import type { DatabaseSync } from 'node:sqlite';
import type { DomainDeps } from '../domain/types.ts';
import { effectiveStatus } from '../server/sessions-repo.ts';
import type { SessionRow } from '../server/sessions-repo.ts';
import { pickCurateBatch, runCurate } from './curate.ts';
import { MIN_DIGEST_CHARS, nextWindow, runDigest, skipWindow } from './digest.ts';
import type { DigestWindow } from './digest.ts';
import { isPausing } from './llm.ts';
import type { LlmErrorKind, LlmRunner } from './llm.ts';
import { markStageReviewed, pickRestageBatch, runRestage } from './restage.ts';
import type { SchedulerStatus } from './status.ts';

export { disabledStatus } from './status.ts';
export type { SchedulerStatus } from './status.ts';

/** How often the timer started by `start()` ticks. */
export const TICK_MS = 30000;
/**
 * How long `status()` reuses the counts that scan `chunks` (seconds-to-minutes stale is fine for a status line, and
 * the change feed asks every second). Every tick also drops them, since a tick is what changes them most.
 */
export const STATUS_CACHE_MS = 10000;
/** A session is digested this long after it stopped working (went idle, done, blocked, ended or offline). */
export const DEBOUNCE_MS = 120000;
/** A session that keeps working is digested anyway once its oldest unprocessed chunk is this old. */
export const FALLBACK_MS = 1800000;
/** Uncurated digests wait at most this long for a batch to fill up. */
export const CURATE_DELAY_MS = 300000;
/** This many uncurated digests start a curator run right away. */
export const CURATE_BATCH = 8;
/** First pause after a pausing failure (and first curate-only wait after a curate failure); doubles each time. */
export const BACKOFF_START_MS = 60000;
export const BACKOFF_MAX_MS = 1800000;
/** Consecutive failures after which a session cools down, or a curate batch is given up. */
export const MAX_SESSION_FAILURES = 3;
export const SESSION_COOLDOWN_MS = 3600000;
/** Cooldowns the same window may cause at its full size; after that each further one halves the session's window. */
export const STALL_GRACE_CYCLES = 2;

export type TickResult = 'curated' | 'digested' | 'restaged' | 'skipped' | 'idle' | 'paused' | 'busy';

const PAUSE_LABELS: Record<string, string> = {
  rate_limit: '限流（429）',
  overloaded: '模型过载（529）',
  auth: '鉴权失败（OAuth token 无效或已过期）',
};

/** ISO time without milliseconds, for messages people read. */
function shortIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `null` (a session that predates schema v3) counts as long ago. */
function age(now: number, iso: string | null): number {
  return iso === null ? Number.POSITIVE_INFINITY : now - Date.parse(iso);
}

/** An error's message, or the thrown value as text; never throws. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'a thrown value that cannot be printed';
  }
}

function nextBackoff(current: number): number {
  return Math.min(current * 2, BACKOFF_MAX_MS);
}

type Candidate = { key: string; oldest: string };
/** The part of the status that scans `chunks`, with the time (ms) it was read at. */
type ChunkCounts = { at: number; waiting_sessions: number; backfill: SchedulerStatus['backfill'] };
type SessionWithHeartbeat = SessionRow & { machine_heartbeat: string | null };
type Picked = { window: DigestWindow; force: boolean };
/** What the tick in flight is working on, so an exception can be counted against it. */
type Work =
  | { kind: 'curate'; ids: number[]; now: number }
  | { kind: 'digest'; window: DigestWindow; now: number }
  | { kind: 'restage'; ids: string[]; now: number };
/**
 * A session whose window keeps failing: the window's first chunk, how many cooldowns it has caused, and the cap its
 * windows are cut to once those pass `STALL_GRACE_CYCLES` (unset until then).
 */
type Stall = { firstChunk: number; cycles: number; cap?: number };
/** Realtime chunks with ids up to `chunk` existed when the sync was requested; only they get the sync treatment. */
type SyncMarks = { chunk: number };

