// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectCard, QuestionView } from '../../src/domain/read.ts';
import type { SessionListItem } from '../../src/server/http.ts';
import { HomePage } from '../../web/src/pages/home.tsx';
import type { Topic } from '../../web/src/stream.ts';
import { StreamContext } from '../../web/src/use-api.ts';
import { card, question, tag, todo } from './fixtures.ts';

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

type Data = { projects: ProjectCard[]; questions: QuestionView[]; sessions: Array<Partial<SessionListItem>> };
let data: Data;

/** The server, as far as the home page sees it: three reads, answered from `data`. */
function serve(): void {
  fetchMock.mockImplementation(async (input) => {
    switch (String(input)) {
      case '/projects':
        return json(data.projects);
      case '/questions?status=pending':
        return json(data.questions);
      case '/sessions':
        return json(data.sessions);
      default:
        return json({ error: 'not_found' }, 404);
    }
  });
}

const requests = (path: string) => fetchMock.mock.calls.filter(([input]) => String(input) === path).length;

function session(over: Partial<SessionListItem> = {}): Partial<SessionListItem> {
  return {
    key: 'claude:abc',
    short_id: '0d67da1f',
    machine: 'mac-mini',
    agent_kind: 'claude',
    effective_status: 'working',
    title: 'Rea reverse engineering on macOS',
    linked_projects: [],
    ...over,
  };
}

/** Renders the page and waits until all three reads have been answered and shown. */
async function renderHome() {
  const view = render(
    <StreamContext.Provider value={stream}>
      <HomePage />
    </StreamContext.Provider>,
  );
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull());
  return view;
}

const region = (name: string | RegExp) => screen.getByRole('region', { name });

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  listeners = new Set();
  data = { projects: [], questions: [], sessions: [] };
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('shows 加载中… until the projects have arrived', async () => {
  render(
    <StreamContext.Provider value={stream}>
      <HomePage />
    </StreamContext.Provider>,
  );
  expect(screen.getAllByText('加载中…').length).toBeGreaterThan(0);
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull());
});

test('the heading counts the live projects, active and dormant separately', async () => {
  data.projects = [
    card({ id: 'a', title: '推进中 1' }),
    card({ id: 'b', title: '推进中 2' }),
    card({ id: 'c', title: '休眠的', dormant_days: 9 }),
    card({ id: 'd', title: '新 idea 不算', inbox: true, stage: 'idea' }),
    card({ id: 'e', title: '关闭的不算', closed: true, stage: 'done', dormant_days: 20 }),
  ];
  await renderHome();
  expect(screen.getByRole('heading', { name: '项目 · 按优先级 · 2 个推进中 · 1 个休眠' })).toBeTruthy();
  for (const title of ['推进中 1', '推进中 2', '休眠的']) expect(screen.getByRole('link', { name: title })).toBeTruthy();
});

