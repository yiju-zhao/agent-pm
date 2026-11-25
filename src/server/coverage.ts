import type { DatabaseSync } from 'node:sqlite';
import type { ServerConfig } from './config.ts';
import { contentCuts, isHerdrChunk } from './content-cuts.ts';
import { herdrSourceId, sourceHealth } from './sources-repo.ts';
import type { SourceKind, SourceRow } from './sources-repo.ts';

// What each collection source has actually delivered, so "the collector is online" is not mistaken for "everything was
// collected". One entry per source that is configured (server config) or has ever reported. It counts, per source: the
// sessions it found, how many of them have stored content, where the content read stands, known gaps, and how much of
// the stored text was cut (and whether the cut lost a message, a tool detail, or nothing the center does not still hold). It also names what this kind of source cannot see at all.
//
// The report covers what reached the center. It cannot count sessions a collector never saw (a herdr pane closed before
// the collector first ran, a Paseo archive that was never imported): those are listed under `limits`, not as numbers.

export type SourceCoverage = {
  source_id: string;
  kind: SourceKind;
  machine: string;
  /** Named in the server config, or holding an unrevoked herdr collector key made in the UI. */
  configured: boolean;
  /** `never_reported`: configured, but no collector has ever pushed for it. */
  state: 'never_reported' | 'offline' | 'daemon_down' | 'ok';
  collector_heartbeat: string | null;
  collector_version: string | null;
  daemon_status: string | null;
  last_snapshot_at: string | null;
  /**
   * Sessions this source has observed, by what became of the observation (`untracked`: left out by the collector's
   * filters), and how many of them the user told the board to ignore (collected, but never summarized).
   */
  sessions: { total: number; live: number; ended: number; purged: number; untracked: number; ignored: number };
  content: {
    /** Observed sessions with at least one stored chunk (from any source). */
    with_content: number;
    /** Observed sessions with no stored content at all. */
    without_content: number;
    /** herdr: sessions known only from screen snapshots (no transcript). */
    screen_only: number;
    /** Paseo: where the timeline read stands, per agent. */
    catching_up: number;
    unloaded: number;
    paused: number;
    error: number;
    /** Chunks this source delivered. */
    chunks: number;
    /** Of those: chunks in which a user or assistant message was cut at collection (the rest of it is not at the center). */
    truncated_chunks: number;
    /** Chunks in which only tool text was cut, as every collector does by design. */
    tool_cut_chunks: number;
    /** Paseo: chunks that show an excerpt of an event the center keeps a fuller copy of. */
    excerpted_chunks: number;
    /** Chunks delivered but not summarized yet. */
    undigested_chunks: number;
    refused_chunks: number;
  };
  /** Known holes in the delivered timelines, by reason. */
  gaps: Record<string, number>;
  /** Paseo: what the collector still owes (its own report, from the last snapshot). */
  backlog: { outbox_batches: number; outbox_bytes: number; lagging_agents: number } | null;
  last_error: string | null;
  /** What this kind of source does not collect, in words. */
  limits: string[];
};

const LIMITS: Record<SourceKind, string[]> = {
  herdr: [
    '只发现采集器运行期间出现过的 pane：首次观察之前就已关闭的 session 不会被发现',
    '保存的是归一化文本：超长消息保留首尾并标注省略，工具调用只保留摘要，工具结果不采集',
    '只有屏幕快照的 session（没有 transcript）无法补回完整对话',
  ],
  paseo: [
    '默认不导入采集器启动前已归档的 agent（includeArchivedHistory 为 false 时）',
    '已关闭或未加载的 agent 只有元数据：读取其时间线可能唤醒 agent，所以不读',
    '保存的是有上限的事件副本：消息 64 KiB、工具输入输出各 16 KiB，超出部分保留首尾并标注',
  ],
};

/** The collector's own report stored with its last snapshot; anything unreadable counts as none. */
function parseDiagnostics<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** How many of a source's chunks carry each kind of cut (see ./content-cuts.ts). Only chunks with a marker are read. */
function cutCounts(db: DatabaseSync, sourceId: string): { truncated_chunks: number; tool_cut_chunks: number; excerpted_chunks: number } {
  const out = { truncated_chunks: 0, tool_cut_chunks: 0, excerpted_chunks: 0 };
  const herdr = isHerdrChunk(sourceId);
  for (const row of db.prepare("SELECT text FROM chunks WHERE source_id = ? AND text LIKE '%…[%'").iterate(sourceId)) {
    const cuts = contentCuts(String(row.text), herdr);
    if (cuts.message) out.truncated_chunks += 1;
    else if (cuts.tool) out.tool_cut_chunks += 1;
    if (cuts.excerpt) out.excerpted_chunks += 1;
  }
  return out;
}

export type SourceConfig = Pick<ServerConfig, 'collectors' | 'paseoCollectors'>;

