import type { DatabaseSync } from 'node:sqlite';
import { readRow } from './changes.ts';
import type { Row } from './changes.ts';
import type { Handler, OpContext } from './execute.ts';
import { definedFields } from './field-edits.ts';
import { checkMilestone } from './items-ops.ts';
import type { OpArgs, OpName } from './ops.ts';
import { loadProject } from './projects-ops.ts';
import { confirmOptions } from './questions.ts';
import { OpRejected } from './types.ts';

/** How many `merged_into` links `resolveSessionKey` follows (same bound as chunk routing in sessions-repo). */
const MAX_MERGE_HOPS = 5;

/**
 * The key a session is known by now: follows `merged_into` (a pending key that got its native id) at most 5 hops.
 * `null` when `key` is not a session.
 */
export function resolveSessionKey(db: DatabaseSync, key: string): string | null {
  const select = db.prepare('SELECT merged_into FROM sessions WHERE key = ?');
  let current = key;
  for (let hop = 0; ; hop++) {
    const found = select.get(current) as { merged_into: string | null } | undefined;
    if (found === undefined) return null;
    if (found.merged_into === null || hop === MAX_MERGE_HOPS) return current;
    current = found.merged_into;
  }
}

function requireSession(ctx: OpContext, key: string): string {
  const resolved = resolveSessionKey(ctx.db, key);
  if (resolved === null) throw new OpRejected('not_found', `session ${key} not found`);
  return resolved;
}

/** The (session, project) link row, live or tombstone; there is at most one. */
function findLink(db: DatabaseSync, session: string, projectId: string): Row | undefined {
  const found = db.prepare('SELECT * FROM contributions WHERE session_key = ? AND project_id = ?').get(session, projectId);
  return found === undefined ? undefined : { ...found };
}

/** The earlier (`min`) or later (`max`) of a stored and a given instant; `undefined` when nothing was given. */
function widen(stored: unknown, given: string | undefined, pick: 'min' | 'max'): string | undefined {
  if (given === undefined) return undefined;
  if (typeof stored !== 'string') return given;
  return (pick === 'min' ? given < stored : given > stored) ? given : stored;
}

/**
 * Links a session (by its final key) to a project: one row per pair, whose time range only ever widens. A tombstone is
 * revived, except one the user vetoed, which an AI may only ask about. An AI may not link a session the user ignores
 * (`not_allowed`), and on a live link the user made it only widens the time range. Also used by `create_project`
 * with `from_session`.
 */
export function linkSession(ctx: OpContext, args: OpArgs<'link_session'>): { id: string } | void {
  const session = requireSession(ctx, args.session);
  if (ctx.ai && readRow(ctx.db, 'sessions', session)?.ignored === 1) {
    throw new OpRejected('not_allowed', `session ${session} is ignored; only the user may link it`);
  }
  const project = loadProject(ctx, args.project);
  if (typeof args.milestone_id === 'string') checkMilestone(ctx, args.project, args.milestone_id);

  const existing = findLink(ctx.db, session, args.project);
  if (!existing) {
    const id = ctx.deps.newId('c');
    ctx.changes.insert('contributions', {
      id,
      session_key: session,
      project_id: args.project,
      milestone_id: args.milestone_id ?? null,
      summary: args.summary ?? null,
      ts_start: args.ts_start ?? null,
      ts_end: args.ts_end ?? null,
      confidence: args.confidence ?? null,
      actor: ctx.actor,
      created_at: ctx.deps.now().toISOString(),
    });
    return { id };
  }

  const id = String(existing.id);
  if (ctx.ai && existing.deleted_at !== null && existing.vetoed === 1) {
    ctx.propose({
      kind: 'confirm',
      prompt: `AI 想把 session ${session} 重新关联到「${String(project.title)}」（你之前取消过）：${ctx.reason}`,
      options: confirmOptions('link_session', { ...args, session }),
      project_id: args.project,
      session_key: session,
      guards: [{ table: 'contributions', id, col: 'deleted_at', equals: existing.deleted_at }],
      dedupe_key: `link:${session}:${args.project}`,
    });
    return;
  }

  let fields = definedFields({ milestone_id: args.milestone_id, summary: args.summary, confidence: args.confidence });
  // The user's own description of a live link stays theirs; an AI may only add to its time range.
  if (ctx.ai && existing.deleted_at === null && existing.actor === 'user') {
    const dropped = Object.keys(fields);
    if (dropped.length > 0) ctx.warnings.push(`the user made this link; ${dropped.join(', ')} left as they are`);
    fields = {};
  }
  ctx.changes.update('contributions', id, {
    ...fields,
    ts_start: widen(existing.ts_start, args.ts_start, 'min'),
    ts_end: widen(existing.ts_end, args.ts_end, 'max'),
    deleted_at: null,
    vetoed: 0,
    // A link the user makes is theirs from then on, so an AI can no longer take it back without asking.
    actor: ctx.ai ? undefined : 'user',
  });
  return { id };
}

/**
 * The user's unlink is a veto (a tombstone an AI may only ask to undo). An AI removes links it made itself; one the
 * user made it can only propose removing.
 */
function unlinkSession(ctx: OpContext, args: OpArgs<'unlink_session'>): void {
  const session = requireSession(ctx, args.session);
  const project = loadProject(ctx, args.project);
  const link = findLink(ctx.db, session, args.project);
  if (!link || link.deleted_at !== null) {
    throw new OpRejected('not_found', `session ${session} is not linked to project ${args.project}`);
  }

  if (ctx.ai && link.actor === 'user') {
    ctx.propose({
      kind: 'confirm',
      prompt: `AI 想取消你建立的关联：session ${session} ↔「${String(project.title)}」：${ctx.reason}`,
      options: confirmOptions('unlink_session', { session, project: args.project }),
      project_id: args.project,
      session_key: session,
      guards: [{ table: 'contributions', id: String(link.id), col: 'deleted_at', equals: null }],
      dedupe_key: `unlink:${session}:${args.project}`,
    });
    return;
  }

  ctx.changes.update('contributions', String(link.id), { deleted_at: ctx.deps.now().toISOString(), vetoed: ctx.ai ? 0 : 1 });
  if (!ctx.ai) ctx.isVeto = true;
}

/** Stops (or resumes) tracking a session. Not tied to a project. An AI can only suggest it. */
function ignoreSession(ctx: OpContext, args: OpArgs<'ignore_session'>): void {
  const key = requireSession(ctx, args.session);
  const session = readRow(ctx.db, 'sessions', key) as Row;
  const target = args.ignored ? 1 : 0;

  if (!ctx.ai) {
    ctx.changes.update('sessions', key, { ignored: target });
    return;
  }
  if ((session.ignored ?? 0) === target) return;
  ctx.propose({
    kind: 'confirm',
    prompt: `AI 建议${args.ignored ? '不再' : '恢复'}追踪 session ${key}：${ctx.reason}`,
    options: confirmOptions('ignore_session', { session: key, ignored: args.ignored }),
    project_id: null,
    session_key: key,
    guards: [{ table: 'sessions', id: key, col: 'ignored', equals: session.ignored }],
    dedupe_key: `ignore:${key}`,
  });
}

export const LINK_HANDLERS: Partial<Record<OpName, Handler>> = {
  link_session: linkSession,
  unlink_session: unlinkSession,
  ignore_session: ignoreSession,
};
