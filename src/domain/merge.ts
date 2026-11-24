import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { addLocks, readLocks, readRow } from './changes.ts';
import type { Row } from './changes.ts';
import type { Handler, OpContext } from './execute.ts';
import { carrySessionLink, resolveSessionKey } from './links-ops.ts';
import type { OpArgs, OpName } from './ops.ts';
import { OpRejected } from './types.ts';

// Merging one project into another, in two shapes:
//  - `project`: the whole source. Every session of the source is also linked to the target, and the source becomes
//    `merged` (its own record and links stay, read-only, as before).
//  - `sessions`: some of the source's sessions. Their link moves: the target gets it, the source's is taken back (a
//    tombstone, like an unlink by the user). The source project stays as it is, with its other sessions.
// Only the link between a session and a project moves. Sessions, their content, their links to other projects and the
// event history are never touched, and a session the target already has is not linked twice.
//
// A merge is prepared as a preview (understand/merge-preview.ts writes the draft text) and applied by `apply_merge`,
// which writes exactly what the preview holds. Which links move is computed here from the database, never by a model.

export type MergeMode = 'project' | 'sessions';
export type MergeScope = { source: string; target: string; mode: MergeMode; sessions: string[] };

/** The text fields of a project a merge draft rewrites. */
export const DRAFT_FIELDS = ['title', 'summary', 'why', 'done_criteria'] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];
export type DraftText = Record<DraftField, string>;

function liveProject(db: DatabaseSync, id: string, what: string): Row {
  const row = readRow(db, 'projects', id);
  if (!row || row.deleted_at !== null) throw new OpRejected('not_found', `project ${id} not found`);
  if (row.stage === 'merged') throw new OpRejected('invalid', `${what} ${id} is already merged into ${String(row.merged_into)}`);
  return row;
}

/** The sessions a project is linked to now, by key. */
export function liveSessions(db: DatabaseSync, projectId: string): string[] {
  const rows = db.prepare('SELECT session_key FROM contributions WHERE project_id = ? AND deleted_at IS NULL ORDER BY session_key').all(projectId);
  return (rows as Array<{ session_key: string }>).map((r) => r.session_key);
}

/**
 * Checks a requested merge and names its sessions by their current keys. Without `sessions` the whole source is merged;
 * with them, each must be a session the source is linked to now. Throws `OpRejected`.
 */
export function resolveMergeScope(db: DatabaseSync, source: string, target: string, sessions?: string[]): MergeScope {
  liveProject(db, source, 'the source project');
  if (source === target) throw new OpRejected('invalid', 'a project cannot be merged into itself');
  liveProject(db, target, 'the target project');
  const linked = liveSessions(db, source);
  if (sessions === undefined) return { source, target, mode: 'project', sessions: linked };

  const chosen = new Set<string>();
  for (const key of sessions) {
    const resolved = resolveSessionKey(db, key);
    if (resolved === null || !linked.includes(resolved)) throw new OpRejected('invalid', `session ${key} is not linked to project ${source}`);
    chosen.add(resolved);
  }
  if (chosen.size === 0) throw new OpRejected('invalid', 'choose at least one session to move');
  return { source, target, mode: 'sessions', sessions: [...chosen].sort() };
}

/** The sessions whose content a merge draft is built from: the target's own and the ones coming over. */
export function evidenceSessions(db: DatabaseSync, scope: MergeScope): string[] {
  return [...new Set([...liveSessions(db, scope.target), ...scope.sessions])].sort();
}

export type LinkChange = {
  session: string;
  /**
   * `add`: the target gets a new link; `restore`: a link taken back earlier comes back (`restore_vetoed` when it was the
   * user who took it back); `keep`: the target already has it.
   */
  target: 'add' | 'restore' | 'restore_vetoed' | 'keep';
  /** `remove`: the source's link is taken back (partial merge); `keep`: it stays on the merged source's record. */
  source: 'remove' | 'keep';
};

export type MergePlan = {
  links: LinkChange[];
  /** What becomes of the source project. */
  source_stage: string;
  source_merged: boolean;
  source_remaining_sessions: string[];
};

/** What applying the merge does to links and to the source, from the database as it is now. */
export function mergePlan(db: DatabaseSync, scope: MergeScope): MergePlan {
  const find = db.prepare('SELECT deleted_at, vetoed FROM contributions WHERE session_key = ? AND project_id = ?');
  const links = scope.sessions.map((session): LinkChange => {
    const existing = find.get(session, scope.target) as { deleted_at: string | null; vetoed: number } | undefined;
    return {
      session,
      target: existing === undefined ? 'add' : existing.deleted_at === null ? 'keep' : existing.vetoed === 1 ? 'restore_vetoed' : 'restore',
      source: scope.mode === 'sessions' ? 'remove' : 'keep',
    };
  });
  const whole = scope.mode === 'project';
  return {
    links,
    source_stage: whole ? 'merged' : String(readRow(db, 'projects', scope.source)?.stage),
    source_merged: whole,
    source_remaining_sessions: whole ? [] : liveSessions(db, scope.source).filter((key) => !scope.sessions.includes(key)),
  };
}

/**
 * A hash of everything a preview depends on: both projects' text, stage and locks, every link of either project, and for
 * each evidence session whether it is ignored or held back and how much content it has. A preview is applied only
 * while this still equals the value it was built with.
 */
