import { addLocks, readLocks, readRow } from './changes.ts';
import type { Row } from './changes.ts';
import type { Handler, OpContext } from './execute.ts';
import { applyAiFieldEdits, definedFields } from './field-edits.ts';
import type { FieldValue } from './field-edits.ts';
import type { OpArgs, OpName } from './ops.ts';
import { loadProject } from './projects-ops.ts';
import { confirmOptions } from './questions.ts';
import { OpRejected } from './types.ts';

/** The tables of things that hang off a project and can be deleted. */
export type ItemTable = 'milestones' | 'todos' | 'decisions' | 'blockers';

const LABEL: Record<ItemTable, string> = { milestones: '里程碑', todos: 'todo', decisions: '决策', blockers: '阻塞' };

const DELETE_OP: Record<ItemTable, OpName> = {
  milestones: 'delete_milestone',
  todos: 'delete_todo',
  decisions: 'delete_decision',
  blockers: 'delete_blocker',
};

/**
 * The live row `id` of `table` in project `projectId`. One that is missing or belongs to another project → `not_found`.
 * A deleted one is `not_found` for the user; for an AI it is `vetoed` when the user deleted it (a tombstone the AI may
 * not touch or restore) and `not_found` otherwise.
 */
export function loadItem(ctx: OpContext, table: ItemTable, projectId: string, id: string): Row {
  const row = readRow(ctx.db, table, id);
  if (!row || row.project_id !== projectId) {
    throw new OpRejected('not_found', `${LABEL[table]} ${id} not found in project ${projectId}`);
  }
  if (row.deleted_at !== null) {
    if (ctx.ai && row.vetoed === 1) {
      throw new OpRejected('vetoed', `the user deleted ${LABEL[table]} ${id}; an AI may not change or restore it`);
    }
    throw new OpRejected('not_found', `${LABEL[table]} ${id} not found in project ${projectId}`);
  }
  return row;
}

function now(ctx: OpContext): string {
  return ctx.deps.now().toISOString();
}

/** The `locks` for a new row: the fields a user gave are locked, an AI's are not. */
function newLocks(ctx: OpContext, fields: Record<string, FieldValue>): string {
  return ctx.ai ? '[]' : addLocks({}, Object.keys(fields));
}

/**
 * Edits `fields` of a milestone or todo `row`. The user writes them and locks them; an AI writes the unlocked ones and
 * proposes the locked ones.
 */
function editLockable(
  ctx: OpContext,
  table: 'milestones' | 'todos',
  op: 'upsert_milestone' | 'upsert_todo',
  args: { project: string; id: string },
  row: Row,
  fields: Record<string, FieldValue>,
): { id: string } {
  if (ctx.ai) {
    applyAiFieldEdits(ctx, table, row, fields, {
      op,
      args: (proposed) => ({ project: args.project, id: args.id, ...proposed }),
    });
  } else {
    ctx.changes.update(table, args.id, { ...fields, locks: addLocks(row, Object.keys(fields)) });
  }
  return { id: args.id };
}

// ---- milestones --------------------------------------------------------------------------------------------------

function nextPosition(ctx: OpContext, projectId: string): number {
  const { top } = ctx.db
    .prepare('SELECT MAX(position) AS top FROM milestones WHERE project_id = ? AND deleted_at IS NULL')
    .get(projectId) as { top: number | null };
  return top === null ? 0 : top + 1;
}

function upsertMilestone(ctx: OpContext, args: OpArgs<'upsert_milestone'>): { id: string } {
  loadProject(ctx, args.project);
  const fields = definedFields({ title: args.title, status: args.status, position: args.position });

  if (args.id !== undefined) {
    const row = loadItem(ctx, 'milestones', args.project, args.id);
    return editLockable(ctx, 'milestones', 'upsert_milestone', { project: args.project, id: args.id }, row, fields);
  }

  if (args.title === undefined) throw new OpRejected('invalid', 'a new milestone needs a title');
  const id = ctx.deps.newId('m');
  ctx.changes.insert('milestones', {
    id,
    project_id: args.project,
    title: args.title,
    status: args.status ?? 'todo',
    position: args.position ?? nextPosition(ctx, args.project),
    locks: newLocks(ctx, fields),
    created_by: ctx.actor,
    created_at: now(ctx),
  });
  return { id };
}

// ---- todos -------------------------------------------------------------------------------------------------------

/** A todo may only hang under a live milestone of its own project. */
function checkMilestone(ctx: OpContext, projectId: string, milestoneId: string): void {
  const milestone = readRow(ctx.db, 'milestones', milestoneId);
  if (!milestone || milestone.project_id !== projectId || milestone.deleted_at !== null) {
    throw new OpRejected('invalid', `milestone ${milestoneId} is not a live milestone of project ${projectId}`);
  }
}