/**
 * Decides what the understanding layer does next and does it, one model call at a time: curate a batch of digests,
 * digest a session that is ready (realtime), digest a slice of imported history (backfill), or review the stage of
 * projects not yet judged under the current stage rules, in that order. Pauses,
 * backoff, failure counts and cooldowns live in memory and start over when the server restarts.
 */
export class Scheduler {
  private readonly db: DatabaseSync;
  private readonly deps: DomainDeps;
  private readonly runner: LlmRunner;
  private readonly models: { digest: string; curate: string };

  private inFlight: Promise<TickResult> | null = null;
  private running: 'digest' | 'curate' | 'restage' | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private work: Work | null = null;
  private sync: SyncMarks | null = null;

  private pausedUntil: number | null = null;
  private pauseReason: string | null = null;
  private backoffMs = BACKOFF_START_MS;
  private lastError: string | null = null;

  private readonly sessionFailures = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly stalls = new Map<string, Stall>();
  private curateFailures = 0;
  private curateWaitUntil: number | null = null;
  private restageFailures = 0;
  private restageWaitUntil: number | null = null;
  /** The session the last backfill window came from; the next one starts after it. */
  private backfillCursor: string | null = null;
  /** See `STATUS_CACHE_MS`. */
  private chunkCounts: ChunkCounts | null = null;

  constructor(db: DatabaseSync, deps: DomainDeps, runner: LlmRunner, models: { digest: string; curate: string }) {
    this.db = db;
    this.deps = deps;
    this.runner = runner;
    this.models = models;
  }

  /**
   * Does at most one thing. `busy` while an earlier tick is still running, `paused` during a pause (or when this tick's
   * call started one). `skipped` covers a window stored as skipped without a model call, and a call that failed without
   * pausing. Never rejects: an exception is logged to stderr and counts as a failure (not pausing) of the work the tick
   * had picked, so `skipped`; an exception before anything was picked counts as `idle`.
   */
  tick(): Promise<TickResult> {
    if (this.inFlight !== null) return Promise.resolve('busy');
    this.work = null;
    const run = this.step()
      .catch((err: unknown): TickResult => {
        // Everything in here can throw too (logging, an exotic thrown value, the database); the timer must still never
        // see a rejection.
        try {
          console.error('herdr-pm scheduler: tick failed:', err);
        } catch {
          // Nowhere left to report it.
        }
        try {
          const message = `exception: ${describeError(err)}`;
          const work = this.work;
          this.lastError = `调度出错：${message}`;
          if (work === null) return 'idle';
          if (work.kind === 'curate') this.curateFailed(work.now, work.ids, 'other', message);
          else if (work.kind === 'restage') this.restageFailed(work.now, work.ids, 'other', message);
          else this.digestFailed(work.now, work.window, 'other', message);
          return 'skipped';
        } catch (accountingErr) {
          try {
            console.error('herdr-pm scheduler: recording the failure failed:', accountingErr);
          } catch {
            // As above.
          }
          return 'idle';
        }
      })
      .finally(() => {
        this.running = null;
        this.work = null;
        this.inFlight = null;
        this.chunkCounts = null;
      });
    this.inFlight = run;
    return run;
  }

