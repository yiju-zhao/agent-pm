import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Context, MiddlewareHandler } from 'hono';
import { MachineLabel } from '../shared/protocol.ts';
import { bearerToken, tokenMatches } from './bearer.ts';
import type { ServerConfig } from './config.ts';

// API keys. Every caller of the center presents one kind of credential, a bearer key, and what it may do is its scope:
//   admin                    the user: project writes, raw evidence, sync, key and settings management
//   mcp                      a coding agent on /mcp: read the board, pm_report
//   ingest:herdr:<machine>   the herdr collector of one machine (legacy /ingest/*)
//   ingest:paseo:<source>    the Paseo collector of one configured source (/ingest/v2/*)
// A key has exactly one scope, so least privilege is the default: an agent's key cannot write projects, a collector's
// cannot read raw evidence or report for another machine. Keys made in the web UI are stored as SHA-256 hashes only and
// shown once. The tokens in the server config (userToken, mcpToken, collectors, paseoCollectors) are keys too, with the
// scope their place in the config gives them; they cannot be revoked from the UI (edit the config instead).

export type Scope =
  | { kind: 'admin' }
  | { kind: 'mcp' }
  | { kind: 'ingest_herdr'; machine: string }
  | { kind: 'ingest_paseo'; source: string };

export type Principal = { id: string; name: string; scope: Scope; origin: 'config' | 'db' };

export function scopeText(s: Scope): string {
  switch (s.kind) {
    case 'admin':
      return 'admin';
    case 'mcp':
      return 'mcp';
    case 'ingest_herdr':
      return `ingest:herdr:${s.machine}`;
    case 'ingest_paseo':
      return `ingest:paseo:${s.source}`;
  }
}

/** A scope from its text form; `null` when it is not one. */
export function parseScope(text: string): Scope | null {
  if (text === 'admin') return { kind: 'admin' };
  if (text === 'mcp') return { kind: 'mcp' };
  const herdr = /^ingest:herdr:(.+)$/.exec(text);
  if (herdr && MachineLabel.safeParse(herdr[1]).success) return { kind: 'ingest_herdr', machine: herdr[1]! };
  const paseo = /^ingest:paseo:([A-Za-z0-9._-]+)$/.exec(text);
  if (paseo) return { kind: 'ingest_paseo', source: paseo[1]! };
  return null;
}

const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');

/** The keys the server config holds, each with the scope its place there gives it. */
function configKeys(config: ServerConfig): Array<{ token: string; principal: Principal }> {
  const out: Array<{ token: string; principal: Principal }> = [
    { token: config.userToken, principal: { id: 'config:userToken', name: 'userToken（配置文件）', scope: { kind: 'admin' }, origin: 'config' } },
    { token: config.mcpToken, principal: { id: 'config:mcpToken', name: 'mcpToken（配置文件）', scope: { kind: 'mcp' }, origin: 'config' } },
  ];
  for (const [machine, token] of Object.entries(config.collectors)) {
    out.push({ token, principal: { id: `config:collectors.${machine}`, name: `herdr 采集器 ${machine}（配置文件）`, scope: { kind: 'ingest_herdr', machine }, origin: 'config' } });
  }
  for (const [source, entry] of Object.entries(config.paseoCollectors ?? {})) {
    out.push({
      token: entry.token,
      principal: { id: `config:paseoCollectors.${source}`, name: `Paseo 采集器 ${source}（配置文件）`, scope: { kind: 'ingest_paseo', source }, origin: 'config' },
    });
  }
  return out;
}

/** `last_used_at` is written at most this often per key, so a collector's 10-second heartbeat is not a write each time. */
const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Who presents `token`: a config key (compared against every one, each in constant time, no early exit) or a stored,
 * unrevoked key (looked up by hash). `null` for anything else.
 */
export function resolveKey(db: DatabaseSync, config: ServerConfig, token: string, now: Date): Principal | null {
  let found: Principal | null = null;
  for (const k of configKeys(config)) if (tokenMatches(token, k.token) && found === null) found = k.principal;
  if (found !== null) return found;
  const row = db.prepare('SELECT id, name, scope, last_used_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL').get(hashOf(token)) as
    | { id: string; name: string; scope: string; last_used_at: string | null }
    | undefined;
  if (row === undefined) return null;
  const scope = parseScope(row.scope);
  if (scope === null) return null;
  if (row.last_used_at === null || now.getTime() - Date.parse(row.last_used_at) >= LAST_USED_RESOLUTION_MS) {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  }
  return { id: row.id, name: row.name, scope, origin: 'db' };
}

