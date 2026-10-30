// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { SessionTag } from '../../web/src/components/session-tag.tsx';
import { ToastProvider } from '../../web/src/components/toast.tsx';

const execCommand = vi.fn<(command: string) => boolean>();

const session = {
  short_id: '0d67da1f',
  machine: 'gx10-090e',
  agent_kind: 'claude',
  effective_status: 'working',
  title: '修 herdr-pm 的采集器',
};

function renderTag(over: Partial<typeof session> = {}) {
  return render(
    <ToastProvider>
      <SessionTag session={{ ...session, ...over }} />
    </ToastProvider>,
  );
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  execCommand.mockReset();
  Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: execCommand });
  // The page is opened over plain http: no secure context, no navigator.clipboard.
  vi.stubGlobal('isSecureContext', false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (document as { execCommand?: unknown }).execCommand;
});

test('shows machine · agent · ●status · short id, with the session title as its title', () => {
  renderTag();
  const button = screen.getByRole('button');
  expect(button.textContent).toBe('gx10-090e · claude · ●运行中 · 0d67da1f');
  expect(button.getAttribute('title')).toBe('修 herdr-pm 的采集器');
  expect(button.getAttribute('type')).toBe('button');
});

test('the dot carries the status class; offline is its own (hollow) dot', () => {
  const view = renderTag({ effective_status: 'offline' });
  expect(screen.getByRole('button').textContent).toBe('gx10-090e · claude · ●离线 · 0d67da1f');
  expect(view.container.querySelector('.dot-offline')?.textContent).toBe('●');
  view.unmount();

  const blocked = renderTag({ effective_status: 'blocked' });
  expect(blocked.container.querySelector('.dot-blocked')).not.toBeNull();
  expect(blocked.container.querySelector('.dot-offline')).toBeNull();
  blocked.unmount();

  const odd = renderTag({ effective_status: 'brand-new-status' });
  expect(odd.container.querySelector('.dot-idle')).not.toBeNull();
  // A status we have no word for is shown as it is.
  expect(screen.getByRole('button').textContent).toBe('gx10-090e · claude · ●brand-new-status · 0d67da1f');
});

test('clicking copies the short id and says 已复制', async () => {
  let copied = '';
  execCommand.mockImplementation(() => {
    copied = document.querySelector('textarea')?.value ?? '';
    return true;
  });
  renderTag();
  fireEvent.click(screen.getByRole('button'));
  expect(await screen.findByText('已复制 0d67da1f')).toBeTruthy();
  expect(copied).toBe('0d67da1f');
});

test('when copying fails the short id is put in the toast so it can be selected by hand', async () => {
  execCommand.mockReturnValue(false);
  renderTag();
  fireEvent.click(screen.getByRole('button'));
  expect(await screen.findByText('复制失败，短 ID：0d67da1f')).toBeTruthy();
  expect(screen.queryByText('已复制 0d67da1f')).toBeNull();
});
