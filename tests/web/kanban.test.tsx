// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { Kanban } from '../../web/src/components/kanban.tsx';
import { card, question, tag } from './fixtures.ts';

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(cleanup);

test('seven columns with their Chinese names and counts, empty ones included, merged nowhere', () => {
  render(
    <Kanban
      cards={[
        card({ id: 'a', title: '构建中的', stage: 'build' }),
        card({ id: 'b', title: '已合并的', stage: 'merged', closed: true }),
        card({ id: 'c', title: '放弃的', stage: 'abandoned', closed: true }),
      ]}
    />,
  );
  const headings = screen.getAllByRole('heading').map((h) => h.textContent);
  expect(headings).toEqual(['idea · 0', '探索 · 0', '构建 · 1', '验证 · 0', '完成 · 0', '搁置 · 0', '放弃 · 1']);
  expect(screen.queryByText('已合并的')).toBeNull();
  const build = screen.getByRole('region', { name: '构建 · 1' });
  expect(within(build).getByRole('link', { name: '构建中的' }).getAttribute('href')).toBe('#/p/a');
});

test('a kanban card shows only priority, title and dormant days', () => {
  render(
    <Kanban
      cards={[
        card({
          id: 'a',
          title: '休眠的',
          stage: 'idea',
          priority: 'P2',
          summary: '不该出现的摘要',
          dormant_days: 9,
          milestones_progress: { done: 1, doing: 0, todo: 1 },
          active_sessions: [tag()],
          pending_questions: [question()],
        }),
        card({ id: 'b', title: '没定优先级', stage: 'idea', priority: null }),
      ]}
    />,
  );
  const idea = screen.getByRole('region', { name: 'idea · 2' });
  expect(within(idea).getByText('P2').classList.contains('p2')).toBe(true);
  expect(within(idea).getByText('未定')).toBeTruthy();
  expect(within(idea).getByText('休眠 9 天')).toBeTruthy();
  expect(screen.queryByText('不该出现的摘要')).toBeNull();
  expect(screen.queryByText(/里程碑/)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('a closed card does not read as dormant', () => {
  render(<Kanban cards={[card({ title: '做完了', stage: 'done', closed: true, dormant_days: 12 })]} />);
  expect(screen.queryByText(/休眠/)).toBeNull();
});
