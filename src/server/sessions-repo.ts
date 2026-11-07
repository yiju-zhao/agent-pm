import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChunkPush, LiveStatus, SnapshotPush, SnapshotSession } from '../shared/protocol.ts';
import { assignShortIds, parseSessionKey, pendingKey, shortIdSource } from '../shared/session-key.ts';
import { transaction } from './db.ts';

import { claimContentOwner, reconsiderOwner } from './content-owner.ts';
import { migrateSessionIdentity } from './session-identity.ts';
import {
  endObservation,
  ensureSessionRow,
  herdrSourceId,
  loadStatusContext,
  OFFLINE_AFTER_MS,
  refreshSession,
  statusIn,
  touchSource,
  upsertObservation,
} from './sources-repo.ts';
import type { EffectiveStatus, ObservationFields, SourceView } from './sources-repo.ts';

export { OFFLINE_AFTER_MS };

export type Lifecycle = 'live' | 'ended' | 'purged';

export type SessionRow = {
  key: string;
  agent_kind: string;
  native_id: string | null;
  machine: string;
  /** herdr location; null for a session only Paseo observes. */
  pane_id: string | null;
  terminal_id: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  cwd: string;
  title: string;
  live_status: LiveStatus;
  lifecycle: Lifecycle;
  fidelity: 'full' | 'screen';
  transcript_path: string | null;
  predecessor_key: string | null;
  merged_into: string | null;
  ignored: number;
  first_seen: string;
  last_seen: string;
  /** When live_status or lifecycle last changed; null for sessions that predate schema v3 and have not changed since. */
  status_changed_at: string | null;
  /** The source whose content feeds the analysis (see `claimContentOwner`); null before any content arrived. */
  content_owner: string | null;
};

export type SessionView = SessionRow & {
  short_id: string;
  effective_status: EffectiveStatus;
  chunk_count: number;
  /** Every source's observation of this session (herdr, Paseo), with its freshness and content role. */
  sources: SourceView[];
};

function herdrObservation(machine: string, s: SnapshotSession): ObservationFields {
  return {
    source_id: herdrSourceId(machine),
    external_id: s.key,
    session_key: s.key,
    provider: s.agent_kind,
    native_id: s.native_id,
    native_id_origin: s.native_id === null ? null : 'herdr',
    machine,
    pane_id: s.pane_id,
    terminal_id: s.terminal_id,
    workspace_id: s.workspace_id,
    tab_id: s.tab_id,
    cwd: s.cwd,
    title: s.title,
    fidelity: s.fidelity,
    transcript_path: s.transcript_path,
    live_status: s.live_status,
    raw_status: s.live_status,
    attention: null,
    lifecycle: 'live',
    end_reason: null,
    content_state: null,
  };
}

/**
 * Applies one machine's herdr snapshot atomically: heartbeat of the machine's herdr source, the source's observations of
 * the reported sessions, ending of the observations this source no longer reports (other sources' observations of the
 * same sessions, e.g. Paseo's, are untouched, so a session ends only when every source ended it), predecessor links,
 * pending merges and purges. Each touched session's projection is recomputed from all of its sources at the end.
 */
