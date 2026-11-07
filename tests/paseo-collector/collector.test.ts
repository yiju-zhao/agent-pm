import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getSession, listSessions, OFFLINE_AFTER_MS } from '../../src/server/sessions-repo.ts';
import { createCenterClient } from '../../src/paseo-collector/client.ts';
import type { CenterClient } from '../../src/paseo-collector/client.ts';
import { PaseoCollectorConfig } from '../../src/paseo-collector/config.ts';
import { PaseoCollector } from '../../src/paseo-collector/loop.ts';
import { LEASE_TTL_MS } from '../../src/shared/ingest-v2.ts';
import { Outbox } from '../../src/paseo-collector/outbox.ts';
import { StateDir } from '../../src/paseo-collector/state-store.ts';
import { count, MACHINE, PASEO_SOURCE, PASEO_TOKEN, SERVER_ID, startCenter } from '../helpers/center.ts';
import type { Center } from '../helpers/center.ts';
import { FakePaseo } from '../helpers/fake-paseo.ts';

let dir: string;
let center: Center;
let fake: FakePaseo;
let logs: string[];
const running: PaseoCollector[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'paseo-collector-'));
  center = startCenter(join(dir, 'center.db'));
  fake = new FakePaseo();
  logs = [];
});
afterEach(async () => {
  for (const c of running.splice(0)) await c.stop();
  center.close();
  await rm(dir, { recursive: true, force: true });
});

function config(over: Record<string, unknown> = {}) {
  return PaseoCollectorConfig.parse({
    server: 'http://center.test',
    sourceId: PASEO_SOURCE,
    machine: MACHINE,
    tokenFile: '/dev/null',
    paseo: { url: 'ws://daemon.test/ws', serverId: SERVER_ID },
    stateDir: join(dir, 'state'),
    heartbeatMs: 1000,
    reconcileMs: 5000,
    debounceMs: 0,
    pageLimit: 4,
    ...over,
  });
}

function centerClient(wrap?: (c: CenterClient) => CenterClient): CenterClient {
  const base = createCenterClient({ server: 'http://center.test', token: PASEO_TOKEN, fetch: (url, init) => Promise.resolve(center.app.request(url, init)) });
  return wrap ? wrap(base) : base;
}

function collector(o: { wrap?: (c: CenterClient) => CenterClient; cfg?: Record<string, unknown>; sdk?: FakePaseo } = {}): PaseoCollector {
  const cfg = config(o.cfg);
  const state = StateDir.open(cfg.stateDir, { sourceId: cfg.sourceId, serverId: cfg.paseo.serverId, server: cfg.server });
  const c = new PaseoCollector(cfg, { sdk: o.sdk ?? fake, client: centerClient(o.wrap), state, outbox: new Outbox(cfg.stateDir), now: () => center.now, log: (l) => logs.push(l), random: () => 0.5 });
  running.push(c);
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function drain(c: PaseoCollector): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await sleep(5);
    await c.settled();
  }
}
async function cycle(c: PaseoCollector): Promise<void> {
  await c.reconcile();
  await c.heartbeat();
  await drain(c);
}
async function stopped(c: PaseoCollector): Promise<void> {
  await c.stop();
  running.splice(running.indexOf(c), 1);
}

const chunkTexts = (key: string) => (center.db.prepare('SELECT text FROM chunks WHERE session_key = ? ORDER BY id').all(key) as Array<{ text: string }>).map((r) => r.text).join('\n');
const sessionKey = (agentId: string) => `claude:native-${agentId}`;
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

function history(id: string, n: number, prefix = 'msg'): void {
  for (let i = 0; i < n; i++) {
    fake.user(id, `${prefix} user ${i}`, `${prefix}-u${i}`);
    fake.reasoning(id, 'thinking'); // never delivered
    fake.tool(id, { command: `cmd ${prefix} ${i}`, output: `out ${i}`, exitCode: i % 3 === 0 ? 1 : 0 }, `${prefix}-c${i}`);
    fake.assistant(id, `${prefix} answer ${i}`, `${prefix}-a${i}`);
  }
}

