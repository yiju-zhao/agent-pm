// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectDetail } from '../../src/domain/read.ts';
import { setToken } from '../../web/src/api.ts';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { BlockerList, DecisionList, MilestoneList, TodoList, groupTodos } from '../../web/src/components/items.tsx';
import { blocker, decision, detail, milestone, todo } from './fixtures.ts';

const fetchMock = vi.fn<typeof fetch>();
const reload = vi.fn();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const applied = () => json({ status: 'applied', event_id: 7, question_ids: [], warnings: [] });

function show(List: ComponentType<{ project: ProjectDetail; reload(): void }>, project: ProjectDetail) {
  return render(
    <ToastProvider>
      <List project={project} reload={reload} />
    </ToastProvider>,
  );
}

/** The write the page made last: method, URL, parsed body. */
function request() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => applied());
  reload.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  setToken('tok-1');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- groupTodos --------------------------------------------------------------------------------------------------

test('groupTodos: one group per milestone in milestone order, each with its todos', () => {
  const ms = [milestone({ id: 'm_b', position: 2 }), milestone({ id: 'm_a', position: 1 })];
  const todos = [todo({ id: 't_1', milestone_id: 'm_b' }), todo({ id: 't_2', milestone_id: 'm_a' }), todo({ id: 't_3', milestone_id: 'm_b' })];
  const groups = groupTodos(todos, ms);
  expect(groups.map((g) => [g.milestone?.id, g.todos.map((t) => t.id)])).toEqual([
    ['m_a', ['t_2']],
    ['m_b', ['t_1', 't_3']],
  ]);
});

test('groupTodos: a todo without a milestone, or with one that no longer exists, goes into the last group (milestone null)', () => {
  const ms = [milestone({ id: 'm_1', position: 0 })];
  const todos = [
    todo({ id: 't_free', milestone_id: null }),
    todo({ id: 't_gone', milestone_id: 'm_deleted' }),
    todo({ id: 't_1', milestone_id: 'm_1' }),
  ];
  const groups = groupTodos(todos, ms);
  expect(groups).toHaveLength(2);
  expect(groups[0].milestone?.id).toBe('m_1');
  expect(groups[1].milestone).toBeNull();
  expect(groups[1].todos.map((t) => t.id)).toEqual(['t_free', 't_gone']);
});

test('groupTodos: groups with no todos are not returned, and no todos at all is no groups', () => {
  const ms = [milestone({ id: 'm_1', position: 0 }), milestone({ id: 'm_2', position: 1 })];
  expect(groupTodos([todo({ milestone_id: 'm_2' })], ms).map((g) => g.milestone?.id)).toEqual(['m_2']);
  expect(groupTodos([], ms)).toEqual([]);
});

// ---- milestones --------------------------------------------------------------------------------------------------

const milestones = (project: ProjectDetail) => show(MilestoneList, project);

test('a milestone shows its state as ✓ ◐ ○', () => {
  milestones(
    detail({
      milestones: [
        milestone({ id: 'm_1', title: '已完成的', status: 'done', position: 0 }),
        milestone({ id: 'm_2', title: '进行中的', status: 'doing', position: 1 }),
        milestone({ id: 'm_3', title: '没开始的', status: 'todo', position: 2 }),
      ],
    }),
  );
  expect(screen.getByRole('button', { name: '✓' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '◐' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '○' })).toBeTruthy();
});

test('clicking the milestone icon cycles todo → doing → done → todo', async () => {
  for (const [icon, status, next] of [
    ['○', 'todo', 'doing'],
    ['◐', 'doing', 'done'],
    ['✓', 'done', 'todo'],
  ] as const) {
    fetchMock.mockClear();
    reload.mockClear();
    const view = milestones(detail({ milestones: [milestone({ id: 'm_1', status })] }));
    fireEvent.click(screen.getByRole('button', { name: icon }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(request()).toEqual({ url: '/projects/p_1/milestones/m_1', method: 'PATCH', body: { status: next } });
    view.unmount();
  }
});

test('the milestone title is edited in place', async () => {
  milestones(detail({ milestones: [milestone({ id: 'm_1', title: '旧名字' })] }));
  const row = screen.getByRole('button', { name: '旧名字' }).closest('li') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: '旧名字' }));
  fireEvent.change(within(row).getByRole('textbox'), { target: { value: '新名字' } });
  fireEvent.keyDown(within(row).getByRole('textbox'), { key: 'Enter' });
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/milestones/m_1', method: 'PATCH', body: { title: '新名字' } });
});

