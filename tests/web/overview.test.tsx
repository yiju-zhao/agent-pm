// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectCard, QuestionView } from '../../src/domain/read.ts';
import type { SessionListItem } from '../../src/server/http.ts';
import type { SourceCoverage } from '../../src/server/coverage.ts';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { InboxProvider } from '../../web/src/inbox.tsx';
import { OverviewPage } from '../../web/src/pages/overview.tsx';
import type { Reminder } from '../../src/domain/reminders.ts';
import { activity, item, projectActivity, source } from './console-fixtures.ts';
import { blocker, card, question, sessionItem } from './fixtures.ts';

// The command center as the user meets it: it reads the board, the sessions, the period and the sources, and only points.

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let data: { projects: ProjectCard[]; sessions: SessionListItem[]; questions: QuestionView[]; coverage: SourceCoverage[] | null; activity: ReturnType<typeof activity>; reminders: Reminder[] };

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-15T09:00:00.000Z') });
  data = { projects: [], sessions: [], questions: [], coverage: [], activity: activity(), reminders: [] };
  fetchMock.mockReset().mockImplementation(async (input) => {
    const path = String(input);
    if (path === '/projects') return json(data.projects);
    if (path === '/sessions') return json(data.sessions);
    if (path === '/questions?status=pending') return json(data.questions);
    if (path === '/reminders') return json(data.reminders);
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
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6));
  await screen.findByRole('region', { name: '项目组合' });
}
const panel = (name: string) => screen.getByRole('region', { name });
const metric = (label: string) => within(screen.getByRole('group', { name: '关键指标' })).getByText(label).parentElement!;

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


const reminder = (over: Partial<Reminder>): Reminder => ({ key: 'blocker:b_1', category: 'waiting_you', text: '等你试听成片', detail: 'd', project_id: 'p_1', project_title: 'openlingo', session_key: null, short_id: null, since: null, fingerprint: 'f', ...over });

test('the key numbers count decisions for the user, reminders, what runs and what is wrong', async () => {
  data.questions = [question({ id: 'q_1', session_key: null }), question({ id: 'q_2', project_id: null, session_key: 'claude:x' })];
  data.sessions = [
    sessionItem({ key: 'a', effective_status: 'working', linked_projects: [{ id: 'p_1', title: 'dLLM 评测框架' }] }),
    sessionItem({ key: 'b', effective_status: 'blocked', linked_projects: [] }),
    sessionItem({ key: 'c', effective_status: 'ended', linked_projects: [] }),
  ];
  data.reminders = [reminder({}), reminder({ key: 'repo:/w', category: 'unpushed', text: '有 5 个提交没有推送' })];
  data.coverage = [source(), source({ source_id: 'herdr:gx10', state: 'offline' })];
  await renderPage();
  await waitFor(() => expect(metric('需要你决策').textContent).toContain('2'));
  expect(metric('等你操作').textContent).toContain('1');
  expect(metric('运行中').textContent).toBe('运行中1共 2 个在线');
  expect(metric('未归属 session').textContent).toContain('1');
  await waitFor(() => expect(metric('提醒').textContent).toBe('提醒2随进展自动更新'));
  await waitFor(() => expect(metric('采集异常').textContent).toContain('1'));
});

test('the queue separates decisions about the board from reminders, which carry no options to answer', async () => {
  data.questions = [1, 2, 3, 4].map((n) => question({ id: `q_${n}`, prompt: `问题 ${n}`, session_key: null }));
  data.reminders = [
    reminder({ key: 'session:s', category: 'agent_waiting', text: '「打磨采集」在等你操作', project_id: null, project_title: null }),
    reminder({}),
    reminder({ key: 'stalled:p_2', category: 'stalled', text: 'P1 项目「CBRS」已经 12 天没有进展', project_id: 'p_2', project_title: 'CBRS' }),
  ];
  data.coverage = [source({ source_id: 'herdr:never', state: 'never_reported', collector_heartbeat: null })];
  await renderPage();
  const queue = panel('行动队列');
  await waitFor(() => expect(within(queue).getByText('问题 1')).toBeTruthy());
  expect(within(queue).queryByText('问题 4')).toBeNull();
  expect(within(queue).getByRole('link', { name: '另有 1 个待决定 → Inbox' }).getAttribute('href')).toBe('#/inbox');
  const waiting = await within(queue).findByRole('region', { name: 'agent 在等你' });
  expect(within(waiting).getByText('「打磨采集」在等你操作')).toBeTruthy();
  const you = within(queue).getByRole('region', { name: '等你回复或动手' });
  expect(within(you).getByRole('link', { name: 'openlingo' }).getAttribute('href')).toBe('#/p/p_1');
  // A reminder is not a question: no answer buttons, no put-off buttons in the compact view.
  expect(within(you).queryByRole('button')).toBeNull();
  expect(within(queue).getByRole('region', { name: '需要继续推进' })).toBeTruthy();
  await waitFor(() => expect(within(queue).getByText('herdr:never')).toBeTruthy());
});

test('with nothing to decide or remind, the queue says so', async () => {
  await renderPage();
  const queue = panel('行动队列');
  await waitFor(() => expect(within(queue).getByText('没有需要你在 agent-pm 里决定的事。')).toBeTruthy());
  await waitFor(() => expect(within(queue).getByText(/没有需要提醒的事/)).toBeTruthy());
});
