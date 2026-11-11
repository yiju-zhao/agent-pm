import { z } from 'zod';
import { LiveStatus } from './protocol.ts';

// The v2 ingestion contract: a source-scoped protocol for collectors whose positions are not byte offsets (Paseo).
// The center owns identity (the collector sends agent ids, never central session keys) and the confirmed positions
// (a collector always resumes from what the center committed, never from its own cache).
//
//   POST /ingest/v2/lease       take or renew the source's single-writer lease
//   POST /ingest/v2/snapshot    heartbeat, daemon health and the directory (complete or partial), revisioned
//   GET  /ingest/v2/checkpoint  the committed timeline position of one agent
//   POST /ingest/v2/batches     one immutable batch of timeline events, committed atomically with the next position

/** Largest request body the center accepts on the v2 routes. */
export const MAX_V2_BODY_BYTES = 512 * 1024;
/** How long a lease lives without renewal (every snapshot renews it). */
export const LEASE_TTL_MS = 60_000;

export const Cursor = z.object({ epoch: z.string().min(1), seq: z.number().int().nonnegative() });
export type Cursor = z.infer<typeof Cursor>;

const Writer = {
  source_id: z.string().min(1),
  instance_id: z.string().min(8).max(100),
  lease_epoch: z.number().int().positive(),
};

export const LeaseRequest = z.object({
  source_id: z.string().min(1),
  instance_id: z.string().min(8).max(100),
  server_id: z.string().min(1),
  collector_version: z.string().min(1),
});
export type LeaseRequest = z.infer<typeof LeaseRequest>;

/** `snapshot_rev`: the last revision accepted under this lease; the holder continues above it (0 for a new lease). */
export const LeaseResponse = z.object({ lease_epoch: z.number().int().positive(), expires_at: z.string(), snapshot_rev: z.number().int().nonnegative() });
export type LeaseResponse = z.infer<typeof LeaseResponse>;

/**
 * How the collector sees one agent. `lifecycle`: `live` while listed and not archived; `closed` the daemon closed it
 * (not loaded, not archived); `archived`; `deleted` an exact-id lookup no longer finds it; `excluded` deployment
 * filters stopped tracking it (not an end of the session). `content` says whether its timeline can be read without
 * resuming it, and how far behind the collector is.
 */
export const AgentObservation = z.object({
  agent_id: z.string().min(1).max(200),
  provider: z.string().min(1).max(100),
  native_id: z.string().min(1).max(300).nullable(),
  native_id_origin: z.enum(['runtime', 'persistence']).nullable(),
  cwd: z.string().max(4096),
  title: z.string().max(2000),
  workspace_id: z.string().max(200).nullable(),
  raw_status: z.string().max(50),
  status: LiveStatus,
  attention: z.string().max(200).nullable(),
  lifecycle: z.enum(['live', 'closed', 'archived', 'deleted', 'excluded']),
  content: z.enum(['current', 'catching_up', 'unloaded', 'error', 'paused']),
});
export type AgentObservation = z.infer<typeof AgentObservation>;

export const DaemonHealth = z.object({
  status: z.enum(['connected', 'connecting', 'disconnected', 'identity_mismatch']),
  error: z.string().max(1000).nullable(),
  server_id: z.string().nullable(),
});
export type DaemonHealth = z.infer<typeof DaemonHealth>;

export const SnapshotV2 = z.object({
  ...Writer,
  collector_version: z.string().min(1),
  /** Strictly increasing per lease; a late or repeated revision is refused. */
  snapshot_rev: z.number().int().positive(),
  daemon: DaemonHealth,
  /**
   * `true` only when `agents` came from a full, successful directory pagination (plus exact-id checks of tracked agents
   * missing from it); only then may the center end this source's observations that are not in it. A failed page, a
   * disconnect or a filter change sends `false` (or no agents at all).
   */
  complete: z.boolean(),
  agents: z.array(AgentObservation).max(5000),
  diagnostics: z
    .object({
      outbox_batches: z.number().int().nonnegative(),
      outbox_bytes: z.number().int().nonnegative(),
      lagging_agents: z.number().int().nonnegative(),
      last_error: z.string().max(1000).nullable(),
    })
    .optional(),
});
export type SnapshotV2 = z.infer<typeof SnapshotV2>;

