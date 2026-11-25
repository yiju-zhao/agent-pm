import type { DatabaseSync } from 'node:sqlite';

import { QUESTION_TTL_DAYS } from '../domain/questions.ts';
import { sessionLinks } from '../domain/read.ts';
import { listReminders } from '../domain/reminders.ts';
import { configuredSources, PENDING_DIGEST_CHUNKS, sourceState, type SourceConfig } from '../server/coverage.ts';
import { getSession, listSessions, mergeTarget } from '../server/sessions-repo.ts';
import type { SourceRow } from '../server/sources-repo.ts';
import type { Turn } from '../server/turns.ts';
import type { ToolInfo, Truncation } from '../shared/ingest-v2.ts';
import { assignShortIds, shortIdSource } from '../shared/session-key.ts';
import { ContextAddressError } from './address.ts';

export const REFUSAL_NOTE = '此段曾被摘要模型拒绝，中心没有它的摘要';
export const ISOLATED_TEXT = '因摘要被拒而隔离，后台不提供正文';

export function resolveSession(db: DatabaseSync, shortId: string): { key: string; short: string } {
  const ids = assignShortIds(
    db
      .prepare('SELECT key FROM sessions')
      .all()
      .map((s) => String(s.key)),
  );
  const candidates = [...ids].filter(([key, id]) => id === shortId || shortIdSource(key).startsWith(shortId));
  const keys = [...new Set(candidates.map(([key]) => mergeTarget(db, key)))];
  if (keys.length !== 1) throw new ContextAddressError(keys.length ? `session 短 ID 不唯一：${shortId}` : `找不到 session：${shortId}`);
  return { key: keys[0], short: ids.get(keys[0])! };
}

type ChangeSummary = {
  project_id: string;
  stages: number;
  decisions: number;
  completed_todos: number;
  new_blockers: number;
  cleared_blockers: number;
};
type Pending = { text: string; since: string | null; ref: string };
type SessionCard = { goal: string; state: string; waiting_on: string | null; next: string | null; note: string | null };
type SessionOutline = Turn & {
  address: string;
  user: string;
  assistant: string;
  user_refused: boolean;
  assistant_refused: boolean;
  refused: boolean;
  in_progress: boolean;
};
type Overview = {
  sources: { id: string; state: string; last_sync: string | null }[];
  undigested: number;
  refusals: number;
  pending: Pending[];
  running: { address: string; machine: string; projects: string[]; turn: number | null; age_ms: number | null; user: string }[];
  changes: ChangeSummary[];
  last_event_id: number;
};

export function readOverview(db: DatabaseSync, now: Date, reader: string, sources?: { config: SourceConfig; startedAt: Date }): Overview {
  const rows = db.prepare('SELECT * FROM ingest_sources ORDER BY source_id').all() as SourceRow[];
  const coverage = rows.map(source => ({
    id: source.source_id,
    state: sourceState(source, now),
    last_sync: source.last_snapshot_at ?? source.collector_heartbeat,
  }));
  for (const [id] of configuredSources(db, sources?.config ?? { collectors: {} })) {
    if (!coverage.some((s) => s.id === id)) coverage.push({ id, state: 'never_reported', last_sync: null });
  }
  const sessions = listSessions(db, {}, now);
  const links = sessionLinks(db);
  const pending: Pending[] = listReminders(db, now, sources).map((r) => ({
    text: r.text,
    since: r.since,
    ref: r.short_id ? 's:' + r.short_id : (r.project_id ?? r.key),
  }));
  pending.push(
    ...(db
      .prepare(
        `SELECT prompt AS text, created_at AS since, id AS ref FROM questions WHERE status='pending'
    AND created_at>=? AND (project_id IS NULL OR project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL))`,
      )
      .all(new Date(now.getTime() - QUESTION_TTL_DAYS * 86400_000).toISOString()) as Pending[]),
  );
  pending.sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''));
  const latestTurn = db.prepare('SELECT n, ts_start FROM turns WHERE session_key=? ORDER BY n DESC LIMIT 1');
  const openingMessage = db.prepare(
    "SELECT substr(text, 1, 80) AS text FROM context_turn_events WHERE session_key=? AND n=? AND kind='user' ORDER BY first_event LIMIT 1",
  );
  const running = sessions
    .filter((s) => s.effective_status === 'working' && !s.ignored)
    .map((s) => {
      const turn = latestTurn.get(s.key);
      const user = turn && openingMessage.get(s.key, turn.n);
      return {
        address: 's:' + s.short_id,
        machine: s.machine,
        projects: (links.get(s.key) ?? []).map((p) => p.title),
        turn: turn ? Number(turn.n) : null,
        age_ms: turn?.ts_start ? Math.max(0, now.getTime() - Date.parse(String(turn.ts_start))) : null,
        user: String(user?.text ?? ''),
      };
    });
  const cursor = db.prepare('SELECT last_event_id FROM reader_cursors WHERE reader=?').get(reader);
  const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const changes = db
    .prepare(
      `SELECT project_id, sum(op='transition_stage') stages, sum(op='record_decision') decisions,
    sum(op='upsert_todo' AND EXISTS(SELECT 1 FROM json_each(after) j WHERE json_extract(j.value, '$.status')='done')) completed_todos,
    sum(op='set_blocker' AND NOT EXISTS(SELECT 1 FROM json_each(before) WHERE type!='null')) new_blockers,
    sum(op='clear_blocker') cleared_blockers FROM events WHERE project_id IS NOT NULL AND ${cursor ? 'id>?' : 'recorded_at>=?'}
    GROUP BY project_id ORDER BY max(id) DESC`,
    )
    .all(cursor?.last_event_id ?? dayAgo) as ChangeSummary[];
  return {
    sources: coverage,
    pending,
    running,
    changes,
    last_event_id: Number(db.prepare('SELECT coalesce(max(id), 0) n FROM events').get()!.n),
    undigested: Number(db.prepare(`SELECT count(DISTINCT session_key) n FROM (${PENDING_DIGEST_CHUNKS})`).get()!.n),
    refusals: Number(db.prepare('SELECT count(*) n FROM digest_blocks').get()!.n),
  };
}

