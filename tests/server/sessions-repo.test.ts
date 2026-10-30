import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MIGRATIONS, openDb } from '../../src/server/db.ts';
import {
  applySnapshot,
  findByShortId,
  insertChunks,
  listSessions,
  maxOffset,
  OFFLINE_AFTER_MS,
} from '../../src/server/sessions-repo.ts';
import type { ChunkPush, SnapshotPush, SnapshotSession } from '../../src/shared/protocol.ts';

let db: DatabaseSync;
const t0 = new Date('2026-10-29T10:00:00.000Z');
const t1 = new Date('2026-10-29T10:00:10.000Z');
const t2 = new Date('2026-10-29T10:00:20.000Z');

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

function session(key: string, terminal_id: string, extra: Partial<SnapshotSession> = {}): SnapshotSession {
  const sep = key.indexOf(':');
  const pending = key.startsWith('pending:');
  return {
    key,
    agent_kind: pending ? 'codex' : key.slice(0, sep),
    native_id: pending ? null : key.slice(sep + 1),
    pane_id: 'w1:1:1',
    terminal_id,
    workspace_id: 'w1',
    tab_id: 'w1:1',
    cwd: '/home/demo/proj',
    title: 'Some task',
    live_status: 'working',
    fidelity: pending ? 'screen' : 'full',
    transcript_path: pending ? null : `/home/demo/.claude/${key.slice(sep + 1)}.jsonl`,
    ...extra,
  };
}

function push(machine: string, sessions: SnapshotSession[], purged: string[] = []): SnapshotPush {
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

function row(key: string): Record<string, unknown> {
  const r = db.prepare('SELECT * FROM sessions WHERE key = ?').get(key);
  if (!r) throw new Error(`no session ${key}`);
  return r;
}

function chunkKeys(): Array<{ session_key: string; offset_start: number; text: string }> {
  return db
    .prepare('SELECT session_key, offset_start, text FROM chunks ORDER BY session_key, offset_start')
    .all() as Array<{ session_key: string; offset_start: number; text: string }>;
}

const A = 'claude:aaaaaaaa-1111-4111-8111-111111111111';
const B = 'claude:bbbbbbbb-2222-4222-8222-222222222222';
const C = 'codex:cccccccc-3333-4333-8333-333333333333';
const X = 'claude:dddddddd-4444-4444-8444-444444444444';
const Y = 'codex:eeeeeeee-5555-4555-8555-555555555555';

test('snapshot upserts live sessions and heartbeat', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1'), session(B, 'term_2')]), t0);
  applySnapshot(db, push('laptop', [session(A, 'term_1', { title: 'Renamed', live_status: 'idle', pane_id: 'w1:2:1' }), session(B, 'term_2')]), t1);

  expect(db.prepare('SELECT * FROM machines').all()).toEqual([
    { label: 'laptop', last_heartbeat: t1.toISOString(), collector_version: '0.1.0' },
  ]);
  expect(row(A)).toMatchObject({
    agent_kind: 'claude',
    native_id: 'aaaaaaaa-1111-4111-8111-111111111111',
    machine: 'laptop',
    pane_id: 'w1:2:1',
    terminal_id: 'term_1',
    title: 'Renamed',
    live_status: 'idle',
    lifecycle: 'live',
    fidelity: 'full',
    predecessor_key: null,
    merged_into: null,
    ignored: 0,
    first_seen: t0.toISOString(),
    last_seen: t1.toISOString(),
  });
});

test('session missing from its machine snapshot becomes ended', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1'), session(B, 'term_2')]), t0);
  applySnapshot(db, push('laptop', [session(A, 'term_1')]), t1);
  expect(row(A)).toMatchObject({ lifecycle: 'live', last_seen: t1.toISOString() });
  expect(row(B)).toMatchObject({ lifecycle: 'ended', last_seen: t0.toISOString() });
  expect(listSessions(db, {}, t1).find((v) => v.key === B)?.effective_status).toBe('ended');
});

test('an ended session that shows up again is live again', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1')]), t0);
  applySnapshot(db, push('laptop', []), t1);
  applySnapshot(db, push('laptop', [session(A, 'term_9')]), t2);
  expect(row(A)).toMatchObject({ lifecycle: 'live', terminal_id: 'term_9', first_seen: t0.toISOString() });
});

test('sessions of a machine that stopped reporting show offline, not ended', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1')]), t0);
  const v = listSessions(db, {}, new Date(t0.getTime() + 181000));
  expect(v[0]).toMatchObject({ lifecycle: 'live', effective_status: 'offline' });

  const fresh = listSessions(db, {}, new Date(t0.getTime() + OFFLINE_AFTER_MS));
  expect(fresh[0]).toMatchObject({ lifecycle: 'live', effective_status: 'working' });
});

