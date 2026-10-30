import type { DatabaseSync } from 'node:sqlite';
import type { ChunkPush, LiveStatus, SnapshotPush, SnapshotSession } from '../shared/protocol.ts';
import { assignShortIds, parseSessionKey, pendingKey } from '../shared/session-key.ts';
import { transaction } from './db.ts';

/** A live session whose machine has not reported for longer than this is shown as offline. */
export const OFFLINE_AFTER_MS = 180000;

export type Lifecycle = 'live' | 'ended' | 'purged';

export type SessionRow = {
  key: string;
  agent_kind: string;
  native_id: string | null;
  machine: string;
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
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
};

export type SessionView = SessionRow & {
  short_id: string;
  effective_status: LiveStatus | 'ended' | 'purged' | 'offline';
  chunk_count: number;
};

const UPSERT_SESSION = `
  INSERT INTO sessions (
    key, agent_kind, native_id, machine, pane_id, terminal_id, workspace_id, tab_id, cwd, title,
    live_status, lifecycle, fidelity, transcript_path, first_seen, last_seen
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    agent_kind = excluded.agent_kind,
    native_id = excluded.native_id,
    machine = excluded.machine,
    pane_id = excluded.pane_id,
    terminal_id = excluded.terminal_id,
    workspace_id = excluded.workspace_id,
    tab_id = excluded.tab_id,
    cwd = excluded.cwd,
    title = excluded.title,
    live_status = excluded.live_status,
    lifecycle = 'live',
    fidelity = excluded.fidelity,
    transcript_path = excluded.transcript_path,
    merged_into = NULL,
    last_seen = excluded.last_seen
`;

/**
 * Applies one machine's snapshot atomically: heartbeat, upsert of reported sessions, ending of
 * sessions the machine no longer reports, predecessor links, pending merges and purges.
 */
export function applySnapshot(db: DatabaseSync, push: SnapshotPush, now: Date): void {
  const nowIso = now.toISOString();
  const machine = push.machine;

  // One session resumed in two panes may be reported twice; the last occurrence wins.
  const reported = new Map<string, SnapshotSession>();
  for (const s of push.sessions) reported.set(s.key, s);

  transaction(db, () => {
    // 1. Heartbeat.
    db.prepare(
      `INSERT INTO machines (label, last_heartbeat, collector_version) VALUES (?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET
         last_heartbeat = excluded.last_heartbeat, collector_version = excluded.collector_version`,
    ).run(machine, nowIso, push.collector_version);

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

    // Pending sessions still live before this snapshot are the only merge candidates (key → agent_kind).
    const livePending = new Map(
      (
        db
          .prepare(
            `SELECT key, agent_kind FROM sessions
             WHERE machine = ? AND lifecycle = 'live' AND merged_into IS NULL AND key LIKE 'pending:%'`,
          )
          .all(machine) as Array<{ key: string; agent_kind: string }>
      ).map((r) => [r.key, r.agent_kind]),
    );

    // 2. Upsert reported sessions as live.
    const upsert = db.prepare(UPSERT_SESSION);
    for (const s of reported.values()) {
      upsert.run(
        s.key, s.agent_kind, s.native_id, machine, s.pane_id, s.terminal_id, s.workspace_id, s.tab_id,
        s.cwd, s.title, s.live_status, s.fidelity, s.transcript_path, nowIso, nowIso,
      );
    }
    const restart = db.prepare('UPDATE sessions SET first_seen = ?, predecessor_key = NULL WHERE key = ?');
    for (const key of revived) restart.run(nowIso, key); // the upsert already cleared merged_into

    // 3. Live sessions of this machine that were not reported have ended.
    const ended = (
      db
        .prepare(
          `SELECT key, terminal_id FROM sessions
           WHERE machine = ? AND lifecycle = 'live' ORDER BY last_seen DESC, key`,
        )
        .all(machine) as Array<{ key: string; terminal_id: string }>
    ).filter((r) => !reported.has(r.key));
    const endSession = db.prepare(`UPDATE sessions SET lifecycle = 'ended' WHERE key = ?`);
    for (const r of ended) endSession.run(r.key);

    // 5. A native session of the same agent kind on the terminal of a live pending session is that
    //    session, now identified.
    const merged = new Set<string>();
    const moveChunks = db.prepare('UPDATE OR IGNORE chunks SET session_key = ? WHERE session_key = ?');
    const dropChunks = db.prepare('DELETE FROM chunks WHERE session_key = ?');
    const markMerged = db.prepare(
      `UPDATE sessions SET merged_into = ?, lifecycle = 'ended' WHERE key = ?`,
    );
    for (const s of reported.values()) {
      if (parseSessionKey(s.key).kind !== 'native') continue;
      const pending = pendingKey(machine, s.terminal_id);
      if (livePending.get(pending) !== s.agent_kind || reported.has(pending)) continue;
      moveChunks.run(s.key, pending);
      dropChunks.run(pending); // leftovers collided with chunks the native key already has
      markMerged.run(s.key, pending);
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

    // 6. Purged transcripts (only this machine's sessions, any lifecycle).
    const purge = db.prepare(`UPDATE sessions SET lifecycle = 'purged' WHERE key = ? AND machine = ?`);
    for (const key of push.purged) purge.run(key, machine);
  });
}

/** Stores one push atomically; chunks already stored at the same (session_key, offset_start) count as duplicates. */
export function insertChunks(
  db: DatabaseSync,
  push: ChunkPush,
  now: Date,
): { inserted: number; duplicates: number } {
  const receivedAt = now.toISOString();
  return transaction(db, () => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO chunks
         (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const c of push.chunks) {
      const { changes } = insert.run(
        c.session_key, c.kind, c.offset_start, c.offset_end, c.ts_start, c.ts_end, c.text,
        c.backfill ? 1 : 0, receivedAt,
      );
      inserted += Number(changes);
    }
    return { inserted, duplicates: push.chunks.length - inserted };
  });
}

