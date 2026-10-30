import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';
import type { ServerConfig } from '../../src/server/config.ts';
import { OFFLINE_AFTER_MS } from '../../src/server/sessions-repo.ts';
import type { LlmRunner } from '../../src/understand/llm.ts';
import { Scheduler } from '../../src/understand/scheduler.ts';
import type { ChunkPush, SnapshotPush, SnapshotSession } from '../../src/shared/protocol.ts';

const GX10 = 'gx10-090e';
const GX10_TOKEN = 'gx10-secret-token';
const LAPTOP_TOKEN = 'laptop-secret-token';
const CLAUDE_KEY = 'claude:5d27595b-908e-4fe5-9283-890acdbd075f';

const config: ServerConfig = {
  port: 8787,
  dbPath: ':memory:',
  userToken: 'user-secret-token-0123456789',
  mcpToken: 'mcp-secret-token-0123456789',
  collectors: { [GX10]: GX10_TOKEN, laptop: LAPTOP_TOKEN },
};

let db: DatabaseSync;
let now: Date;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  now = new Date('2026-10-29T10:00:00.000Z');
  app = createApp(db, config, () => now);
});

afterEach(() => {
  db.close();
});

function session(key: string, extra: Partial<SnapshotSession> = {}): SnapshotSession {
  const sep = key.indexOf(':');
  return {
    key,
    agent_kind: key.slice(0, sep),
    native_id: key.slice(sep + 1),
    pane_id: 'w1:1:1',
    terminal_id: 't1',
    workspace_id: 'w1',
    tab_id: 'w1:1',
    cwd: '/home/demo/proj',
    title: 'Some task',
    live_status: 'working',
    fidelity: 'full',
    transcript_path: '/home/demo/.claude/x.jsonl',
    ...extra,
  };
}

function snapshot(machine: string, sessions: SnapshotSession[], purged: string[] = []): SnapshotPush {
  return { machine, collector_version: '0.1.0', sessions, purged };
}

type Chunk = ChunkPush['chunks'][number];
function chunk(session_key: string, offset_start: number, offset_end: number, extra: Partial<Chunk> = {}): Chunk {
  return {
    session_key,
    kind: 'transcript',
    offset_start,
    offset_end,
    ts_start: '2026-10-29T09:59:00.000Z',
    ts_end: '2026-10-29T09:59:30.000Z',
    text: `text ${offset_start}`,
    backfill: false,
    ...extra,
  };
}

