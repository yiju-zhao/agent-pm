// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { copyText } from '../../web/src/copy.ts';

const execCommand = vi.fn<(command: string) => boolean>();

/** A fake `navigator.clipboard`, or none at all. */
function setClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

beforeEach(() => {
  execCommand.mockReset();
  Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: execCommand });
  vi.stubGlobal('isSecureContext', false);
  setClipboard(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { clipboard?: unknown }).clipboard;
  delete (document as { execCommand?: unknown }).execCommand;
});

test('outside a secure context the text is copied through a hidden textarea and execCommand', async () => {
  let seen: { value: string; selected: string; inDocument: boolean } | null = null;
  execCommand.mockImplementation((command) => {
    const area = document.querySelector('textarea');
    seen = { value: area?.value ?? '', selected: area ? area.value.slice(area.selectionStart, area.selectionEnd) : '', inDocument: area !== null };
    expect(command).toBe('copy');
    return true;
  });
  await expect(copyText('0d67da1f')).resolves.toBe(true);
  expect(execCommand).toHaveBeenCalledTimes(1);
  // The text was in a textarea, selected, at the moment of the copy ...
  expect(seen).toEqual({ value: '0d67da1f', selected: '0d67da1f', inDocument: true });
  // ... and the textarea is gone afterwards.
  expect(document.querySelector('textarea')).toBeNull();
});

test('execCommand saying no, with no clipboard, is a failure', async () => {
  execCommand.mockReturnValue(false);
  await expect(copyText('abc')).resolves.toBe(false);
  expect(document.querySelector('textarea')).toBeNull();
});

test('execCommand throwing is a failure, and the textarea is still removed', async () => {
  execCommand.mockImplementation(() => {
    throw new Error('not allowed');
  });
  await expect(copyText('abc')).resolves.toBe(false);
  expect(document.querySelector('textarea')).toBeNull();
});

test('a browser without execCommand is a failure', async () => {
  delete (document as { execCommand?: unknown }).execCommand;
  await expect(copyText('abc')).resolves.toBe(false);
  expect(document.querySelector('textarea')).toBeNull();
});

test('focus goes back to where it was after the fallback copy', async () => {
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  execCommand.mockReturnValue(true);
  await copyText('abc');
  expect(document.activeElement).toBe(input);
  input.remove();
});

test('in a secure context the clipboard API is used and execCommand is not', async () => {
  vi.stubGlobal('isSecureContext', true);
  const writeText = vi.fn(async (_text: string) => {});
  setClipboard(writeText);
  await expect(copyText('0d67da1f')).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledWith('0d67da1f');
  expect(execCommand).not.toHaveBeenCalled();
});

test('if the clipboard API fails, execCommand is tried', async () => {
  vi.stubGlobal('isSecureContext', true);
  setClipboard(async () => {
    throw new DOMException('denied', 'NotAllowedError');
  });
  execCommand.mockReturnValue(true);
  await expect(copyText('abc')).resolves.toBe(true);
  expect(execCommand).toHaveBeenCalledTimes(1);
});

test('if both fail, the answer is false', async () => {
  vi.stubGlobal('isSecureContext', true);
  setClipboard(async () => {
    throw new DOMException('denied', 'NotAllowedError');
  });
  execCommand.mockReturnValue(false);
  await expect(copyText('abc')).resolves.toBe(false);
});

test('a clipboard object outside a secure context is not trusted', async () => {
  const writeText = vi.fn(async (_text: string) => {});
  setClipboard(writeText);
  execCommand.mockReturnValue(true);
  await expect(copyText('abc')).resolves.toBe(true);
  expect(writeText).not.toHaveBeenCalled();
});
