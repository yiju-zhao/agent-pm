// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { ApiError } from '../../web/src/api.ts';
import { EditableText } from '../../web/src/components/editable-text.tsx';

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(cleanup);

const onSave = vi.fn<(value: string) => Promise<void>>();

function setup(props: Partial<Parameters<typeof EditableText>[0]> = {}) {
  onSave.mockReset().mockResolvedValue(undefined);
  return render(<EditableText value="旧标题" onSave={onSave} {...props} />);
}

const type = (value: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value } });
const edit = () => fireEvent.click(screen.getByRole('button', { name: /旧标题|（还没有）/ }));

test('click the text, type, Cmd+Enter: onSave gets the new value and editing ends', async () => {
  setup({ multiline: true });
  edit();
  type('新标题');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(onSave).toHaveBeenCalledExactlyOnceWith('新标题');
});

test('Ctrl+Enter saves a multi-line text too, a plain Enter only adds a line', async () => {
  setup({ multiline: true });
  edit();
  type('第一行\n第二行');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(onSave).toHaveBeenCalledExactlyOnceWith('第一行\n第二行');
});

test('a single-line text saves on Enter, but not while an input method is composing', async () => {
  setup();
  edit();
  type('新标题');
  const box = screen.getByRole('textbox');
  fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(box, { key: 'Process', keyCode: 229 });
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(onSave).toHaveBeenCalledExactlyOnceWith('新标题');
});

test('a single-line field is an input, a multi-line one a textarea', () => {
  const single = setup();
  edit();
  expect(screen.getByRole('textbox').tagName).toBe('INPUT');
  single.unmount();
  setup({ multiline: true });
  edit();
  expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA');
});

test('an unchanged value sends nothing; whitespace around the text does not count as a change', () => {
  setup();
  edit();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();

  edit();
  type('  旧标题 ');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('the text is trimmed before it is sent', async () => {
  setup();
  edit();
  type('  新标题\n');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(onSave).toHaveBeenCalledExactlyOnceWith('新标题');
});

test('Esc drops the edit and shows the old value again', () => {
  setup();
  edit();
  type('写到一半');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: '旧标题' })).toBeTruthy();
  // Editing again starts from the saved value, not from the abandoned draft.
  edit();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('旧标题');
});

test('the 保存 and 取消 buttons do what Enter and Esc do (a phone has no Cmd+Enter)', async () => {
  setup({ multiline: true });
  edit();
  type('新的');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();

  edit();
  type('新的');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(onSave).toHaveBeenCalledExactlyOnceWith('新的');
});

test('a null value shows the placeholder; clicking it opens an empty field', () => {
  setup({ value: null, placeholder: '（还没有）', multiline: true });
  expect(screen.getByText('（还没有）')).toBeTruthy();
  edit();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
});

test('when the save is refused the field stays open with the text and the reason', async () => {
  setup();
  onSave.mockRejectedValueOnce(new ApiError(409, 'merged', 'project p_1 was merged'));
  edit();
  type('新标题');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('项目已合并到别的项目');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('新标题');

  // Typing again clears the old reason, and the retry goes through.
  type('新标题 2');
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(onSave).toHaveBeenLastCalledWith('新标题 2');
});

test('a second Enter while the save is on its way does not send it twice', async () => {
  setup();
  let finish: () => void = () => {};
  onSave.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
  edit();
  type('新标题');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(onSave).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
});

test('a new value from the server does not overwrite what is being typed', () => {
  const view = setup();
  edit();
  type('我正在写');
  view.rerender(<EditableText value="别处改的" onSave={onSave} />);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('我正在写');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(screen.getByRole('button', { name: '别处改的' })).toBeTruthy();
});

test('text from the AI is shown as plain text', () => {
  setup({ value: '<img src=x onerror=alert(1)> **粗体**' });
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByRole('button').textContent).toBe('<img src=x onerror=alert(1)> **粗体**');
});

test('the field shows only its text: nothing says who last changed it', () => {
  setup();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(document.body.textContent).toBe('旧标题');
});
