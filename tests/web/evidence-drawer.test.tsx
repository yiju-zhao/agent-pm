// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { EvidenceView } from '../../src/domain/evidence.ts';
import { AUTH_EVENT, setToken } from '../../web/src/api.ts';
import { EvidenceDrawer, EvidenceLink } from '../../web/src/components/evidence-drawer.tsx';

const fetchMock = vi.fn<typeof fetch>();
const onAuth = vi.fn();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const SESSION: EvidenceView['session'] = {
  key: 'claude:abc',
  agent_kind: 'claude',
  native_id: 'abc',
  machine: 'gx10-090e',
  pane_id: 'p1',
  terminal_id: 't1',
  workspace_id: 'w1',
  tab_id: 'tab1',
  cwd: '/work/herdr-pm',
  title: '修采集器',
  live_status: 'working',
  lifecycle: 'live',
  fidelity: 'full',
  transcript_path: null,
  predecessor_key: null,
  merged_into: null,
  ignored: 0,
  first_seen: '2026-10-29T08:00:00.000Z',
  last_seen: '2026-10-30T09:00:00.000Z',
  status_changed_at: null,
  content_owner: null,
  short_id: '0d67da1f',
  effective_status: 'working',
  chunk_count: 3,
  sources: [],
};

function digestView(over: Partial<EvidenceView> = {}): EvidenceView {
  return {
    ref: 'digest:3',
    kind: 'digest',
    id: 3,
    session_key: 'claude:abc',
    session: SESSION,
    ts_start: new Date(2026, 9, 30, 9, 5).toISOString(),
    ts_end: new Date(2026, 9, 30, 9, 40).toISOString(),
    digest: {
      topics: [{ label: '采集器掉线', summary: '重连逻辑有竞态', likely_project_ids: ['p_1'], is_new_topic: false, confidence: 0.8 }],
      decisions: [{ text: '先修重连再加指标', quote_ref: 'chunk:9' }],
      progress: ['复现了掉线'],
      todos_added: [],
      todos_done: [],
      blockers: [{ text: '等 gx10 重启', kind: 'external' }],
      open_questions: [],
      trivial: false,
    },
    chunks: [
      { id: 8, kind: 'transcript', ts_start: new Date(2026, 9, 30, 9, 6).toISOString(), ts_end: null, text: '用户：为什么掉线？\n助手：因为竞态。', truncated: false, source: null },
      { id: 9, kind: 'transcript', ts_start: null, ts_end: null, text: '很长的一段对话', truncated: true, source: null },
    ],
    ...over,
  };
}

function serve(view: EvidenceView | null, status = 200) {
  fetchMock.mockImplementation(async () => (view === null ? json({ error: 'not_found' }, 404) : json(view, status)));
}

function open(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  fetchMock.mockReset();
  onAuth.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('isSecureContext', false);
  window.addEventListener(AUTH_EVENT, onAuth);
  localStorage.clear();
  setToken('tok-1');
});

afterEach(() => {
  cleanup();
  window.removeEventListener(AUTH_EVENT, onAuth);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a digest tag reads 摘要 #3 and a chunk tag 片段 #9', () => {
  render(
    <>
      <EvidenceLink evidence="digest:3" />
      <EvidenceLink evidence="chunk:9" />
    </>,
  );
  expect(screen.getByRole('button', { name: '摘要 #3' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '片段 #9' })).toBeTruthy();
});

test('event and question references are plain labels, not buttons', () => {
  render(
    <>
      <EvidenceLink evidence="event:12" />
      <EvidenceLink evidence="question:q_ab12" />
    </>,
  );
  expect(screen.getByText('事件 #12').tagName).toBe('SPAN');
  expect(screen.getByText('问题 q_ab12').tagName).toBe('SPAN');
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a #… suffix is not part of the reference', async () => {
  serve(digestView());
  render(
    <>
      <EvidenceLink evidence="digest:3#xyz" />
      <EvidenceLink evidence="event:5#L2" />
    </>,
  );
  expect(screen.getByText('事件 #5')).toBeTruthy();
  open('摘要 #3');
  await screen.findByText('采集器掉线');
  expect(fetchMock.mock.calls[0][0]).toBe('/evidence/digest%3A3');
});

