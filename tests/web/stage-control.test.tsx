// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectDetail } from '../../src/domain/read.ts';
import { setToken } from '../../web/src/api.ts';
import { StageControl } from '../../web/src/components/stage-control.tsx';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { detail } from './fixtures.ts';

const fetchMock = vi.fn<typeof fetch>();
const reload = vi.fn();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const applied = () => json({ status: 'applied', event_id: 7, question_ids: [], warnings: [] });

const TARGETS = [
  { id: 'p_1', title: 'dLLM 评测框架' },
  { id: 'p_2', title: 'loopwm' },
  { id: 'p_3', title: 'agent-pm' },
];

/** `targets: null` stands for a project list that has not arrived (or, with `targetsFailed`, could not be read). */
function renderControl(over: Partial<ProjectDetail> = {}, targets: typeof TARGETS | null = TARGETS, targetsFailed = false) {
  return render(
    <ToastProvider>
      <StageControl
        project={detail({ id: 'p_1', stage: 'build', ...over })}
        mergeTargets={targets ?? undefined}
        mergeTargetsFailed={targetsFailed}
        reload={reload}
      />
    </ToastProvider>,
  );
}

const stageSelect = () => screen.getByRole('combobox', { name: '阶段' }) as HTMLSelectElement;
const choose = (stage: string) => fireEvent.change(stageSelect(), { target: { value: stage } });
const request = () => {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, method: init?.method, headers: init?.headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
};

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
});

test('one field: the menu shows the current stage among all stages, with who set it', () => {
  renderControl({ field_sources: { stage: 'ai', priority: null } });
  expect(stageSelect().value).toBe('build');
  const labels = within(stageSelect()).getAllByRole('option').map((o) => o.textContent);
  expect(labels).toEqual(['idea', '探索', '构建', '验证', '完成', '搁置', '放弃', '合并']);
  expect(screen.getByText('AI 预填')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '确定' })).toBeNull();
  cleanup();
  renderControl({ field_sources: { stage: 'user', priority: null } });
  expect(screen.getByText('你定的')).toBeTruthy();
});

test('picking another stage only proposes it: nothing is sent until 确定, and 取消 puts the field back', async () => {
  renderControl();
  choose('verify');
  expect(stageSelect().value).toBe('verify');
  expect(screen.getByText('构建 → 验证')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(stageSelect().value).toBe('build');
  expect(screen.queryByRole('button', { name: '确定' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  choose('verify');
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toMatchObject({ url: '/projects/p_1/stage', method: 'POST', body: { stage: 'verify' } });
  expect((request().headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
});

test('选了 合并 但没选目标时 确定 不能点；选了目标后发出 {stage, merge_into}', async () => {
  renderControl();
  choose('merged');
  const ok = screen.getByRole('button', { name: '确定' }) as HTMLButtonElement;
  expect(ok.disabled).toBe(true);
  const target = screen.getByRole('combobox', { name: '合并到' }) as HTMLSelectElement;
  expect(within(target).queryByRole('option', { name: 'dLLM 评测框架' })).toBeNull();
  expect(within(target).getAllByRole('option').map((o) => o.textContent)).toEqual(['选择目标项目', 'loopwm', 'agent-pm']);
  fireEvent.change(target, { target: { value: 'p_2' } });
  expect(ok.disabled).toBe(false);
  fireEvent.click(ok);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toMatchObject({ url: '/projects/p_1/stage', method: 'POST', body: { stage: 'merged', merge_into: 'p_2' } });
});

test('the target menu is only there for 合并', () => {
  renderControl();
  choose('verify');
  expect(screen.queryByRole('combobox', { name: '合并到' })).toBeNull();
});

test('with no other project to merge into, 合并 cannot be confirmed and says why', () => {
  renderControl({}, [{ id: 'p_1', title: 'dLLM 评测框架' }]);
  choose('merged');
  expect(screen.getByText('没有可以合并进去的项目')).toBeTruthy();
  expect((screen.getByRole('button', { name: '确定' }) as HTMLButtonElement).disabled).toBe(true);
});

test('while the project list is on its way the merge menu says 加载中…; when it cannot be read it says so', () => {
  renderControl({}, null);
  choose('merged');
  expect(screen.getByText('加载中…')).toBeTruthy();
  expect((screen.getByRole('button', { name: '确定' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  renderControl({}, null, true);
  choose('merged');
  expect(screen.getByText('读不到项目列表')).toBeTruthy();
});

test('a parked project has a button back to the stage it was parked from', async () => {
  renderControl({ stage: 'parked', stage_before_park: 'build' });
  expect(stageSelect().value).toBe('parked');
  fireEvent.click(screen.getByRole('button', { name: '恢复到 构建' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toMatchObject({ url: '/projects/p_1/stage', method: 'POST', body: { stage: 'build' } });
});

test('a project that is not parked has no 恢复 button', () => {
  renderControl();
  expect(screen.queryByRole('button', { name: /恢复到/ })).toBeNull();
});

test('a refusal is shown in Chinese and nothing is reloaded; the choice stays pending', async () => {
  fetchMock.mockImplementation(async () => json({ error: 'not_allowed', message: 'build -> done skips verify' }, 409));
  renderControl();
  choose('done');
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
  expect(await screen.findByText('不允许这个操作：build -> done skips verify')).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  expect(stageSelect().value).toBe('done');
  expect(screen.getByRole('button', { name: '确定' })).toBeTruthy();
});

test('when the project moves to the picked stage, the field simply shows it, with nothing pending', () => {
  const view = renderControl({ stage: 'build' });
  choose('verify');
  view.rerender(
    <ToastProvider>
      <StageControl project={detail({ id: 'p_1', stage: 'verify' })} mergeTargets={TARGETS} reload={reload} />
    </ToastProvider>,
  );
  expect(stageSelect().value).toBe('verify');
  expect(screen.queryByRole('button', { name: '确定' })).toBeNull();
});