export function applySnapshot(db: DatabaseSync, push: SnapshotPush, now: Date): void {
  const nowIso = now.toISOString();
  const machine = push.machine;
  const sourceId = herdrSourceId(machine);

  // One session resumed in two panes may be reported twice; the last occurrence wins.
  const reported = new Map<string, SnapshotSession>();
  for (const s of push.sessions) reported.set(s.key, s);
  const touched = new Set<string>(reported.keys());

  transaction(db, () => {
    // 1. Heartbeat: the legacy machine row and the machine's herdr source.
    db.prepare(
      `INSERT INTO machines (label, last_heartbeat, collector_version) VALUES (?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET
         last_heartbeat = excluded.last_heartbeat, collector_version = excluded.collector_version`,
    ).run(machine, nowIso, push.collector_version);
    touchSource(db, { source_id: sourceId, kind: 'herdr', machine, collector_version: push.collector_version }, nowIso);
    db.prepare('UPDATE ingest_sources SET last_snapshot_at = ? WHERE source_id = ?').run(nowIso, sourceId);

    // "New" = not in the DB before this snapshot, or a revived pending key (Ruling R7: herdr reuses
    // pending:<machine>:<terminal> for every id-less session on a terminal, so a pending row that is
    // no longer live, or was merged, now stands for a different session).
    const existing = db.prepare('SELECT lifecycle, merged_into FROM sessions WHERE key = ?');
    const newKeys = new Set<string>();
    const revived = new Set<string>();
    for (const key of reported.keys()) {
      const prev = existing.get(key) as { lifecycle: string; merged_into: string | null } | undefined;
      if (prev === undefined) {
        newKeys.add(key);
      } else if (parseSessionKey(key).kind === 'pending' && (prev.lifecycle !== 'live' || prev.merged_into !== null)) {
        newKeys.add(key);
        revived.add(key);
      }
    }

    // Pending sessions this source still had live before this snapshot are the only merge candidates (key → agent_kind).
    const livePending = new Map(
      (
        db
          .prepare(
            `SELECT o.external_id AS key, o.provider AS agent_kind FROM session_sources o JOIN sessions s ON s.key = o.session_key
             WHERE o.source_id = ? AND o.lifecycle = 'live' AND s.merged_into IS NULL AND o.external_id LIKE 'pending:%'`,
          )
          .all(sourceId) as Array<{ key: string; agent_kind: string }>
      ).map((r) => [r.key, r.agent_kind]),
    );

    // 2. This source's observations of the reported sessions; rows for keys seen for the first time.
    const revive = db.prepare('UPDATE sessions SET merged_into = NULL, lifecycle = ?, status_changed_at = ? WHERE key = ? AND merged_into IS NOT NULL');
    for (const s of reported.values()) {
      const o = herdrObservation(machine, s);
      ensureSessionRow(db, s.key, o, nowIso);
      revive.run('ended', nowIso, s.key);
      upsertObservation(db, o, nowIso);
    }
    const restart = db.prepare('UPDATE sessions SET first_seen = ?, predecessor_key = NULL WHERE key = ?');
    for (const key of revived) restart.run(nowIso, key);

    // 3. Observations of this source that it no longer reports have ended (this source's only).
    const ended = (
      db
        .prepare(
          `SELECT external_id AS key, terminal_id FROM session_sources
           WHERE source_id = ? AND lifecycle = 'live' ORDER BY last_seen DESC, external_id`,
        )
        .all(sourceId) as Array<{ key: string; terminal_id: string }>
    ).filter((r) => !reported.has(r.key));
    for (const r of ended) {
      endObservation(db, sourceId, r.key, 'ended', 'absent', nowIso);
      touched.add(r.key);
    }

    // 5. A native session of the same agent kind on the terminal of a live pending session is that
    //    session, now identified.
    const merged = new Set<string>();
    for (const s of reported.values()) {
      if (parseSessionKey(s.key).kind !== 'native') continue;
      const pending = pendingKey(machine, s.terminal_id);
      if (livePending.get(pending) !== s.agent_kind || reported.has(pending)) continue;
      migrateSessionIdentity(db, pending, s.key, nowIso);
      db.prepare(`UPDATE session_sources SET lifecycle = 'ended', end_reason = 'merged', status_changed_at = ? WHERE source_id = ? AND external_id = ?`).run(
        nowIso, sourceId, pending,
      );
      livePending.delete(pending);
      merged.add(pending);
    }

    // 4. A new session on the terminal of a session that just ended succeeds it (Ruling R3: a
    //    merged pending session is the same session, never a predecessor).
    const setPredecessor = db.prepare('UPDATE sessions SET predecessor_key = ? WHERE key = ?');
    for (const key of newKeys) {
      const terminal = reported.get(key)!.terminal_id;
      const predecessor = ended.find((r) => r.terminal_id === terminal && !merged.has(r.key));
      if (predecessor) setPredecessor.run(predecessor.key, key);
    }

    // 6. Purged transcripts (only this source's observations, any lifecycle).
    for (const key of push.purged) {
      const has = db.prepare('SELECT 1 FROM session_sources WHERE source_id = ? AND external_id = ?').get(sourceId, key);
      if (has === undefined) continue;
      endObservation(db, sourceId, key, 'purged', 'transcript_deleted', nowIso);
      touched.add(key);
    }

    // 7. Every touched session's projection, from all of its sources.
    const sessionOf = db.prepare('SELECT session_key FROM session_sources WHERE source_id = ? AND external_id = ?');
    const keys = new Set<string>();
    for (const key of touched) {
      const r = sessionOf.get(sourceId, key) as { session_key: string } | undefined;
      keys.add(r?.session_key ?? key);
    }
    for (const key of keys) {
      refreshSession(db, key, nowIso);
      reconsiderOwner(db, key, nowIso);
    }
  });
}