test('a reference we cannot read is shown as it is, without a button', () => {
  render(<EvidenceLink evidence="memo:77" />);
  expect(screen.getByText('memo:77').tagName).toBe('SPAN');
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('clicking 摘要 #3 asks for /evidence/digest%3A3 with the token and opens the drawer', async () => {
  serve(digestView());
  render(<EvidenceLink evidence="digest:3" />);
  expect(screen.queryByRole('dialog')).toBeNull();
  open('摘要 #3');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('采集器掉线');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/evidence/digest%3A3');
  expect(init?.method).toBe('GET');
  expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
});

test('clicking 片段 #9 asks for the chunk', async () => {
  serve(digestView({ ref: 'chunk:9', kind: 'chunk', id: 9, digest: null, chunks: [digestView().chunks[1]] }));
  render(<EvidenceLink evidence="chunk:9" />);
  open('片段 #9');
  await screen.findByText(/很长的一段对话/);
  expect(fetchMock.mock.calls[0][0]).toBe('/evidence/chunk%3A9');
});

test('the drawer shows the session, the time range, the digest lists and the conversation text', async () => {
  serve(digestView());
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('采集器掉线');

  expect(within(dialog).getByRole('button', { name: 'gx10-090e · claude · ●运行中 · 0d67da1f' })).toBeTruthy();
  expect(within(dialog).getByText('10/30 09:05 – 10/30 09:40')).toBeTruthy();

  expect(within(dialog).getByText(/重连逻辑有竞态/)).toBeTruthy();
  expect(within(dialog).getByText('先修重连再加指标')).toBeTruthy();
  expect(within(dialog).getByText('复现了掉线')).toBeTruthy();
  expect(within(dialog).getByText('等 gx10 重启')).toBeTruthy();
  for (const heading of ['主题', '决策', '进展', '阻塞']) expect(within(dialog).getByText(heading)).toBeTruthy();
  expect(within(dialog).getByText('证据 · 摘要 #3')).toBeTruthy();
  expect(within(dialog).getByText('片段 #8 · 对话 · 10/30 09:06')).toBeTruthy();
  expect(within(dialog).getByText('片段 #9 · 对话')).toBeTruthy();

  const pres = dialog.querySelectorAll('pre');
  expect(pres).toHaveLength(2);
  // The text keeps its line breaks; only a truncated chunk carries the marker.
  expect(pres[0].textContent).toBe('用户：为什么掉线？\n助手：因为竞态。');
  expect(pres[1].textContent).toBe('很长的一段对话…（已截断）');
});

test('a session that has been purged shows its key and （已清除）', async () => {
  serve(digestView({ session: null }));
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  expect(await screen.findByText('session claude:abc（已清除）')).toBeTruthy();
});

test('a chunk reference has no digest lists, just the text', async () => {
  serve(digestView({ ref: 'chunk:8', kind: 'chunk', id: 8, digest: null, chunks: [digestView().chunks[0]] }));
  render(<EvidenceLink evidence="chunk:8" />);
  open('片段 #8');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(/因为竞态/);
  expect(within(dialog).queryByText('主题')).toBeNull();
  expect(dialog.querySelectorAll('pre')).toHaveLength(1);
});

test('a digest that came back malformed does not break the drawer', async () => {
  const broken = digestView({
    digest: { topics: 'oops', decisions: null, progress: [1, null, '有效'], blockers: [{ kind: 'user' }, 'plain'] } as never,
  });
  serve(broken);
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('有效');
  expect(within(dialog).getByText('plain')).toBeTruthy();
  expect(within(dialog).queryByText('主题')).toBeNull();
  expect(within(dialog).queryByText('决策')).toBeNull();
  expect(dialog.querySelectorAll('pre')).toHaveLength(2);
});

test('a digest whose JSON could not be read, and one without conversation text, still read', async () => {
  serve(digestView({ digest: null, chunks: [] }));
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('没有对话原文');
  expect(dialog.querySelectorAll('pre')).toHaveLength(0);
});

test('conversation text is plain text, not HTML', async () => {
  serve(digestView({ chunks: [{ id: 8, kind: 'transcript', ts_start: null, ts_end: null, text: '<b>粗</b><script>alert(1)</script>', truncated: false, source: null }] }));
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('采集器掉线');
  expect(dialog.querySelector('b')).toBeNull();
  expect(dialog.querySelector('script')).toBeNull();
  expect(dialog.querySelector('pre')?.textContent).toBe('<b>粗</b><script>alert(1)</script>');
});

test('while it loads the drawer says so', async () => {
  fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  expect(await screen.findByText('加载中…')).toBeTruthy();
});

test('a 401 says a token is needed and offers to open the token dialog', async () => {
  fetchMock.mockImplementation(async () => json({ error: 'unauthorized' }, 401));
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('需要先设置 token')).toBeTruthy();
  const before = onAuth.mock.calls.length;
  fireEvent.click(within(dialog).getByRole('button', { name: '设置 token' }));
  expect(onAuth.mock.calls.length).toBe(before + 1);
});

test('with no token at all nothing is requested, and the drawer says what to do', async () => {
  localStorage.clear();
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  expect(await screen.findByText('需要先设置 token')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '设置 token' })).toBeTruthy();
});

