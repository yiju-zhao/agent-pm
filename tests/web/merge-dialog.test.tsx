// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { MergePreviewView } from '../../src/server/merge-routes.ts';
import { setToken } from '../../web/src/api.ts';
import { MergeDialog } from '../../web/src/components/merge-dialog.tsx';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { detail, tag } from './fixtures.ts';

// The merge dialog from the user's side: choose, preview, confirm. The server is a scripted fetch.

const A = 'codex:aaaaaaaa';
const B = 'codex:bbbbbbbb';
const reload = vi.fn();
const onClose = vi.fn();
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let previews: MergePreviewView[];

function contribution(key: string, title: string) {
  return { id: `c_${key}`, session_key: key, project_id: 'p_1', milestone_id: null, summary: null, ts_start: null, ts_end: null, confidence: null, actor: 'user', created_at: '2026-11-01T00:00:00.000Z', session: tag({ key, title, short_id: key.slice(-8) }) };
}
function preview(over: Partial<MergePreviewView> = {}): MergePreviewView {
  return {
    id: 'mp_1',
    status: 'ready',
    mode: 'sessions',
    source: { id: 'p_1', title: '杂项' },
    target: { id: 'p_2', title: '采集' },
    sessions: [A],
    session_labels: { [A]: '修采集 · gx10', 'codex:cccccccc': '关窗补读 · mac-mini' },
    draft: { title: '采集可靠性', title_change_reason: '工作已收敛到采集可靠性', summary: '补齐漏采', why: '看板依赖完整证据', done_criteria: '- 中文批次入库', unknowns: ['真实机器尚未对账'], evidence: [] },
    coverage: { layer: 'chunks', mode: 'direct', model_calls: 1, sessions: [
      { session_key: A, side: 'source', status: 'read', chunks_total: 2, chunks_read: 2, chars_total: 10, chars_read: 10, truncated_chunks: 1, excerpted_chunks: 0 },
      { session_key: 'codex:cccccccc', side: 'target', status: 'refused', chunks_total: 0, chunks_read: 0, chars_total: 0, chars_read: 0, truncated_chunks: 0, excerpted_chunks: 0 },
    ] },
    error: null,
    stale: false,
    changes: {
      links: [{ session: A, target: 'add', source: 'remove' }],
      source_stage: 'build',
      source_merged: false,
      source_remaining_sessions: [B],
      fields: [
        { field: 'title', before: '采集', after: '采集可靠性', locked: false },
        { field: 'why', before: '我写的原因', after: '看板依赖完整证据', locked: true },
      ],
    },
    created_at: '2026-11-13T10:00:00.000Z',
    ...over,
  };
}
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }));
const writes = () => sent().filter((r) => r.method !== 'GET');

