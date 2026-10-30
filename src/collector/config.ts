import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MachineLabel } from '../shared/protocol.ts';

/** `~` or a leading `~/` refers to the home directory of the user running the collector. */
export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

const PathSetting = (fallback: string) => z.string().min(1).default(fallback).transform((p) => expandHome(p));

/**
 * One machine's collector: where the central server is, the machine label and bearer token it
 * pushes as, the herdr binary, the transcript roots and the local cursor state file.
 */
export const CollectorConfig = z.object({
  server: z.url({ protocol: /^https?$/ }),
  machine: MachineLabel,
  token: z.string().min(1),
  herdrBin: z.string().min(1).default('herdr'),
  claudeDir: PathSetting('~/.claude'),
  codexDir: PathSetting('~/.codex'),
  stateFile: PathSetting('~/.local/state/herdr-pm/collector.json'),
  pollMs: z.number().int().positive().default(10_000),
});
export type CollectorConfig = z.infer<typeof CollectorConfig>;

/** Reads and validates the collector config (JSON); missing optional settings get their defaults. */
export function loadCollectorConfig(path: string): CollectorConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read collector config ${path}: ${(err as Error).message}`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`collector config ${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const parsed = CollectorConfig.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid collector config ${path}: ${problems.join('; ')}`);
  }
  return parsed.data;
}
