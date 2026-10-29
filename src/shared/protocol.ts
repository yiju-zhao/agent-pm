import { z } from 'zod';

/** Agent type as reported by herdr's `agent` field, e.g. `claude`, `codex`. */
export type AgentKind = string;

export const LiveStatus = z.enum(['idle', 'working', 'blocked', 'done', 'unknown']);
export type LiveStatus = z.infer<typeof LiveStatus>;

export const SnapshotSession = z.object({
  key: z.string(),
  agent_kind: z.string(),
  native_id: z.string().nullable(),
  pane_id: z.string(),
  terminal_id: z.string(),
  workspace_id: z.string(),
  tab_id: z.string(),
  cwd: z.string(),
  title: z.string(),
  live_status: LiveStatus,
  fidelity: z.enum(['full', 'screen']),
  transcript_path: z.string().nullable(),
});
export type SnapshotSession = z.infer<typeof SnapshotSession>;

export const SnapshotPush = z.object({
  machine: z.string(),
  collector_version: z.string(),
  sessions: z.array(SnapshotSession),
  purged: z.array(z.string()),
});
export type SnapshotPush = z.infer<typeof SnapshotPush>;

export const ChunkPush = z.object({
  machine: z.string(),
  chunks: z.array(
    z.object({
      session_key: z.string(),
      kind: z.enum(['transcript', 'screen']),
      offset_start: z.number(),
      offset_end: z.number(),
      ts_start: z.string(),
      ts_end: z.string(),
      text: z.string(),
      backfill: z.boolean(),
    }),
  ),
});
export type ChunkPush = z.infer<typeof ChunkPush>;

export const OffsetResponse = z.object({
  session_key: z.string(),
  max_offset_end: z.number().nullable(),
});
export type OffsetResponse = z.infer<typeof OffsetResponse>;
