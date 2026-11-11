// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { ProjectCard } from '../../src/domain/read.ts';
import { ProjectCardView } from '../../web/src/components/project-card.tsx';
import { blocker, card, question, tag, todo } from './fixtures.ts';

const NO_TITLES = new Map<string, string>();

function renderCard(over: Partial<ProjectCard> = {}, titles: Map<string, string> = NO_TITLES) {
  return render(<ProjectCardView card={card(over)} projectTitles={titles} />);
}

const root = (view: { container: HTMLElement }) => view.container.firstElementChild as HTMLElement;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('the first line is priority, linked title and stage; the title links to the project page', () => {
  renderCard({ id: 'p_1', title: 'dLLM 评测框架', stage: 'build', priority: 'P0' });
  const link = screen.getByRole('link', { name: 'dLLM 评测框架' });
  expect(link.getAttribute('href')).toBe('#/p/p_1');
  const priority = screen.getByText('P0');
  expect(priority.classList.contains('p0')).toBe(true);
  expect(screen.getByText('构建')).toBeTruthy();
});

test('each priority has its class, and an unset one reads 未定', () => {
  for (const p of ['P0', 'P1', 'P2', 'P3'] as const) {
    const view = renderCard({ priority: p });
    expect(screen.getByText(p).classList.contains(p.toLowerCase())).toBe(true);
    view.unmount();
  }
  renderCard({ priority: null });
  expect(screen.getByText('未定').classList.contains('tag')).toBe(true);
});

test('a title is plain text, never markup', () => {
  renderCard({ title: '<img src=x onerror=alert(1)> **粗体**' });
  expect(screen.getByRole('link').textContent).toBe('<img src=x onerror=alert(1)> **粗体**');
  expect(document.querySelector('img')).toBeNull();
});

test('milestone counts show only when there are milestones, as done/total', () => {
  const view = renderCard({ milestones_progress: { done: 3, doing: 1, todo: 1 } });
  expect(screen.getByText('里程碑 3/5')).toBeTruthy();
  view.unmount();
  renderCard({ milestones_progress: { done: 0, doing: 0, todo: 0 } });
  expect(screen.queryByText(/里程碑/)).toBeNull();
});

test('the progress bar has one cell per milestone: done, then doing, then todo', () => {
  const view = renderCard({ milestones_progress: { done: 2, doing: 1, todo: 2 } });
  const cells = [...view.container.querySelectorAll('.ms > span')];
  expect(cells.map((c) => c.className)).toEqual(['d', 'd', 'n', '', '']);
  view.unmount();
  const empty = renderCard({ milestones_progress: { done: 0, doing: 0, todo: 0 } });
  expect(empty.container.querySelector('.ms')).toBeNull();
});

test('the summary is one line with its full text as the title', () => {
  const view = renderCard({ summary: '给 Diffusion LLM 做统一评测和负载分析' });
  const summary = view.container.querySelector('.summary');
  expect(summary?.textContent).toBe('给 Diffusion LLM 做统一评测和负载分析');
  expect(summary?.getAttribute('title')).toBe('给 Diffusion LLM 做统一评测和负载分析');
  view.unmount();
  const none = renderCard({ summary: null });
  expect(none.container.querySelector('.summary')).toBeNull();
});

test('the current milestone is followed by the tags of the sessions working on it', () => {
  const here = tag({ key: 'claude:1', short_id: 'aaaa1111', milestone_id: 'm_2' });
  const view = renderCard({
    current_milestone: { id: 'm_2', title: '接入 cannbench 负载数据', status: 'doing' },
    active_sessions: [here],
  });
  const line = screen.getByText('当前里程碑：').closest('div') as HTMLElement;
  expect(line.textContent).toContain('接入 cannbench 负载数据');
  expect(within(line).getByRole('button', { name: /aaaa1111/ })).toBeTruthy();
  expect(screen.queryByText('▸ 其他推进中的 session')).toBeNull();
  view.unmount();

  // No current milestone and no sessions: no such line at all.
  renderCard({ current_milestone: null, active_sessions: [] });
  expect(screen.queryByText('当前里程碑：')).toBeNull();
});

