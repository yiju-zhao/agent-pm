import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getEvidence } from '../../src/domain/evidence.ts';
import { readFeedState } from '../../src/server/change-feed.ts';
import { MIGRATIONS, openDb } from '../../src/server/db.ts';
import { getSession, insertChunks, listSessions, maxOffset, OFFLINE_AFTER_MS } from '../../src/server/sessions-repo.ts';
import { applySnapshot } from '../../src/server/sessions-repo.ts';
import { sessionEffectiveStatus } from '../../src/server/sources-repo.ts';
import { disabledStatus } from '../../src/understand/status.ts';
import {
  agent,
  call,
  count,
  event,
  HERDR_TOKEN,
  herdrChunks,
  herdrSession,
  herdrSnapshot,
  MACHINE,
  OTHER_TOKEN,
  OTHER_SOURCE,
  PASEO_SOURCE,
  PaseoWriter,
  sessionRow,
  SERVER_ID,
  startCenter,
} from '../helpers/center.ts';
import type { Center } from '../helpers/center.ts';

const H = 'claude:aaaaaaaa-1111-4111-8111-111111111111'; // herdr only
const P_NATIVE = 'bbbbbbbb-2222-4222-8222-222222222222'; // Paseo only
const SHARED = 'cccccccc-3333-4333-8333-333333333333'; // both

let center: Center;
let paseo: PaseoWriter;

beforeEach(async () => {
  center = startCenter();
  paseo = new PaseoWriter(center);
  expect((await paseo.lease()).status).toBe(200);
});
afterEach(() => center.close());

const status = (key: string) => listSessions(center.db, {}, center.now).find((v) => v.key === key)?.effective_status;
const herdr = (sessions: ReturnType<typeof herdrSession>[]) => call(center, 'POST', '/ingest/snapshot', HERDR_TOKEN, herdrSnapshot(sessions));