describe('discovery and import', () => {
  test('imports current history of every loaded agent, once, and keeps up with new rows', async () => {
    fake.addAgent('a1');
    fake.addAgent('a2', { provider: 'codex' });
    history('a1', 5);
    history('a2', 3);
    const c = collector();
    await c.start();
    await drain(c);
    const t1 = chunkTexts(sessionKey('a1'));
    for (let i = 0; i < 5; i++) {
      expect(occurrences(t1, `msg user ${i}`)).toBe(1);
      expect(occurrences(t1, `msg answer ${i}`)).toBe(1);
      expect(occurrences(t1, `cmd msg ${i}`)).toBe(1);
    }
    expect(t1).not.toContain('thinking');
    expect(t1).toMatch(/cmd msg 0 → 失败\(exit 1\)/);
    expect(chunkTexts('codex:native-a2')).toContain('msg answer 2');
    // Nothing new: another round adds nothing.
    const before = count(center.db, 'SELECT count(*) AS n FROM source_events');
    await cycle(c);
    expect(count(center.db, 'SELECT count(*) AS n FROM source_events')).toBe(before);
    // New rows arrive through the live notification.
    fake.user('a1', 'a new question', 'new-u');
    fake.assistant('a1', 'a new answer', 'new-a');
    await drain(c);
    expect(occurrences(chunkTexts(sessionKey('a1')), 'a new answer')).toBe(1);
    expect(fake.resumedByRead).toEqual([]);
  });

  test('a closed (unloaded) agent is reported but never read; it is read once the user opens it', async () => {
    fake.addAgent('cold', { loaded: false });
    history('cold', 2);
    const c = collector();
    await cycle(c);
    expect(fake.timelineReads).not.toContain('cold');
    expect(getSession(center.db, sessionKey('cold'), center.now)!.sources[0]).toMatchObject({ lifecycle: 'ended', end_reason: 'closed', content_state: 'unloaded' });
    // The user opened it in Paseo: loaded now, read now.
    const a = fake.agents.get('cold')!;
    a.snapshot.status = 'idle';
    a.snapshot.availableModes = [{ id: 'x' }];
    a.snapshot.capabilities = { ...a.snapshot.capabilities, supportsStreaming: true, supportsSessionListing: true };
    await cycle(c);
    expect(chunkTexts(sessionKey('cold'))).toContain('msg answer 1');
    expect(fake.resumedByRead).toEqual([]);
  });

  test('a failing directory page is not a complete snapshot: nothing ends', async () => {
    for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) fake.addAgent(id);
    const c = collector();
    await cycle(c);
    expect(listSessions(center.db, {}, center.now).filter((v) => v.effective_status === 'idle')).toHaveLength(5);
    // Page 2 of the directory now fails; d5 also disappeared, but the scan is incomplete, so it must not end.
    fake.failListPage = 0;
    fake.remove('d5');
    await cycle(c);
    expect(getSession(center.db, sessionKey('d5'), center.now)!.effective_status).toBe('idle');
    // Once the directory reads again, the exact-id lookup says d5 is gone.
    fake.failListPage = null;
    await cycle(c);
    expect(getSession(center.db, sessionKey('d5'), center.now)!.sources[0]).toMatchObject({ lifecycle: 'ended', end_reason: 'deleted' });
  });

  test('a tracked agent that is archived gets its last rows read, then ends', async () => {
    fake.addAgent('arch');
    history('arch', 1);
    const c = collector();
    await cycle(c);
    fake.user('arch', 'last words before archiving', 'last-u');
    fake.disconnect(); // the notification is lost
    fake.reconnect();
    fake.archive('arch');
    await cycle(c);
    await cycle(c);
    expect(chunkTexts(sessionKey('arch'))).toContain('last words before archiving');
    expect(getSession(center.db, sessionKey('arch'), center.now)!.effective_status).toBe('ended');
    expect(fake.resumedByRead).toEqual([]);
  });

  test('status mapping: running is working, a pending permission blocked, error blocked', async () => {
    fake.addAgent('s1', { status: 'running' });
    fake.addAgent('s2');
    fake.addAgent('s3', { status: 'error' });
    fake.setPermissions('s2', 1);
    const c = collector();
    await cycle(c);
    const st = (id: string) => getSession(center.db, sessionKey(id), center.now)!;
    expect(st('s1').effective_status).toBe('working');
    expect(st('s2').effective_status).toBe('blocked');
    expect(st('s2').sources[0]!.attention).toBe('permission:1');
    expect(st('s3').effective_status).toBe('blocked');
    expect(st('s3').sources[0]!.raw_status).toBe('error');
  });
});