test('重试 asks again, for example after the token was set', async () => {
  localStorage.clear();
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  await screen.findByText('需要先设置 token');
  setToken('tok-2');
  serve(digestView());
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('采集器掉线')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer tok-2');
  expect(screen.queryByText('需要先设置 token')).toBeNull();
});

test('a reference the server does not know says so in Chinese', async () => {
  serve(null);
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  expect(await screen.findByText('找不到这条证据（可能已被清除）')).toBeTruthy();
  expect(screen.queryByText('需要先设置 token')).toBeNull();
});

test('a network failure is shown', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  expect(await screen.findByText('连不上服务器')).toBeTruthy();
});

test('Escape closes the drawer and focus goes back to the tag', async () => {
  serve(digestView());
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  await screen.findByText('采集器掉线');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '摘要 #3' }));
});

test('the 关闭 button and a click on the backdrop close the drawer', async () => {
  serve(digestView());
  const { baseElement } = render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  await screen.findByText('采集器掉线');
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  open('摘要 #3');
  await screen.findByText('采集器掉线');
  // A click inside the drawer leaves it open ...
  fireEvent.mouseDown(screen.getByRole('dialog'));
  expect(screen.getByRole('dialog')).toBeTruthy();
  // ... one on the dimmed page behind it closes it.
  fireEvent.mouseDown(baseElement.querySelector('.drawer-backdrop') as Element);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('Escape does not close the drawer while the token dialog is on top of it', async () => {
  serve(digestView());
  render(
    <>
      <EvidenceLink evidence="digest:3" />
      <div role="dialog" aria-modal="true" aria-label="token" />
    </>,
  );
  open('摘要 #3');
  await screen.findByText('采集器掉线');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: /证据/ })).toBeTruthy();
});

test('other keys leave the drawer open', async () => {
  serve(digestView());
  render(<EvidenceLink evidence="digest:3" />);
  open('摘要 #3');
  await screen.findByText('采集器掉线');
  fireEvent.keyDown(document, { key: 'a' });
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('EvidenceDrawer can be used on its own and calls onClose', async () => {
  serve(digestView());
  const onClose = vi.fn();
  render(<EvidenceDrawer evidenceRef="digest:3" onClose={onClose} />);
  await screen.findByText('采集器掉线');
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('copying a session tag inside the drawer works like anywhere else', async () => {
  serve(digestView());
  Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: vi.fn(() => true) });
  try {
    render(<EvidenceLink evidence="digest:3" />);
    open('摘要 #3');
    const tag = await screen.findByRole('button', { name: /0d67da1f/ });
    fireEvent.click(tag);
    await waitFor(() => expect((document.execCommand as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1));
  } finally {
    delete (document as { execCommand?: unknown }).execCommand;
  }
});
