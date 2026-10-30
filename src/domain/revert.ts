import { addLocks, entityKey, LOCKABLE, parseEntityKey, readRow } from './changes.ts';
import type { DomainTable, Row } from './changes.ts';
import type { Handler, OpContext } from './execute.ts';
import type { OpArgs, OpName } from './ops.ts';
import { OpRejected } from './types.ts';

type EventRow = {
  id: number;
  actor: string;
  op: string;
  project_id: string | null;
  before: string;
  after: string;
  reverted_by: number | null;
};

type Columns = Record<string, unknown>;

/** One row of the event to undo, checked and ready to write back. */
type Step = { table: DomainTable; id: string; row: Row; before: Columns | null };

/** `locks` is never compared or restored: a revert must not hand back an old lock list. */
const NOT_RESTORED = 'locks';

function lockableFields(table: DomainTable): readonly string[] {
  return Object.hasOwn(LOCKABLE, table) ? LOCKABLE[table as keyof typeof LOCKABLE] : [];
}

/**
 * Live rows the user made that hang off `table:id`, as entity keys: undoing its creation would hide or orphan them.
 * Rows the same event inserted are left out (they are undone with it), and so are rows an AI made.
 */
function userDependents(ctx: OpContext, table: DomainTable, id: string): string[] {
  // Table and column names are constants: they are spliced into SQL.
  const sources: Array<{ table: DomainTable; where: string }> =
    table === 'projects'
      ? [
          { table: 'todos', where: "project_id = ? AND created_by = 'user'" },
          { table: 'milestones', where: "project_id = ? AND created_by = 'user'" },
          { table: 'decisions', where: "project_id = ? AND created_by = 'user'" },
          { table: 'blockers', where: "project_id = ? AND created_by = 'user'" },
          { table: 'contributions', where: "project_id = ? AND actor = 'user'" },
        ]
      : table === 'milestones'
        ? [{ table: 'todos', where: "milestone_id = ? AND created_by = 'user'" }]
        : [];
  return sources.flatMap((source) => {
    const found = ctx.db
      .prepare(`SELECT id FROM ${source.table} WHERE ${source.where} AND deleted_at IS NULL ORDER BY rowid`)
      .all(id) as Array<{ id: string }>;
    return found.map((r) => entityKey(source.table, r.id));
  });
}

/**
 * Checks every row of the event before anything is written: each must still exist and still hold the event's `after`
 * values. An inserted row must merely still be live, and nothing the user made since may depend on it (a todo in the
 * project, a todo in the milestone). Anything else → `conflict`, naming the row or column.
 */
function checkRows(ctx: OpContext, event: EventRow): Step[] {
  const before = JSON.parse(event.before) as Record<string, Columns | null>;
  const after = JSON.parse(event.after) as Record<string, Columns>;
  const inEvent = new Set(Object.keys(after));
  return Object.keys(after).map((key) => {
    const { table, id } = parseEntityKey(key);
    const old = before[key];
    if (old === undefined) throw new Error(`event ${event.id} has no before for ${key}`);
    const row = readRow(ctx.db, table, id);
    if (!row) throw new OpRejected('conflict', `${key} no longer exists`);
    if (old === null) {
      if (row.deleted_at !== null) throw new OpRejected('conflict', `${key} was deleted after event ${event.id}`);
      const blocking = userDependents(ctx, table, id).find((dep) => !inEvent.has(dep));
      if (blocking !== undefined) {
        throw new OpRejected('conflict', `${blocking}, made by the user, depends on ${key}; delete or move it first`);
      }
    } else {
      for (const [col, value] of Object.entries(after[key])) {
        if (col !== NOT_RESTORED && row[col] !== value) {
          throw new OpRejected('conflict', `${key}.${col} changed after event ${event.id}`);
        }
      }
    }
    return { table, id, row, before: old };
  });
}

/**
 * The user undoes one event. A row the event inserted becomes a tombstone; any other row gets its `before` values
 * back. Undoing an AI's event is a veto: restored lockable fields are locked, and rows left deleted are vetoed
 * tombstones the AI may not revive. A revert can itself be undone the same way; since its actor is the user, that is
 * a plain write-back of its `before` values, never a veto.
 */
function revertEvent(ctx: OpContext, args: OpArgs<'revert_event'>): void {
  const event = ctx.db
    .prepare('SELECT id, actor, op, project_id, before, after, reverted_by FROM events WHERE id = ?')
    .get(args.event_id) as EventRow | undefined;
  if (!event) throw new OpRejected('not_found', `event ${args.event_id} not found`);
  if (event.reverted_by !== null) {
    throw new OpRejected('already_reverted', `event ${event.id} was already reverted by event ${event.reverted_by}`);
  }

  const veto = event.actor !== 'user';
  const now = ctx.deps.now().toISOString();
  for (const { table, id, row, before } of checkRows(ctx, event)) {
    const patch: Record<string, string | number | null> = {};
    if (before === null) {
      patch.deleted_at = now;
      if (veto) patch.vetoed = 1;
    } else {
      const restored = Object.keys(before).filter((col) => col !== NOT_RESTORED);
      for (const col of restored) patch[col] = before[col] as string | number | null;
      if (veto) {
        const locked = restored.filter((col) => lockableFields(table).includes(col));
        if (locked.length > 0) patch.locks = addLocks(row, locked);
        const deletedAt = Object.hasOwn(patch, 'deleted_at') ? patch.deleted_at : row.deleted_at;
        if (typeof deletedAt === 'string') patch.vetoed = 1;
      }
    }
    ctx.changes.update(table, id, patch);
  }

  if (ctx.changes.changes.length === 0) {
    throw new OpRejected('not_revertible', `event ${event.id} changed only locks, which a revert does not restore`);
  }
  ctx.projectId = event.project_id;
  ctx.isVeto = veto;
  ctx.reverts = event.id;
}

export const REVERT_HANDLERS: Partial<Record<OpName, Handler>> = {
  revert_event: revertEvent,
};