/** How many `merged_into` links `mergeTarget` follows. */
const MAX_MERGE_HOPS = 5;

/**
 * The key a session is known by now: follows `merged_into` (a pending key whose session got its native id) at most 5
 * hops, so a cycle cannot loop. A key that is not a session, or was not merged, comes back as it is.
 */
export function mergeTarget(db: DatabaseSync, key: string): string {
  const mergedInto = db.prepare('SELECT merged_into FROM sessions WHERE key = ?');
  let target = key;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    const row = mergedInto.get(target) as { merged_into: string | null } | undefined;
    if (row?.merged_into == null) break;
    target = row.merged_into;
  }
  return target;
}

/**
 * Stores one herdr push atomically. Every chunk is first received for the machine's herdr source; then, if that source
 * owns the session's content (`./content-owner.ts`), it is stored as a chunk (and so queued for analysis), deduped on
 * (session_key, offset_start); otherwise it is kept as standby evidence of the source only. Either way the source's
 * byte checkpoint moves to the furthest transcript offset received, so `/ingest/offset` never asks for standby content
 * again. Chunks pushed under a key that was merged into another (a pending key whose session got its native id) are
 * stored under the merge target, so they stay with the session they belong to.
 */
export function insertChunks(
  db: DatabaseSync,
  push: ChunkPush,
  now: Date,
): { inserted: number; duplicates: number } {
  const receivedAt = now.toISOString();
  const sourceId = herdrSourceId(push.machine);
  return transaction(db, () => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO chunks
         (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, received_at, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const standby = db.prepare(
      `INSERT OR IGNORE INTO source_events
         (source_id, stream_id, event_key, content_hash, revision, session_key, kind, ts, ts_known, backfill, received_at,
          text, meta, disposition)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?, ?, ?, 'standby')`,
    );
    const checkpoint = db.prepare(
      `INSERT INTO source_offsets (source_id, session_key, offset_end, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id, session_key) DO UPDATE SET
         offset_end = max(offset_end, excluded.offset_end), updated_at = excluded.updated_at`,
    );
    const targets = new Map<string, { key: string; role: 'owner' | 'standby'; since: string | null }>();
    const targetOf = (key: string) => {
      let target = targets.get(key);
      if (target === undefined) {
        const merged = mergeTarget(db, key);
        target = { key: merged, ...claimContentOwner(db, merged, sourceId, receivedAt) };
        targets.set(key, target);
      }
      return target;
    };
    let inserted = 0;
    for (const c of push.chunks) {
      const { key, role, since } = targetOf(c.session_key);
      let changes: number | bigint;
      // After a handover, what the previous owner already covered stays standby.
      if (role === 'owner' && (since === null || c.ts_end > since)) {
        ({ changes } = insert.run(
          key, c.kind, c.offset_start, c.offset_end, c.ts_start, c.ts_end, c.text, c.backfill ? 1 : 0, receivedAt, sourceId,
        ));
      } else {
        ({ changes } = standby.run(
          sourceId, key, `off:${c.kind}:${c.offset_start}`, createHash('sha256').update(c.text).digest('hex'), key, c.kind,
          c.ts_start, c.backfill ? 1 : 0, receivedAt, c.text,
          JSON.stringify({ offset_start: c.offset_start, offset_end: c.offset_end, ts_end: c.ts_end }),
        ));
      }
      inserted += Number(changes);
      if (c.kind === 'transcript') checkpoint.run(sourceId, key, c.offset_end, receivedAt);
    }
    return { inserted, duplicates: push.chunks.length - inserted };
  });
}