/** The principal of a request's bearer key, or `null` (no header, unknown or revoked key). */
export function principalOf(c: Context, db: DatabaseSync, config: ServerConfig, now: Date): Principal | null {
  const token = bearerToken(c.req.header('Authorization'));
  return token === null ? null : resolveKey(db, config, token, now);
}

/**
 * Middleware: 401 (`WWW-Authenticate: Bearer`, `{error: 'unauthorized', message}`) unless the request's key has a scope
 * `accepts` takes. A valid key with another scope is refused the same way, so a route never tells which keys exist.
 */
export function requireScope(
  db: DatabaseSync,
  config: ServerConfig,
  clock: () => Date,
  accepts: (s: Scope) => boolean,
  message: string,
): MiddlewareHandler {
  return async (c, next) => {
    const p = principalOf(c, db, config, clock());
    if (p === null || !accepts(p.scope)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized', message }, 401);
    }
    await next();
  };
}

export const isAdmin = (s: Scope) => s.kind === 'admin';
export const isMcp = (s: Scope) => s.kind === 'mcp';

// ---- management --------------------------------------------------------------------------------------------------

export type KeyView = {
  id: string;
  name: string;
  scope: string;
  /** The first characters of a stored key, enough to recognize it; `null` for config keys. */
  prefix: string | null;
  origin: 'config' | 'db';
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** Every key, config ones first, then stored ones newest first. Never a secret. */
export function listKeys(db: DatabaseSync, config: ServerConfig): KeyView[] {
  const fromConfig: KeyView[] = configKeys(config).map(({ principal: p }) => ({
    id: p.id,
    name: p.name,
    scope: scopeText(p.scope),
    prefix: null,
    origin: 'config',
    created_at: null,
    last_used_at: null,
    revoked_at: null,
  }));
  const stored = db
    .prepare('SELECT id, name, scope, prefix, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC, id')
    .all() as Array<Omit<KeyView, 'origin'>>;
  return [...fromConfig, ...stored.map((r) => ({ ...r, origin: 'db' as const }))];
}

export class KeyError extends Error {}

/**
 * Makes a key with one scope and returns it (the only time it is shown) with its view. A Paseo scope must name a
 * source configured in `paseoCollectors`, which is where its machine and daemon identity come from.
 */
export function createKey(
  db: DatabaseSync,
  config: ServerConfig,
  args: { name: string; scope: string; createdBy: string },
  now: Date,
  newId: () => string,
): { key: string; view: KeyView } {
  const name = args.name.trim();
  if (name === '' || name.length > 100) throw new KeyError('name must be 1 to 100 characters');
  const scope = parseScope(args.scope);
  if (scope === null) throw new KeyError(`unknown scope ${JSON.stringify(args.scope)}`);
  if (scope.kind === 'ingest_paseo' && config.paseoCollectors?.[scope.source] === undefined) {
    throw new KeyError(`Paseo source ${JSON.stringify(scope.source)} is not in paseoCollectors of the server config`);
  }
  const key = `hpm_${randomBytes(24).toString('base64url')}`;
  const view: KeyView = {
    id: newId(),
    name,
    scope: scopeText(scope),
    prefix: key.slice(0, 10),
    origin: 'db',
    created_at: now.toISOString(),
    last_used_at: null,
    revoked_at: null,
  };
  db.prepare('INSERT INTO api_keys (id, name, scope, prefix, hash, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    view.id, view.name, view.scope, view.prefix, hashOf(key), view.created_at, args.createdBy,
  );
  return { key, view };
}

/** Revokes a stored key; config keys are changed in the config. Returns false when there is no such stored key. */
export function revokeKey(db: DatabaseSync, id: string, now: Date): boolean {
  if (id.startsWith('config:')) throw new KeyError('a key from the server config is changed by editing the config');
  return Number(db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now.toISOString(), id).changes) > 0;
}
