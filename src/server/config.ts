import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { MachineLabel } from '../shared/protocol.ts';

/**
 * `collectors` maps a machine label to the bearer token that machine's collector pushes with. `userToken` is the bearer
 * token the user's own tools present on the write routes; it must not be one a collector holds, or that collector's
 * token (which lives on a coding agent's machine) would also let it act as the user.
 */
export const ServerConfig = z
  .object({
    port: z.number().int().min(1).max(65535),
    dbPath: z.string().min(1),
    userToken: z.string().min(16, 'must be at least 16 characters').regex(/^\S+$/, 'must not contain whitespace'),
    collectors: z.record(MachineLabel, z.string().min(1)),
  })
  .superRefine((config, ctx) => {
    const clash = Object.entries(config.collectors).find(([, token]) => token === config.userToken);
    if (clash) {
      ctx.addIssue({
        code: 'custom',
        path: ['userToken'],
        message: `must differ from every collector token (it equals the token of collector ${JSON.stringify(clash[0])})`,
      });
    }
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
    const problems = parsed.error.issues.map((i) => {
      const where = i.path.join('.') || '(root)';
      // A bad record key (machine label) carries the reason in its nested issues.
      if (i.code === 'invalid_key') {
        return `${where}: invalid key ${JSON.stringify(i.path.at(-1))}: ${i.issues.map((n) => n.message).join('; ')}`;
      }
      return `${where}: ${i.message}`;
    });
    throw new Error(`invalid server config ${path}: ${problems.join('; ')}`);
  }
  const config = parsed.data;
  // ':memory:' is SQLite's in-memory database, not a file name.
  const dbPath = config.dbPath === ':memory:' ? config.dbPath : resolve(dirname(path), config.dbPath);
  return { ...config, dbPath };
}
