import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LEASE_TTL_MS } from '../shared/ingest-v2.ts';
import type {
  AgentObservation,
  BatchAck,
  BatchV2,
  CheckpointResponse,
  Cursor,
  LeaseRequest,
  LeaseResponse,
  SnapshotV2,
  SnapshotV2Response,
  TimelineEvent,
  V2Error,
} from '../shared/ingest-v2.ts';
import { transaction } from './db.ts';
import { claimContentOwner, insertPaseoChunks, reconsiderOwner } from './content-owner.ts';
import { renderEvent } from './paseo-content.ts';
import { isTemporaryKey, migrateSessionIdentity, resolvePaseoKey } from './session-identity.ts';
import { mergeTarget } from './sessions-repo.ts';
import { endObservation, ensureSessionRow, refreshSession, upsertObservation } from './sources-repo.ts';
import type { ObservationFields } from './sources-repo.ts';

// The center side of the v2 (Paseo) ingestion contract. Every write runs in one transaction that also checks the
// writer's lease, so a second collector instance, a stale instance retrying, or a late snapshot cannot overwrite newer
// state, and a batch's events, chunks, receipt and checkpoint are committed together or not at all.

export type PaseoSource = { sourceId: string; machine: string; serverId: string };

/** A refused v2 request: the HTTP status, a code the collector acts on, and the committed position when relevant. */
export class IngestError extends Error {
  readonly status: 400 | 403 | 409 | 413;
  readonly code: V2Error['error'];
  readonly checkpoint: Cursor | null | undefined;
  constructor(status: 400 | 403 | 409 | 413, code: V2Error['error'], message: string, checkpoint?: Cursor | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.checkpoint = checkpoint;
  }
}

type SourceLeaseRow = {
  lease_instance: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  snapshot_rev: number;
};

function ensureSource(db: DatabaseSync, src: PaseoSource): void {
  db.prepare(
    `INSERT INTO ingest_sources (source_id, kind, machine, server_id) VALUES (?, 'paseo', ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET kind = 'paseo', machine = excluded.machine, server_id = excluded.server_id`,
  ).run(src.sourceId, src.machine, src.serverId);
}

function leaseRow(db: DatabaseSync, sourceId: string): SourceLeaseRow {
  return db.prepare('SELECT lease_instance, lease_epoch, lease_expires_at, snapshot_rev FROM ingest_sources WHERE source_id = ?').get(sourceId) as SourceLeaseRow;
}

/**
 * Grants or renews the source's single-writer lease. Another instance holding an unexpired lease is refused; a new
 * holder gets the next lease epoch (which also restarts snapshot revisions). A collector connected to another daemon
 * than the one configured for the source is refused: its observations would be written under the wrong identity.
 */
export function acquireLease(db: DatabaseSync, src: PaseoSource, req: LeaseRequest, now: Date): LeaseResponse {
  if (req.server_id !== src.serverId) {
    throw new IngestError(409, 'identity_mismatch', `connected daemon ${JSON.stringify(req.server_id)} is not the configured ${JSON.stringify(src.serverId)}`);
  }
  return transaction(db, () => {
    ensureSource(db, src);
    const row = leaseRow(db, src.sourceId);
    const held = row.lease_instance !== null && row.lease_instance !== req.instance_id && row.lease_expires_at !== null && Date.parse(row.lease_expires_at) > now.getTime();
    if (held) throw new IngestError(409, 'lease_held', `source ${src.sourceId} is written by another collector instance until ${row.lease_expires_at}`);
    const same = row.lease_instance === req.instance_id && row.lease_epoch > 0;
    const epoch = same ? row.lease_epoch : row.lease_epoch + 1;
    const expires = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
    const rev = same ? row.snapshot_rev : 0;
    db.prepare(
      `UPDATE ingest_sources SET lease_instance = ?, lease_epoch = ?, lease_expires_at = ?, snapshot_rev = ?,
         collector_version = ?, collector_heartbeat = ? WHERE source_id = ?`,
    ).run(req.instance_id, epoch, expires, rev, req.collector_version, now.toISOString(), src.sourceId);
    return { lease_epoch: epoch, expires_at: expires, snapshot_rev: rev };
  });
}

