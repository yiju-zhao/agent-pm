import type { DatabaseSync } from 'node:sqlite';
import { listSessions } from '../server/sessions-repo.ts';
import type { SessionView } from '../server/sessions-repo.ts';
import { readLocks } from './changes.ts';
import type { OpName } from './ops.ts';
import { expireQuestions, QUESTION_TTL_DAYS } from './questions.ts';
import type { QuestionOption } from './questions.ts';
import { CLOSED } from './stage.ts';
import { PRIORITIES } from './types.ts';
import type { DomainDeps, Priority, Stage } from './types.ts';

/** A project with no active session and no activity for this many days is dormant. */
export const DORMANT_AFTER_DAYS = 7;
/** How many of a project's newest events its detail carries. */
export const EVENTS_IN_DETAIL = 200;

const DAY_MS = 86_400_000;

// ---- types -------------------------------------------------------------------------------------------------------

export type ItemStatus = 'todo' | 'doing' | 'done';

export type MilestoneRow = {
  id: string;
  project_id: string;
  title: string;
  status: ItemStatus;
  position: number;
  locks: string[];
  created_by: string;
  created_at: string;
};

export type TodoRow = {
  id: string;
  project_id: string;
  milestone_id: string | null;
  title: string;
  status: ItemStatus;
  priority: Priority | null;
  locks: string[];
  created_by: string;
  created_at: string;
};

export type DecisionRow = {
  id: string;
  project_id: string;
  text: string;
  decided_at: string;
  evidence: string[];
  created_by: string;
  created_at: string;
};

export type BlockerRow = {
  id: string;
  project_id: string;
  text: string;
  kind: 'user' | 'external' | 'technical';
  status: 'open' | 'cleared';
  cleared_at: string | null;
  created_by: string;
  created_at: string;
};

export type ContributionRow = {
  id: string;
  session_key: string;
  project_id: string;
  milestone_id: string | null;
  summary: string | null;
  ts_start: string | null;
  ts_end: string | null;
  confidence: number | null;
  actor: string;
  created_at: string;
};

/** A linked session as the page shows it. */
export type SessionTag = {
  key: string;
  short_id: string;
  machine: string;
  agent_kind: string;
  effective_status: string;
  title: string;
  milestone_id: string | null;
};

/**
 * One answer as the page shows it: the label and what answering runs (`op` with `args`; both `null` when it does
 * nothing), so the user can see past a misleading label. The page still sends back only the option's index.
 */
export type QuestionOptionView = {
  label: string;
  has_op: boolean;
  op: OpName | null;
  args: Record<string, unknown> | null;
  text_arg?: string;
};

/** A question as the page shows it. */
export type QuestionView = {
  id: string;
  kind: 'choice' | 'text' | 'confirm';
  prompt: string;
  options: QuestionOptionView[];
  project_id: string | null;
  session_key: string | null;
  status: 'pending' | 'answered' | 'withdrawn' | 'expired';
  evidence: string[];
  created_by: string;
  created_at: string;
  resolution_note: string | null;
};

export type ProjectCard = {
  id: string;
  title: string;
  stage: Stage;
  priority: Priority | null;
  summary: string | null;
  why: string | null;
  done_criteria: string | null;
  merged_into: string | null;
  locks: string[];
  created_by: string;
  created_at: string;
  /** Made by an AI, still an idea, and the user has not touched it: shown in the "new ideas" fold. */
  inbox: boolean;
  closed: boolean;
  last_activity_at: string;
  dormant_days: number | null;
  milestones_progress: { done: number; doing: number; todo: number };
  current_milestone: { id: string; title: string; status: ItemStatus } | null;
  open_todos: TodoRow[];
  open_blockers: BlockerRow[];
  active_sessions: SessionTag[];
  pending_questions: QuestionView[];
};

export type EventView = {
  id: number;
  occurred_at: string;
  recorded_at: string;
  actor: string;
  op: string;
  entity: string | null;
  args: unknown;
  before: unknown;
  after: unknown;
  reason: string | null;
  evidence: string[];
  question_id: string | null;
  reverts: number | null;
  reverted_by: number | null;
  is_veto: boolean;
};

export type ProjectDetail = ProjectCard & {
  milestones: MilestoneRow[];
  todos: TodoRow[];
  decisions: DecisionRow[];
  blockers: BlockerRow[];
  contributions: Array<ContributionRow & { session: SessionTag | null }>;
  events: EventView[];
  /** Things the user deleted or unlinked, so the curator does not propose them again. */
  tombstones: Array<{ table: string; id: string; label: string; deleted_at: string }>;
};

