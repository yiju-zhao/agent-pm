import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execute } from '../../src/domain/execute.ts';
import type { IdPrefix } from '../../src/domain/types.ts';
import type { ServerConfig } from '../../src/server/config.ts';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';
import type { SnapshotPush } from '../../src/shared/protocol.ts';

const USER_TOKEN = 'user-token-0123456789abcdef';
const COLLECTOR = 'gx10-090e';
const COLLECTOR_TOKEN = 'collector-token-gx10-0123456789';
const SESSION = 'claude:5d27595b-908e-4fe5-9283-890acdbd075f';
const NOW = '2026-10-29T10:00:00.000Z';

const config: ServerConfig = {
  port: 1,
  dbPath: ':memory:',
  userToken: USER_TOKEN,
  collectors: { [COLLECTOR]: COLLECTOR_TOKEN },
};

let db: DatabaseSync;
let now: Date;
let app: ReturnType<typeof createApp>;
let failIds: boolean;
let aiIds: number;

beforeEach(() => {
  db = openDb(':memory:');
  now = new Date(NOW);
  failIds = false;
  aiIds = 0;
  const counters = new Map<IdPrefix, number>();
  app = createApp(
    db,
    config,
    () => now,
    (prefix) => {
      if (failIds) throw new Error('boom: id generator broke');
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${n}`;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  if (db.isOpen) db.close();
});

// ---- helpers -----------------------------------------------------------------------------------------------------

/** Any JSON the API returns; the tests assert on the parts they care about. */
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function req(method: string, path: string, body?: unknown, token: string | null = USER_TOKEN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return app.request(path, { method, headers, body: payload });
}

/** Sends the request and returns the status with the parsed body. */
async function call(method: string, path: string, body?: unknown, token: string | null = USER_TOKEN): Promise<{ status: number; body: Json }> {
  const res = await req(method, path, body, token);
  return { status: res.status, body: await res.json() };
}

async function newProject(extra: Record<string, unknown> = {}): Promise<string> {
  const r = await call('POST', '/projects', { title: 'Project', ...extra });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function detail(id: string): Promise<Json> {
  const r = await call('GET', `/projects/${id}`, undefined, null);
  expect(r.status).toBe(200);
  return r.body;
}

/** Makes `SESSION` known to the server the way a collector does. */
async function ingestSession(): Promise<void> {
  const push: SnapshotPush = {
    machine: COLLECTOR,
    collector_version: '0.1.0',
    sessions: [
      {
        key: SESSION,
        agent_kind: 'claude',
        native_id: SESSION.slice('claude:'.length),
        pane_id: 'w1:1:1',
        terminal_id: 't1',
        workspace_id: 'w1',
        tab_id: 'w1:1',
        cwd: '/home/demo/proj',
        title: 'Some task',
        live_status: 'working',
        fidelity: 'full',
        transcript_path: '/home/demo/.claude/x.jsonl',
      },
    ],
    purged: [],
  };
  const r = await req('POST', '/ingest/snapshot', push, COLLECTOR_TOKEN);
  expect(r.status).toBe(200);
}

const sessionPath = (suffix: string) => `/sessions/${encodeURIComponent(SESSION)}${suffix}`;

/** An AI proposes moving `project` to `done`, which it may not do itself, so the server files a question. */
function aiProposesDone(project: string): string {
  const r = execute(
    db,
    { now: () => now, newId: (prefix) => `${prefix}_ai${++aiIds}` },
    { op: 'transition_stage', args: { project, stage: 'done' }, actor: 'ai:curator', reason: 'looks finished', evidence: ['chunk:1'] },
  );
  if (r.status !== 'proposed') throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.question_ids[0];
}

function eventCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
}

// ---- auth --------------------------------------------------------------------------------------------------------

test('mutations require the user token; collector tokens are refused', async () => {
  const noToken = await req('POST', '/projects', { title: 'x' }, null);
  expect(noToken.status).toBe(401);
  expect(noToken.headers.get('www-authenticate')).toBe('Bearer');
  expect(await noToken.json()).toMatchObject({ error: 'unauthorized' });
  expect((await req('POST', '/projects', { title: 'x' }, COLLECTOR_TOKEN)).status).toBe(401);
  expect((await call('GET', '/projects', undefined, null)).body).toEqual([]);

  const ok = await req('POST', '/projects', { title: 'x' }, USER_TOKEN);
  expect(ok.status).toBe(201);
});

/** Every write route of the project API, with a body that is well-formed for it. */
const WRITE_ROUTES: Array<[method: string, pattern: string, body?: unknown]> = [
  ['POST', '/projects', { title: 'x' }],
  ['PATCH', '/projects/:id', { title: 'x' }],
  ['POST', '/projects/:id/stage', { stage: 'build' }],
  ['DELETE', '/projects/:id/locks/:field'],
  ['POST', '/projects/:id/milestones', { title: 'x' }],
  ['PATCH', '/projects/:id/milestones/:mid', { title: 'x' }],
  ['DELETE', '/projects/:id/milestones/:mid'],
  ['DELETE', '/projects/:id/milestones/:mid/locks/:field'],
  ['POST', '/projects/:id/todos', { title: 'x' }],
  ['PATCH', '/projects/:id/todos/:tid', { title: 'x' }],
  ['DELETE', '/projects/:id/todos/:tid'],
  ['DELETE', '/projects/:id/todos/:tid/locks/:field'],
  ['POST', '/projects/:id/decisions', { text: 'x' }],
  ['DELETE', '/projects/:id/decisions/:did'],
  ['POST', '/projects/:id/blockers', { text: 'x' }],
  ['PATCH', '/projects/:id/blockers/:bid', { text: 'x' }],
  ['DELETE', '/projects/:id/blockers/:bid'],
  ['POST', '/sessions/:key/links', { project_id: 'x' }],
  ['DELETE', '/sessions/:key/links/:project_id'],
  ['PUT', '/sessions/:key/ignored', { ignored: true }],
  ['POST', '/events/:id/revert'],
  ['POST', '/questions/:id/answer', { option_index: 0 }],
  ['POST', '/questions/:id/dismiss'],
];

test('every write route refuses a missing, wrong, collector and malformed token without touching the database', async () => {
  for (const [method, pattern, body] of WRITE_ROUTES) {
    const path = pattern.replace(/:\w+/g, '1');
    const events = eventCount();
    const sameLengthWrong = `${USER_TOKEN.slice(0, -1)}X`;
    for (const token of [null, 'wrong-token-0123456789', COLLECTOR_TOKEN, USER_TOKEN.slice(0, -1), `${USER_TOKEN}x`, sameLengthWrong]) {
      const res = await req(method, path, body, token);
      expect(res.status, `${method} ${path} with ${token}`).toBe(401);
    }
    const basic = await app.request(path, { method, headers: { authorization: `Basic ${USER_TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(basic.status, `${method} ${path} with a Basic scheme`).toBe(401);
    expect(eventCount(), `${method} ${path} wrote despite the refusal`).toBe(events);
    const accepted = await req(method, path, body, USER_TOKEN);
    expect(accepted.status, `${method} ${path} with the user token`).not.toBe(401);
  }
});

test('the table of write routes above is the complete set of write routes the app registers', () => {
  const registered = new Set(
    app.routes
      .filter((r) => r.method !== 'GET' && r.method !== 'ALL' && !r.path.startsWith('/ingest/'))
      .map((r) => `${r.method} ${r.path}`),
  );
  expect(registered).toEqual(new Set(WRITE_ROUTES.map(([method, pattern]) => `${method} ${pattern}`)));
});

test('the user token cannot push ingest data', async () => {
  const snapshot = { machine: COLLECTOR, collector_version: '0.1.0', sessions: [], purged: [] };
  expect((await req('POST', '/ingest/snapshot', snapshot, USER_TOKEN)).status).toBe(401);
  expect((await req('POST', '/ingest/chunks', { machine: COLLECTOR, chunks: [] }, USER_TOKEN)).status).toBe(401);
  expect((await req('GET', `/ingest/offset?machine=${COLLECTOR}&session_key=${SESSION}`, undefined, USER_TOKEN)).status).toBe(401);
  // The collector's own token still works there.
  expect((await req('POST', '/ingest/snapshot', snapshot, COLLECTOR_TOKEN)).status).toBe(200);
});

// ---- reading -----------------------------------------------------------------------------------------------------

test('GET /projects is open and returns cards', async () => {
  const a = await newProject({ title: '冒烟项目' });
  const b = await newProject({ title: 'Second', priority: 'P1', stage: 'build' });

  const all = await call('GET', '/projects', undefined, null);
  expect(all.status).toBe(200);
  expect(all.body.map((p: Json) => p.id).sort()).toEqual([a, b].sort());
  expect(all.body.find((p: Json) => p.id === a)).toMatchObject({ title: '冒烟项目', stage: 'idea', inbox: false, priority: null, created_by: 'user' });

  expect((await call('GET', '/projects?stage=build', undefined, null)).body.map((p: Json) => p.id)).toEqual([b]);
  expect((await call('GET', '/projects?priority=P1', undefined, null)).body.map((p: Json) => p.id)).toEqual([b]);
  expect((await call('GET', '/projects?stage=idea&priority=P1', undefined, null)).body).toEqual([]);
});

test('GET /projects refuses unknown stage and priority values', async () => {
  for (const query of ['stage=nope', 'priority=P9', 'stage=', 'priority=', 'stage=IDEA']) {
    const r = await call('GET', `/projects?${query}`, undefined, null);
    expect(r.status, query).toBe(400);
    expect(r.body.error, query).toBe('invalid');
    expect(r.body.message, query).toEqual(expect.any(String));
  }
});

test('GET /projects/:id returns the detail, and 404 for an unknown or deleted project', async () => {
  const id = await newProject();
  const found = await call('GET', `/projects/${id}`, undefined, null);
  expect(found.status).toBe(200);
  expect(found.body).toMatchObject({ id, title: 'Project', milestones: [], todos: [], decisions: [], blockers: [], tombstones: [] });
  expect(found.body.events).toHaveLength(1);

  const missing = await call('GET', '/projects/p_nope', undefined, null);
  expect(missing.status).toBe(404);
  expect(missing.body).toMatchObject({ error: 'not_found' });
});

// ---- projects ----------------------------------------------------------------------------------------------------

test('POST /projects creates a project as the user and answers with the OpResult', async () => {
  const r = await call('POST', '/projects', {
    title: ' Everything ',
    summary: 'S',
    why: 'W',
    done_criteria: 'D',
    priority: 'P2',
    stage: 'explore',
  });
  expect(r.status).toBe(201);
  expect(r.body).toEqual({ status: 'applied', event_id: 1, id: 'p_1', question_ids: [], warnings: [] });

  const project = await detail('p_1');
  expect(project).toMatchObject({ title: 'Everything', summary: 'S', why: 'W', done_criteria: 'D', priority: 'P2', stage: 'explore', created_by: 'user' });
  expect(project.events[0]).toMatchObject({ actor: 'user', op: 'create_project', recorded_at: NOW });
});

test('POST /projects maps the operation layer’s rejections to 400', async () => {
  for (const body of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(201) }, { title: 'x', stage: 'nope' }, { title: 'x', stage: 'merged' }, { title: 'x', priority: 'P9' }]) {
    const r = await call('POST', '/projects', body);
    expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    expect(r.body).toMatchObject({ error: 'invalid' });
    expect(r.body.message).toEqual(expect.any(String));
  }
  expect(eventCount()).toBe(0);
});

