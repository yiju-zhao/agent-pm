import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MIN_DIGEST_CHARS } from '../../src/understand/digest.ts';
import type { LlmCall, LlmResult, LlmRunner } from '../../src/understand/llm.ts';
import {
  BACKOFF_START_MS,
  CURATE_BATCH,
  CURATE_DELAY_MS,
  DEBOUNCE_MS,
  disabledStatus,
  FALLBACK_MS,
  Scheduler,
  SESSION_COOLDOWN_MS,
  STATUS_CACHE_MS,
  TICK_MS,
} from '../../src/understand/scheduler.ts';
import { openDb } from '../../src/server/db.ts';
import { NOW, setup } from '../domain/helpers.ts';
import type { Setup } from '../domain/helpers.ts';

const MODELS = { digest: 'claude-haiku-5-5', curate: 'claude-sonnet-5-5' };
const A = 'claude:aaaa1111aaaa1111';
const B = 'codex:bbbb2222bbbb2222';
const BIG = 'x'.repeat(MIN_DIGEST_CHARS + 100);

let t: Setup;
let clock: number;
let nextOffset: number;

beforeEach(() => {
  t = setup();
  clock = Date.parse(NOW);
  nextOffset = 0;
  t.db.prepare('INSERT INTO machines (label, last_heartbeat, collector_version) VALUES (?, ?, ?)').run('laptop', NOW, '0.1.0');
});

afterEach(() => {
  vi.restoreAllMocks();
  t.db.close();
});

// ---- fixtures ----------------------------------------------------------------------------------------------------

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Moves the clock forward; the machine keeps reporting, so its sessions do not go offline. */
function advance(ms: number): void {
  clock += ms;
  t.setNow(iso(clock));
  t.db.prepare('UPDATE machines SET last_heartbeat = ?').run(iso(clock));
}

type SessionOpts = { live_status?: string; lifecycle?: string; status_changed_at?: string | null; ignored?: number };

function addSession(key: string, opts: SessionOpts = {}): void {
  t.db
    .prepare(
      `INSERT INTO sessions (key, agent_kind, machine, terminal_id, cwd, title, lifecycle, live_status, ignored, first_seen, last_seen, status_changed_at)
       VALUES (?, 'claude', 'laptop', 'term_1', '/work', 'task', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      opts.lifecycle ?? 'live',
      opts.live_status ?? 'idle',
      opts.ignored ?? 0,
      NOW,
      NOW,
      opts.status_changed_at === undefined ? iso(clock - 3_600_000) : opts.status_changed_at,
    );
}

function addChunk(
  key: string,
  text: string,
  opts: { backfill?: number; receivedAt?: string; digested?: number; kind?: string } = {},
): number {
  nextOffset += 1;
  const ts = iso(Date.parse('2026-10-29T08:00:00.000Z') + nextOffset * 60_000);
  const info = t.db
    .prepare(
      `INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, digested, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(key, opts.kind ?? 'transcript', nextOffset * 1000, nextOffset * 1000 + text.length, ts, ts, text, opts.backfill ?? 0, opts.digested ?? 0, opts.receivedAt ?? iso(clock));
  return Number(info.lastInsertRowid);
}

function digestJson(trivial: boolean): string {
  return JSON.stringify({
    topics: trivial ? [] : [{ label: '调度器', summary: '写调度器', likely_project_ids: [], is_new_topic: false, confidence: 0.8 }],
    decisions: [],
    progress: [],
    todos_added: [],
    todos_done: [],
    blockers: [],
    open_questions: [],
    trivial,
  });
}

/** An uncurated digest row, as the digester leaves one. */
function addDigest(createdAt = iso(clock), key = A): number {
  const info = t.db
    .prepare(
      `INSERT INTO digests (session_key, chunk_ids, json, model, ts_start, ts_end, backfill, trivial, skipped, curated, created_at)
       VALUES (?, '[]', ?, 'claude-haiku-5-5', ?, ?, 0, 0, 0, 0, ?)`,
    )
    .run(key, digestJson(false), createdAt, createdAt, createdAt);
  return Number(info.lastInsertRowid);
}

function ok(structured: unknown = JSON.parse(digestJson(true))): LlmResult {
  return {
    ok: true,
    text: '',
    structured,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 },
    costUsd: 0,
    durationMs: 1,
  };
}

function fail(kind: 'rate_limit' | 'overloaded' | 'auth' | 'bad_output' | 'other', message = 'boom'): LlmResult {
  return { ok: false, kind, message, durationMs: 1 };
}

/** A runner that answers with `answer(call)` (by default: a trivial digest, or a plain success for the curator). */
function fakeRunner(answer: (call: LlmCall) => LlmResult = (call) => (call.role === 'digest' ? ok() : ok(null))) {
  const calls: LlmCall[] = [];
  const runner: LlmRunner = async (call) => {
    calls.push(call);
    return answer(call);
  };
  return { calls, runner };
}

