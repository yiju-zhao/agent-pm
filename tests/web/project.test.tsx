// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectCard, ProjectDetail, QuestionView } from '../../src/domain/read.ts';
import { setToken } from '../../web/src/api.ts';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { ProjectPage } from '../../web/src/pages/project.tsx';
import type { Topic } from '../../web/src/stream.ts';
import { StreamContext } from '../../web/src/use-api.ts';
import { blocker, card, decision, detail, milestone, question, todo } from './fixtures.ts';

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

let project: ProjectDetail | null;
let projects: ProjectCard[];
let pending: QuestionView[];
/** What a write answers with, by `METHOD /path`; anything not listed is applied. */
let writes: Record<string, () => Response>;

function serve(): void {
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    const route = `${init?.method ?? 'GET'} ${path}`;
    if (route === 'GET /projects/p_1') return project === null ? json({ error: 'not_found', message: 'project p_1 not found' }, 404) : json(project);
    if (route === 'GET /projects') return json(projects);
    if (route === 'GET /questions?status=pending&project_id=p_1') return json(pending);
    if (init?.method !== undefined && init.method !== 'GET') return (writes[route] ?? applied)();
    return json({ error: 'not_found', message: route }, 404);
  });
}

const reads = (path: string) => fetchMock.mock.calls.filter(([input, init]) => String(input) === path && (init?.method ?? 'GET') === 'GET').length;
const writesMade = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method !== undefined && init.method !== 'GET')
    .map(([url, init]) => ({ url: String(url), method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }));

async function renderPage(id = 'p_1') {
  const view = render(
    <StreamContext.Provider value={stream}>
      <ToastProvider>
        <ProjectPage id={id} />
      </ToastProvider>
    </StreamContext.Provider>,
  );
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull());
  return view;
}

const region = (name: string) => screen.getByRole('region', { name });

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  setToken('tok-1');
  listeners = new Set();
  project = detail({ created_at: '2026-10-02T12:00:00.000Z' });
  projects = [card({ id: 'p_1' }), card({ id: 'p_2', title: 'loopwm' })];
  pending = [];
  writes = {};
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('shows 加载中… until the project has arrived', async () => {
  render(
    <StreamContext.Provider value={stream}>
      <ToastProvider>
        <ProjectPage id="p_1" />
      </ToastProvider>
    </StreamContext.Provider>,
  );
  expect(screen.getByText('加载中…')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull());
  expect(screen.getByRole('button', { name: 'dLLM 评测框架' })).toBeTruthy();
});

test('a project that does not exist says so and links back to the home page', async () => {
  project = null;
  await renderPage();
  expect(screen.getByText('项目不存在或已删除')).toBeTruthy();
  expect(screen.getByRole('link', { name: '回首页' }).getAttribute('href')).toBe('#/');
  expect(screen.queryByRole('region', { name: '里程碑' })).toBeNull();
});

test('the page element names the project, also while it is missing', async () => {
  project = null;
  await renderPage();
  expect(document.querySelector('main[data-page="project"]')?.getAttribute('data-project-id')).toBe('p_1');
});

test('any other failed read shows the reason and a retry that reads again', async () => {
  fetchMock.mockImplementation(async (input) => (String(input) === '/projects/p_1' ? new Response('down', { status: 500 }) : json([])));
  render(
    <StreamContext.Provider value={stream}>
      <ToastProvider>
        <ProjectPage id="p_1" />
      </ToastProvider>
    </StreamContext.Provider>,
  );
  const retry = await screen.findByRole('button', { name: '重试' });
  expect(screen.getByRole('alert').textContent).toContain('服务器返回了错误');
  expect(screen.queryByText('项目不存在或已删除')).toBeNull();

  serve();
  fireEvent.click(retry);
  expect(await screen.findByRole('button', { name: 'dLLM 评测框架' })).toBeTruthy();
});

test('a merged project has a banner linking to the project it went into', async () => {
  project = detail({ stage: 'merged', merged_into: 'p_2' });
  await renderPage();
  const banner = screen.getByText(/已合并到/).closest('div') as HTMLElement;
  expect(banner.textContent).toBe('已合并到 loopwm');
  expect(within(banner).getByRole('link', { name: 'loopwm' }).getAttribute('href')).toBe('#/p/p_2');
});

test('if the project it was merged into is not in the list, the banner links with its id', async () => {
  project = detail({ stage: 'merged', merged_into: 'p_9' });
  await renderPage();
  expect(screen.getByRole('link', { name: 'p_9' }).getAttribute('href')).toBe('#/p/p_9');
});

