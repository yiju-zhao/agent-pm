import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { readLocks, readRow } from '../domain/changes.ts';
import { execute } from '../domain/execute.ts';
import { currentSignature, DRAFT_FIELDS, evidenceSessions, mergePlan, mergeSignature, previewScope, resolveMergeScope } from '../domain/merge.ts';
import type { DraftField, MergePlan, MergeScope, PreviewScopeRow } from '../domain/merge.ts';
import { OpRejected } from '../domain/types.ts';
import type { DomainDeps, OpResult, RejectCode } from '../domain/types.ts';
import { MAX_BODY_BYTES, readBody, rejectStatus } from './domain-routes.ts';
import type { LlmRunner } from '../understand/llm.ts';
import { draftMerge } from '../understand/merge-preview.ts';
import type { MergeCoverage, MergeDraft } from '../understand/merge-preview.ts';

// The merge flow over HTTP (see domain/merge.ts for what a merge is):
//   POST /projects/:id/merge-previews   { target, sessions? }  start a preview of merging :id (or some of its sessions)
//   GET  /merge-previews/:id                                   the preview: its draft, what would change, its evidence
//   POST /merge-previews/:id/apply      { overwrite_locked? }  apply exactly that preview
// Building a preview calls the model and can take minutes, so it runs after the POST has answered and the page polls the
// GET. Until it is applied a preview changes no project, link or stage.

/** The model used to draft merges; absent when the understanding layer is switched off. */
export type MergeLlm = { runner: LlmRunner; model: () => string };

export type MergePreviewView = {
  id: string;
  status: 'generating' | 'ready' | 'failed' | 'applied';
  mode: MergeScope['mode'];
  source: { id: string; title: string };
  target: { id: string; title: string };
  sessions: string[];
  /** How to name every session the preview mentions (title and machine), by key. */
  session_labels: Record<string, string>;
  draft: MergeDraft | null;
  coverage: MergeCoverage | null;
  error: string | null;
  /** Something the preview was built from has changed: it can no longer be applied, only built again. */
  stale: boolean;
  /** What applying does, from the data as it is now; null once the preview is stale or applied. */
  changes: (MergePlan & { fields: Array<{ field: DraftField; before: string | null; after: string; locked: boolean }> }) | null;
  created_at: string;
};

type Row = PreviewScopeRow & { id: string; status: MergePreviewView['status']; signature: string; draft: string | null; coverage: string | null; error: string | null; created_at: string };

const Create = z.object({ target: z.string().min(1), sessions: z.array(z.string().min(1)).max(500).optional() }).strict();
const Apply = z.object({ overwrite_locked: z.array(z.string()).optional() }).strict();

function sessionLabel(db: DatabaseSync, key: string): string {
  const s = db.prepare('SELECT title, machine FROM sessions WHERE key = ?').get(key) as { title: string | null; machine: string | null } | undefined;
  return [s?.title || key, s?.machine].filter(Boolean).join(' · ');
}

function view(db: DatabaseSync, row: Row): MergePreviewView {
  const scope = previewScope(row);
  const title = (id: string) => ({ id, title: String(readRow(db, 'projects', id)?.title ?? id) });
  const draft = row.draft === null ? null : (JSON.parse(row.draft) as MergeDraft);
  const stale = row.status === 'ready' && currentSignature(db, scope) !== row.signature;
  let changes: MergePreviewView['changes'] = null;
  if (row.status === 'ready' && !stale && draft !== null) {
    const target = readRow(db, 'projects', scope.target)!;
    const locks = readLocks(target);
    const fields = DRAFT_FIELDS.filter((f) => draft[f] !== '' && target[f] !== draft[f]).map((f) => ({ field: f, before: typeof target[f] === 'string' ? (target[f] as string) : null, after: draft[f], locked: locks.includes(f) }));
    changes = { ...mergePlan(db, scope), fields };
  }
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    source: title(scope.source),
    target: title(scope.target),
    sessions: scope.sessions,
    session_labels: Object.fromEntries(evidenceSessions(db, scope).map((key) => [key, sessionLabel(db, key)])),
    draft,
    coverage: row.coverage === null ? null : (JSON.parse(row.coverage) as MergeCoverage),
    error: row.error,
    stale,
    changes,
    created_at: row.created_at,
  };
}