function scheduler(runner: LlmRunner): Scheduler {
  return new Scheduler(t.db, t.deps, runner, MODELS);
}

function digested(id: number): number {
  return (t.db.prepare('SELECT digested FROM chunks WHERE id = ?').get(id) as { digested: number }).digested;
}

function digestSessions(): string[] {
  return (t.db.prepare('SELECT session_key FROM digests ORDER BY id').all() as Array<{ session_key: string }>).map((r) => r.session_key);
}

function uncurated(): number {
  return (t.db.prepare('SELECT count(*) AS n FROM digests WHERE curated = 0').get() as { n: number }).n;
}

// ---- readiness ---------------------------------------------------------------------------------------------------

test('a session that went idle is digested only after the 2-minute debounce', async () => {
  addSession(A, { live_status: 'idle', status_changed_at: iso(clock - 60_000) });
  const id = addChunk(A, BIG, { receivedAt: iso(clock - 60_000) });
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);

  expect(await s.tick()).toBe('idle');
  advance(DEBOUNCE_MS - 60_000 - 1);
  expect(await s.tick()).toBe('idle');
  expect(calls).toHaveLength(0);

  advance(1);
  expect(await s.tick()).toBe('digested');
  expect(calls).toHaveLength(1);
  expect(calls[0].role).toBe('digest');
  expect(calls[0].model).toBe(MODELS.digest);
  expect(digested(id)).toBe(1);
});

test('a session whose status predates schema v3 counts as settled long ago', async () => {
  addSession(A, { live_status: 'done', status_changed_at: null });
  addChunk(A, BIG);
  const { runner } = fakeRunner();
  expect(await scheduler(runner).tick()).toBe('digested');
});

test('a session still working is digested once its oldest chunk is 30 minutes old', async () => {
  addSession(A, { live_status: 'working' });
  const id = addChunk(A, BIG);
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);

  expect(await s.tick()).toBe('idle');
  advance(FALLBACK_MS - 1);
  addChunk(A, BIG); // newer chunks do not restart the clock
  expect(await s.tick()).toBe('idle');
  expect(calls).toHaveLength(0);

  advance(1);
  expect(await s.tick()).toBe('digested');
  expect(digested(id)).toBe(1);
});

test('a working session on a machine that went offline is settled', async () => {
  addSession(A, { live_status: 'working' });
  addChunk(A, BIG);
  // No heartbeat for 10 minutes: the session shows as offline.
  clock += 600_000;
  t.setNow(iso(clock));
  const { runner } = fakeRunner();
  expect(await scheduler(runner).tick()).toBe('digested');
});

test('ignored sessions are never digested', async () => {
  addSession(A, { ignored: 1 });
  addChunk(A, BIG);
  addChunk(A, BIG, { backfill: 1 });
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);
  expect(await s.tick()).toBe('idle');
  expect(calls).toHaveLength(0);
  expect(s.status().waiting_sessions).toBe(0);
});

test('report keys are digested once their oldest chunk is 2 minutes old', async () => {
  const key = 'report:laptop:proj';
  const id = addChunk(key, BIG);
  const { runner } = fakeRunner();
  const s = scheduler(runner);
  expect(await s.tick()).toBe('idle');
  advance(DEBOUNCE_MS);
  expect(await s.tick()).toBe('digested');
  expect(digested(id)).toBe(1);
});

// ---- short reports (R14) -----------------------------------------------------------------------------------------

/** The digest rows, oldest first: whether each was skipped and its session. */
function digestFlags(): Array<{ session_key: string; skipped: number }> {
  return t.db.prepare('SELECT session_key, skipped FROM digests ORDER BY id').all() as Array<{ session_key: string; skipped: number }>;
}

test('a short inbox report goes to the model after the 2-minute debounce, not the 30-minute fallback', async () => {
  const id = addChunk('report:inbox', '换成了 sentencepiece，分数涨了 2 个点', { kind: 'report' });
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);
  advance(DEBOUNCE_MS - 1);
  expect(await s.tick()).toBe('idle');
  advance(1);
  expect(await s.tick()).toBe('digested');
  expect(calls.map((c) => c.role)).toEqual(['digest']);
  expect(digested(id)).toBe(1);
  expect(digestFlags()).toEqual([{ session_key: 'report:inbox', skipped: 0 }]);
});

test('a short inbox report under requestSync goes to the model at once', async () => {
  addChunk('report:inbox', '阻塞在 GPU 配额', { kind: 'report' });
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);
  s.requestSync();
  expect(await s.tick()).toBe('digested');
  expect(calls).toHaveLength(1);
  expect(digestFlags()).toEqual([{ session_key: 'report:inbox', skipped: 0 }]);
});

