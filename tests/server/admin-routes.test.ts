import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';
import type { ServerConfig } from '../../src/server/config.ts';
import { Settings } from '../../src/server/settings.ts';
import { buildQueryOptions } from '../../src/understand/agent-sdk.ts';

const USER = 'user-secret-token-0123456789';
const MCP = 'mcp-secret-token-0123456789';
const HERDR = 'herdr-laptop-token';
const PASEO = 'paseo-source-token-0123456789';

let dir: string;
let db: DatabaseSync;
let app: ReturnType<typeof createApp>;
let settings: Settings;
let config: ServerConfig;
let now = new Date('2026-11-11T10:00:00.000Z');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herdr-pm-admin-'));
  await writeFile(join(dir, 'config-oauth'), 'sk-ant-oat-from-config-file-0000\n');
  config = {
    port: 7718,
    dbPath: ':memory:',
    userToken: USER,
    mcpToken: MCP,
    collectors: { laptop: HERDR },
    paseoCollectors: { 'paseo-mini': { token: PASEO, machine: 'mac-mini', serverId: 'srv_x' } },
    understanding: { digestModel: 'claude-haiku-5-5', curateModel: 'claude-sonnet-5-5' },
  };
  db = openDb(':memory:');
  now = new Date('2026-11-11T10:00:00.000Z');
  settings = new Settings(db, config, join(dir, 'secrets'), () => now);
  app = createApp(db, config, () => now, undefined, { settings });
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

