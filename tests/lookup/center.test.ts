import { expect, test } from 'vitest';
import { CENTER_TIMEOUT_MS, centerHint } from '../../src/lookup/center.ts';

type FetchCall = { url: string; signal: AbortSignal | null | undefined };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // A trimmed SessionView as the central server returns it.
  return {
    key: 'claude:0d67da1f-aaaa',
    machine: 'gx10-090e',
    agent_kind: 'claude',
    title: '重构采集器',
    effective_status: 'idle',
    short_id: '0d67da1f',
    lifecycle: 'live',
    ...overrides,
  };
}

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

test('ended session gives 已结束 with machine and title', async () => {
  const { impl } = fakeFetch(() => json([view({ effective_status: 'ended', lifecycle: 'ended' })]));
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBe('这个 session 已结束（gx10-090e · 重构采集器）');
});

test('purged is reported the same way as ended', async () => {
  const { impl } = fakeFetch(() => json([view({ effective_status: 'purged' })]));
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBe('这个 session 已结束（gx10-090e · 重构采集器）');
});

test('offline gives the 采集器离线 line', async () => {
  const { impl } = fakeFetch(() => json([view({ effective_status: 'offline' })]));
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBe(
    'gx10-090e 的采集器离线，这个 session 可能还在（重构采集器）',
  );
});

test('any other status says the center knows it but herdr does not list it', async () => {
  const { impl } = fakeFetch(() => json([view({ effective_status: 'working' })]));
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBe(
    '中心记录：gx10-090e · claude · 重构采集器，但本机 herdr 没列出来',
  );
});

test('several results give one line each', async () => {
  const { impl } = fakeFetch(() =>
    json([
      view({ effective_status: 'ended' }),
      view({ machine: 'mac-mini', effective_status: 'offline', title: '另一个' }),
    ]),
  );
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBe(
    '这个 session 已结束（gx10-090e · 重构采集器）\nmac-mini 的采集器离线，这个 session 可能还在（另一个）',
  );
});

test('asks the by-short-id endpoint with a timeout signal', async () => {
  const { impl, calls } = fakeFetch(() => json([]));
  await centerHint(impl, 'http://center:7718/', '0d67da1f');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('http://center:7718/sessions/by-short-id/0d67da1f');
  expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  expect(CENTER_TIMEOUT_MS).toBe(2000);
});

test('keeps a path prefix on the server url', async () => {
  const { impl, calls } = fakeFetch(() => json([]));
  await centerHint(impl, 'http://proxy/herdr-pm', '0d67da1f');
  expect(calls[0]!.url).toBe('http://proxy/herdr-pm/sessions/by-short-id/0d67da1f');
});

test('an unreachable center gives null', async () => {
  const impl = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
});

test('a timed out request gives null', async () => {
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  const started = Date.now();
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
  expect(Date.now() - started).toBeLessThan(CENTER_TIMEOUT_MS + 1500);
}, 5000);

test('an empty list gives null', async () => {
  const { impl } = fakeFetch(() => json([]));
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
});

test('a non-2xx response gives null', async () => {
  const { impl } = fakeFetch(() => json([view({ effective_status: 'ended' })], { status: 500 }));
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
});

test('a body that is not a list of sessions gives null', async () => {
  for (const body of [{ error: 'nope' }, 'text', [{ machine: 'x' }], [view({ title: 5 })]]) {
    const { impl } = fakeFetch(() => json(body));
    expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
  }
  const { impl } = fakeFetch(() => new Response('<html>not json</html>'));
  expect(await centerHint(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
});

test('an invalid server url gives null instead of throwing', async () => {
  const { impl, calls } = fakeFetch(() => json([]));
  expect(await centerHint(impl, 'not a url', '0d67da1f')).toBeNull();
  expect(calls).toHaveLength(0);
});
