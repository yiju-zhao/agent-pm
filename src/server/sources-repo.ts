import type { DatabaseSync } from 'node:sqlite';
import type { LiveStatus } from '../shared/protocol.ts';

// Ingestion sources and their observations of sessions.
//
// A source is one collector's view: `herdr:<machine>` for the herdr collector of a machine, a configured id for a Paseo
// collector of one daemon. Each source keeps its own heartbeat and its own observation of each session it sees
// (`session_sources`); a snapshot from one source only ever ends that source's observations. `sessions` stays the
// logical session: its status columns are the projection of its sources (`refreshSession`), and what a session shows
// as right now (`effectiveStatus`) is decided by one rule here, used by `/sessions`, the scheduler and the change feed.

/** A source (or a session observation) that has not reported for longer than this is not fresh; its sessions show as offline. */
export const OFFLINE_AFTER_MS = 180000;

export type SourceKind = 'herdr' | 'paseo';
export type ObservationLifecycle = 'live' | 'ended' | 'purged' | 'untracked';
export type EffectiveStatus = LiveStatus | 'ended' | 'purged' | 'offline';

/** The source a legacy (herdr) collector token of `machine` writes as. */
export function herdrSourceId(machine: string): string {
  return `herdr:${machine}`;
}

export type SourceRow = {
  source_id: string;
  kind: SourceKind;
  machine: string;
  server_id: string | null;
  collector_version: string | null;
  collector_heartbeat: string | null;
  daemon_status: string | null;
  daemon_error: string | null;
  daemon_checked_at: string | null;
  last_snapshot_at: string | null;
  diagnostics: string | null;
};

export type SessionSourceRow = {
  source_id: string;
  external_id: string;
  session_key: string;
  provider: string | null;
  native_id: string | null;
  native_id_origin: string | null;
  machine: string | null;
  pane_id: string | null;
  terminal_id: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  cwd: string | null;
  title: string | null;
  fidelity: string | null;
  transcript_path: string | null;
  live_status: LiveStatus;
  raw_status: string | null;
  attention: string | null;
  lifecycle: ObservationLifecycle;
  end_reason: string | null;
  content_state: string | null;
  identity_note: string | null;
  first_seen: string | null;
  last_seen: string | null;
  status_changed_at: string | null;
};

/** One source's observation of a session, as the API shows it. */
export type SourceView = {
  source_id: string;
  kind: SourceKind;
  machine: string | null;
  external_id: string;
  provider: string | null;
  native_id: string | null;
  native_id_origin: string | null;
  live_status: LiveStatus;
  raw_status: string | null;
  attention: string | null;
  lifecycle: ObservationLifecycle;
  end_reason: string | null;
  last_seen: string | null;
  /** The observation is live, its source is alive (and its daemon connected) and it was reported recently. */
  fresh: boolean;
  collector_alive: boolean;
  daemon_status: string | null;
  /** `owner`: its content feeds the analysis; `standby`: kept as evidence only; `null`: no content owner yet. */
  content_role: 'owner' | 'standby' | null;
  content_state: string | null;
  identity_note: string | null;
  /** Paseo: the last committed timeline position; herdr: null. */
  checkpoint: { epoch: string | null; seq: number | null } | null;
  /** Recorded content gaps of this observation (unrecoverable or unverified ranges). */
  gaps: number;
};

function within(iso: string | null, now: Date): boolean {
  return iso !== null && now.getTime() - Date.parse(iso) <= OFFLINE_AFTER_MS;
}

/** Whether the collector of a source reported recently, and (for Paseo) whether it is connected to its daemon. */
export function sourceHealth(src: Pick<SourceRow, 'kind' | 'collector_heartbeat' | 'daemon_status'>, now: Date): { collectorAlive: boolean; daemonOk: boolean } {
  const collectorAlive = within(src.collector_heartbeat, now);
  return { collectorAlive, daemonOk: src.kind !== 'paseo' || src.daemon_status === 'connected' };
}

/** Herdr reports `done`; Paseo has no such state. Earlier in the list wins. */
const STATUS_PRIORITY: LiveStatus[] = ['working', 'blocked', 'done', 'idle', 'unknown'];

/** The status several observations add up to: working beats blocked beats done beats idle beats unknown. */
export function combineStatuses(statuses: LiveStatus[]): LiveStatus | null {
  for (const s of STATUS_PRIORITY) if (statuses.includes(s)) return s;
  return null;
}

type ObservationInput = { lifecycle: ObservationLifecycle; live_status: LiveStatus; fresh: boolean };

