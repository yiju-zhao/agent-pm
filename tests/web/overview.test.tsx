// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectCard, QuestionView } from '../../src/domain/read.ts';
import type { SessionListItem } from '../../src/server/http.ts';
import type { SourceCoverage } from '../../src/server/coverage.ts';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { InboxProvider } from '../../web/src/inbox.tsx';
import { OverviewPage } from '../../web/src/pages/overview.tsx';
import { activity, item, projectActivity, source } from './console-fixtures.ts';
import { blocker, card, question, sessionItem } from './fixtures.ts';

// The command center as the user meets it: it reads the board, the sessions, the period and the sources, and only points.

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let data: { projects: ProjectCard[]; sessions: SessionListItem[]; questions: QuestionView[]; coverage: SourceCoverage[] | null; activity: ReturnType<typeof activity> };

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-15T09:00:00.000Z') });
  data = { projects: [], sessions: [], questions: [], coverage: [], activity: activity() };
  fetchMock.mockReset().mockImplementation(async (input) => {
    const path = String(input);
    if (path === '/projects') return json(data.projects);
    if (path === '/sessions') return json(data.sessions);
    if (path === '/questions?status=pending') return json(data.questions);
    if (path === '/coverage') return data.coverage === null ? json({ error: 'unauthorized' }, 401) : json(data.coverage);
    if (path.startsWith('/activity?days=14&tz=')) return json(data.activity);
    return json({ error: 'not_found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderPage() {
  render(<ToastProvider><InboxProvider><OverviewPage /></InboxProvider></ToastProvider>);
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5));
  await screen.findByRole('region', { name: '项目组合' });
}
const panel = (name: string) => screen.getByRole('region', { name });
const metric = (label: string) => within(screen.getByRole('group', { name: '关键指标' })).getByText(label).parentElement!;

test('the key numbers count what needs the user, what runs and what is wrong', async () => {
  data.questions = [question({ id: 'q_1', session_key: null }), question({ id: 'q_2', project_id: null, session_key: 'claude:x' })];
  data.sessions = [
    sessionItem({ key: 'a', effective_status: 'working', linked_projects: [{ id: 'p_1', title: 'dLLM 评测框架' }] }),
    sessionItem({ key: 'b', effective_status: 'blocked', linked_projects: [] }),
    sessionItem({ key: 'c', effective_status: 'ended', linked_projects: [] }),
  ];
  data.projects = [card({ open_blockers: [blocker({ id: 'b_1' }), blocker({ id: 'b_2' })] }), card({ id: 'p_2', closed: true, stage: 'done', open_blockers: [blocker({ id: 'b_3' })] })];
  data.coverage = [source(), source({ source_id: 'herdr:gx10', state: 'offline' })];
  await renderPage();
  await waitFor(() => expect(metric('待你决定').textContent).toContain('1'));
  expect(metric('等你操作').textContent).toContain('1');
  expect(metric('运行中').textContent).toBe('运行中1共 2 个在线');
  expect(metric('未归属 session').textContent).toContain('1');
  expect(metric('开放阻塞').textContent).toContain('2');
  await waitFor(() => expect(metric('采集异常').textContent).toContain('1'));
});

test('the action queue lists decisions, waiting agents, blockers, collection faults and stalled priorities, each with a way in', async () => {
  data.questions = [1, 2, 3, 4].map((n) => question({ id: `q_${n}`, prompt: `问题 ${n}`, session_key: null }));
  data.sessions = [sessionItem({ key: 'w', title: '等我确认的 agent', short_id: 'deadbeef', effective_status: 'blocked', linked_projects: [{ id: 'p_1', title: 'dLLM 评测框架' }] })];
  data.projects = [card({ open_blockers: Array.from({ length: 8 }, (_, i) => blocker({ id: `b_${i}`, text: `阻塞 ${i}` })) }), card({ id: 'p_2', title: '停了的 P1', priority: 'P1', dormant_days: 9 })];
  data.coverage = [source({ source_id: 'herdr:never', state: 'never_reported', collector_heartbeat: null })];
  await renderPage();
  const queue = panel('行动队列');
  await waitFor(() => expect(within(queue).getByText('问题 1')).toBeTruthy());
  expect(within(queue).queryByText('问题 4')).toBeNull();
  expect(within(queue).getByRole('link', { name: '另有 1 个待决定 → Inbox' }).getAttribute('href')).toBe('#/inbox');
  expect(within(queue).getByText('等我确认的 agent').closest('a')!.getAttribute('href')).toBe('#/p/p_1');
  // The newest blockers first, six of them, the rest counted.
  expect(within(queue).getByText('阻塞 7')).toBeTruthy();
  expect(within(queue).queryByText('阻塞 1')).toBeNull();
  expect(within(queue).getByText(/另有 2 个阻塞/)).toBeTruthy();
  await waitFor(() => expect(within(queue).getByText('herdr:never')).toBeTruthy());
  expect(within(queue).getByText(/已配置但从未上报/)).toBeTruthy();
  expect(within(queue).getByText('停了的 P1').closest('a')!.getAttribute('href')).toBe('#/p/p_2');
});

test('with nothing pending the queue says so', async () => {
  await renderPage();
  await waitFor(() => expect(within(panel('行动队列')).getByText(/一切正常/)).toBeTruthy());
});

test('the fleet shows each machine as a lane of its live sessions, the waiting ones first, unlinked ones marked', async () => {
  data.sessions = [
    sessionItem({ key: 'a', machine: 'mac-mini', title: '空闲的', effective_status: 'idle', linked_projects: [{ id: 'p_1', title: 'dLLM 评测框架' }] }),
    sessionItem({ key: 'b', machine: 'mac-mini', title: '等你的', effective_status: 'blocked', linked_projects: [] }),
    sessionItem({ key: 'c', machine: 'gx10', title: '跑着的', effective_status: 'working', linked_projects: [] }),
    sessionItem({ key: 'd', machine: 'gx10', title: '结束了的', effective_status: 'ended' }),
    sessionItem({ key: 'e', machine: 'gx10', title: '忽略了的', effective_status: 'working', ignored: 1 }),
  ];
  await renderPage();
  const fleet = panel('运行态势');
  await waitFor(() => expect(within(fleet).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['gx10', 'mac-mini']));
  const mini = within(fleet).getByRole('group', { name: 'mac-mini' });
  expect(within(mini).getAllByRole('link').map((a) => a.querySelector('.chip-title')!.textContent)).toEqual(['等你的', '空闲的']);
  expect(within(mini).getByText('未归属')).toBeTruthy();
  expect(within(fleet).queryByText('结束了的')).toBeNull();
  expect(within(fleet).queryByText('忽略了的')).toBeNull();
});

test('the portfolio is one row per open project with its stage, momentum, blockers and questions; closed ones on request', async () => {
  data.projects = [
    card({ id: 'p_1', title: '主线', open_blockers: [blocker()], pending_questions: [question()], active_sessions: [] }),
    card({ id: 'p_2', title: '已完成的', stage: 'done', closed: true }),
  ];
  data.activity = activity({ projects: [projectActivity({ id: 'p_1', daily: [1, 0, 4] })] });
  await renderPage();
  const table = within(panel('项目组合')).getByRole('table');
  await waitFor(() => expect(within(table).getByRole('img', { name: /主线 14 天投入：共 5，最近一天 4/ })).toBeTruthy());
  const row = within(table).getByRole('link', { name: '主线' }).closest('tr')!;
  expect(within(row).getByRole('img', { name: '阶段：构建' })).toBeTruthy();
  expect(row.textContent).toContain('P0');
  expect(within(table).queryByText('已完成的')).toBeNull();
  within(panel('项目组合')).getByRole('checkbox', { name: '显示已关闭' }).click();
  await waitFor(() => expect(within(table).getByText('已完成的')).toBeTruthy());
  // No project has milestones, so there is no empty milestone column.
  expect(within(table).queryByRole('columnheader', { name: '里程碑' })).toBeNull();
});

test('recent changes list the period’s milestones with their project, and the volume chart counts the unlinked part', async () => {
  data.projects = [card()];
  data.activity = activity({ total_daily: [2, 0, 5], unlinked_daily: [1, 0, 0], items: [item(), item({ event_id: 2, kind: 'todo_done', text: '跑通对照组' })] });
  await renderPage();
  const changes = panel('最近变化');
  await waitFor(() => expect(within(changes).getByText('评测集先用公开 v2')).toBeTruthy());
  expect(within(changes).getAllByRole('link', { name: 'dLLM 评测框架' })[0]!.getAttribute('href')).toBe('#/p/p_1');
  expect(within(changes).getByText('完成')).toBeTruthy();
  expect(within(panel('工作量')).getByText(/收到 7 段对话，其中未归属 1 段/)).toBeTruthy();
});
