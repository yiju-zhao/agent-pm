// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { ReviewPage, summaryMarkdown } from '../../web/src/pages/review.tsx';
import { activity, item, projectActivity } from './console-fixtures.ts';

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const A = projectActivity({ id: 'p_a', title: '采集可靠性', priority: 'P1', daily: [3, 0, 9], marks: [{}, {}, { decision: 1, todo_done: 2 }], totals: { chunks: 12, sessions: 2, decisions: 1, done: 2, stage_changes: 0, blockers_opened: 1, blockers_cleared: 0 } });
const B = projectActivity({ id: 'p_b', title: '合并预览', priority: 'P2', daily: [0, 2, 0], totals: { chunks: 2, sessions: 1, decisions: 0, done: 0, stage_changes: 1, blockers_opened: 0, blockers_cleared: 0 } });
const IDLE = projectActivity({ id: 'p_c', title: '停滞的主线', priority: 'P0' });
const ITEMS = [
  item({ event_id: 5, project_id: 'p_a', kind: 'decision', text: '只读对账' }),
  item({ event_id: 4, project_id: 'p_a', kind: 'todo_done', text: '补读尾部' }),
  item({ event_id: 3, project_id: 'p_a', kind: 'todo_done', text: '字节预算' }),
  item({ event_id: 2, project_id: 'p_a', kind: 'blocker_set', text: 'SSH 被拒' }),
  item({ event_id: 1, project_id: 'p_b', kind: 'stage', text: '探索 → 构建', day: 1, at: '2026-11-14T08:00:00.000Z' }),
];
const view = activity({ total_daily: [3, 2, 10], unlinked_daily: [0, 0, 1], projects: [B, IDLE, A], machines: [{ machine: 'mac-mini', daily: [3, 2, 10] }], items: ITEMS });

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => json(view));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  render(<ToastProvider><ReviewPage /></ToastProvider>);
  await screen.findByRole('table', { name: '项目 × 日期 投入' });
}

test('the heat map has one row per project that moved, most work first, and the unlinked work apart', async () => {
  await renderPage();
  const heat = screen.getByRole('table', { name: '项目 × 日期 投入' });
  const rows = within(heat).getAllByRole('rowheader').map((h) => h.querySelector('a')?.textContent ?? h.firstChild!.textContent);
  expect(rows).toEqual(['采集可靠性', '合并预览', '未归属项目']);
  const cells = within(within(heat).getAllByRole('row')[1]!).getAllByRole('cell');
  expect(cells[2]!.getAttribute('title')).toBe('9 段；决策 1，完成 2');
  expect(cells[2]!.textContent).toBe('◆✓');
  expect(cells[1]!.className).toContain('is-zero');
});

test('the range is asked of the server, and the period numbers add up the events', async () => {
  await renderPage();
  expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^\/activity\?days=14&tz=-?\d+$/);
  fireEvent.click(screen.getByRole('button', { name: '30 天' }));
  await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/^\/activity\?days=30&/));
  const metrics = screen.getByRole('group', { name: '期间指标' });
  expect(within(metrics).getByText('完成').parentElement!.textContent).toBe('完成2');
  expect(within(metrics).getByText('阻塞 新增/解除').parentElement!.textContent).toBe('阻塞 新增/解除1/0');
});

test('the timeline groups events by day and filters by kind', async () => {
  await renderPage();
  const events = screen.getByRole('region', { name: '关键事件' });
  expect(within(events).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['2026-11-15周日 · 4 条', '2026-11-14周六 · 1 条']);
  fireEvent.click(within(events).getByRole('button', { name: '完成 2' }));
  expect(within(events).queryByText('补读尾部')).toBeNull();
  expect(within(events).getByText('只读对账')).toBeTruthy();
});

test('summaries name what each project did, flag stalled high priorities, and copy out as Markdown', async () => {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await renderPage();
  const summaries = screen.getByRole('region', { name: '项目总结' });
  expect(within(summaries).getByText(/没有任何进展的高优先级项目/).textContent).toContain('停滞的主线（P0）');
  const a = within(summaries).getByRole('article', { name: '采集可靠性' });
  expect(within(a).getByText('补读尾部')).toBeTruthy();
  expect(within(a).getByText('SSH 被拒')).toBeTruthy();
  fireEvent.click(within(summaries).getByRole('button', { name: '复制为 Markdown' }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(await screen.findByText('已复制复盘总结（Markdown）')).toBeTruthy();
  expect(writeText.mock.calls[0]![0]).toBe(summaryMarkdown(view, 14));
});

test('the Markdown summary lists each project with its work, done items, decisions, stages and blockers', () => {
  const md = summaryMarkdown(view, 14);
  expect(md.split('\n').slice(0, 4)).toEqual(['# 工作复盘 · 2026-11-13 ~ 2026-11-15（14 天）', '', '- 收到对话 15 段，涉及 2 个项目；未归属项目 1 段', '- 决策 1 条，完成 2 项，阶段变化 1 次']);
  expect(md).toContain('## 采集可靠性（P1 · 构建）\n投入 12 段，2 个 session\n- 完成：');
  expect(md).toMatch(/- 完成：\n {2}- \S+ \S+ 字节预算\n {2}- \S+ \S+ 补读尾部/);
  expect(md).toContain('## 合并预览（P2 · 构建）');
  expect(md).not.toContain('停滞的主线');
});
