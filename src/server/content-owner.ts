import type { DatabaseSync } from 'node:sqlite';
import type { TimelineEvent } from '../shared/ingest-v2.ts';
import { packLines, renderEvent } from './paseo-content.ts';

// Which source's content feeds the analysis of a session (`sessions.content_owner`), and the handover when that source
// stops observing it.
//
// The first source to deliver content owns the session; every other source's content is kept as standby evidence and
// not analysed, so the same work is never analysed twice. Ownership does not move on a heartbeat or a short outage.
// It moves only when the owner's observation has *ended* (herdr closed the pane, Paseo archived or closed the agent)
// while another source still observes the session live and delivers content: then that source takes over from a
// boundary, the end time of the content already analysed. Content up to the boundary stays standby (the previous owner
// covered it, in its own format; nothing is spliced), content after it is analysed, including what the new owner had
// already delivered as standby. Every handover is logged in `content_handovers`.

export type ContentRole = { role: 'owner' | 'standby'; since: string | null };

function liveObservation(db: DatabaseSync, key: string, sourceId: string): boolean {
  return db.prepare(`SELECT 1 FROM session_sources WHERE session_key = ? AND source_id = ? AND lifecycle = 'live'`).get(key, sourceId) !== undefined;
}

function latestHandover(db: DatabaseSync, key: string, sourceId: string): string | null {
  const row = db
    .prepare('SELECT boundary_ts FROM content_handovers WHERE session_key = ? AND to_source = ? ORDER BY id DESC LIMIT 1')
    .get(key, sourceId) as { boundary_ts: string | null } | undefined;
  return row?.boundary_ts ?? null;
}

/**
 * The role of `sourceId`'s content for session `key`, claiming or taking over ownership as described above. `since` is
 * the handover boundary when this source took over from another: its content up to then is standby. Runs inside the
 * caller's transaction.
 */
export function claimContentOwner(db: DatabaseSync, key: string, sourceId: string, nowIso: string): ContentRole {
  const row = db.prepare('SELECT content_owner FROM sessions WHERE key = ?').get(key) as { content_owner: string | null } | undefined;
  if (row === undefined) return { role: 'owner', since: null };
  if (row.content_owner === null) {
    // Chunks stored before the session row existed name their source; the first of them owns the session.
    const earlier = db
      .prepare('SELECT source_id FROM chunks WHERE session_key = ? AND source_id IS NOT NULL ORDER BY id LIMIT 1')
      .get(key) as { source_id: string } | undefined;
    const owner = earlier?.source_id ?? sourceId;
    db.prepare('UPDATE sessions SET content_owner = ? WHERE key = ?').run(owner, key);
    if (owner === sourceId) return { role: 'owner', since: null };
    return claimContentOwner(db, key, sourceId, nowIso);
  }
  if (row.content_owner === sourceId) return { role: 'owner', since: latestHandover(db, key, sourceId) };
  // Another source owns it. It keeps it while it observes the session (live), or while this one does not.
  const ownerObserves = db
    .prepare(`SELECT 1 FROM session_sources WHERE session_key = ? AND source_id = ? AND lifecycle IN ('live', 'untracked')`)
    .get(key, row.content_owner) !== undefined;
  if (ownerObserves || !liveObservation(db, key, sourceId)) return { role: 'standby', since: null };
  return handOver(db, key, row.content_owner, sourceId, nowIso);
}

function handOver(db: DatabaseSync, key: string, from: string, to: string, nowIso: string): ContentRole {
  const { b } = db.prepare('SELECT max(ts_end) AS b FROM chunks WHERE session_key = ?').get(key) as { b: string | null };
  db.prepare('UPDATE sessions SET content_owner = ? WHERE key = ?').run(to, key);
  db.prepare('INSERT INTO content_handovers (session_key, from_source, to_source, boundary_ts, at) VALUES (?, ?, ?, ?, ?)').run(key, from, to, b, nowIso);
  db.prepare('UPDATE session_sources SET identity_note = ? WHERE session_key = ? AND source_id = ?').run(
    `content_handover: took over from ${from} after ${b ?? 'the start'}`,
    key,
    to,
  );
  materializeStandby(db, key, to, b, nowIso);
  return { role: 'owner', since: b };
}

type StoredEvent = { id: number; kind: string; ts: string | null; text: string | null; meta: string | null; backfill: number; disposition: string };

