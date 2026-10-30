import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/** The token of an `Authorization: Bearer <token>` header, or null when the header is missing or has another shape. */
export function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer +(\S+)$/i.exec(authorization ?? '');
  return match ? match[1] : null;
}

/**
 * Whether a presented token equals the expected one, compared in constant time. `timingSafeEqual` needs equal
 * lengths, so a token of a different length simply cannot match (its length is all the timing gives away).
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Middleware that answers 401 (`WWW-Authenticate: Bearer`, body `{error: 'unauthorized', message}`) unless the
 * request carries `Authorization: Bearer <expected>`.
 */
export function requireToken(expected: string, message: string): MiddlewareHandler {
  return async (c, next) => {
    const presented = bearerToken(c.req.header('Authorization'));
    if (presented === null || !tokenMatches(presented, expected)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized', message }, 401);
    }
    await next();
  };
}
