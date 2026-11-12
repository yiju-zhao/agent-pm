import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { ADMIN_COOKIE, SESSION_SECONDS, adminAccount, browserAdmin, issueSession, passwordHash, passwordMatches, revokeSession, sameOriginBrowser } from './admin-auth.ts';
import { transaction } from './db.ts';

const credentials = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) }).strict();
const change = z.object({ current_password: z.string().min(1).max(1024), password: z.string().min(12).max(1024) }).strict();
const dummy = 'scrypt:7b633c41081cd927cbf004e48b5d5637:' + '0'.repeat(128);
function sessionCookie(c: Context, token: string, maxAge = SESSION_SECONDS): void {
  setCookie(c, ADMIN_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'Strict', secure: new URL(c.req.url).protocol === 'https:', maxAge });
}

export function mountAuthRoutes(app: Hono, db: DatabaseSync, now: () => Date): void {
  let failures = 0;
  let resetAt = 0;
  let inFlight = 0;
  app.use('/auth/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.method !== 'GET' && !sameOriginBrowser(c)) return c.json({ error: 'forbidden', message: '请从本站页面操作' }, 403);
    await next();
  });
  app.use('/auth/*', bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }));
  app.get('/auth/session', (c) => {
    const session = browserAdmin(c, db, now());
    return c.json({ configured: adminAccount(db) !== undefined, username: session?.username ?? null, must_change_password: !!session?.must_change_password });
  });
  app.post('/auth/login', async (c) => {
    const at = now();
    if (at.getTime() >= resetAt) { failures = 0; resetAt = at.getTime() + 5 * 60_000; }
    if (failures >= 10 || inFlight >= 3) { c.header('Retry-After', '300'); return c.json({ error: 'rate_limited', message: '尝试次数过多，请5分钟后重试' }, 429); }
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', message: '请输入用户名和密码' }, 400);
    const account = adminAccount(db);
    inFlight++;
    let valid: boolean;
    try { valid = await passwordMatches(parsed.data.password, account?.password_hash ?? dummy); } finally { inFlight--; }
    if (!account || !valid || parsed.data.username !== account.username || adminAccount(db)?.password_hash !== account.password_hash) { failures++; return c.json({ error: 'unauthorized', message: '用户名或密码错误' }, 401); }
    failures = 0;
    revokeSession(c, db);
    sessionCookie(c, issueSession(db, at));
    return c.json({ configured: true, username: account.username, must_change_password: !!account.must_change_password });
  });
  app.post('/auth/logout', (c) => {
    revokeSession(c, db);
    sessionCookie(c, '', 0);
    return c.json({ ok: true });
  });
  app.post('/auth/password', async (c) => {
    const session = browserAdmin(c, db, now());
    if (!session) return c.json({ error: 'unauthorized', message: '请先登录' }, 401);
    const parsed = change.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', message: '新密码至少需要12个字符' }, 400);
    const account = adminAccount(db)!;
    const at = now().getTime();
    if (at >= resetAt) { failures = 0; resetAt = at + 5 * 60_000; }
    if (failures >= 10 || inFlight >= 3) { c.header('Retry-After', '300'); return c.json({ error: 'rate_limited', message: '尝试次数过多，请5分钟后重试' }, 429); }
    inFlight++;
    let valid: boolean;
    try { valid = await passwordMatches(parsed.data.current_password, account.password_hash); } finally { inFlight--; }
    if (!valid) { failures++; return c.json({ error: 'invalid', message: '当前密码错误' }, 400); }
    if (parsed.data.current_password === parsed.data.password) return c.json({ error: 'invalid', message: '新密码需与当前密码不同' }, 400);
    const encoded = await passwordHash(parsed.data.password);
    let token = '';
    transaction(db, () => {
      const updated = db.prepare('UPDATE admin_account SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = 1 AND password_hash = ?').run(encoded, now().toISOString(), account.password_hash);
      if (Number(updated.changes) !== 1) throw new Error('account changed during password update');
      db.exec('DELETE FROM admin_sessions');
      token = issueSession(db, now());
    });
    failures = 0;
    sessionCookie(c, token);
    return c.json({ configured: true, username: session.username, must_change_password: false });
  });
}