describe('two sources on one machine', () => {
  test('neither source ends the other one’s sessions', async () => {
    await herdr([herdrSession(H)]);
    await paseo.snapshot([agent('agent-p', { native_id: P_NATIVE, native_id_origin: 'runtime' })]);
    // Each source now reports without the other's session, several times, interleaved.
    for (let i = 0; i < 3; i++) {
      center.advance(10_000);
      expect((await herdr([herdrSession(H)])).status).toBe(200);
      expect((await paseo.snapshot([agent('agent-p', { native_id: P_NATIVE, native_id_origin: 'runtime' })])).status).toBe(200);
    }
    expect(status(H)).toBe('working');
    expect(status(`claude:${P_NATIVE}`)).toBe('working');
    // Locations are not overwritten across sources.
    expect(sessionRow(center.db, H)).toMatchObject({ machine: MACHINE, pane_id: 'w1:1:1', terminal_id: 'term_1' });
    expect(sessionRow(center.db, `claude:${P_NATIVE}`)).toMatchObject({ machine: MACHINE, pane_id: null, terminal_id: null, workspace_id: 'ws_1' });
  });

  test('an empty herdr snapshot ends herdr sessions only, an empty complete Paseo snapshot Paseo ones only', async () => {
    await herdr([herdrSession(H)]);
    await paseo.snapshot([agent('agent-p', { native_id: P_NATIVE, native_id_origin: 'runtime' })]);
    await herdr([]);
    expect(status(H)).toBe('ended');
    expect(status(`claude:${P_NATIVE}`)).toBe('working');
    await paseo.snapshot([]);
    expect(status(`claude:${P_NATIVE}`)).toBe('ended');
  });

  test('a partial Paseo snapshot (failed page, filter change) ends nothing', async () => {
    await paseo.snapshot([agent('agent-p', { native_id: P_NATIVE, native_id_origin: 'runtime' }), agent('agent-q')]);
    await paseo.snapshot([agent('agent-q')], { complete: false });
    expect(status(`claude:${P_NATIVE}`)).toBe('working');
  });

  test('a silent Paseo collector shows its sessions offline while herdr’s heartbeat keeps herdr sessions fresh', async () => {
    await herdr([herdrSession(H)]);
    await paseo.snapshot([agent('agent-p', { native_id: P_NATIVE, native_id_origin: 'runtime' })]);
    for (let t = 0; t < OFFLINE_AFTER_MS + 30_000; t += 30_000) {
      center.advance(30_000);
      await herdr([herdrSession(H)]);
    }
    expect(status(H)).toBe('working');
    expect(status(`claude:${P_NATIVE}`)).toBe('offline');
  });

  test('a disconnected daemon makes Paseo sessions offline at once, though the collector is alive; nothing ends', async () => {
    await herdr([herdrSession(H)]);
    await paseo.snapshot([agent('agent-p', { native_id: P_NATIVE, native_id_origin: 'runtime' })]);
    await paseo.snapshot([], { daemon: { status: 'disconnected', error: 'ECONNREFUSED', server_id: null }, complete: false });
    expect(status(`claude:${P_NATIVE}`)).toBe('offline');
    expect(status(H)).toBe('working');
    expect(sessionRow(center.db, `claude:${P_NATIVE}`)!.lifecycle).toBe('live');
    // Even a "complete" empty list sent while disconnected must not end anything.
    await paseo.snapshot([], { daemon: { status: 'disconnected', error: null, server_id: null }, complete: true });
    expect(sessionRow(center.db, `claude:${P_NATIVE}`)!.lifecycle).toBe('live');
    await paseo.snapshot([agent('agent-p', { native_id: P_NATIVE, native_id_origin: 'runtime' })]);
    expect(status(`claude:${P_NATIVE}`)).toBe('working');
  });

  test('a silent herdr collector is not hidden by the Paseo heartbeat', async () => {
    await herdr([herdrSession(H)]);
    for (let t = 0; t < OFFLINE_AFTER_MS + 30_000; t += 30_000) {
      center.advance(30_000);
      await paseo.snapshot([agent('agent-p', { native_id: P_NATIVE, native_id_origin: 'runtime' })]);
    }
    expect(status(H)).toBe('offline');
    expect(status(`claude:${P_NATIVE}`)).toBe('working');
  });

  test('the scheduler rule and the change feed agree with /sessions', async () => {
    await herdr([herdrSession(H)]);
    await paseo.snapshot([agent('agent-p', { native_id: P_NATIVE, native_id_origin: 'runtime', status: 'idle', raw_status: 'idle' })]);
    const before = readFeedState(center.db, center.now, disabledStatus());
    expect(sessionEffectiveStatus(center.db, `claude:${P_NATIVE}`, center.now)).toBe('idle');
    await paseo.snapshot([], { daemon: { status: 'disconnected', error: null, server_id: null }, complete: false });
    expect(sessionEffectiveStatus(center.db, `claude:${P_NATIVE}`, center.now)).toBe('offline');
    expect(readFeedState(center.db, center.now, disabledStatus()).sessions).not.toBe(before.sessions);
    for (const v of listSessions(center.db, {}, center.now)) expect(sessionEffectiveStatus(center.db, v.key, center.now)).toBe(v.effective_status);
  });
});

