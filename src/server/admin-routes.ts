import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { DomainDeps } from '../domain/types.ts';
import type { ServerConfig } from './config.ts';
import { userAuth } from './domain-routes.ts';
import { createKey, KeyError, listKeys, principalOf, revokeKey } from './keys.ts';
import { CREDENTIAL_MODES, LLM_ROLES, SettingsError } from './settings.ts';
import type { Settings } from './settings.ts';

// `/admin/*`: API keys and settings, for an `admin` key only. Nothing here ever answers with a secret except the one
// response that creates a key (its only showing).

const MAX_BODY_BYTES = 16 * 1024;

const CreateKey = z.object({ name: z.string(), scope: z.string() }).strict();
const PutModels = z.object({ models: z.partialRecord(z.enum(LLM_ROLES), z.string()) }).strict();
const PutProvider = z.object({ mode: z.enum(CREDENTIAL_MODES), secret: z.string().optional() }).strict();

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'invalid', message: 'request body is not valid JSON' }, 400);
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : c.json({ error: 'invalid', message: z.prettifyError(parsed.error) }, 400);
}

export function mountAdminRoutes(app: Hono, db: DatabaseSync, config: ServerConfig, deps: DomainDeps, settings: Settings): void {
  const admin = userAuth(config, db, deps.now);
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'too_large' }, 413) });

  app.get('/admin/keys', admin, (c) => {
    const machines = [
      ...new Set([
        ...Object.keys(config.collectors),
        ...(db.prepare(`SELECT DISTINCT machine FROM ingest_sources WHERE kind = 'herdr'`).all() as Array<{ machine: string }>).map((r) => r.machine),
      ]),
    ].sort();
    return c.json({ keys: listKeys(db, config), machines, paseo_sources: Object.keys(config.paseoCollectors ?? {}) });
  });

  app.post('/admin/keys', admin, limit, async (c) => {
    const args = await body(c, CreateKey);
    if (args instanceof Response) return args;
    const by = principalOf(c, db, config, deps.now());
    try {
      const made = createKey(db, config, { ...args, createdBy: by?.id ?? 'unknown' }, deps.now(), () => `k_${randomBytes(6).toString('hex')}`);
      return c.json({ key: made.key, ...made.view }, 201);
    } catch (err) {
      if (err instanceof KeyError) return c.json({ error: 'invalid', message: err.message }, 400);
      throw err;
    }
  });

  app.delete('/admin/keys/:id', admin, (c) => {
    try {
      return revokeKey(db, c.req.param('id'), deps.now()) ? c.json({ revoked: true }) : c.json({ error: 'not_found' }, 404);
    } catch (err) {
      if (err instanceof KeyError) return c.json({ error: 'config_key', message: err.message }, 409);
      throw err;
    }
  });

  app.get('/admin/settings', admin, (c) => c.json(settings.view()));

  app.put('/admin/settings/models', admin, limit, async (c) => {
    const args = await body(c, PutModels);
    if (args instanceof Response) return args;
    try {
      settings.setModels(args.models);
      return c.json(settings.view());
    } catch (err) {
      if (err instanceof SettingsError) return c.json({ error: 'invalid', message: err.message }, 400);
      throw err;
    }
  });

  app.put('/admin/settings/provider', admin, limit, async (c) => {
    const args = await body(c, PutProvider);
    if (args instanceof Response) return args;
    try {
      settings.setProvider(args.mode, args.secret);
      return c.json(settings.view());
    } catch (err) {
      if (err instanceof SettingsError) return c.json({ error: 'invalid', message: err.message }, 400);
      throw err;
    }
  });

  app.delete('/admin/settings/provider/:kind', admin, (c) => {
    const kind = c.req.param('kind');
    if (kind !== 'oauth_token' && kind !== 'api_key') return c.json({ error: 'not_found' }, 404);
    settings.clearSecret(kind);
    return c.json(settings.view());
  });
}