export function mergeSignature(db: DatabaseSync, scope: MergeScope): string {
  const project = db.prepare('SELECT id, title, summary, why, done_criteria, stage, merged_into, locks, deleted_at FROM projects WHERE id = ?');
  const links = db.prepare('SELECT id, session_key, deleted_at, vetoed, summary, ts_start, ts_end, confidence FROM contributions WHERE project_id = ? ORDER BY id');
  const session = db.prepare(
    `SELECT (SELECT ignored FROM sessions WHERE key = ?) AS ignored,
            (SELECT coalesce(max(id),0) FROM digest_blocks WHERE session_key = ?) AS last_refusal,
            (SELECT count(*) FROM chunks WHERE session_key = ?) AS chunks,
            (SELECT coalesce(max(id), 0) FROM chunks WHERE session_key = ?) AS last_chunk`,
  );
  const parts = {
    scope,
    projects: [scope.source, scope.target].map((id) => project.get(id) ?? null),
    links: [scope.source, scope.target].map((id) => links.all(id)),
    sessions: evidenceSessions(db, scope).map((key) => [key, session.get(key, key, key, key)]),
  };
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** A stored preview's scope columns. */
export type PreviewScopeRow = { source_id: string; target_id: string; mode: MergeMode; session_keys: string };

export function previewScope(row: PreviewScopeRow): MergeScope {
  return { source: row.source_id, target: row.target_id, mode: row.mode, sessions: JSON.parse(row.session_keys) as string[] };
}

/**
 * The signature of `scope` as the database is now, or null when the scope itself no longer holds (a project was
 * merged or deleted, a chosen session left the source, the source gained or lost sessions of a whole-project merge).
 */
export function currentSignature(db: DatabaseSync, scope: MergeScope): string | null {
  try {
    const now = resolveMergeScope(db, scope.source, scope.target, scope.mode === 'sessions' ? scope.sessions : undefined);
    return JSON.stringify(now.sessions) === JSON.stringify(scope.sessions) ? mergeSignature(db, scope) : null;
  } catch (e) {
    if (e instanceof OpRejected) return null;
    throw e;
  }
}

type PreviewRow = PreviewScopeRow & { id: string; status: string; signature: string; draft: string | null };

/** The stored scope and draft of a preview that can still be applied. Throws `OpRejected` otherwise. */
function readyPreview(db: DatabaseSync, id: string): { scope: MergeScope; draft: DraftText; signature: string } {
  const row = db.prepare('SELECT id, source_id, target_id, mode, session_keys, status, signature, draft FROM merge_previews WHERE id = ?').get(id) as PreviewRow | undefined;
  if (!row) throw new OpRejected('not_found', `merge preview ${id} not found`);
  if (row.status !== 'ready' || row.draft === null) throw new OpRejected('not_pending', `merge preview ${id} is ${row.status}, not ready to apply`);
  return { scope: previewScope(row), draft: JSON.parse(row.draft) as DraftText, signature: row.signature };
}

/**
 * The user applies a merge preview. Refused as `stale` when anything the preview was built from changed since. Then, in
 * the caller's transaction: the links move as `mergePlan` says, the target's text becomes the draft's (a field the user
 * locked only when named in `overwrite_locked`; every field written is locked, being the user's confirmed text), a
 * whole-project merge marks the source merged, and the preview is marked applied. One event records all of it, so
 * `revert_event` takes the whole merge back.
 */
function applyMerge(ctx: OpContext, args: OpArgs<'apply_merge'>): void {
  const { scope, draft, signature } = readyPreview(ctx.db, args.preview);
  const same = scope.source === args.source && scope.target === args.target && scope.mode === args.mode && JSON.stringify(scope.sessions) === JSON.stringify(args.sessions);
  if (!same) throw new OpRejected('invalid', `the arguments do not describe merge preview ${args.preview}`);
  if (currentSignature(ctx.db, scope) !== signature) throw new OpRejected('stale', '项目、关联或会话内容在生成预览后发生了变化，请重新生成预览');

  ctx.projectId = scope.target;
  const now = ctx.deps.now().toISOString();
  const find = ctx.db.prepare('SELECT * FROM contributions WHERE session_key = ? AND project_id = ? AND deleted_at IS NULL');
  for (const session of scope.sessions) {
    const link = { ...(find.get(session, scope.source) as Row) };
    carrySessionLink(ctx, link, scope.target, { restoreVetoed: true });
    if (scope.mode === 'sessions') ctx.changes.update('contributions', String(link.id), { deleted_at: now, vetoed: 1 });
  }

  const target = readRow(ctx.db, 'projects', scope.target) as Row;
  const locked = new Set(readLocks(target));
  const written: Record<string, string> = {};
  for (const field of DRAFT_FIELDS) {
    // An empty draft field means the evidence gave nothing to write: the target keeps what it has.
    if (draft[field] === '' || target[field] === draft[field]) continue;
    if (locked.has(field) && !args.overwrite_locked.includes(field)) continue;
    written[field] = draft[field];
  }
  if (Object.keys(written).length > 0) ctx.changes.update('projects', scope.target, { ...written, locks: addLocks(target, Object.keys(written)) });

  if (scope.mode === 'project') {
    const source = readRow(ctx.db, 'projects', scope.source) as Row;
    ctx.changes.update('projects', scope.source, {
      stage: 'merged',
      merged_into: scope.target,
      stage_before_park: source.stage === 'parked' ? null : undefined,
      user_touched: 1,
    });
  }
  ctx.db.prepare("UPDATE merge_previews SET status = 'applied', updated_at = ? WHERE id = ?").run(now, args.preview);
}

export const MERGE_HANDLERS: Partial<Record<OpName, Handler>> = {
  apply_merge: applyMerge,
};