/**
 * What a session shows as. Not live (every source ended or purged it): its lifecycle. Live with observations: the
 * combined status of the fresh live ones, `offline` when none is fresh (a silent collector, a disconnected daemon, a
 * stale observation, or a source that stopped tracking it). A session without any source (rows that predate sources,
 * `report:` keys) keeps the old machine-heartbeat rule.
 */
export function effectiveStatus(
  row: { lifecycle: string; live_status: LiveStatus },
  observations: ObservationInput[],
  legacyHeartbeat: string | null,
  now: Date,
): EffectiveStatus {
  if (row.lifecycle !== 'live') return row.lifecycle as EffectiveStatus;
  if (observations.length === 0) return within(legacyHeartbeat, now) ? row.live_status : 'offline';
  const fresh = observations.filter((o) => o.lifecycle === 'live' && o.fresh).map((o) => o.live_status);
  return combineStatuses(fresh) ?? 'offline';
}

/** Every source and observation, read once, for computing many sessions' status and source views. */
export type StatusContext = {
  sources: Map<string, SourceRow>;
  observations: Map<string, SourceView[]>;
  machineHeartbeats: Map<string, string | null>;
  contentOwners: Map<string, string | null>;
};

export function loadStatusContext(db: DatabaseSync, now: Date): StatusContext {
  const sources = new Map(
    (db.prepare('SELECT * FROM ingest_sources').all() as SourceRow[]).map((s) => [s.source_id, s]),
  );
  const owners = new Map(
    (db.prepare('SELECT key, content_owner FROM sessions').all() as Array<{ key: string; content_owner: string | null }>).map((r) => [
      r.key,
      r.content_owner,
    ]),
  );
  const streams = new Map(
    (db.prepare('SELECT source_id, stream_id, epoch, seq FROM ingest_streams').all() as Array<{ source_id: string; stream_id: string; epoch: string | null; seq: number | null }>).map(
      (r) => [`${r.source_id}\u0000${r.stream_id}`, r],
    ),
  );
  const gaps = new Map(
    (db.prepare('SELECT source_id, stream_id, count(*) AS n FROM ingest_gaps GROUP BY source_id, stream_id').all() as Array<{ source_id: string; stream_id: string; n: number }>).map(
      (r) => [`${r.source_id}\u0000${r.stream_id}`, r.n],
    ),
  );
  const observations = new Map<string, SourceView[]>();
  for (const o of db.prepare('SELECT * FROM session_sources ORDER BY source_id, external_id').all() as SessionSourceRow[]) {
    const src = sources.get(o.source_id);
    const kind = (src?.kind ?? 'herdr') as SourceKind;
    const health = src ? sourceHealth(src, now) : { collectorAlive: false, daemonOk: false };
    const owner = owners.get(o.session_key) ?? null;
    const streamKey = `${o.source_id}\u0000${o.external_id}`;
    const stream = streams.get(streamKey);
    const view: SourceView = {
      source_id: o.source_id,
      kind,
      machine: o.machine ?? src?.machine ?? null,
      external_id: o.external_id,
      provider: o.provider,
      native_id: o.native_id,
      native_id_origin: o.native_id_origin,
      live_status: o.live_status,
      raw_status: o.raw_status,
      attention: o.attention,
      lifecycle: o.lifecycle,
      end_reason: o.end_reason,
      last_seen: o.last_seen,
      fresh: o.lifecycle === 'live' && health.collectorAlive && health.daemonOk && within(o.last_seen, now),
      collector_alive: health.collectorAlive,
      daemon_status: src?.daemon_status ?? null,
      content_role: owner === null ? null : owner === o.source_id ? 'owner' : 'standby',
      content_state: o.content_state,
      identity_note: o.identity_note,
      checkpoint: kind === 'paseo' ? { epoch: stream?.epoch ?? null, seq: stream?.seq ?? null } : null,
      gaps: gaps.get(streamKey) ?? 0,
    };
    const list = observations.get(o.session_key);
    if (list) list.push(view);
    else observations.set(o.session_key, [view]);
  }
  const machineHeartbeats = new Map(
    (db.prepare('SELECT label, last_heartbeat FROM machines').all() as Array<{ label: string; last_heartbeat: string | null }>).map((r) => [
      r.label,
      r.last_heartbeat,
    ]),
  );
  return { sources, observations, machineHeartbeats, contentOwners: owners };
}