test('request bodies are shape-checked and strict: unknown keys, wrong types and AI-only fields are 400', async () => {
  const id = await newProject();
  const before = eventCount();
  const cases: Array<[string, string, unknown]> = [
    ['POST', '/projects', {}],
    ['POST', '/projects', { title: 5 }],
    ['POST', '/projects', { title: 'x', reason: 'because' }],
    ['POST', '/projects', { title: 'x', evidence: ['chunk:1'] }],
    ['POST', '/projects', { title: 'x', from_session: SESSION }],
    ['POST', '/projects', { title: 'x', actor: 'ai:curator' }],
    ['PATCH', `/projects/${id}`, { stage: 'done' }],
    ['PATCH', `/projects/${id}`, { title: 'x', reason: 'because' }],
    ['PATCH', `/projects/${id}`, { priority: 1 }],
    ['POST', `/projects/${id}/stage`, {}],
    ['POST', `/projects/${id}/stage`, { stage: 'build', reason: 'r' }],
    ['POST', `/projects/${id}/milestones`, {}],
    ['POST', `/projects/${id}/milestones`, { title: 'm', project: 'other' }],
    ['POST', `/projects/${id}/milestones`, { title: 'm', position: '1' }],
    ['POST', `/projects/${id}/todos`, { title: 'm', milestone_id: 3 }],
    ['POST', `/projects/${id}/decisions`, { text: 'x', evidence: ['chunk:1'] }],
    ['POST', `/projects/${id}/blockers`, { text: 'x', status: 'cleared' }],
    ['PATCH', `/projects/${id}/blockers/b_1`, { status: 'open' }],
    ['PATCH', `/projects/${id}/blockers/b_1`, { status: null }],
    ['POST', sessionPath('/links'), {}],
    ['POST', sessionPath('/links'), { project_id: id, summary: 'x' }],
    ['PUT', sessionPath('/ignored'), {}],
    ['PUT', sessionPath('/ignored'), { ignored: 'yes' }],
    ['POST', '/questions/q_1/answer', {}],
    ['POST', '/questions/q_1/answer', { option_index: 0, text: 'x' }],
    ['POST', '/questions/q_1/answer', { option_index: '0' }],
    ['POST', '/questions/q_1/answer', { text: 5 }],
    ['POST', '/questions/q_1/answer', { option_index: 0, reason: 'r' }],
  ];
  for (const [method, path, body] of cases) {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
    expect(r.body, `${method} ${path} ${JSON.stringify(body)}`).toMatchObject({ error: 'invalid' });
  }
  expect(eventCount()).toBe(before);
});

