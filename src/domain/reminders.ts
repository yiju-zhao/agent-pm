import type { DatabaseSync } from 'node:sqlite';
import { listSessions } from '../server/sessions-repo.ts';
import { configuredSources, type SourceConfig } from '../server/coverage.ts';
import { Workspace } from '../shared/workspace.ts';
import { listProjects, sessionLinks } from './read.ts';

// Reminders: what in the user's work is waiting on them or has stalled, derived each time from what the sessions,
// projects and repositories show now. agent-pm only reads the agents' work, so these are not questions to answer
// here (an answer in agent-pm reaches no agent); they point the user back to where the work is, and they go away by
// themselves when the work moves on: a blocker the review finds resolved, a session no longer waiting, a pushed branch.
//
// The user can only put one off: until a time ("later"), or until it changes ("not again", by its fingerprint).

export const REMINDER_CATEGORIES = ['agent_waiting', 'waiting_you', 'stalled', 'unpushed', 'waiting_external', 'source_offline'] as const;
export type ReminderCategory = (typeof REMINDER_CATEGORIES)[number];

export type Reminder = {
  /** Stable while it is the same thing: `blocker:<id>`, `session:<key>`, `stalled:<project>`, `repo:<root>`. */
  key: string;
  category: ReminderCategory;
  text: string;
  /** Where it stands, in a short line (how long, which machine, how many commits). */
  detail: string;
  project_id: string | null;
  project_title: string | null;
  session_key: string | null;
  short_id: string | null;
  since: string | null;
  /** Changes when what the reminder says changes; a "not again" lasts while it stays the same. */
  fingerprint: string;
};

/** A sleeping laptop should not raise a reminder: only an outage this long does. */
export const SOURCE_REMINDER_AFTER_MS = 60 * 60_000;
type ReminderSources = { config: SourceConfig; startedAt: Date };

/** A branch with commits not pushed for this long is worth a reminder. */
export const UNPUSHED_AFTER_MS = 2 * 3600_000;
/** A P0/P1 project quiet for this many days is "stalled". */
export const STALLED_AFTER_DAYS = 7;

function snoozed(db: DatabaseSync, now: Date): Map<string, { until: string | null; fingerprint: string }> {
  const rows = db.prepare('SELECT key, until, fingerprint FROM reminder_snoozes').all() as Array<{ key: string; until: string | null; fingerprint: string }>;
  return new Map(rows.filter((r) => r.until === null || r.until > now.toISOString()).map((r) => [r.key, r]));
}