export function markOverviewRead(db: DatabaseSync, reader: string, now: Date, through?: number): void {
  db.prepare(
    `INSERT INTO reader_cursors(reader, last_event_id, last_seen_at) VALUES (?, coalesce(?, (SELECT coalesce(max(id), 0) FROM events)), ?)
    ON CONFLICT(reader) DO UPDATE SET last_event_id=max(last_event_id, excluded.last_event_id), last_seen_at=excluded.last_seen_at`,
  ).run(reader, through ?? null, now.toISOString());
}

export type SessionContext = {
  key: string;
  address: string;
  title: string;
  machine: string;
  status: string;
  projects: string[];
  turns: SessionOutline[];
  earlier: number;
  card: SessionCard | null;
  card_as_of_turn: number | null;
  card_lag: number | null;
  no_turn_index: boolean;
  earlier_digests: number;
  digests: { id: number; ts_end: string | null; json: string | null }[];
};
export function readSession(
  db: DatabaseSync,
  now: Date,
  shortId: string,
  options: { before?: number; limit?: number },
  background = false,
): SessionContext {
  const { key, short } = resolveSession(db, shortId);
  const session = getSession(db, key, now)!;
  const card = db.prepare('SELECT card, card_as_of_turn FROM sessions WHERE key=?').get(key) as {
    card: string | null;
    card_as_of_turn: number | null;
  };
  const address = 's:' + short;
  const total = Number(db.prepare('SELECT coalesce(max(n), 0) n FROM turns WHERE session_key=?').get(key)!.n);
  const turns = db
    .prepare(
      `SELECT n, turn_id, first_key, last_key, ts_start, ts_end, tool_calls, tool_failures FROM turns
    WHERE session_key=? AND n<? ORDER BY n DESC LIMIT ?`,
    )
    .all(key, options.before ?? total + 1, options.limit ?? 30) as Turn[];
  const openingMessage = db.prepare(
    "SELECT substr(text, 1, 80) AS text, refused FROM context_turn_events WHERE session_key=? AND n=? AND kind='user' ORDER BY first_event LIMIT 1",
  );
  const finalAnswer = db.prepare(
    "SELECT substr(text, 1, 120) AS text, refused FROM context_turn_events WHERE session_key=? AND n=? AND kind='assistant' ORDER BY first_event DESC LIMIT 1",
  );
  const refusedEvent = db.prepare('SELECT 1 FROM context_turn_events WHERE session_key=? AND n=? AND refused=1 LIMIT 1');
  const outline = turns.reverse().map((t) => {
    const first = openingMessage.get(key, t.n);
    const last = finalAnswer.get(key, t.n);
    const refused = !!refusedEvent.get(key, t.n);
    return {
      ...t,
      refused,
      address: address + '#' + t.n,
      user: background && first?.refused ? ISOLATED_TEXT : String(first?.text ?? ''),
      assistant: background && last?.refused ? ISOLATED_TEXT : String(last?.text ?? ''),
      user_refused: !!first?.refused,
      assistant_refused: !!last?.refused,
      in_progress: t.n === total && session.effective_status === 'working',
    };
  });
  const digests = total
    ? []
    : (db
        .prepare('SELECT id, ts_end, json FROM digests WHERE session_key=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?')
        .all(key, options.before ?? null, options.before ?? null, options.limit ?? 30) as SessionContext['digests']);
  return {
    key,
    address,
    title: session.title,
    machine: session.machine,
    status: session.effective_status,
    projects: (sessionLinks(db).get(key) ?? []).map((p) => p.title),
    card: card.card ? (JSON.parse(card.card) as SessionCard) : null,
    card_as_of_turn: card.card_as_of_turn,
    card_lag: card.card_as_of_turn === null ? null : total - card.card_as_of_turn,
    turns: outline,
    earlier: turns.length ? turns[0].n - 1 : 0,
    no_turn_index: total === 0,
    earlier_digests: digests.length
      ? Number(db.prepare('SELECT count(*) n FROM digests WHERE session_key=? AND id<?').get(key, digests.at(-1)!.id)!.n)
      : 0,
    digests,
  };
}

