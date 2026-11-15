import type { DatabaseSync } from 'node:sqlite';
import type { Priority, Stage } from './types.ts';

// Activity over a period, for the overview's momentum lines and the review page. Read only.
//
// Work is measured as the conversation content that arrived (chunks), bucketed by the day it was said, in the
// viewer's time zone. A chunk counts for every project its session is linked to now, so the per-project numbers can
// add up to more than the total; `unlinked` is what belongs to no project yet. Milestones of the period come from the
// event log: decisions, todos and milestones marked done, stage changes, blockers opened and cleared, new projects and
// merges. Events that were taken back, and the events that took them back, are left out.

export const MAX_ACTIVITY_DAYS = 90;
const DAY_MS = 86_400_000;

export type ActivityKind = 'decision' | 'todo_done' | 'milestone_done' | 'stage' | 'blocker_set' | 'blocker_cleared' | 'project_created' | 'merge';

export type ActivityItem = {
  event_id: number;
  at: string;
  /** Index into `days`. */
  day: number;
  kind: ActivityKind;
  project_id: string | null;
  /** What happened, in a line: the decision, the todo, the new stage, the blocker. */
  text: string;
  actor: string;
};

export type ProjectActivity = {
  id: string;
  title: string;
  stage: Stage;
  priority: Priority | null;
  closed: boolean;
  /** Chunks per day. */
  daily: number[];
  /** Notable items per day, by kind. */
  marks: Array<Partial<Record<ActivityKind, number>>>;
  totals: { chunks: number; sessions: number; decisions: number; done: number; stage_changes: number; blockers_opened: number; blockers_cleared: number };
};