test('a short report filed under a real session is digested by the model, not skipped or held back', async () => {
  // A live session that has settled: a short transcript window would wait for more; a report does not.
  addSession(A, { live_status: 'idle' });
  addChunk(A, '短上报', { kind: 'report' });
  // An ended session: a short transcript window would be force-skipped; a report is not.
  addSession(B, { lifecycle: 'ended' });
  addChunk(B, '另一条短上报', { kind: 'report' });
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);
  expect(await s.tick()).toBe('digested');
  expect(await s.tick()).toBe('digested');
  expect(calls).toHaveLength(2);
  expect(digestFlags()).toEqual([
    { session_key: A, skipped: 0 },
    { session_key: B, skipped: 0 },
  ]);
});

test('realtime work always goes before backfill', async () => {
  addSession(A);
  addSession(B);
  const old = addChunk(A, BIG, { backfill: 1, receivedAt: iso(clock - 86_400_000) });
  const fresh = addChunk(B, BIG);
  const { runner } = fakeRunner();
  const s = scheduler(runner);

  expect(await s.tick()).toBe('digested');
  expect(digested(fresh)).toBe(1);
  expect(digested(old)).toBe(0);
  expect(await s.tick()).toBe('digested');
  expect(digested(old)).toBe(1);
  expect(digestSessions()).toEqual([B, A]);
  expect(await s.tick()).toBe('idle');
});

test('backfill rotates across sessions', async () => {
  addSession(A);
  addSession(B);
  // Each chunk fills a backfill window of its own, so every session needs two calls.
  const huge = 'y'.repeat(100_000);
  for (let i = 0; i < 2; i++) {
    addChunk(A, huge, { backfill: 1 });
    addChunk(B, huge, { backfill: 1 });
  }
  const { runner } = fakeRunner();
  const s = scheduler(runner);
  for (let i = 0; i < 4; i++) expect(await s.tick()).toBe('digested');
  expect(digestSessions()).toEqual([A, B, A, B]);
  expect(await s.tick()).toBe('idle');
});

test('a tiny backfill window is force-skipped without a model call', async () => {
  addSession(A, { live_status: 'working' });
  const id = addChunk(A, 'short', { backfill: 1 });
  const { calls, runner } = fakeRunner();
  expect(await scheduler(runner).tick()).toBe('skipped');
  expect(calls).toHaveLength(0);
  expect(digested(id)).toBe(1);
});

test('a tiny window waits while the session is live and is force-skipped once it ended', async () => {
  addSession(A, { live_status: 'idle' });
  const id = addChunk(A, 'ok');
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);

  expect(await s.tick()).toBe('idle');
  expect(digested(id)).toBe(0);

  t.db.prepare(`UPDATE sessions SET lifecycle = 'ended', status_changed_at = ? WHERE key = ?`).run(iso(clock), A);
  advance(DEBOUNCE_MS - 1);
  expect(await s.tick()).toBe('idle');
  advance(1);
  expect(await s.tick()).toBe('skipped');
  expect(calls).toHaveLength(0);
  expect(digested(id)).toBe(1);
  expect(t.db.prepare('SELECT skipped FROM digests').get()).toEqual({ skipped: 1 });
});

test('a tiny window on a live session does not block a ready session behind it', async () => {
  addSession(A, { live_status: 'idle' });
  addSession(B, { live_status: 'idle' });
  addChunk(A, 'ok', { receivedAt: iso(clock - 60_000) });
  const id = addChunk(B, BIG);
  const { runner } = fakeRunner();
  expect(await scheduler(runner).tick()).toBe('digested');
  expect(digested(id)).toBe(1);
});

// ---- curation ----------------------------------------------------------------------------------------------------

test('curation runs at 8 uncurated digests or after 5 minutes, whichever first', async () => {
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);

  for (let i = 0; i < CURATE_BATCH - 1; i++) addDigest();
  expect(await s.tick()).toBe('idle');
  addDigest();
  expect(await s.tick()).toBe('curated');
  expect(calls.map((c) => [c.role, c.model])).toEqual([['curate', MODELS.curate]]);
  expect(uncurated()).toBe(0);

  addDigest();
  advance(CURATE_DELAY_MS - 1);
  expect(await s.tick()).toBe('idle');
  advance(1);
  expect(await s.tick()).toBe('curated');
  expect(uncurated()).toBe(0);
  expect(s.status().last_curate_at).toBe(iso(clock));
});

test('curation goes before digesting', async () => {
  addSession(A);
  addChunk(A, BIG);
  for (let i = 0; i < CURATE_BATCH; i++) addDigest();
  const { runner } = fakeRunner();
  const s = scheduler(runner);
  expect(await s.tick()).toBe('curated');
  expect(await s.tick()).toBe('digested');
});

