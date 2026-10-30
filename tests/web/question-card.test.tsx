// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { QuestionOptionView, QuestionView } from '../../src/domain/read.ts';
import { AUTH_EVENT, setToken } from '../../web/src/api.ts';
import { QuestionCard } from '../../web/src/components/question-card.tsx';

const fetchMock = vi.fn<typeof fetch>();
const onDone = vi.fn();
const onAuth = vi.fn();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const applied = () => json({ status: 'applied', event_id: 7, question_ids: [], warnings: [] });

const OPTIONS: QuestionOptionView[] = [
  { label: '标记完成', has_op: true, op: 'transition_stage', args: { project: 'p_1', stage: 'done' } },
  { label: '搁置', has_op: true, op: 'transition_stage', args: { project: 'p_1', stage: 'parked' } },
  { label: '都不是', has_op: false, op: null, args: null },
];

function question(over: Partial<QuestionView> = {}): QuestionView {
  return {
    id: 'q_1',
    kind: 'choice',
    prompt: '这个项目可以收尾了吗？',
    options: OPTIONS,
    project_id: 'p_1',
    session_key: null,
    status: 'pending',
    evidence: [],
    created_by: 'ai:curator',
    created_at: '2026-10-30T10:00:00.000Z',
    resolution_note: null,
    ...over,
  };
}

function textQuestion(over: Partial<QuestionView> = {}): QuestionView {
  return question({
    kind: 'text',
    prompt: '这条决策怎么写？',
    options: [{ label: '记录', has_op: true, op: 'record_decision', args: { project: 'p_1' }, text_arg: 'text' }],
    ...over,
  });
}

/** The request the page made: method, URL, parsed body. */
function lastRequest() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, method: init?.method, headers: init?.headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  fetchMock.mockReset();
  onDone.mockReset();
  onAuth.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.addEventListener(AUTH_EVENT, onAuth);
  localStorage.clear();
  setToken('tok-1');
  fetchMock.mockImplementation(async () => applied());
});