/** The status of one session row under a loaded context. */
export function statusIn(ctx: StatusContext, row: { key: string; lifecycle: string; live_status: LiveStatus; machine: string | null }, now: Date): EffectiveStatus {
  return effectiveStatus(row, ctx.observations.get(row.key) ?? [], ctx.machineHeartbeats.get(row.machine ?? '') ?? null, now);
}

/** The status of one session, reading only what that session needs. */
export function sessionEffectiveStatus(db: DatabaseSync, key: string, now: Date): EffectiveStatus | null {
  const row = db.prepare('SELECT key, lifecycle, live_status, machine FROM sessions WHERE key = ?').get(key) as
    | { key: string; lifecycle: string; live_status: LiveStatus; machine: string | null }
    | undefined;
  if (row === undefined) return null;
  const obs = db
    .prepare(
      `SELECT o.lifecycle, o.live_status, o.last_seen, s.kind, s.collector_heartbeat, s.daemon_status
       FROM session_sources o LEFT JOIN ingest_sources s ON s.source_id = o.source_id WHERE o.session_key = ?`,
    )
    .all(key) as Array<{ lifecycle: ObservationLifecycle; live_status: LiveStatus; last_seen: string | null; kind: SourceKind | null; collector_heartbeat: string | null; daemon_status: string | null }>;
  const inputs = obs.map((o) => {
    const health = o.kind === null ? { collectorAlive: false, daemonOk: false } : sourceHealth({ kind: o.kind, collector_heartbeat: o.collector_heartbeat, daemon_status: o.daemon_status }, now);
    return { lifecycle: o.lifecycle, live_status: o.live_status, fresh: o.lifecycle === 'live' && health.collectorAlive && health.daemonOk && within(o.last_seen, now) };
  });
  const hb = db.prepare('SELECT last_heartbeat FROM machines WHERE label = ?').get(row.machine ?? '') as { last_heartbeat: string | null } | undefined;
  return effectiveStatus(row, inputs, hb?.last_heartbeat ?? null, now);
}

// ---- writes -------------------------------------------------------------------------------------------------------