describe('one provider session seen by both sources', () => {
  const key = `claude:${SHARED}`;

  test('is one logical session with two sources; it ends only when both ended', async () => {
    await herdr([herdrSession(key, { live_status: 'idle' })]);
    await paseo.snapshot([agent('agent-s', { native_id: SHARED, native_id_origin: 'runtime', status: 'working' })]);
    const view = getSession(center.db, key, center.now)!;
    expect(view.sources.map((s) => s.source_id).sort()).toEqual([`herdr:${MACHINE}`, PASEO_SOURCE]);
    expect(view.effective_status).toBe('working'); // working beats idle
    await herdr([]);
    expect(status(key)).toBe('working');
    // The location follows the source that still has it live: no stale herdr pane.
    expect(getSession(center.db, key, center.now)).toMatchObject({ pane_id: null, terminal_id: null, workspace_id: 'ws_1' });
    await paseo.snapshot([agent('agent-s', { native_id: SHARED, native_id_origin: 'runtime', lifecycle: 'archived' })]);
    expect(status(key)).toBe('ended');
  });

  test('a stale observation does not override a fresh one', async () => {
    await herdr([herdrSession(key, { live_status: 'working' })]);
    await paseo.snapshot([agent('agent-s', { native_id: SHARED, native_id_origin: 'runtime', status: 'idle', raw_status: 'idle' })]);
    for (let t = 0; t < OFFLINE_AFTER_MS + 30_000; t += 30_000) {
      center.advance(30_000);
      await paseo.snapshot([agent('agent-s', { native_id: SHARED, native_id_origin: 'runtime', status: 'idle', raw_status: 'idle' })]);
    }
    // herdr went silent while it said "working"; only Paseo's fresh "idle" counts.
    expect(status(key)).toBe('idle');
  });

  test('a pending permission shows blocked; the raw status stays on the source', async () => {
    await paseo.snapshot([agent('agent-s', { native_id: SHARED, native_id_origin: 'runtime', status: 'blocked', raw_status: 'running', attention: 'permission' })]);
    const view = getSession(center.db, key, center.now)!;
    expect(view.effective_status).toBe('blocked');
    expect(view.sources[0]).toMatchObject({ raw_status: 'running', attention: 'permission' });
  });

  test('herdr content owns an existing session; Paseo content is standby and not analysed twice', async () => {
    await herdr([herdrSession(key)]);
    await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, herdrChunks(key, 0, 500));
    await paseo.snapshot([agent('agent-s', { native_id: SHARED, native_id_origin: 'runtime' })]);
    const ack = await paseo.batch(paseo.batchBody('agent-s', null, { epoch: 'epoch-1', seq: 3 }, [event('msg:1', 1), event('msg:2', 2)]));
    expect(ack.status).toBe(200);
    expect(ack.json).toMatchObject({ standby: 2, materialized: 0, session_key: key });
    expect(count(center.db, 'SELECT count(*) AS n FROM chunks WHERE session_key = ? AND digested = 0', key)).toBe(1);
    expect(count(center.db, "SELECT count(*) AS n FROM source_events WHERE disposition = 'standby'")).toBe(2);
    const view = getSession(center.db, key, center.now)!;
    expect(view.content_owner).toBe(`herdr:${MACHINE}`);
    expect(view.sources.find((s) => s.source_id === PASEO_SOURCE)!.content_role).toBe('standby');
  });

  test('Paseo content owns a new session; herdr content is standby but its byte checkpoint still advances', async () => {
    await paseo.snapshot([agent('agent-s', { native_id: SHARED, native_id_origin: 'runtime' })]);
    await paseo.batch(paseo.batchBody('agent-s', null, { epoch: 'epoch-1', seq: 2 }, [event('msg:1', 1)]));
    await herdr([herdrSession(key)]);
    const pushed = await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, herdrChunks(key, 0, 4096));
    expect(pushed.json).toEqual({ inserted: 1, duplicates: 0 });
    // Nothing new to analyse from herdr, but herdr is never asked for those bytes again.
    expect(count(center.db, 'SELECT count(*) AS n FROM chunks WHERE session_key = ? AND source_id = ?', key, `herdr:${MACHINE}`)).toBe(0);
    const offset = await call(center, 'GET', `/ingest/offset?machine=${MACHINE}&session_key=${encodeURIComponent(key)}`, HERDR_TOKEN);
    expect(offset.json).toEqual({ session_key: key, max_offset_end: 4096 });
    // Re-pushing the same window is a duplicate, not new evidence.
    expect((await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, herdrChunks(key, 0, 4096))).json).toEqual({ inserted: 0, duplicates: 1 });
  });
});