afterEach(() => {
  cleanup();
  window.removeEventListener(AUTH_EVENT, onAuth);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('shows the prompt, the project it is about, and one button per option', () => {
  render(<QuestionCard question={question()} projectTitle="herdr-pm" />);
  expect(screen.getByText('这个项目可以收尾了吗？')).toBeTruthy();
  expect(screen.getByText('herdr-pm')).toBeTruthy();
  for (const label of ['标记完成', '搁置', '都不是']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
});

test('an option button says what it would do in its title', () => {
  render(<QuestionCard question={question()} />);
  const title = screen.getByRole('button', { name: '标记完成' }).getAttribute('title') ?? '';
  expect(title).toContain('改阶段');
  expect(title).toContain('stage=done');
  expect(screen.getByRole('button', { name: '都不是' }).getAttribute('title')).toBe('不做任何操作');
});

test('the prompt is plain text, not HTML', () => {
  const { container } = render(<QuestionCard question={question({ prompt: '<img src=x onerror=alert(1)> **粗体**' })} />);
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('<img src=x onerror=alert(1)> **粗体**')).toBeTruthy();
});

test('the second option posts its index with the token, then onDone', async () => {
  render(<QuestionCard question={question()} onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: '搁置' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  const req = lastRequest();
  expect(req.url).toBe('/questions/q_1/answer');
  expect(req.method).toBe('POST');
  expect(req.body).toEqual({ option_index: 1 });
  expect((req.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('the question id is encoded into the path', async () => {
  render(<QuestionCard question={question({ id: 'q/odd id' })} onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: '搁置' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(lastRequest().url).toBe('/questions/q%2Fodd%20id/answer');
});

test('a confirm question works like a choice', async () => {
  const confirm = question({
    kind: 'confirm',
    options: [
      { label: '确认', has_op: true, op: 'ignore_session', args: { session: 's_1' } },
      { label: '取消', has_op: false, op: null, args: null },
    ],
  });
  render(<QuestionCard question={confirm} onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(lastRequest().body).toEqual({ option_index: 0 });
});

test('a text question: 提交 stays disabled until there is something besides whitespace', async () => {
  render(<QuestionCard question={textQuestion()} onDone={onDone} />);
  const submit = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement;
  const input = screen.getByRole('textbox');
  expect(submit.disabled).toBe(true);
  fireEvent.change(input, { target: { value: '   ' } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(input, { target: { value: ' 先做 A，再做 B ' } });
  expect(submit.disabled).toBe(false);

  fireEvent.click(submit);
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  const req = lastRequest();
  expect(req.url).toBe('/questions/q_1/answer');
  expect(req.body).toEqual({ text: '先做 A，再做 B' });
});

test('a text question has no option buttons, and the submit button says what it will run', () => {
  render(<QuestionCard question={textQuestion()} />);
  expect(screen.queryByRole('button', { name: '记录' })).toBeNull();
  const title = screen.getByRole('button', { name: '提交' }).getAttribute('title') ?? '';
  expect(title).toContain('记录决策');
  expect(title).toContain('（填入 text）');
});

test('pressing Enter in the text box submits it', async () => {
  render(<QuestionCard question={textQuestion()} onDone={onDone} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '好' } });
  fireEvent.submit(screen.getByRole('textbox').closest('form') as HTMLFormElement);
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(lastRequest().body).toEqual({ text: '好' });
});

test('every card has 忽略, which posts to dismiss without a body', async () => {
  render(<QuestionCard question={question()} onDone={onDone} />);
  fireEvent.click(screen.getByText('忽略'));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  const req = lastRequest();
  expect(req.url).toBe('/questions/q_1/dismiss');
  expect(req.method).toBe('POST');
  expect(req.body).toBeUndefined();
  cleanup();

  render(<QuestionCard question={textQuestion()} />);
  expect(screen.getByText('忽略')).toBeTruthy();
});

test('a stale question shows why, and onDone is not called', async () => {
  fetchMock.mockImplementation(async () => json({ error: 'stale', message: 'the situation this question was about has changed' }, 409));
  render(<QuestionCard question={question()} onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: '标记完成' }));
  expect(await screen.findByText('情况已变，这个问题已撤回')).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
  // The buttons are usable again.
  expect((screen.getByRole('button', { name: '标记完成' }) as HTMLButtonElement).disabled).toBe(false);
});

test('a failed dismiss shows the reason too', async () => {
  fetchMock.mockImplementation(async () => json({ error: 'not_pending', message: 'question q_1 is answered, not pending' }, 409));
  render(<QuestionCard question={question()} onDone={onDone} />);
  fireEvent.click(screen.getByText('忽略'));
  expect(await screen.findByText('这个问题已经处理过了')).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
});

test('a network failure is shown', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  render(<QuestionCard question={question()} onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: '标记完成' }));
  expect(await screen.findByText('连不上服务器')).toBeTruthy();
});

test('the error goes away when the next attempt starts', async () => {
  fetchMock.mockImplementationOnce(async () => json({ error: 'stale', message: 'x' }, 409));
  render(<QuestionCard question={question()} onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: '标记完成' }));
  await screen.findByText('情况已变，这个问题已撤回');
  fireEvent.click(screen.getByRole('button', { name: '搁置' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('情况已变，这个问题已撤回')).toBeNull();
});

test('while a request is on its way every button is disabled, and a second click sends nothing', async () => {
  let finish: (res: Response) => void = () => {};
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
  render(<QuestionCard question={question()} onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: '标记完成' }));

  await waitFor(() => expect((screen.getByRole('button', { name: '搁置' }) as HTMLButtonElement).disabled).toBe(true));
  for (const name of ['标记完成', '搁置', '都不是', '忽略']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
  }
  fireEvent.click(screen.getByRole('button', { name: '搁置' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  finish(applied());
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('after a successful answer the card stays disabled, so the same question is not answered twice', async () => {
  render(<QuestionCard question={question()} onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: '标记完成' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect((screen.getByRole('button', { name: '搁置' }) as HTMLButtonElement).disabled).toBe(true);
});

test('without a token nothing is sent; the card says why and the token dialog is asked for', async () => {
  localStorage.clear();
  render(<QuestionCard question={question()} onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: '标记完成' }));
  expect(await screen.findByText('需要先设置 token')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(onAuth).toHaveBeenCalledTimes(1);
  expect(onDone).not.toHaveBeenCalled();
});

test('onDone is optional', async () => {
  render(<QuestionCard question={question()} />);
  fireEvent.click(screen.getByRole('button', { name: '标记完成' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((screen.getByRole('button', { name: '搁置' }) as HTMLButtonElement).disabled).toBe(true));
});

test('evidence shows as small tags: digests and chunks open the drawer, the others are plain labels', () => {
  render(<QuestionCard question={question({ evidence: ['digest:3', 'chunk:9#L4', 'event:12', 'question:q_9'] })} />);
  expect(screen.getByRole('button', { name: '摘要 #3' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '片段 #9' })).toBeTruthy();
  expect(screen.getByText('事件 #12').tagName).toBe('SPAN');
  expect(screen.getByText('问题 q_9').tagName).toBe('SPAN');
});

test('no evidence, no tags', () => {
  const { container } = render(<QuestionCard question={question({ evidence: [] })} />);
  expect(container.querySelector('.evidence')).toBeNull();
});