/** Every reminder that holds now, the ones put off left out, by category order then newest first. */
export function listReminders(db: DatabaseSync, now: Date, sources?: ReminderSources): Reminder[] {
  const out: Reminder[] = [];
  const cards = listProjects(db, now, {}).filter((c) => !c.closed);
  const title = new Map(cards.map((c) => [c.id, c.title]));

  for (const c of cards) {
    for (const b of c.open_blockers) {
      if (b.kind === 'technical') continue; // the agents' to solve
      out.push({
        key: `blocker:${b.id}`,
        category: b.kind === 'user' ? 'waiting_you' : 'waiting_external',
        text: b.text,
        // What to do about it is the category's (shown once above the group), not repeated on every line.
        detail: '',
        project_id: c.id,
        project_title: c.title,
        session_key: null,
        short_id: null,
        since: b.created_at,
        fingerprint: `${b.kind}:${b.text}`,
      });
    }
    if ((c.priority === 'P0' || c.priority === 'P1') && c.dormant_days !== null && c.dormant_days >= STALLED_AFTER_DAYS) {
      out.push({
        key: `stalled:${c.id}`,
        category: 'stalled',
        text: `${c.priority} 项目「${c.title}」已经 ${c.dormant_days} 天没有进展`,
        detail: c.current_milestone ? `当前里程碑：${c.current_milestone.title}` : c.open_todos[0] ? `下一步：${c.open_todos[0].title}` : '没有记录下一步',
        project_id: c.id,
        project_title: c.title,
        session_key: null,
        short_id: null,
        since: c.last_activity_at,
        // Re-raised each further week of silence.
        fingerprint: `week:${Math.floor(c.dormant_days / 7)}`,
      });
    }
  }

  const links = sessionLinks(db);
  const sessions = listSessions(db, {}, now).filter((s) => !s.ignored);
  const workspace = db.prepare('SELECT workspace FROM session_sources WHERE session_key = ? AND workspace IS NOT NULL ORDER BY last_seen DESC LIMIT 1');
  const repos = new Map<string, Reminder>();
  for (const s of sessions) {
    const project = (links.get(s.key) ?? [])[0] ?? null;
    if (s.effective_status === 'blocked') {
      const attention = s.sources.map((o) => o.attention).find((a) => a) ?? null;
      out.push({
        key: `session:${s.key}`,
        category: 'agent_waiting',
        text: `「${s.title || s.short_id}」在等你操作`,
        detail: [`${s.machine} · ${s.agent_kind} · ${s.short_id}`, attention?.startsWith('permission') ? '等待权限确认' : attention?.startsWith('error') ? '出错停下' : null].filter(Boolean).join(' · '),
        project_id: project?.id ?? null,
        project_title: project?.title ?? null,
        session_key: s.key,
        short_id: s.short_id,
        since: s.status_changed_at ?? s.last_seen,
        fingerprint: `${s.status_changed_at ?? ''}`,
      });
    }
    if (s.effective_status === 'ended' || s.effective_status === 'purged') continue;
    const row = workspace.get(s.key) as { workspace: string } | undefined;
    if (!row) continue;
    const parsed = Workspace.safeParse(JSON.parse(row.workspace));
    if (!parsed.success) continue;
    const w = parsed.data;
    const head = w.recent[0];
    if (!w.ahead || !head || now.getTime() - Date.parse(head.at) < UNPUSHED_AFTER_MS || repos.has(w.root)) continue;
    repos.set(w.root, {
      key: `repo:${w.root}`,
      category: 'unpushed',
      text: `${w.root.split('/').at(-1)} 的 ${w.branch ?? 'HEAD'} 有 ${w.ahead} 个提交没有推送`,
      detail: `最新：${head.sha} ${head.subject}`,
      project_id: project?.id ?? null,
      project_title: project ? (title.get(project.id) ?? project.title) : null,
      session_key: s.key,
      short_id: s.short_id,
      since: head.at,
      fingerprint: `${w.ahead}:${head.sha}`,
    });
  }
  out.push(...repos.values());

  if (sources) {
    const heartbeat = db.prepare('SELECT collector_heartbeat FROM ingest_sources WHERE source_id=?');
    for (const [id, source] of configuredSources(db, sources.config)) {
      const row = heartbeat.get(id) as { collector_heartbeat: string | null } | undefined;
      const last = row?.collector_heartbeat;
      const since = last ?? source.createdAt ?? sources.startedAt.toISOString();
      if (now.getTime() - Date.parse(since) < SOURCE_REMINDER_AFTER_MS) continue;
      out.push({
        key: `source:${id}`, category: 'source_offline',
        text: last ? `采集来源 ${id} 已离线` : `采集来源 ${id} 尚未上报`,
        detail: last ? '最后一次收到心跳' : '仍在等待首次心跳',
        project_id: null, project_title: null, session_key: null, short_id: null,
        since, fingerprint: last ?? 'never_reported',
      });
    }
  }

  const off = snoozed(db, now);
  const order = (r: Reminder) => REMINDER_CATEGORIES.indexOf(r.category);
  return out
    .filter((r) => {
      const s = off.get(r.key);
      return s === undefined || (s.until === null && s.fingerprint !== r.fingerprint);
    })
    .sort((a, b) => order(a) - order(b) || (b.since ?? '').localeCompare(a.since ?? ''));
}

/**
 * Puts a reminder off: for `hours`, or with `hours` null until what it says changes. Unknown keys are refused (a
 * reminder that already went away needs nothing). Returns false when there is no such reminder now.
 */
export function snoozeReminder(db: DatabaseSync, now: Date, key: string, hours: number | null, sources?: ReminderSources): boolean {
  const current = listReminders(db, now, sources).find((r) => r.key === key);
  if (current === undefined) return false;
  const until = hours === null ? null : new Date(now.getTime() + hours * 3600_000).toISOString();
  db.prepare(
    `INSERT INTO reminder_snoozes (key, until, fingerprint, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET until = excluded.until, fingerprint = excluded.fingerprint, created_at = excluded.created_at`,
  ).run(key, until, current.fingerprint, now.toISOString());
  return true;
}