describe('settling rows', () => {
  test('the growing last row of a running turn and a running tool are held back, then delivered once', async () => {
    fake.addAgent('r');
    fake.user('r', 'build it', 'r-u');
    fake.setStatus('r', 'running');
    const tool = fake.tool('r', { command: 'make', status: 'running' }, 'r-c');
    const c = collector();
    await cycle(c);
    expect(chunkTexts(sessionKey('r'))).toContain('build it');
    expect(chunkTexts(sessionKey('r'))).not.toContain('make');
    tool.item.status = 'failed';
    tool.item.error = { message: 'make: *** [all] Error 2' };
    const answer = fake.assistant('r', 'it fails because', 'r-a', 3);
    await drain(c);
    expect(chunkTexts(sessionKey('r'))).toMatch(/make → 失败/);
    expect(chunkTexts(sessionKey('r'))).not.toContain('it fails because');
    answer.item.text = 'it fails because the linker is missing';
    fake.setStatus('r', 'idle');
    await drain(c);
    const text = chunkTexts(sessionKey('r'));
    expect(occurrences(text, 'it fails because the linker is missing')).toBe(1);
    expect(occurrences(text, 'make → 失败')).toBe(1);
    expect(occurrences(text, 'build it')).toBe(1);
    // Idle is not "done": nothing in the project layer changed.
    expect(count(center.db, 'SELECT count(*) AS n FROM events')).toBe(0);
  });

  test('projected text that grows after delivery adds only the new part', async () => {
    fake.addAgent('g');
    const row = fake.assistant('g', 'part one.', 'g-a', 2);
    const c = collector();
    await cycle(c);
    row.item.text = 'part one. part two.';
    row.seqEnd += 2;
    fake.agents.get('g')!.nextSeq += 2;
    fake.emitTimeline('g', { kind: 'activity', turnEnded: true });
    await drain(c);
    const text = chunkTexts(sessionKey('g'));
    expect(occurrences(text, 'part one.')).toBe(1);
    expect(text).toMatch(/assistant（续）:  part two\./);
  });

  test('a replaced epoch does not duplicate history; new rows after it flow; the replacement is recorded', async () => {
    fake.addAgent('e');
    history('e', 3);
    const c = collector();
    await cycle(c);
    const before = count(center.db, "SELECT count(*) AS n FROM chunks WHERE digested = 0");
    fake.replaceEpoch('e');
    fake.user('e', 'after the replacement', 'e-new');
    await drain(c);
    expect(occurrences(chunkTexts(sessionKey('e')), 'msg user 0')).toBe(1);
    expect(occurrences(chunkTexts(sessionKey('e')), 'after the replacement')).toBe(1);
    expect(count(center.db, 'SELECT count(*) AS n FROM chunks WHERE digested = 0')).toBe(before + 1);
    expect(getSession(center.db, sessionKey('e'), center.now)!.sources[0]!.gaps).toBeGreaterThan(0);
  });

  test('an upstream gap is recorded, not papered over', async () => {
    fake.addAgent('gap');
    history('gap', 1);
    const c = collector();
    await cycle(c);
    fake.agents.get('gap')!.gapOnce = true;
    fake.user('gap', 'after a gap', 'gap-u');
    await drain(c);
    expect(count(center.db, "SELECT count(*) AS n FROM ingest_gaps WHERE reason = 'upstream_gap'")).toBe(1);
    expect(chunkTexts(sessionKey('gap'))).toContain('after a gap');
  });
});