/** Refuses a writer that does not hold the current lease; renews it for the one that does. */
function checkLease(db: DatabaseSync, src: PaseoSource, instance: string, epoch: number, now: Date): SourceLeaseRow {
  const row = db.prepare('SELECT lease_instance, lease_epoch, lease_expires_at, snapshot_rev FROM ingest_sources WHERE source_id = ?').get(src.sourceId) as
    | SourceLeaseRow
    | undefined;
  if (row === undefined || row.lease_instance !== instance || row.lease_epoch !== epoch) {
    throw new IngestError(409, 'stale_lease', `this instance does not hold the lease of source ${src.sourceId}`);
  }
  db.prepare('UPDATE ingest_sources SET lease_expires_at = ? WHERE source_id = ?').run(new Date(now.getTime() + LEASE_TTL_MS).toISOString(), src.sourceId);
  return row;
}

function observationLifecycle(a: AgentObservation): { lifecycle: ObservationFields['lifecycle']; reason: string | null } {
  switch (a.lifecycle) {
    case 'live':
      return { lifecycle: 'live', reason: null };
    case 'excluded':
      return { lifecycle: 'untracked', reason: 'excluded' };
    default:
      return { lifecycle: 'ended', reason: a.lifecycle };
  }
}

/**
 * Applies a Paseo snapshot: always the heartbeat and daemon health; with a connected daemon also the agents (each
 * resolved to its central key, moving a temporary identity onto a native one when the provider id appears); and only
 * for a complete snapshot, the end of this source's live observations that are not in it. A disconnected daemon
 * changes health only: its sessions show offline, nothing ends.
 */
export function applyPaseoSnapshot(db: DatabaseSync, src: PaseoSource, push: SnapshotV2, now: Date): SnapshotV2Response {
  const nowIso = now.toISOString();
  return transaction(db, () => {
    const lease = checkLease(db, src, push.instance_id, push.lease_epoch, now);
    if (push.snapshot_rev <= lease.snapshot_rev) {
      throw new IngestError(409, 'stale_snapshot', `snapshot revision ${push.snapshot_rev} is not newer than ${lease.snapshot_rev}`);
    }
    const connected = push.daemon.status === 'connected';
    db.prepare(
      `UPDATE ingest_sources SET collector_version = ?, collector_heartbeat = ?, daemon_status = ?, daemon_error = ?,
         daemon_checked_at = ?, snapshot_rev = ?, diagnostics = ?,
         last_snapshot_at = CASE WHEN ? THEN ? ELSE last_snapshot_at END
       WHERE source_id = ?`,
    ).run(
      push.collector_version, nowIso, push.daemon.status, push.daemon.error, nowIso, push.snapshot_rev,
      push.diagnostics === undefined ? null : JSON.stringify(push.diagnostics), connected && push.complete ? 1 : 0, nowIso, src.sourceId,
    );
    if (!connected) return { ok: true, snapshot_rev: push.snapshot_rev, lease_expires_at: new Date(now.getTime() + LEASE_TTL_MS).toISOString() };

    const touched = new Set<string>();
    const existingOf = db.prepare('SELECT session_key FROM session_sources WHERE source_id = ? AND external_id = ?');
    for (const a of push.agents) {
      const existing = (existingOf.get(src.sourceId, a.agent_id) as { session_key: string } | undefined)?.session_key ?? null;
      const identity = resolvePaseoKey(db, {
        sourceId: src.sourceId,
        serverId: src.serverId,
        agentId: a.agent_id,
        machine: src.machine,
        provider: a.provider,
        nativeId: a.native_id,
        cwd: a.cwd,
        currentKey: existing,
      });
      const { lifecycle, reason } = observationLifecycle(a);
      const fields: ObservationFields = {
        source_id: src.sourceId,
        external_id: a.agent_id,
        session_key: identity.key,
        provider: a.provider,
        native_id: a.native_id,
        native_id_origin: a.native_id_origin,
        machine: src.machine,
        pane_id: null,
        terminal_id: null,
        workspace_id: a.workspace_id,
        tab_id: null,
        cwd: a.cwd,
        title: a.title,
        fidelity: 'full',
        transcript_path: null,
        live_status: a.status,
        raw_status: a.raw_status,
        attention: a.attention,
        lifecycle,
        end_reason: reason,
        content_state: a.content,
      };
      let fresh = false;
      if (existing !== null && existing !== identity.key) {
        if (isTemporaryKey(existing)) {
          // The provider session id appeared: the temporary session becomes the native one, references and all.
          migrateSessionIdentity(db, existing, identity.key, nowIso);
        } else {
          // The agent moved on to another provider session: a new logical session that succeeds the old one.
          fresh = ensureSessionRow(db, identity.key, fields, nowIso);
          if (fresh) db.prepare('UPDATE sessions SET predecessor_key = ? WHERE key = ?').run(existing, identity.key);
          touched.add(existing);
        }
      }
      if (!fresh) ensureSessionRow(db, identity.key, fields, nowIso);
      upsertObservation(db, fields, nowIso);
      db.prepare(
        `UPDATE session_sources SET identity_note = coalesce(?, CASE WHEN identity_note LIKE 'late_identity_overlap%' THEN identity_note END)
         WHERE source_id = ? AND external_id = ?`,
      ).run(identity.note, src.sourceId, a.agent_id);
      touched.add(identity.key);
    }
    if (push.complete) {
      const listed = new Set(push.agents.map((a) => a.agent_id));
      const live = db
        .prepare(`SELECT external_id, session_key FROM session_sources WHERE source_id = ? AND lifecycle = 'live'`)
        .all(src.sourceId) as Array<{ external_id: string; session_key: string }>;
      for (const o of live.filter((r) => !listed.has(r.external_id))) {
        endObservation(db, src.sourceId, o.external_id, 'ended', 'absent', nowIso);
        touched.add(o.session_key);
      }
    }
    for (const key of touched) {
      refreshSession(db, key, nowIso);
      reconsiderOwner(db, key, nowIso);
    }
    return { ok: true, snapshot_rev: push.snapshot_rev, lease_expires_at: new Date(now.getTime() + LEASE_TTL_MS).toISOString() };
  });
}

