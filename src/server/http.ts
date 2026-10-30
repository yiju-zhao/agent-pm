import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { defaultDeps } from '../domain/types.ts';
import type { DomainDeps } from '../domain/types.ts';
import { ChunkPush, SnapshotPush } from '../shared/protocol.ts';
import type { OffsetResponse } from '../shared/protocol.ts';
import { parseSessionKey } from '../shared/session-key.ts';
import type { Scheduler } from '../understand/scheduler.ts';
import { disabledStatus } from '../understand/status.ts';
import type { ServerConfig } from './config.ts';
import { mountDomainRoutes, userAuth } from './domain-routes.ts';
import { applySnapshot, findByShortId, insertChunks, listSessions, maxOffset } from './sessions-repo.ts';

/**
 * The central API. `/ingest/*` is for collectors (bearer token bound to one machine); the project
 * API (`./domain-routes.ts`) takes the user token on writes; every GET, `/sessions*` included, is
 * unauthenticated for now (Tailscale only). Every timestamp the server stores comes from `clock`,
 * never from a request body: offline detection relies on server-stamped heartbeats. `newId`
 * generates the ids of new projects, milestones and so on (random unless a test pins it).
 * `opts.scheduler` is the running understanding scheduler, or absent when the layer is switched off.
 */
export function createApp(
  db: DatabaseSync,
  config: ServerConfig,
  clock: () => Date = () => new Date(),
  newId?: DomainDeps['newId'],
  opts: AppOptions = {},
): Hono {
  const scheduler = opts.scheduler ?? null;
  const app = new Hono();
  const deps: DomainDeps = { now: clock, newId: newId ?? defaultDeps().newId };

  // Anything not handled below is a bug: say so on stderr, tell the client only that it happened.
  app.onError((err, c) => {
    console.error(`herdr-pm server: unhandled error in ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: 'internal' }, 500);
  });

  app.post('/ingest/snapshot', async (c) => {
    const push = await readPush(c, config, SnapshotPush, (p) => [
      ...p.sessions.map((s, i) => checkKey(s.key, `sessions[${i}].key`, p.machine)),
      ...p.purged.map((key, i) => checkKey(key, `purged[${i}]`, p.machine)),
    ]);
    if (push instanceof Response) return push;
    applySnapshot(db, push, clock());
    return c.json({ ok: true });
  });

  app.post('/ingest/chunks', async (c) => {
    const push = await readPush(c, config, ChunkPush, (p) =>
      p.chunks.map((chunk, i) => checkKey(chunk.session_key, `chunks[${i}].session_key`, p.machine)),
    );
    if (push instanceof Response) return push;
    return c.json(insertChunks(db, push, clock()));
  });

  app.get('/ingest/offset', (c) => {
    const labels = authenticate(c, config);
    if (labels instanceof Response) return labels;
    const machine = c.req.query('machine');
    if (!machine) return c.json({ error: 'query parameter "machine" is required' }, 400);
    const forbidden = requireMachine(c, labels, machine);
    if (forbidden) return forbidden;
    const sessionKey = c.req.query('session_key');
    if (!sessionKey) return c.json({ error: 'query parameter "session_key" is required' }, 400);
    const body: OffsetResponse = { session_key: sessionKey, max_offset_end: maxOffset(db, sessionKey) };
    return c.json(body);
  });

  app.get('/sessions', (c) =>
    c.json(
      listSessions(db, { machine: c.req.query('machine') || undefined, lifecycle: c.req.query('lifecycle') || undefined }, clock()),
    ),
  );

  app.get('/sessions/by-short-id/:sid', (c) => c.json(findByShortId(db, c.req.param('sid'), clock())));

  app.get('/status', (c) => c.json({ understanding: scheduler?.status() ?? disabledStatus() }));

  app.post('/sync', userAuth(config), (c) => {
    if (scheduler === null) return c.json({ error: 'understanding_disabled' }, 409);
    scheduler.requestSync();
    return c.json({ accepted: true }, 202);
  });

  mountDomainRoutes(app, db, config, deps);

  return app;
}

export type AppOptions = { scheduler?: Scheduler | null };

/**
 * Authenticates an ingest request, then reads and validates its JSON body. Order: bearer token
 * (401), JSON with a `machine` string (400), token belongs to that machine (403), zod schema and
 * session keys (400). Returns the parsed push, or the error response to send.
 */
async function readPush<T extends { machine: string }>(
  c: Context,
  config: ServerConfig,
  schema: ZodType<T>,
  keyErrors: (push: T) => Array<string | null>,
): Promise<T | Response> {
  const labels = authenticate(c, config);
  if (labels instanceof Response) return labels;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'request body is not valid JSON' }, 400);
  }
  const machine = typeof body === 'object' && body !== null ? (body as { machine?: unknown }).machine : undefined;
  if (typeof machine !== 'string' || machine === '') {
    return c.json({ error: 'request body must be an object with a "machine" string' }, 400);
  }
  const forbidden = requireMachine(c, labels, machine);
  if (forbidden) return forbidden;

  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid request body', issues: parsed.error.issues }, 400);
  const keyError = keyErrors(parsed.data).find((e) => e !== null);
  if (keyError) return c.json({ error: keyError }, 400);
  return parsed.data;
}

/** Labels of every collector whose token equals the presented bearer token, or a 401 response. */
function authenticate(c: Context, config: ServerConfig): string[] | Response {
  const unauthorized = () => {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'missing or invalid bearer token' }, 401);
  };
  const match = /^Bearer +(\S+)$/i.exec(c.req.header('Authorization') ?? '');
  if (!match) return unauthorized();
  const presented = Buffer.from(match[1]);
  // Compare against every configured token (no early exit) in constant time; timingSafeEqual
  // needs equal lengths, so a token of a different length simply cannot match.
  const labels = Object.entries(config.collectors)
    .filter(([, token]) => {
      const expected = Buffer.from(token);
      return expected.length === presented.length && timingSafeEqual(expected, presented);
    })
    .map(([label]) => label);
  return labels.length > 0 ? labels : unauthorized();
}

/** 403 unless the authenticated token is the one configured for the declared machine. */
function requireMachine(c: Context, labels: string[], machine: string): Response | null {
  return labels.includes(machine) ? null : c.json({ error: `token is not valid for machine ${JSON.stringify(machine)}` }, 403);
}

/**
 * A key that does not parse would be stored and then make every session read throw (short ids are
 * computed over all stored keys), so it is rejected here. A pending key must carry the pushing machine.
 */
function checkKey(key: string, where: string, machine: string): string | null {
  let parsed: ReturnType<typeof parseSessionKey>;
  try {
    parsed = parseSessionKey(key);
  } catch {
    return `invalid session key at ${where}: ${JSON.stringify(key)}`;
  }
  if (parsed.kind === 'pending' && parsed.machine !== machine) {
    return `session key at ${where} is pending for machine ${JSON.stringify(parsed.machine)}, not ${JSON.stringify(machine)}: ${JSON.stringify(key)}`;
  }
  return null;
}