describe('failures', () => {
  test('center unreachable: batches wait in the outbox and go out once, after a restart', async () => {
    fake.addAgent('o');
    history('o', 2);
    let down = true;
    const c1 = collector({ wrap: (cl) => ({ ...cl, batch: (b) => (down ? Promise.reject(Object.assign(new (require('../../src/paseo-collector/client.ts').RetryableError)('ECONNREFUSED'))) : cl.batch(b)) }) });
    await cycle(c1);
    expect(count(center.db, 'SELECT count(*) AS n FROM chunks')).toBe(0);
    expect(new Outbox(config().stateDir).usage().batches).toBeGreaterThan(0);
    await stopped(c1);
    down = false;
    const c2 = collector();
    await cycle(c2);
    const text = chunkTexts(sessionKey('o'));
    expect(occurrences(text, 'msg answer 0')).toBe(1);
    expect(occurrences(text, 'msg answer 1')).toBe(1);
    expect(new Outbox(config().stateDir).usage().batches).toBe(0);
  });

  test('committed but the ack was lost: the resend returns the same ack and adds nothing', async () => {
    fake.addAgent('l');
    history('l', 2);
    let lose = true;
    const c1 = collector({
      wrap: (cl) => ({
        ...cl,
        batch: async (b) => {
          const ack = await cl.batch(b);
          if (lose) throw new (await import('../../src/paseo-collector/client.ts')).RetryableError('socket hang up after commit');
          return ack;
        },
      }),
    });
    await cycle(c1);
    const committed = count(center.db, 'SELECT count(*) AS n FROM source_events');
    expect(committed).toBeGreaterThan(0);
    await stopped(c1); // "crash": the batch is still in the outbox
    lose = false;
    const c2 = collector();
    await cycle(c2);
    const text = chunkTexts(sessionKey('l'));
    expect(occurrences(text, 'msg answer 0')).toBe(1);
    expect(occurrences(text, 'msg answer 1')).toBe(1);
    expect(count(center.db, 'SELECT count(*) AS n FROM ingest_batches')).toBeGreaterThan(0);
  });

  test('local state lost: the collector resumes from the center position without duplicates', async () => {
    fake.addAgent('s');
    history('s', 2);
    const c1 = collector();
    await cycle(c1);
    await stopped(c1);
    await rm(join(dir, 'state'), { recursive: true, force: true });
    fake.user('s', 'while the collector was gone', 's-new');
    const c2 = collector();
    // A new instance (its identity was lost with the directory) waits until the old instance's lease expires.
    await cycle(c2);
    expect(logs.join('\n')).toMatch(/lease_held/);
    center.advance(LEASE_TTL_MS + 1);
    await cycle(c2);
    const text = chunkTexts(sessionKey('s'));
    expect(occurrences(text, 'msg user 0')).toBe(1);
    expect(occurrences(text, 'while the collector was gone')).toBe(1);
  });

  test('center restored from an older backup: what it lost is read again, once', async () => {
    fake.addAgent('b');
    history('b', 1);
    const c = collector();
    await cycle(c);
    const backup = join(dir, 'backup.db');
    center.db.exec(`VACUUM INTO '${backup}'`);
    fake.user('b', 'lost by the restore', 'b-lost');
    fake.assistant('b', 'also lost', 'b-lost-a');
    await drain(c);
    expect(chunkTexts(sessionKey('b'))).toContain('lost by the restore');
    // Restore: a new center process on the backup file. The collector still believes in the newer position.
    center.close();
    center = startCenter(backup, center.now);
    expect(chunkTexts(sessionKey('b'))).not.toContain('lost by the restore');
    fake.user('b', 'after the restore', 'b-after');
    await cycle(c);
    const text = chunkTexts(sessionKey('b'));
    expect(occurrences(text, 'lost by the restore')).toBe(1);
    expect(occurrences(text, 'also lost')).toBe(1);
    expect(occurrences(text, 'after the restore')).toBe(1);
    expect(occurrences(text, 'msg user 0')).toBe(1);
  });

  test('one agent failing does not hold back other agents or the heartbeat', async () => {
    fake.addAgent('bad');
    fake.addAgent('good');
    history('bad', 1);
    history('good', 1);
    fake.failTimeline.add('bad');
    const c = collector();
    await cycle(c);
    await c.heartbeat();
    expect(chunkTexts(sessionKey('good'))).toContain('msg answer 0');
    expect(getSession(center.db, sessionKey('bad'), center.now)!.sources[0]!.content_state).toBe('error');
    expect(getSession(center.db, sessionKey('bad'), center.now)!.effective_status).toBe('idle');
    expect(logs.join('\n')).not.toMatch(/msg (user|answer)/); // no conversation text in logs
  });

  test('a disconnect only marks the source offline; rows written meanwhile are caught up after reconnect', async () => {
    fake.addAgent('dc');
    history('dc', 1);
    const c = collector();
    await cycle(c);
    fake.disconnect();
    await c.heartbeat();
    expect(getSession(center.db, sessionKey('dc'), center.now)).toMatchObject({ lifecycle: 'live', effective_status: 'offline' });
    // While disconnected the agent goes on; its notifications are lost.
    fake.status = 'connected';
    fake.user('dc', 'during the disconnect', 'dc-u');
    fake.status = 'disconnected';
    fake.reconnect();
    await c.heartbeat();
    await drain(c);
    expect(chunkTexts(sessionKey('dc'))).toContain('during the disconnect');
    expect(getSession(center.db, sessionKey('dc'), center.now)!.effective_status).toBe('idle');
  });

  test('a collector that goes silent shows offline after the threshold; nothing ends', async () => {
    fake.addAgent('q');
    const c = collector();
    await cycle(c);
    await stopped(c);
    center.advance(OFFLINE_AFTER_MS + 1000);
    expect(getSession(center.db, sessionKey('q'), center.now)).toMatchObject({ lifecycle: 'live', effective_status: 'offline' });
  });

  test('a daemon with another server id is not read and nothing is written for it', async () => {
    fake.serverIdValue = 'srv_impostor';
    fake.addAgent('x');
    history('x', 1);
    const c = collector();
    await c.start();
    await drain(c);
    expect(fake.timelineReads).toEqual([]);
    expect(count(center.db, 'SELECT count(*) AS n FROM session_sources')).toBe(0);
    expect((center.db.prepare('SELECT daemon_status FROM ingest_sources WHERE source_id = ?').get(PASEO_SOURCE) as { daemon_status: string }).daemon_status).toBe('identity_mismatch');
  });
});

