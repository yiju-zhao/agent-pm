import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ZodType } from 'zod';
import { BatchV2, LeaseRequest, MAX_V2_BODY_BYTES, SnapshotV2 } from '../shared/ingest-v2.ts';
import type { V2Error } from '../shared/ingest-v2.ts';
import { principalOf } from './keys.ts';
import type { ServerConfig } from './config.ts';
import { acquireLease, applyPaseoSnapshot, bodyHash, commitBatch, getCheckpoint, IngestError } from './ingest-repo.ts';
import type { PaseoSource } from './ingest-repo.ts';

// `/ingest/v2/*`: the routes of Paseo collectors. A key (`ingest:paseo:<source>`) belongs to one configured source and may write that
// source only; the source, machine and daemon identity come from the server config, never from the request body (a
// body naming another source is refused). Legacy herdr tokens get nothing here, and Paseo tokens nothing on the legacy
// routes. Every timestamp is the server's clock.

function errorBody(code: V2Error['error'], message: string, checkpoint?: V2Error['checkpoint']): V2Error {
  return checkpoint === undefined ? { error: code, message } : { error: code, message, checkpoint };
}

/** The configured source whose key was presented (an `ingest:paseo:<source>` key), or the error response to send. */
function authenticateSource(c: Context, db: DatabaseSync, config: ServerConfig, clock: () => Date): PaseoSource | Response {
  const p = principalOf(c, db, config, clock());
  const entry = p?.scope.kind === 'ingest_paseo' ? config.paseoCollectors?.[p.scope.source] : undefined;
  if (p === null || p.scope.kind !== 'ingest_paseo' || entry === undefined) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'missing or invalid bearer token' }, 401);
  }
  return { sourceId: p.scope.source, machine: entry.machine, serverId: entry.serverId };
}

async function readBody<T extends { source_id: string }>(c: Context, src: PaseoSource, schema: ZodType<T>): Promise<{ body: T; raw: unknown } | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(errorBody('invalid', 'request body is not valid JSON'), 400);
  }
  const claimed = typeof raw === 'object' && raw !== null ? (raw as { source_id?: unknown }).source_id : undefined;
  if (claimed !== src.sourceId) {
    return c.json(errorBody('forbidden', `token is not valid for source ${JSON.stringify(claimed)}`), 403);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return c.json({ ...errorBody('invalid', 'invalid request body'), issues: parsed.error.issues }, 400);
  return { body: parsed.data, raw };
}

function refused(c: Context, err: unknown): Response {
  if (err instanceof IngestError) return c.json(errorBody(err.code, err.message, err.checkpoint), err.status);
  throw err;
}

export function mountIngestV2(app: Hono, db: DatabaseSync, config: ServerConfig, clock: () => Date): void {
  const limit = bodyLimit({
    maxSize: MAX_V2_BODY_BYTES,
    onError: (c) => c.json(errorBody('too_large', `request body exceeds ${MAX_V2_BODY_BYTES} bytes`), 413),
  });

  app.post('/ingest/v2/lease', limit, async (c) => {
    const src = authenticateSource(c, db, config, clock);
    if (src instanceof Response) return src;
    const read = await readBody(c, src, LeaseRequest);
    if (read instanceof Response) return read;
    try {
      return c.json(acquireLease(db, src, read.body, clock()));
    } catch (err) {
      return refused(c, err);
    }
  });

  app.post('/ingest/v2/snapshot', limit, async (c) => {
    const src = authenticateSource(c, db, config, clock);
    if (src instanceof Response) return src;
    const read = await readBody(c, src, SnapshotV2);
    if (read instanceof Response) return read;
    if (read.body.daemon.server_id !== null && read.body.daemon.server_id !== src.serverId) {
      return c.json(errorBody('identity_mismatch', `daemon ${JSON.stringify(read.body.daemon.server_id)} is not the configured one`), 409);
    }
    try {
      return c.json(applyPaseoSnapshot(db, src, read.body, clock()));
    } catch (err) {
      return refused(c, err);
    }
  });

  app.get('/ingest/v2/checkpoint', (c) => {
    const src = authenticateSource(c, db, config, clock);
    if (src instanceof Response) return src;
    const agentId = c.req.query('agent_id');
    if (!agentId) return c.json(errorBody('invalid', 'query parameter "agent_id" is required'), 400);
    return c.json(getCheckpoint(db, src, agentId));
  });

  app.post('/ingest/v2/batches', limit, async (c) => {
    const src = authenticateSource(c, db, config, clock);
    if (src instanceof Response) return src;
    const read = await readBody(c, src, BatchV2);
    if (read instanceof Response) return read;
    try {
      return c.json(commitBatch(db, src, read.body, bodyHash(read.raw), clock()));
    } catch (err) {
      return refused(c, err);
    }
  });
}
