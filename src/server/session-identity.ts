import type { DatabaseSync } from 'node:sqlite';
import { crossMachineKey, makeSessionKey, parseSessionKey, paseoPendingKey } from '../shared/session-key.ts';

// Who a session is, across sources. Collectors never build a central key for another source; the center resolves
// Paseo agents to keys here, and moves everything that hangs off a key when a temporary identity becomes a native one.

/**
 * Moves a session that was known by a temporary key (`fromKey`) onto the key it turned out to have (`toKey`), in the
 * caller's transaction: chunks, digests, project links, questions, an ignore, source observations and source events
 * follow; the old row is marked `merged_into` and ended, so old short ids and evidence refs still resolve; a missing
 * predecessor is inherited. Chunk offsets that collide with ones the target already has are dropped (the target's are
 * the same bytes), and so are project links the target already has (the target's row wins).
 *
 * When both keys already had content from different sources, the moved, not yet analysed chunks are kept as evidence
 * only (marked processed): the target's content owner already covers that conversation, and replaying the other side to
 * the model would analyse the same work twice. The observation that brought them is noted for review.
 */
export function migrateSessionIdentity(db: DatabaseSync, fromKey: string, toKey: string, nowIso: string): { overlapChunks: number } {
  if (fromKey === toKey) return { overlapChunks: 0 };
  const from = db.prepare('SELECT * FROM sessions WHERE key = ?').get(fromKey) as Record<string, unknown> | undefined;
  if (from === undefined) return { overlapChunks: 0 };
  const to = db.prepare('SELECT key, content_owner FROM sessions WHERE key = ?').get(toKey) as
    | { key: string; content_owner: string | null }
    | undefined;
  if (to === undefined) {
    // The target is new: it starts as a copy of the session it was before.
    const cols = Object.keys(from).filter((c) => c !== 'key' && c !== 'merged_into' && c !== 'predecessor_key');
    db.prepare(
      `INSERT INTO sessions (key, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM sessions WHERE key = ?`,
    ).run(toKey, fromKey);
  }

  const fromOwner = (from.content_owner as string | null) ?? null;
  const toOwner = to?.content_owner ?? null;
  const toHasContent = to !== undefined && db.prepare('SELECT 1 FROM chunks WHERE session_key = ? LIMIT 1').get(toKey) !== undefined;
  let overlapChunks = 0;
  if (fromOwner !== null && toOwner !== null && fromOwner !== toOwner && toHasContent) {
    overlapChunks = Number(db.prepare('UPDATE chunks SET digested = 1 WHERE session_key = ? AND digested = 0').run(fromKey).changes);
    db.prepare(
      `UPDATE session_sources SET identity_note = ? WHERE session_key = ? AND source_id = ?`,
    ).run(`late_identity_overlap: content before ${nowIso} kept as evidence, not analysed again`, fromKey, fromOwner);
  } else if (toOwner === null && fromOwner !== null) {
    db.prepare('UPDATE sessions SET content_owner = ? WHERE key = ?').run(fromOwner, toKey);
  }

  db.prepare('UPDATE OR IGNORE chunks SET session_key = ? WHERE session_key = ?').run(toKey, fromKey);
  db.prepare('DELETE FROM chunks WHERE session_key = ?').run(fromKey);
  db.prepare('UPDATE digests SET session_key = ? WHERE session_key = ?').run(toKey, fromKey);
  // Project links and questions follow the session. This is a key rename, not a change to project state, so it is
  // written here directly and logs no event.
  db.prepare('UPDATE OR IGNORE contributions SET session_key = ? WHERE session_key = ?').run(toKey, fromKey);
  db.prepare('DELETE FROM contributions WHERE session_key = ?').run(fromKey);
  db.prepare('UPDATE questions SET session_key = ? WHERE session_key = ?').run(toKey, fromKey);
  db.prepare('UPDATE session_sources SET session_key = ? WHERE session_key = ?').run(toKey, fromKey);
  db.prepare('UPDATE source_events SET session_key = ? WHERE session_key = ?').run(toKey, fromKey);
  db.prepare('UPDATE OR IGNORE source_offsets SET session_key = ? WHERE session_key = ?').run(toKey, fromKey);
  db.prepare('DELETE FROM source_offsets WHERE session_key = ?').run(fromKey);
  // An ignore carries over; an ignore the target already has is never cleared.
  db.prepare('UPDATE sessions SET ignored = 1 WHERE key = ? AND EXISTS (SELECT 1 FROM sessions WHERE key = ? AND ignored = 1)').run(toKey, fromKey);
  db.prepare(
    `UPDATE sessions SET predecessor_key = COALESCE(predecessor_key, (SELECT predecessor_key FROM sessions WHERE key = ?)) WHERE key = ?`,
  ).run(fromKey, toKey);
  // Sessions that named the old key as their predecessor now name the new one.
  db.prepare('UPDATE sessions SET predecessor_key = ? WHERE predecessor_key = ? AND key != ?').run(toKey, fromKey, toKey);
  db.prepare(`UPDATE sessions SET merged_into = ?, lifecycle = 'ended', status_changed_at = ? WHERE key = ?`).run(toKey, nowIso, fromKey);
  return { overlapChunks };
}