test('other machines are unaffected by one machine snapshot', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1')]), t0);
  applySnapshot(db, push('desktop', [session(B, 'term_1')]), t0);
  applySnapshot(db, push('desktop', [], [A]), t1);
  expect(row(A)).toMatchObject({ lifecycle: 'live', machine: 'laptop' });
  expect(row(B)).toMatchObject({ lifecycle: 'ended' });
  expect(db.prepare('SELECT label, last_heartbeat FROM machines ORDER BY label').all()).toEqual([
    { label: 'desktop', last_heartbeat: t1.toISOString() },
    { label: 'laptop', last_heartbeat: t0.toISOString() },
  ]);
});

test('new session on same terminal after old one ended gets predecessor_key', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1'), session(C, 'term_2')]), t0);
  applySnapshot(db, push('laptop', [session(B, 'term_1'), session(X, 'term_3')]), t1);
  expect(row(A)).toMatchObject({ lifecycle: 'ended' });
  expect(row(B)).toMatchObject({ lifecycle: 'live', predecessor_key: A });
  expect(row(X)).toMatchObject({ predecessor_key: null });
});

test('an already-known session moving onto an ended terminal gets no predecessor_key', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1'), session(B, 'term_2')]), t0);
  applySnapshot(db, push('laptop', [session(B, 'term_1')]), t1);
  expect(row(A)).toMatchObject({ lifecycle: 'ended' });
  expect(row(B)).toMatchObject({ predecessor_key: null });
});

test('predecessor only comes from sessions ended by this snapshot', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1')]), t0);
  applySnapshot(db, push('laptop', []), t1);
  applySnapshot(db, push('laptop', [session(B, 'term_1')]), t2);
  expect(row(B)).toMatchObject({ predecessor_key: null });
});

test('pending session merges into native key and moves chunks', () => {
  const P = 'pending:laptop:term_1';
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t0);
  insertChunks(db, { machine: 'laptop', chunks: [
    chunk(P, 1761732000000, 1761732000000, { kind: 'screen' }),
    chunk(P, 1761732005000, 1761732005000, { kind: 'screen' }),
  ] }, t0);

  applySnapshot(db, push('laptop', [session(Y, 'term_1')]), t1);

  // Ruling R3: a merged pending session is the same session, not a predecessor.
  expect(row(Y)).toMatchObject({ lifecycle: 'live', predecessor_key: null });
  expect(row(P)).toMatchObject({ lifecycle: 'ended', merged_into: Y });
  expect(chunkKeys().map((c) => [c.session_key, c.offset_start])).toEqual([
    [Y, 1761732000000],
    [Y, 1761732005000],
  ]);
});

test('pending merge keeps the native chunk when offsets collide', () => {
  const P = 'pending:laptop:term_1';
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t0);
  insertChunks(db, { machine: 'laptop', chunks: [
    chunk(P, 1000, 1000, { kind: 'screen', text: 'pending dup' }),
    chunk(P, 2000, 2000, { kind: 'screen', text: 'pending only' }),
    chunk(Y, 1000, 1500, { text: 'native' }),
  ] }, t0);

  applySnapshot(db, push('laptop', [session(Y, 'term_1')]), t1);

  expect(chunkKeys()).toEqual([
    { session_key: Y, offset_start: 1000, text: 'native' },
    { session_key: Y, offset_start: 2000, text: 'pending only' },
  ]);
});

test('pending sessions of other machines are not merged', () => {
  const P = 'pending:desktop:term_1';
  applySnapshot(db, push('desktop', [session(P, 'term_1')]), t0);
  applySnapshot(db, push('laptop', [session(Y, 'term_1')]), t1);
  expect(row(P)).toMatchObject({ lifecycle: 'live', merged_into: null });
});

test('a pending session that ended earlier is not merged', () => {
  const P = 'pending:laptop:term_1';
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t0);
  applySnapshot(db, push('laptop', []), t1);
  applySnapshot(db, push('laptop', [session(Y, 'term_1')]), t2);
  expect(row(P)).toMatchObject({ lifecycle: 'ended', merged_into: null });
  expect(row(Y)).toMatchObject({ predecessor_key: null });
});

test('a pending session of another agent kind is not merged but becomes the predecessor', () => {
  const P = 'pending:laptop:term_1'; // agent_kind codex
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t0);
  insertChunks(db, { machine: 'laptop', chunks: [chunk(P, 1761732000000, 1761732000000, { kind: 'screen' })] }, t0);

  applySnapshot(db, push('laptop', [session(X, 'term_1')]), t1); // claude in the same pane

  expect(row(P)).toMatchObject({ lifecycle: 'ended', merged_into: null });
  expect(row(X)).toMatchObject({ lifecycle: 'live', predecessor_key: P });
  expect(chunkKeys().map((c) => c.session_key)).toEqual([P]);
});