test('a locked milestone field shows 🔒 and 解锁, and unlocking calls the lock route of that field', async () => {
  milestones(detail({ milestones: [milestone({ id: 'm_1', title: '锁了的', locks: ['title', 'status'] })] }));
  expect(screen.getAllByText('🔒')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '解锁状态' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/milestones/m_1/locks/status', method: 'DELETE', body: undefined });

  fetchMock.mockClear();
  fireEvent.click(screen.getByRole('button', { name: '解锁' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  expect(request().url).toBe('/projects/p_1/milestones/m_1/locks/title');
});

test('deleting a milestone needs a second click and then calls DELETE', async () => {
  milestones(detail({ milestones: [milestone({ id: 'm_1' })] }));
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/milestones/m_1', method: 'DELETE', body: undefined });
});

test('a milestone is added from the box at the bottom, which is then emptied', async () => {
  milestones(detail());
  expect(screen.getByText('还没有里程碑')).toBeTruthy();
  const add = screen.getByRole('button', { name: '添加里程碑' }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: '新里程碑' }), { target: { value: '  做完评测  ' } });
  fireEvent.click(add);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/milestones', method: 'POST', body: { title: '做完评测' } });
  expect((screen.getByRole('textbox', { name: '新里程碑' }) as HTMLInputElement).value).toBe('');
});

test('a refused write is explained in a toast, nothing is reloaded, and the typed text is kept', async () => {
  fetchMock.mockImplementation(async () => json({ error: 'merged', message: 'merged into p_2' }, 409));
  milestones(detail());
  fireEvent.change(screen.getByRole('textbox', { name: '新里程碑' }), { target: { value: '做完评测' } });
  fireEvent.click(screen.getByRole('button', { name: '添加里程碑' }));
  expect(await screen.findByText('项目已合并到别的项目')).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox', { name: '新里程碑' }) as HTMLInputElement).value).toBe('做完评测');
});

// ---- todos -------------------------------------------------------------------------------------------------------

const todos = (project: ProjectDetail) => show(TodoList, project);

test('todos are listed under their milestone; one whose milestone is gone shows under 未分组', () => {
  todos(
    detail({
      milestones: [milestone({ id: 'm_1', title: '接入数据' })],
      todos: [
        todo({ id: 't_1', title: '写加载器', milestone_id: 'm_1' }),
        todo({ id: 't_2', title: '孤儿 todo', milestone_id: 'm_deleted' }),
        todo({ id: 't_3', title: '没分组的', milestone_id: null }),
      ],
    }),
  );
  const mine = screen.getByRole('group', { name: '接入数据' });
  expect(within(mine).getByText('写加载器')).toBeTruthy();
  const loose = screen.getByRole('group', { name: '未分组' });
  expect(within(loose).getByText('孤儿 todo')).toBeTruthy();
  expect(within(loose).getByText('没分组的')).toBeTruthy();
});

test('only unplaced todos: just the one group, 未分组', () => {
  todos(detail({ todos: [todo({ title: '单独一条' })] }));
  expect(screen.getAllByRole('group')).toHaveLength(1);
  expect(within(screen.getByRole('group', { name: '未分组' })).getByText('单独一条')).toBeTruthy();
});

test('the checkbox cycles the status like the milestone icon: unchecked, half, checked', async () => {
  const view = todos(detail({ todos: [todo({ id: 't_1', title: '写加载器', status: 'doing' })] }));
  const box = screen.getByRole('checkbox', { name: '写加载器' }) as HTMLInputElement;
  expect(box.indeterminate).toBe(true);
  fireEvent.click(box);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/todos/t_1', method: 'PATCH', body: { status: 'done' } });
  view.unmount();

  fetchMock.mockClear();
  todos(detail({ todos: [todo({ id: 't_1', title: '写加载器', status: 'todo' })] }));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  expect(request().body).toEqual({ status: 'doing' });
});

test('a done todo is checked, and checking it again sends it back to todo', async () => {
  todos(detail({ todos: [todo({ id: 't_1', status: 'done' })] }));
  const box = screen.getByRole('checkbox') as HTMLInputElement;
  expect(box.checked).toBe(true);
  fireEvent.click(box);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request().body).toEqual({ status: 'todo' });
});

test('deleting a todo: the first click only asks, the second one sends DELETE /projects/p_1/todos/t_1', async () => {
  todos(detail({ todos: [todo({ id: 't_1' })] }));
  const del = screen.getByRole('button', { name: '删除' });
  fireEvent.click(del);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '确认删除' })).toBe(del);
  fireEvent.click(del);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/todos/t_1', method: 'DELETE', body: undefined });
});

