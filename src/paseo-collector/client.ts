import { z } from 'zod';
import { BatchAck, CheckpointResponse, LeaseResponse, SnapshotV2Response, V2Error } from '../shared/ingest-v2.ts';
import type { BatchV2, LeaseRequest, SnapshotV2 } from '../shared/ingest-v2.ts';

/** Worth retrying unchanged later: the center was unreachable, timed out, or answered 408, 429 or 5xx. */
export class RetryableError extends Error {
  override name = 'RetryableError';
}

/** The center refused a write for a reason the collector reconciles (lease, revision, checkpoint, conflict…). */
export class RefusedError extends Error {
  override name = 'RefusedError';
  readonly code: V2Error['error'];
  readonly checkpoint: V2Error['checkpoint'];
  readonly status: number;
  constructor(status: number, body: V2Error) {
    super(`${body.error}${body.message ? `: ${body.message}` : ''}`);
    this.status = status;
    this.code = body.error;
    this.checkpoint = body.checkpoint;
  }
}

/** Not worth retrying: bad token, a token for another source, an invalid request. Needs a person. */
export class FatalError extends Error {
  override name = 'FatalError';
}

export type CenterClient = {
  lease(req: LeaseRequest): Promise<LeaseResponse>;
  snapshot(body: SnapshotV2): Promise<SnapshotV2Response>;
  checkpoint(agentId: string): Promise<CheckpointResponse>;
  /** Sends a batch exactly as given (the outbox's bytes), so a resend is byte-identical. */
  batch(body: BatchV2): Promise<BatchAck>;
};

export type CenterClientOptions = {
  server: string;
  token: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

export function createCenterClient(opts: CenterClientOptions): CenterClient {
  const base = opts.server.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 30_000;

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
    if (res.status >= 500 || res.status === 408 || res.status === 429) throw new RetryableError(`${what} -> HTTP ${res.status}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RetryableError(`${what} -> HTTP ${res.status} with a non-JSON body`);
    }
    if (!res.ok) {
      const refusal = V2Error.safeParse(json);
      if (res.status === 409 && refusal.success && refusal.data.error !== 'identity_mismatch') throw new RefusedError(res.status, refusal.data);
      // Only the error code goes into the message: the body may echo request fields.
      const code = refusal.success ? refusal.data.error : (json as { error?: unknown })?.error;
      throw new FatalError(`${what} -> HTTP ${res.status} ${typeof code === 'string' ? code : ''}`.trim());
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new FatalError(`${what} returned an unexpected body`);
    return parsed.data;
  }

  return {
    lease: (req) => call('POST', '/ingest/v2/lease', LeaseResponse, req),
    snapshot: (body) => call('POST', '/ingest/v2/snapshot', SnapshotV2Response, body),
    checkpoint: (agentId) => call('GET', `/ingest/v2/checkpoint?${new URLSearchParams({ agent_id: agentId })}`, CheckpointResponse),
    batch: (body) => call('POST', '/ingest/v2/batches', BatchAck, body),
  };
}