export type PaseoIdentity = {
  key: string;
  /** Set when the native key was kept apart or a link is doubtful; shown on the observation for review. */
  note: string | null;
};

/**
 * The central key of a Paseo agent `{serverId, agentId}` observed on `machine`:
 *  - with a provider session id: `<provider>:<native id>`, shared with any other source on the same machine that sees
 *    that provider session (herdr included). If that key already belongs to a session observed on another machine, the
 *    agent gets its own `crossMachineKey` instead; it is never merged across machines.
 *  - without one (yet): `paseo-pending:<serverId>:<agentId>`, or whatever key the agent already has.
 * A different cwd than the other sources of the same key links anyway, with a note for review: the native id is the
 * identity, cwd is only a hint. Titles and text are never used.
 */
export function resolvePaseoKey(
  db: DatabaseSync,
  a: { sourceId: string; serverId: string; agentId: string; machine: string; provider: string; nativeId: string | null; cwd: string; currentKey: string | null },
): PaseoIdentity {
  if (a.nativeId === null) {
    if (a.currentKey !== null) return { key: a.currentKey, note: null };
    return { key: paseoPendingKey(a.serverId, a.agentId), note: null };
  }
  const base = makeSessionKey(a.provider, a.nativeId);
  // The agent already sits on this native id (plain or kept apart): stay there.
  if (a.currentKey !== null && (a.currentKey === base || a.currentKey.startsWith(`${base}@`))) return { key: a.currentKey, note: null };
  const others = db
    .prepare('SELECT source_id, machine, cwd FROM session_sources WHERE session_key = ? AND source_id != ?')
    .all(base, a.sourceId) as Array<{ source_id: string; machine: string | null; cwd: string | null }>;
  const legacy = db.prepare('SELECT machine FROM sessions WHERE key = ?').get(base) as { machine: string | null } | undefined;
  const otherMachines = new Set(others.map((o) => o.machine).filter((m): m is string => m !== null && m !== ''));
  if (others.length === 0 && legacy?.machine) otherMachines.add(legacy.machine);
  otherMachines.delete(a.machine);
  if (otherMachines.size > 0) {
    return { key: crossMachineKey(a.provider, a.nativeId, a.machine), note: `cross_machine: ${base} is also observed on ${[...otherMachines].sort().join(', ')}` };
  }
  const cwds = new Set(others.map((o) => o.cwd).filter((c): c is string => c !== null && c !== '' && c !== a.cwd));
  return { key: base, note: cwds.size > 0 ? `cwd_mismatch: other sources report ${[...cwds].sort().join(', ')}` : null };
}

/** Whether a key is a temporary identity (herdr or Paseo pending) that a native key may replace. */
export function isTemporaryKey(key: string): boolean {
  try {
    return parseSessionKey(key).kind !== 'native';
  } catch {
    return false;
  }
}
