// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { EVENTS_IN_DETAIL } from '../../src/domain/read.ts';
import type { EventView } from '../../src/domain/read.ts';
import { setToken } from '../../web/src/api.ts';
import { EVENTS_SHOWN, EventLog } from '../../web/src/components/event-log.tsx';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { shortTime } from '../../web/src/format.ts';
import { eventView } from './fixtures.ts';

const fetchMock = vi.fn<typeof fetch>();
const reload = vi.fn();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const applied = () => json({ status: 'applied', event_id: 99, question_ids: [], warnings: [] });

function show(events: EventView[]) {
  return render(
    <ToastProvider>
      <EventLog events={events} reload={reload} />
    </ToastProvider>,
  );
}

/** Newest first, as the server sends them: ids `count` down to 1. */
function many(count: number, over: (id: number) => Partial<EventView> = () => ({})): EventView[] {
  return Array.from({ length: count }, (_, i) => eventView({ id: count - i, ...over(count - i) }));
}

const rows = () => Array.from(document.querySelectorAll('li[id^="event-"]'));
const row = (id: number) => document.getElementById(`event-${id}`) as HTMLElement;
const requests = () =>
  fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }));

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
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

test('has the title 事件日志 and the note that only the latest 200 are shown', () => {
  show([eventView({ id: 1 })]);
  expect(screen.getByRole('region', { name: '事件日志' })).toBeTruthy();
  expect(screen.getByText('只显示最近 200 条')).toBeTruthy();
});

test('the note about how many are shown follows what the server sends', () => {
  expect(EVENTS_SHOWN).toBe(EVENTS_IN_DETAIL);
});

test('without events it says so and has no 显示更多', () => {
  show([]);
  expect(screen.getByText('还没有事件')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '显示更多' })).toBeNull();
});

test('a row shows #id, the time, who, what, the entity and the reason', () => {
  show([
    eventView({
      id: 5,
      occurred_at: '2026-10-29T08:30:00.000Z',
      actor: 'ai:curator',
      op: 'transition_stage',
      entity: 'project:p_1',
      reason: '评测已经跑通了',
    }),
  ]);
  const r = row(5);
  expect(r.tagName).toBe('LI');
  expect(r.textContent).toContain('#5');
  expect(within(r).getByText(shortTime('2026-10-29T08:30:00.000Z'))).toBeTruthy();
  expect(within(r).getByText('AI 整理员')).toBeTruthy();
  expect(within(r).getByText('改阶段')).toBeTruthy();
  expect(within(r).getByText('project:p_1')).toBeTruthy();
  expect(within(r).getByText('评测已经跑通了')).toBeTruthy();
});

test('the #id comes first in the row', () => {
  show([eventView({ id: 5 })]);
  expect(row(5).firstElementChild?.textContent).toBe('#5');
});

test('a row without reason or entity shows neither, and an operation we have no name for is shown as written', () => {
  show([eventView({ id: 5, op: 'brand_new_op', entity: null, reason: null })]);
  const r = row(5);
  expect(within(r).getByText('brand_new_op')).toBeTruthy();
  expect(r.querySelector('.event-reason')).toBeNull();
});

test('evidence is shown as links, and a veto carries the tag 否决', () => {
  show([eventView({ id: 5, evidence: ['digest:3', 'event:2'], is_veto: true }), eventView({ id: 4 })]);
  expect(within(row(5)).getByRole('button', { name: '摘要 #3' })).toBeTruthy();
  expect(within(row(5)).getByText('事件 #2')).toBeTruthy();
  expect(within(row(5)).getByText('否决')).toBeTruthy();
  expect(within(row(4)).queryByText('否决')).toBeNull();
});

test('text from the AI is plain text, not markup', () => {
  show([eventView({ id: 5, reason: '<img src=x onerror=alert(1)> **粗体**' })]);
  expect(row(5).querySelector('img')).toBeNull();
  expect(within(row(5)).getByText('<img src=x onerror=alert(1)> **粗体**')).toBeTruthy();
});

test('a reverted event says 已被 #12 撤销, is faded and has no 撤销 button; the revert itself says 撤销了 #7 and has one', () => {
  show([eventView({ id: 12, op: 'revert_event', reverts: 7 }), eventView({ id: 7, reverted_by: 12 })]);
  const reverted = row(7);
  expect(within(reverted).getByRole('button', { name: '已被 #12 撤销' })).toBeTruthy();
  expect(within(reverted).queryByRole('button', { name: '撤销' })).toBeNull();
  expect(reverted.className).toContain('reverted');

  const revert = row(12);
  expect(within(revert).getByRole('button', { name: '撤销了 #7' })).toBeTruthy();
  expect(within(revert).getByRole('button', { name: '撤销' })).toBeTruthy();
  expect(revert.className).not.toContain('reverted');
});

test('every event that nothing has reverted has a 撤销 button, whatever it is', () => {
  show(many(4));
  expect(screen.getAllByRole('button', { name: '撤销' })).toHaveLength(4);
});

test('撤销 asks once more; the second click posts to /events/7/revert and then reloads', async () => {
  show([eventView({ id: 7 })]);
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确定撤销？' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(requests()).toEqual([{ url: '/events/7/revert', method: 'POST', body: undefined }]);
});

test('a refusal (409 already_reverted) is told in a toast and nothing is reloaded', async () => {
  fetchMock.mockImplementation(async () => json({ error: 'already_reverted', message: 'event 7 was already reverted' }, 409));
  show([eventView({ id: 7 })]);
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  fireEvent.click(screen.getByRole('button', { name: '确定撤销？' }));
  expect(await screen.findByText('已经撤销过了')).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  // The button is usable again.
  await waitFor(() => expect((screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement).disabled).toBe(false));
});