describe('process', () => {
  test('a restart on the same state directory keeps the lease and continues its snapshot revisions', async () => {
    fake.addAgent('re');
    const c1 = collector();
    await c1.start();
    for (let i = 0; i < 5; i++) await c1.heartbeat();
    await stopped(c1);
    const c2 = collector();
    await c2.start();
    await c2.heartbeat();
    expect(logs.join('\n')).not.toMatch(/stale_snapshot|lease_held/);
    const row = center.db.prepare('SELECT lease_epoch, snapshot_rev FROM ingest_sources WHERE source_id = ?').get(PASEO_SOURCE) as { lease_epoch: number; snapshot_rev: number };
    expect(row.lease_epoch).toBe(1);
    expect(row.snapshot_rev).toBeGreaterThan(6);
  });

  test('one state directory, one process; a second instance elsewhere cannot take the source', async () => {
    fake.addAgent('p');
    const c1 = collector();
    await c1.start();
    expect(() => collector()).toThrow(/in use/);
    const c2 = collector({ cfg: { stateDir: join(dir, 'state-2') } });
    await c2.start();
    expect(logs.join('\n')).toMatch(/lease_held/);
  });

  test('stopping releases subscriptions and the daemon connection and leaves agents as they were', async () => {
    fake.addAgent('k', { status: 'running' });
    const before = structuredClone(fake.agents.get('k')!.snapshot);
    const c = collector();
    await c.start();
    await drain(c);
    await stopped(c);
    expect(fake.closed).toBe(true);
    expect(fake.agents.get('k')!.snapshot).toEqual(before);
    // The state directory is free again.
    const again = collector();
    await again.start();
  });
});
