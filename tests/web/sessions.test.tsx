// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectCard } from '../../src/domain/read.ts';
import type { SessionListItem } from '../../src/server/http.ts';
import { setToken } from '../../web/src/api.ts';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { SessionsPage } from '../../web/src/pages/sessions.tsx';
import type { Topic } from '../../web/src/stream.ts';
import { StreamContext } from '../../web/src/use-api.ts';
import { card, sessionItem } from './fixtures.ts';

const fetchMock = vi.fn<typeof fetch>();
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const applied = () => json({ status: 'applied', event_id: 7, question_ids: [], warnings: [] });

let sessions: SessionListItem[];
let projects: ProjectCard[];
/** What a write answers with, by `METHOD /path`; anything not listed is applied. */
let writes: Record<string, () => Response>;

/** The server as the sessions page sees it: the list under each filter, the projects, and the writes. */
function serve(): void {
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') return (writes[`${method} ${path}`] ?? applied)();
    if (path === '/projects') return json(projects);
    if (path === '/sessions') return json(sessions);
    if (path === '/sessions?lifecycle=live') return json(sessions.filter((s) => s.lifecycle === 'live'));
    if (path === '/sessions?lifecycle=ended') return json(sessions.filter((s) => s.lifecycle === 'ended'));
    return json({ error: 'not_found', message: path }, 404);
  });
}

const reads = (path: string) => fetchMock.mock.calls.filter(([input, init]) => String(input) === path && (init?.method ?? 'GET') === 'GET').length;
const writesMade = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method !== undefined && init.method !== 'GET')
    .map(([url, init]) => ({ url: String(url), method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }));

async function renderPage() {
  const view = render(
    <StreamContext.Provider value={stream}>
      <ToastProvider>
        <SessionsPage />
      </ToastProvider>
    </StreamContext.Provider>,
  );
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull());
  return view;
}

const row = (title: string) => screen.getByText(title).closest('li') as HTMLElement;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  setToken('tok-1');
  listeners = new Set();
  sessions = [sessionItem()];
  projects = [card({ id: 'p_1', title: 'dLLM 评测框架' }), card({ id: 'p_2', title: 'loopwm' })];
  writes = {};
  serve();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('is the sessions page, and reads all sessions first', async () => {
  await renderPage();
  expect(document.querySelector('main[data-page="sessions"]')).not.toBeNull();
  expect(reads('/sessions')).toBe(1);
  expect(reads('/projects')).toBe(1);
});

test('shows 加载中… until the sessions have arrived', async () => {
  render(
    <StreamContext.Provider value={stream}>
      <ToastProvider>
        <SessionsPage />
      </ToastProvider>
    </StreamContext.Provider>,
  );
  expect(screen.getByText('加载中…')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull());
  expect(screen.getByText('接入 cannbench 数据')).toBeTruthy();
});

test('says so when there are no sessions', async () => {
  sessions = [];
  await renderPage();
  expect(screen.getByText('没有 session')).toBeTruthy();
});

test('a list that cannot be read shows the reason and 重试 reads it again', async () => {
  fetchMock.mockImplementation(async () => new Response('Internal Server Error', { status: 500 }));
  render(
    <StreamContext.Provider value={stream}>
      <ToastProvider>
        <SessionsPage />
      </ToastProvider>
    </StreamContext.Provider>,
  );
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('服务器返回了错误（HTTP 500）');

  serve();
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
  expect(await screen.findByText('接入 cannbench 数据')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

// ---- filter ------------------------------------------------------------------------------------------------------

test('the filter offers 全部 / 活跃 / 已结束, and 全部 is on first', async () => {
  await renderPage();
  const group = screen.getByRole('group', { name: '筛选' });
  expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['全部', '活跃', '已结束']);
  expect(within(group).getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(group).getByRole('button', { name: '活跃' }).getAttribute('aria-pressed')).toBe('false');
});

test('活跃 reads /sessions?lifecycle=live, 已结束 reads ?lifecycle=ended, 全部 reads /sessions again', async () => {
  sessions = [
    sessionItem({ key: 'claude:abc', title: '还在跑的' }),
    sessionItem({ key: 'claude:def', title: '已经结束的', lifecycle: 'ended', effective_status: 'ended', short_id: '9a8b7c6d' }),
  ];
  await renderPage();
  expect(screen.getByText('还在跑的')).toBeTruthy();
  expect(screen.getByText('已经结束的')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '活跃' }));
  await waitFor(() => expect(reads('/sessions?lifecycle=live')).toBe(1));
  await waitFor(() => expect(screen.queryByText('已经结束的')).toBeNull());
  expect(screen.getByText('还在跑的')).toBeTruthy();
  expect(screen.getByRole('button', { name: '活跃' }).getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(screen.getByRole('button', { name: '已结束' }));
  await waitFor(() => expect(reads('/sessions?lifecycle=ended')).toBe(1));
  await waitFor(() => expect(screen.queryByText('还在跑的')).toBeNull());
  expect(screen.getByText('已经结束的')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '全部' }));
  await waitFor(() => expect(reads('/sessions')).toBe(2));
  await waitFor(() => expect(screen.getByText('还在跑的')).toBeTruthy());
});