test('a failed read of the projects shows the reason and a retry that reads again', async () => {
  fetchMock.mockImplementation(async (input) =>
    String(input) === '/projects' ? new Response('upstream down', { status: 500 }) : json([]),
  );
  render(
    <StreamContext.Provider value={stream}>
      <HomePage />
    </StreamContext.Provider>,
  );
  const retry = await screen.findByRole('button', { name: '重试' });
  expect(screen.getByRole('alert').textContent).toContain('服务器返回了错误');
  const before = requests('/projects');

  data.projects = [card({ title: '回来了' })];
  serve();
  fireEvent.click(retry);
  expect(await screen.findByRole('link', { name: '回来了' })).toBeTruthy();
  expect(requests('/projects')).toBe(before + 1);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('new ideas sit in a fold that starts shut, and opens on click', async () => {
  data.projects = [
    card({ id: 'a', title: '正式项目' }),
    card({ id: 'b', title: 'AI 想到的 idea 甲', inbox: true, stage: 'idea' }),
    card({ id: 'c', title: 'AI 想到的 idea 乙', inbox: true, stage: 'idea' }),
  ];
  await renderHome();
  const fold = screen.getByRole('button', { name: /新 idea（2）/ });
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('AI 想到的 idea 甲')).toBeNull();
  expect(screen.getByRole('link', { name: '正式项目' })).toBeTruthy();

  fireEvent.click(fold);
  expect(fold.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('link', { name: 'AI 想到的 idea 甲' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'AI 想到的 idea 乙' })).toBeTruthy();

  fireEvent.click(fold);
  expect(screen.queryByText('AI 想到的 idea 甲')).toBeNull();
});

test('closed projects sit in their own shut fold; a fold with nothing in it is not shown', async () => {
  data.projects = [card({ id: 'a', title: '正式项目' }), card({ id: 'b', title: '做完的', stage: 'done', closed: true })];
  await renderHome();
  expect(screen.queryByRole('button', { name: /新 idea/ })).toBeNull();
  const fold = screen.getByRole('button', { name: /已关闭（1）/ });
  expect(screen.queryByText('做完的')).toBeNull();
  fireEvent.click(fold);
  expect(screen.getByRole('link', { name: '做完的' })).toBeTruthy();
});

test('questions are split: project decisions under 需要你, session ones under 待归属 with the session tag', async () => {
  data.projects = [card({ id: 'p_1', title: 'dLLM 评测框架' })];
  data.questions = [
    question({ id: 'q_1', prompt: '评测集用哪个？', project_id: 'p_1', session_key: null }),
    question({ id: 'q_2', prompt: '这个 session 属于哪个项目？', project_id: null, session_key: 'claude:abc' }),
    question({ id: 'q_3', prompt: '已经答过的', status: 'answered' }),
  ];
  data.sessions = [session({ key: 'claude:abc', short_id: '0d67da1f', title: 'Rea reverse engineering on macOS' })];
  await renderHome();

  const need = region('需要你 · 1');
  expect(within(need).getByText('评测集用哪个？')).toBeTruthy();
  expect(within(need).getByText('dLLM 评测框架')).toBeTruthy();
  expect(within(need).queryByText('这个 session 属于哪个项目？')).toBeNull();

  const tray = region('待归属的 session · 1');
  expect(within(tray).getByText('这个 session 属于哪个项目？')).toBeTruthy();
  expect(within(tray).getByRole('button', { name: /0d67da1f/ })).toBeTruthy();
  expect(within(tray).getByText('Rea reverse engineering on macOS')).toBeTruthy();
  expect(within(tray).queryByText('评测集用哪个？')).toBeNull();
  expect(screen.queryByText('已经答过的')).toBeNull();
});

test('a session that is not in the list is shown by its key', async () => {
  data.questions = [question({ id: 'q_2', project_id: null, session_key: 'claude:gone', prompt: '归到哪里？' })];
  data.sessions = [session({ key: 'claude:other' })];
  await renderHome();
  const tray = region('待归属的 session · 1');
  expect(within(tray).getByText('claude:gone')).toBeTruthy();
  expect(within(tray).queryByRole('button', { name: /0d67da1f/ })).toBeNull();
  expect(within(tray).getByText('归到哪里？')).toBeTruthy();
});

test('a failed session list does not stop the tray: the key stands in', async () => {
  data.questions = [question({ id: 'q_2', project_id: null, session_key: 'claude:x', prompt: '归到哪里？' })];
  fetchMock.mockImplementation(async (input) => {
    switch (String(input)) {
      case '/projects':
        return json([]);
      case '/questions?status=pending':
        return json(data.questions);
      default:
        return json({ error: 'internal' }, 500);
    }
  });
  render(
    <StreamContext.Provider value={stream}>
      <HomePage />
    </StreamContext.Provider>,
  );
  const tray = await screen.findByRole('region', { name: '待归属的 session · 1' });
  expect(within(tray).getByText('claude:x')).toBeTruthy();
});

test('both lists have an empty message', async () => {
  await renderHome();
  expect(within(region('需要你 · 0')).getByText('没有需要你决定的事')).toBeTruthy();
  expect(within(region('待归属的 session · 0')).getByText('没有待归属的 session')).toBeTruthy();
});

test('a project card can be answered from the home page: its question is on the card and in 需要你', async () => {
  data.projects = [card({ id: 'p_1', pending_questions: [question({ id: 'q_1', prompt: '评测集用哪个？' })] })];
  data.questions = [question({ id: 'q_1', prompt: '评测集用哪个？' })];
  await renderHome();
  expect(screen.getAllByText('评测集用哪个？')).toHaveLength(2);
});

test('the view toggle starts on the list, switches to the kanban and remembers it', async () => {
  data.projects = [card({ id: 'a', title: '构建中的', stage: 'build', summary: '一句话摘要' })];
  await renderHome();
  const list = screen.getByRole('button', { name: '列表' });
  const kanban = screen.getByRole('button', { name: '看板' });
  expect(list.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('一句话摘要')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '探索 · 0' })).toBeNull();

  fireEvent.click(kanban);
  expect(kanban.getAttribute('aria-pressed')).toBe('true');
  expect(localStorage.getItem('herdr-pm.homeView')).toBe('kanban');
  expect(screen.getByRole('heading', { name: '构建 · 1' })).toBeTruthy();
  expect(screen.queryByText('一句话摘要')).toBeNull();

  fireEvent.click(list);
  expect(localStorage.getItem('herdr-pm.homeView')).toBe('list');
  expect(screen.getByText('一句话摘要')).toBeTruthy();
});

