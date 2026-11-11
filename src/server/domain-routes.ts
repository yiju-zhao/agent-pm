import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { answerQuestion, dismissQuestion } from '../domain/answers.ts';
import { readRow } from '../domain/changes.ts';
import { execute } from '../domain/execute.ts';
import type { OpName } from '../domain/ops.ts';
import { getProject, listProjects, listQuestions } from '../domain/read.ts';
import type { QuestionView } from '../domain/read.ts';
import { PRIORITIES, STAGES } from '../domain/types.ts';
import type { DomainDeps, OpResult, RejectCode } from '../domain/types.ts';
import { isAdmin, requireScope } from './keys.ts';
import type { ServerConfig } from './config.ts';

/** Request bodies of the write routes are small JSON documents. */
const MAX_BODY_BYTES = 64 * 1024;

// ---- request shapes ----------------------------------------------------------------------------------------------
// The routes check only the shape of a body (which keys, which JSON types) and refuse anything else, so a user's request can
// never carry an AI-only field such as `reason` or `evidence`. Every domain rule (lengths, enum values, who owns what) stays
// in the operation layer, which answers `invalid` for what the shape lets through.

const Str = z.string();

const PROJECT_FIELDS = { title: Str, summary: Str, why: Str, done_criteria: Str, priority: Str.nullable() };
const CreateProject = z.object({ ...PROJECT_FIELDS, stage: Str }).partial().required({ title: true }).strict();
const UpdateProject = z.object(PROJECT_FIELDS).partial().strict();
const Transition = z.object({ stage: Str, merge_into: Str.optional() }).strict();

const MILESTONE_FIELDS = { title: Str, status: Str, position: z.number() };
const CreateMilestone = z.object(MILESTONE_FIELDS).partial().required({ title: true }).strict();
const UpdateMilestone = z.object(MILESTONE_FIELDS).partial().strict();

const TODO_FIELDS = { title: Str, status: Str, priority: Str.nullable(), milestone_id: Str.nullable() };
const CreateTodo = z.object(TODO_FIELDS).partial().required({ title: true }).strict();
const UpdateTodo = z.object(TODO_FIELDS).partial().strict();

const RecordDecision = z.object({ text: Str, decided_at: Str.optional() }).strict();
const CreateBlocker = z.object({ text: Str, kind: Str.optional() }).strict();
const UpdateBlocker = z.object({ text: Str, kind: Str, status: z.literal('cleared') }).partial().strict();

const LinkSession = z.object({ project_id: Str, milestone_id: Str.nullable().optional() }).strict();
const IgnoreSession = z.object({ ignored: z.boolean() }).strict();

const Answer = z.union([z.object({ option_index: z.number() }).strict(), z.object({ text: Str }).strict()]);

const ProjectFilter = z.object({ stage: z.enum(STAGES).optional(), priority: z.enum(PRIORITIES).optional() });
const QUESTION_STATUSES = ['pending', 'answered', 'withdrawn', 'expired'] as const satisfies readonly QuestionView['status'][];
const QuestionFilter = z.object({ status: z.enum(QUESTION_STATUSES).optional(), project_id: Str.min(1).optional() });

// ---- responses ---------------------------------------------------------------------------------------------------

function invalid(c: Context, message: string): Response {
  return c.json({ error: 'invalid', message }, 400);
}

function rejected(code: RejectCode, message: string): OpResult {
  return { status: 'rejected', code, message };
}

/** `invalid` is the caller's mistake, `not_found` and `user_only` are what they say, every other refusal is a state conflict. */
function rejectStatus(code: RejectCode): 400 | 403 | 404 | 409 {
  switch (code) {
    case 'invalid':
      return 400;
    case 'not_found':
      return 404;
    case 'user_only':
      return 403;
    default:
      return 409;
  }
}

/** An applied operation answers with its `OpResult` (201 when it created something); a rejection with `{ error, message }`. */
function respond(c: Context, result: OpResult, created: boolean): Response {
  if (result.status === 'rejected') return c.json({ error: result.code, message: result.message }, rejectStatus(result.code));
  return c.json(result, created ? 201 : 200);
}

/** The parsed JSON body, or the 400 response to send. */
async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S> | Response> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return invalid(c, 'request body is not valid JSON');
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : invalid(c, z.prettifyError(parsed.error));
}

// ---- routes ------------------------------------------------------------------------------------------------------

/** Middleware that answers 401 unless the request carries `Authorization: Bearer <userToken>`. */
/** The user's routes: a key with the `admin` scope (the config's userToken, or an admin key made in the web UI). */
export function userAuth(config: ServerConfig, db: DatabaseSync, clock: () => Date = () => new Date()): MiddlewareHandler {
  return requireScope(db, config, clock, isAdmin, 'missing or invalid user token');
}

type Params = Record<string, string>;
type WriteMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * The project API. Reads (`GET`) are open like `/sessions`; every write needs `Authorization: Bearer <userToken>`, runs as
 * the user through `execute()`, and answers with the operation's result. The collectors' tokens are not accepted here, and
 * the user token is not accepted on `/ingest/*` (the config forbids the two overlapping).
 */