/** Turns `to`'s standby evidence of `key` newer than `boundary` into chunks for the analysis, in order. */
function materializeStandby(db: DatabaseSync, key: string, to: string, boundary: string | null, nowIso: string): void {
  const herdr = to.startsWith('herdr:');
  // A herdr chunk counts by its end (as in `insertChunks`), a Paseo event by its own time.
  const endOf = (r: StoredEvent): string | null => (herdr ? ((JSON.parse(r.meta ?? '{}') as { ts_end?: string }).ts_end ?? r.ts) : r.ts);
  const rows = (
    db
      .prepare(`SELECT id, kind, ts, text, meta, backfill, disposition FROM source_events WHERE session_key = ? AND source_id = ? AND disposition = 'standby' ORDER BY ts, id`)
      .all(key, to) as StoredEvent[]
  ).filter((r) => {
    const end = endOf(r);
    return end !== null && (boundary === null || end > boundary);
  });
  if (rows.length === 0) return;
  const mark = db.prepare(`UPDATE source_events SET disposition = 'materialized' WHERE id = ?`);
  if (herdr) {
    // herdr standby evidence is chunk-shaped already.
    const insert = db.prepare(
      `INSERT OR IGNORE INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, received_at, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      const m = JSON.parse(r.meta ?? '{}') as { offset_start?: number; offset_end?: number; ts_end?: string };
      insert.run(key, r.kind, m.offset_start ?? null, m.offset_end ?? null, r.ts, m.ts_end ?? r.ts, r.text ?? '', r.backfill, nowIso, to);
      mark.run(r.id);
    }
    return;
  }
  const lines = rows.map((r) => {
    const m = JSON.parse(r.meta ?? '{}') as { item_type?: string; text_truncated?: TimelineEvent['text_truncated']; tool?: TimelineEvent['tool'] };
    const event = { kind: r.kind as TimelineEvent['kind'], ts: r.ts, text: r.text ?? '', text_truncated: m.text_truncated ?? null, tool: m.tool ?? null, item_type: m.item_type ?? r.kind };
    return { id: r.id, ts: r.ts, backfill: r.backfill, text: renderEvent(event) };
  });
  insertPaseoChunks(db, key, to, lines, nowIso);
  for (const r of rows) mark.run(r.id);
}

/** Packs rendered event lines into chunks (backfill and realtime apart) and links each chunk to its source events. */
export function insertPaseoChunks(
  db: DatabaseSync,
  key: string,
  sourceId: string,
  lines: Array<{ id: number; ts: string | null; backfill: number | boolean; text: string }>,
  nowIso: string,
  fallbackTs: string | null = null,
): void {
  const insertChunk = db.prepare(
    `INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, received_at, source_id)
     VALUES (?, 'transcript', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  );
  const link = db.prepare('INSERT INTO chunk_sources (chunk_id, source_event_id) VALUES (?, ?)');
  for (const backfill of [true, false]) {
    for (const group of packLines(lines.filter((l) => Boolean(l.backfill) === backfill))) {
      const known = group.map((l) => l.ts).filter((t): t is string => t !== null);
      const tsStart = known[0] ?? fallbackTs ?? nowIso;
      const tsEnd = known.at(-1) ?? tsStart;
      const { lastInsertRowid } = insertChunk.run(key, tsStart, tsEnd, group.map((l) => l.text).join('\n'), backfill ? 1 : 0, nowIso, sourceId);
      for (const l of group) link.run(Number(lastInsertRowid), l.id);
    }
  }
}

/**
 * After a snapshot changed who observes `key`: if its content owner no longer observes it live while another source
 * does and holds standby evidence of it, that source takes over now (rather than at its next batch).
 */
export function reconsiderOwner(db: DatabaseSync, key: string, nowIso: string): void {
  const row = db.prepare('SELECT content_owner FROM sessions WHERE key = ? AND merged_into IS NULL').get(key) as { content_owner: string | null } | undefined;
  if (row?.content_owner == null) return;
  const candidate = db
    .prepare(
      `SELECT o.source_id FROM session_sources o
       WHERE o.session_key = ? AND o.lifecycle = 'live' AND o.source_id != ?
         AND EXISTS (SELECT 1 FROM source_events e WHERE e.session_key = o.session_key AND e.source_id = o.source_id AND e.disposition = 'standby')
       ORDER BY o.last_seen DESC LIMIT 1`,
    )
    .get(key, row.content_owner) as { source_id: string } | undefined;
  if (candidate !== undefined) claimContentOwner(db, key, candidate.source_id, nowIso);
}
