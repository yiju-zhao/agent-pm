// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { ConfirmButton } from '../../web/src/components/confirm-button.tsx';

const onConfirm = vi.fn<() => Promise<void>>();

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  vi.useFakeTimers();
  onConfirm.mockReset().mockResolvedValue(undefined);
  render(<ConfirmButton label="删除" confirmLabel="确认删除？" onConfirm={onConfirm} />);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('the first click only asks; the second one, within 3 seconds, does it', async () => {
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();

  await act(async () => {
    vi.advanceTimersByTime(2999);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '确认删除？' }));
  });
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
});

test('after 3 seconds without a second click it goes back to asking nothing', async () => {
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  // The next click starts over: it asks again instead of doing it.
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '确认删除？' })).toBeTruthy();
});

test('it is not clickable while the action is on its way, and a refusal does not leave it stuck', async () => {
  let fail: (reason: Error) => void = () => {};
  onConfirm.mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)));
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  fireEvent.click(screen.getByRole('button', { name: '确认删除？' }));
  expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);

  await act(async () => {
    fail(new Error('refused'));
  });
  expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(false);
});