describe('identities', () => {
  test('the same native id on another machine is kept apart, with a note', async () => {
    const key = `claude:${SHARED}`;
    await call(center, 'POST', '/ingest/snapshot', 'herdr-gx10-token', herdrSnapshot([herdrSession(key)], 'gx10-090e'));
    await paseo.snapshot([agent('agent-s', { native_id: SHARED, native_id_origin: 'runtime' })]);
    const own = `claude:${SHARED}@${MACHINE}`;
    expect(getSession(center.db, own, center.now)!.sources[0]).toMatchObject({ source_id: PASEO_SOURCE, identity_note: expect.stringContaining('cross_machine') });
    expect(getSession(center.db, key, center.now)!.sources.map((s) => s.source_id)).toEqual(['herdr:gx10-090e']);
  });

  test('pending → native moves chunks, digests, links, questions, ignore and source rows; old refs still resolve', async () => {
    const db = center.db;
    await paseo.snapshot([agent('agent-n')]);
    const pending = `paseo-pending:${SERVER_ID}:agent-n`;
    expect(sessionRow(db, pending)).toBeDefined();
    await paseo.batch(paseo.batchBody('agent-n', null, { epoch: 'epoch-1', seq: 2 }, [event('msg:1', 1)]));
    const chunk = db.prepare('SELECT id FROM chunks WHERE session_key = ?').get(pending) as { id: number };
    db.prepare(`INSERT INTO digests (session_key, chunk_ids, json, created_at) VALUES (?, ?, '{}', 'x')`).run(pending, JSON.stringify([chunk.id]));
    db.prepare(`INSERT INTO projects (id, title, stage, created_at) VALUES ('p1', 'Proj', 'building', 'x')`).run();
    db.prepare(`INSERT INTO contributions (id, session_key, project_id, created_at) VALUES ('c1', ?, 'p1', 'x')`).run(pending);
    db.prepare(`INSERT INTO questions (id, kind, session_key, status, created_at) VALUES ('q1', 'link', ?, 'pending', 'x')`).run(pending);
    db.prepare('UPDATE sessions SET ignored = 1 WHERE key = ?').run(pending);

    await paseo.snapshot([agent('agent-n', { native_id: P_NATIVE, native_id_origin: 'runtime' })]);
    const native = `claude:${P_NATIVE}`;
    for (const [table, col] of [['chunks', 'session_key'], ['digests', 'session_key'], ['contributions', 'session_key'], ['questions', 'session_key'], ['session_sources', 'session_key'], ['source_events', 'session_key']]) {
      expect(count(db, `SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`, pending)).toBe(0);
      expect(count(db, `SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`, native)).toBeGreaterThan(0);
    }
    expect(sessionRow(db, native)).toMatchObject({ ignored: 1, content_owner: PASEO_SOURCE });
    expect(sessionRow(db, pending)).toMatchObject({ merged_into: native, lifecycle: 'ended' });
    expect(getSession(db, pending, center.now)!.key).toBe(native);
    expect(getEvidence(db, center.now, `chunk:${chunk.id}`)!.session!.key).toBe(native);
    // Content keeps flowing under the native key from the same checkpoint.
    const next = await paseo.batch(paseo.batchBody('agent-n', { epoch: 'epoch-1', seq: 2 }, { epoch: 'epoch-1', seq: 3 }, [event('msg:2', 3)]));
    expect(next.json).toMatchObject({ session_key: native, materialized: 1 });
  });

  test('an identity that appears late on a session herdr already analysed does not replay Paseo content', async () => {
    const native = `claude:${SHARED}`;
    await herdr([herdrSession(native)]);
    await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, herdrChunks(native, 0, 500));
    await paseo.snapshot([agent('agent-l')]);
    await paseo.batch(paseo.batchBody('agent-l', null, { epoch: 'epoch-1', seq: 2 }, [event('msg:1', 1), event('msg:2', 2)]));
    await paseo.snapshot([agent('agent-l', { native_id: SHARED, native_id_origin: 'persistence' })]);
    expect(count(center.db, 'SELECT count(*) AS n FROM chunks WHERE session_key = ? AND digested = 0', native)).toBe(1);
    expect(count(center.db, 'SELECT count(*) AS n FROM chunks WHERE session_key = ? AND source_id = ?', native, PASEO_SOURCE)).toBe(1);
    expect(getSession(center.db, native, center.now)!.sources.find((s) => s.source_id === PASEO_SOURCE)!.identity_note).toMatch(/late_identity_overlap/);
  });
});

