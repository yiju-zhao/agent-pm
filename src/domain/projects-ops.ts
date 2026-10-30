import { addLocks, LOCKABLE, readLocks, readRow } from './changes.ts';
import type { Row } from './changes.ts';
import type { Handler, OpContext } from './execute.ts';
import { applyAiFieldEdits, definedFields } from './field-edits.ts';
import { linkSession } from './links-ops.ts';
import type { OpArgs, OpName } from './ops.ts';
import { confirmOptions } from './questions.ts';
import { aiMayTransition, checkTransition } from './stage.ts';
import { OpRejected, STAGE_LABEL } from './types.ts';
import type { Stage } from './types.ts';

/**
 * The live project `id`, filed as the operation's project. Missing or deleted → `not_found`; an AI writing to a
 * merged project → `merged`, naming the project it was merged into.
 */
export function loadProject(ctx: OpContext, id: string): Row {
  const row = readRow(ctx.db, 'projects', id);
  if (!row || row.deleted_at !== null) throw new OpRejected('not_found', `project ${id} not found`);
  if (ctx.ai && row.stage === 'merged') {
    throw new OpRejected('merged', `project ${id} was merged into ${String(row.merged_into)}; write to that project instead`);
  }
  ctx.projectId = id;
  return row;
}

function createProject(ctx: OpContext, args: OpArgs<'create_project'>): { id: string } {
  const stage = args.stage ?? 'idea';
  if (ctx.ai && stage !== 'idea') throw new OpRejected('not_allowed', 'an AI may only create projects in idea');
  if (stage === 'merged') throw new OpRejected('invalid', 'a project cannot be created merged; create it, then merge it');

  const id = ctx.deps.newId('p');
  const given = Object.keys(definedFields(args)).filter((k) => LOCKABLE.projects.includes(k));
  ctx.changes.insert('projects', {
    id,
    title: args.title,
    summary: args.summary,
    why: args.why,
    done_criteria: args.done_criteria,
    priority: args.priority ?? null,
    stage,
    locks: ctx.ai ? '[]' : addLocks({}, given),
    created_by: ctx.actor,
    user_touched: ctx.ai ? 0 : 1,
    created_at: ctx.deps.now().toISOString(),
  });
  ctx.projectId = id;
  if (args.from_session !== undefined) linkSession(ctx, { session: args.from_session, project: id });
  return { id };
}

function updateProject(ctx: OpContext, args: OpArgs<'update_project'>): void {
  const row = loadProject(ctx, args.project);
  const fields = definedFields(args.fields);

  if (!ctx.ai) {
    const keys = Object.keys(fields);
    ctx.changes.update('projects', args.project, {
      ...fields,
      locks: addLocks(row, keys),
      user_touched: keys.includes('priority') ? 1 : undefined,
    });
    return;
  }

  applyAiFieldEdits(ctx, 'projects', row, fields, {
    op: 'update_project',
    args: (proposed) => ({ project: args.project, fields: proposed }),
  });
}

function transitionStage(ctx: OpContext, args: OpArgs<'transition_stage'>): void {
  const row = loadProject(ctx, args.project);
  const from = row.stage as Stage;
  const to = args.stage;
  checkTransition(from, to, args.merge_into);

  let target: Row | undefined;
  if (args.merge_into !== undefined) {
    target = readRow(ctx.db, 'projects', args.merge_into);
    if (!target || target.deleted_at !== null || target.id === args.project || target.stage === 'merged') {
      throw new OpRejected('invalid', `cannot merge into ${args.merge_into}: it must be another live project that is not merged`);
    }
  }

  if (ctx.ai && !aiMayTransition(from, to)) {
    const where = target ? `合并到「${String(target.title)}」` : `转到${STAGE_LABEL[to]}`;
    ctx.propose({
      kind: 'confirm',
      prompt: `AI 建议把「${String(row.title)}」从${STAGE_LABEL[from]}${where}：${ctx.reason}`,
      options: confirmOptions('transition_stage', args),
      project_id: args.project,
      session_key: null,
      guards: [{ table: 'projects', id: args.project, col: 'stage', equals: from }],
      dedupe_key: `stage:${args.project}:${to}`,
    });
    return;
  }

  ctx.changes.update('projects', args.project, {
    stage: to,
    stage_before_park: to === 'parked' ? from : from === 'parked' ? null : undefined,
    merged_into: to === 'merged' ? args.merge_into : from === 'merged' ? null : undefined,
    user_touched: ctx.ai ? undefined : 1,
  });
}

function unlockField(ctx: OpContext, args: OpArgs<'unlock_field'>): void {
  const { table, id, field } = args;
  if (!LOCKABLE[table].includes(field)) throw new OpRejected('invalid', `${table}.${field} cannot be locked`);

  let row: Row;
  if (table === 'projects') {
    row = loadProject(ctx, id);
  } else {
    const found = readRow(ctx.db, table, id);
    if (!found || found.deleted_at !== null) throw new OpRejected('not_found', `${table}:${id} not found`);
    row = found;
    ctx.projectId = typeof found.project_id === 'string' ? found.project_id : null;
  }

  const locks = readLocks(row);
  if (!locks.includes(field)) return;
  ctx.changes.update(table, id, { locks: JSON.stringify(locks.filter((f) => f !== field)) });
}

export const PROJECT_HANDLERS: Partial<Record<OpName, Handler>> = {
  create_project: createProject,
  update_project: updateProject,
  transition_stage: transitionStage,
  unlock_field: unlockField,
};