test('a todo is added under 未分组 by default, or under the milestone picked in the menu', async () => {
  todos(detail({ milestones: [milestone({ id: 'm_1', title: '接入数据' })] }));
  const menu = screen.getByRole('combobox', { name: '所属里程碑' }) as HTMLSelectElement;
  expect(within(menu).getAllByRole('option').map((o) => o.textContent)).toEqual(['未分组', '接入数据']);
  expect(menu.value).toBe('');

  fireEvent.change(screen.getByRole('textbox', { name: '新 todo' }), { target: { value: '先做 A' } });
  fireEvent.click(screen.getByRole('button', { name: '添加 todo' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/todos', method: 'POST', body: { title: '先做 A' } });

  fireEvent.change(menu, { target: { value: 'm_1' } });
  fireEvent.change(screen.getByRole('textbox', { name: '新 todo' }), { target: { value: '再做 B' } });
  fireEvent.click(screen.getByRole('button', { name: '添加 todo' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  expect(request().body).toEqual({ title: '再做 B', milestone_id: 'm_1' });
});

test('a todo title and its locks work like the milestone ones', async () => {
  todos(detail({ todos: [todo({ id: 't_1', title: '旧', locks: ['status'] })] }));
  fireEvent.click(screen.getByRole('button', { name: '解锁状态' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/todos/t_1/locks/status', method: 'DELETE', body: undefined });

  const row = screen.getByRole('button', { name: '旧' }).closest('li') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: '旧' }));
  fireEvent.change(within(row).getByRole('textbox'), { target: { value: '新' } });
  fireEvent.keyDown(within(row).getByRole('textbox'), { key: 'Enter' });
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  expect(request()).toEqual({ url: '/projects/p_1/todos/t_1', method: 'PATCH', body: { title: '新' } });
});

// ---- blockers ----------------------------------------------------------------------------------------------------

const blockers = (project: ProjectDetail) => show(BlockerList, project);

test('an open blocker is a red line with its kind in Chinese', () => {
  blockers(
    detail({
      blockers: [
        blocker({ id: 'b_1', text: '显存不够', kind: 'technical' }),
        blocker({ id: 'b_2', text: '等数据授权', kind: 'external' }),
        blocker({ id: 'b_3', text: '要你拍板', kind: 'user' }),
      ],
    }),
  );
  const line = screen.getByText('显存不够').closest('li') as HTMLElement;
  expect(line.classList.contains('blk')).toBe(true);
  expect(within(line).getByText('技术')).toBeTruthy();
  expect(within(screen.getByText('等数据授权').closest('li') as HTMLElement).getByText('外部')).toBeTruthy();
  expect(within(screen.getByText('要你拍板').closest('li') as HTMLElement).getByText('等你')).toBeTruthy();
});

test('解除 clears a blocker with PATCH {status: cleared}', async () => {
  blockers(detail({ blockers: [blocker({ id: 'b_1' })] }));
  fireEvent.click(screen.getByRole('button', { name: '解除' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/blockers/b_1', method: 'PATCH', body: { status: 'cleared' } });
});

test('cleared blockers are folded under 已解除（n）, have no 解除 button, and can be deleted', async () => {
  blockers(
    detail({
      blockers: [
        blocker({ id: 'b_1', text: '还开着' }),
        blocker({ id: 'b_2', text: '早解决了', status: 'cleared', cleared_at: '2026-10-25T08:00:00.000Z' }),
      ],
    }),
  );
  expect(screen.queryByText('早解决了')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /已解除（1）/ }));
  const line = screen.getByText('早解决了').closest('li') as HTMLElement;
  expect(line.classList.contains('blk')).toBe(false);
  expect(within(line).queryByRole('button', { name: '解除' })).toBeNull();

  fireEvent.click(within(line).getByRole('button', { name: '删除' }));
  fireEvent.click(within(line).getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/blockers/b_2', method: 'DELETE', body: undefined });
});

test('with no cleared blocker there is no fold', () => {
  blockers(detail({ blockers: [blocker()] }));
  expect(screen.queryByRole('button', { name: /已解除/ })).toBeNull();
});

test('a blocker is added with its kind', async () => {
  blockers(detail());
  const kind = screen.getByRole('combobox', { name: '阻塞种类' }) as HTMLSelectElement;
  expect(within(kind).getAllByRole('option').map((o) => o.textContent)).toEqual(['等你', '外部', '技术']);
  fireEvent.change(kind, { target: { value: 'external' } });
  fireEvent.change(screen.getByRole('textbox', { name: '新阻塞' }), { target: { value: '等审批' } });
  fireEvent.click(screen.getByRole('button', { name: '添加阻塞' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/blockers', method: 'POST', body: { text: '等审批', kind: 'external' } });
});

// ---- decisions ---------------------------------------------------------------------------------------------------

const decisions = (project: ProjectDetail) => show(DecisionList, project);

test('a decision is MM/DD and its text, followed by tags for its evidence', () => {
  decisions(
    detail({
      decisions: [
        decision({ id: 'd_1', text: '评测集先用公开 v2', decided_at: '2026-10-21T12:00:00.000Z', evidence: ['digest:3', 'event:12'] }),
        decision({ id: 'd_2', text: '用户自己记的', decided_at: '2026-10-22T12:00:00.000Z', evidence: [] }),
      ],
    }),
  );
  const line = screen.getByText(/评测集先用公开 v2/).closest('li') as HTMLElement;
  expect(line.textContent).toContain('10/21 评测集先用公开 v2');
  expect(within(line).getByRole('button', { name: '摘要 #3' })).toBeTruthy();
  expect(within(line).getByText('事件 #12')).toBeTruthy();
  expect(within(screen.getByText(/用户自己记的/).closest('li') as HTMLElement).queryByRole('button', { name: /#/ })).toBeNull();
});

test('a decision can be deleted after a second click', async () => {
  decisions(detail({ decisions: [decision({ id: 'd_1' })] }));
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/decisions/d_1', method: 'DELETE', body: undefined });
});

test('a decision is recorded from the box under the list', async () => {
  decisions(detail());
  expect(screen.getByText('还没有记录决策')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: '新决策' }), { target: { value: '先不做缓存' } });
  fireEvent.click(screen.getByRole('button', { name: '记录决策' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toEqual({ url: '/projects/p_1/decisions', method: 'POST', body: { text: '先不做缓存' } });
});

test('text from the AI in titles and decisions is plain text', () => {
  decisions(detail({ decisions: [decision({ text: '<b>粗</b> <script>x()</script>' })] }));
  expect(document.querySelector('b, script')).toBeNull();
  expect(screen.getByText(/<b>粗<\/b>/)).toBeTruthy();
});