describe('legacy compatibility', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-pm-mig-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a v4 database upgrades in place: ids, references, offsets and status survive', async () => {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    for (let v = 0; v < 4; v++) old.exec(MIGRATIONS[v]!);
    old.exec('PRAGMA user_version = 4');
    const t = '2026-11-06T09:59:00.000Z';
    old.prepare('INSERT INTO machines VALUES (?, ?, ?)').run(MACHINE, t, '0.1.0');
    old.prepare(
      `INSERT INTO sessions (key, agent_kind, native_id, machine, pane_id, terminal_id, workspace_id, tab_id, cwd, title, live_status, lifecycle, fidelity, transcript_path, ignored, first_seen, last_seen)
       VALUES (?, 'claude', ?, ?, 'w1:1:1', 'term_1', 'w1', 'w1:1', '/p', 'T', 'idle', 'live', 'full', '/x.jsonl', 0, ?, ?)`,
    ).run(H, H.slice(7), MACHINE, t, t);
    old.prepare(`INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, digested, received_at) VALUES (?, 'transcript', 0, 777, ?, ?, 'old', 0, 1, ?)`).run(H, t, t, t);
    old.prepare(`INSERT INTO digests (session_key, chunk_ids, json, created_at) VALUES (?, '[1]', '{}', ?)`).run(H, t);
    old.close();

    const db = openDb(path);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT id, session_key FROM chunks').all()).toEqual([{ id: 1, session_key: H }]);
      expect(db.prepare('SELECT id, session_key FROM digests').all()).toEqual([{ id: 1, session_key: H }]);
      expect(sessionRow(db, H)).toMatchObject({ content_owner: `herdr:${MACHINE}`, lifecycle: 'live' });
      expect(maxOffset(db, H, `herdr:${MACHINE}`)).toBe(777);
      expect(maxOffset(db, H)).toBe(777);
      const view = listSessions(db, {}, new Date(Date.parse(t) + 1000))[0]!;
      expect(view).toMatchObject({ key: H, effective_status: 'idle' });
      expect(view.sources).toEqual([expect.objectContaining({ source_id: `herdr:${MACHINE}`, kind: 'herdr', content_role: 'owner' })]);
      expect(getEvidence(db, new Date(), 'digest:1')!.chunks[0]!.id).toBe(1);
      // The old collector protocol keeps working against the upgraded database.
      applySnapshot(db, herdrSnapshot([herdrSession(H, { live_status: 'working' })]), new Date(Date.parse(t) + 5000));
      insertChunks(db, herdrChunks(H, 777, 900), new Date(Date.parse(t) + 5000));
      expect(maxOffset(db, H, `herdr:${MACHINE}`)).toBe(900);
    } finally {
      db.close();
    }
  });

  test('tokens are scoped: a herdr token gets nothing on v2, a Paseo token nothing on v1, nor another source', async () => {
    expect((await call(center, 'POST', '/ingest/v2/lease', HERDR_TOKEN, { source_id: PASEO_SOURCE })).status).toBe(401);
    expect((await call(center, 'POST', '/ingest/snapshot', paseo.token, herdrSnapshot([])) ).status).toBe(401);
    const other = await call(center, 'POST', '/ingest/v2/lease', OTHER_TOKEN, { source_id: PASEO_SOURCE, instance_id: 'instance-x-0001', server_id: SERVER_ID, collector_version: '1' });
    expect(other.status).toBe(403);
    // A Paseo pending key can never be pushed through the herdr protocol.
    const forged = await call(center, 'POST', '/ingest/snapshot', HERDR_TOKEN, herdrSnapshot([herdrSession(`paseo-pending:${SERVER_ID}:agent-x`)]));
    expect(forged.status).toBe(400);
    expect(OTHER_SOURCE).not.toBe(PASEO_SOURCE);
  });
});