test('three curate failures in a row give up on that batch; digesting continues meanwhile', async () => {
  const ids = Array.from({ length: CURATE_BATCH }, () => addDigest());
  addSession(A);
  const chunk = addChunk(A, BIG);
  const { calls, runner } = fakeRunner((call) => (call.role === 'curate' ? fail('bad_output', 'no tools used') : ok()));
  const s = scheduler(runner);

  expect(await s.tick()).toBe('skipped');
  expect(s.status().last_error).toContain('no tools used');
  // The curate wait does not stop digesting.
  expect(await s.tick()).toBe('digested');
  expect(digested(chunk)).toBe(1);
  expect(await s.tick()).toBe('idle');

  advance(BACKOFF_START_MS);
  expect(await s.tick()).toBe('skipped');
  advance(BACKOFF_START_MS); // the wait doubled
  expect(await s.tick()).toBe('idle');
  advance(BACKOFF_START_MS);
  expect(await s.tick()).toBe('skipped');
  expect(calls.filter((c) => c.role === 'curate')).toHaveLength(3);

  // Given up: marked curated so the queue moves on, and said so.
  const flags = ids.map((id) => (t.db.prepare('SELECT curated FROM digests WHERE id = ?').get(id) as { curated: number }).curated);
  expect(flags).toEqual(ids.map(() => 1));
  expect(s.status().last_error).toMatch(/放弃/);
  expect(await s.tick()).toBe('idle');

  // The counter was reset: a new batch gets three fresh attempts, the first one right away.
  for (let i = 0; i < CURATE_BATCH; i++) addDigest();
  expect(await s.tick()).toBe('skipped');
  expect(uncurated()).toBe(CURATE_BATCH);
});

// ---- failures ----------------------------------------------------------------------------------------------------

test('a curate run that fails after a write landed is not replayed and its error is recorded', async () => {
  const id = addDigest();
  const { calls, runner } = fakeRunner((call) => {
    if (call.role !== 'curate') return ok();
    void call.tools!.find((x) => x.name === 'create_project')!.handler({ title: '半途', reason: 'r', evidence: [`digest:${id}`] });
    return fail('other', 'stream cut');
  });
  const s = scheduler(runner);
  s.requestSync();
  expect(await s.tick()).toBe('curated');
  expect(uncurated()).toBe(0);
  expect(t.db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 });
  expect(s.status().last_error).toContain('stream cut');
  expect(s.status().paused_until).toBeNull();
  expect(await s.tick()).toBe('idle');
  expect(calls).toHaveLength(1);
});

test('a curate run cut off by a rate limit after a write landed is not replayed, and the scheduler still pauses', async () => {
  const id = addDigest();
  const { calls, runner } = fakeRunner((call) => {
    void call.tools!.find((x) => x.name === 'create_project')!.handler({ title: '半途', reason: 'r', evidence: [`digest:${id}`] });
    return fail('rate_limit', '429');
  });
  const s = scheduler(runner);
  s.requestSync();
  expect(await s.tick()).toBe('paused');
  expect(s.status().paused_until).toBe(iso(clock + BACKOFF_START_MS));
  expect(s.status().last_error).toContain('429');
  expect(uncurated()).toBe(0);
  advance(BACKOFF_START_MS);
  expect(await s.tick()).toBe('idle');
  expect(calls).toHaveLength(1);
  expect(t.db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 });
});

test('a rate limit pauses with doubling backoff, keeps chunks undigested, and resumes after the pause', async () => {
  addSession(A);
  const id = addChunk(A, BIG);
  const answers = [fail('rate_limit', '429'), fail('rate_limit', '429'), ok(), fail('overloaded', '529')];
  const { calls, runner } = fakeRunner(() => answers.shift()!);
  const s = scheduler(runner);

  expect(await s.tick()).toBe('paused');
  expect(digested(id)).toBe(0);
  let status = s.status();
  expect(status.paused_until).toBe(iso(clock + BACKOFF_START_MS));
  expect(status.pause_reason).toBe('限流（429），2026-10-29T12:01:00Z 恢复');

  advance(BACKOFF_START_MS - 1);
  expect(await s.tick()).toBe('paused');
  expect(calls).toHaveLength(1);

  advance(1);
  expect(await s.tick()).toBe('paused');
  expect(s.status().paused_until).toBe(iso(clock + 2 * BACKOFF_START_MS));

  advance(2 * BACKOFF_START_MS);
  expect(await s.tick()).toBe('digested');
  expect(digested(id)).toBe(1);
  status = s.status();
  expect(status.paused_until).toBeNull();
  expect(status.pause_reason).toBeNull();
  expect(status.last_digest_at).toBe(iso(clock));

  // The backoff was reset by the success.
  addChunk(A, BIG);
  expect(await s.tick()).toBe('paused');
  expect(s.status().paused_until).toBe(iso(clock + BACKOFF_START_MS));
  expect(s.status().pause_reason).toContain('过载');
});

