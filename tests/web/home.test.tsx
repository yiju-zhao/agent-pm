// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectCard } from '../../src/domain/read.ts';
import { setToken } from '../../web/src/api.ts';
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

type Data = { projects: ProjectCard[] };
let data: Data;

/** The workspace reads projects; question actions still go to the shared API. */
function serve(): void {
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === 'POST') return json({ status: 'applied', event_id: 7, question_ids: [], warnings: [] });
    switch (String(input)) {
      case '/projects':
        return json(data.projects);
      default:
        return json({ error: 'not_found' }, 404);
    }
  });
}

const region = (name: string | RegExp) => screen.getByRole('region', { name });

const requests = (path: string) => fetchMock.mock.calls.filter(([input]) => String(input) === path).length;

/** Renders the project workspace and waits for its read. */
async function renderHome() {
  const view = render(
    <StreamContext.Provider value={stream}>
      <HomePage />
    </StreamContext.Provider>,
  );
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull());
  return view;
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  listeners = new Set();
  data = { projects: [] };
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

test('a project question stays on its card without a second sidebar copy', async () => {
  data.projects = [card({ id: 'p_1', pending_questions: [question({ id: 'q_1', prompt: '评测集用哪个？' })] })];
  await renderHome();
  expect(screen.getAllByText('评测集用哪个？')).toHaveLength(1);
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

test('each kanban column keeps the server’s priority order, new ideas among the others', async () => {
  // The server sends the projects by priority; the list groups them, the kanban must not.
  data.projects = [
    card({ id: 'a', title: '高优先 idea（新）', stage: 'idea', priority: 'P0', inbox: true }),
    card({ id: 'b', title: '中优先 idea', stage: 'idea', priority: 'P1' }),
    card({ id: 'c', title: '低优先 idea（新）', stage: 'idea', priority: 'P3', inbox: true }),
  ];
  localStorage.setItem('herdr-pm.homeView', 'kanban');
  await renderHome();
  const links = within(region('idea · 3')).getAllByRole('link').map((a) => a.textContent);
  expect(links).toEqual(['高优先 idea（新）', '中优先 idea', '低优先 idea（新）']);
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

test('a question answered on a project card clears without the stream', async () => {
  setToken('tok-1');
  const q = question({ id: 'q_1', prompt: '评测集用哪个？' });
  data.projects = [card({ id: 'p_1', pending_questions: [q] })];
  await renderHome();
  data.projects = [card({ id: 'p_1', pending_questions: [] })];
  const article = document.querySelector('article[data-project-id="p_1"]') as HTMLElement;
  fireEvent.click(within(article).getByRole('button', { name: '公开 v2' }));
  await waitFor(() => expect(screen.queryByText('评测集用哪个？')).toBeNull());
});

test('a projects change and reconnect reload the project workspace only', async () => {
  data.projects = [card({ id: 'a', title: '旧标题' })];
  await renderHome();

  data.projects = [card({ id: 'a', title: '新标题' })];
  emit('projects');
  expect(await screen.findByRole('link', { name: '新标题' })).toBeTruthy();

  const before = requests('/projects');
  emit('all');
  await waitFor(() => expect(requests('/projects')).toBe(before + 1));
  expect(requests('/questions?status=pending')).toBe(0);
  expect(requests('/sessions')).toBe(0);
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull());
});

test('a project with a todo shows it as the next step on its card', async () => {
  data.projects = [card({ id: 'a', open_todos: [todo({ title: '评测报告模板' })], active_sessions: [tag()] })];
  await renderHome();
  expect(screen.getByText('下一步：评测报告模板')).toBeTruthy();
});

test('project search, stage and priority combine and remain active when switching views', async () => {
  data.projects = [
    card({ id: 'a', title: 'Agent 平台', summary: '管理多机工作', stage: 'build', priority: 'P1' }),
    card({ id: 'b', title: '其他平台', stage: 'verify', priority: 'P1' }),
    card({ id: 'c', title: '低优先 Agent', stage: 'build', priority: 'P3' }),
  ];
  await renderHome();
  fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: ' AGENT ' } });
  fireEvent.change(screen.getByLabelText('筛选项目阶段'), { target: { value: 'build' } });
  fireEvent.change(screen.getByLabelText('筛选项目优先级'), { target: { value: 'P1' } });
  expect(screen.getByRole('link', { name: 'Agent 平台' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: '其他平台' })).toBeNull();
  expect(screen.queryByRole('link', { name: '低优先 Agent' })).toBeNull();
  expect(screen.getByText('显示 1 / 3 个项目')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '看板' }));
  expect(within(region('构建 · 1')).getByRole('link', { name: 'Agent 平台' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
  expect(screen.getByRole('link', { name: '其他平台' })).toBeTruthy();
  expect(screen.getByRole('link', { name: '低优先 Agent' })).toBeTruthy();
});

test('filtering includes folded projects, missing priorities and merged projects on the board', async () => {
  data.projects = [
    card({ id: 'a', title: '正式项目', priority: 'P1' }),
    card({ id: 'b', title: '新想法', stage: 'idea', inbox: true, priority: null, summary: '特别关键词' }),
    card({ id: 'c', title: '已经合并', stage: 'merged', closed: true, priority: null }),
  ];
  await renderHome();
  fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: '特别关键词' } });
  expect(screen.getByRole('link', { name: '新想法' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('筛选项目优先级'), { target: { value: 'none' } });
  fireEvent.change(screen.getByLabelText('筛选项目阶段'), { target: { value: 'merged' } });
  fireEvent.click(screen.getByRole('button', { name: '看板' }));
  expect(within(region('合并 · 1')).getByRole('link', { name: '已经合并' })).toBeTruthy();
});

test('an empty filter result can be cleared and live updates still obey the filters', async () => {
  data.projects = [card({ id: 'a', title: '构建项目', stage: 'build' })];
  await renderHome();
  fireEvent.change(screen.getByLabelText('筛选项目阶段'), { target: { value: 'verify' } });
  expect(screen.getByText('没有符合条件的项目')).toBeTruthy();
  data.projects = [card({ id: 'a', title: '构建项目', stage: 'verify' })];
  emit('projects');
  expect(await screen.findByRole('link', { name: '构建项目' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: 'no match' } });
  fireEvent.click(screen.getByRole('button', { name: '查看全部项目' }));
  expect(screen.getByRole('link', { name: '构建项目' })).toBeTruthy();
  expect((screen.getByLabelText('筛选项目阶段') as HTMLSelectElement).value).toBe('all');
});


test('the project workspace has no pending queue sidebar or attribution reads', async () => {
  data.projects = [card()];
  await renderHome();
  expect(document.querySelector('[data-page="home"] aside')).toBeNull();
  expect(screen.queryByRole('region', { name: /需要你|待归属/ })).toBeNull();
  expect(requests('/questions?status=pending')).toBe(0);
  expect(requests('/sessions')).toBe(0);
});
