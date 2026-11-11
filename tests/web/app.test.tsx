// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { SchedulerStatus } from '../../src/understand/status.ts';
import { AUTH_EVENT, TOKEN_KEY, setToken } from '../../web/src/api.ts';
import { App } from '../../web/src/app.tsx';
import { ToastProvider, useToast } from '../../web/src/components/toast.tsx';
import type { StreamState, Topic } from '../../web/src/stream.ts';
import { StreamContext } from '../../web/src/use-api.ts';
import type { ConnectionSource } from '../../web/src/use-api.ts';

const fetchMock = vi.fn<typeof fetch>();

function understanding(over: Partial<SchedulerStatus> = {}): SchedulerStatus {
  return {
    enabled: true,
    paused_until: null,
    pause_reason: null,
    last_error: null,
    running: null,
    waiting_sessions: 0,
    uncurated_digests: 0,
    backfill: { sessions_total: 0, sessions_done: 0 },
    last_digest_at: null,
    last_curate_at: null,
    ...over,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** `/status` answers with the given status; `POST /sync` with `sync`; anything else is a 404. */
function serve(status: SchedulerStatus, sync: () => Response = () => json({ accepted: true }, 202)): void {
  fetchMock.mockImplementation(async (input, init) => {
    const route = `${init?.method ?? 'GET'} ${String(input)}`;
    if (route === 'GET /status') return json({ understanding: status });
    if (route === 'POST /sync') return sync();
    return json({ error: 'not_found', message: route }, 404);
  });
}

let listeners: Set<(topics: Topic[]) => void> = new Set();
let connection: StreamState = 'open';
let connectionListeners: Set<() => void> = new Set();

const source: ConnectionSource = {
  get: () => connection,
  subscribe(fn) {
    connectionListeners.add(fn);
    return () => {
      connectionListeners.delete(fn);
    };
  },
};

function setConnection(next: StreamState): void {
  connection = next;
  act(() => {
    for (const fn of [...connectionListeners]) fn();
  });
}

function renderApp() {
  return render(
    <StreamContext.Provider
      value={{
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        connection: source,
      }}
    >
      <ToastProvider>
        <App />
      </ToastProvider>
    </StreamContext.Provider>,
  );
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  history.replaceState(null, '', '/');
  listeners = new Set();
  connectionListeners = new Set();
  connection = 'open';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('shows 整理已暂停 with reason and time when paused', async () => {
  serve(understanding({ paused_until: '2026-10-30T10:05:00', pause_reason: '额度用尽' }));
  renderApp();
  expect(await screen.findByText('整理已暂停（额度用尽，10:05 恢复）')).toBeTruthy();
});

test('a paused status without a reason still reads cleanly', async () => {
  serve(understanding({ paused_until: '2026-10-30T09:07:00' }));
  renderApp();
  expect(await screen.findByText('整理已暂停（09:07 恢复）')).toBeTruthy();
});

test('shows 理解层未开启 when disabled', async () => {
  serve(understanding({ enabled: false }));
  renderApp();
  expect(await screen.findByText('理解层未开启')).toBeTruthy();
});

test('shows what the understanding layer is running', async () => {
  serve(understanding({ running: 'digest' }));
  const view = renderApp();
  expect(await screen.findByText('摘要中…')).toBeTruthy();
  view.unmount();

  serve(understanding({ running: 'curate' }));
  renderApp();
  expect(await screen.findByText('整理中…')).toBeTruthy();
});

test('idle shows the backlog, leaving out a part that is zero', async () => {
  serve(understanding({ waiting_sessions: 3, uncurated_digests: 2 }));
  const view = renderApp();
  expect(await screen.findByText('空闲 · 待摘要 3 个 session · 待整理 2 条')).toBeTruthy();
  view.unmount();

  serve(understanding({ waiting_sessions: 3 }));
  const second = renderApp();
  expect(await screen.findByText('空闲 · 待摘要 3 个 session')).toBeTruthy();
  second.unmount();

  serve(understanding({ uncurated_digests: 2 }));
  const third = renderApp();
  expect(await screen.findByText('空闲 · 待整理 2 条')).toBeTruthy();
  third.unmount();

  serve(understanding());
  renderApp();
  expect(await screen.findByText('空闲')).toBeTruthy();
});

test('a last_error shows a warning whose title is the error', async () => {
  serve(understanding({ last_error: 'rate limited: try later' }));
  renderApp();
  await screen.findByText('空闲');
  expect(screen.getByTitle('rate limited: try later').getAttribute('aria-label')).toBe('最近一次出错');
});

test('no warning without a last_error', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  expect(screen.queryByRole('img', { name: '最近一次出错' })).toBeNull();
});

test('a failing /status shows the error text instead of a status', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  renderApp();
  // The home page below the header fails the same way and says so too: look at the header only.
  await waitFor(() => expect(document.querySelector('.understanding')?.textContent).toBe('连不上服务器'));
});

test('the status is read again when the status topic arrives', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  serve(understanding({ running: 'curate' }));
  act(() => {
    for (const fn of [...listeners]) fn(['status']);
  });
  expect(await screen.findByText('整理中…')).toBeTruthy();
});