/**
 * Resume position for a transcript, a byte offset. With `sourceId`, that herdr source's own checkpoint: what it pushed
 * and the center received, materialized or kept as standby. Without one, or when the source has no checkpoint for the
 * key (data that predates sources), the max offset_end of the key's herdr `transcript` chunks (screen chunks use
 * timestamps, Paseo chunks have no byte offsets).
 */
export function maxOffset(db: DatabaseSync, sessionKey: string, sourceId?: string): number | null {
  if (sourceId !== undefined) {
    const row = db.prepare('SELECT offset_end FROM source_offsets WHERE source_id = ? AND session_key = ?').get(sourceId, sessionKey) as
      | { offset_end: number }
      | undefined;
    if (row !== undefined) return row.offset_end;
  }
  const row = db
    .prepare(
      `SELECT max(offset_end) AS m FROM chunks
       WHERE session_key = ? AND kind = 'transcript' AND (source_id IS NULL OR source_id LIKE 'herdr:%')`,
    )
    .get(sessionKey) as { m: number | null };
  return row.m;
}

/** Sessions ordered live first, then most recently seen. */
export function listSessions(
  db: DatabaseSync,
  filter: { machine?: string; lifecycle?: string },
  now: Date,
): SessionView[] {
  return loadViews(db, now).filter(
    (v) =>
      (filter.machine === undefined || v.machine === filter.machine || v.sources.some((o) => o.machine === filter.machine)) &&
      (filter.lifecycle === undefined || v.lifecycle === filter.lifecycle),
  );
}

/** One session as a view, found by the key it is known by now (`mergeTarget`); `null` when there is no such session. */
export function getSession(db: DatabaseSync, key: string, now: Date): SessionView | null {
  const target = mergeTarget(db, key);
  return loadViews(db, now).find((v) => v.key === target) ?? null;
}

/** Sessions whose short id equals `shortId` or whose native id (terminal id if pending) starts with it. */
export function findByShortId(db: DatabaseSync, shortId: string, now: Date): SessionView[] {
  if (shortId === '') return [];
  return loadViews(db, now).filter((v) => v.short_id === shortId || shortIdSource(v.key).startsWith(shortId));
}

/** All sessions as views; short ids are computed over every session in the database. */
function loadViews(db: DatabaseSync, now: Date): SessionView[] {
  const rows = db
    .prepare(
      `SELECT s.*, (SELECT count(*) FROM chunks c WHERE c.session_key = s.key) AS chunk_count
       FROM sessions s
       ORDER BY s.lifecycle = 'live' DESC, s.last_seen DESC, s.key`,
    )
    .all() as Array<SessionRow & { chunk_count: number }>;
  const shortIds = assignShortIds(rows.map((r) => r.key));
  const ctx = loadStatusContext(db, now);
  return rows.map((row) => ({
    ...row,
    short_id: shortIds.get(row.key)!,
    effective_status: statusIn(ctx, row, now),
    sources: ctx.observations.get(row.key) ?? [],
  }));
}
