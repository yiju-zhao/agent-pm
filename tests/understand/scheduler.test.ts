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
  TICK_MS,
} from '../../src/understand/scheduler.ts';
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

function addChunk(key: string, text: string, opts: { backfill?: number; receivedAt?: string; digested?: number } = {}): number {
  nextOffset += 1;
  const ts = iso(Date.parse('2026-10-29T08:00:00.000Z') + nextOffset * 60_000);
  const info = t.db
    .prepare(
      `INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, digested, received_at)
       VALUES (?, 'transcript', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(key, nextOffset * 1000, nextOffset * 1000 + text.length, ts, ts, text, opts.backfill ?? 0, opts.digested ?? 0, opts.receivedAt ?? iso(clock));
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
  // The digest written during the sync is newer than the sync, so the curate delay applies to it.
  expect(await s.tick()).toBe('idle');

  // New work from the still-working session follows the normal rules.
  const later = addChunk(A, BIG);
  expect(await s.tick()).toBe('idle');
  advance(60_000);
  addChunk(A, BIG);
  expect(await s.tick()).toBe('idle');
  expect(digested(later)).toBe(0);
  expect(uncurated()).toBe(1);

  advance(CURATE_DELAY_MS);
  expect(await s.tick()).toBe('curated');
  advance(FALLBACK_MS);
  expect(await s.tick()).toBe('digested');
  expect(digested(later)).toBe(1);
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