export function mountMergeRoutes(app: Hono, db: DatabaseSync, deps: DomainDeps, requireUser: MiddlewareHandler, llm: MergeLlm | null, onProjectReviewQueued?: () => void): void {
  // A preview still generating belongs to a process that is gone: its model call died with it.
  db.prepare("UPDATE merge_previews SET status = 'failed', error = ?, updated_at = ? WHERE status = 'generating'").run('服务重启，预览没有生成完；请重新生成', deps.now().toISOString());

  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'too_large', message: `request body must be at most ${MAX_BODY_BYTES} bytes` }, 413) });
  const select = db.prepare('SELECT * FROM merge_previews WHERE id = ?');
  const find = (id: string) => select.get(id) as Row | undefined;
  const refuse = (c: Context, code: RejectCode, message: string) => c.json({ error: code, message }, rejectStatus(code));

  const generate = async (id: string, scope: MergeScope, signature: string, model: MergeLlm): Promise<void> => {
    const finish = (status: 'ready' | 'failed', fields: { draft?: unknown; coverage?: unknown; error?: string }) =>
      db.prepare("UPDATE merge_previews SET status = ?, draft = ?, coverage = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'generating'").run(
        status,
        fields.draft === undefined ? null : JSON.stringify(fields.draft),
        fields.coverage === undefined ? null : JSON.stringify(fields.coverage),
        fields.error ?? null,
        deps.now().toISOString(),
        id,
      );
    try {
      const out = await draftMerge(db, deps, model.runner, model.model(), scope);
      if (!out.ok) finish('failed', { coverage: out.coverage, error: out.kind === 'refused' ? `模型提供方拒绝了这次请求，未生成草稿，也不会自动重试：${out.message}` : out.message });
      // The draft describes what was read while it was written; if that moved meanwhile it is already out of date.
      else if (currentSignature(db, scope) !== signature) finish('failed', { coverage: out.coverage, error: '生成期间项目、关联或会话内容发生了变化；请重新生成' });
      else finish('ready', { draft: out.draft, coverage: out.coverage });
    } catch (err) {
      console.error(`agent-pm server: merge preview ${id} failed:`, err);
      finish('failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };

  app.post('/projects/:id/merge-previews', requireUser, limit, async (c) => {
    const req = await readBody(c, Create);
    if (req instanceof Response) return req;
    if (llm === null) return c.json({ error: 'understanding_disabled', message: '理解层未启用，无法根据会话证据生成合并预览' }, 409);
    let scope: MergeScope;
    try {
      scope = resolveMergeScope(db, c.req.param('id'), req.target, req.sessions);
    } catch (e) {
      if (e instanceof OpRejected) return refuse(c, e.code, e.message);
      throw e;
    }
    // One draft at a time: each can be many model calls, and a second one would only race the first.
    if (db.prepare("SELECT 1 FROM merge_previews WHERE status = 'generating'").get()) return refuse(c, 'conflict', '已有一份合并预览正在生成，请等它结束后再试');
    const id = deps.newId('mp');
    const now = deps.now().toISOString();
    const signature = mergeSignature(db, scope);
    db.prepare(
      `INSERT INTO merge_previews (id, source_id, target_id, mode, session_keys, status, signature, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'generating', ?, ?, ?)`,
    ).run(id, scope.source, scope.target, scope.mode, JSON.stringify(scope.sessions), signature, now, now);
    void generate(id, scope, signature, llm);
    return c.json(view(db, find(id)!), 202);
  });

  app.get('/merge-previews/:id', requireUser, (c) => {
    const row = find(c.req.param('id'));
    return row === undefined ? c.json({ error: 'not_found' }, 404) : c.json(view(db, row));
  });

  app.post('/merge-previews/:id/apply', requireUser, limit, async (c) => {
    const req = await readBody(c, Apply);
    if (req instanceof Response) return req;
    const row = find(c.req.param('id'));
    if (row === undefined) return c.json({ error: 'not_found' }, 404);
    const result: OpResult = execute(db, deps, { op: 'apply_merge', actor: 'user', args: { preview: row.id, ...previewScope(row), overwrite_locked: req.overwrite_locked ?? [] } });
    if (result.status === 'rejected') return refuse(c, result.code, result.message);
    if (result.status === 'applied' && result.project_review_queued) onProjectReviewQueued?.();
    return c.json(result);
  });
}