test('three consecutive failures cool a session down for an hour while other sessions continue', async () => {
  addSession(A);
  addSession(B);
  const bad = addChunk(A, `${BIG} poison`, { receivedAt: iso(clock - 60_000) });
  const good = addChunk(B, BIG);
  const { calls, runner } = fakeRunner((call) => (call.prompt.includes('poison') ? fail('bad_output', 'schema mismatch') : ok()));
  const s = scheduler(runner);

  expect(await s.tick()).toBe('skipped');
  expect(s.status().last_error).toContain('schema mismatch');
  // A session that just failed goes behind healthy ones.
  expect(await s.tick()).toBe('digested');
  expect(digested(good)).toBe(1);
  expect(await s.tick()).toBe('skipped');
  expect(await s.tick()).toBe('skipped');
  expect(calls).toHaveLength(4);

  // Cooled down: not even tried.
  expect(await s.tick()).toBe('idle');
  const fresh = addChunk(B, BIG);
  expect(await s.tick()).toBe('digested');
  expect(digested(fresh)).toBe(1);
  expect(calls).toHaveLength(5);
  expect(digested(bad)).toBe(0);

  advance(SESSION_COOLDOWN_MS);
  expect(await s.tick()).toBe('skipped');
  expect(calls).toHaveLength(6);
});

test('a single chunk that fails every time is skipped after its first cycle past the two-cycle grace', async () => {
  addSession(A);
  const only = addChunk(A, `${BIG} poison`, { receivedAt: iso(clock - 60_000) });
  const { calls, runner } = fakeRunner((call) => (call.prompt.includes('poison') ? fail('other', 'always') : ok()));
  const s = scheduler(runner);
  for (let n = 0; n < 2; n++) {
    for (let i = 0; i < 3; i++) expect(await s.tick()).toBe('skipped');
    advance(SESSION_COOLDOWN_MS);
  }
  expect(digested(only)).toBe(0);
  for (let i = 0; i < 3; i++) expect(await s.tick()).toBe('skipped');
  expect(digested(only)).toBe(1);
  expect(calls).toHaveLength(9);
  expect(s.status().last_error).toContain(`chunk ${only}`);
});

test('a digest window that fails every time shrinks after two cooldowns and its first chunk is finally skipped', async () => {
  addSession(A);
  addSession(B);
  const poison = Array.from({ length: 4 }, () => addChunk(A, `${BIG} poison`, { receivedAt: iso(clock - 60_000) }));
  const { calls, runner } = fakeRunner((call) => (call.prompt.includes('poison') ? fail('other', 'always') : ok()));
  const s = scheduler(runner);
  const chunksPerCall = () => calls.map((c) => c.prompt.split('<chunk id=').length - 1);

  /** One full cycle: three failed calls, then the cooldown. */
  async function cycle(): Promise<void> {
    for (let i = 0; i < 3; i++) expect(await s.tick()).toBe('skipped');
    expect(await s.tick()).toBe('idle');
    advance(SESSION_COOLDOWN_MS);
  }

  await cycle();
  await cycle();
  expect(chunksPerCall()).toEqual([4, 4, 4, 4, 4, 4]);
  // Two cycles on the same first chunk: the cap halves on each further cycle.
  await cycle();
  expect(chunksPerCall().slice(6)).toEqual([2, 2, 2]);
  expect(digested(poison[0])).toBe(0);

  // Down to one chunk; when that exhausts a cycle too, it is stored as skipped and the session moves on.
  for (let i = 0; i < 3; i++) expect(await s.tick()).toBe('skipped');
  expect(chunksPerCall().slice(9)).toEqual([1, 1, 1]);
  expect(digested(poison[0])).toBe(1);
  expect(poison.slice(1).map(digested)).toEqual([0, 0, 0]);
  expect(t.db.prepare('SELECT chunk_ids, skipped, curated, json FROM digests').all()).toEqual([
    { chunk_ids: JSON.stringify([poison[0]]), skipped: 1, curated: 1, json: null },
  ]);
  expect(s.status().last_error).toContain(A);
  expect(s.status().last_error).toContain(`chunk ${poison[0]}`);

  // The rest of the session is tried right away, with the full cap again.
  expect(await s.tick()).toBe('skipped');
  expect(chunksPerCall().at(-1)).toBe(3);

  // Meanwhile other sessions were never held up.
  const good = addChunk(B, BIG);
  expect(await s.tick()).toBe('digested');
  expect(digested(good)).toBe(1);
});

test('a failing window that cannot shrink below the newest screen plus one chunk is skipped as a whole', async () => {
  addSession(A);
  const screen = addChunk(A, `${BIG} poison screen`, { kind: 'screen', receivedAt: iso(clock - 60_000) });
  const t1 = addChunk(A, `${BIG} poison`);
  const t2 = addChunk(A, `${BIG} poison`);
  const { calls, runner } = fakeRunner((call) => (call.prompt.includes('poison') ? fail('other', 'always') : ok()));
  const s = scheduler(runner);
  for (let n = 0; n < 3; n++) {
    for (let i = 0; i < 3; i++) expect(await s.tick()).toBe('skipped');
    advance(SESSION_COOLDOWN_MS);
  }
  // The halved cap cannot be met (the screen and the first chunk always go in), so that window is as small as it gets
  // and the cycle it failed is its last.
  expect(calls.map((c) => c.prompt.split('<chunk id=').length - 1)).toEqual([3, 3, 3, 3, 3, 3, 2, 2, 2]);
  expect([screen, t1, t2].map(digested)).toEqual([1, 1, 0]);
  expect(t.db.prepare('SELECT chunk_ids, skipped FROM digests').all()).toEqual([
    { chunk_ids: JSON.stringify([screen, t1]), skipped: 1 },
  ]);
});