test('a conflict with a later change is told in a toast', async () => {
  fetchMock.mockImplementation(async () => json({ error: 'conflict', message: 'later edits touch it' }, 409));
  show([eventView({ id: 7 })]);
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  fireEvent.click(screen.getByRole('button', { name: '确定撤销？' }));
  expect(await screen.findByText('和后来的改动冲突，没法撤销')).toBeTruthy();
});

test('without a token nothing is sent and the page is told to ask for it', async () => {
  setToken(null);
  const asked = vi.fn();
  window.addEventListener('herdr-pm:auth', asked);
  show([eventView({ id: 7 })]);
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  fireEvent.click(screen.getByRole('button', { name: '确定撤销？' }));
  await waitFor(() => expect(asked).toHaveBeenCalled());
  window.removeEventListener('herdr-pm:auth', asked);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

test('45 events show 30 first; 显示更多 shows 45 and then goes away', () => {
  show(many(45));
  expect(rows()).toHaveLength(30);
  expect(row(45)).not.toBeNull();
  expect(document.getElementById('event-16')).not.toBeNull();
  expect(document.getElementById('event-15')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '显示更多' }));
  expect(rows()).toHaveLength(45);
  expect(screen.queryByRole('button', { name: '显示更多' })).toBeNull();
});

test('每次 显示更多 adds 30 more', () => {
  show(many(75));
  fireEvent.click(screen.getByRole('button', { name: '显示更多' }));
  expect(rows()).toHaveLength(60);
  fireEvent.click(screen.getByRole('button', { name: '显示更多' }));
  expect(rows()).toHaveLength(75);
});

test('exactly 30 events have no 显示更多', () => {
  show(many(30));
  expect(rows()).toHaveLength(30);
  expect(screen.queryByRole('button', { name: '显示更多' })).toBeNull();
});

test('events that come in on a reload do not shrink what was shown', () => {
  const view = show(many(45));
  fireEvent.click(screen.getByRole('button', { name: '显示更多' }));
  view.rerender(
    <ToastProvider>
      <EventLog events={many(46)} reload={reload} />
    </ToastProvider>,
  );
  expect(rows()).toHaveLength(46);
});

test('详情 shows the JSON of before and after, indented by 2 spaces, and hides it again', () => {
  const before = { title: '旧', locks: [] };
  const after = { title: '新', locks: ['title'] };
  show([eventView({ id: 5, before, after })]);
  expect(row(5).querySelector('pre')).toBeNull();
  const button = within(row(5)).getByRole('button', { name: '详情' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const texts = Array.from(row(5).querySelectorAll('pre')).map((pre) => pre.textContent);
  expect(texts).toEqual([JSON.stringify(before, null, 2), JSON.stringify(after, null, 2)]);
  expect(texts[0]).toContain('\n  "title": "旧"');
  fireEvent.click(button);
  expect(row(5).querySelector('pre')).toBeNull();
});

test('详情 of an event without before or after shows null', () => {
  show([eventView({ id: 5, before: null, after: undefined })]);
  fireEvent.click(within(row(5)).getByRole('button', { name: '详情' }));
  expect(Array.from(row(5).querySelectorAll('pre')).map((pre) => pre.textContent)).toEqual(['null', 'null']);
});

test('详情 of one row does not open the others', () => {
  show([eventView({ id: 2 }), eventView({ id: 1 })]);
  fireEvent.click(within(row(2)).getByRole('button', { name: '详情' }));
  expect(row(2).querySelector('pre')).not.toBeNull();
  expect(row(1).querySelector('pre')).toBeNull();
});

test('clicking 已被 #3 撤销 shows enough rows to include #3 and scrolls to it', () => {
  const scrolled: string[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: Element) {
      scrolled.push(this.id);
    },
  });
  // #3 is the 48th of 50.
  show(many(50, (id) => (id === 50 ? { reverted_by: 3 } : {})));
  expect(document.getElementById('event-3')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '已被 #3 撤销' }));
  expect(rows()).toHaveLength(48);
  expect(document.getElementById('event-3')).not.toBeNull();
  expect(scrolled).toEqual(['event-3']);
});

test('clicking 撤销了 #N jumps the same way', () => {
  const scrolled: string[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: Element) {
      scrolled.push(this.id);
    },
  });
  show(many(40, (id) => (id === 40 ? { op: 'revert_event', reverts: 2 } : {})));
  fireEvent.click(screen.getByRole('button', { name: '撤销了 #2' }));
  expect(rows()).toHaveLength(39);
  expect(scrolled).toEqual(['event-2']);
});

test('a jump to a row that is already shown does not add rows', () => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  show([eventView({ id: 12, op: 'revert_event', reverts: 7 }), eventView({ id: 7, reverted_by: 12 })]);
  fireEvent.click(screen.getByRole('button', { name: '已被 #12 撤销' }));
  expect(rows()).toHaveLength(2);
  expect((Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
});

test('a link to an event that is not in the list (older than the 200 shown) is disabled and does not throw', () => {
  show([eventView({ id: 7, reverted_by: 999 })]);
  const link = screen.getByRole('button', { name: '已被 #999 撤销' }) as HTMLButtonElement;
  expect(link.disabled).toBe(true);
  fireEvent.click(link);
  expect(rows()).toHaveLength(1);
});