test('sessions that are not on the current milestone get their own line, even when no milestone is current', () => {
  const stray = tag({ key: 'claude:2', short_id: 'bbbb2222', milestone_id: 'm_deleted' });
  const here = tag({ key: 'claude:1', short_id: 'aaaa1111', milestone_id: 'm_2' });
  const view = renderCard({
    current_milestone: { id: 'm_2', title: '接入负载', status: 'doing' },
    active_sessions: [here, stray],
  });
  const other = screen.getByText('其他推进中的 session').closest('div') as HTMLElement;
  expect(within(other).getByRole('button', { name: /bbbb2222/ })).toBeTruthy();
  expect(within(other).queryByRole('button', { name: /aaaa1111/ })).toBeNull();
  view.unmount();

  renderCard({ current_milestone: null, active_sessions: [stray] });
  const alone = screen.getByText('其他推进中的 session').closest('div') as HTMLElement;
  expect(within(alone).getByRole('button', { name: /bbbb2222/ })).toBeTruthy();
});

test('a blocked session puts a red dot beside the title; other statuses do not', () => {
  const blocked = renderCard({ active_sessions: [tag({ effective_status: 'working' }), tag({ key: 'claude:2', effective_status: 'blocked' })] });
  const dot = screen.getByTitle('有 agent 在等你操作');
  expect(dot.classList.contains('alert-dot')).toBe(true);
  blocked.unmount();

  renderCard({ active_sessions: [tag({ effective_status: 'working' }), tag({ key: 'claude:2', effective_status: 'idle' })] });
  expect(screen.queryByTitle('有 agent 在等你操作')).toBeNull();
});

test('every open blocker is a red line starting with the blocked icon', () => {
  renderCard({ open_blockers: [blocker({ id: 'b_1', text: '显存不够跑对照组' }), blocker({ id: 'b_2', text: '等数据授权' })] });
  const first = screen.getByText('显存不够跑对照组');
  expect(first.classList.contains('blk')).toBe(true);
  expect(first.querySelector('svg.icon')).not.toBeNull();
  expect(screen.getByText('等数据授权')).toBeTruthy();
});

test('at most three todos: the first is 下一步, the rest are counted', () => {
  renderCard({
    open_todos: ['A', 'B', 'C', 'D'].map((title, i) => todo({ id: `t_${i}`, title })),
  });
  expect(screen.getByText('下一步：A')).toBeTruthy();
  expect(screen.getByText('B')).toBeTruthy();
  expect(screen.getByText('C')).toBeTruthy();
  expect(screen.queryByText('D')).toBeNull();
  expect(screen.getByText('还有 1 条')).toBeTruthy();
});

test('three todos are all shown without a count; none shows nothing', () => {
  const view = renderCard({ open_todos: ['A', 'B', 'C'].map((title, i) => todo({ id: `t_${i}`, title })) });
  expect(screen.getByText('C')).toBeTruthy();
  expect(screen.queryByText(/还有/)).toBeNull();
  view.unmount();
  renderCard({ open_todos: [] });
  expect(screen.queryByText(/下一步/)).toBeNull();
});

test('a dormant project says how long and is dimmed; a closed one with the same data is not', () => {
  const dormant = renderCard({ dormant_days: 9, stage: 'idea', priority: 'P2' });
  expect(screen.getByText('休眠 9 天')).toBeTruthy();
  expect(screen.getByText('无活跃 session')).toBeTruthy();
  expect(root(dormant).classList.contains('dormant')).toBe(true);
  dormant.unmount();

  const closed = renderCard({ dormant_days: 9, stage: 'done', closed: true });
  expect(screen.queryByText(/休眠/)).toBeNull();
  expect(screen.queryByText(/无活跃/)).toBeNull();
  expect(closed.container.querySelector('.dormant')).toBeNull();
});

test('each pending question is a card that can be answered right there', () => {
  renderCard({
    pending_questions: [question({ id: 'q_1', prompt: '评测集用哪个？' }), question({ id: 'q_2', prompt: '要不要合并？' })],
  });
  expect(screen.getByText('评测集用哪个？')).toBeTruthy();
  expect(screen.getByText('要不要合并？')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '公开 v2' })).toHaveLength(2);
});

test('a question about another project names it; one about this project does not repeat the title', () => {
  const titles = new Map([
    ['p_1', 'dLLM 评测框架'],
    ['p_2', 'loopwm'],
  ]);
  renderCard(
    { id: 'p_1', pending_questions: [question({ id: 'q_1', project_id: 'p_1' }), question({ id: 'q_2', project_id: 'p_2', prompt: '合并吗？' })] },
    titles,
  );
  const mine = document.querySelector('[data-question-id="q_1"]') as HTMLElement;
  const other = document.querySelector('[data-question-id="q_2"]') as HTMLElement;
  expect(within(mine).queryByText('dLLM 评测框架')).toBeNull();
  expect(within(other).getByText('loopwm')).toBeTruthy();
});