test('a success resets a failing window\'s cycle count', async () => {
  addSession(A);
  const first = addChunk(A, `${BIG} poison`, { receivedAt: iso(clock - 60_000) });
  let healthy = false;
  const { calls, runner } = fakeRunner((call) => (call.prompt.includes('poison') && !healthy ? fail('other', 'flaky') : ok()));
  const s = scheduler(runner);
  for (let n = 0; n < 2; n++) {
    for (let i = 0; i < 3; i++) expect(await s.tick()).toBe('skipped');
    advance(SESSION_COOLDOWN_MS);
  }
  healthy = true;
  expect(await s.tick()).toBe('digested');
  expect(digested(first)).toBe(1);

  // A new failing window starts from scratch: two full cycles at the full cap before anything shrinks or is skipped.
  healthy = false;
  addChunk(A, `${BIG} poison`);
  addChunk(A, `${BIG} poison`);
  for (let n = 0; n < 2; n++) {
    for (let i = 0; i < 3; i++) expect(await s.tick()).toBe('skipped');
    advance(SESSION_COOLDOWN_MS);
  }
  expect(calls.slice(-6).map((c) => c.prompt.split('<chunk id=').length - 1)).toEqual([2, 2, 2, 2, 2, 2]);
  expect(t.db.prepare('SELECT count(*) AS n FROM digests WHERE skipped = 1').get()).toEqual({ n: 0 });
});

test('an exception inside a tick is logged and does not break the next tick', async () => {
  addSession(A);
  addChunk(A, BIG);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let first = true;
  const runner: LlmRunner = async () => {
    if (first) {
      first = false;
      throw new Error('runner exploded');
    }
    return ok();
  };
  const s = scheduler(runner);
  expect(await s.tick()).toBe('skipped');
  expect(errors).toHaveBeenCalled();
  expect(String(errors.mock.calls[0])).toContain('runner exploded');
  expect(s.status().last_error).toContain('runner exploded');
  expect(s.status().running).toBeNull();
  expect(await s.tick()).toBe('digested');
});

test('a session whose digest keeps throwing cools down after three ticks while another session proceeds', async () => {
  addSession(A);
  addSession(B);
  const bad = addChunk(A, `${BIG} poison`, { receivedAt: iso(clock - 60_000) });
  const good = addChunk(B, BIG);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let calls = 0;
  // Breaks the runner's never-throw contract on purpose.
  const runner: LlmRunner = async (call) => {
    calls += 1;
    if (call.prompt.includes('poison')) throw new Error('sdk crashed');
    return ok();
  };
  const s = scheduler(runner);

  expect(await s.tick()).toBe('skipped');
  expect(await s.tick()).toBe('digested');
  expect(digested(good)).toBe(1);
  expect(await s.tick()).toBe('skipped');
  expect(await s.tick()).toBe('skipped');
  expect(s.status().last_error).toMatch(/sdk crashed.*冷却/);
  expect(await s.tick()).toBe('idle');
  expect(calls).toBe(4);
  expect(digested(bad)).toBe(0);
});

test('a curator that keeps throwing is given up on like a failing one, and digesting goes on', async () => {
  for (let i = 0; i < CURATE_BATCH; i++) addDigest();
  addSession(A);
  const chunk = addChunk(A, BIG);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const runner: LlmRunner = async (call) => {
    if (call.role === 'curate') throw new Error('curator crashed');
    return ok();
  };
  const s = scheduler(runner);

  expect(await s.tick()).toBe('skipped');
  expect(await s.tick()).toBe('digested');
  expect(digested(chunk)).toBe(1);
  advance(BACKOFF_START_MS);
  expect(await s.tick()).toBe('skipped');
  advance(2 * BACKOFF_START_MS);
  expect(await s.tick()).toBe('skipped');
  expect(uncurated()).toBe(0);
  expect(s.status().last_error).toMatch(/curator crashed.*放弃/);
});

test('tick still resolves when the thrown value cannot even be turned into a string', async () => {
  addSession(A);
  addChunk(A, BIG);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // String() on an object without a prototype throws a TypeError.
  const runner: LlmRunner = async () => {
    throw Object.create(null);
  };
  const s = scheduler(runner);
  expect(await s.tick()).toBe('skipped');
  expect(s.status().last_error).not.toBeNull();
});

