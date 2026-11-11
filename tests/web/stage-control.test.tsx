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

test('one field: the menu shows the current stage among all stages, and nothing else', () => {
  renderControl();
  expect(stageSelect().value).toBe('build');
  const labels = within(stageSelect()).getAllByRole('option').map((o) => o.textContent);
  expect(labels).toEqual(['idea', '探索', '构建', '验证', '完成', '搁置', '放弃', '合并']);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText(/AI 预填|你定的/)).toBeNull();
});

test('picking another stage moves the project at once, with no confirmation', async () => {
  renderControl();
  choose('verify');
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(request()).toMatchObject({ url: '/projects/p_1/stage', method: 'POST', body: { stage: 'verify' } });
  expect((request().headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  expect(screen.queryByRole('button', { name: /确定|取消/ })).toBeNull();
});

test('picking the stage the project is in sends nothing', () => {
  renderControl();
  choose('build');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('合并 asks which project first; picking one merges at once with {stage, merge_into}', async () => {
  renderControl();
  choose('merged');
  expect(fetchMock).not.toHaveBeenCalled();
  const target = screen.getByRole('combobox', { name: '合并到' }) as HTMLSelectElement;
  expect(within(target).queryByRole('option', { name: 'dLLM 评测框架' })).toBeNull();
  expect(within(target).getAllByRole('option').map((o) => o.textContent)).toEqual(['合并到哪个项目…', 'loopwm', 'agent-pm']);
  fireEvent.change(target, { target: { value: 'p_2' } });
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request()).toMatchObject({ url: '/projects/p_1/stage', method: 'POST', body: { stage: 'merged', merge_into: 'p_2' } });
});

test('picking another stage instead of a merge target drops the merge and moves there', async () => {
  renderControl();
  choose('merged');
  choose('build');
  expect(screen.queryByRole('combobox', { name: '合并到' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  choose('merged');
  choose('verify');
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(request().body).toEqual({ stage: 'verify' });
  expect(screen.queryByRole('combobox', { name: '合并到' })).toBeNull();
});

test('with no other project to merge into, 合并 says why and sends nothing', () => {
  renderControl({}, [{ id: 'p_1', title: 'dLLM 评测框架' }]);
  choose('merged');
  expect(screen.getByText('没有可以合并进去的项目')).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: '合并到' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('while the project list is on its way the merge menu says 加载中…; when it cannot be read it says so', () => {
  renderControl({}, null);
  choose('merged');
  expect(screen.getByText('加载中…')).toBeTruthy();
  cleanup();
  renderControl({}, null, true);
  choose('merged');
  expect(screen.getByText('读不到项目列表')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
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

test('a refusal is shown in Chinese, nothing is reloaded, and the menu stays on the stage the project is in', async () => {
  fetchMock.mockImplementation(async () => json({ error: 'not_allowed', message: 'build -> done skips verify' }, 409));
  renderControl();
  choose('done');
  expect(await screen.findByText('不允许这个操作：build -> done skips verify')).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  expect(stageSelect().value).toBe('build');
});

test('when the project has moved, the menu shows the new stage', () => {
  const view = renderControl({ stage: 'build' });
  view.rerender(
    <ToastProvider>
      <StageControl project={detail({ id: 'p_1', stage: 'verify' })} mergeTargets={TARGETS} reload={reload} />
    </ToastProvider>,
  );
  expect(stageSelect().value).toBe('verify');
});