// ---- small helpers -----------------------------------------------------------------------------------------------

/** Rows come back from SQLite untyped; the column lists below decide which type they are. */
function asRows<T>(rows: unknown[]): T[] {
  return rows as T[];
}

/** The parsed JSON array in a column; anything malformed counts as empty. */
function jsonArray<T>(text: unknown): T[] {
  if (typeof text !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function jsonValue(text: unknown): unknown {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function priorityRank(priority: Priority | null): number {
  return priority === null ? PRIORITIES.length : PRIORITIES.indexOf(priority);
}

/** Stored timestamps are ISO strings, so they compare as text. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TODO_STATUS_RANK: Record<ItemStatus, number> = { doing: 0, todo: 1, done: 2 };

/** doing first, then P0 to unset, then oldest first. */
function compareTodos(a: TodoRow, b: TodoRow): number {
  return (
    TODO_STATUS_RANK[a.status] - TODO_STATUS_RANK[b.status] ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    compareText(a.created_at, b.created_at)
  );
}

// ---- loading one project's parts ---------------------------------------------------------------------------------

type ProjectRaw = {
  id: string;
  title: string;
  stage: Stage;
  priority: Priority | null;
  summary: string | null;
  why: string | null;
  done_criteria: string | null;
  merged_into: string | null;
  locks: string;
  created_by: string;
  user_touched: number;
  created_at: string;
};

const PROJECT_COLUMNS =
  'id, title, stage, priority, summary, why, done_criteria, merged_into, locks, created_by, user_touched, created_at';

function loadMilestones(db: DatabaseSync, projectId: string): MilestoneRow[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, title, status, position, locks, created_by, created_at
       FROM milestones WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, created_at, rowid`,
    )
    .all(projectId);
  return asRows<Omit<MilestoneRow, 'locks'> & { locks: string }>(rows).map((r) => ({ ...r, locks: readLocks(r) }));
}

function loadTodos(db: DatabaseSync, projectId: string): TodoRow[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, milestone_id, title, status, priority, locks, created_by, created_at
       FROM todos WHERE project_id = ? AND deleted_at IS NULL ORDER BY rowid`,
    )
    .all(projectId);
  return asRows<Omit<TodoRow, 'locks'> & { locks: string }>(rows)
    .map((r) => ({ ...r, locks: readLocks(r) }))
    .sort(compareTodos);
}

function loadDecisions(db: DatabaseSync, projectId: string): DecisionRow[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, text, decided_at, evidence, created_by, created_at
       FROM decisions WHERE project_id = ? AND deleted_at IS NULL ORDER BY decided_at DESC, rowid DESC`,
    )
    .all(projectId);
  return asRows<Omit<DecisionRow, 'evidence'> & { evidence: string }>(rows).map((r) => ({
    ...r,
    evidence: jsonArray<string>(r.evidence),
  }));
}

function loadBlockers(db: DatabaseSync, projectId: string): BlockerRow[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, text, kind, status, cleared_at, created_by, created_at
       FROM blockers WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid`,
    )
    .all(projectId);
  return asRows<BlockerRow>(rows).map((r) => ({ ...r }));
}

/** Live links, most recently worked on first, those without an end time last. */
function loadContributions(db: DatabaseSync, projectId: string): ContributionRow[] {
  const rows = db
    .prepare(
      `SELECT id, session_key, project_id, milestone_id, summary, ts_start, ts_end, confidence, actor, created_at
       FROM contributions WHERE project_id = ? AND deleted_at IS NULL
       ORDER BY ts_end IS NULL, ts_end DESC, created_at DESC, rowid DESC`,
    )
    .all(projectId);
  return asRows<ContributionRow>(rows).map((r) => ({ ...r }));
}

type QuestionRaw = Omit<QuestionView, 'options' | 'evidence'> & { options: string; evidence: string };

const QUESTION_COLUMNS =
  'id, kind, prompt, options, project_id, session_key, status, evidence, created_by, created_at, resolution_note';

function questionView(r: QuestionRaw): QuestionView {
  return {
    id: r.id,
    kind: r.kind,
    prompt: r.prompt,
    options: jsonArray<QuestionOption>(r.options).map((o) => {
      const view: QuestionOptionView =
        o.op === null
          ? { label: o.label, has_op: false, op: null, args: null }
          : { label: o.label, has_op: true, op: o.op, args: { ...(o.args ?? {}) } };
      if (o.text_arg !== undefined) view.text_arg = o.text_arg;
      return view;
    }),
    project_id: r.project_id,
    session_key: r.session_key,
    status: r.status,
    evidence: jsonArray<string>(r.evidence),
    created_by: r.created_by,
    created_at: r.created_at,
    resolution_note: r.resolution_note,
  };
}

/** Pending questions of a project, newest first. Those past their time limit are left out even before `listQuestions` expires them. */
function loadPendingQuestions(db: DatabaseSync, now: Date, projectId: string): QuestionView[] {
  const cutoff = new Date(now.getTime() - QUESTION_TTL_DAYS * DAY_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT ${QUESTION_COLUMNS} FROM questions
       WHERE project_id = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at DESC, rowid DESC`,
    )
    .all(projectId, cutoff);
  return asRows<QuestionRaw>(rows).map(questionView);
}

function sessionTag(view: SessionView, milestoneId: string | null): SessionTag {
  return {
    key: view.key,
    short_id: view.short_id,
    machine: view.machine,
    agent_kind: view.agent_kind,
    effective_status: view.effective_status,
    title: view.title,
    milestone_id: milestoneId,
  };
}

// ---- cards -------------------------------------------------------------------------------------------------------

/** A card and the live parts it was built from, which the detail reuses. */
type Assembled = {
  card: ProjectCard;
  milestones: MilestoneRow[];
  todos: TodoRow[];
  blockers: BlockerRow[];
  contributions: ContributionRow[];
};

function assemble(db: DatabaseSync, now: Date, project: ProjectRaw, sessions: Map<string, SessionView>): Assembled {
  const milestones = loadMilestones(db, project.id);
  const todos = loadTodos(db, project.id);
  const blockers = loadBlockers(db, project.id);

  // Deleting a milestone leaves contributions pointing at it; they read as having no milestone.
  const liveMilestones = new Set(milestones.map((m) => m.id));
  const contributions = loadContributions(db, project.id).map((c) => ({
    ...c,
    milestone_id: c.milestone_id !== null && liveMilestones.has(c.milestone_id) ? c.milestone_id : null,
  }));

  const activeSessions: SessionTag[] = [];
  let lastActivity = project.created_at;
  for (const c of contributions) {
    if (c.ts_end !== null && c.ts_end > lastActivity) lastActivity = c.ts_end;
    const session = sessions.get(c.session_key);
    if (session && !session.ignored && session.effective_status !== 'ended' && session.effective_status !== 'purged') {
      activeSessions.push(sessionTag(session, c.milestone_id));
    }
  }

  const idleDays = Math.floor((now.getTime() - Date.parse(lastActivity)) / DAY_MS);
  const current = milestones.find((m) => m.status === 'doing') ?? milestones.find((m) => m.status === 'todo');

  const card: ProjectCard = {
    id: project.id,
    title: project.title,
    stage: project.stage,
    priority: project.priority,
    summary: project.summary,
    why: project.why,
    done_criteria: project.done_criteria,
    merged_into: project.merged_into,
    locks: readLocks(project),
    created_by: project.created_by,
    created_at: project.created_at,
    inbox: project.created_by !== 'user' && project.stage === 'idea' && !project.user_touched,
    closed: CLOSED.includes(project.stage),
    last_activity_at: lastActivity,
    dormant_days: activeSessions.length === 0 && idleDays >= DORMANT_AFTER_DAYS ? idleDays : null,
    milestones_progress: {
      done: milestones.filter((m) => m.status === 'done').length,
      doing: milestones.filter((m) => m.status === 'doing').length,
      todo: milestones.filter((m) => m.status === 'todo').length,
    },
    current_milestone: current ? { id: current.id, title: current.title, status: current.status } : null,
    open_todos: todos.filter((todo) => todo.status !== 'done'),
    open_blockers: blockers.filter((b) => b.status !== 'cleared'),
    active_sessions: activeSessions,
    pending_questions: loadPendingQuestions(db, now, project.id),
  };
  return { card, milestones, todos, blockers, contributions };
}

function sessionIndex(db: DatabaseSync, now: Date): Map<string, SessionView> {
  return new Map(listSessions(db, {}, now).map((s) => [s.key, s]));
}

/**
 * The home page cards: live projects, closed ones last, then P0 to unset, then most recently active first.
 * `now` fixes the clock for session status, dormancy and question expiry; nothing is written.
 */
export function listProjects(db: DatabaseSync, now: Date, filter: { stage?: Stage; priority?: Priority }): ProjectCard[] {
  const where = ['deleted_at IS NULL'];
  const params: string[] = [];
  if (filter.stage !== undefined) {
    where.push('stage = ?');
    params.push(filter.stage);
  }
  if (filter.priority !== undefined) {
    where.push('priority = ?');
    params.push(filter.priority);
  }
  const projects = asRows<ProjectRaw>(
    db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE ${where.join(' AND ')} ORDER BY rowid`).all(...params),
  );

  const sessions = sessionIndex(db, now);
  return projects
    .map((project) => assemble(db, now, project, sessions).card)
    .sort(
      (a, b) =>
        Number(a.closed) - Number(b.closed) ||
        priorityRank(a.priority) - priorityRank(b.priority) ||
        compareText(b.last_activity_at, a.last_activity_at),
    );
}