export function mountDomainRoutes(app: Hono, db: DatabaseSync, config: ServerConfig, deps: DomainDeps): void {
  const requireUser = userAuth(config, db, deps.now);

  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'too_large', message: `request body must be at most ${MAX_BODY_BYTES} bytes` }, 413),
  });

  const asUser = (op: OpName, args: unknown): OpResult => execute(db, deps, { op, args, actor: 'user' });

  /** A write route that takes no body. */
  const act = (method: WriteMethod, path: string, run: (params: Params) => OpResult): void => {
    app.on(method, path, requireUser, limitBody, (c) => respond(c, run(c.req.param()), false));
  };

  /** A write route whose JSON body must match `schema`. */
  const actWith = <S extends z.ZodType<object>>(
    method: WriteMethod,
    path: string,
    schema: S,
    run: (params: Params, body: z.output<S>) => OpResult,
    created = false,
  ): void => {
    app.on(method, path, requireUser, limitBody, async (c) => {
      const body = await readBody(c, schema);
      return body instanceof Response ? body : respond(c, run(c.req.param(), body), created);
    });
  };

  // ---- reading ----

  app.get('/projects', (c) => {
    const filter = ProjectFilter.safeParse(c.req.query());
    if (!filter.success) return invalid(c, z.prettifyError(filter.error));
    return c.json(listProjects(db, deps.now(), filter.data));
  });

  app.get('/projects/:id', (c) => {
    const project = getProject(db, deps.now(), c.req.param('id'));
    return project === null ? c.json({ error: 'not_found', message: `project ${c.req.param('id')} not found` }, 404) : c.json(project);
  });

  app.get('/questions', (c) => {
    const filter = QuestionFilter.safeParse(c.req.query());
    if (!filter.success) return invalid(c, z.prettifyError(filter.error));
    return c.json(listQuestions(db, deps, filter.data));
  });

  // ---- projects ----

  actWith('POST', '/projects', CreateProject, (_p, body) => asUser('create_project', body), true);
  actWith('PATCH', '/projects/:id', UpdateProject, (p, fields) => asUser('update_project', { project: p.id, fields }));
  actWith('POST', '/projects/:id/stage', Transition, (p, body) => asUser('transition_stage', { project: p.id, ...body }));
  act('DELETE', '/projects/:id/locks/:field', (p) => asUser('unlock_field', { table: 'projects', id: p.id, field: p.field }));

  // ---- milestones and todos: the same four routes each ----

  /** `idParam` names the item in the path (`:mid`, `:tid`). Its lock route checks the item is the project's first, because `unlock_field` has no project argument. */
  const mountLockableItems = (
    segment: 'milestones' | 'todos',
    idParam: string,
    ops: { upsert: OpName; delete: OpName },
    create: z.ZodType<object>,
    update: z.ZodType<object>,
  ): void => {
    const collection = `/projects/:id/${segment}`;
    const item = `${collection}/:${idParam}`;
    actWith('POST', collection, create, (p, body) => asUser(ops.upsert, { project: p.id, ...body }), true);
    actWith('PATCH', item, update, (p, body) => asUser(ops.upsert, { project: p.id, id: p[idParam], ...body }));
    act('DELETE', item, (p) => asUser(ops.delete, { project: p.id, id: p[idParam] }));
    act('DELETE', `${item}/locks/:field`, (p) => {
      const row = readRow(db, segment, p[idParam]);
      if (!row || row.project_id !== p.id) return rejected('not_found', `${segment} ${p[idParam]} not found in project ${p.id}`);
      return asUser('unlock_field', { table: segment, id: p[idParam], field: p.field });
    });
  };
  mountLockableItems('milestones', 'mid', { upsert: 'upsert_milestone', delete: 'delete_milestone' }, CreateMilestone, UpdateMilestone);
  mountLockableItems('todos', 'tid', { upsert: 'upsert_todo', delete: 'delete_todo' }, CreateTodo, UpdateTodo);

  // ---- decisions and blockers ----

  actWith('POST', '/projects/:id/decisions', RecordDecision, (p, body) => asUser('record_decision', { project: p.id, ...body }), true);
  act('DELETE', '/projects/:id/decisions/:did', (p) => asUser('delete_decision', { project: p.id, id: p.did }));

  actWith('POST', '/projects/:id/blockers', CreateBlocker, (p, body) => asUser('set_blocker', { project: p.id, ...body }), true);
  actWith('PATCH', '/projects/:id/blockers/:bid', UpdateBlocker, (p, { status, ...fields }) => {
    const edited = asUser('set_blocker', { project: p.id, id: p.bid, ...fields });
    if (status === undefined || edited.status === 'rejected') return edited;
    // Two operations, one event each; the answer is the clearing's result (it has no `id` of its own).
    const cleared = asUser('clear_blocker', { project: p.id, id: p.bid });
    return cleared.status === 'applied' ? { ...cleared, id: p.bid } : cleared;
  });
  act('DELETE', '/projects/:id/blockers/:bid', (p) => asUser('delete_blocker', { project: p.id, id: p.bid }));

  // ---- sessions (keys contain colons, so clients percent-encode them) ----

  actWith('POST', '/sessions/:key/links', LinkSession, (p, body) =>
    asUser('link_session', { session: p.key, project: body.project_id, milestone_id: body.milestone_id }),
  );
  act('DELETE', '/sessions/:key/links/:project_id', (p) => asUser('unlink_session', { session: p.key, project: p.project_id }));
  actWith('PUT', '/sessions/:key/ignored', IgnoreSession, (p, body) => asUser('ignore_session', { session: p.key, ignored: body.ignored }));

  // ---- events and questions ----

  act('POST', '/events/:id/revert', (p) => {
    // Digits only: Number() would also take '1e3' or '0x10' for an event id.
    const eventId = /^[1-9]\d*$/.test(p.id) ? Number(p.id) : NaN;
    if (!Number.isSafeInteger(eventId)) return rejected('invalid', `event id must be a positive integer (got ${JSON.stringify(p.id)})`);
    return asUser('revert_event', { event_id: eventId });
  });

  actWith('POST', '/questions/:id/answer', Answer, (p, body) => answerQuestion(db, deps, p.id, body));
  act('POST', '/questions/:id/dismiss', (p) => dismissQuestion(db, deps, p.id));
}