async function post(path: string, body: unknown, token: string | null = GX10_TOKEN): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function get(path: string, token: string | null = GX10_TOKEN): Promise<Response> {
  return app.request(path, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
}

async function sessionsBody(path = '/sessions'): Promise<Array<Record<string, unknown>>> {
  return (await (await get(path, null)).json()) as Array<Record<string, unknown>>;
}

test('rejects ingest without token (401)', async () => {
  const body = snapshot(GX10, [session(CLAUDE_KEY)]);
  const res = await post('/ingest/snapshot', body, null);
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
  expect((await post('/ingest/chunks', { machine: GX10, chunks: [] }, null)).status).toBe(401);
  expect((await get(`/ingest/offset?machine=${GX10}&session_key=${CLAUDE_KEY}`, null)).status).toBe(401);
  expect(await sessionsBody()).toEqual([]);
});

test('rejects a malformed Authorization header or an unknown token (401)', async () => {
  const body = snapshot(GX10, [session(CLAUDE_KEY)]);
  const send = (authorization: string) =>
    app.request('/ingest/snapshot', { method: 'POST', headers: { authorization }, body: JSON.stringify(body) });
  expect((await send(`Basic ${GX10_TOKEN}`)).status).toBe(401);
  expect((await send(GX10_TOKEN)).status).toBe(401);
  expect((await send('Bearer ')).status).toBe(401);
  expect((await send('Bearer not-a-token')).status).toBe(401);
  expect((await send(`Bearer ${GX10_TOKEN}x`)).status).toBe(401); // longer than the real token
  expect((await send(`Bearer ${GX10_TOKEN.slice(0, -1)}`)).status).toBe(401); // shorter
  expect((await send(`Bearer ${'x'.repeat(GX10_TOKEN.length)}`)).status).toBe(401); // same length
  expect(await sessionsBody()).toEqual([]);
});

test('rejects token of another machine (403)', async () => {
  // gx10-090e's token pushing a snapshot for machine 'laptop'
  const res = await post('/ingest/snapshot', snapshot('laptop', [session(CLAUDE_KEY)]), GX10_TOKEN);
  expect(res.status).toBe(403);
  expect((await post('/ingest/chunks', { machine: 'laptop', chunks: [] }, GX10_TOKEN)).status).toBe(403);
  expect((await get(`/ingest/offset?machine=laptop&session_key=${CLAUDE_KEY}`, GX10_TOKEN)).status).toBe(403);
  // a machine nobody configured is also forbidden for a valid token
  expect((await post('/ingest/snapshot', snapshot('stranger', []), GX10_TOKEN)).status).toBe(403);
  expect(await sessionsBody()).toEqual([]);
});

test('rejects malformed body (400) with zod issues', async () => {
  const res = await post('/ingest/snapshot', { machine: GX10, collector_version: '0.1.0', sessions: 'nope' });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; issues: Array<{ path: unknown[] }> };
  expect(typeof body.error).toBe('string');
  expect(body.issues.some((i) => i.path[0] === 'sessions')).toBe(true);
  expect(body.issues.some((i) => i.path[0] === 'purged')).toBe(true);

  const chunks = await post('/ingest/chunks', { machine: GX10, chunks: [{ session_key: CLAUDE_KEY }] });
  expect(chunks.status).toBe(400);
  expect(((await chunks.json()) as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
});

test('rejects a body that is not JSON, or has no machine (400)', async () => {
  for (const body of ['{not json', '', 'null', '[]', '"x"', JSON.stringify({ chunks: [] }), JSON.stringify({ machine: 7 })]) {
    const res = await post('/ingest/chunks', body);
    expect(res.status, body).toBe(400);
    expect(typeof ((await res.json()) as { error: string }).error).toBe('string');
  }
});

test('rejects invalid session keys at the ingest boundary and stores nothing (400)', async () => {
  const cases: Array<[string, string, unknown]> = [
    ['sessions[1].key', '/ingest/snapshot', snapshot(GX10, [session('claude:ok-1'), session('nocolon', { native_id: null })])],
    ['sessions[0].key', '/ingest/snapshot', snapshot(GX10, [session('claude:', { native_id: null })])],
    ['sessions[0].key', '/ingest/snapshot', snapshot(GX10, [session('pending:onlymachine', { native_id: null })])],
    ['purged[0]', '/ingest/snapshot', snapshot(GX10, [session(CLAUDE_KEY)], [':x'])],
    ['chunks[1].session_key', '/ingest/chunks', { machine: GX10, chunks: [chunk(CLAUDE_KEY, 0, 5), chunk('bad', 5, 9)] }],
  ];
  for (const [where, path, body] of cases) {
    const res = await post(path, body);
    expect(res.status, where).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(where);
  }
  expect(await sessionsBody()).toEqual([]);
  expect(db.prepare('SELECT count(*) AS n FROM chunks').get()).toEqual({ n: 0 });

  // the invalid key is named in the message
  const res = await post('/ingest/snapshot', snapshot(GX10, [session('nocolon', { native_id: null })]));
  expect(((await res.json()) as { error: string }).error).toContain('nocolon');
});

test('rejects a pending key that belongs to another machine (400)', async () => {
  const foreign = 'pending:laptop:t9';
  const pendingSession = (key: string) => session(key, { native_id: null, agent_kind: 'codex', fidelity: 'screen' });
  expect((await post('/ingest/snapshot', snapshot(GX10, [pendingSession(foreign)]))).status).toBe(400);
  expect((await post('/ingest/snapshot', snapshot(GX10, [], [foreign]))).status).toBe(400);
  expect((await post('/ingest/chunks', { machine: GX10, chunks: [chunk(foreign, 0, 5)] })).status).toBe(400);

  const own = `pending:${GX10}:t9`;
  expect((await post('/ingest/snapshot', snapshot(GX10, [pendingSession(own)]))).status).toBe(200);
  expect((await post('/ingest/chunks', { machine: GX10, chunks: [chunk(own, 0, 5)] })).status).toBe(200);
});

test('snapshot then GET /sessions returns the session with short_id', async () => {
  const res = await post('/ingest/snapshot', snapshot(GX10, [session(CLAUDE_KEY)]));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const sessions = await sessionsBody();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    key: CLAUDE_KEY,
    machine: GX10,
    short_id: '5d27595b',
    lifecycle: 'live',
    effective_status: 'working',
    chunk_count: 0,
  });
});

test('GET /sessions filters by machine and lifecycle; empty filters mean no filter', async () => {
  const laptopKey = 'codex:019a0000-aaaa-bbbb-cccc-111122223333';
  await post('/ingest/snapshot', snapshot(GX10, [session(CLAUDE_KEY)]));
  await post('/ingest/snapshot', snapshot('laptop', [session(laptopKey)]), LAPTOP_TOKEN);
  // second gx10 snapshot no longer reports the session: it has ended
  await post('/ingest/snapshot', snapshot(GX10, []));

  const keys = async (path: string) => (await sessionsBody(path)).map((s) => s.key);
  expect(await keys('/sessions?machine=laptop')).toEqual([laptopKey]);
  expect(await keys(`/sessions?machine=${GX10}`)).toEqual([CLAUDE_KEY]);
  expect(await keys('/sessions?lifecycle=ended')).toEqual([CLAUDE_KEY]);
  expect(await keys('/sessions?lifecycle=live')).toEqual([laptopKey]);
  expect(await keys('/sessions?machine=laptop&lifecycle=ended')).toEqual([]);
  expect((await keys('/sessions?machine=&lifecycle=')).sort()).toEqual([CLAUDE_KEY, laptopKey].sort());
});

