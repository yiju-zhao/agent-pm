import { afterEach, beforeEach, expect, test } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';
import { createAdmin, passwordMatches, adminAccount } from '../../src/server/admin-auth.ts';

let db: DatabaseSync;
let app: ReturnType<typeof createApp>;
let now: Date;
const config = { port: 7718, dbPath: ':memory:', userToken: 'user-token-at-least-16', mcpToken: 'mcp-token-at-least-16', collectors: {} };
const password = 'original-password-123';
const nextPassword = 'new-password-long-456';
async function req(path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
  const res = await app.request(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-PM': 'browser', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { res, body: await res.json(), cookie: res.headers.get('Set-Cookie')?.split(';')[0] };
}
async function login(pass = password) { return req('/auth/login', { username: 'admin', password: pass }); }
beforeEach(async () => {
  db = openDb(':memory:'); now = new Date('2026-11-11T20:00:00Z');
  await createAdmin(db, 'admin', password, now);
  app = createApp(db, config, () => now);
});
afterEach(() => db.close());

test('login uses a revocable HttpOnly cookie; password and session secret are not stored in plaintext', async () => {
  const { res, body, cookie } = await login();
  expect(res.status).toBe(200);
  expect(body).toEqual({ configured: true, username: 'admin', must_change_password: false });
  expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
  expect(res.headers.get('Set-Cookie')).toContain('SameSite=Strict');
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(JSON.stringify(db.prepare('SELECT * FROM admin_account').all())).not.toContain(password);
  expect(JSON.stringify(db.prepare('SELECT * FROM admin_sessions').all())).not.toContain(cookie!.split('=')[1]);
  expect((await req('/auth/session', undefined, cookie)).body.username).toBe('admin');
  expect((await req('/admin/keys', undefined, cookie)).res.status).toBe(200);
  expect((await req('/projects', { title: 'cookie-only project' }, cookie)).res.status).toBe(201);
});

test('wrong password and unknown user return the same error; login is throttled', async () => {
  expect((await login('wrong')).body).toEqual((await req('/auth/login', { username: 'nobody', password })).body);
  for (let i = 0; i < 8; i++) await login('wrong');
  expect((await login()).res.status).toBe(429);
  now = new Date(now.getTime() + 5 * 60_000 + 1);
  expect((await login()).res.status).toBe(200);
});

test('cookie writes and login reject cross-origin requests and missing custom headers', async () => {
  expect((await req('/auth/login', { username: 'admin', password }, undefined, { Origin: 'https://evil.example' })).res.status).toBe(403);
  const { cookie } = await login();
  expect((await req('/projects', { title: 'bad' }, cookie, { Origin: 'http://evil.localhost' })).res.status).toBe(403);
  expect((await req('/projects', { title: 'bad' }, cookie, { 'X-Agent-PM': '' })).res.status).toBe(403);
  expect((await req('/projects', { title: 'good' }, cookie, { Origin: 'http://localhost' })).res.status).toBe(201);
});

test('logout revokes the cookie and expired sessions cannot write', async () => {
  const { cookie } = await login();
  await req('/auth/logout', {}, cookie);
  expect((await req('/auth/session', undefined, cookie)).body.username).toBeNull();
  expect((await req('/projects', { title: 'bad' }, cookie)).res.status).toBe(401);
  const second = await login();
  now = new Date(now.getTime() + 7 * 24 * 3600_000 + 1);
  expect((await req('/admin/settings', undefined, second.cookie)).res.status).toBe(401);
});

test('password change checks old password, revokes other browsers and issues a fresh session', async () => {
  const first = await login(), second = await login();
  expect((await req('/auth/password', { current_password: 'wrong', password: nextPassword }, first.cookie)).res.status).toBe(400);
  const changed = await req('/auth/password', { current_password: password, password: nextPassword }, first.cookie);
  expect(changed.res.status).toBe(200);
  expect((await req('/admin/keys', undefined, second.cookie)).res.status).toBe(401);
  expect((await req('/admin/keys', undefined, first.cookie)).res.status).toBe(401);
  expect((await req('/admin/keys', undefined, changed.cookie)).res.status).toBe(200);
  expect((await login()).res.status).toBe(401);
  expect((await login(nextPassword)).res.status).toBe(200);
});

test('initial password permits only changing password until replaced', async () => {
  db.prepare('UPDATE admin_account SET must_change_password = 1').run();
  const first = await login();
  expect(first.body.must_change_password).toBe(true);
  expect((await req('/admin/settings', undefined, first.cookie)).res.status).toBe(403);
  const changed = await req('/auth/password', { current_password: password, password: nextPassword }, first.cookie);
  expect(changed.body.must_change_password).toBe(false);
  expect((await req('/admin/settings', undefined, changed.cookie)).res.status).toBe(200);
});

test('browser cookies cannot authenticate MCP or collectors; bearer keys retain scopes', async () => {
  const { cookie } = await login();
  expect((await req('/mcp', {}, cookie)).res.status).toBe(401);
  expect((await req('/ingest/snapshot', {}, cookie)).res.status).toBe(401);
  expect((await req('/projects', { title: 'legacy key' }, undefined, { Authorization: `Bearer ${config.userToken}` })).res.status).toBe(201);
  expect((await req('/admin/keys', undefined, cookie, { Authorization: `Bearer ${config.mcpToken}` })).res.status).toBe(401);
});

test('credentials are validated, account setup cannot overwrite an existing administrator', async () => {
  await expect(createAdmin(db, 'other', nextPassword, now)).rejects.toThrow();
  await expect(createAdmin(db, 'admin', 'short', now)).rejects.toThrow();
  expect(await passwordMatches(password, adminAccount(db)!.password_hash)).toBe(true);
  expect((await req('/auth/login', { username: 'admin', password, extra: true })).res.status).toBe(400);
  const https = await app.request('https://localhost/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-PM': 'browser' }, body: JSON.stringify({ username: 'admin', password }) });
  expect(https.headers.get('Set-Cookie')).toContain('Secure');
});