/** Resume position for a transcript: max offset_end of its `transcript` chunks (screen chunks use timestamps). */
export function maxOffset(db: DatabaseSync, sessionKey: string): number | null {
  const row = db
    .prepare(`SELECT max(offset_end) AS m FROM chunks WHERE session_key = ? AND kind = 'transcript'`)
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
      (filter.machine === undefined || v.machine === filter.machine) &&
      (filter.lifecycle === undefined || v.lifecycle === filter.lifecycle),
  );
}

/** Sessions whose short id equals `shortId` or whose native id (terminal id if pending) starts with it. */
export function findByShortId(db: DatabaseSync, shortId: string, now: Date): SessionView[] {
  if (shortId === '') return [];
  return loadViews(db, now).filter((v) => v.short_id === shortId || shortIdSource(v.key).startsWith(shortId));
}

function shortIdSource(key: string): string {
  const parsed = parseSessionKey(key);
  return parsed.kind === 'native' ? parsed.nativeId : parsed.terminalId;
}

/** All sessions as views; short ids are computed over every session in the database. */
function loadViews(db: DatabaseSync, now: Date): SessionView[] {
  const rows = db
    .prepare(
      `SELECT s.*,
         (SELECT count(*) FROM chunks c WHERE c.session_key = s.key) AS chunk_count,
         m.last_heartbeat AS machine_heartbeat
       FROM sessions s LEFT JOIN machines m ON m.label = s.machine
       ORDER BY s.lifecycle = 'live' DESC, s.last_seen DESC, s.key`,
    )
    .all() as Array<SessionRow & { chunk_count: number; machine_heartbeat: string | null }>;
  const shortIds = assignShortIds(rows.map((r) => r.key));
  return rows.map(({ machine_heartbeat, ...row }) => ({
    ...row,
    short_id: shortIds.get(row.key)!,
    effective_status: effectiveStatus(row, machine_heartbeat, now),
  }));
}

function effectiveStatus(row: SessionRow, heartbeat: string | null, now: Date): SessionView['effective_status'] {
  if (row.lifecycle !== 'live') return row.lifecycle;
  if (heartbeat === null || now.getTime() - Date.parse(heartbeat) > OFFLINE_AFTER_MS) return 'offline';
  return row.live_status;
}
