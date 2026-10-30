import { z } from 'zod';
import { OffsetResponse } from '../shared/protocol.ts';
import type { ChunkPush, SnapshotPush } from '../shared/protocol.ts';

/** A failure worth retrying later unchanged: the server was unreachable, timed out or answered 5xx. */
export class RetryableError extends Error {
  override name = 'RetryableError';
}

export type PushResult = { inserted: number; duplicates: number };

export type PmClient = {
  pushSnapshot(p: SnapshotPush): Promise<void>;
  pushChunks(p: ChunkPush): Promise<PushResult>;
  /** The server's resume position for a transcript (a byte offset), or null when it has none. */
  getOffset(key: string): Promise<number | null>;
};

export type PmClientOptions = {
  server: string;
  machine: string;
  token: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

const PushResultBody = z.object({ inserted: z.number(), duplicates: z.number() });

const DEFAULT_TIMEOUT_MS = 30_000;

/** HTTP client for the central server's `/ingest/*` API, authenticated with the machine's bearer token. */
export function createPmClient(opts: PmClientOptions): PmClient {
  const base = opts.server.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const what = `${method} ${path.split('?')[0]}`;
    const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw new RetryableError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!res.ok) {
      const message = `${what} -> HTTP ${res.status}: ${text.slice(0, 500)}`;
      if (res.status >= 500 || res.status === 408 || res.status === 429) throw new RetryableError(message);
      throw new Error(message);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RetryableError(`${what} returned a non-JSON body: ${text.slice(0, 200)}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error(`${what} returned an unexpected body: ${text.slice(0, 200)}`);
    return parsed.data;
  }

  return {
    async pushSnapshot(p) {
      await call('POST', '/ingest/snapshot', z.unknown(), p);
    },
    pushChunks(p) {
      return call('POST', '/ingest/chunks', PushResultBody, p);
    },
    async getOffset(key) {
      const query = new URLSearchParams({ session_key: key, machine: opts.machine });
      const body = await call('GET', `/ingest/offset?${query}`, OffsetResponse);
      return body.max_offset_end;
    },
  };
}
