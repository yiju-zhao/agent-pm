import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { expandHome } from '../collector/config.ts';
import { MachineLabel } from '../shared/protocol.ts';

const PathSetting = z.string().min(1).transform((p) => expandHome(p));

/**
 * One Paseo collector instance: the center it reports to, the source id and machine it reports as, the one daemon it
 * observes (`machine` is where that daemon runs, not where this process runs), its own state directory and timings.
 * Secrets live in files (`tokenFile`, `paseo.passwordFile`), never in this config or in logs.
 */
export const PaseoCollectorConfig = z.object({
  server: z.url({ protocol: /^https?$/ }),
  sourceId: z.string().regex(/^[A-Za-z0-9._-]+$/, 'sourceId must contain only letters, digits, ".", "_" and "-"'),
  machine: MachineLabel,
  tokenFile: PathSetting,
  paseo: z.object({
    url: z.string().regex(/^wss?:\/\/\S+$/, 'paseo.url must be a ws:// or wss:// URL (usually ending in /ws)'),
    /** The daemon's server id (`paseo status --json`); a daemon answering with another id is not read. */
    serverId: z.string().min(1),
    passwordFile: PathSetting.optional(),
  }),
  stateDir: PathSetting,
  /** Also renews the center lease (60 s), so it stays well below that. */
  heartbeatMs: z.number().int().min(1000).max(30_000).default(10_000),
  reconcileMs: z.number().int().min(5000).default(60_000),
  maxConcurrentAgents: z.number().int().min(1).max(32).default(4),
  /** Also import agents that were already archived when first seen (off: only agents seen live are tracked). */
  includeArchivedHistory: z.boolean().default(false),
  /** List background workspaces' agents too (the SDK's default list leaves them out). */
  includeBackground: z.boolean().default(true),
  /**
   * After a tracked agent is archived, read its timeline once more for its last rows. The daemon serves an archived
   * agent's history from a history-only session (nothing runs); turn off to never make it do so.
   */
  readArchivedTracked: z.boolean().default(true),
  /** Agents to stop tracking (marked as not tracked, which does not end their sessions). */
  exclude: z
    .object({ projectKeys: z.array(z.string()).default([]), labels: z.record(z.string(), z.string()).default({}) })
    .default({ projectKeys: [], labels: {} }),
  pageLimit: z.number().int().min(1).max(500).default(100),
  /** The outbox may grow to this many bytes; beyond it, content reading pauses (heartbeats go on, nothing is dropped). */
  maxOutboxBytes: z.number().int().min(1024 * 1024).default(64 * 1024 * 1024),
  /** Quiet time after timeline activity before reading it. */
  debounceMs: z.number().int().min(0).default(2000),
  /** A turn that keeps running is read this often anyway. */
  longTurnRefreshMs: z.number().int().min(5000).default(60_000),
});
export type PaseoCollectorConfig = z.infer<typeof PaseoCollectorConfig>;

export type LoadedPaseoConfig = { config: PaseoCollectorConfig; token: string; password: string | undefined };

function readSecret(path: string, what: string): string {
  let value: string;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new Error(`cannot read ${what} ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (value === '') throw new Error(`${what} ${path} is empty`);
  return value;
}

/** Reads and validates the config and the secret files it names. Errors name files and settings, never secrets. */
export function loadPaseoCollectorConfig(path: string): LoadedPaseoConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read Paseo collector config ${path}: ${(err as Error).message}`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Paseo collector config ${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const parsed = PaseoCollectorConfig.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid Paseo collector config ${path}: ${problems.join('; ')}`);
  }
  const config = parsed.data;
  return {
    config,
    token: readSecret(config.tokenFile, 'tokenFile'),
    password: config.paseo.passwordFile === undefined ? undefined : readSecret(config.paseo.passwordFile, 'paseo.passwordFile'),
  };
}