test('no merge while the snapshot still reports the pending key', () => {
  const P = 'pending:laptop:term_1';
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t0);
  insertChunks(db, { machine: 'laptop', chunks: [chunk(P, 1761732000000, 1761732000000, { kind: 'screen' })] }, t0);

  applySnapshot(db, push('laptop', [session(P, 'term_1'), session(Y, 'term_1')]), t1);

  expect(row(P)).toMatchObject({ lifecycle: 'live', merged_into: null });
  expect(chunkKeys().map((c) => c.session_key)).toEqual([P]);
});

test('a revived pending key starts fresh and succeeds the session it was merged into (R7)', () => {
  const P = 'pending:laptop:term_1';
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t0);
  applySnapshot(db, push('laptop', [session(Y, 'term_1')]), t1);
  expect(row(P)).toMatchObject({ merged_into: Y });

  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t2);

  expect(row(Y)).toMatchObject({ lifecycle: 'ended' });
  expect(row(P)).toMatchObject({
    lifecycle: 'live',
    merged_into: null,
    predecessor_key: Y,
    first_seen: t2.toISOString(),
    last_seen: t2.toISOString(),
  });
});

test('a pending key that ended without merging also starts fresh when revived (R7)', () => {
  const P = 'pending:laptop:term_1';
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t0);
  applySnapshot(db, push('laptop', [session(X, 'term_1')]), t1); // P ended, X succeeds it
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t2); // X ended, P revived
  expect(row(P)).toMatchObject({ lifecycle: 'live', first_seen: t2.toISOString(), predecessor_key: X });
});

test('a revived pending key can be merged again later', () => {
  const P = 'pending:laptop:term_1';
  const Z = 'codex:ffffffff-6666-4666-8666-666666666666';
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t0);
  applySnapshot(db, push('laptop', [session(Y, 'term_1')]), t1);
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t2);
  const t3 = new Date(t2.getTime() + 10000);
  insertChunks(db, { machine: 'laptop', chunks: [chunk(P, t2.getTime(), t2.getTime(), { kind: 'screen' })] }, t2);

  applySnapshot(db, push('laptop', [session(Z, 'term_1')]), t3);

  expect(row(P)).toMatchObject({ lifecycle: 'ended', merged_into: Z });
  expect(row(Z)).toMatchObject({ lifecycle: 'live', predecessor_key: null });
  expect(chunkKeys().map((c) => [c.session_key, c.offset_start])).toEqual([[Z, t2.getTime()]]);
});

test('the same key twice in one snapshot: last occurrence wins', () => {
  applySnapshot(db, push('laptop', [
    session(A, 'term_1', { pane_id: 'w1:1:1', title: 'first' }),
    session(A, 'term_2', { pane_id: 'w1:2:1', title: 'second' }),
  ]), t0);
  expect(row(A)).toMatchObject({ lifecycle: 'live', terminal_id: 'term_2', pane_id: 'w1:2:1', title: 'second' });
  expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
});

test('purged keys are marked purged', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1'), session(B, 'term_2')]), t0);
  applySnapshot(db, push('desktop', [session(C, 'term_3')]), t0);
  applySnapshot(db, push('laptop', [session(A, 'term_1')], [A, B, C]), t1);
  expect(row(A)).toMatchObject({ lifecycle: 'purged' });
  expect(row(B)).toMatchObject({ lifecycle: 'purged' });
  expect(row(C)).toMatchObject({ lifecycle: 'live' }); // belongs to another machine
  expect(listSessions(db, { lifecycle: 'purged' }, t1).map((v) => [v.key, v.effective_status])).toEqual([
    [A, 'purged'],
    [B, 'purged'],
  ]);
});

test('a failing snapshot leaves nothing behind', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1')]), t0);
  const bad = push('laptop', [session(B, 'term_2'), { ...session(X, 'term_3'), cwd: {} as unknown as string }]);
  expect(() => applySnapshot(db, bad, t1)).toThrow();
  expect(row(A)).toMatchObject({ lifecycle: 'live', last_seen: t0.toISOString() });
  expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
});

test('insertChunks dedupes on (session_key, offset_start)', () => {
  const cp: ChunkPush = { machine: 'laptop', chunks: [chunk(A, 0, 100), chunk(A, 100, 250)] };
  const now = t0;
  expect(insertChunks(db, cp, now)).toEqual({ inserted: 2, duplicates: 0 });
  expect(insertChunks(db, cp, now)).toEqual({ inserted: 0, duplicates: 2 });
  expect(insertChunks(db, { machine: 'laptop', chunks: [chunk(A, 100, 250), chunk(A, 250, 300)] }, now))
    .toEqual({ inserted: 1, duplicates: 1 });
  expect(db.prepare('SELECT kind, backfill, digested, received_at FROM chunks WHERE offset_start = 0').get())
    .toEqual({ kind: 'transcript', backfill: 0, digested: 0, received_at: t0.toISOString() });
});