async function req(method: string, path: string, token: string | null, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}
const mcpList = (token: string) =>
  app.request('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
const herdrSnapshot = (machine: string) => ({ machine, collector_version: '1', sessions: [], purged: [] });

describe('one kind of key, told apart by scope', () => {
  test('a key made for agents works on /mcp and nowhere else', async () => {
    const made = await req('POST', '/admin/keys', USER, { name: 'gx10 的 agent', scope: 'mcp' });
    expect(made.status).toBe(201);
    expect(made.json.key).toMatch(/^hpm_/);
    const key = made.json.key as string;
    expect((await mcpList(key)).status).toBe(200);
    expect((await req('POST', '/projects', key, { title: 'x' })).status).toBe(401);
    expect((await req('POST', '/ingest/snapshot', key, herdrSnapshot('laptop'))).status).toBe(401);
    expect((await req('GET', '/admin/keys', key)).status).toBe(401);
  });

  test('a herdr collector key may push for its machine only', async () => {
    const key = (await req('POST', '/admin/keys', USER, { name: 'gx10 采集器', scope: 'ingest:herdr:gx10-090e' })).json.key;
    expect((await req('POST', '/ingest/snapshot', key, herdrSnapshot('gx10-090e'))).status).toBe(200);
    expect((await req('POST', '/ingest/snapshot', key, herdrSnapshot('laptop'))).status).toBe(403);
    expect((await mcpList(key)).status).toBe(401);
  });

  test('a Paseo collector key needs a configured source and writes only that source', async () => {
    expect((await req('POST', '/admin/keys', USER, { name: 'x', scope: 'ingest:paseo:not-configured' })).status).toBe(400);
    const key = (await req('POST', '/admin/keys', USER, { name: 'mini', scope: 'ingest:paseo:paseo-mini' })).json.key;
    const lease = await req('POST', '/ingest/v2/lease', key, { source_id: 'paseo-mini', instance_id: 'instance-1234', server_id: 'srv_x', collector_version: '1' });
    expect(lease.status).toBe(200);
  });

  test('an admin key made in the UI acts as the user until it is revoked', async () => {
    const made = (await req('POST', '/admin/keys', USER, { name: '笔记本浏览器', scope: 'admin' })).json;
    expect((await req('POST', '/projects', made.key, { title: '用新 key 建的项目' })).status).toBe(201);
    expect((await req('DELETE', `/admin/keys/${made.id}`, USER)).json).toEqual({ revoked: true });
    expect((await req('POST', '/projects', made.key, { title: 'x' })).status).toBe(401);
    expect((await req('DELETE', `/admin/keys/${made.id}`, USER)).status).toBe(404);
  });

  test('config tokens keep working with the scope their place gives them, and are listed without secrets', async () => {
    expect((await mcpList(MCP)).status).toBe(200);
    expect((await req('POST', '/ingest/snapshot', HERDR, herdrSnapshot('laptop'))).status).toBe(200);
    const list = await req('GET', '/admin/keys', USER);
    expect(list.json.keys.filter((k: { origin: string }) => k.origin === 'config').map((k: { scope: string }) => k.scope)).toEqual([
      'admin',
      'mcp',
      'ingest:herdr:laptop',
      'ingest:paseo:paseo-mini',
    ]);
    for (const secret of [USER, MCP, HERDR, PASEO]) expect(list.text).not.toContain(secret);
    expect(list.json.paseo_sources).toEqual(['paseo-mini']);
    expect((await req('DELETE', '/admin/keys/config:mcpToken', USER)).status).toBe(409);
  });

  test('a stored key is only its hash; the list shows a prefix and when it was last used', async () => {
    const made = (await req('POST', '/admin/keys', USER, { name: 'agent', scope: 'mcp' })).json;
    const raw = JSON.stringify(db.prepare('SELECT * FROM api_keys').all());
    expect(raw).not.toContain(made.key);
    expect(raw).toContain(made.key.slice(0, 10));
    now = new Date(now.getTime() + 5000);
    await mcpList(made.key);
    const listed = (await req('GET', '/admin/keys', USER)).json.keys.find((k: { id: string }) => k.id === made.id);
    expect(listed).toMatchObject({ prefix: made.key.slice(0, 10), last_used_at: now.toISOString(), revoked_at: null });
    expect(JSON.stringify(listed)).not.toContain(made.key);
  });

  test('bad requests: unknown scope, empty name', async () => {
    expect((await req('POST', '/admin/keys', USER, { name: 'x', scope: 'root' })).status).toBe(400);
    expect((await req('POST', '/admin/keys', USER, { name: '  ', scope: 'mcp' })).status).toBe(400);
    expect((await req('POST', '/admin/keys', USER, { name: 'x', scope: 'ingest:herdr:bad label' })).status).toBe(400);
  });
});

describe('settings', () => {
  test('models per role: defaults from the config, changed in the UI, restage follows curate unless set', async () => {
    expect((await req('GET', '/admin/settings', USER)).json.models).toEqual({ digest: 'claude-haiku-5-5', curate: 'claude-sonnet-5-5', restage: 'claude-sonnet-5-5' });
    const put = await req('PUT', '/admin/settings/models', USER, { models: { curate: 'claude-opus-5-5' } });
    expect(put.json.models).toEqual({ digest: 'claude-haiku-5-5', curate: 'claude-opus-5-5', restage: 'claude-opus-5-5' });
    await req('PUT', '/admin/settings/models', USER, { models: { restage: 'claude-sonnet-5-5' } });
    expect(settings.models()).toEqual({ digest: 'claude-haiku-5-5', curate: 'claude-opus-5-5', restage: 'claude-sonnet-5-5' });
    expect((await req('PUT', '/admin/settings/models', USER, { models: { digest: 'has spaces' } })).status).toBe(400);
    expect((await req('PUT', '/admin/settings/models', USER, { models: { writer: 'x' } })).status).toBe(400);
  });

  test('an API key is stored in a 0600 file, never shown again, and becomes the active credential', async () => {
    const secret = 'sk-ant-api03-test-key-abcdefghijklmnop-WXYZ';
    expect((await req('PUT', '/admin/settings/provider', USER, { mode: 'api_key' })).status).toBe(400); // nothing stored yet
    const put = await req('PUT', '/admin/settings/provider', USER, { mode: 'api_key', secret });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain(secret);
    expect(put.json.provider).toEqual({ mode: 'api_key', origin: 'settings', stored: { api_key: 'WXYZ' } });
    const file = join(dir, 'secrets', 'anthropic-api-key');
    expect((await readFile(file, 'utf8')).trim()).toBe(secret);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(db.prepare('SELECT * FROM settings').all())).not.toContain(secret);
    expect(settings.credential()).toEqual({ mode: 'api_key', key: secret });
    // Back to the subscription login; the stored key stays until it is deleted.
    await req('PUT', '/admin/settings/provider', USER, { mode: 'login' });
    expect(settings.credential()).toEqual({ mode: 'login' });
    expect((await req('DELETE', '/admin/settings/provider/api_key', USER)).json.provider.stored).toEqual({});
  });

  test('with nothing chosen, the config oauthTokenFile is used; deleting the active secret falls back to it', async () => {
    config.understanding = { ...config.understanding, oauthTokenFile: join(dir, 'config-oauth') };
    expect(settings.credential()).toEqual({ mode: 'oauth_token', token: 'sk-ant-oat-from-config-file-0000' });
    expect(settings.provider().origin).toBe('config');
    await req('PUT', '/admin/settings/provider', USER, { mode: 'oauth_token', secret: 'sk-ant-oat-from-the-ui-0000-1111' });
    expect(settings.credential()).toEqual({ mode: 'oauth_token', token: 'sk-ant-oat-from-the-ui-0000-1111' });
    await req('DELETE', '/admin/settings/provider/oauth_token', USER);
    expect(settings.credential()).toEqual({ mode: 'oauth_token', token: 'sk-ant-oat-from-config-file-0000' });
  });

  test('a center started without a secrets directory refuses to store secrets', async () => {
    const plain = createApp(db, config, () => now);
    const res = await plain.request('/admin/settings/provider', {
      method: 'PUT',
      headers: { authorization: `Bearer ${USER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'api_key', secret: 'sk-ant-api03-0000000000000000000000' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('the credential decides what a model call bills', () => {
  const sdk = { tool: (() => ({})) as never, createSdkMcpServer: (() => ({})) as never };
  const call = { role: 'digest' as const, model: 'm', system: 's', prompt: 'p', maxTurns: 1 };

  test('api key: ANTHROPIC_API_KEY only; oauth: the token only; login: neither; inherited ones never leak through', () => {
    process.env.ANTHROPIC_API_KEY = 'inherited-api-key';
    process.env.ANTHROPIC_BASE_URL = 'http://elsewhere';
    try {
      const api = buildQueryOptions(sdk, call, { credential: () => ({ mode: 'api_key', key: 'chosen-key' }) }).env!;
      expect(api.ANTHROPIC_API_KEY).toBe('chosen-key');
      expect(api.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(api.ANTHROPIC_BASE_URL).toBeUndefined();
      const oauth = buildQueryOptions(sdk, call, { credential: () => ({ mode: 'oauth_token', token: 'tok' }) }).env!;
      expect(oauth.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
      expect(oauth.ANTHROPIC_API_KEY).toBeUndefined();
      const login = buildQueryOptions(sdk, call, { credential: () => ({ mode: 'login' }) }).env!;
      expect(login.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });
});