test('PATCH then GET shows the field locked; DELETE lock unlocks it', async () => {
  const id = await newProject();
  const patched = await call('PATCH', `/projects/${id}`, { title: 'Renamed', priority: 'P1' });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({ status: 'applied', event_id: 2 });

  const locked = await detail(id);
  expect(locked).toMatchObject({ title: 'Renamed', priority: 'P1' });
  expect(locked.locks).toEqual(expect.arrayContaining(['title', 'priority']));

  const unlocked = await call('DELETE', `/projects/${id}/locks/title`);
  expect(unlocked.status).toBe(200);
  expect(unlocked.body.status).toBe('applied');
  const after = await detail(id);
  expect(after.locks).not.toContain('title');
  expect(after.locks).toContain('priority');
});

test('PATCH /projects/:id edge cases: empty fields are 400, unknown projects 404, unlocking a field that cannot be locked is 400', async () => {
  const id = await newProject();
  expect((await call('PATCH', `/projects/${id}`, {})).status).toBe(400);
  expect((await call('PATCH', '/projects/p_nope', { title: 'x' })).status).toBe(404);
  expect((await call('PATCH', `/projects/${id}`, { priority: null })).status).toBe(200);
  expect((await call('DELETE', `/projects/${id}/locks/stage`)).status).toBe(400);
  expect((await call('DELETE', '/projects/p_nope/locks/title')).status).toBe(404);
});

