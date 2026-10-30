import type { DatabaseSync } from 'node:sqlite';
import type { DomainDeps } from '../domain/types.ts';
import { effectiveStatus } from '../server/sessions-repo.ts';
import type { SessionRow } from '../server/sessions-repo.ts';
import { pickCurateBatch, runCurate } from './curate.ts';
import { MIN_DIGEST_CHARS, nextWindow, runDigest } from './digest.ts';
import type { DigestWindow } from './digest.ts';
import { isPausing } from './llm.ts';
import type { LlmErrorKind, LlmRunner } from './llm.ts';
import type { SchedulerStatus } from './status.ts';

export { disabledStatus } from './status.ts';
export type { SchedulerStatus } from './status.ts';

/** How often the timer started by `start()` ticks. */
export const TICK_MS = 30000;
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

export type TickResult = 'curated' | 'digested' | 'skipped' | 'idle' | 'paused' | 'busy';

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

function nextBackoff(current: number): number {
  return Math.min(current * 2, BACKOFF_MAX_MS);
}

type Candidate = { key: string; oldest: string };
type SessionWithHeartbeat = SessionRow & { machine_heartbeat: string | null };
type Picked = { window: DigestWindow; force: boolean };
/** What the tick in flight is working on, so an exception can be counted against it. */
type Work = { kind: 'curate'; ids: number[]; now: number } | { kind: 'digest'; key: string; now: number };
/** Chunks and digests with ids up to these existed when the sync was requested; only they get the sync treatment. */
type SyncMarks = { chunk: number; digest: number };

/**
 * Decides what the understanding layer does next and does it, one model call at a time: curate a batch of digests,
 * digest a session that is ready (realtime), or digest a slice of imported history (backfill), in that order. Pauses,
 * backoff, failure counts and cooldowns live in memory and start over when the server restarts.
 */
export class Scheduler {
  private readonly db: DatabaseSync;
  private readonly deps: DomainDeps;
  private readonly runner: LlmRunner;
  private readonly models: { digest: string; curate: string };

  private inFlight: Promise<TickResult> | null = null;
  private running: 'digest' | 'curate' | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private work: Work | null = null;
  private sync: SyncMarks | null = null;

  private pausedUntil: number | null = null;
  private pauseReason: string | null = null;
  private backoffMs = BACKOFF_START_MS;
  private lastError: string | null = null;

