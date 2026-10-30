import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

/** `collectors` maps a machine label to the bearer token that machine's collector pushes with. */
export const ServerConfig = z.object({
  port: z.number().int().min(1).max(65535),
  dbPath: z.string().min(1),
  collectors: z.record(z.string(), z.string().min(1)),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

/** Reads and validates the server config; a relative `dbPath` is resolved against the config file's directory. */
export function loadServerConfig(path: string): ServerConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read server config ${path}: ${(err as Error).message}`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`server config ${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const parsed = ServerConfig.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid server config ${path}: ${problems.join('; ')}`);
  }
  const config = parsed.data;
  // ':memory:' is SQLite's in-memory database, not a file name.
  const dbPath = config.dbPath === ':memory:' ? config.dbPath : resolve(dirname(path), config.dbPath);
  return { ...config, dbPath };
}
