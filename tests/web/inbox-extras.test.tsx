// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { QuestionView } from '../../src/domain/read.ts';
import { AutoDecisions, SameNameProjects, sameNameGroups } from '../../web/src/components/inbox-extras.tsx';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { card, question } from './fixtures.ts';

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let answered: QuestionView[];

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  answered = [];
  localStorage.clear();
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    if (url === '/questions?status=answered') return json(answered);
    if (init?.method === 'POST') return json({ status: 'applied', event_id: 99, question_ids: [], warnings: [] });
    return json({ error: 'not_found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('decisions the AI made alone are listed with what it chose, how sure it was, and an undo', async () => {
  answered = [
    question({ id: 'q_1', status: 'answered', prompt: '这个 session 属于哪个项目？', options: [{ label: '关联到 openlingo', has_op: true, op: 'link_session', args: {} }, { label: '都不是', has_op: false, op: null, args: null }], auto: { decider: 'Jev', confidence: 0.91, option_index: 0, event_id: 7, reason: '仓库一致' } }),
    question({ id: 'q_2', status: 'answered', prompt: '用户自己答的' }),
  ];
  render(<ToastProvider><AutoDecisions /></ToastProvider>);
  const section = await screen.findByRole('region', { name: 'AI 已自动决定' });
  expect(within(section).getByRole('heading').textContent).toBe('AI 已自动决定 · 1');
  expect(section.textContent).toContain('→ 关联到 openlingo');
  expect(section.textContent).toContain('Jev · 置信度 91%');
  expect(section.textContent).not.toContain('用户自己答的');
  fireEvent.click(within(section).getByRole('button', { name: '撤销' }));
  await waitFor(() => expect(within(section).getByText('已撤销')).toBeTruthy());
  expect(fetchMock.mock.calls.some(([url, init]) => url === '/events/7/revert' && init?.method === 'POST')).toBe(true);
});

test('projects are grouped by the Paseo project most of their sessions work in, joining the one named after it, largest groups first', () => {
  const groups = sameNameGroups([
    card({ id: 'p_1', title: 'open-evo', project_names: ['open-evo'] }),
    card({ id: 'p_2', title: 'open-evo：RSI 流水线', project_names: ['open-evo'] }),
    card({ id: 'a', title: 'ATZ 财报研究', project_names: ['power-of-compounding'] }),
    card({ id: 'b', title: 'NVO 能力圈扩展', project_names: ['power-of-compounding', 'beta-lab'] }),
    card({ id: 'c', title: 'dLLM 评测', project_names: ['diffusion-model', 'beta-lab'] }),
    card({ id: 'd', title: 'lewm-loopedwm：gap 诊断', project_names: ['beta-lab', 'lewm-loopedwm'] }),
    card({ id: 'e', title: 'open-evo：已完成的', project_names: ['open-evo'], closed: true }),
  ]);
  expect(groups.map((g) => [g.name, g.target?.id ?? null, g.members.map((m) => m.id)])).toEqual([
    ['power-of-compounding', null, ['a', 'b']],
    ['open-evo', 'p_1', ['p_2']],
  ]);
});

test('a group is one yes/no: yes shows what will happen and does it on confirmation, no remembers they are separate', async () => {
  const cards = [
    card({ id: 'a', title: 'ATZ 财报研究', project_names: ['power-of-compounding'] }),
    card({ id: 'b', title: 'NVO 能力圈扩展', project_names: ['power-of-compounding'] }),
    card({ id: 'c', title: 'RBLX 估值', project_names: ['power-of-compounding'] }),
  ];
  fetchMock.mockImplementation(async (url, init) => {
    if (url === '/projects' && init?.method === 'POST') return json({ status: 'applied', event_id: 1, id: 'p_new', question_ids: [], warnings: [] }, 201);
    return json({ status: 'applied', event_id: 2, question_ids: [], warnings: [] });
  });
  const reload = vi.fn();
  const view = render(<ToastProvider><SameNameProjects cards={cards} reload={reload} /></ToastProvider>);
  const group = screen.getByRole('listitem', { name: 'power-of-compounding' });
  expect(within(group).getByText('把这 3 个项目合并成一个长期项目「power-of-compounding」？')).toBeTruthy();
  fireEvent.click(within(group).getByRole('button', { name: '是，看看会怎么合并' }));
  const dialog = await screen.findByRole('dialog', { name: '合并为一个项目' });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(dialog.textContent).toContain('新建项目「power-of-compounding」');
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /RBLX 估值/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: '确认合并 2 个项目' }));
  await waitFor(() => expect(reload).toHaveBeenCalled());
  const writes = fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))]);
  expect(writes).toEqual([
    ['/projects', { title: 'power-of-compounding', stage: 'build' }],
    ['/projects/a/stage', { stage: 'merged', merge_into: 'p_new' }],
    ['/projects/b/stage', { stage: 'merged', merge_into: 'p_new' }],
  ]);
  view.unmount();
  render(<ToastProvider><SameNameProjects cards={cards} reload={reload} /></ToastProvider>);
  fireEvent.click(screen.getByRole('button', { name: '否，它们各自独立' }));
  expect(screen.queryByRole('region', { name: '可能是同一个项目' })).toBeNull();
});