test('the kanban shows every project, including new ideas and closed ones, without the folds', async () => {
  data.projects = [
    card({ id: 'a', title: '构建中的', stage: 'build' }),
    card({ id: 'b', title: 'AI 的 idea', stage: 'idea', inbox: true }),
    card({ id: 'c', title: '做完的', stage: 'done', closed: true }),
  ];
  localStorage.setItem('herdr-pm.homeView', 'kanban');
  await renderHome();
  expect(within(region('idea · 1')).getByRole('link', { name: 'AI 的 idea' })).toBeTruthy();
  expect(within(region('完成 · 1')).getByRole('link', { name: '做完的' })).toBeTruthy();
  expect(within(region('构建 · 1')).getByRole('link', { name: '构建中的' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /新 idea/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /已关闭/ })).toBeNull();
});

test('the chosen view is restored on the next visit', async () => {
  localStorage.setItem('herdr-pm.homeView', 'kanban');
  await renderHome();
  expect(screen.getByRole('button', { name: '看板' }).getAttribute('aria-pressed')).toBe('true');
});

test('when the browser will not store the choice the switch still works', async () => {
  data.projects = [card({ id: 'a', title: '构建中的', stage: 'build' })];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  await renderHome();
  fireEvent.click(screen.getByRole('button', { name: '看板' }));
  expect(screen.getByRole('heading', { name: '构建 · 1' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '列表' }));
  expect(screen.queryByRole('heading', { name: '构建 · 1' })).toBeNull();
});

test('an unknown stored view falls back to the list', async () => {
  localStorage.setItem('herdr-pm.homeView', 'gantt');
  await renderHome();
  expect(screen.getByRole('button', { name: '列表' }).getAttribute('aria-pressed')).toBe('true');
});

test('a questions change makes the page read the questions again, and only those', async () => {
  data.questions = [question({ id: 'q_1', prompt: '第一个问题' })];
  await renderHome();
  expect(screen.getAllByText('第一个问题').length).toBeGreaterThan(0);
  const before = { questions: requests('/questions?status=pending'), projects: requests('/projects'), sessions: requests('/sessions') };

  data.questions = [question({ id: 'q_1', prompt: '第一个问题' }), question({ id: 'q_9', prompt: '新来的问题' })];
  emit('questions');
  expect(await screen.findByText('新来的问题')).toBeTruthy();
  expect(requests('/questions?status=pending')).toBe(before.questions + 1);
  expect(requests('/sessions')).toBe(before.sessions);
  expect(requests('/projects')).toBe(before.projects);
});

test('a projects change reads the projects again; a reconnect reads all three', async () => {
  data.projects = [card({ id: 'a', title: '旧标题' })];
  await renderHome();

  data.projects = [card({ id: 'a', title: '新标题' })];
  emit('projects');
  expect(await screen.findByRole('link', { name: '新标题' })).toBeTruthy();

  const before = { questions: requests('/questions?status=pending'), sessions: requests('/sessions') };
  emit('all');
  await waitFor(() => expect(requests('/sessions')).toBe(before.sessions + 1));
  expect(requests('/questions?status=pending')).toBe(before.questions + 1);
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull());
});

test('a project with a todo shows it as the next step on its card', async () => {
  data.projects = [card({ id: 'a', open_todos: [todo({ title: '评测报告模板' })], active_sessions: [tag()] })];
  await renderHome();
  expect(screen.getByText('下一步：评测报告模板')).toBeTruthy();
});