test('insertChunks is all-or-nothing', () => {
  const bad = { ...chunk(A, 100, 200), text: {} as unknown as string };
  expect(() => insertChunks(db, { machine: 'laptop', chunks: [chunk(A, 0, 100), bad] }, t0)).toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM chunks').get()).toEqual({ n: 0 });
});

test('maxOffset returns max offset_end or null', () => {
  expect(maxOffset(db, A)).toBeNull();
  insertChunks(db, { machine: 'laptop', chunks: [chunk(A, 0, 100), chunk(A, 100, 250), chunk(B, 0, 999)] }, t0);
  expect(maxOffset(db, A)).toBe(250);
});

test('maxOffset ignores screen chunks (e.g. moved in by a pending merge)', () => {
  const P = 'pending:laptop:term_1';
  applySnapshot(db, push('laptop', [session(P, 'term_1')]), t0);
  insertChunks(db, { machine: 'laptop', chunks: [chunk(P, 1761732000000, 1761732000000, { kind: 'screen' })] }, t0);
  applySnapshot(db, push('laptop', [session(Y, 'term_1')]), t1);
  expect(maxOffset(db, Y)).toBeNull();
  insertChunks(db, { machine: 'laptop', chunks: [chunk(Y, 0, 400)] }, t1);
  expect(maxOffset(db, Y)).toBe(400);
});

test('listSessions filters, orders live first then by last_seen desc, and counts chunks', () => {
  applySnapshot(db, push('laptop', [session(A, 'term_1'), session(B, 'term_2')]), t0);
  applySnapshot(db, push('desktop', [session(C, 'term_3')]), t1);
  applySnapshot(db, push('laptop', [session(X, 'term_4')]), t2);
  insertChunks(db, { machine: 'laptop', chunks: [chunk(A, 0, 1), chunk(A, 1, 2), chunk(X, 0, 1)] }, t2);

  const all = listSessions(db, {}, t2);
  // X and C are live (X seen later); A and B ended with equal last_seen, tie broken by key.
  expect(all.map((v) => v.key)).toEqual([X, C, A, B]);
  expect(all.find((v) => v.key === A)).toMatchObject({ chunk_count: 2, short_id: 'aaaaaaaa', effective_status: 'ended' });
  expect(all.find((v) => v.key === B)).toMatchObject({ chunk_count: 0 });

  expect(listSessions(db, { machine: 'desktop' }, t2).map((v) => v.key)).toEqual([C]);
  expect(listSessions(db, { machine: 'laptop', lifecycle: 'live' }, t2).map((v) => v.key)).toEqual([X]);
});

test('findByShortId resolves 8-char prefix', () => {
  const A2 = 'claude:aaaaaaaa-9999-4999-8999-999999999999';
  const P = 'pending:laptop:term_65e13dfbb5fca2';
  applySnapshot(db, push('laptop', [session(A, 'term_1'), session(A2, 'term_2'), session(B, 'term_3'), session(P, 'term_65e13dfbb5fca2')]), t0);

  expect(findByShortId(db, 'bbbbbbbb', t0).map((v) => v.key)).toEqual([B]);
  expect(findByShortId(db, 'bbbbbbbb', t0)[0]).toMatchObject({ short_id: 'bbbbbbbb', effective_status: 'working' });
  // Colliding prefixes: the 8-char prefix matches both, the grown short id resolves one.
  expect(findByShortId(db, 'aaaaaaaa', t0).map((v) => v.key).sort()).toEqual([A, A2].sort());
  expect(findByShortId(db, 'aaaaaaaa-1', t0).map((v) => v.key)).toEqual([A]);
  // A longer pasted prefix of the native id also resolves.
  expect(findByShortId(db, 'bbbbbbbb-2222-42', t0).map((v) => v.key)).toEqual([B]);
  // Pending sessions resolve by terminal id.
  expect(findByShortId(db, 'term_65e', t0).map((v) => v.key)).toEqual([P]);
  expect(findByShortId(db, 'zzzzzzzz', t0)).toEqual([]);
});

test('migrations are idempotent when opening the same file twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-pm-db-'));
  try {
    const path = join(dir, 'pm.db');
    const first = openDb(path);
    applySnapshot(first, push('laptop', [session(A, 'term_1')]), t0);
    expect(first.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    first.close();

    const second = openDb(path);
    expect(second.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    expect(second.prepare('SELECT key FROM sessions').all()).toEqual([{ key: A }]);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