test('uses the server clock for heartbeats, so a silent machine shows as offline', async () => {
  await post('/ingest/snapshot', snapshot(GX10, [session(CLAUDE_KEY)]));
  expect((await sessionsBody())[0]).toMatchObject({ effective_status: 'working', last_seen: now.toISOString() });

  now = new Date(now.getTime() + OFFLINE_AFTER_MS + 1000);
  expect((await sessionsBody())[0]).toMatchObject({ effective_status: 'offline', lifecycle: 'live' });
});

test('chunks are deduped across repeated pushes', async () => {
  const body = { machine: GX10, chunks: [chunk(CLAUDE_KEY, 0, 10), chunk(CLAUDE_KEY, 10, 20)] };
  const first = await post('/ingest/chunks', body);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ inserted: 2, duplicates: 0 });

  const second = await post('/ingest/chunks', body);
  expect(await second.json()).toEqual({ inserted: 0, duplicates: 2 });

  const overlap = await post('/ingest/chunks', { machine: GX10, chunks: [chunk(CLAUDE_KEY, 10, 20), chunk(CLAUDE_KEY, 20, 30)] });
  expect(await overlap.json()).toEqual({ inserted: 1, duplicates: 1 });
  expect(db.prepare('SELECT count(*) AS n FROM chunks').get()).toEqual({ n: 3 });
});

test('chunks are stamped with the server clock, not a time from the body', async () => {
  await post('/ingest/chunks', { machine: GX10, chunks: [chunk(CLAUDE_KEY, 0, 10)] });
  expect(db.prepare('SELECT received_at FROM chunks').get()).toEqual({ received_at: now.toISOString() });
});

