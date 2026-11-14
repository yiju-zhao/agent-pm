// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { QuestionView } from '../../src/domain/read.ts';
import { InboxProvider } from '../../web/src/inbox.tsx';
import { InboxPage } from '../../web/src/pages/inbox.tsx';
import { StreamContext } from '../../web/src/use-api.ts';
import type { Topic } from '../../web/src/stream.ts';
import { card, question } from './fixtures.ts';

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let pending: QuestionView[];
let failQuestions: boolean;
let failSessions: boolean;
let listeners: Set<(topics: Topic[]) => void>;
function renderInbox() {
  return render(<StreamContext.Provider value={{ subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; } }}><InboxProvider><InboxPage /></InboxProvider></StreamContext.Provider>);
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  listeners = new Set(); pending = []; failQuestions = false; failSessions = false;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') { pending = []; return json({ status: 'applied', event_id: 1, question_ids: [], warnings: [] }); }
    if (url === '/questions?status=pending') return failQuestions ? json({ error: 'internal' }, 500) : json(pending);
    if (url === '/projects') return json([card({ title: '项目甲' })]);
    if (url === '/sessions') return failSessions ? json({ error: 'internal' }, 500) : json([{ key: 'claude:abc', short_id: 'abc', machine: 'laptop', agent_kind: 'claude', effective_status: 'idle', title: '调试会话' }]);
    return json({ error: 'not_found' }, 404);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('inbox groups pending decisions and session attribution with project and session context', async () => {
  pending = [question({ id: 'q_decision', prompt: '选择评测集', session_key: null }), question({ id: 'q_session', project_id: null, session_key: 'claude:abc', prompt: '分配到哪个项目' }), question({ id: 'answered', status: 'answered', prompt: '不显示' })];
  renderInbox();
  const decisions = await screen.findByRole('region', { name: '需要你 · 1' });
  expect(within(decisions).getByText('选择评测集')).toBeTruthy();
  expect(within(decisions).getByRole('link', { name: /项目甲/ }).getAttribute('href')).toBe('#/p/p_1');
  const sessions = screen.getByRole('region', { name: '待归属的 session · 1' });
  expect(await within(sessions).findByText('调试会话')).toBeTruthy();
  expect(within(sessions).getByText('分配到哪个项目')).toBeTruthy();
  expect(screen.queryByText('不显示')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /会话归属/ }));
  expect(screen.queryByRole('region', { name: '需要你 · 1' })).toBeNull();
  expect(screen.getByRole('region', { name: '待归属的 session · 1' })).toBeTruthy();
});

test('answering clears the pending queue without a stream event', async () => {
  pending = [question({ prompt: '等待选择', session_key: null })];
  renderInbox();
  fireEvent.click(await screen.findByRole('button', { name: '公开 v2' }));
  expect(await screen.findByText('暂时没有待处理事项')).toBeTruthy();
  expect(screen.queryByText('等待选择')).toBeNull();
  expect(fetchMock.mock.calls.filter(([url]) => url === '/questions?status=pending')).toHaveLength(2);
});

test('dismissing a session question clears it and its count', async () => {
  pending = [question({ project_id: null, session_key: 'claude:abc' })];
  renderInbox();
  fireEvent.click(await screen.findByRole('button', { name: '忽略' }));
  expect(await screen.findByText('暂时没有待处理事项')).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/dismiss'))).toBe(true);
});

test('missing session metadata keeps the session key and question actionable', async () => {
  failSessions = true;
  pending = [question({ project_id: null, session_key: 'claude:gone' })];
  renderInbox();
  expect(await screen.findByText('claude:gone')).toBeTruthy();
  expect(await screen.findByText(/会话信息暂时不可用/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '公开 v2' })).toBeTruthy();
});

test('question failures can be retried and are not presented as an empty inbox', async () => {
  failQuestions = true;
  renderInbox();
  const retry = await screen.findByRole('button', { name: '重新加载' });
  expect(screen.queryByText('暂时没有待处理事项')).toBeNull();
  failQuestions = false;
  fireEvent.click(retry);
  expect(await screen.findByText('暂时没有待处理事项')).toBeTruthy();
});

test('pending questions refresh on live events and reconnects', async () => {
  renderInbox();
  await screen.findByText('暂时没有待处理事项');
  pending = [question({ prompt: '新的决策', session_key: null })];
  act(() => { for (const listener of listeners) listener(['questions']); });
  expect(await screen.findByText('新的决策')).toBeTruthy();
  pending = [];
  act(() => { for (const listener of listeners) listener(['all']); });
  await waitFor(() => expect(screen.queryByText('新的决策')).toBeNull());
  expect(screen.getByText('暂时没有待处理事项')).toBeTruthy();
});