type Item = {
  address: string;
  kind: string;
  text: string;
  refused: boolean;
  tool: { name: string; input: string; status: string; exit_code: number | null } | null;
};
type StoredItem = {
  event_key: string;
  server_id: string;
  stream_id: string;
  kind: string;
  text: string | null;
  meta: string | null;
  refused: number;
};
type EventMeta = { tool?: ToolInfo | null; text_truncated?: Truncation };

export function readTurn(db: DatabaseSync, shortId: string, turn: number, background = false): { address: string; items: Item[] } {
  const { key, short } = resolveSession(db, shortId);
  const address = 's:' + short + '#' + turn;
  const rows = db
    .prepare('SELECT kind, text, meta, refused FROM context_turn_events WHERE session_key=? AND n=? ORDER BY first_event')
    .all(key, turn) as Pick<StoredItem, 'kind' | 'text' | 'meta' | 'refused'>[];
  if (!rows.length) throw new ContextAddressError(`找不到回合：${address}`);
  return {
    address,
    items: rows.map((r, i) => {
      const isHidden = background && !!r.refused;
      const tool = isHidden ? null : (JSON.parse(r.meta ?? '{}') as EventMeta).tool;
      return {
        address: address + '.' + (i + 1),
        kind: r.kind,
        refused: !!r.refused,
        text: isHidden ? ISOLATED_TEXT : (r.text ?? '原文不在库里'),
        tool: tool
          ? { name: tool.name, input: Array.from(tool.input).slice(0, 200).join(''), status: tool.status, exit_code: tool.exit_code }
          : null,
      };
    }),
  };
}

export function readItem(
  db: DatabaseSync,
  shortId: string,
  turn: number,
  item: number,
  { offset }: { offset: number },
): {
  address: string;
  text: string;
  missing: boolean;
  total: number;
  next_offset: number | null;
  truncated: Truncation | { input: Truncation; output: Truncation };
  refused: boolean;
  pointer: { server_id: string; agent_id: string; event_key: string };
} {
  const { key, short } = resolveSession(db, shortId);
  const address = 's:' + short + '#' + turn + '.' + item;
  const row = db
    .prepare('SELECT * FROM context_turn_events WHERE session_key=? AND n=? ORDER BY first_event LIMIT 1 OFFSET ?')
    .get(key, turn, item - 1) as StoredItem | undefined;
  if (!row) throw new ContextAddressError(`找不到回合条目：${address}`);
  const meta = JSON.parse(row.meta ?? '{}') as EventMeta;
  const tool = meta.tool;
  const missing = row.text === null || (!tool && row.text === '');
  let text: string;
  if (tool && !missing) {
    text = [
      tool.input && '【输入】\n' + tool.input,
      tool.output && '【输出】\n' + tool.output,
      tool.error && '【错误】\n' + tool.error,
    ].filter(Boolean).join('\n\n');
  } else {
    text = row.text ?? '';
  }
  const chars = Array.from(text);
  const pageSize = 4000;
  return {
    address,
    missing,
    text: missing ? '原文不在库里' : chars.slice(offset, offset + pageSize).join(''),
    total: chars.length,
    next_offset: offset + pageSize < chars.length ? offset + pageSize : null,
    truncated: tool ? { input: tool.input_truncated, output: tool.output_truncated } : (meta.text_truncated ?? null),
    refused: !!row.refused,
    pointer: { server_id: row.server_id, agent_id: row.stream_id, event_key: row.event_key },
  };
}