// ---- detail ------------------------------------------------------------------------------------------------------

type EventRaw = {
  id: number;
  occurred_at: string;
  recorded_at: string;
  actor: string;
  op: string;
  entity: string | null;
  args: string;
  before: string;
  after: string;
  reason: string | null;
  evidence: string;
  question_id: string | null;
  reverts: number | null;
  reverted_by: number | null;
  is_veto: number;
};

function loadEvents(db: DatabaseSync, projectId: string): EventView[] {
  const rows = db
    .prepare(
      `SELECT id, occurred_at, recorded_at, actor, op, entity, args, before, after, reason, evidence, question_id,
              reverts, reverted_by, is_veto
       FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(projectId, EVENTS_IN_DETAIL);
  return asRows<EventRaw>(rows).map((r) => ({
    id: r.id,
    occurred_at: r.occurred_at,
    recorded_at: r.recorded_at,
    actor: r.actor,
    op: r.op,
    entity: r.entity,
    args: jsonValue(r.args),
    before: jsonValue(r.before),
    after: jsonValue(r.after),
    reason: r.reason,
    evidence: jsonArray<string>(r.evidence),
    question_id: r.question_id,
    reverts: r.reverts,
    reverted_by: r.reverted_by,
    is_veto: r.is_veto === 1,
  }));
}

/** Table name and the column that names a row. Both are constants: they are spliced into SQL. */
const TOMBSTONE_SOURCES = [
  { table: 'milestones', label: 'title' },
  { table: 'todos', label: 'title' },
  { table: 'decisions', label: 'text' },
  { table: 'blockers', label: 'text' },
  { table: 'contributions', label: 'session_key' },
] as const;

/** Rows of this project the user deleted or unlinked (vetoes), newest first. An AI deleting its own item is not one. */
function loadTombstones(db: DatabaseSync, projectId: string): ProjectDetail['tombstones'] {
  return TOMBSTONE_SOURCES.flatMap(({ table, label }) =>
    asRows<{ id: string; label: string; deleted_at: string }>(
      db
        .prepare(
          `SELECT id, ${label} AS label, deleted_at FROM ${table}
           WHERE project_id = ? AND vetoed = 1 AND deleted_at IS NOT NULL ORDER BY rowid`,
        )
        .all(projectId),
    ).map((r) => ({ table, id: r.id, label: r.label, deleted_at: r.deleted_at })),
  ).sort((a, b) => compareText(b.deleted_at, a.deleted_at));
}

/** One project with everything on it; `null` when it does not exist or was deleted. */
export function getProject(db: DatabaseSync, now: Date, id: string): ProjectDetail | null {
  const project = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as ProjectRaw | undefined;
  if (project === undefined) return null;

  const sessions = sessionIndex(db, now);
  const { card, milestones, todos, blockers, contributions } = assemble(db, now, project, sessions);
  return {
    ...card,
    milestones,
    todos,
    decisions: loadDecisions(db, id),
    blockers,
    contributions: contributions.map((c) => {
      const session = sessions.get(c.session_key);
      return { ...c, session: session ? sessionTag(session, c.milestone_id) : null };
    }),
    events: loadEvents(db, id),
    tombstones: loadTombstones(db, id),
  };
}

// ---- questions ---------------------------------------------------------------------------------------------------

/**
 * Questions, newest first, leaving out those about a deleted project (reverting an AI's `create_project` deletes it, and
 * the questions asked about it carry no guards to withdraw them). Pending questions past their time limit are expired
 * first, so this writes.
 */
export function listQuestions(
  db: DatabaseSync,
  deps: DomainDeps,
  filter: { status?: QuestionView['status']; project_id?: string },
): QuestionView[] {
  expireQuestions(db, deps);
  const where = ['(project_id IS NULL OR project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL))'];
  const params: string[] = [];
  if (filter.status !== undefined) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.project_id !== undefined) {
    where.push('project_id = ?');
    params.push(filter.project_id);
  }
  const rows = db
    .prepare(
      `SELECT ${QUESTION_COLUMNS} FROM questions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC`,
    )
    .all(...params);
  return asRows<QuestionRaw>(rows).map(questionView);
}
