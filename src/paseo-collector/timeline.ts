import { randomUUID } from 'node:crypto';
import type { BatchV2, Cursor, Gap, TimelineEvent } from '../shared/ingest-v2.ts';
import { isUnsettled, normalizeEntry } from './normalize.ts';
import type { PaseoSdk, TimelinePage } from './sdk.ts';

// One step of reading an agent's timeline: the page after the committed position, turned into one batch.
//
// The position is the daemon's own `{epoch, seq}`. A page `after seq X` holds every projected row with a canonical seq
// above X, so a row that straddles a page boundary comes again (the center dedupes it by identity and content) and
// rows never need consecutive seqs. Rows that may still change (a running tool call, the growing last row of an active
// turn) are held back: the batch stops before the first of them and its position stops at that row's first seq minus
// one, so the next read starts with it again. A cursor whose epoch was replaced is detected (the daemon then answers
// with the latest rows of the new epoch, which must not be taken as the continuation): the new epoch is read from its
// start, flagged as a reset, and the center sorts out which rows it already had.

/** Batches stay well under the center's 512 KiB body limit. */
export const BATCH_BUDGET_BYTES = 300 * 1024;

export type BatchPlan = {
  batch: Omit<BatchV2, 'source_id' | 'instance_id' | 'lease_epoch'>;
  /** The committed position moves (or the epoch changes); when false, reading again now would find the same rows. */
  progressed: boolean;
  /** More settled rows can be read right after this batch is committed (a size cut, or the daemon has newer rows). */
  more: boolean;
};

export type ReadOptions = {
  sdk: PaseoSdk;
  agentId: string;
  /** The center's committed position; null before the agent's first batch. */
  base: Cursor | null;
  /** The agent's turn is active (running): its last row may still grow. */
  turnActive: boolean;
  startedAt: Date;
  pageLimit: number;
  budgetBytes?: number;
};

const sameEpoch = (a: Cursor | null, epoch: string) => a !== null && a.epoch === epoch;

async function fetchAfter(o: ReadOptions, cursor: Cursor): Promise<TimelinePage> {
  const page = await o.sdk.fetchTimeline(o.agentId, { direction: 'after', cursor, limit: o.pageLimit });
  if (page.error) throw new Error(`timeline of ${o.agentId}: ${page.error}`);
  return page;
}

/** The next batch after `base`, or null when there is nothing to deliver now. */
export async function nextBatch(o: ReadOptions): Promise<BatchPlan | null> {
  let reset: BatchV2['reset'] = null;
  let cursor: Cursor;
  let page: TimelinePage;
  if (o.base === null) {
    const tail = await o.sdk.fetchTimeline(o.agentId, { direction: 'tail', limit: 1 });
    if (tail.error) throw new Error(`timeline of ${o.agentId}: ${tail.error}`);
    cursor = { epoch: tail.epoch, seq: 0 };
    page = await fetchAfter(o, cursor);
  } else {
    cursor = o.base;
    page = await fetchAfter(o, cursor);
    if (page.staleCursor || page.reset || page.epoch !== cursor.epoch) {
      // The epoch was replaced: start the new one from its beginning.
      reset = { previous_epoch: o.base.epoch, reason: page.staleCursor ? 'stale_cursor' : 'replacement' };
      cursor = { epoch: page.epoch, seq: 0 };
      page = await fetchAfter(o, cursor);
      if (page.staleCursor || page.epoch !== cursor.epoch) throw new Error(`timeline of ${o.agentId} changed epoch again while re-reading it`);
    }
  }
  if (page.staleCursor && o.base === null) throw new Error(`timeline of ${o.agentId} changed epoch while starting`);

  const gaps: Gap[] = [];
  if (page.gap) gaps.push({ epoch: page.epoch, from_seq: cursor.seq + 1, to_seq: page.startCursor ? Math.max(cursor.seq + 1, page.startCursor.seq - 1) : null, reason: 'upstream_gap' });
  if (page.window.minSeq > cursor.seq + 1 && page.window.maxSeq > 0) {
    gaps.push({ epoch: page.epoch, from_seq: cursor.seq + 1, to_seq: page.window.minSeq - 1, reason: 'history_unavailable' });
  }

  const rows = page.entries;
  const budget = o.budgetBytes ?? BATCH_BUDGET_BYTES;
  const events: TimelineEvent[] = [];
  const filtered: Record<string, number> = {};
  let size = 0;
  const pageEnd: Cursor = page.endCursor && sameEpoch(page.endCursor, cursor.epoch) ? page.endCursor : cursor;
  let next: Cursor = pageEnd;
  let cutForSize = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const stopAt = { epoch: cursor.epoch, seq: Math.max(cursor.seq, row.seqStart - 1) };
    if (isUnsettled(row, i === rows.length - 1 && !page.hasNewer, o.turnActive)) {
      next = stopAt;
      break;
    }
    const n = normalizeEntry(row, page.epoch, o.startedAt);
    const bytes = 'event' in n ? JSON.stringify(n.event).length : 0;
    // Cut before this row if the batch is full, but only where the position still moves (else the same rows would be
    // read again forever); a cut that cannot move it takes the row along.
    if (events.length > 0 && size + bytes > budget && stopAt.seq > cursor.seq) {
      next = stopAt;
      cutForSize = true;
      break;
    }
    if ('event' in n) {
      events.push(n.event);
      size += bytes;
    } else {
      filtered[n.filtered] = (filtered[n.filtered] ?? 0) + 1;
    }
  }
  // Everything up to the end was delivered and nothing is held back: the position is the end of the last row (a row
  // that later gains seqs, e.g. a merged tool call finishing, has a seq above it and comes again).
  const deliveredAll = !cutForSize && !page.hasNewer && rows.length > 0 && next === pageEnd;
  if (deliveredAll) next = { epoch: cursor.epoch, seq: Math.max(next.seq, ...rows.map((r) => r.seqEnd)) };
  if (next.seq < cursor.seq) next = cursor;

  const moved = reset !== null || next.seq > cursor.seq || (o.base === null && rows.length > 0);
  if (events.length === 0 && gaps.length === 0 && !moved) return null;
  return {
    batch: {
      batch_id: `b-${randomUUID()}`,
      agent_id: o.agentId,
      base: o.base,
      next,
      reset,
      events,
      gaps,
      filtered,
    },
    progressed: moved,
    more: moved && (page.hasNewer || cutForSize),
  };
}