describe('content handover', () => {
  const key = `claude:${SHARED}`;
  const ts = (min: number) => new Date(Date.parse('2026-11-06T09:00:00.000Z') + min * 60_000).toISOString();

  test('herdr owned it and ended; Paseo still sees it live: Paseo takes over after what herdr covered, nothing analysed twice', async () => {
    await herdr([herdrSession(key)]);
    const chunk = herdrChunks(key, 0, 900, '[2026-11-06T09:05Z] user: from herdr');
    chunk.chunks[0]!.ts_end = ts(5);
    await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, chunk);
    await paseo.snapshot([agent('agent-h', { native_id: SHARED, native_id_origin: 'runtime' })]);
    // Paseo's history: two rows herdr already covered, one after it. All standby while herdr owns the session.
    const r = await paseo.batch(
      paseo.batchBody('agent-h', null, { epoch: 'epoch-1', seq: 3 }, [event('msg:1', 1, { ts: ts(1) }), event('msg:2', 2, { ts: ts(5) }), event('msg:3', 3, { ts: ts(9), text: 'continued in Paseo' })]),
    );
    expect(r.json).toMatchObject({ standby: 3, materialized: 0 });
    // A short silence of herdr changes nothing.
    center.advance(OFFLINE_AFTER_MS + 1000);
    await paseo.snapshot([agent('agent-h', { native_id: SHARED, native_id_origin: 'runtime' })]);
    expect(sessionRow(center.db, key)!.content_owner).toBe(`herdr:${MACHINE}`);
    // herdr closes the pane (its observation ends): Paseo takes over from 09:05.
    await herdr([]);
    expect(sessionRow(center.db, key)!.content_owner).toBe(PASEO_SOURCE);
    const queued = center.db.prepare('SELECT source_id, text FROM chunks WHERE session_key = ? AND digested = 0 ORDER BY id').all(key) as Array<{ source_id: string; text: string }>;
    expect(queued.map((q) => q.source_id)).toEqual([`herdr:${MACHINE}`, PASEO_SOURCE]);
    expect(queued[1]!.text).toContain('continued in Paseo');
    expect(queued[1]!.text).not.toContain('msg:1');
    expect(center.db.prepare('SELECT from_source, to_source, boundary_ts FROM content_handovers').all()).toEqual([
      { from_source: `herdr:${MACHINE}`, to_source: PASEO_SOURCE, boundary_ts: ts(5) },
    ]);
    // New rows flow; a late row from before the boundary does not.
    const next = await paseo.batch(paseo.batchBody('agent-h', { epoch: 'epoch-1', seq: 3 }, { epoch: 'epoch-1', seq: 5 }, [event('msg:4', 4, { ts: ts(10) }), event('row:epoch-1:5:error', 5, { ts: ts(2), kind: 'error', item_type: 'error', stable_id: false })]));
    expect(next.json).toMatchObject({ materialized: 1, standby: 1 });
    expect(getSession(center.db, key, center.now)!.sources.find((s) => s.source_id === PASEO_SOURCE)!.identity_note).toMatch(/content_handover/);
  });

  test('Paseo owned it and archived it; herdr still sees it live: herdr takes over after the boundary', async () => {
    await paseo.snapshot([agent('agent-r', { native_id: SHARED, native_id_origin: 'runtime' })]);
    await paseo.batch(paseo.batchBody('agent-r', null, { epoch: 'epoch-1', seq: 1 }, [event('msg:1', 1, { ts: ts(3) })]));
    await herdr([herdrSession(key)]);
    const early = herdrChunks(key, 0, 500, 'herdr early');
    early.chunks[0]!.ts_end = ts(2);
    const late = herdrChunks(key, 500, 900, 'herdr late');
    late.chunks[0]!.ts_end = ts(8);
    await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, early);
    await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, late);
    expect(count(center.db, "SELECT count(*) AS n FROM source_events WHERE source_id = ? AND disposition = 'standby'", `herdr:${MACHINE}`)).toBe(2);
    await paseo.snapshot([agent('agent-r', { native_id: SHARED, native_id_origin: 'runtime', lifecycle: 'archived' })]);
    expect(sessionRow(center.db, key)!.content_owner).toBe(`herdr:${MACHINE}`);
    const texts = (center.db.prepare('SELECT text FROM chunks WHERE session_key = ? ORDER BY id').all(key) as Array<{ text: string }>).map((t) => t.text);
    expect(texts.some((t) => t.includes('herdr late'))).toBe(true);
    expect(texts.some((t) => t.includes('herdr early'))).toBe(false);
    // The byte checkpoint never depended on any of this.
    expect((await call(center, 'GET', `/ingest/offset?machine=${MACHINE}&session_key=${encodeURIComponent(key)}`, HERDR_TOKEN)).json.max_offset_end).toBe(900);
  });
});
