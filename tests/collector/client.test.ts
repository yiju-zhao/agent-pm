import { expect, test } from 'vitest';
import { createPmClient, RetryableError } from '../../src/collector/client.ts';

type Call = { url: string; init: RequestInit };

function clientWith(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const client = createPmClient({
    server: 'http://pm.test:7718/',
    machine: 'laptop',
    token: 'tok',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond({ url, init });
    },
  });
  return { client, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('getOffset sends session_key, machine and the bearer token', async () => {
  const { client, calls } = clientWith(() => json({ session_key: 'claude:a', max_offset_end: 1234 }));
  await expect(client.getOffset('claude:a')).resolves.toBe(1234);
  const url = new URL(calls[0]!.url);
  expect(url.origin + url.pathname).toBe('http://pm.test:7718/ingest/offset');
  expect(url.searchParams.get('session_key')).toBe('claude:a');
  expect(url.searchParams.get('machine')).toBe('laptop');
  expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
});

test('getOffset returns null when the server has no chunks', async () => {
  const { client } = clientWith(() => json({ session_key: 'claude:a', max_offset_end: null }));
  await expect(client.getOffset('claude:a')).resolves.toBeNull();
});

test('pushChunks posts JSON and returns the insert counts', async () => {
  const { client, calls } = clientWith(() => json({ inserted: 2, duplicates: 1 }));
  const push = { machine: 'laptop', chunks: [] };
  await expect(client.pushChunks(push)).resolves.toEqual({ inserted: 2, duplicates: 1 });
  expect(calls[0]!.url).toBe('http://pm.test:7718/ingest/chunks');
  expect(calls[0]!.init.method).toBe('POST');
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual(push);
});

test('network errors and 5xx are retryable', async () => {
  const down = clientWith(() => Promise.reject(new TypeError('fetch failed')));
  await expect(down.client.pushSnapshot({ machine: 'laptop', collector_version: '0', sessions: [], purged: [] })).rejects.toBeInstanceOf(
    RetryableError,
  );
  const broken = clientWith(() => new Response('boom', { status: 503 }));
  await expect(broken.client.getOffset('claude:a')).rejects.toBeInstanceOf(RetryableError);
});

test('auth and validation failures are not retryable', async () => {
  for (const status of [400, 401, 403]) {
    const { client } = clientWith(() => json({ error: 'nope' }, status));
    const err = await client.getOffset('claude:a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RetryableError);
    expect((err as Error).message).toContain(String(status));
  }
});

const emptyPush = { machine: 'laptop', collector_version: '0', sessions: [], purged: [] };

test('pushSnapshot returns the sidebar labels the server answers with', async () => {
  const labels = [
    { key: 'claude:a', short_id: '0d67da1f', project: 'dLLM评测' },
    { key: 'pending:laptop:term_1', short_id: 'term_1', project: null },
  ];
  const { client, calls } = clientWith(() => json({ ok: true, labels }));
  await expect(client.pushSnapshot(emptyPush)).resolves.toEqual(labels);
  expect(calls[0]!.url).toBe('http://pm.test:7718/ingest/snapshot');
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual(emptyPush);
});

test('an old server answering {ok:true} gives no labels', async () => {
  const { client } = clientWith(() => json({ ok: true }));
  await expect(client.pushSnapshot(emptyPush)).resolves.toEqual([]);
});

test('a malformed labels field is no reason to fail the push: pushSnapshot gives no labels', async () => {
  for (const body of [
    { ok: true, labels: 'garbage' },
    { ok: true, labels: [{ key: 1 }] },
    { ok: false },
    ['not', 'an', 'object'],
    null,
  ]) {
    const { client } = clientWith(() => json(body));
    await expect(client.pushSnapshot(emptyPush)).resolves.toEqual([]);
  }
});

test('pushSnapshot still fails on HTTP errors and non-JSON bodies, as before', async () => {
  const rejected = clientWith(() => json({ error: 'nope' }, 403));
  const err = await rejected.client.pushSnapshot(emptyPush).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(RetryableError);
  expect((err as Error).message).toContain('403');

  const broken = clientWith(() => new Response('boom', { status: 503 }));
  await expect(broken.client.pushSnapshot(emptyPush)).rejects.toBeInstanceOf(RetryableError);

  const notJson = clientWith(() => new Response('<html>', { status: 200 }));
  await expect(notJson.client.pushSnapshot(emptyPush)).rejects.toBeInstanceOf(RetryableError);
});
