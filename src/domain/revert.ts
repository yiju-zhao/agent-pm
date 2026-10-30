import { addLocks, LOCKABLE, parseEntityKey, readRow } from './changes.ts';
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
 * Checks every row of the event before anything is written: each must still exist and still hold the event's `after`
 * values (an inserted row must merely still be live). Anything else → `conflict`, naming the row or column.
 */
function checkRows(ctx: OpContext, event: EventRow): Step[] {
  const before = JSON.parse(event.before) as Record<string, Columns | null>;
  const after = JSON.parse(event.after) as Record<string, Columns>;
  return Object.keys(after).map((key) => {
    const { table, id } = parseEntityKey(key);
    const old = before[key];
    if (old === undefined) throw new Error(`event ${event.id} has no before for ${key}`);
    const row = readRow(ctx.db, table, id);
    if (!row) throw new OpRejected('conflict', `${key} no longer exists`);
    if (old === null) {
      if (row.deleted_at !== null) throw new OpRejected('conflict', `${key} was deleted after event ${event.id}`);
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
 * tombstones the AI may not revive.
 */
function revertEvent(ctx: OpContext, args: OpArgs<'revert_event'>): void {
  const event = ctx.db
    .prepare('SELECT id, actor, op, project_id, before, after, reverted_by FROM events WHERE id = ?')
    .get(args.event_id) as EventRow | undefined;
  if (!event) throw new OpRejected('not_found', `event ${args.event_id} not found`);
  if (event.op === 'revert_event') throw new OpRejected('not_revertible', `event ${event.id} is itself a revert`);
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