type StreamRow = {
  epoch: string | null;
  seq: number | null;
  state: string | null;
  last_batch_id: string | null;
  last_event_ts: string | null;
  /** After a replacement: rows without a provider id up to this time may repeat history already received. */
  overlap_until: string | null;
};

function streamOf(db: DatabaseSync, sourceId: string, agentId: string): StreamRow | undefined {
  return db.prepare('SELECT epoch, seq, state, last_batch_id, last_event_ts, overlap_until FROM ingest_streams WHERE source_id = ? AND stream_id = ?').get(sourceId, agentId) as
    | StreamRow
    | undefined;
}

function cursorOf(row: StreamRow | undefined): Cursor | null {
  return row?.epoch != null && row.seq != null ? { epoch: row.epoch, seq: row.seq } : null;
}

/** The committed timeline position of one agent of the source, with the session it feeds. */
export function getCheckpoint(db: DatabaseSync, src: PaseoSource, agentId: string): CheckpointResponse {
  const stream = streamOf(db, src.sourceId, agentId);
  const obs = db.prepare('SELECT session_key FROM session_sources WHERE source_id = ? AND external_id = ?').get(src.sourceId, agentId) as
    | { session_key: string }
    | undefined;
  return {
    agent_id: agentId,
    session_key: obs ? mergeTarget(db, obs.session_key) : null,
    checkpoint: cursorOf(stream),
    state: stream?.state ?? null,
    last_batch_id: stream?.last_batch_id ?? null,
  };
}

/**
 * The hash a batch is remembered by: the same batch id with other content is a conflict, not a retry. The writer
 * fields are left out, so a batch resent under a renewed lease (after its acknowledgement was lost) is still a retry.
 */