test('the projects for the dropdown are read once, whatever the filter', async () => {
  await renderPage();
  fireEvent.click(screen.getByRole('button', { name: '活跃' }));
  await waitFor(() => expect(reads('/sessions?lifecycle=live')).toBe(1));
  expect(reads('/projects')).toBe(1);
});

// ---- rows --------------------------------------------------------------------------------------------------------

test('a row has the session tag, the title, the cwd and when it was last seen', async () => {
  sessions = [sessionItem({ last_seen: new Date(Date.now() - 5 * 60_000).toISOString() })];
  await renderPage();
  const line = row('接入 cannbench 数据');
  expect(within(line).getByRole('button', { name: /gx10-090e · claude · ●运行中 · 0d67da1f/ })).toBeTruthy();
  expect(within(line).getByText('/home/eason/projects/agent-pm')).toBeTruthy();
  expect(within(line).getByText('5 分钟前')).toBeTruthy();
});

test('a long cwd is cut in the middle and keeps the full path in its title', async () => {
  const cwd = '/Users/eason/Documents/nasa718/experiments/2026-10/very-long-directory-name/agent-pm-web';
  sessions = [sessionItem({ cwd })];
  await renderPage();
  const shown = row('接入 cannbench 数据').querySelector('.cwd') as HTMLElement;
  expect(shown.getAttribute('title')).toBe(cwd);
  expect(shown.textContent).toContain('…');
  expect(shown.textContent!.length).toBeLessThan(cwd.length);
  expect(shown.textContent!.startsWith('/Users/')).toBe(true);
  expect(shown.textContent!.endsWith('agent-pm-web')).toBe(true);
});

test('a short cwd is shown whole', async () => {
  sessions = [sessionItem({ cwd: '/srv/app' })];
  await renderPage();
  const shown = row('接入 cannbench 数据').querySelector('.cwd') as HTMLElement;
  expect(shown.textContent).toBe('/srv/app');
});

test('a session that only has the screen carries 仅屏幕, a full one does not', async () => {
  sessions = [
    sessionItem({ key: 'claude:abc', title: '屏幕读的', fidelity: 'screen' }),
    sessionItem({ key: 'claude:def', title: '完整的', fidelity: 'full', short_id: '9a8b7c6d' }),
  ];
  await renderPage();
  expect(within(row('屏幕读的')).getByText('仅屏幕')).toBeTruthy();
  expect(within(row('完整的')).queryByText('仅屏幕')).toBeNull();
});

test('sessions are grouped by machine, each group titled with the machine and how many sessions it has', async () => {
  sessions = [
    sessionItem({ key: 'claude:a1', title: '甲一', machine: 'mac-mini', short_id: 'a1a1a1a1' }),
    sessionItem({ key: 'claude:g1', title: '丙一', machine: 'gx10-090e', short_id: 'c1c1c1c1' }),
    sessionItem({ key: 'claude:a2', title: '甲二', machine: 'mac-mini', short_id: 'a2a2a2a2' }),
  ];
  await renderPage();
  const mini = screen.getByRole('region', { name: 'mac-mini · 2 个 session' });
  expect(within(mini).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    expect.stringContaining('甲一'),
    expect.stringContaining('甲二'),
  ]);
  const gx = screen.getByRole('region', { name: 'gx10-090e · 1 个 session' });
  expect(within(gx).getAllByRole('listitem')).toHaveLength(1);
  // The groups are in the order of the machine names, so they do not jump around when sessions come and go.
  expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['gx10-090e · 1 个 session', 'mac-mini · 2 个 session']);
});

