import type { DatabaseSync } from 'node:sqlite';
import { STREAM_MAX_EVENTS } from '../shared/stream-protocol.ts';
import type { StreamEvent, StreamMessage } from '../shared/stream-protocol.ts';
import type { LiveStatus } from '../shared/protocol.ts';
import type { SchedulerStatus } from '../understand/status.ts';
import { loadStatusContext, sourceHealth, statusIn } from './sources-repo.ts';
import type { SourceRow } from './sources-repo.ts';

// Change detection for `WS /stream` by polling the database. The writes come from many paths (operations, questions,
// answers, snapshots, the scheduler), and some changes have no write at all (a source whose collector went silent, or
// whose daemon disconnected, goes offline when the clock passes its heartbeat), so one cheap read of a few signatures
// covers them all.

/** A cheap signature of everything the page shows; two equal states mean the page has nothing to re-read. */
export type FeedState = { eventId: number; questions: string; sessions: string; status: string };

/** Reads the current signatures. `now` decides which sources count as offline; `status` is the scheduler's. */
export function readFeedState(db: DatabaseSync, now: Date, status: SchedulerStatus): FeedState {
  const { m } = db.prepare('SELECT MAX(id) AS m FROM events').get() as { m: number | null };
  const q = db
    .prepare(
      // `evidence` grows when the same question is asked again (askUser's dedupe path), which writes nothing else.
      `SELECT COUNT(*) AS n, COALESCE(SUM(status = 'pending'), 0) AS pending, MAX(rowid) AS last, MAX(resolved_at) AS resolved,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN length(evidence) END), 0) AS evidence
       FROM questions`,
    )
    .get() as { n: number; pending: number; last: number | null; resolved: string | null; evidence: number };
  // Each session's status by the same rule `/sessions` and the scheduler use, plus its sources' state, so the
  // signature flips exactly when what a session shows (or a source badge) would change.
  const ctx = loadStatusContext(db, now);
  const sessions = (
    db
      .prepare('SELECT key, live_status, lifecycle, ignored, merged_into, title, machine, content_owner FROM sessions ORDER BY key')
      .all() as Array<{ key: string; live_status: LiveStatus; lifecycle: string; ignored: number; merged_into: string | null; title: string; machine: string | null; content_owner: string | null }>
  ).map((r) => [
    r.key,
    statusIn(ctx, r, now),
    r.lifecycle,
    r.ignored,
    r.merged_into,
    r.title,
    r.machine,
    r.content_owner,
    (ctx.observations.get(r.key) ?? []).map((o) => [o.source_id, o.live_status, o.lifecycle, o.fresh, o.content_state, o.gaps]),
  ]);
  const offline = [...ctx.sources.values()]
    .filter((src) => !sourceAlive(src, now))
    .map((src) => src.source_id)
    .sort();
  return {
    eventId: m ?? 0,
    questions: `${q.n}|${q.pending}|${q.last ?? ''}|${q.resolved ?? ''}|${q.evidence}`,
    sessions: JSON.stringify({ sessions, offline }),
    status: JSON.stringify(status),
  };
}

function sourceAlive(src: SourceRow, now: Date): boolean {
  const h = sourceHealth(src, now);
  return h.collectorAlive && h.daemonOk;
}

/** The messages that take a page from `prev` to `next`, always in the order events, questions, sessions, status. */
export function diffFeed(db: DatabaseSync, prev: FeedState, next: FeedState): StreamMessage[] {
  const messages: StreamMessage[] = [];
  if (next.eventId > prev.eventId) {
    // Bounded by `next.eventId` too: events written after `next` was read belong to the next poll, not to this one.
    const rows = db
      .prepare('SELECT id, project_id, op, actor FROM events WHERE id > ? AND id <= ? ORDER BY id LIMIT ?')
      .all(prev.eventId, next.eventId, STREAM_MAX_EVENTS + 1) as StreamEvent[];
    const events = rows.slice(0, STREAM_MAX_EVENTS).map(({ id, project_id, op, actor }) => ({ id, project_id, op, actor }));
    messages.push({ type: 'events', events, more: rows.length > STREAM_MAX_EVENTS });
  }
  if (next.questions !== prev.questions) messages.push({ type: 'questions' });
  if (next.sessions !== prev.sessions) messages.push({ type: 'sessions' });
  if (next.status !== prev.status) messages.push({ type: 'status' });
  return messages;
}

/**
 * Polls the database while anyone listens. The first subscriber takes a baseline and starts the timer; the last one to
 * unsubscribe stops it, so an idle server does no work. One listener throwing does not keep the others from hearing,
 * and a failing poll is logged and retried on the next tick.
 */
export class ChangeFeed {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly status: () => SchedulerStatus;
  private readonly intervalMs: number;
  private readonly listeners = new Set<(msg: StreamMessage) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: FeedState | null = null;

  constructor(db: DatabaseSync, opts: { now?: () => Date; status: () => SchedulerStatus; intervalMs?: number }) {
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.status = opts.status;
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  subscribe(listener: (msg: StreamMessage) => void): () => void {
    // A wrapper, so subscribing the same function twice gives two independent subscriptions.
    const entry = (msg: StreamMessage) => listener(msg);
    this.listeners.add(entry);
    if (this.timer === null) {
      this.state = null;
      this.poll(); // baseline: with no previous state nothing is sent
      this.timer = setInterval(() => this.poll(), this.intervalMs);
      // The HTTP server keeps the process alive; this timer alone must not.
      this.timer.unref?.();
    }
    return () => {
      if (!this.listeners.delete(entry)) return;
      if (this.listeners.size === 0) this.halt();
    };
  }

  poll(): void {
    let messages: StreamMessage[];
    try {
      const next = readFeedState(this.db, this.now(), this.status());
      messages = this.state === null ? [] : diffFeed(this.db, this.state, next);
      this.state = next;
    } catch (err) {
      console.error(`herdr-pm server: change feed poll failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const msg of messages) {
      for (const listener of [...this.listeners]) {
        try {
          listener(msg);
        } catch (err) {
          console.error(`herdr-pm server: change feed listener failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  stop(): void {
    this.listeners.clear();
    this.halt();
  }

  private halt(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.state = null;
  }
}
