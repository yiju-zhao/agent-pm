// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { setToken } from '../../web/src/api.ts';
import type { Topic } from '../../web/src/stream.ts';
import { StreamContext, useApi } from '../../web/src/use-api.ts';

type Pending = { url: string; headers: HeadersInit | undefined; resolve(body: unknown, status?: number): void; fail(err: unknown): void };

const fetchMock = vi.fn<typeof fetch>();
let calls: Pending[] = [];
let listeners: Set<(topics: Topic[]) => void> = new Set();

const stream = {
  subscribe(fn: (topics: Topic[]) => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

function emit(...topics: Topic[]): void {
  act(() => {
    for (const fn of [...listeners]) fn(topics);
  });
}

/** Answer the n-th request (0-based) the page has made. */
async function respond(n: number, body: unknown, status = 200): Promise<void> {
  await act(async () => {
    calls[n].resolve(body, status);
  });
}

function Probe(props: { path: string | null; topics: Topic[]; auth?: boolean }) {
  const { data, error, loading, reload } = useApi<{ n: number }>(props.path, props.topics, { auth: props.auth });
  return (
    <div>
      <span data-testid="data">{data === undefined ? 'none' : String(data.n)}</span>
      <span data-testid="error">{error === null ? 'none' : error.code}</span>
      <span data-testid="loading">{String(loading)}</span>
      <button onClick={reload}>reload</button>
    </div>
  );
}

const tree = (props: Parameters<typeof Probe>[0]) => (
  <StreamContext.Provider value={stream}>
    <Probe {...props} />
  </StreamContext.Provider>
);

const text = (id: string) => screen.getByTestId(id).textContent;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  calls = [];
  listeners = new Set();
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    (input, init) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({
          url: String(input),
          headers: init?.headers,
          resolve: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
          fail: reject,
        });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('loads on mount', async () => {
  render(tree({ path: '/things', topics: ['projects'] }));
  expect(calls.map((c) => c.url)).toEqual(['/things']);
  expect(text('loading')).toBe('true');
  expect(text('data')).toBe('none');
  await respond(0, { n: 1 });
  expect(text('data')).toBe('1');
  expect(text('loading')).toBe('false');
  expect(text('error')).toBe('none');
});

test('refetches when a matching topic arrives', async () => {
  render(tree({ path: '/things', topics: ['projects', 'project:p_1'] }));
  await respond(0, { n: 1 });
  emit('project:p_1');
  expect(calls).toHaveLength(2);
  await respond(1, { n: 2 });
  expect(text('data')).toBe('2');
});

test('ignores unrelated topics', async () => {
  render(tree({ path: '/things', topics: ['projects'] }));
  await respond(0, { n: 1 });
  emit('sessions', 'status', 'project:p_9');
  expect(calls).toHaveLength(1);
});

test("'all' always refetches", async () => {
  render(tree({ path: '/things', topics: ['projects'] }));
  await respond(0, { n: 1 });
  emit('all');
  expect(calls).toHaveLength(2);
});

test('keeps old data while reloading', async () => {
  render(tree({ path: '/things', topics: ['projects'] }));
  await respond(0, { n: 1 });
  emit('projects');
  expect(calls).toHaveLength(2);
  expect(text('data')).toBe('1');
  expect(text('loading')).toBe('true');
  await respond(1, { n: 2 });
  expect(text('data')).toBe('2');
  expect(text('loading')).toBe('false');
});

test('drops a stale response', async () => {
  render(tree({ path: '/things', topics: ['projects'] }));
  emit('projects');
  emit('projects');
  expect(calls).toHaveLength(3);
  await respond(2, { n: 30 });
  await respond(1, { n: 20 });
  await respond(0, { n: 10 });
  expect(text('data')).toBe('30');
  expect(text('loading')).toBe('false');
});

test('a stale failure does not replace newer data either', async () => {
  render(tree({ path: '/things', topics: ['projects'] }));
  emit('projects');
  await respond(1, { n: 2 });
  await respond(0, { error: 'boom', message: 'late' }, 500);
  expect(text('data')).toBe('2');
  expect(text('error')).toBe('none');
});

test('reload() fetches again', async () => {
  render(tree({ path: '/things', topics: [] }));
  await respond(0, { n: 1 });
  act(() => screen.getByRole('button', { name: 'reload' }).click());
  expect(calls).toHaveLength(2);
});

test('a null path does nothing', () => {
  render(tree({ path: null, topics: ['projects'] }));
  emit('all');
  act(() => screen.getByRole('button', { name: 'reload' }).click());
  expect(calls).toHaveLength(0);
  expect(text('loading')).toBe('false');
  expect(text('data')).toBe('none');
});

test('changing the path clears the data at once and drops the old path response', async () => {
  const view = render(tree({ path: '/a', topics: [] }));
  await respond(0, { n: 1 });
  expect(text('data')).toBe('1');

  view.rerender(tree({ path: '/b', topics: [] }));
  expect(calls.map((c) => c.url)).toEqual(['/a', '/b']);
  expect(text('data')).toBe('none');
  expect(text('loading')).toBe('true');

  await respond(1, { n: 2 });
  expect(text('data')).toBe('2');

  // A path going back to null clears the data too.
  view.rerender(tree({ path: null, topics: [] }));
  expect(text('data')).toBe('none');
  expect(text('loading')).toBe('false');
});

test('a late response for the previous path is dropped', async () => {
  const view = render(tree({ path: '/a', topics: [] }));
  view.rerender(tree({ path: '/b', topics: [] }));
  await respond(1, { n: 2 });
  await respond(0, { n: 1 });
  expect(text('data')).toBe('2');
});

test('an error is reported, old data survives a failed reload, and the next success clears the error', async () => {
  render(tree({ path: '/things', topics: ['projects'] }));
  await respond(0, { n: 1 });
  emit('projects');
  await respond(1, { error: 'boom', message: 'server down' }, 500);
  expect(text('error')).toBe('boom');
  expect(text('data')).toBe('1');
  expect(text('loading')).toBe('false');
  emit('projects');
  await respond(2, { n: 3 });
  expect(text('error')).toBe('none');
  expect(text('data')).toBe('3');
});

test('a fetch that rejects is a network error', async () => {
  render(tree({ path: '/things', topics: [] }));
  await act(async () => {
    calls[0].fail(new TypeError('Failed to fetch'));
  });
  expect(text('error')).toBe('network');
});

test('uses the latest topics without resubscribing', async () => {
  const view = render(tree({ path: '/things', topics: ['projects'] }));
  await respond(0, { n: 1 });
  view.rerender(tree({ path: '/things', topics: ['sessions'] }));
  emit('projects');
  expect(calls).toHaveLength(1);
  emit('sessions');
  expect(calls).toHaveLength(2);
  expect(listeners.size).toBe(1);
});

test('unsubscribes on unmount and ignores a response that arrives afterwards', async () => {
  const view = render(tree({ path: '/things', topics: ['projects'] }));
  expect(listeners.size).toBe(1);
  view.unmount();
  expect(listeners.size).toBe(0);
  await act(async () => {
    calls[0].resolve({ n: 1 });
  });
});

test('auth sends the token; without one it fails with no_token and does not fetch', async () => {
  const view = render(tree({ path: '/secret', topics: [], auth: true }));
  await waitFor(() => expect(text('error')).toBe('no_token'));
  expect(calls).toHaveLength(0);
  view.unmount();

  setToken('tok');
  render(tree({ path: '/secret', topics: [], auth: true }));
  expect(calls).toHaveLength(1);
  expect(calls[0].headers).toEqual({ Authorization: 'Bearer tok' });
});