function upsertTodo(ctx: OpContext, args: OpArgs<'upsert_todo'>): { id: string } {
  loadProject(ctx, args.project);
  const fields = definedFields({
    title: args.title,
    status: args.status,
    priority: args.priority,
    milestone_id: args.milestone_id,
  });

  if (args.id !== undefined) {
    const row = loadItem(ctx, 'todos', args.project, args.id);
    if (typeof args.milestone_id === 'string') checkMilestone(ctx, args.project, args.milestone_id);
    return editLockable(ctx, 'todos', 'upsert_todo', { project: args.project, id: args.id }, row, fields);
  }

  if (args.title === undefined) throw new OpRejected('invalid', 'a new todo needs a title');
  if (typeof args.milestone_id === 'string') checkMilestone(ctx, args.project, args.milestone_id);
  const id = ctx.deps.newId('t');
  ctx.changes.insert('todos', {
    id,
    project_id: args.project,
    milestone_id: args.milestone_id ?? null,
    title: args.title,
    status: args.status ?? 'todo',
    priority: args.priority ?? null,
    locks: newLocks(ctx, fields),
    created_by: ctx.actor,
    created_at: now(ctx),
  });
  return { id };
}

// ---- decisions and blockers --------------------------------------------------------------------------------------

function recordDecision(ctx: OpContext, args: OpArgs<'record_decision'>): { id: string } {
  loadProject(ctx, args.project);
  const id = ctx.deps.newId('d');
  ctx.changes.insert('decisions', {
    id,
    project_id: args.project,
    text: args.text,
    decided_at: args.decided_at ?? ctx.occurredAt,
    evidence: JSON.stringify(ctx.evidence),
    created_by: ctx.actor,
    created_at: now(ctx),
  });
  return { id };
}

function setBlocker(ctx: OpContext, args: OpArgs<'set_blocker'>): { id: string } {
  loadProject(ctx, args.project);

  if (args.id !== undefined) {
    loadItem(ctx, 'blockers', args.project, args.id);
    ctx.changes.update('blockers', args.id, definedFields({ text: args.text, kind: args.kind }));
    return { id: args.id };
  }

  if (args.text === undefined) throw new OpRejected('invalid', 'a new blocker needs text');
  const id = ctx.deps.newId('b');
  ctx.changes.insert('blockers', {
    id,
    project_id: args.project,
    text: args.text,
    kind: args.kind ?? 'technical',
    status: 'open',
    created_by: ctx.actor,
    created_at: now(ctx),
  });
  return { id };
}

function clearBlocker(ctx: OpContext, args: OpArgs<'clear_blocker'>): void {
  loadProject(ctx, args.project);
  const row = loadItem(ctx, 'blockers', args.project, args.id);
  if (row.status === 'cleared') return;
  ctx.changes.update('blockers', args.id, { status: 'cleared', cleared_at: now(ctx) });
}

// ---- deleting ----------------------------------------------------------------------------------------------------

/**
 * The user's delete is a veto: a tombstone the AI may not touch. An AI may delete what it made itself and the user
 * never edited; deleting anything else it can only propose. Deleting a milestone detaches its todos, so an AI that
 * would clear a todo's locked `milestone_id` may only propose it too.
 */
function deleteItem(ctx: OpContext, table: ItemTable, args: { project: string; id: string }): void {
  loadProject(ctx, args.project);
  const row = loadItem(ctx, table, args.project, args.id);

  const attached =
    table === 'milestones'
      ? (ctx.db
          .prepare('SELECT id, locks FROM todos WHERE milestone_id = ? AND deleted_at IS NULL ORDER BY rowid')
          .all(args.id) as Array<{ id: string; locks: string }>)
      : [];

  const touchesUserWork =
    row.created_by === 'user' || readLocks(row).length > 0 || attached.some((todo) => readLocks(todo).includes('milestone_id'));
  if (ctx.ai && touchesUserWork) {
    ctx.propose({
      kind: 'confirm',
      prompt: `AI 想删除你编辑过的${LABEL[table]}「${String(row.title ?? row.text)}」：${ctx.reason}`,
      options: confirmOptions(DELETE_OP[table], { project: args.project, id: args.id }),
      project_id: args.project,
      session_key: null,
      guards: [{ table, id: args.id, col: 'deleted_at', equals: null }],
      dedupe_key: `delete:${table}:${args.id}`,
    });
    return;
  }

  ctx.changes.update(table, args.id, { deleted_at: now(ctx), vetoed: ctx.ai ? 0 : 1 });
  if (!ctx.ai) ctx.isVeto = true;
  for (const todo of attached) ctx.changes.update('todos', todo.id, { milestone_id: null });
}

export const ITEM_HANDLERS: Partial<Record<OpName, Handler>> = {
  upsert_milestone: upsertMilestone,
  delete_milestone: (ctx, args: OpArgs<'delete_milestone'>) => deleteItem(ctx, 'milestones', args),
  upsert_todo: upsertTodo,
  delete_todo: (ctx, args: OpArgs<'delete_todo'>) => deleteItem(ctx, 'todos', args),
  record_decision: recordDecision,
  delete_decision: (ctx, args: OpArgs<'delete_decision'>) => deleteItem(ctx, 'decisions', args),
  set_blocker: setBlocker,
  clear_blocker: clearBlocker,
  delete_blocker: (ctx, args: OpArgs<'delete_blocker'>) => deleteItem(ctx, 'blockers', args),
};
