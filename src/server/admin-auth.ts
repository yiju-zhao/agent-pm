import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';

export const ADMIN_COOKIE = 'agent_pm_admin';
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});

export type AdminAccount = { username: string; password_hash: string; must_change_password: number };
export type AdminSession = { username: string; must_change_password: number };

export function adminAccount(db: DatabaseSync): AdminAccount | undefined {
  return db.prepare('SELECT username, password_hash, must_change_password FROM admin_account WHERE id = 1').get() as AdminAccount | undefined;
}

export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(password, salt)).toString('hex')}`;
}

export async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [, salt, key] = encoded.split(':');
  if (!salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = await derive(password, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createAdmin(db: DatabaseSync, username: string, password: string, now: Date, temporary = false): Promise<void> {
  if (!/^[\p{L}\p{N}_.@-]{1,64}$/u.test(username) || password.length < 12 || password.length > 1024) throw new Error('用户名需为1–64个字母、数字或_.@-，密码需为12–1024个字符');
  const encoded = await passwordHash(password);
  // The unique singleton also protects concurrent setup attempts. Never replace an existing account.
  db.prepare('INSERT INTO admin_account (id, username, password_hash, must_change_password, updated_at) VALUES (1, ?, ?, ?, ?)').run(username, encoded, temporary ? 1 : 0, now.toISOString());
}

export function issueSession(db: DatabaseSync, now: Date): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now.toISOString());
  db.prepare('INSERT INTO admin_sessions (hash, expires_at) VALUES (?, ?)').run(hash(token), new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString());
  return token;
}

export function browserAdmin(c: Context, db: DatabaseSync, now: Date): AdminSession | null {
  const token = getCookie(c, ADMIN_COOKIE);
  if (!token || token.length > 128) return null;
  return db.prepare('SELECT a.username, a.must_change_password FROM admin_account a JOIN admin_sessions s ON s.hash = ? WHERE a.id = 1 AND s.expires_at > ?').get(hash(token), now.toISOString()) as AdminSession | undefined ?? null;
}

export function revokeSession(c: Context, db: DatabaseSync): void {
  const token = getCookie(c, ADMIN_COOKIE);
  if (token) db.prepare('DELETE FROM admin_sessions WHERE hash = ?').run(hash(token));
}

/** A custom header prevents cross-site form requests; Origin also rejects sibling origins. No CORS is enabled. */
export function sameOriginBrowser(c: Context): boolean {
  if (c.req.header('X-Agent-PM') !== 'browser' || c.req.header('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = c.req.header('Origin');
  return origin === undefined || origin === new URL(c.req.url).origin;
}