/** Creates or refreshes a source's registration and records a collector heartbeat. */
export function touchSource(
  db: DatabaseSync,
  src: { source_id: string; kind: SourceKind; machine: string; server_id?: string | null; collector_version: string },
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO ingest_sources (source_id, kind, machine, server_id, collector_version, collector_heartbeat)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       kind = excluded.kind, machine = excluded.machine, server_id = coalesce(excluded.server_id, server_id),
       collector_version = excluded.collector_version, collector_heartbeat = excluded.collector_heartbeat`,
  ).run(src.source_id, src.kind, src.machine, src.server_id ?? null, src.collector_version, nowIso);
}

export type ObservationFields = {
  source_id: string;
  external_id: string;
  session_key: string;
  provider: string;
  native_id: string | null;
  native_id_origin: string | null;
  machine: string;
  pane_id: string | null;
  terminal_id: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  cwd: string;
  title: string;
  fidelity: string;
  transcript_path: string | null;
  live_status: LiveStatus;
  raw_status: string | null;
  attention: string | null;
  lifecycle: ObservationLifecycle;
  end_reason: string | null;
  content_state: string | null;
};

/** Writes one source's current observation of a session; `status_changed_at` moves only when status or lifecycle changed. */
export function upsertObservation(db: DatabaseSync, o: ObservationFields, nowIso: string): void {
  db.prepare(
    `INSERT INTO session_sources (
       source_id, external_id, session_key, provider, native_id, native_id_origin, machine, pane_id, terminal_id,
       workspace_id, tab_id, cwd, title, fidelity, transcript_path, live_status, raw_status, attention, lifecycle,
       end_reason, content_state, first_seen, last_seen, status_changed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, external_id) DO UPDATE SET
       session_key = excluded.session_key, provider = excluded.provider, native_id = excluded.native_id,
       native_id_origin = excluded.native_id_origin, machine = excluded.machine, pane_id = excluded.pane_id,
       terminal_id = excluded.terminal_id, workspace_id = excluded.workspace_id, tab_id = excluded.tab_id,
       cwd = excluded.cwd, title = excluded.title, fidelity = excluded.fidelity, transcript_path = excluded.transcript_path,
       status_changed_at = CASE
         WHEN live_status IS NOT excluded.live_status OR lifecycle IS NOT excluded.lifecycle THEN excluded.status_changed_at
         ELSE status_changed_at
       END,
       live_status = excluded.live_status, raw_status = excluded.raw_status, attention = excluded.attention,
       lifecycle = excluded.lifecycle, end_reason = excluded.end_reason,
       content_state = coalesce(excluded.content_state, content_state), last_seen = excluded.last_seen`,
  ).run(
    o.source_id, o.external_id, o.session_key, o.provider, o.native_id, o.native_id_origin, o.machine, o.pane_id,
    o.terminal_id, o.workspace_id, o.tab_id, o.cwd, o.title, o.fidelity, o.transcript_path, o.live_status, o.raw_status,
    o.attention, o.lifecycle, o.end_reason, o.content_state, nowIso, nowIso, nowIso,
  );
}

/** Ends (or purges, or stops tracking) one source's observation; other sources' observations are untouched. */
export function endObservation(
  db: DatabaseSync,
  sourceId: string,
  externalId: string,
  lifecycle: Exclude<ObservationLifecycle, 'live'>,
  reason: string,
  nowIso: string,
): void {
  db.prepare(
    `UPDATE session_sources SET lifecycle = ?, end_reason = ?, status_changed_at = ?
     WHERE source_id = ? AND external_id = ? AND lifecycle IS NOT ?`,
  ).run(lifecycle, reason, nowIso, sourceId, externalId, lifecycle);
}

/** Inserts a session row for a key seen for the first time; an existing row is left as it is. */
export function ensureSessionRow(db: DatabaseSync, key: string, o: ObservationFields, nowIso: string): boolean {
  const { changes } = db
    .prepare(
      `INSERT OR IGNORE INTO sessions (
         key, agent_kind, native_id, machine, pane_id, terminal_id, workspace_id, tab_id, cwd, title, live_status,
         lifecycle, fidelity, transcript_path, first_seen, last_seen, status_changed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?)`,
    )
    .run(
      key, o.provider, o.native_id, o.machine, o.pane_id, o.terminal_id, o.workspace_id, o.tab_id, o.cwd, o.title,
      o.live_status, o.fidelity, o.transcript_path, nowIso, nowIso, nowIso,
    );
  return Number(changes) > 0;
}

/**
 * Recomputes a session's projection from its observations: lifecycle (live while any source has it live; purged once
 * every source purged it; ended otherwise), live status (combined over live observations, freshness aside: that is a
 * read-time matter), and the location columns from its primary observation (a live herdr one first, since only herdr
 * has panes, then the most recently seen live one, then the most recently seen). A session without observations is
 * left alone. `status_changed_at` moves only when lifecycle or live status changed.
 */
export function refreshSession(db: DatabaseSync, key: string, nowIso: string): void {
  const obs = db
    .prepare(
      `SELECT o.*, s.kind AS kind FROM session_sources o LEFT JOIN ingest_sources s ON s.source_id = o.source_id
       WHERE o.session_key = ? ORDER BY o.last_seen DESC, o.source_id, o.external_id`,
    )
    .all(key) as Array<SessionSourceRow & { kind: SourceKind | null }>;
  if (obs.length === 0) return;
  const current = db.prepare('SELECT lifecycle, live_status, merged_into FROM sessions WHERE key = ?').get(key) as
    | { lifecycle: string; live_status: LiveStatus; merged_into: string | null }
    | undefined;
  if (current === undefined || current.merged_into !== null) return;

  const live = obs.filter((o) => o.lifecycle === 'live' || o.lifecycle === 'untracked');
  const lifecycle = live.length > 0 ? 'live' : obs.every((o) => o.lifecycle === 'purged') ? 'purged' : 'ended';
  const liveStatus = combineStatuses(obs.filter((o) => o.lifecycle === 'live').map((o) => o.live_status)) ?? current.live_status;
  const primary = live.find((o) => o.kind === 'herdr') ?? live[0] ?? obs[0]!;
  db.prepare(
    `UPDATE sessions SET
       agent_kind = ?, native_id = coalesce(?, native_id), machine = ?, pane_id = ?, terminal_id = ?, workspace_id = ?,
       tab_id = ?, cwd = ?, title = ?, fidelity = coalesce(?, fidelity), transcript_path = ?,
       status_changed_at = CASE WHEN live_status IS NOT ? OR lifecycle IS NOT ? THEN ? ELSE status_changed_at END,
       live_status = ?, lifecycle = ?, last_seen = max(coalesce(last_seen, ''), ?)
     WHERE key = ?`,
  ).run(
    primary.provider, primary.native_id, primary.machine, primary.pane_id, primary.terminal_id, primary.workspace_id,
    primary.tab_id, primary.cwd, primary.title, primary.fidelity, primary.transcript_path, liveStatus, lifecycle, nowIso,
    liveStatus, lifecycle, primary.last_seen ?? nowIso, key,
  );
}
