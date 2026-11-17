// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { Reminder } from '../../src/domain/reminders.ts';
import { Reminders } from '../../web/src/components/reminders.tsx';
import { ToastProvider } from '../../web/src/components/toast.tsx';

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let reminders: Reminder[];
const reminder = (over: Partial<Reminder>): Reminder => ({ key: 'blocker:b_1', category: 'waiting_you', text: '等你试听成片', detail: '在对应的 session 里回复或处理后，会随新进展自动消失', project_id: 'p_1', project_title: 'openlingo', session_key: null, short_id: null, since: null, fingerprint: 'f', ...over });

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  reminders = [reminder({}), reminder({ key: 'repo:/w/agent-pm', category: 'unpushed', text: 'agent-pm 的 master 有 5 个提交没有推送', detail: '最新：abc feat' })];
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      reminders = reminders.slice(1);
      return json({ ok: true });
    }
    return json(reminders);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('reminders are grouped by kind with what to do, and can be put off or marked handled, never answered', async () => {
  render(<ToastProvider><Reminders /></ToastProvider>);
  const you = await screen.findByRole('region', { name: '等你回复或动手' });
  expect(within(you).getByText(/去那个 session 处理/)).toBeTruthy();
  expect(within(screen.getByRole('region', { name: '还没推送' })).getByText('agent-pm 的 master 有 5 个提交没有推送')).toBeTruthy();
  const row = within(you).getByRole('listitem', { name: '等你试听成片' });
  expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['已处理', '明天再提醒', '不再提醒']);
  fireEvent.click(within(row).getByRole('button', { name: '不再提醒' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '等你回复或动手' })).toBeNull());
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/reminders/snooze');
  expect(JSON.parse(String(post[1]!.body))).toEqual({ key: 'blocker:b_1', hours: null });
  // A repository reminder has no "handled": it goes away when the commits are pushed.
  const repo = screen.getByRole('listitem', { name: 'agent-pm 的 master 有 5 个提交没有推送' });
  expect(within(repo).queryByRole('button', { name: '已处理' })).toBeNull();
});

test('marking a blocker reminder handled clears that blocker', async () => {
  render(<ToastProvider><Reminders /></ToastProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '已处理' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/projects/p_1/blockers/b_1' && init?.method === 'PATCH' && JSON.parse(String(init.body)).status === 'cleared')).toBe(true));
});

test('in the Inbox, reminders are grouped by project, the projects waiting on the user first, each line saying its kind', async () => {
  reminders = [
    reminder({ key: 'blocker:e', category: 'waiting_external', text: '等华硕售后', project_id: 'p_2', project_title: 'DGX Spark' }),
    reminder({ key: 'blocker:y', text: '等你试听成片' }),
    reminder({ key: 'repo:/w', category: 'unpushed', text: '有 5 个提交没有推送', project_id: 'p_1', project_title: 'openlingo' }),
    reminder({ key: 'session:s', category: 'agent_waiting', text: '「某 session」在等你操作', project_id: null, project_title: null }),
  ];
  render(<ToastProvider><Reminders groupBy="project" /></ToastProvider>);
  await screen.findByRole('region', { name: 'openlingo' });
  const groups = [...document.querySelectorAll('section.reminder-project')].map((g) => g.getAttribute('aria-label'));
  expect(groups).toEqual(['openlingo', 'DGX Spark', '未归属项目']);
  const openlingo = screen.getByRole('region', { name: 'openlingo' });
  expect(within(openlingo).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['等你试听成片', '有 5 个提交没有推送']);
  expect(openlingo.querySelector('.reminder-project-head')!.textContent).toBe('openlingo等你回复或动手 1还没推送 1');
  expect(within(openlingo).getByRole('listitem', { name: '等你试听成片' }).textContent).toContain('等你回复或动手');
});