test('a project that is not merged has no banner', async () => {
  await renderPage();
  expect(screen.queryByText(/已合并到/)).toBeNull();
});

test('the header has priority, title, stage, and when it was created and last active', async () => {
  project = detail({ priority: 'P1', stage: 'verify', last_activity_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
  await renderPage();
  expect((screen.getByRole('combobox', { name: '优先级' }) as HTMLSelectElement).value).toBe('P1');
  expect(screen.getByRole('button', { name: 'dLLM 评测框架' })).toBeTruthy();
  expect(screen.getByText('当前阶段：验证')).toBeTruthy();
  expect(screen.getByText('创建于 10/02 · 最近活动 2 小时前')).toBeTruthy();
});

test('a project without priority shows 未定 in the menu', async () => {
  project = detail({ priority: null });
  await renderPage();
  const menu = screen.getByRole('combobox', { name: '优先级' }) as HTMLSelectElement;
  expect(menu.value).toBe('');
  expect(within(menu).getAllByRole('option').map((o) => o.textContent)).toEqual(['未定', 'P0', 'P1', 'P2', 'P3']);
});

test('picking a priority sends it; 未定 sends null; the page reads the project again', async () => {
  project = detail({ priority: 'P0' });
  await renderPage();
  const before = reads('/projects/p_1');
  fireEvent.change(screen.getByRole('combobox', { name: '优先级' }), { target: { value: 'P2' } });
  await waitFor(() => expect(reads('/projects/p_1')).toBe(before + 1));
  fireEvent.change(screen.getByRole('combobox', { name: '优先级' }), { target: { value: '' } });
  await waitFor(() => expect(reads('/projects/p_1')).toBe(before + 2));
  expect(writesMade()).toEqual([
    { url: '/projects/p_1', method: 'PATCH', body: { priority: 'P2' } },
    { url: '/projects/p_1', method: 'PATCH', body: { priority: null } },
  ]);
});

test('a locked priority and a locked title show 🔒 with 解锁, which calls their lock routes', async () => {
  project = detail({ locks: ['priority', 'title'] });
  await renderPage();
  const head = region('项目概览');
  expect(within(head).getAllByText('🔒')).toHaveLength(2);
  fireEvent.click(within(head).getByRole('button', { name: '解锁优先级' }));
  await waitFor(() => expect(writesMade()).toHaveLength(1));
  fireEvent.click(within(head).getByRole('button', { name: '解锁' }));
  await waitFor(() => expect(writesMade()).toHaveLength(2));
  expect(writesMade().map((w) => `${w.method} ${w.url}`)).toEqual(['DELETE /projects/p_1/locks/priority', 'DELETE /projects/p_1/locks/title']);
});

test('the title is edited in place', async () => {
  await renderPage();
  const head = region('项目概览');
  fireEvent.click(within(head).getByRole('button', { name: 'dLLM 评测框架' }));
  fireEvent.change(within(head).getByRole('textbox'), { target: { value: '新名字' } });
  fireEvent.keyDown(within(head).getByRole('textbox'), { key: 'Enter' });
  await waitFor(() => expect(writesMade()).toHaveLength(1));
  expect(writesMade()[0]).toEqual({ url: '/projects/p_1', method: 'PATCH', body: { title: '新名字' } });
});

test('big picture: 是什么, 为什么, 做完的标准, each with （还没有） while empty', async () => {
  project = detail({ summary: '给 Diffusion LLM 做评测', why: null, done_criteria: null });
  await renderPage();
  expect(within(region('是什么')).getByText('给 Diffusion LLM 做评测')).toBeTruthy();
  expect(within(region('为什么')).getByText('（还没有）')).toBeTruthy();
  expect(within(region('做完的标准')).getByText('（还没有）')).toBeTruthy();
});

test('a locked summary has 🔒 beside 是什么, the other fields do not', async () => {
  project = detail({ locks: ['summary'] });
  await renderPage();
  expect(within(region('是什么')).getByText('🔒')).toBeTruthy();
  expect(within(region('为什么')).queryByText('🔒')).toBeNull();
  expect(within(region('做完的标准')).queryByText('🔒')).toBeNull();
});

test('saving 为什么 sends PATCH {why}, then the page shows what the server now has', async () => {
  await renderPage();
  const why = region('为什么');
  fireEvent.click(within(why).getByText('（还没有）'));
  fireEvent.change(within(why).getByRole('textbox'), { target: { value: '评测口径不统一' } });
  project = detail({ why: '评测口径不统一', locks: ['why'], created_at: '2026-10-02T12:00:00.000Z' });
  fireEvent.keyDown(within(why).getByRole('textbox'), { key: 'Enter', metaKey: true });
  await waitFor(() => expect(within(region('为什么')).getByText('评测口径不统一')).toBeTruthy());
  expect(writesMade()).toEqual([{ url: '/projects/p_1', method: 'PATCH', body: { why: '评测口径不统一' } }]);
  expect(within(region('为什么')).getByText('🔒')).toBeTruthy();
});

test('the same for 是什么 and 做完的标准, and 解锁 deletes the lock of that field', async () => {
  project = detail({ summary: '旧', done_criteria: '旧标准', locks: ['summary', 'done_criteria'] });
  await renderPage();
  fireEvent.click(within(region('是什么')).getByText('旧'));
  fireEvent.change(within(region('是什么')).getByRole('textbox'), { target: { value: '新' } });
  fireEvent.keyDown(within(region('是什么')).getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(writesMade()).toHaveLength(1));
  fireEvent.click(within(region('做完的标准')).getByRole('button', { name: '解锁' }));
  await waitFor(() => expect(writesMade()).toHaveLength(2));
  fireEvent.click(within(region('是什么')).getByRole('button', { name: '解锁' }));
  await waitFor(() => expect(writesMade()).toHaveLength(3));
  expect(writesMade().map((w) => `${w.method} ${w.url} ${JSON.stringify(w.body ?? null)}`)).toEqual([
    'PATCH /projects/p_1 {"summary":"新"}',
    'DELETE /projects/p_1/locks/done_criteria null',
    'DELETE /projects/p_1/locks/summary null',
  ]);
});

test('a refusal (409) is told in a toast, and the field stays open with the text', async () => {
  writes['PATCH /projects/p_1'] = () => json({ error: 'merged', message: 'project p_1 was merged into p_2' }, 409);
  await renderPage();
  const why = region('为什么');
  fireEvent.click(within(why).getByText('（还没有）'));
  fireEvent.change(within(why).getByRole('textbox'), { target: { value: '想写的' } });
  fireEvent.keyDown(within(why).getByRole('textbox'), { key: 'Enter', metaKey: true });
  // The note beside the field, and the toast.
  expect(await within(why).findByText('项目已合并到别的项目')).toBeTruthy();
  expect(screen.getAllByText('项目已合并到别的项目')).toHaveLength(2);
  expect((within(why).getByRole('textbox') as HTMLTextAreaElement).value).toBe('想写的');
});

test('a refusal the page has no wording for shows the server’s own message', async () => {
  writes['PATCH /projects/p_1'] = () => json({ error: 'something_new', message: '服务器说：现在不行' }, 409);
  await renderPage();
  fireEvent.change(screen.getByRole('combobox', { name: '优先级' }), { target: { value: 'P3' } });
  expect(await screen.findByText('服务器说：现在不行')).toBeTruthy();
});

test('the project’s pending questions are asked for by project and shown as cards', async () => {
  pending = [question({ id: 'q_1', prompt: '这个项目可以收尾了吗？' }), question({ id: 'q_2', prompt: '要不要合并？' })];
  await renderPage();
  expect(screen.getByText('这个项目可以收尾了吗？')).toBeTruthy();
  expect(screen.getByText('要不要合并？')).toBeTruthy();
  expect(region('待你回答 · 2')).toBeTruthy();
});

test('answering a question reads the project and the questions again', async () => {
  pending = [question({ id: 'q_1' })];
  await renderPage();
  const projectReads = reads('/projects/p_1');
  const questionReads = reads('/questions?status=pending&project_id=p_1');
  pending = [];
  fireEvent.click(screen.getByRole('button', { name: '公开 v2' }));
  await waitFor(() => expect(screen.queryByText('评测集用哪个？')).toBeNull());
  expect(reads('/projects/p_1')).toBe(projectReads + 1);
  expect(reads('/questions?status=pending&project_id=p_1')).toBe(questionReads + 1);
});

test('without pending questions there is no such section', async () => {
  await renderPage();
  expect(screen.queryByText(/待你回答/)).toBeNull();
});

test('milestones, todos, blockers and decisions are all on the page', async () => {
  project = detail({
    milestones: [milestone({ id: 'm_1', title: '接入数据' })],
    todos: [todo({ id: 't_1', title: '写加载器', milestone_id: 'm_1' })],
    blockers: [blocker({ id: 'b_1', text: '显存不够' })],
    decisions: [decision({ id: 'd_1', text: '先用公开 v2', evidence: ['digest:3'] })],
  });
  await renderPage();
  expect(within(region('里程碑')).getByText('接入数据')).toBeTruthy();
  expect(within(region('Todo')).getByText('写加载器')).toBeTruthy();
  expect(within(region('阻塞')).getByText('显存不够')).toBeTruthy();
  expect(within(region('决策')).getByRole('button', { name: '摘要 #3' })).toBeTruthy();
});

test('a todo that points to a deleted milestone is still on the page, under 未分组', async () => {
  project = detail({ milestones: [], todos: [todo({ title: '孤儿 todo', milestone_id: 'm_deleted' })] });
  await renderPage();
  expect(within(screen.getByRole('group', { name: '未分组' })).getByText('孤儿 todo')).toBeTruthy();
});

test('the stage menu offers the other projects as merge targets, not the project itself', async () => {
  await renderPage();
  fireEvent.change(screen.getByRole('combobox', { name: '新阶段' }), { target: { value: 'merged' } });
  const target = screen.getByRole('combobox', { name: '合并到' });
  expect(within(target).getAllByRole('option').map((o) => o.textContent)).toEqual(['选择目标项目', 'loopwm']);
  fireEvent.change(target, { target: { value: 'p_2' } });
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
  await waitFor(() => expect(writesMade()).toHaveLength(1));
  expect(writesMade()[0]).toEqual({ url: '/projects/p_1/stage', method: 'POST', body: { stage: 'merged', merge_into: 'p_2' } });
});

test('deleted items are folded under 已删除的条目（n）, with what they were and when', async () => {
  project = detail({
    tombstones: [
      { table: 'todos', id: 't_9', label: '重写调度器', deleted_at: '2026-10-25T12:00:00.000Z' },
      { table: 'milestones', id: 'm_9', label: '上线', deleted_at: '2026-10-24T12:00:00.000Z' },
    ],
  });
  await renderPage();
  expect(screen.queryByText('重写调度器 · 10/25')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /已删除的条目（2）/ }));
  expect(screen.getByText('这些是你删掉的，AI 不会再把它们加回来')).toBeTruthy();
  expect(screen.getByText('重写调度器 · 10/25')).toBeTruthy();
  expect(screen.getByText('上线 · 10/24')).toBeTruthy();
});