test('POST /projects/:id/stage moves the project; invalid moves are 400, unknown projects 404', async () => {
  const a = await newProject({ title: 'A' });
  const b = await newProject({ title: 'B' });

  expect((await call('POST', `/projects/${a}/stage`, { stage: 'build' })).status).toBe(200);
  expect((await detail(a)).stage).toBe('build');
  // The user may skip steps and reopen.
  expect((await call('POST', `/projects/${a}/stage`, { stage: 'done' })).status).toBe(200);
  expect((await call('POST', `/projects/${a}/stage`, { stage: 'explore' })).status).toBe(200);

  expect((await call('POST', `/projects/${a}/stage`, { stage: 'explore' })).status).toBe(400);
  expect((await call('POST', `/projects/${a}/stage`, { stage: 'nope' })).status).toBe(400);
  expect((await call('POST', `/projects/${a}/stage`, { stage: 'merged' })).status).toBe(400);
  expect((await call('POST', `/projects/${a}/stage`, { stage: 'build', merge_into: b })).status).toBe(400);
  expect((await call('POST', '/projects/p_nope/stage', { stage: 'build' })).status).toBe(404);

  const merged = await call('POST', `/projects/${a}/stage`, { stage: 'merged', merge_into: b });
  expect(merged.status).toBe(200);
  expect(await detail(a)).toMatchObject({ stage: 'merged', merged_into: b });
});

// ---- milestones and todos ----------------------------------------------------------------------------------------

test('milestones: create, edit (locks the field), delete (tombstone), unlock', async () => {
  const p = await newProject();
  const created = await call('POST', `/projects/${p}/milestones`, { title: 'Alpha', status: 'doing', position: 3 });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ status: 'applied', id: 'm_1' });
  expect((await detail(p)).milestones).toMatchObject([{ id: 'm_1', title: 'Alpha', status: 'doing', position: 3 }]);

  const patched = await call('PATCH', `/projects/${p}/milestones/m_1`, { status: 'done' });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({ status: 'applied', id: 'm_1' });
  expect((await detail(p)).milestones[0]).toMatchObject({ status: 'done', locks: expect.arrayContaining(['status']) });

  expect((await call('DELETE', `/projects/${p}/milestones/m_1/locks/status`)).status).toBe(200);
  expect((await detail(p)).milestones[0].locks).not.toContain('status');

  expect((await call('DELETE', `/projects/${p}/milestones/m_1`)).status).toBe(200);
  const after = await detail(p);
  expect(after.milestones).toEqual([]);
  expect(after.tombstones).toMatchObject([{ table: 'milestones', id: 'm_1' }]);
  expect((await call('DELETE', `/projects/${p}/milestones/m_1`)).status).toBe(404);
});

test('milestones: bad values are 400, unknown projects 404', async () => {
  const p = await newProject();
  expect((await call('POST', `/projects/${p}/milestones`, { title: 'x', status: 'finished' })).status).toBe(400);
  expect((await call('POST', `/projects/${p}/milestones`, { title: 'x', position: -1 })).status).toBe(400);
  expect((await call('POST', `/projects/${p}/milestones`, { title: ' ' })).status).toBe(400);
  expect((await call('POST', '/projects/p_nope/milestones', { title: 'x' })).status).toBe(404);
});

test('todos: create under a milestone, edit, detach, delete, unlock', async () => {
  const p = await newProject();
  const m = (await call('POST', `/projects/${p}/milestones`, { title: 'M' })).body.id;

  const created = await call('POST', `/projects/${p}/todos`, { title: 'Write it', priority: 'P1', milestone_id: m });
  expect(created.status).toBe(201);
  expect((await detail(p)).todos).toMatchObject([{ id: 't_1', title: 'Write it', priority: 'P1', milestone_id: m, status: 'todo' }]);

  expect((await call('PATCH', `/projects/${p}/todos/t_1`, { status: 'doing', milestone_id: null, priority: null })).status).toBe(200);
  expect((await detail(p)).todos[0]).toMatchObject({ status: 'doing', milestone_id: null, priority: null, locks: expect.arrayContaining(['status', 'milestone_id', 'priority']) });

  expect((await call('DELETE', `/projects/${p}/todos/t_1/locks/priority`)).status).toBe(200);
  expect((await detail(p)).todos[0].locks).not.toContain('priority');

  expect((await call('DELETE', `/projects/${p}/todos/t_1`)).status).toBe(200);
  const after = await detail(p);
  expect(after.todos).toEqual([]);
  expect(after.tombstones).toMatchObject([{ table: 'todos', id: 't_1' }]);
});