test('tick still resolves when recording a failure fails too', async () => {
  for (let i = 0; i < CURATE_BATCH; i++) addDigest();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let attempts = 0;
  const runner: LlmRunner = async () => {
    attempts += 1;
    // On the third failure the scheduler gives up on the batch with an UPDATE, which then cannot reach the database.
    if (attempts === 3) t.db.close();
    throw new Error('curator crashed');
  };
  const s = scheduler(runner);
  try {
    expect(await s.tick()).toBe('skipped');
    advance(BACKOFF_START_MS);
    expect(await s.tick()).toBe('skipped');
    advance(2 * BACKOFF_START_MS);
    errors.mockClear();
    await expect(s.tick()).resolves.toBe('idle');
    expect(errors).toHaveBeenCalledTimes(2);
    expect(String(errors.mock.calls[1])).toMatch(/not open/);
  } finally {
    if (attempts >= 3) t = { ...t, db: openDb(':memory:') }; // afterEach closes the database
  }
});

// ---- sync and concurrency ----------------------------------------------------------------------------------------

test('requestSync skips the debounce and the curate delay', async () => {
  addSession(A, { live_status: 'working' });
  const tiny = addChunk(A, 'ok');
  addSession(B, { live_status: 'working' });
  const big = addChunk(B, BIG);
  addDigest();
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);
  expect(await s.tick()).toBe('idle');

  s.requestSync();
  expect(await s.tick()).toBe('curated');
  const results = [await s.tick(), await s.tick()].sort();
  expect(results).toEqual(['digested', 'skipped']);
  expect(digested(tiny)).toBe(1);
  expect(digested(big)).toBe(1);
  expect(calls.map((c) => c.role)).toEqual(['curate', 'digest']);

  // Nothing left: the sync ends, and new work waits for the debounce again.
  expect(await s.tick()).toBe('idle');
  addChunk(A, BIG);
  expect(await s.tick()).toBe('idle');
});

test('a sync ends even while a working session keeps adding chunks', async () => {
  addSession(A, { live_status: 'working' });
  const before = addChunk(A, BIG);
  const { runner } = fakeRunner((call) => (call.role === 'digest' ? ok(JSON.parse(digestJson(false))) : ok(null)));
  const s = scheduler(runner);
  s.requestSync();
  const since = addChunk(A, BIG); // lands in the same window as the chunk from before the sync

  expect(await s.tick()).toBe('digested');
  expect([digested(before), digested(since)]).toEqual([1, 1]);
  // The session keeps working while the sync's digest is curated.
  const later = addChunk(A, BIG);
  expect(await s.tick()).toBe('curated');

  // The sync is over: new work from the still-working session follows the normal rules.
  expect(await s.tick()).toBe('idle');
  advance(60_000);
  addChunk(A, BIG);
  expect(await s.tick()).toBe('idle');
  expect(digested(later)).toBe(0);
  advance(FALLBACK_MS);
  expect(await s.tick()).toBe('digested');
  expect(digested(later)).toBe(1);
  // ...and so does curation: the new digest waits for the curate delay.
  expect(await s.tick()).toBe('idle');
  expect(uncurated()).toBe(1);
  advance(CURATE_DELAY_MS);
  expect(await s.tick()).toBe('curated');
});

test('a digest written by the sync is curated right away, then the sync ends', async () => {
  addSession(A, { live_status: 'working' });
  const pending = addChunk(A, BIG);
  const { calls, runner } = fakeRunner((call) => (call.role === 'digest' ? ok(JSON.parse(digestJson(false))) : ok(null)));
  const s = scheduler(runner);
  expect(await s.tick()).toBe('idle');

  s.requestSync();
  expect(await s.tick()).toBe('digested');
  expect(digested(pending)).toBe(1);
  expect(await s.tick()).toBe('curated');
  expect(uncurated()).toBe(0);
  expect(await s.tick()).toBe('idle');
  expect(calls.map((c) => c.role)).toEqual(['digest', 'curate']);

  // Sync cleared: a new digest waits for the curate delay again.
  addDigest();
  expect(await s.tick()).toBe('idle');
});

test('a small chunk arriving after requestSync is not force-skipped', async () => {
  addSession(A, { live_status: 'working' });
  addSession(B, { live_status: 'working' });
  const oldTiny = addChunk(B, 'old');
  const { calls, runner } = fakeRunner();
  const s = scheduler(runner);
  s.requestSync();
  const fresh = addChunk(A, 'just arrived');
  const mixed = addChunk(B, 'new');

  // B's window mixes a chunk from before the sync with a newer one: ready, but too small to force out.
  expect(await s.tick()).toBe('idle');
  expect([digested(fresh), digested(oldTiny), digested(mixed)]).toEqual([0, 0, 0]);
  expect(calls).toHaveLength(0);
  expect(t.db.prepare('SELECT count(*) AS n FROM digests').get()).toEqual({ n: 0 });

  // A second requestSync takes in what arrived since.
  s.requestSync();
  expect([await s.tick(), await s.tick()]).toEqual(['skipped', 'skipped']);
  expect([digested(fresh), digested(oldTiny), digested(mixed)]).toEqual([1, 1, 1]);
});