test('with nothing deleted there is no such fold', async () => {
  await renderPage();
  expect(screen.queryByRole('button', { name: /已删除的条目/ })).toBeNull();
});

test('the places for the timeline and the event log are there', async () => {
  await renderPage();
  expect(document.querySelector('section[data-slot="timeline"]')).not.toBeNull();
  expect(document.querySelector('section[data-slot="events"]')).not.toBeNull();
});

test('a change announced for this project reads it again; one for another project does not', async () => {
  await renderPage();
  const before = reads('/projects/p_1');
  emit('project:p_2');
  await act(async () => {});
  expect(reads('/projects/p_1')).toBe(before);
  project = detail({ title: '别处改的标题' });
  emit('project:p_1');
  expect(await screen.findByRole('button', { name: '别处改的标题' })).toBeTruthy();
  expect(reads('/projects/p_1')).toBe(before + 1);
});

test('questions and the project list are read again on their own topics', async () => {
  await renderPage();
  const q = reads('/questions?status=pending&project_id=p_1');
  const p = reads('/projects');
  pending = [question({ prompt: '新问题' })];
  emit('questions');
  expect(await screen.findByText('新问题')).toBeTruthy();
  expect(reads('/questions?status=pending&project_id=p_1')).toBe(q + 1);
  emit('projects');
  await waitFor(() => expect(reads('/projects')).toBe(p + 1));
});

test('opening another project starts from scratch', async () => {
  const view = await renderPage();
  expect(screen.getByRole('button', { name: 'dLLM 评测框架' })).toBeTruthy();
  fetchMock.mockImplementation(async (input) => {
    const path = String(input);
    if (path === '/projects/p_7') return json(detail({ id: 'p_7', title: '另一个项目' }));
    if (path === '/projects') return json([]);
    return json([]);
  });
  view.rerender(
    <StreamContext.Provider value={stream}>
      <ToastProvider>
        <ProjectPage id="p_7" />
      </ToastProvider>
    </StreamContext.Provider>,
  );
  expect(await screen.findByRole('button', { name: '另一个项目' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'dLLM 评测框架' })).toBeNull();
});