test('a todo id from another project returns 404', async () => {
  const p1 = await newProject({ title: 'One' });
  const p2 = await newProject({ title: 'Two' });
  const todo = (await call('POST', `/projects/${p2}/todos`, { title: 'Theirs' })).body.id;
  const milestone = (await call('POST', `/projects/${p2}/milestones`, { title: 'Theirs' })).body.id;
  await call('PATCH', `/projects/${p2}/todos/${todo}`, { title: 'Theirs, edited' });
  await call('PATCH', `/projects/${p2}/milestones/${milestone}`, { title: 'Theirs, edited' });
  const before = JSON.stringify(await detail(p2));

  for (const [method, path, body] of [
    ['PATCH', `/projects/${p1}/todos/${todo}`, { title: 'Hijacked' }],
    ['DELETE', `/projects/${p1}/todos/${todo}`, undefined],
    ['DELETE', `/projects/${p1}/todos/${todo}/locks/title`, undefined],
    ['PATCH', `/projects/${p1}/milestones/${milestone}`, { title: 'Hijacked' }],
    ['DELETE', `/projects/${p1}/milestones/${milestone}`, undefined],
    ['DELETE', `/projects/${p1}/milestones/${milestone}/locks/title`, undefined],
    ['DELETE', `/projects/p_nope/todos/${todo}/locks/title`, undefined],
    ['DELETE', `/projects/${p1}/todos/t_nope/locks/title`, undefined],
  ] as const) {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path}`).toBe(404);
    expect(r.body, `${method} ${path}`).toMatchObject({ error: 'not_found' });
  }
  expect(JSON.stringify(await detail(p2))).toBe(before);
});

test('a todo cannot be filed under another project’s milestone (400)', async () => {
  const p1 = await newProject({ title: 'One' });
  const p2 = await newProject({ title: 'Two' });
  const foreign = (await call('POST', `/projects/${p2}/milestones`, { title: 'Theirs' })).body.id;
  const r = await call('POST', `/projects/${p1}/todos`, { title: 'x', milestone_id: foreign });
  expect(r.status).toBe(400);
  expect(r.body.error).toBe('invalid');
});

// ---- decisions and blockers --------------------------------------------------------------------------------------

test('decisions: record with an occurrence time, then delete', async () => {
  const p = await newProject();
  const r = await call('POST', `/projects/${p}/decisions`, { text: 'Use SQLite', decided_at: '2026-10-01T08:00:00.000Z' });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ status: 'applied', id: 'd_1' });
  expect((await detail(p)).decisions).toMatchObject([{ id: 'd_1', text: 'Use SQLite', decided_at: '2026-10-01T08:00:00.000Z', created_by: 'user' }]);

  expect((await call('POST', `/projects/${p}/decisions`, { text: 'x', decided_at: 'yesterday' })).status).toBe(400);
  expect((await call('POST', `/projects/${p}/decisions`, { text: '' })).status).toBe(400);

  expect((await call('DELETE', `/projects/${p}/decisions/d_1`)).status).toBe(200);
  expect((await detail(p)).decisions).toEqual([]);
  expect((await call('DELETE', `/projects/${p}/decisions/d_1`)).status).toBe(404);

  const other = await newProject({ title: 'Other' });
  const foreign = (await call('POST', `/projects/${other}/decisions`, { text: 'Theirs' })).body.id;
  expect((await call('DELETE', `/projects/${p}/decisions/${foreign}`)).status).toBe(404);
});

test('blockers: create, edit, clear via PATCH status, delete', async () => {
  const p = await newProject();
  const created = await call('POST', `/projects/${p}/blockers`, { text: 'Waiting on keys', kind: 'external' });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ status: 'applied', id: 'b_1' });

  expect((await call('PATCH', `/projects/${p}/blockers/b_1`, { text: 'Still waiting', kind: 'user' })).status).toBe(200);
  expect((await detail(p)).blockers).toMatchObject([{ id: 'b_1', text: 'Still waiting', kind: 'user', status: 'open' }]);

  const cleared = await call('PATCH', `/projects/${p}/blockers/b_1`, { status: 'cleared' });
  expect(cleared.status).toBe(200);
  expect(cleared.body).toMatchObject({ status: 'applied', id: 'b_1', event_id: expect.any(Number) });
  expect((await detail(p)).blockers).toMatchObject([{ id: 'b_1', status: 'cleared', cleared_at: NOW }]);

  expect((await call('DELETE', `/projects/${p}/blockers/b_1`)).status).toBe(200);
  expect((await detail(p)).blockers).toEqual([]);
});

test('PATCH blocker with text and status runs set_blocker then clear_blocker, one event each', async () => {
  const p = await newProject();
  await call('POST', `/projects/${p}/blockers`, { text: 'Waiting' });
  const before = eventCount();

  const r = await call('PATCH', `/projects/${p}/blockers/b_1`, { text: 'Resolved by Bob', status: 'cleared' });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: 'applied', id: 'b_1' });
  expect(eventCount()).toBe(before + 2);

  const events = (await detail(p)).events.slice(0, 2).map((e: Json) => e.op);
  expect(events.sort()).toEqual(['clear_blocker', 'set_blocker']);
  expect((await detail(p)).blockers[0]).toMatchObject({ text: 'Resolved by Bob', status: 'cleared' });
});

test('PATCH blocker: when the edit is refused the blocker is not cleared; a foreign or unknown blocker is 404', async () => {
  const p = await newProject();
  await call('POST', `/projects/${p}/blockers`, { text: 'Waiting' });
  const refused = await call('PATCH', `/projects/${p}/blockers/b_1`, { text: '   ', status: 'cleared' });
  expect(refused.status).toBe(400);
  expect((await detail(p)).blockers[0].status).toBe('open');

  const other = await newProject({ title: 'Other' });
  const foreign = (await call('POST', `/projects/${other}/blockers`, { text: 'Theirs' })).body.id;
  for (const [method, body] of [['PATCH', { status: 'cleared' }], ['PATCH', { text: 'x' }], ['DELETE', undefined]] as const) {
    expect((await call(method, `/projects/${p}/blockers/${foreign}`, body)).status).toBe(404);
    expect((await call(method, `/projects/${p}/blockers/b_nope`, body)).status).toBe(404);
  }
  expect((await detail(other)).blockers[0]).toMatchObject({ text: 'Theirs', status: 'open' });
});

// ---- sessions ----------------------------------------------------------------------------------------------------

test('session keys with colons work in paths', async () => {
  await ingestSession();
  const p = await newProject();
  const r = await call('POST', sessionPath('/links'), { project_id: p });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: 'applied', id: 'c_1' });
  expect((await detail(p)).contributions).toMatchObject([{ session_key: SESSION, actor: 'user', session: { key: SESSION } }]);

  // The raw colon works too.
  const raw = await call('POST', `/sessions/${SESSION}/links`, { project_id: p });
  expect(raw.status).toBe(200);
});

test('link, relink under a milestone, unlink; an unlinked pair is 404', async () => {
  await ingestSession();
  const p = await newProject();
  const m = (await call('POST', `/projects/${p}/milestones`, { title: 'M' })).body.id;

  expect((await call('POST', sessionPath('/links'), { project_id: p })).status).toBe(200);
  expect((await call('POST', sessionPath('/links'), { project_id: p, milestone_id: m })).status).toBe(200);
  expect((await detail(p)).contributions).toMatchObject([{ milestone_id: m }]);
  expect((await call('POST', sessionPath('/links'), { project_id: p, milestone_id: null })).status).toBe(200);
  expect((await detail(p)).contributions).toMatchObject([{ milestone_id: null }]);

  expect((await call('DELETE', sessionPath(`/links/${p}`))).status).toBe(200);
  expect((await detail(p)).contributions).toEqual([]);
  expect((await call('DELETE', sessionPath(`/links/${p}`))).status).toBe(404);
});

test('linking an unknown session or project is 404; a milestone of another project is 400', async () => {
  await ingestSession();
  const p = await newProject();
  const other = await newProject({ title: 'Other' });
  const foreign = (await call('POST', `/projects/${other}/milestones`, { title: 'Theirs' })).body.id;

  expect((await call('POST', `/sessions/${encodeURIComponent('claude:nope')}/links`, { project_id: p })).status).toBe(404);
  expect((await call('POST', sessionPath('/links'), { project_id: 'p_nope' })).status).toBe(404);
  expect((await call('POST', sessionPath('/links'), { project_id: p, milestone_id: foreign })).status).toBe(400);
  expect((await call('DELETE', `/sessions/${encodeURIComponent('claude:nope')}/links/${p}`)).status).toBe(404);
});

test('PUT /sessions/:key/ignored sets and clears the flag', async () => {
  await ingestSession();
  const ignored = () => (db.prepare('SELECT ignored FROM sessions WHERE key = ?').get(SESSION) as { ignored: number }).ignored;

  const on = await call('PUT', sessionPath('/ignored'), { ignored: true });
  expect(on.status).toBe(200);
  expect(on.body.status).toBe('applied');
  expect(ignored()).toBe(1);
  expect((await call('PUT', sessionPath('/ignored'), { ignored: false })).status).toBe(200);
  expect(ignored()).toBe(0);
  expect((await call('PUT', `/sessions/${encodeURIComponent('claude:nope')}/ignored`, { ignored: true })).status).toBe(404);
});

// ---- revert ------------------------------------------------------------------------------------------------------

test('POST /events/:id/revert undoes the event; reverting twice is 409', async () => {
  const p = await newProject({ title: 'Before' });
  const patched = await call('PATCH', `/projects/${p}`, { title: 'After' });
  const eventId = patched.body.event_id;

  const reverted = await call('POST', `/events/${eventId}/revert`);
  expect(reverted.status).toBe(200);
  expect(reverted.body).toMatchObject({ status: 'applied', event_id: eventId + 1 });
  expect((await detail(p)).title).toBe('Before');

  const again = await call('POST', `/events/${eventId}/revert`);
  expect(again.status).toBe(409);
  expect(again.body).toMatchObject({ error: 'already_reverted' });
});

test('reverting a delete brings the todo back and clears its tombstone', async () => {
  const p = await newProject();
  await call('POST', `/projects/${p}/todos`, { title: 'Keep me' });
  const deleted = await call('DELETE', `/projects/${p}/todos/t_1`);
  expect((await detail(p)).tombstones).toMatchObject([{ table: 'todos', id: 't_1' }]);

  const reverted = await call('POST', `/events/${deleted.body.event_id}/revert`);
  expect(reverted.status).toBe(200);
  const after = await detail(p);
  expect(after.todos).toMatchObject([{ id: 't_1', title: 'Keep me' }]);
  expect(after.tombstones).toEqual([]);
});

test('revert conflict maps to 409 with the column in the message', async () => {
  const p = await newProject({ title: 'One' });
  const first = (await call('PATCH', `/projects/${p}`, { title: 'Two' })).body.event_id;
  await call('PATCH', `/projects/${p}`, { title: 'Three' });

  const r = await call('POST', `/events/${first}/revert`);
  expect(r.status).toBe(409);
  expect(r.body.error).toBe('conflict');
  expect(r.body.message).toContain('title');
  expect((await detail(p)).title).toBe('Three');
});

test('POST /events/:id/revert: an id that is not a positive integer is 400, an unknown event 404', async () => {
  for (const id of ['abc', '0', '-1', '1.5', '1e3', '01', '%20', '9007199254740993']) {
    const r = await call('POST', `/events/${id}/revert`);
    expect(r.status, id).toBe(400);
    expect(r.body, id).toMatchObject({ error: 'invalid' });
  }
  const missing = await call('POST', '/events/999/revert');
  expect(missing.status).toBe(404);
  expect(missing.body.error).toBe('not_found');
});

// ---- questions ---------------------------------------------------------------------------------------------------

test('answering a question executes its op; answering again is 409', async () => {
  const p = await newProject();
  const q = aiProposesDone(p);

  const pending = await call('GET', '/questions?status=pending', undefined, null);
  expect(pending.status).toBe(200);
  expect(pending.body).toMatchObject([{ id: q, kind: 'confirm', status: 'pending', project_id: p, options: [{ label: '确认', has_op: true, op: 'transition_stage', args: { project: p, stage: 'done' } }, { label: '拒绝', has_op: false, op: null, args: null }] }]);

  const answered = await call('POST', `/questions/${q}/answer`, { option_index: 0 });
  expect(answered.status).toBe(200);
  expect(answered.body).toMatchObject({ status: 'applied', event_id: expect.any(Number) });
  const project = await detail(p);
  expect(project.stage).toBe('done');
  expect(project.events[0]).toMatchObject({ op: 'transition_stage', actor: 'user', question_id: q });

  const again = await call('POST', `/questions/${q}/answer`, { option_index: 0 });
  expect(again.status).toBe(409);
  expect(again.body).toMatchObject({ error: 'not_pending' });
  expect((await call('GET', '/questions?status=answered', undefined, null)).body).toHaveLength(1);
});

test('answers that do not fit the question are 400 and leave it pending; unknown questions are 404', async () => {
  const p = await newProject();
  const q = aiProposesDone(p);
  for (const body of [{ option_index: 2 }, { option_index: -1 }, { option_index: 0.5 }, { text: 'a confirm question has no text' }]) {
    const r = await call('POST', `/questions/${q}/answer`, body);
    expect(r.status, JSON.stringify(body)).toBe(400);
    expect(r.body, JSON.stringify(body)).toMatchObject({ error: 'invalid' });
  }
  expect((await call('GET', '/questions?status=pending', undefined, null)).body).toHaveLength(1);
  expect((await call('POST', '/questions/q_nope/answer', { option_index: 0 })).status).toBe(404);
  expect((await call('POST', '/questions/q_nope/dismiss')).status).toBe(404);
});

test('declining (the option without an op) records the rejection and changes nothing', async () => {
  const p = await newProject();
  const q = aiProposesDone(p);
  const r = await call('POST', `/questions/${q}/answer`, { option_index: 1 });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: 'applied', event_id: null });
  expect((await detail(p)).stage).toBe('idea');
});

test('POST /questions/:id/dismiss withdraws the question; dismissing again is 409', async () => {
  const p = await newProject();
  const q = aiProposesDone(p);
  const dismissed = await call('POST', `/questions/${q}/dismiss`);
  expect(dismissed.status).toBe(200);
  expect(dismissed.body.status).toBe('applied');
  expect((await call('GET', '/questions?status=withdrawn', undefined, null)).body).toMatchObject([{ id: q, resolution_note: 'dismissed' }]);
  expect((await call('POST', `/questions/${q}/dismiss`)).status).toBe(409);
  expect((await call('POST', `/questions/${q}/answer`, { option_index: 0 })).status).toBe(409);
});

test('GET /questions is open, filters by status and project, and refuses an unknown status', async () => {
  const a = await newProject({ title: 'A' });
  const b = await newProject({ title: 'B' });
  const qa = aiProposesDone(a);
  const qb = aiProposesDone(b);

  const all = await call('GET', '/questions', undefined, null);
  expect(all.status).toBe(200);
  expect(all.body.map((q: Json) => q.id).sort()).toEqual([qa, qb].sort());
  expect((await call('GET', `/questions?project_id=${a}`, undefined, null)).body.map((q: Json) => q.id)).toEqual([qa]);
  expect((await call('GET', '/questions?status=answered', undefined, null)).body).toEqual([]);
  for (const query of ['status=nope', 'status=']) {
    const r = await call('GET', `/questions?${query}`, undefined, null);
    expect(r.status, query).toBe(400);
    expect(r.body.error, query).toBe('invalid');
  }
});

// ---- body and error handling -------------------------------------------------------------------------------------

test('malformed JSON is 400 and an oversized body is 413', async () => {
  const id = await newProject();
  for (const body of ['{not json', '', 'null', '[]', '"title"', '42']) {
    const r = await call('POST', '/projects', body);
    expect(r.status, JSON.stringify(body)).toBe(400);
    expect(r.body, JSON.stringify(body)).toMatchObject({ error: 'invalid' });
  }
  expect((await call('PATCH', `/projects/${id}`, '{"title":')).status).toBe(400);

  const big = await call('POST', '/projects', JSON.stringify({ title: 'x', summary: 'y'.repeat(70 * 1024) }));
  expect(big.status).toBe(413);
  expect(big.body).toMatchObject({ error: 'too_large' });
  const bigWithLength = await app.request('/projects', {
    method: 'POST',
    headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json', 'content-length': String(70 * 1024) },
    body: JSON.stringify({ title: 'x', summary: 'y'.repeat(70 * 1024) }),
  });
  expect(bigWithLength.status).toBe(413);

  // Just under the limit is let through to validation (the summary is long but allowed to be up to 4000 chars: 400, not 413).
  const near = await call('POST', '/projects', JSON.stringify({ title: 'x', summary: 'y'.repeat(60 * 1024) }));
  expect(near.status).toBe(400);
  expect(near.body.error).toBe('invalid');
});

test('the body limit does not apply to /ingest/*', async () => {
  const chunk = {
    session_key: SESSION,
    kind: 'transcript',
    offset_start: 0,
    offset_end: 100_000,
    ts_start: '2026-10-29T09:59:00.000Z',
    ts_end: '2026-10-29T09:59:30.000Z',
    text: 'z'.repeat(100_000),
    backfill: false,
  };
  await ingestSession();
  const r = await req('POST', '/ingest/chunks', { machine: COLLECTOR, chunks: [chunk] }, COLLECTOR_TOKEN);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ inserted: 1, duplicates: 0 });
});

test('an unauthenticated oversized request is 401, not 413', async () => {
  const r = await req('POST', '/projects', JSON.stringify({ title: 'x'.repeat(100 * 1024) }), null);
  expect(r.status).toBe(401);
});

test('an unexpected exception returns JSON 500 and is logged to stderr; the database is unchanged', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  failIds = true;
  const r = await req('POST', '/projects', { title: 'x' });
  expect(r.status).toBe(500);
  expect(r.headers.get('content-type')).toContain('application/json');
  expect(await r.json()).toEqual({ error: 'internal' });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(log.mock.calls[0], (_k, v) => (v instanceof Error ? v.message : v))).toContain('boom: id generator broke');

  failIds = false;
  expect((await call('GET', '/projects', undefined, null)).body).toEqual([]);
  expect(eventCount()).toBe(0);
});

test('the JSON 500 applies to the whole app, not only the project routes', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  db.close();
  const r = await req('GET', '/sessions', undefined, null);
  expect(r.status).toBe(500);
  expect(await r.json()).toEqual({ error: 'internal' });
  expect(log).toHaveBeenCalled();
});

test('createApp without a newId generator uses random prefixed ids', async () => {
  const plain = createApp(db, config, () => now);
  const res = await plain.request('/projects', {
    method: 'POST',
    headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).id).toMatch(/^p_[0-9a-f]{12}$/);
});
