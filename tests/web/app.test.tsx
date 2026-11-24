// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { SchedulerStatus } from '../../src/understand/status.ts';
import { setToken } from '../../web/src/api.ts';
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
  expect(sync?.[1]?.headers).toEqual({ Authorization: 'Bearer tok-1', 'X-Agent-PM': 'browser' });
});

test('立即同步 shows the rejection in Chinese', async () => {
  serve(understanding({ enabled: false }), () => json({ error: 'understanding_disabled', message: 'x' }, 409));
  setToken('tok-1');
  renderApp();
  await screen.findByText('理解层未开启');
  fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
  expect(await screen.findByText('理解层没有开启')).toBeTruthy();
});

test('立即同步 uses a browser session without requiring a key', async () => {
  serve(understanding());
  renderApp();
  await screen.findByText('空闲');
  fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
  expect(await screen.findByText('已开始同步')).toBeTruthy();
  expect(fetchMock.mock.calls.find(([url]) => url === '/sync')?.[1]?.credentials).toBe('same-origin');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('设置 shows account and password controls, with no browser API key field', async () => {
  serve(understanding()); renderApp(); await screen.findByText('空闲');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: '修改密码' }));
  expect(within(dialog).getByLabelText('当前密码')).toBeTruthy();
  expect(within(dialog).queryByLabelText('API key')).toBeNull();
  expect((within(dialog).getByRole('button', { name: '保存密码' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('Escape closes account settings', async () => {
  serve(understanding()); renderApp(); await screen.findByText('空闲');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent(await screen.findByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
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
  expect(screen.getByRole('link', { name: '指挥台' }).getAttribute('href')).toBe('#/');
  expect(screen.getByRole('link', { name: 'Session' }).getAttribute('href')).toBe('#/sessions');
  expect(screen.getByRole('link', { name: '项目' }).getAttribute('href')).toBe('#/projects');
  expect(screen.getByRole('link', { name: '复盘' }).getAttribute('href')).toBe('#/review');
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
  expect(screen.getByRole('link', { name: '指挥台' }).getAttribute('aria-current')).toBe('page');
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


test('a paused-for-review digest shows a separate link without a runtime warning', async () => {
  serve(understanding({ blocked_sessions: 1, blocked_reason: '上游拒绝摘要，原文保留', last_error: null }));
  renderApp();
  const link = await screen.findByRole('link', { name: '1 个会话有拒摘缺口' });
  expect(link.getAttribute('href')).toBe('#/sessions');
  expect(link.getAttribute('title')).toBe('上游拒绝摘要，原文保留');
  expect(screen.queryByRole('img', { name: '最近一次出错' })).toBeNull();
});

test('a new runtime error still warns alongside a paused digest', async () => {
  serve(understanding({ blocked_sessions: 1, blocked_reason: '历史摘要暂停', last_error: '新的连接故障' }));
  renderApp();
  expect(await screen.findByRole('link', { name: '1 个会话有拒摘缺口' })).toBeTruthy();
  expect(screen.getByRole('img', { name: '最近一次出错' }).getAttribute('title')).toBe('新的连接故障');
});

test('global Inbox count shares the queue with its page and updates after answering', async () => {
  const { card, question } = await import('./fixtures.ts');
  let pending = [question({ id: 'q_1', prompt: '需要决定', session_key: null }), question({ id: 'q_2', project_id: null, session_key: 'claude:gone', prompt: '需要归属' })];
  fetchMock.mockImplementation(async (url, init) => {
    if (url === '/status') return json({ understanding: understanding() });
    if (url === '/questions?status=pending') return json(pending);
    if (url === '/projects') return json([card()]);
    if (url === '/sessions') return json([]);
    if (init?.method === 'POST') { pending = pending.filter((q) => q.id !== 'q_1'); return json({ status: 'applied', event_id: 1, question_ids: [], warnings: [] }); }
    return json({ error: 'not_found' }, 404);
  });
  renderApp();
  const link = await screen.findByRole('link', { name: 'Inbox · 2 项待处理' });
  expect(link.getAttribute('href')).toBe('#/inbox');
  expect(fetchMock.mock.calls.filter(([url]) => url === '/questions?status=pending')).toHaveLength(1);
  act(() => { history.replaceState(null, '', '#/inbox'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
  expect(await screen.findByRole('heading', { name: /Inbox 待处理事项/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Inbox · 2 项待处理' }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(within(screen.getByRole('region', { name: '需要你 · 1' })).getByRole('button', { name: '公开 v2' }));
  expect(await screen.findByRole('link', { name: 'Inbox · 1 项待处理' })).toBeTruthy();
  expect(screen.queryByText('需要决定')).toBeNull();
  expect(screen.getByText('需要归属')).toBeTruthy();
});

test('resolving a project card question also refreshes the global Inbox counter', async () => {
  const { card, question } = await import('./fixtures.ts');
  let pending = [question({ session_key: null })];
  fetchMock.mockImplementation(async (url, init) => {
    if (url === '/status') return json({ understanding: understanding() });
    if (url === '/questions?status=pending') return json(pending);
    if (url === '/projects') return json([card({ pending_questions: pending })]);
    if (init?.method === 'POST') { pending = []; return json({ status: 'applied', event_id: 1, question_ids: [], warnings: [] }); }
    if (String(url).startsWith('/activity')) return json({ error: 'not_found' }, 404);
    return json([]);
  });
  renderApp();
  await screen.findByRole('link', { name: 'Inbox · 1 项待处理' });
  fireEvent.click(await screen.findByRole('button', { name: '公开 v2' }));
  expect(await screen.findByRole('link', { name: 'Inbox · 0 项待处理' })).toBeTruthy();
});


test('queued structural changes show project review progress separately from digest backlog', async () => {
  serve(understanding({ pending_project_reviews: 2 }));
  const view=renderApp();
  expect(await screen.findByText('空闲 · 待整理 2 个项目')).toBeTruthy();
  view.unmount();
  serve(understanding({ running: 'curate', pending_project_reviews: 1, reviewing_project: 'p_1' }));
  renderApp();
  expect(await screen.findByText('项目重新整理中…')).toBeTruthy();
});