  /**
   * "Run a round now": the realtime chunks that exist at this moment skip the debounce (and a small window of only such
   * chunks is stored as skipped, unless it holds a report), and while the sync lasts every uncurated digest, including the ones the sync itself
   * writes, skips the curate delay. The sync ends once those chunks are processed and nothing is left to curate. Chunks
   * that arrive later follow the normal rules, so a session that keeps working cannot keep the sync going. Calling it
   * again during a sync takes in what arrived since.
   */
  requestSync(): void {
    const max = (this.db.prepare('SELECT coalesce(max(id), 0) AS n FROM chunks').get() as { n: number }).n;
    this.sync = { chunk: max };
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  /** Stops the timer and waits for the tick in flight, if any. */
  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  status(): SchedulerStatus {
    const now = this.deps.now().getTime();
    const paused = this.pausedUntil !== null && now < this.pausedUntil;
    const scalar = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    const latest = (sql: string): string | null => (this.db.prepare(sql).get() as { at: string | null }).at;
    const counts = this.readChunkCounts(now);
    return {
      enabled: true,
      paused_until: paused ? new Date(this.pausedUntil!).toISOString() : null,
      pause_reason: paused ? this.pauseReason : null,
      last_error: this.lastError,
      running: this.running,
      waiting_sessions: counts.waiting_sessions,
      uncurated_digests: scalar('SELECT count(*) AS n FROM digests WHERE curated = 0'),
      backfill: { ...counts.backfill },
      last_digest_at: latest('SELECT max(created_at) AS at FROM digests WHERE skipped = 0'),
      last_curate_at: latest(`SELECT max(ts) AS at FROM llm_runs WHERE role = 'curate' AND ok = 1`),
    };
  }

  /**
   * The status counts that scan `chunks` (backfill ones have no index: hundreds of ms on a big history), reused for
   * `STATUS_CACHE_MS` or until the next tick ends.
   */
  private readChunkCounts(now: number): ChunkCounts {
    const cached = this.chunkCounts;
    if (cached !== null && now >= cached.at && now - cached.at < STATUS_CACHE_MS) return cached;
    const scalar = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    const counts: ChunkCounts = {
      at: now,
      waiting_sessions: scalar(
        `SELECT count(DISTINCT c.session_key) AS n FROM chunks c LEFT JOIN sessions s ON s.key = c.session_key
         WHERE c.digested = 0 AND c.backfill = 0 AND coalesce(s.ignored, 0) = 0`,
      ),
      // Ignored sessions are never digested, so they are left out like in `waiting_sessions`.
      backfill: {
        sessions_total: scalar(
          `SELECT count(DISTINCT c.session_key) AS n FROM chunks c LEFT JOIN sessions s ON s.key = c.session_key
           WHERE c.backfill = 1 AND coalesce(s.ignored, 0) = 0`,
        ),
        sessions_done: scalar(
          `SELECT count(*) AS n FROM (
             SELECT c.session_key FROM chunks c LEFT JOIN sessions s ON s.key = c.session_key
             WHERE c.backfill = 1 AND coalesce(s.ignored, 0) = 0
             GROUP BY c.session_key HAVING sum(c.digested = 0) = 0
           )`,
        ),
      },
    };
    this.chunkCounts = counts;
    return counts;
  }

  // ---- one tick --------------------------------------------------------------------------------------------------

  private async step(): Promise<TickResult> {
    const now = this.deps.now().getTime();
    if (this.pausedUntil !== null) {
      if (now < this.pausedUntil) return 'paused';
      this.pausedUntil = null;
      this.pauseReason = null;
    }

    if (this.sync !== null && this.syncDone(this.sync, now)) this.sync = null;

    const uncurated = this.db
      .prepare('SELECT count(*) AS n, min(created_at) AS oldest FROM digests WHERE curated = 0')
      .get() as { n: number; oldest: string | null };
    const curateWaiting = this.curateWaitUntil !== null && now < this.curateWaitUntil;
    if (
      uncurated.n > 0 &&
      !curateWaiting &&
      (uncurated.n >= CURATE_BATCH || age(now, uncurated.oldest) >= CURATE_DELAY_MS || this.sync !== null)
    ) {
      return this.curate(now);
    }

    const realtime = this.pickRealtime(now);
    if (realtime !== null) return this.digest(now, realtime);

    const backfill = this.pickBackfill(now);
    if (backfill !== null) return this.digest(now, backfill);

    if (this.restageWaitUntil === null || now >= this.restageWaitUntil) {
      const projects = pickRestageBatch(this.db);
      if (projects.length > 0) return this.restage(now, projects);
    }
    return 'idle';
  }

  private async restage(now: number, ids: string[]): Promise<TickResult> {
    this.work = { kind: 'restage', ids, now };
    this.running = 'restage';
    const outcome = await runRestage(this.db, this.deps, this.runner, ids, { model: this.models.curate });
    if (outcome.status === 'reviewed') {
      this.restageFailures = 0;
      this.restageWaitUntil = null;
      const partial = outcome.partialError;
      if (partial === undefined) {
        this.backoffMs = BACKOFF_START_MS;
        return 'restaged';
      }
      this.lastError = `复核阶段中途失败（${partial.kind}）：${partial.message}；已改的阶段保留，项目 ${ids.join(', ')} 不再重试`;
      return isPausing(partial.kind) ? this.pause(now, partial.kind) : 'restaged';
    }
    if (isPausing(outcome.kind)) return this.pause(now, outcome.kind);
    this.restageFailed(now, ids, outcome.kind, outcome.message);
    return 'skipped';
  }

  /** Like `curateFailed`: a restage-only wait, and after `MAX_SESSION_FAILURES` the batch is given up (marked reviewed). */
  private restageFailed(now: number, ids: string[], kind: LlmErrorKind, message: string): void {
    this.restageFailures += 1;
    this.lastError = `复核阶段失败（${kind}）：${message}`;
    if (this.restageFailures >= MAX_SESSION_FAILURES) {
      markStageReviewed(this.db, ids);
      this.lastError += `；连续 ${this.restageFailures} 次失败，已跳过项目 ${ids.join(', ')}`;
      this.restageFailures = 0;
      this.restageWaitUntil = null;
    } else {
      this.restageWaitUntil = now + Math.min(BACKOFF_START_MS * 2 ** (this.restageFailures - 1), BACKOFF_MAX_MS);
    }
  }

  private async curate(now: number): Promise<TickResult> {
    const ids = pickCurateBatch(this.db);
    this.work = { kind: 'curate', ids, now };
    this.running = 'curate';
    const outcome = await runCurate(this.db, this.deps, this.runner, ids, { model: this.models.curate });
    if (outcome.status === 'curated') {
      this.curateFailures = 0;
      this.curateWaitUntil = null;
      const partial = outcome.partialError;
      if (partial === undefined) {
        this.backoffMs = BACKOFF_START_MS;
        return 'curated';
      }
      // The batch was marked curated because writes had landed; the failure itself still counts.
      this.lastError = `整理中途失败（${partial.kind}）：${partial.message}；已写入的部分保留，摘要 ${ids.join(', ')} 不再重试`;
      return isPausing(partial.kind) ? this.pause(now, partial.kind) : 'curated';
    }
    if (isPausing(outcome.kind)) return this.pause(now, outcome.kind);
    this.curateFailed(now, ids, outcome.kind, outcome.message);
    return 'skipped';
  }

  /** A curate failure that does not pause: a curate-only wait, and after `MAX_SESSION_FAILURES` the batch is given up. */
  private curateFailed(now: number, ids: number[], kind: LlmErrorKind, message: string): void {
    this.curateFailures += 1;
    this.lastError = `整理失败（${kind}）：${message}`;
    if (this.curateFailures >= MAX_SESSION_FAILURES) {
      // Give up on this batch so the digests behind it are not stuck forever.
      this.db.prepare(`UPDATE digests SET curated = 1 WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids);
      this.lastError += `；连续 ${this.curateFailures} 次失败，已放弃摘要 ${ids.join(', ')}`;
      this.curateFailures = 0;
      this.curateWaitUntil = null;
    } else {
      const wait = Math.min(BACKOFF_START_MS * 2 ** (this.curateFailures - 1), BACKOFF_MAX_MS);
      this.curateWaitUntil = now + wait;
    }
  }

  private async digest(now: number, picked: Picked): Promise<TickResult> {
    const { window } = picked;
    const key = window.sessionKey;
    this.work = { kind: 'digest', window, now };
    this.running = 'digest';
    const outcome = await runDigest(this.db, this.deps, this.runner, window, {
      model: this.models.digest,
      force: picked.force,
    });
    if (outcome.status !== 'failed') {
      if (outcome.status === 'digested') this.backoffMs = BACKOFF_START_MS;
      this.sessionFailures.delete(key);
      this.stalls.delete(key);
      return outcome.status;
    }
    if (isPausing(outcome.kind)) return this.pause(now, outcome.kind);
    this.digestFailed(now, window, outcome.kind, outcome.message);
    return 'skipped';
  }

  /**
   * A digest failure that does not pause: counts against the session, which cools down after `MAX_SESSION_FAILURES`.
   * Each cooldown is also a cycle of the window's stall (see `stalled`).
   */
  private digestFailed(now: number, window: DigestWindow, kind: LlmErrorKind, message: string): void {
    const key = window.sessionKey;
    this.lastError = `摘要失败（${key}，${kind}）：${message}`;
    const failures = (this.sessionFailures.get(key) ?? 0) + 1;
    if (failures >= MAX_SESSION_FAILURES) {
      this.sessionFailures.delete(key);
      this.cooldownUntil.set(key, now + SESSION_COOLDOWN_MS);
      this.lastError += `；连续 ${failures} 次失败，冷却到 ${shortIso(now + SESSION_COOLDOWN_MS)}`;
      this.stalled(window);
    } else {
      this.sessionFailures.set(key, failures);
    }
  }

  /**
   * A window just used up a whole cycle (failures up to a cooldown). The same first chunk gets `STALL_GRACE_CYCLES`
   * cycles at full size; from then on, after each cycle the session's windows are cut to half of what this one held.
   * Once the window cannot get smaller (a single chunk, or the newest screen plus the first other chunk, which always
   * go in) and still fails one of those further cycles, it is stored as a skipped digest so the session can move on
   * (its cooldown is lifted).
   */
  private stalled(window: DigestWindow): void {
    const key = window.sessionKey;
    const firstChunk = window.chunkIds[0];
    const previous = this.stalls.get(key);
    const stall: Stall = previous?.firstChunk === firstChunk ? previous : { firstChunk, cycles: 0 };
    stall.cycles += 1;
    this.stalls.set(key, stall);
    if (stall.cycles < STALL_GRACE_CYCLES) return;

    const smallest = window.chunkIds.length === 1 || (stall.cap !== undefined && window.totalChars > stall.cap);
    if (!smallest) {
      stall.cap = Math.floor(window.totalChars / 2);
      this.lastError += `；同一窗口已冷却 ${stall.cycles} 次，窗口减半到 ${stall.cap} 字`;
      return;
    }
    // A window that was this small from the start still gets its first cycle past the grace.
    if (stall.cycles === STALL_GRACE_CYCLES) return;
    skipWindow(this.db, this.deps, window);
    this.stalls.delete(key);
    this.cooldownUntil.delete(key);
    this.lastError += `；session ${key} 的 chunk ${window.chunkIds.join(', ')} 单独摘要仍然失败 ${stall.cycles} 轮，已跳过`;
  }

  private pause(now: number, kind: LlmErrorKind): TickResult {
    this.pausedUntil = now + this.backoffMs;
    this.pauseReason = `${PAUSE_LABELS[kind] ?? kind}，${shortIso(this.pausedUntil)} 恢复`;
    this.backoffMs = nextBackoff(this.backoffMs);
    return 'paused';
  }

  // ---- sync ------------------------------------------------------------------------------------------------------

  /** Nothing is left to curate, and no realtime chunk from before the sync of a session we would digest. */
  private syncDone(marks: SyncMarks, now: number): boolean {
    if (this.db.prepare('SELECT 1 FROM digests WHERE curated = 0 LIMIT 1').get() !== undefined) return false;
    const keys = this.db
      .prepare(
        `SELECT DISTINCT c.session_key AS key FROM chunks c LEFT JOIN sessions s ON s.key = c.session_key
         WHERE c.digested = 0 AND c.backfill = 0 AND c.id <= ? AND coalesce(s.ignored, 0) = 0`,
      )
      .all(marks.chunk) as Array<{ key: string }>;
    return keys.every((r) => this.cooling(r.key, now));
  }

  // ---- choosing work ---------------------------------------------------------------------------------------------

  private cooling(key: string, now: number): boolean {
    const until = this.cooldownUntil.get(key);
    if (until === undefined) return false;
    if (now < until) return true;
    this.cooldownUntil.delete(key);
    return false;
  }

  /** Keys with unprocessed chunks of one mode, minus ignored and cooling sessions, oldest waiting first. */
  private candidates(backfill: boolean, now: number): Candidate[] {
    const rows = this.db
      .prepare(
        `SELECT c.session_key AS key, min(c.received_at) AS oldest
         FROM chunks c LEFT JOIN sessions s ON s.key = c.session_key
         WHERE c.digested = 0 AND c.backfill = ? AND coalesce(s.ignored, 0) = 0
         GROUP BY c.session_key ORDER BY oldest, key`,
      )
      .all(backfill ? 1 : 0) as Candidate[];
    return rows.filter((r) => !this.cooling(r.key, now));
  }

  /** The first ready realtime window. Sessions that failed recently go behind healthy ones. */
  private pickRealtime(now: number): Picked | null {
    const failures = (key: string) => this.sessionFailures.get(key) ?? 0;
    const ordered = this.candidates(false, now).sort((a, b) => failures(a.key) - failures(b.key));
    const loadSession = this.db.prepare(
      `SELECT s.*, m.last_heartbeat AS machine_heartbeat FROM sessions s LEFT JOIN machines m ON m.label = s.machine
       WHERE s.key = ?`,
    );
    for (const { key, oldest } of ordered) {
      const overdue = age(now, oldest) >= FALLBACK_MS;
      const session = loadSession.get(key) as SessionWithHeartbeat | undefined;
      let ready: boolean;
      let finished = false;
      if (session === undefined) {
        // `report:` keys, and chunks that arrived before their session's first snapshot.
        ready = age(now, oldest) >= DEBOUNCE_MS;
      } else {
        const { machine_heartbeat, ...row } = session;
        const settled =
          effectiveStatus(row, machine_heartbeat, new Date(now)) !== 'working' &&
          age(now, row.status_changed_at) >= DEBOUNCE_MS;
        ready = settled || overdue;
        finished = row.lifecycle !== 'live';
      }
      if (!ready && this.sync === null) continue;

      const window = nextWindow(this.db, key, 'realtime', this.stalls.get(key)?.cap);
      if (window === null) continue;
      // Under sync, a window that starts with a chunk from before the sync is ready; it may be forced out as skipped
      // only when every chunk in it is from before the sync, so a fragment that arrived since is not thrown away.
      const mark = this.sync?.chunk ?? 0;
      const syncReady = this.sync !== null && Math.min(...window.chunkIds, ...window.staleChunkIds) <= mark;
      if (!ready && !syncReady) continue;
      const syncForce = this.sync !== null && window.chunkIds.every((id) => id <= mark);
      const force = finished || overdue || syncForce;
      // Too little to be worth a call: wait for more while the session may still add to it. A report is never held
      // back for its size (and `runDigest` never skips it).
      if (window.totalChars < MIN_DIGEST_CHARS && !force && !window.hasReport) continue;
      return { window, force };
    }
    return null;
  }

  /** The next session's backfill window, round robin by key, so one long conversation cannot hold the queue. */
  private pickBackfill(now: number): Picked | null {
    const keys = this.candidates(true, now)
      .map((c) => c.key)
      .sort();
    if (keys.length === 0) return null;
    const cursor = this.backfillCursor;
    const after = cursor === null ? -1 : keys.findIndex((k) => k > cursor);
    const ordered = after < 0 ? keys : [...keys.slice(after), ...keys.slice(0, after)];
    for (const key of ordered) {
      const window = nextWindow(this.db, key, 'backfill', this.stalls.get(key)?.cap);
      if (window === null) continue;
      this.backfillCursor = key;
      return { window, force: true };
    }
    return null;
  }
}