  private readonly sessionFailures = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private curateFailures = 0;
  private curateWaitUntil: number | null = null;
  /** The session the last backfill window came from; the next one starts after it. */
  private backfillCursor: string | null = null;

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
        console.error('herdr-pm scheduler: tick failed:', err);
        const message = `exception: ${err instanceof Error ? err.message : String(err)}`;
        const work = this.work;
        if (work === null) {
          this.lastError = `调度出错：${message}`;
          return 'idle';
        }
        if (work.kind === 'curate') this.curateFailed(work.now, work.ids, 'other', message);
        else this.digestFailed(work.now, work.key, 'other', message);
        return 'skipped';
      })
      .finally(() => {
        this.running = null;
        this.work = null;
        this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  /**
   * "Run a round now": the realtime chunks and the digests that exist at this moment skip the debounce and the curate
   * delay (and a small window of only such chunks is stored as skipped) until all of them are processed. Chunks that
   * arrive later follow the normal rules, so a session that keeps working cannot keep the sync going. Calling it again
   * during a sync takes in what arrived since.
   */
  requestSync(): void {
    const max = (table: string) => (this.db.prepare(`SELECT coalesce(max(id), 0) AS n FROM ${table}`).get() as { n: number }).n;
    this.sync = { chunk: max('chunks'), digest: max('digests') };
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
    return {
      enabled: true,
      paused_until: paused ? new Date(this.pausedUntil!).toISOString() : null,
      pause_reason: paused ? this.pauseReason : null,
      last_error: this.lastError,
      running: this.running,
      waiting_sessions: scalar(
        `SELECT count(DISTINCT c.session_key) AS n FROM chunks c LEFT JOIN sessions s ON s.key = c.session_key
         WHERE c.digested = 0 AND c.backfill = 0 AND coalesce(s.ignored, 0) = 0`,
      ),
      uncurated_digests: scalar('SELECT count(*) AS n FROM digests WHERE curated = 0'),
      backfill: {
        sessions_total: scalar('SELECT count(DISTINCT session_key) AS n FROM chunks WHERE backfill = 1'),
        sessions_done: scalar(
          `SELECT count(*) AS n FROM (
             SELECT session_key FROM chunks WHERE backfill = 1 GROUP BY session_key HAVING sum(digested = 0) = 0
           )`,
        ),
      },
      last_digest_at: latest('SELECT max(created_at) AS at FROM digests WHERE skipped = 0'),
      last_curate_at: latest(`SELECT max(ts) AS at FROM llm_runs WHERE role = 'curate' AND ok = 1`),
    };
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
      (uncurated.n >= CURATE_BATCH || age(now, uncurated.oldest) >= CURATE_DELAY_MS || this.syncCurate())
    ) {
      return this.curate(now);
    }

    const realtime = this.pickRealtime(now);
    if (realtime !== null) return this.digest(now, realtime);

    const backfill = this.pickBackfill(now);
    if (backfill !== null) return this.digest(now, backfill);
    return 'idle';
  }

  private async curate(now: number): Promise<TickResult> {
    const ids = pickCurateBatch(this.db);
    this.work = { kind: 'curate', ids, now };
    this.running = 'curate';
    const outcome = await runCurate(this.db, this.deps, this.runner, ids, { model: this.models.curate });
    if (outcome.status === 'curated') {
      this.backoffMs = BACKOFF_START_MS;
      this.curateFailures = 0;
      this.curateWaitUntil = null;
      return 'curated';
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
    const key = picked.window.sessionKey;
    this.work = { kind: 'digest', key, now };
    this.running = 'digest';
    const outcome = await runDigest(this.db, this.deps, this.runner, picked.window, {
      model: this.models.digest,
      force: picked.force,
    });
    if (outcome.status !== 'failed') {
      if (outcome.status === 'digested') this.backoffMs = BACKOFF_START_MS;
      this.sessionFailures.delete(key);
      return outcome.status;
    }
    if (isPausing(outcome.kind)) return this.pause(now, outcome.kind);
    this.digestFailed(now, key, outcome.kind, outcome.message);
    return 'skipped';
  }

  /** A digest failure that does not pause: counts against the session, which cools down after `MAX_SESSION_FAILURES`. */
  private digestFailed(now: number, key: string, kind: LlmErrorKind, message: string): void {
    this.lastError = `摘要失败（${key}，${kind}）：${message}`;
    const failures = (this.sessionFailures.get(key) ?? 0) + 1;
    if (failures >= MAX_SESSION_FAILURES) {
      this.sessionFailures.delete(key);
      this.cooldownUntil.set(key, now + SESSION_COOLDOWN_MS);
      this.lastError += `；连续 ${failures} 次失败，冷却到 ${shortIso(now + SESSION_COOLDOWN_MS)}`;
    } else {
      this.sessionFailures.set(key, failures);
    }
  }

  private pause(now: number, kind: LlmErrorKind): TickResult {
    this.pausedUntil = now + this.backoffMs;
    this.pauseReason = `${PAUSE_LABELS[kind] ?? kind}，${shortIso(this.pausedUntil)} 恢复`;
    this.backoffMs = nextBackoff(this.backoffMs);
    return 'paused';
  }

  // ---- sync ------------------------------------------------------------------------------------------------------

  /** Whether some digest that existed when the sync was requested is still uncurated. */
  private syncCurate(): boolean {
    if (this.sync === null) return false;
    return this.db.prepare('SELECT 1 FROM digests WHERE curated = 0 AND id <= ? LIMIT 1').get(this.sync.digest) !== undefined;
  }

  /** Nothing from before the sync is left: no realtime chunk of a session we would digest, no uncurated digest. */
  private syncDone(marks: SyncMarks, now: number): boolean {
    if (this.syncCurate()) return false;
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

      const window = nextWindow(this.db, key, 'realtime');
      if (window === null) continue;
      // Under sync, a window that starts with a chunk from before the sync is ready; it may be forced out as skipped
      // only when every chunk in it is from before the sync, so a fragment that arrived since is not thrown away.
      const mark = this.sync?.chunk ?? 0;
      const syncReady = this.sync !== null && Math.min(...window.chunkIds, ...window.staleChunkIds) <= mark;
      if (!ready && !syncReady) continue;
      const syncForce = this.sync !== null && window.chunkIds.every((id) => id <= mark);
      const force = finished || overdue || syncForce;
      // Too little to be worth a call: wait for more while the session may still add to it.
      if (window.totalChars < MIN_DIGEST_CHARS && !force) continue;
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
      const window = nextWindow(this.db, key, 'backfill');
      if (window === null) continue;
      this.backfillCursor = key;
      return { window, force: true };
    }
    return null;
  }
}