export function bodyHash(body: unknown): string {
  const { instance_id: _instance, lease_epoch: _epoch, ...content } = body as Record<string, unknown>;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function contentHash(e: TimelineEvent): string {
  return createHash('sha256')
    .update(JSON.stringify([e.kind, e.item_type, e.ts, e.text, e.text_truncated, e.tool]))
    .digest('hex');
}

type Disposition = 'materialized' | 'suffix' | 'standby' | 'revision_review' | 'overlap_unverified';

/**
 * Commits one batch of an agent's timeline. In one transaction: the receipt (a retried batch id with the same body
 * returns the stored acknowledgement; with another body it is a conflict), the base check (the batch must continue from
 * the committed position, so a stale or reordered batch is refused with the current one), every event as a source
 * event (an identical one is a duplicate; a changed one is a new revision, never an overwrite), the chunks of the events
 * that feed the analysis, gaps, and the next position. Events feed the analysis only while this source owns the
 * session's content; otherwise they are standby evidence. A revision is analysed only when it is a tool call finishing
 * or text growing after what was already delivered; any other change is kept for review. After a timeline replacement,
 * a row that has no provider id and is not newer than what was already received cannot be told apart from history
 * already analysed, so it is kept as unverified overlap rather than analysed again.
 */
export function commitBatch(db: DatabaseSync, src: PaseoSource, batch: BatchV2, hash: string, now: Date): BatchAck {
  const nowIso = now.toISOString();
  return transaction(db, () => {
    checkLease(db, src, batch.instance_id, batch.lease_epoch, now);
    const prior = db.prepare('SELECT body_hash, ack FROM ingest_batches WHERE source_id = ? AND batch_id = ?').get(src.sourceId, batch.batch_id) as
      | { body_hash: string; ack: string }
      | undefined;
    if (prior !== undefined) {
      if (prior.body_hash !== hash) throw new IngestError(409, 'batch_conflict', `batch ${batch.batch_id} was already committed with other content`);
      return JSON.parse(prior.ack) as BatchAck;
    }
    const obs = db.prepare('SELECT session_key FROM session_sources WHERE source_id = ? AND external_id = ?').get(src.sourceId, batch.agent_id) as
      | { session_key: string }
      | undefined;
    if (obs === undefined) throw new IngestError(409, 'unknown_agent', `agent ${batch.agent_id} has not been reported in a snapshot of ${src.sourceId}`);
    const stream = streamOf(db, src.sourceId, batch.agent_id);
    const current = cursorOf(stream);
    const same = (a: Cursor | null, b: Cursor | null) => (a === null ? b === null : b !== null && a.epoch === b.epoch && a.seq === b.seq);
    if (!same(batch.base, current)) {
      throw new IngestError(409, 'checkpoint_mismatch', `batch ${batch.batch_id} does not continue from the committed position`, current);
    }
    if (batch.base !== null && batch.reset === null && (batch.next.epoch !== batch.base.epoch || batch.next.seq < batch.base.seq)) {
      throw new IngestError(400, 'invalid', 'next position goes backwards or changes epoch without a reset');
    }

    const key = mergeTarget(db, obs.session_key);
    const { role, since } = batch.events.length > 0 ? claimContentOwner(db, key, src.sourceId, nowIso) : { role: 'standby' as const, since: null };
    // After a handover, rows the previous owner already covered stay standby.
    const owns = (e: TimelineEvent) => role === 'owner' && (since === null || (e.ts !== null && e.ts > since));
    // Identity: the collector's key (`base_key`) is a provider id, but one provider id can name several projected rows
    // (seen on codex: two assistant rows of one message, split by a tool call). A revision is the same row again: same
    // epoch, overlapping seqs. A row with a known id elsewhere in the same epoch is another row, `<key>~<seqStart>`.
    // Identical content under any variant of the key is a duplicate, also across epochs (a replayed history).
    const findDup = db.prepare('SELECT 1 FROM source_events WHERE source_id = ? AND stream_id = ? AND base_key = ? AND content_hash = ?');
    const sameRow = db.prepare(
      `SELECT id, event_key, revision, kind, text, meta FROM source_events
       WHERE source_id = ? AND stream_id = ? AND base_key = ? AND epoch = ? AND seq_start <= ? AND seq_end >= ?
       ORDER BY revision DESC, id DESC LIMIT 1`,
    );
    const sameEpochOther = db.prepare('SELECT 1 FROM source_events WHERE source_id = ? AND stream_id = ? AND base_key = ? AND epoch = ? LIMIT 1');
    const otherEpoch = db.prepare(
      'SELECT id, event_key, revision, kind, text, meta FROM source_events WHERE source_id = ? AND stream_id = ? AND base_key = ? ORDER BY id DESC LIMIT 1',
    );
    const insertEvent = db.prepare(
      `INSERT INTO source_events (source_id, stream_id, base_key, event_key, content_hash, revision, session_key, batch_id, epoch,
         seq_start, seq_end, kind, ts, ts_known, backfill, received_at, text, meta, disposition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const lastTs = stream?.last_event_ts ?? null;
    // A replacement re-reads the new epoch over several batches; until then every id-less row up to what was already
    // received may be a repeat. The boundary only ever grows.
    const overlapUntil = batch.reset !== null && lastTs !== null && (stream?.overlap_until == null || lastTs > stream.overlap_until) ? lastTs : (stream?.overlap_until ?? null);
    let duplicates = 0;
    let review = 0;
    let standbyCount = 0;
    let maxTs = lastTs;
    const toMaterialize: Array<{ id: number; event: TimelineEvent; continuation?: string }> = [];
    for (const e of batch.events) {
      const h = contentHash(e);
      if (findDup.get(src.sourceId, batch.agent_id, e.key, h) !== undefined) {
        duplicates += 1;
        continue;
      }
      type Prior = { id: number; event_key: string; revision: number; kind: string; text: string; meta: string };
      let prev = sameRow.get(src.sourceId, batch.agent_id, e.key, e.epoch, e.seq_end, e.seq_start) as Prior | undefined;
      let eventKey = prev?.event_key ?? e.key;
      if (prev === undefined && sameEpochOther.get(src.sourceId, batch.agent_id, e.key, e.epoch) !== undefined) {
        eventKey = `${e.key}~${e.seq_start}`; // another row under the same provider id
      } else if (prev === undefined && e.stable_id) {
        // Known only from an earlier epoch: the same row replayed with other content cannot be told from a rewrite.
        prev = otherEpoch.get(src.sourceId, batch.agent_id, e.key) as Prior | undefined;
        if (prev !== undefined) eventKey = prev.event_key;
      }
      let disposition: Disposition;
      let continuation: string | undefined;
      if (prev === undefined) {
        const unverifiable = !e.stable_id && overlapUntil !== null && (e.ts === null || e.ts <= overlapUntil);
        disposition = unverifiable ? 'overlap_unverified' : owns(e) ? 'materialized' : 'standby';
      } else {
        const prevTool = (JSON.parse(prev.meta) as { tool?: { status?: string } | null }).tool ?? null;
        const toolFinished = e.tool !== null && prevTool?.status === 'running' && e.tool.status !== 'running';
        const grew = (e.kind === 'assistant' || e.kind === 'user') && e.text.length > prev.text.length && e.text.startsWith(prev.text);
        if (toolFinished) disposition = owns(e) ? 'materialized' : 'standby';
        else if (grew) {
          disposition = owns(e) ? 'suffix' : 'standby';
          continuation = e.text.slice(prev.text.length);
        } else disposition = 'revision_review';
      }
      if (disposition === 'revision_review' || disposition === 'overlap_unverified') review += 1;
      if (disposition === 'standby') standbyCount += 1;
      const meta = { item_type: e.item_type, stable_id: e.stable_id, text_truncated: e.text_truncated, tool: e.tool };
      const { lastInsertRowid } = insertEvent.run(
        src.sourceId, batch.agent_id, e.key, eventKey, h, (prev?.revision ?? 0) + 1, key, batch.batch_id, e.epoch, e.seq_start, e.seq_end, e.kind,
        e.ts, e.ts === null ? 0 : 1, e.backfill ? 1 : 0, nowIso, e.text, JSON.stringify(meta), disposition,
      );
      if (disposition === 'materialized' || disposition === 'suffix') toMaterialize.push({ id: Number(lastInsertRowid), event: e, continuation });
      if (e.ts !== null && (maxTs === null || e.ts > maxTs)) maxTs = e.ts;
    }

    // Chunks: the batch's analysable events in order, packed; each chunk remembers the source events it holds.
    insertPaseoChunks(
      db,
      key,
      src.sourceId,
      toMaterialize.map((m) => ({ id: m.id, ts: m.event.ts, backfill: m.event.backfill, text: renderEvent(m.event, m.continuation) })),
      nowIso,
      lastTs,
    );

    const gap = db.prepare('INSERT INTO ingest_gaps (source_id, stream_id, epoch, from_seq, to_seq, reason, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    if (batch.reset !== null) gap.run(src.sourceId, batch.agent_id, batch.reset.previous_epoch, current?.seq ?? null, null, 'epoch_replaced', nowIso);
    for (const g of batch.gaps) gap.run(src.sourceId, batch.agent_id, g.epoch, g.from_seq, g.to_seq, g.reason, nowIso);

    const accepted = batch.events.length - duplicates;
    db.prepare(
      `INSERT INTO ingest_streams (source_id, stream_id, epoch, seq, state, last_batch_id, events_total, last_event_ts, overlap_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, stream_id) DO UPDATE SET
         epoch = excluded.epoch, seq = excluded.seq, state = excluded.state, last_batch_id = excluded.last_batch_id,
         events_total = events_total + excluded.events_total, last_event_ts = excluded.last_event_ts,
         overlap_until = excluded.overlap_until, updated_at = excluded.updated_at`,
    ).run(
      src.sourceId, batch.agent_id, batch.next.epoch, batch.next.seq, batch.gaps.length > 0 || batch.reset !== null ? 'gap_recorded' : 'ok',
      batch.batch_id, accepted, maxTs, overlapUntil, nowIso,
    );
    const ack: BatchAck = {
      batch_id: batch.batch_id,
      agent_id: batch.agent_id,
      checkpoint: batch.next,
      session_key: key,
      accepted,
      duplicates,
      materialized: toMaterialize.length,
      standby: standbyCount,
      review,
    };
    db.prepare('INSERT INTO ingest_batches (source_id, batch_id, stream_id, body_hash, ack, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      src.sourceId, batch.batch_id, batch.agent_id, hash, JSON.stringify(ack), nowIso,
    );
    return ack;
  });
}