export const SnapshotV2Response = z.object({ ok: z.literal(true), snapshot_rev: z.number().int(), lease_expires_at: z.string() });
export type SnapshotV2Response = z.infer<typeof SnapshotV2Response>;

export const Truncation = z.object({ original_chars: z.number().int().nonnegative(), kept_chars: z.number().int().nonnegative() }).nullable();
export type Truncation = z.infer<typeof Truncation>;

export const ToolInfo = z.object({
  name: z.string().max(200),
  status: z.enum(['running', 'completed', 'failed', 'canceled']),
  /** A shell exit code, when the provider reported one. */
  exit_code: z.number().int().nullable(),
  input: z.string(),
  input_truncated: Truncation,
  output: z.string(),
  output_truncated: Truncation,
  error: z.string().nullable(),
});
export type ToolInfo = z.infer<typeof ToolInfo>;

/**
 * One normalized timeline row. `key` is its identity within the agent: `msg:<messageId>` / `tool:<callId>` when the
 * provider gives one (stable across epochs), else `row:<epoch>:<seqStart>:<type>` (stable only within its epoch;
 * `stable_id` false). A later version of the same key with other content is a revision, never an overwrite.
 */
export const TimelineEvent = z.object({
  key: z.string().min(1).max(400),
  stable_id: z.boolean(),
  kind: z.enum(['user', 'assistant', 'tool', 'error', 'notice', 'other']),
  item_type: z.string().max(100),
  epoch: z.string().min(1),
  seq_start: z.number().int().nonnegative(),
  seq_end: z.number().int().nonnegative(),
  /** The row's own timestamp from the daemon; null when it had none (never replaced by the time it was read). */
  ts: z.string().nullable(),
  backfill: z.boolean(),
  text: z.string().max(70_000),
  text_truncated: Truncation,
  tool: ToolInfo.nullable(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const Gap = z.object({
  epoch: z.string().nullable(),
  from_seq: z.number().int().nonnegative().nullable(),
  to_seq: z.number().int().nonnegative().nullable(),
  reason: z.enum(['upstream_gap', 'epoch_replaced', 'history_unavailable', 'unverified_overlap']),
});
export type Gap = z.infer<typeof Gap>;

export const BatchV2 = z.object({
  ...Writer,
  batch_id: z.string().min(8).max(100),
  agent_id: z.string().min(1).max(200),
  /** The committed position this batch continues from; null for an agent's first batch. Must equal the center's. */
  base: Cursor.nullable(),
  /** The position committed with this batch: every row up to it has been delivered in its final form. */
  next: Cursor,
  /** Set when the timeline epoch changed under the collector (replacement or stale cursor). */
  reset: z.object({ previous_epoch: z.string().nullable(), reason: z.enum(['replacement', 'stale_cursor']) }).nullable(),
  events: z.array(TimelineEvent).max(1000),
  gaps: z.array(Gap).max(100),
  /** Rows read but not delivered as events (reasoning, unknown kinds…), by item type. */
  filtered: z.record(z.string(), z.number().int().nonnegative()),
});
export type BatchV2 = z.infer<typeof BatchV2>;

export const BatchAck = z.object({
  batch_id: z.string(),
  agent_id: z.string(),
  checkpoint: Cursor,
  session_key: z.string(),
  accepted: z.number().int(),
  duplicates: z.number().int(),
  materialized: z.number().int(),
  standby: z.number().int(),
  review: z.number().int(),
});
export type BatchAck = z.infer<typeof BatchAck>;

export const CheckpointResponse = z.object({
  agent_id: z.string(),
  session_key: z.string().nullable(),
  checkpoint: Cursor.nullable(),
  state: z.string().nullable(),
  last_batch_id: z.string().nullable(),
});
export type CheckpointResponse = z.infer<typeof CheckpointResponse>;

/** Error bodies the collector acts on (other errors carry only `error` and a message). */
export const V2Error = z.object({
  error: z.enum([
    'lease_held',
    'stale_lease',
    'stale_snapshot',
    'identity_mismatch',
    'checkpoint_mismatch',
    'batch_conflict',
    'unknown_agent',
    'forbidden',
    'invalid',
    'too_large',
  ]),
  message: z.string().optional(),
  checkpoint: Cursor.nullable().optional(),
});
export type V2Error = z.infer<typeof V2Error>;