test('立即同步 posts /sync with the token and says 已开始同步', async () => {
  serve(understanding());
  setToken('tok-1');
  renderApp();
  await screen.findByText('空闲');
  fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
  expect(await screen.findByText('已开始同步')).toBeTruthy();
  const sync = fetchMock.mock.calls.find(([url]) => url === '/sync');
  expect(sync?.[1]?.method).toBe('POST');
  expect(sync?.[1]?.headers).toEqual({ Authorization: 'Bearer tok-1' });
});

test('立即同步 shows the rejection in Chinese', async () => {
  serve(understanding({ enabled: false }), () => json({ error: 'understanding_disabled', message: 'x' }, 409));
  setToken('tok-1');
  renderApp();
  await screen.findByText('理解层未开启');
  fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
  expect(await screen.findByText('理解层没有开启')).toBeTruthy();
});

test('立即同步 without a token opens the token dialog and says why', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(screen.getByText('需要先设置 token')).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url]) => url === '/sync')).toBe(false);
});

test('AUTH_EVENT opens the token dialog and saving stores the token', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  expect(screen.queryByRole('dialog')).toBeNull();

  act(() => {
    window.dispatchEvent(new Event(AUTH_EVENT));
  });
  const dialog = await screen.findByRole('dialog');
  const input = within(dialog).getByLabelText('API key');
  fireEvent.change(input, { target: { value: '  my-secret-token ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

  expect(localStorage.getItem(TOKEN_KEY)).toBe('my-secret-token');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a token the browser will not store keeps the dialog open and says so', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'my-secret-token' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  expect(await screen.findByText('无法保存 key（浏览器禁止了本地存储）')).toBeTruthy();
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('the 设置 button opens the dialog; 清除 removes the stored key', async () => {
  serve(understanding());
  setToken('old-token');
  renderApp();
  await screen.findByText('空闲');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: '清除' }));
  expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('closing the token dialog with 取消 or Escape keeps the stored token', async () => {
  serve(understanding());
  setToken('keep-me');
  renderApp();
  await screen.findByText('空闲');

  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  let dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'typed-but-not-saved' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  dialog = await screen.findByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(localStorage.getItem(TOKEN_KEY)).toBe('keep-me');
});

test('保存 does nothing for an empty token', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog');
  const save = within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
});

test('the connection dot reads 已连接, 重连中 or 已断开', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  expect(screen.getByText('已连接')).toBeTruthy();
  setConnection('connecting');
  expect(screen.getByText('重连中')).toBeTruthy();
  setConnection('closed');
  expect(screen.getByText('已断开')).toBeTruthy();
  setConnection('open');
  expect(screen.getByText('已连接')).toBeTruthy();
});

test('without a connection source the dot reads 已断开', async () => {
  serve(understanding());
  render(
    <StreamContext.Provider value={{ subscribe: () => () => {} }}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StreamContext.Provider>,
  );
  await screen.findByText('空闲');
  expect(screen.getByText('已断开')).toBeTruthy();
});

test('the home page is the default', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  expect(document.querySelector('main[data-page="home"]')).not.toBeNull();
  expect(screen.getByRole('link', { name: '首页' }).getAttribute('href')).toBe('#/');
  expect(screen.getByRole('link', { name: 'Session' }).getAttribute('href')).toBe('#/sessions');
});

test('hash routing renders the project page for #/p/p_1', async () => {
  serve(understanding());
  location.hash = '#/p/p_1';
  renderApp();
  await screen.findByText('空闲');
  const main = document.querySelector('main[data-page="project"]');
  expect(main?.getAttribute('data-project-id')).toBe('p_1');
  expect(document.querySelector('main[data-page="home"]')).toBeNull();
});

test('hash routing follows hashchange', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  location.hash = '#/sessions';
  await waitFor(() => expect(document.querySelector('main[data-page="sessions"]')).not.toBeNull());
  expect(screen.getByRole('link', { name: 'Session' }).getAttribute('aria-current')).toBe('page');
  location.hash = '#/nowhere';
  await waitFor(() => expect(document.querySelector('main[data-page="home"]')).not.toBeNull());
  expect(screen.getByRole('link', { name: '首页' }).getAttribute('aria-current')).toBe('page');
});

function Shout() {
  const toast = useToast();
  return <button onClick={() => toast('复制我')}>shout</button>;
}

test('a toast disappears after 4 seconds', () => {
  vi.useFakeTimers();
  render(
    <ToastProvider>
      <Shout />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'shout' }));
  expect(screen.getByText('复制我')).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(3999);
  });
  expect(screen.getByText('复制我')).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.queryByText('复制我')).toBeNull();
});

test('useToast outside a provider does nothing', () => {
  render(<Shout />);
  expect(() => fireEvent.click(screen.getByRole('button', { name: 'shout' }))).not.toThrow();
});