function open() {
  const project = detail({ id: 'p_1', title: '杂项', contributions: [contribution(A, '修采集'), contribution(B, '重做登录页')] as never });
  render(
    <ToastProvider>
      <MergeDialog project={project} targets={[{ id: 'p_2', title: '采集' }]} onClose={onClose} reload={reload} />
    </ToastProvider>,
  );
  return screen.getByRole('dialog', { name: '合并项目' });
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  previews = [preview({ status: 'generating', draft: null, coverage: null, changes: null }), preview()];
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST' && path.endsWith('/merge-previews')) return json(previews[0], 202);
    if (init?.method === 'POST' && path.endsWith('/apply')) return json({ status: 'applied', event_id: 9, question_ids: [], warnings: [], project_review_queued: true });
    return json(previews.at(-1));
  });
  reload.mockReset();
  onClose.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  setToken('tok-1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('choosing sessions, previewing and confirming: the preview shows every change, and only the confirmation writes', async () => {
  const dialog = open();
  const start = within(dialog).getByRole('button', { name: '生成预览' }) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  fireEvent.change(within(dialog).getByRole('combobox', { name: '合并到' }), { target: { value: 'p_2' } });
  fireEvent.click(within(dialog).getByRole('radio', { name: /只移动选中的 session/ }));
  expect(start.disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /修采集/ }));
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(start);

  expect(await within(dialog).findByText(/正在读取所选 session/)).toBeTruthy();
  expect(writes()).toEqual([{ url: '/projects/p_1/merge-previews', method: 'POST', body: { target: 'p_2', sessions: [A] } }]);

  const draft = await within(dialog).findByRole('region', { name: '项目草稿' }, { timeout: 4000 });
  expect(within(draft).getByText('采集可靠性')).toBeTruthy();
  expect(within(draft).getByText('现在：采集')).toBeTruthy();
  expect(within(draft).getByText('改名原因：工作已收敛到采集可靠性')).toBeTruthy();
  expect(within(draft).getByText('- 中文批次入库')).toBeTruthy();
  expect(within(draft).getByText('真实机器尚未对账')).toBeTruthy();
  const links = within(dialog).getByRole('region', { name: '关联变化' });
  expect(links.textContent).toContain('修采集');
  expect(links.textContent).toContain('关联到目标项目');
  expect(links.textContent).toContain('从本项目移出');
  expect(links.textContent).toContain('本项目「杂项」保留，阶段不变，仍有 1 个 session');
  const evidence = within(dialog).getByRole('region', { name: '证据范围' });
  expect(evidence.textContent).toContain('不是 agent 机器上的原始 transcript');
  expect(evidence.textContent).toContain('其中 1 段有消息在采集时已被截断');
  expect(evidence.textContent).toContain('被模型提供方拒绝过，未读取');
  expect(evidence.textContent).toContain('关窗补读 · mac-mini（目标项目已有）');
  expect(writes()).toHaveLength(1);

  // The locked field is replaced only when the user says so.
  fireEvent.click(within(draft).getByRole('checkbox', { name: /你锁定过「为什么」/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: '确认合并' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(writes().at(-1)).toEqual({ url: '/merge-previews/mp_1/apply', method: 'POST', body: { overwrite_locked: ['why'] } });
  expect(reload).toHaveBeenCalledTimes(1);
});

test('merging the whole project asks for no session list and says the project becomes merged', async () => {
  previews = [preview({ mode: 'project', sessions: [A, B], changes: { ...preview().changes!, links: [{ session: A, target: 'add', source: 'keep' }, { session: B, target: 'keep', source: 'keep' }], source_merged: true, source_remaining_sessions: [], fields: [] } })];
  const dialog = open();
  fireEvent.change(within(dialog).getByRole('combobox', { name: '合并到' }), { target: { value: 'p_2' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '生成预览' }));
  const links = await within(dialog).findByRole('region', { name: '关联变化' });
  expect(writes()[0]!.body).toEqual({ target: 'p_2' });
  expect(links.textContent).toContain('目标项目已关联，不重复添加');
  expect(links.textContent).toContain('在本项目的记录中保留');
  expect(links.textContent).toContain('将标记为「已合并」');
  fireEvent.click(within(dialog).getByRole('button', { name: '确认合并' }));
  await waitFor(() => expect(writes().at(-1)!.body).toEqual({ overwrite_locked: [] }));
});

test('a failed preview says nothing changed and offers to try again; a stale one cannot be confirmed', async () => {
  previews = [preview({ status: 'failed', draft: null, changes: null, error: '模型输出不符合要求的结构' })];
  const dialog = open();
  fireEvent.change(within(dialog).getByRole('combobox', { name: '合并到' }), { target: { value: 'p_2' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '生成预览' }));
  expect((await within(dialog).findByRole('alert')).textContent).toBe('没有生成预览，项目未做任何改动：模型输出不符合要求的结构');
  expect(within(dialog).queryByRole('button', { name: '确认合并' })).toBeNull();

  previews = [preview({ stale: true, changes: null })];
  fireEvent.click(within(dialog).getByRole('button', { name: '重新生成' }));
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('已过期'));
  expect(within(dialog).queryByRole('button', { name: '确认合并' })).toBeNull();
  expect(writes().every((r) => r.url.endsWith('/merge-previews'))).toBe(true);
});

test('a confirmation the server refuses keeps the dialog open and shows the preview as it is now', async () => {
  previews = [preview()];
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/apply')) {
      previews = [preview({ stale: true, changes: null })];
      return json({ error: 'stale', message: '请重新生成预览' }, 409);
    }
    return json(previews[0], init?.method === 'POST' ? 202 : 200);
  });
  const dialog = open();
  fireEvent.change(within(dialog).getByRole('combobox', { name: '合并到' }), { target: { value: 'p_2' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '生成预览' }));
  fireEvent.click(await within(dialog).findByRole('button', { name: '确认合并' }));
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('已过期'));
  expect(onClose).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

test('a preview that cannot be started again, or whose progress cannot be read, says why instead of waiting forever', async () => {
  previews = [preview({ status: 'generating', draft: null, coverage: null, changes: null })];
  fetchMock.mockImplementation(async (url, init) => (init?.method === 'POST' ? json(previews[0], 202) : json({ error: 'not_found', message: 'gone' }, 404)));
  const dialog = open();
  fireEvent.change(within(dialog).getByRole('combobox', { name: '合并到' }), { target: { value: 'p_2' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '生成预览' }));
  expect(await within(dialog).findByRole('button', { name: '关闭' })).toBeTruthy();
  expect((await within(dialog).findByRole('alert', {}, { timeout: 4000 })).textContent).toContain('读不到预览的进度');
  expect(within(dialog).getByRole('button', { name: '生成预览' })).toBeTruthy();
});