test('the title and the cwd are plain text', async () => {
  sessions = [sessionItem({ title: '<img src=x onerror=alert(1)>', cwd: '/tmp/<b>x</b>' })];
  await renderPage();
  expect(document.querySelector('li img')).toBeNull();
  expect(document.querySelector('li b')).toBeNull();
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
});

// ---- linked projects ---------------------------------------------------------------------------------------------

test('a linked project is a link to its page, with a × that needs a second click', async () => {
  sessions = [sessionItem({ linked_projects: [{ id: 'p_1', title: 'dLLM 评测框架' }, { id: 'p 2', title: 'loopwm' }] })];
  await renderPage();
  const line = row('接入 cannbench 数据');
  expect(within(line).getByRole('link', { name: 'dLLM 评测框架' }).getAttribute('href')).toBe('#/p/p_1');
  expect(within(line).getByRole('link', { name: 'loopwm' }).getAttribute('href')).toBe('#/p/p%202');
  expect(within(line).getAllByRole('button', { name: '×' })).toHaveLength(2);
});

test('× asks once more; the second click is DELETE /sessions/:key/links/:project_id with the key encoded', async () => {
  sessions = [sessionItem({ linked_projects: [{ id: 'p_1', title: 'dLLM 评测框架' }] })];
  await renderPage();
  const x = within(row('接入 cannbench 数据')).getByRole('button', { name: '×' });
  fireEvent.click(x);
  expect(writesMade()).toEqual([]);
  expect(x.textContent).toBe('确认取消关联');

  fireEvent.click(x);
  await waitFor(() => expect(writesMade()).toHaveLength(1));
  expect(writesMade()[0]).toEqual({ url: '/sessions/claude%3Aabc/links/p_1', method: 'DELETE', body: undefined });
});

test('after the unlink the sessions are read again at once, without waiting for the stream', async () => {
  sessions = [sessionItem({ linked_projects: [{ id: 'p_1', title: 'dLLM 评测框架' }] })];
  await renderPage();
  expect(reads('/sessions')).toBe(1);
  sessions = [sessionItem({ linked_projects: [] })];
  const x = within(row('接入 cannbench 数据')).getByRole('button', { name: '×' });
  fireEvent.click(x);
  fireEvent.click(x);
  await waitFor(() => expect(reads('/sessions')).toBe(2));
  await waitFor(() => expect(screen.queryByRole('link', { name: 'dLLM 评测框架' })).toBeNull());
});

test('a refused unlink is shown in Chinese', async () => {
  sessions = [sessionItem({ linked_projects: [{ id: 'p_1', title: 'dLLM 评测框架' }] })];
  writes['DELETE /sessions/claude%3Aabc/links/p_1'] = () => json({ error: 'not_found', message: 'not linked' }, 404);
  await renderPage();
  const x = within(row('接入 cannbench 数据')).getByRole('button', { name: '×' });
  fireEvent.click(x);
  fireEvent.click(x);
  expect(await screen.findByText('找不到对象，可能已被删除')).toBeTruthy();
});

// ---- link dropdown -----------------------------------------------------------------------------------------------

test('关联到… lists the projects and choosing one is POST /sessions/:key/links {project_id}', async () => {
  await renderPage();
  const select = within(row('接入 cannbench 数据')).getByRole('combobox', { name: '关联到…' }) as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['关联到…', 'dLLM 评测框架', 'loopwm']);
  expect(select.value).toBe('');

  fireEvent.change(select, { target: { value: 'p_2' } });
  await waitFor(() => expect(writesMade()).toHaveLength(1));
  expect(writesMade()[0]).toEqual({ url: '/sessions/claude%3Aabc/links', method: 'POST', body: { project_id: 'p_2' } });
});

test('after linking, the dropdown is back on 关联到… so the next project can be chosen', async () => {
  await renderPage();
  const select = within(row('接入 cannbench 数据')).getByRole('combobox', { name: '关联到…' }) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: 'p_2' } });
  await waitFor(() => expect(writesMade()).toHaveLength(1));
  expect(select.value).toBe('');
});