test('tick never runs two model calls at once', async () => {
  addSession(A);
  addSession(B);
  addChunk(A, BIG);
  addChunk(B, BIG);
  let release!: (r: LlmResult) => void;
  let active = 0;
  let maxActive = 0;
  const runner: LlmRunner = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const result = await new Promise<LlmResult>((resolve) => {
      release = resolve;
    });
    active -= 1;
    return result;
  };
  const s = scheduler(runner);

  const first = s.tick();
  await vi.waitFor(() => expect(active).toBe(1));
  expect(s.status().running).toBe('digest');
  expect(await s.tick()).toBe('busy');
  release(ok());
  expect(await first).toBe('digested');
  expect(s.status().running).toBeNull();
  expect(maxActive).toBe(1);
});

test('start ticks on an interval and stop waits for the tick in flight', async () => {
  vi.useFakeTimers();
  try {
    addSession(A);
    addChunk(A, BIG);
    let release!: (r: LlmResult) => void;
    const calls: LlmCall[] = [];
    const runner: LlmRunner = (call) => {
      calls.push(call);
      return new Promise<LlmResult>((resolve) => {
        release = resolve;
      });
    };
    const s = scheduler(runner);
    s.start();
    await vi.advanceTimersByTimeAsync(TICK_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);

    let stopped = false;
    const stopping = s.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release(ok());
    await stopping;
    expect(stopped).toBe(true);

    // No more ticks after stop.
    addChunk(A, BIG);
    await vi.advanceTimersByTimeAsync(TICK_MS * 3);
    expect(calls).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

// ---- status ------------------------------------------------------------------------------------------------------

test('backfill progress counts sessions with backfill chunks and those fully digested', () => {
  const C = 'claude:cccc3333cccc3333';
  addSession(A);
  addSession(B);
  addSession(C);
  addChunk(A, BIG, { backfill: 1, digested: 1 });
  addChunk(A, BIG, { backfill: 1, digested: 1 });
  addChunk(B, BIG, { backfill: 1, digested: 1 });
  addChunk(B, BIG, { backfill: 1 });
  addChunk(C, BIG);
  addChunk('report:laptop:x', BIG);
  // An ignored session is never digested, so its backfill must not count towards the total.
  const D = 'claude:dddd4444dddd4444';
  addSession(D, { ignored: 1 });
  addChunk(D, BIG, { backfill: 1 });
  addDigest();
  addDigest();

  const { runner } = fakeRunner();
  expect(scheduler(runner).status()).toEqual({
    enabled: true,
    paused_until: null,
    pause_reason: null,
    last_error: null,
    running: null,
    waiting_sessions: 2,
    uncurated_digests: 2,
    backfill: { sessions_total: 2, sessions_done: 1 },
    // Read from the database, so they survive a restart.
    last_digest_at: NOW,
    last_curate_at: null,
  });
});

test('the chunk counts in the status are cached for STATUS_CACHE_MS; the cheap fields stay live', async () => {
  addSession(A);
  addSession(B);
  addChunk(A, BIG, { backfill: 1 });
  const { runner } = fakeRunner(() => fail('rate_limit'));
  const s = scheduler(runner);
  expect(s.status().backfill).toEqual({ sessions_total: 1, sessions_done: 0 });
  expect(s.status().waiting_sessions).toBe(0);

  // New chunks and a new digest arrive; within the TTL the chunk scans are not run again.
  addChunk(B, BIG, { backfill: 1 });
  addChunk(B, BIG);
  advance(STATUS_CACHE_MS - 1);
  addDigest();
  let status = s.status();
  expect(status.backfill).toEqual({ sessions_total: 1, sessions_done: 0 });
  expect(status.waiting_sessions).toBe(0);
  // Not from a chunk scan, so live.
  expect(status.uncurated_digests).toBe(1);
  expect(status.last_digest_at).toBe(iso(clock));

  advance(1);
  status = s.status();
  expect(status.backfill).toEqual({ sessions_total: 2, sessions_done: 0 });
  expect(status.waiting_sessions).toBe(1);
});

test('every tick drops the cached chunk counts, so the status after a tick is fresh', async () => {
  addSession(A);
  addChunk(A, BIG, { backfill: 1 });
  // The machine's sessions are idle well past the debounce; a pausing failure keeps the tick from changing the counts itself.
  const { runner } = fakeRunner(() => fail('rate_limit'));
  const s = scheduler(runner);
  expect(s.status().backfill.sessions_total).toBe(1);
  addSession(B);
  addChunk(B, BIG, { backfill: 1 });
  expect(s.status().backfill.sessions_total).toBe(1);
  await s.tick();
  expect(s.status().backfill.sessions_total).toBe(2);
});

test('the disabled status has every field empty', () => {
  expect(disabledStatus()).toEqual({
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
  });
});