test('offset endpoint returns null for unknown session', async () => {
  const res = await get(`/ingest/offset?machine=${GX10}&session_key=${CLAUDE_KEY}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ session_key: CLAUDE_KEY, max_offset_end: null });
});

test('offset endpoint returns the max transcript offset_end', async () => {
  await post('/ingest/chunks', {
    machine: GX10,
    chunks: [chunk(CLAUDE_KEY, 0, 10), chunk(CLAUDE_KEY, 10, 40), chunk(CLAUDE_KEY, 5_000_000, 9_999_999, { kind: 'screen' })],
  });
  const res = await get(`/ingest/offset?machine=${GX10}&session_key=${encodeURIComponent(CLAUDE_KEY)}`);
  expect(await res.json()).toEqual({ session_key: CLAUDE_KEY, max_offset_end: 40 });
});

test('offset endpoint requires machine and session_key (400)', async () => {
  expect((await get(`/ingest/offset?session_key=${CLAUDE_KEY}`)).status).toBe(400);
  expect((await get(`/ingest/offset?machine=${GX10}`)).status).toBe(400);
  expect((await get(`/ingest/offset?machine=${GX10}&session_key=`)).status).toBe(400);
});

test('by-short-id returns matches', async () => {
  const other = 'codex:019a0000-aaaa-bbbb-cccc-111122223333';
  await post('/ingest/snapshot', snapshot(GX10, [session(CLAUDE_KEY), session(other)]));

  const hit = await get('/sessions/by-short-id/5d27595b', null);
  expect(hit.status).toBe(200);
  const sessions = (await hit.json()) as Array<{ key: string; short_id: string }>;
  expect(sessions.map((s) => s.key)).toEqual([CLAUDE_KEY]);
  expect(sessions[0].short_id).toBe('5d27595b');

  expect(((await (await get('/sessions/by-short-id/5d27', null)).json()) as unknown[]).length).toBe(1);
  expect(await (await get('/sessions/by-short-id/zzzzzzzz', null)).json()).toEqual([]);
});

test('sessions endpoints need no token, unknown routes are 404', async () => {
  expect((await get('/sessions', null)).status).toBe(200);
  expect((await get('/sessions/by-short-id/abcd', null)).status).toBe(200);
  expect((await get('/nope', null)).status).toBe(404);
  expect((await get('/ingest/snapshot', GX10_TOKEN)).status).toBe(404); // POST-only
});

// ---- understanding -----------------------------------------------------------------------------------------------

function withScheduler(): { app: ReturnType<typeof createApp>; scheduler: Scheduler } {
  const runner: LlmRunner = async () => ({ ok: false, kind: 'other', message: 'not in tests', durationMs: 0 });
  const scheduler = new Scheduler(db, { now: () => now, newId: (p) => `${p}_1` }, runner, { digest: 'd', curate: 'c' });
  return { app: createApp(db, config, () => now, undefined, { scheduler }), scheduler };
}

test('GET /status is open and reports the scheduler state', async () => {
  const off = await get('/status', null);
  expect(off.status).toBe(200);
  expect(await off.json()).toEqual({
    understanding: {
      enabled: false,
      paused_until: null,
      pause_reason: null,
      last_error: null,
      running: null,
      waiting_sessions: 0,
      uncurated_digests: 0,
      backfill: { sessions_total: 0, sessions_done: 0 },
      last_digest_at: null,
      last_curate_at: null,
    },
  });

  await post('/ingest/chunks', { machine: GX10, chunks: [chunk(CLAUDE_KEY, 0, 10), chunk(CLAUDE_KEY, 10, 20, { backfill: true })] });
  const { app: on } = withScheduler();
  const res = await on.request('/status');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { understanding: Record<string, unknown> };
  expect(body.understanding).toMatchObject({
    enabled: true,
    paused_until: null,
    waiting_sessions: 1,
    uncurated_digests: 0,
    backfill: { sessions_total: 1, sessions_done: 0 },
  });
});

test('POST /sync needs the user token and returns 202', async () => {
  const { app: on, scheduler } = withScheduler();
  const requestSync = vi.spyOn(scheduler, 'requestSync');
  const sync = (token: string | null, target = on) =>
    target.request('/sync', { method: 'POST', headers: token === null ? {} : { authorization: `Bearer ${token}` } });

  expect((await sync(null)).status).toBe(401);
  expect((await sync(GX10_TOKEN)).status).toBe(401);
  expect(requestSync).not.toHaveBeenCalled();

  const accepted = await sync(config.userToken);
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ accepted: true });
  expect(requestSync).toHaveBeenCalledTimes(1);

  const disabled = await sync(config.userToken, app);
  expect(disabled.status).toBe(409);
  expect(await disabled.json()).toEqual({ error: 'understanding_disabled' });
  expect((await sync(null, app)).status).toBe(401);
});

// ---- evidence and session links ----------------------------------------------------------------------------------

const USER_TOKEN = config.userToken;

async function userCall(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${USER_TOKEN}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('GET /evidence/:ref needs the user token', async () => {
  await post('/ingest/snapshot', snapshot(GX10, [session(CLAUDE_KEY)]));
  await post('/ingest/chunks', { machine: GX10, chunks: [chunk(CLAUDE_KEY, 0, 10, { text: 'hello evidence' })] });
  const id = (db.prepare('SELECT id FROM chunks').get() as { id: number }).id;

  const anonymous = await get(`/evidence/chunk:${id}`, null);
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
  expect((await get(`/evidence/chunk:${id}`, GX10_TOKEN)).status).toBe(401);

  const ok = await get(`/evidence/chunk:${id}`, USER_TOKEN);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({
    ref: `chunk:${id}`,
    kind: 'chunk',
    id,
    session_key: CLAUDE_KEY,
    digest: null,
    session: { key: CLAUDE_KEY, short_id: '5d27595b' },
    chunks: [{ id, text: 'hello evidence', truncated: false }],
  });
});

test('GET /evidence/:ref answers 400 for a malformed ref and 404 for an unknown one', async () => {
  const bad = await get('/evidence/chunk:abc', USER_TOKEN);
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: 'invalid' });
  expect((await get('/evidence/nonsense', USER_TOKEN)).status).toBe(400);
  expect((await get('/evidence/chunk%3A0', USER_TOKEN)).status).toBe(400);

  const missing = await get('/evidence/chunk:999', USER_TOKEN);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: 'not_found' });
  expect((await get('/evidence/digest:999', USER_TOKEN)).status).toBe(404);
});

test('GET /sessions items carry linked_projects', async () => {
  const other = 'codex:019a0000-aaaa-bbbb-cccc-111122223333';
  await post('/ingest/snapshot', snapshot(GX10, [session(CLAUDE_KEY), session(other)]));
  const created = await userCall('POST', '/projects', { title: 'Linked project' });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const linked = await userCall('POST', `/sessions/${encodeURIComponent(CLAUDE_KEY)}/links`, { project_id: id });
  expect(linked.status).toBe(200);

  const byKey = new Map((await sessionsBody()).map((s) => [s.key, s]));
  expect(byKey.get(CLAUDE_KEY)).toMatchObject({ linked_projects: [{ id, title: 'Linked project' }], short_id: '5d27595b' });
  expect(byKey.get(other)).toMatchObject({ linked_projects: [] });
});