export type ActivityView = {
  /** Local calendar days, oldest first, as `YYYY-MM-DD`. */
  days: string[];
  from: string;
  to: string;
  total_daily: number[];
  unlinked_daily: number[];
  projects: ProjectActivity[];
  machines: Array<{ machine: string; daily: number[] }>;
  /** Newest first. */
  items: ActivityItem[];
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
function parse(text: unknown): Rec {
  if (typeof text !== 'string') return {};
  try {
    const v: unknown = JSON.parse(text);
    return isRec(v) ? v : {};
  } catch {
    return {};
  }
}

const STAGE_TEXT: Record<string, string> = { idea: 'idea', explore: '探索', build: '构建', verify: '验证', done: '完成', parked: '搁置', abandoned: '放弃', merged: '合并' };

/**
 * `days` local days ending today, in the time zone `tzOffsetMinutes` (as `Date#getTimezoneOffset`: minutes to add to
 * local time to get UTC). With `project`, only that project (and only its items).
 */
export function getActivity(db: DatabaseSync, now: Date, opts: { days: number; tzOffsetMinutes: number; project?: string }): ActivityView {
  const days = Math.min(MAX_ACTIVITY_DAYS, Math.max(1, Math.floor(opts.days)));
  const shift = opts.tzOffsetMinutes * 60_000;
  // Local midnight of today, as a UTC instant, then back `days - 1` days.
  const localNow = now.getTime() - shift;
  const todayStart = Math.floor(localNow / DAY_MS) * DAY_MS + shift;
  const fromMs = todayStart - (days - 1) * DAY_MS;
  const toMs = todayStart + DAY_MS;
  const dayOf = (iso: string | null): number => {
    const t = iso === null ? NaN : Date.parse(iso);
    if (Number.isNaN(t) || t < fromMs || t >= toMs) return -1;
    return Math.floor((t - fromMs) / DAY_MS);
  };
  const labels = Array.from({ length: days }, (_, i) => new Date(fromMs + i * DAY_MS - shift).toISOString().slice(0, 10));
  const zeros = () => new Array<number>(days).fill(0);
  const from = new Date(fromMs).toISOString();

  const projectRows = db
    .prepare(`SELECT id, title, stage, priority FROM projects WHERE deleted_at IS NULL ${opts.project ? 'AND id = ?' : ''} ORDER BY rowid`)
    .all(...(opts.project ? [opts.project] : [])) as Array<{ id: string; title: string; stage: Stage; priority: Priority | null }>;
  const projects = new Map<string, ProjectActivity>(
    projectRows.map((p) => [
      p.id,
      {
        ...p,
        closed: ['done', 'abandoned', 'merged'].includes(p.stage),
        daily: zeros(),
        marks: Array.from({ length: days }, () => ({})),
        totals: { chunks: 0, sessions: 0, decisions: 0, done: 0, stage_changes: 0, blockers_opened: 0, blockers_cleared: 0 },
      },
    ]),
  );

  // Which projects each session works for now.
  const linksOf = new Map<string, string[]>();
  for (const r of db.prepare('SELECT session_key, project_id FROM contributions WHERE deleted_at IS NULL').all() as Array<{ session_key: string; project_id: string }>) {
    if (!projects.has(r.project_id)) continue;
    linksOf.set(r.session_key, [...(linksOf.get(r.session_key) ?? []), r.project_id]);
  }

  const total = zeros();
  const unlinked = zeros();
  const machines = new Map<string, number[]>();
  const sessionsOf = new Map<string, Set<string>>();
  const chunks = db
    .prepare(`SELECT c.ts_start, c.session_key, s.machine FROM chunks c LEFT JOIN sessions s ON s.key = c.session_key WHERE c.ts_start >= ? AND c.kind != 'screen'`)
    .iterate(from) as Iterable<{ ts_start: string | null; session_key: string; machine: string | null }>;
  for (const c of chunks) {
    const d = dayOf(c.ts_start);
    if (d < 0) continue;
    const linked = linksOf.get(c.session_key) ?? [];
    if (opts.project && linked.length === 0) continue;
    total[d] += 1;
    if (linked.length === 0) unlinked[d] += 1;
    for (const id of linked) {
      const p = projects.get(id)!;
      p.daily[d] += 1;
      p.totals.chunks += 1;
      (sessionsOf.get(id) ?? sessionsOf.set(id, new Set()).get(id)!).add(c.session_key);
    }
    const machine = c.machine || '未知机器';
    (machines.get(machine) ?? machines.set(machine, zeros()).get(machine)!)[d] += 1;
  }
  for (const [id, set] of sessionsOf) projects.get(id)!.totals.sessions = set.size;

  const titleOf = (table: 'todos' | 'milestones' | 'blockers' | 'decisions', id: string, col: 'title' | 'text'): string => {
    const r = db.prepare(`SELECT ${col} AS t FROM ${table} WHERE id = ?`).get(id) as { t: string | null } | undefined;
    return r?.t ?? id;
  };
  const items: ActivityItem[] = [];
  const events = db
    .prepare(
      `SELECT id, occurred_at, actor, op, project_id, before, after FROM events
       WHERE occurred_at >= ? AND reverted_by IS NULL AND reverts IS NULL ${opts.project ? 'AND project_id = ?' : ''} ORDER BY occurred_at DESC, id DESC`,
    )
    .all(from, ...(opts.project ? [opts.project] : [])) as Array<{ id: number; occurred_at: string; actor: string; op: string; project_id: string | null; before: string; after: string }>;
  for (const e of events) {
    const d = dayOf(e.occurred_at);
    if (d < 0) continue;
    const before = parse(e.before);
    const after = parse(e.after);
    const push = (kind: ActivityKind, text: string, projectId = e.project_id) => {
      items.push({ event_id: e.id, at: e.occurred_at, day: d, kind, project_id: projectId, text, actor: e.actor });
      const p = projectId === null ? undefined : projects.get(projectId);
      if (p === undefined) return;
      p.marks[d][kind] = (p.marks[d][kind] ?? 0) + 1;
      if (kind === 'decision') p.totals.decisions += 1;
      if (kind === 'todo_done' || kind === 'milestone_done') p.totals.done += 1;
      if (kind === 'stage' || kind === 'merge') p.totals.stage_changes += 1;
      if (kind === 'blocker_set') p.totals.blockers_opened += 1;
      if (kind === 'blocker_cleared') p.totals.blockers_cleared += 1;
    };
    for (const [entity, changed] of Object.entries(after)) {
      if (!isRec(changed)) continue;
      const at = entity.indexOf(':');
      const table = entity.slice(0, at);
      const id = entity.slice(at + 1);
      const inserted = before[entity] === null;
      if (table === 'decisions' && inserted) push('decision', String(changed.text ?? titleOf('decisions', id, 'text')));
      else if (table === 'todos' && changed.status === 'done') push('todo_done', titleOf('todos', id, 'title'));
      else if (table === 'milestones' && changed.status === 'done') push('milestone_done', titleOf('milestones', id, 'title'));
      else if (table === 'blockers' && inserted) push('blocker_set', String(changed.text ?? titleOf('blockers', id, 'text')));
      else if (table === 'blockers' && changed.status === 'cleared') push('blocker_cleared', titleOf('blockers', id, 'text'));
      else if (table === 'projects' && inserted) push('project_created', String(changed.title ?? id), id);
      else if (table === 'projects' && typeof changed.stage === 'string') {
        if (changed.stage === 'merged') push('merge', `并入 ${String(changed.merged_into ?? '')}`.trim(), id);
        else push('stage', `${STAGE_TEXT[String(isRec(before[entity]) ? (before[entity] as Rec).stage : '')] ?? '?'} → ${STAGE_TEXT[changed.stage] ?? changed.stage}`, id);
      }
    }
  }

  return {
    days: labels,
    from,
    to: new Date(toMs).toISOString(),
    total_daily: total,
    unlinked_daily: unlinked,
    projects: [...projects.values()],
    machines: [...machines.entries()].map(([machine, daily]) => ({ machine, daily })).sort((a, b) => a.machine.localeCompare(b.machine)),
    items,
  };
}
