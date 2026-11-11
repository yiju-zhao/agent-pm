import { expect, test } from 'vitest';
import { CENTER_TIMEOUT_MS, centerSessions, formatCenterHint } from '../../src/lookup/center.ts';
import type { CenterSession } from '../../src/lookup/center.ts';

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
    terminal_id: 'term_65efc937b197a27',
    ...overrides,
  };
}

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

function centerSession(overrides: Partial<CenterSession> = {}): CenterSession {
  return {
    machine: 'gx10-090e',
    agent_kind: 'claude',
    effective_status: 'idle',
    title: '重构采集器',
    terminal_id: 'term_65efc937b197a27',
    sources: [],
    ...overrides,
  };
}

test('a session only Paseo sees is named as such: open it in Paseo, no herdr pane is made up', () => {
  const paseoOnly = centerSession({
    terminal_id: null,
    sources: [{ kind: 'paseo', lifecycle: 'live', external_id: 'agent-7', machine: 'mac-mini' }],
  });
  expect(formatCenterHint([paseoOnly])).toBe('这个 session 只由 Paseo 采集（mac-mini · agent agent-7 · 重构采集器），不在 herdr 里，请在 Paseo 中打开');
  // Also seen by a live herdr source: the usual hint.
  const both = centerSession({ sources: [...paseoOnly.sources, { kind: 'herdr', lifecycle: 'live', external_id: 'claude:x', machine: 'gx10-090e' }] });
  expect(formatCenterHint([both])).toBe('中心记录：gx10-090e · claude · 重构采集器，但 herdr 里没找到');
});

test('a center that predates sources still parses (no sources means none known)', async () => {
  const { impl } = fakeFetch(() => new Response(JSON.stringify([view()])));
  expect((await centerSessions(impl, 'http://c', '0d67da1f'))![0]!.sources).toEqual([]);
});

test('ended session gives 已结束 with machine and title', () => {
  expect(formatCenterHint([centerSession({ effective_status: 'ended' })])).toBe('这个 session 已结束（gx10-090e · 重构采集器）');
});

test('purged is reported the same way as ended', () => {
  expect(formatCenterHint([centerSession({ effective_status: 'purged' })])).toBe('这个 session 已结束（gx10-090e · 重构采集器）');
});

test('offline gives the 采集器离线 line', () => {
  expect(formatCenterHint([centerSession({ effective_status: 'offline' })])).toBe(
    'gx10-090e 的采集器离线，这个 session 可能还在（重构采集器）',
  );
});

test('any other status says the center knows it but herdr does not list it', () => {
  expect(formatCenterHint([centerSession({ effective_status: 'working' })])).toBe(
    '中心记录：gx10-090e · claude · 重构采集器，但 herdr 里没找到',
  );
});

test('several sessions give one line each', () => {
  expect(
    formatCenterHint([
      centerSession({ effective_status: 'ended' }),
      centerSession({ machine: 'mac-mini', effective_status: 'offline', title: '另一个' }),
    ]),
  ).toBe('这个 session 已结束（gx10-090e · 重构采集器）\nmac-mini 的采集器离线，这个 session 可能还在（另一个）');
});

test('no sessions give no hint', () => {
  expect(formatCenterHint([])).toBeNull();
});

test('centerSessions returns the sessions with their terminal ids', async () => {
  const { impl } = fakeFetch(() => json([view({ effective_status: 'working', terminal_id: 'term_abc' }), view({ terminal_id: null })]));
  expect(await centerSessions(impl, 'http://localhost:7718', '0d67da1f')).toEqual([
    { machine: 'gx10-090e', agent_kind: 'claude', effective_status: 'working', title: '重构采集器', terminal_id: 'term_abc', sources: [] },
    { machine: 'gx10-090e', agent_kind: 'claude', effective_status: 'idle', title: '重构采集器', terminal_id: null, sources: [] },
  ]);
});

test('a session without a terminal id field has none', async () => {
  const { impl } = fakeFetch(() => json([{ machine: 'm', agent_kind: 'claude', effective_status: 'idle', title: 't' }]));
  expect(await centerSessions(impl, 'http://localhost:7718', '0d67da1f')).toEqual([
    { machine: 'm', agent_kind: 'claude', effective_status: 'idle', title: 't', terminal_id: null, sources: [] },
  ]);
});

test('asks the by-short-id endpoint with a timeout signal', async () => {
  const { impl, calls } = fakeFetch(() => json([]));
  await centerSessions(impl, 'http://center:7718/', '0d67da1f');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('http://center:7718/sessions/by-short-id/0d67da1f');
  expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  expect(CENTER_TIMEOUT_MS).toBe(2000);
});

test('keeps a path prefix on the server url', async () => {
  const { impl, calls } = fakeFetch(() => json([]));
  await centerSessions(impl, 'http://proxy/agent-pm', '0d67da1f');
  expect(calls[0]!.url).toBe('http://proxy/agent-pm/sessions/by-short-id/0d67da1f');
});

test('an unreachable center gives null', async () => {
  const impl = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  expect(await centerSessions(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
});

test('a timed out request gives null', async () => {
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  const started = Date.now();
  expect(await centerSessions(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
  expect(Date.now() - started).toBeLessThan(CENTER_TIMEOUT_MS + 1500);
}, 5000);

test('an empty list gives null', async () => {
  const { impl } = fakeFetch(() => json([]));
  expect(await centerSessions(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
});

test('a non-2xx response gives null', async () => {
  const { impl } = fakeFetch(() => json([view({ effective_status: 'ended' })], { status: 500 }));
  expect(await centerSessions(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
});

test('a body that is not a list of sessions gives null', async () => {
  for (const body of [{ error: 'nope' }, 'text', [{ machine: 'x' }], [view({ title: 5 })], [view({ terminal_id: 7 })]]) {
    const { impl } = fakeFetch(() => json(body));
    expect(await centerSessions(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
  }
  const { impl } = fakeFetch(() => new Response('<html>not json</html>'));
  expect(await centerSessions(impl, 'http://localhost:7718', '0d67da1f')).toBeNull();
});

test('an invalid server url gives null instead of throwing', async () => {
  const { impl, calls } = fakeFetch(() => json([]));
  expect(await centerSessions(impl, 'not a url', '0d67da1f')).toBeNull();
  expect(calls).toHaveLength(0);
});