test('a project the session is already linked to is not offered again', async () => {
  sessions = [sessionItem({ linked_projects: [{ id: 'p_1', title: 'dLLM 评测框架' }] })];
  await renderPage();
  const select = within(row('接入 cannbench 数据')).getByRole('combobox', { name: '关联到…' }) as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'p_2']);
});

test('a project that was merged into another is not offered', async () => {
  projects = [card({ id: 'p_1' }), card({ id: 'p_3', title: '已并走的', stage: 'merged', merged_into: 'p_1', closed: true })];
  await renderPage();
  const select = within(row('接入 cannbench 数据')).getByRole('combobox', { name: '关联到…' }) as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'p_1']);
});

test('a refused link is shown in Chinese', async () => {
  writes['POST /sessions/claude%3Aabc/links'] = () => json({ error: 'merged', message: 'merged' }, 409);
  await renderPage();
  fireEvent.change(within(row('接入 cannbench 数据')).getByRole('combobox', { name: '关联到…' }), { target: { value: 'p_2' } });
  expect(await screen.findByText('项目已合并到别的项目')).toBeTruthy();
});

test('without a project list the dropdown has only its placeholder, and the page still works', async () => {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input);
    if (path === '/sessions') return json(sessions);
    return json({ error: 'internal' }, 500);
  });
  await renderPage();
  const select = within(row('接入 cannbench 数据')).getByRole('combobox', { name: '关联到…' }) as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['关联到…']);
});

// ---- ignoring ----------------------------------------------------------------------------------------------------

test('a tracked session has 不追踪; clicking it is PUT /sessions/:key/ignored {ignored:true}', async () => {
  await renderPage();
  const line = row('接入 cannbench 数据');
  expect(line.className).not.toContain('ignored');
  expect(within(line).queryByRole('button', { name: '恢复追踪' })).toBeNull();
  fireEvent.click(within(line).getByRole('button', { name: '不追踪' }));
  await waitFor(() => expect(writesMade()).toHaveLength(1));
  expect(writesMade()[0]).toEqual({ url: '/sessions/claude%3Aabc/ignored', method: 'PUT', body: { ignored: true } });
});

test('an ignored session is faded, has 恢复追踪, and clicking it is PUT .../ignored {ignored:false}', async () => {
  sessions = [sessionItem({ ignored: 1 })];
  await renderPage();
  const line = row('接入 cannbench 数据');
  expect(line.className).toContain('ignored');
  expect(within(line).queryByRole('button', { name: '不追踪' })).toBeNull();
  fireEvent.click(within(line).getByRole('button', { name: '恢复追踪' }));
  await waitFor(() => expect(writesMade()).toHaveLength(1));
  expect(writesMade()[0]).toEqual({ url: '/sessions/claude%3Aabc/ignored', method: 'PUT', body: { ignored: false } });
});

test('a write without a token asks for one and sends nothing', async () => {
  setToken(null);
  const asked = vi.fn();
  window.addEventListener('herdr-pm:auth', asked);
  await renderPage();
  fireEvent.click(within(row('接入 cannbench 数据')).getByRole('button', { name: '不追踪' }));
  await waitFor(() => expect(asked).toHaveBeenCalled());
  window.removeEventListener('herdr-pm:auth', asked);
  expect(writesMade()).toEqual([]);
  expect(await screen.findByText('需要先设置 token')).toBeTruthy();
});

// ---- live updates ------------------------------------------------------------------------------------------------

test('reads the sessions again when the server announces a change in sessions', async () => {
  await renderPage();
  expect(reads('/sessions')).toBe(1);
  sessions = [sessionItem({ title: '换了标题' })];
  emit('sessions');
  expect(await screen.findByText('换了标题')).toBeTruthy();
  expect(reads('/sessions')).toBe(2);
});

test('a link made elsewhere is an event on the project, which also refreshes the list and the dropdown', async () => {
  await renderPage();
  sessions = [sessionItem({ linked_projects: [{ id: 'p_2', title: 'loopwm' }] })];
  emit('projects');
  expect(await screen.findByRole('link', { name: 'loopwm' })).toBeTruthy();
  expect(reads('/projects')).toBe(2);
});

test('ignores changes it does not show', async () => {
  await renderPage();
  emit('questions', 'status');
  await act(async () => {});
  expect(reads('/sessions')).toBe(1);
  expect(reads('/projects')).toBe(1);
});