export function configuredSources(db: DatabaseSync, config: SourceConfig) {
  const configured = new Map<string, { kind: SourceKind; machine: string; createdAt?: string }>();
  for (const machine of Object.keys(config.collectors)) configured.set(herdrSourceId(machine), { kind: 'herdr', machine });
  for (const [id, entry] of Object.entries(config.paseoCollectors ?? {})) configured.set(id, { kind: 'paseo', machine: entry.machine });
  // A herdr collector key made in the UI names its machine in its scope (a Paseo source must be in the config anyway).
  for (const key of db.prepare("SELECT scope, min(created_at) AS createdAt FROM api_keys WHERE revoked_at IS NULL AND scope LIKE 'ingest:herdr:%' GROUP BY scope").all() as Array<{ scope: string; createdAt: string }>) {
    const machine = key.scope.slice('ingest:herdr:'.length);
    if (!configured.has(herdrSourceId(machine))) configured.set(herdrSourceId(machine), { kind: 'herdr', machine, createdAt: key.createdAt });
  }
  return configured;
}

export const PENDING_DIGEST_CHUNKS = 'SELECT session_key, source_id FROM chunks WHERE digested = 0 AND digest_block_id IS NULL';

export function sourceState(source: SourceRow | undefined, now: Date): SourceCoverage['state'] {
  if (!source || source.collector_heartbeat === null) return 'never_reported';
  const health = sourceHealth(source, now);
  if (!health.collectorAlive) return 'offline';
  if (!health.daemonOk) return 'daemon_down';
  return 'ok';
}

export function sourceCoverage(db: DatabaseSync, config: ServerConfig, now: Date): SourceCoverage[] {
  const configured = configuredSources(db, config);
  const rows = new Map((db.prepare('SELECT * FROM ingest_sources').all() as SourceRow[]).map((r) => [r.source_id, r]));
  const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const ids = [...new Set([...configured.keys(), ...rows.keys()])].sort();
  return ids.map((id): SourceCoverage => {
    const row = rows.get(id);
    const kind = (row?.kind ?? configured.get(id)!.kind) as SourceKind;
    const lifecycle = Object.fromEntries(
      (db.prepare('SELECT lifecycle, count(*) AS n FROM session_sources WHERE source_id = ? GROUP BY lifecycle').all(id) as Array<{ lifecycle: string; n: number }>).map((r) => [r.lifecycle, r.n]),
    );
    const state = Object.fromEntries(
      (db.prepare('SELECT content_state, count(*) AS n FROM session_sources WHERE source_id = ? AND content_state IS NOT NULL GROUP BY content_state').all(id) as Array<{ content_state: string; n: number }>).map((r) => [r.content_state, r.n]),
    );
    const total = count('SELECT count(*) AS n FROM session_sources WHERE source_id = ?', id);
    const withContent = count('SELECT count(DISTINCT o.session_key) AS n FROM session_sources o WHERE o.source_id = ? AND EXISTS (SELECT 1 FROM chunks c WHERE c.session_key = o.session_key)', id);
    const observedSessions = count('SELECT count(DISTINCT session_key) AS n FROM session_sources WHERE source_id = ?', id);
    type Diagnostics = { outbox_batches?: number; outbox_bytes?: number; lagging_agents?: number; last_error?: string | null };
    const diagnostics = parseDiagnostics<Diagnostics>(row?.diagnostics ?? null);
    return {
      source_id: id,
      kind,
      machine: row?.machine ?? configured.get(id)!.machine,
      configured: configured.has(id),
      state: sourceState(row, now),
      collector_heartbeat: row?.collector_heartbeat ?? null,
      collector_version: row?.collector_version ?? null,
      daemon_status: row?.daemon_status ?? null,
      last_snapshot_at: row?.last_snapshot_at ?? null,
      sessions: { total, live: lifecycle.live ?? 0, ended: lifecycle.ended ?? 0, purged: lifecycle.purged ?? 0, untracked: lifecycle.untracked ?? 0, ignored: count('SELECT count(DISTINCT o.session_key) AS n FROM session_sources o JOIN sessions s ON s.key = o.session_key WHERE o.source_id = ? AND s.ignored = 1', id) },
      content: {
        with_content: withContent,
        without_content: observedSessions - withContent,
        screen_only: count("SELECT count(*) AS n FROM session_sources WHERE source_id = ? AND fidelity = 'screen'", id),
        catching_up: state.catching_up ?? 0,
        unloaded: state.unloaded ?? 0,
        paused: state.paused ?? 0,
        error: state.error ?? 0,
        chunks: count('SELECT count(*) AS n FROM chunks WHERE source_id = ?', id),
        ...cutCounts(db, id),
        undigested_chunks: count(`SELECT count(*) AS n FROM (${PENDING_DIGEST_CHUNKS}) WHERE source_id = ?`, id),
        refused_chunks: count('SELECT count(*) AS n FROM chunks WHERE source_id = ? AND digest_block_id IS NOT NULL', id),
      },
      gaps: Object.fromEntries((db.prepare('SELECT reason, count(*) AS n FROM ingest_gaps WHERE source_id = ? GROUP BY reason').all(id) as Array<{ reason: string; n: number }>).map((r) => [r.reason, r.n])),
      backlog: diagnostics === null ? null : { outbox_batches: diagnostics.outbox_batches ?? 0, outbox_bytes: diagnostics.outbox_bytes ?? 0, lagging_agents: diagnostics.lagging_agents ?? 0 },
      last_error: diagnostics?.last_error ?? row?.daemon_error ?? null,
      limits: LIMITS[kind],
    };
  });
}
