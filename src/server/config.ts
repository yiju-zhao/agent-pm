import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { MachineLabel } from '../shared/protocol.ts';

/**
 * `collectors` maps a machine label to the bearer token that machine's collector pushes with. `userToken` is the bearer
 * token the user's own tools present on the write routes; it must not be one a collector holds, or that collector's
 * token (which lives on a coding agent's machine) would also let it act as the user. `mcpToken` is the bearer token
 * coding agents present on `/mcp`; it lives on every agent machine too, so it must differ from both of the others.
 * `paseoCollectors` maps a Paseo source id (one per observed daemon) to that collector's own token, the machine the daemon
 * runs on and the daemon's server id; such a token may write that source only (see server/ingest-v2.ts), and it must
 * differ from every other token here.
 */
const Token = z.string().min(16, 'must be at least 16 characters').regex(/^\S+$/, 'must not contain whitespace');
/** A Paseo source id; no `:`, so it can never collide with a herdr source (`herdr:<machine>`). */
const SourceLabel = z.string().regex(/^[A-Za-z0-9._-]+$/, 'source id must contain only letters, digits, ".", "_" and "-"');

export const ServerConfig = z
  .object({
    port: z.number().int().min(1).max(65535),
    dbPath: z.string().min(1),
    userToken: Token,
    mcpToken: Token,
    collectors: z.record(MachineLabel, z.string().min(1)),
    paseoCollectors: z
      .record(
        SourceLabel,
        z.object({
          token: Token,
          /** The machine the observed daemon runs on (not where the collector runs). */
          machine: MachineLabel,
          /** The daemon's server id (`paseo status --json`); a collector connected to another daemon is refused. */
          serverId: z.string().min(1),
        }),
      )
      .optional(),
    /** The digester, curator and scheduler; every field is optional (see `understandingSettings` for the defaults). */
    understanding: z
      .object({
        enabled: z.boolean().optional(),
        digestModel: z.string().min(1).optional(),
        curateModel: z.string().min(1).optional(),
        /** A file holding a `claude setup-token` token, used as CLAUDE_CODE_OAUTH_TOKEN. */
        oauthTokenFile: z.string().min(1).optional(),
      })
      .optional(),
  })
  .superRefine((config, ctx) => {
    // The messages name the clashing setting, never the token itself.
    for (const field of ['userToken', 'mcpToken'] as const) {
      const clash = Object.entries(config.collectors).find(([, token]) => token === config[field]);
      if (clash) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `must differ from every collector token (it equals the token of collector ${JSON.stringify(clash[0])})`,
        });
      }
    }
    const paseo = Object.entries(config.paseoCollectors ?? {});
    for (const [sourceId, entry] of paseo) {
      const clash =
        Object.entries(config.collectors).find(([, token]) => token === entry.token)?.[0] !== undefined
          ? 'a herdr collector token'
          : entry.token === config.userToken
            ? 'userToken'
            : entry.token === config.mcpToken
              ? 'mcpToken'
              : paseo.some(([other, e]) => other !== sourceId && e.token === entry.token)
                ? 'another Paseo collector token'
                : null;
      if (clash !== null) {
        ctx.addIssue({ code: 'custom', path: ['paseoCollectors', sourceId, 'token'], message: `must differ from ${clash}` });
      }
    }
    if (config.mcpToken === config.userToken) {
      ctx.addIssue({ code: 'custom', path: ['mcpToken'], message: 'must differ from userToken' });
    }
  });
export type ServerConfig = z.infer<typeof ServerConfig>;

export const DEFAULT_DIGEST_MODEL = 'claude-haiku-5-5';
export const DEFAULT_CURATE_MODEL = 'claude-sonnet-5-5';

export type UnderstandingSettings = { enabled: boolean; digestModel: string; curateModel: string; oauthTokenFile?: string };

/** The `understanding` block with its defaults filled in: enabled, Haiku digests, Sonnet curation. */
export function understandingSettings(config: ServerConfig): UnderstandingSettings {
  const u = config.understanding ?? {};
  return {
    enabled: u.enabled ?? true,
    digestModel: u.digestModel ?? DEFAULT_DIGEST_MODEL,
    curateModel: u.curateModel ?? DEFAULT_CURATE_MODEL,
    oauthTokenFile: u.oauthTokenFile,
  };
}

/**
 * Reads and validates the server config. A relative `dbPath` or `understanding.oauthTokenFile` is resolved against the
 * config file's directory.
 */
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
  const tokenFile = config.understanding?.oauthTokenFile;
  if (config.understanding !== undefined && tokenFile !== undefined) {
    return { ...config, dbPath, understanding: { ...config.understanding, oauthTokenFile: resolve(dirname(path), tokenFile) } };
  }
  return { ...config, dbPath };
}
