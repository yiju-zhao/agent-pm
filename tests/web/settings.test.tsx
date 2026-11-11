// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { SettingsView } from '../../src/server/settings.ts';
import { setToken } from '../../web/src/api.ts';
import { SettingsModal } from '../../web/src/components/settings-modal.tsx';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { KeysPage, scopeLabel } from '../../web/src/pages/keys.tsx';

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function view(over: Partial<SettingsView> = {}): SettingsView {
  return {
    models: { digest: 'claude-haiku-5-5', curate: 'claude-sonnet-5-5', restage: 'claude-sonnet-5-5' },
    model_options: [
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    ],
    roles: [
      { role: 'digest', label: '摘要员', detail: 'd' },
      { role: 'curate', label: '整理员', detail: 'c' },
      { role: 'restage', label: '复核', detail: 'r' },
    ],
    provider: { mode: 'login', origin: 'default', stored: {} },
    secrets_writable: true,
    ...over,
  };
}

const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }));

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const modal = (tab: 'access' | 'models' | 'provider' | 'keys') =>
  render(
    <ToastProvider>
      <SettingsModal initialTab={tab} onClose={() => {}} />
    </ToastProvider>,
  );

test('the center tabs need an admin key first, and point back at 访问', () => {
  modal('models');
  expect(screen.getByText('这一项是中心的设置，需要管理员 API key。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '先设置访问 key' }));
  expect(screen.getByLabelText('API key')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('models: one menu per role; saving sends only what changed; another model id can be typed in', async () => {
  setToken('admin-key');
  fetchMock.mockImplementation(async (_url, init) => (init?.method === 'PUT' ? json(view({ models: { digest: 'claude-haiku-5-5', curate: 'claude-opus-5-5', restage: 'my-model-1' } })) : json(view())));
  modal('models');
  const curate = (await screen.findByLabelText('整理员')) as HTMLSelectElement;
  expect(curate.value).toBe('claude-sonnet-5-5');
  const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(curate, { target: { value: 'claude-opus-5-5' } });
  fireEvent.change(screen.getByLabelText('复核'), { target: { value: '__custom__' } });
  fireEvent.change(screen.getByLabelText('复核 的模型 ID'), { target: { value: 'my-model-1' } });
  fireEvent.click(save);
  await waitFor(() => expect(calls().some((c) => c.method === 'PUT')).toBe(true));
  expect(calls().find((c) => c.method === 'PUT')).toEqual({
    url: '/admin/settings/models',
    method: 'PUT',
    body: { models: { curate: 'claude-opus-5-5', restage: 'my-model-1' } },
  });
});

test('credential: a mode that needs a secret cannot be saved without one; the secret is sent once and only its tail shown', async () => {
  setToken('admin-key');
  fetchMock.mockImplementation(async (_url, init) =>
    init?.method === 'PUT' ? json(view({ provider: { mode: 'api_key', origin: 'settings', stored: { api_key: 'WXYZ' } } })) : json(view()),
  );
  modal('provider');
  expect(await screen.findByText('中心机器的 Claude Code 登录', { selector: 'p b' })).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: /Anthropic API key/ }));
  expect(screen.getByText(/按 token 计费到这个 API key 所属的 API 账户/)).toBeTruthy();
  const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('粘贴新的值'), { target: { value: ' sk-ant-api03-secret-WXYZ ' } });
  fireEvent.click(save);
  await waitFor(() => expect(screen.getByText('已保存 …WXYZ')).toBeTruthy());
  expect(calls().find((c) => c.method === 'PUT')?.body).toEqual({ mode: 'api_key', secret: 'sk-ant-api03-secret-WXYZ' });
  expect(document.body.textContent).not.toContain('sk-ant-api03-secret-WXYZ');
});

const KEYS = {
  keys: [
    { id: 'config:userToken', name: 'userToken（配置文件）', scope: 'admin', prefix: null, origin: 'config', created_at: null, last_used_at: null, revoked_at: null },
    { id: 'k_1', name: 'gx10 agent', scope: 'mcp', prefix: 'hpm_abcdef', origin: 'db', created_at: '2026-11-10T00:00:00.000Z', last_used_at: null, revoked_at: null },
  ],
  machines: ['gx10-090e', 'laptop'],
  paseo_sources: ['paseo-mac-mini'],
};

test('keys page: config keys are read-only; a new key is shown once with how to use it; revoking asks twice', async () => {
  setToken('admin-key');
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return json({ ...KEYS.keys[1], id: 'k_2', name: '新 agent', key: 'hpm_the_only_showing' }, 201);
    if (init?.method === 'DELETE') return json({ revoked: true });
    return json(KEYS);
  });
  render(
    <ToastProvider>
      <KeysPage />
    </ToastProvider>,
  );
  const table = await screen.findByRole('table');
  const configRow = within(table).getByText('userToken（配置文件）').closest('tr')!;
  expect(within(configRow).getByText('改配置文件')).toBeTruthy();
  expect(within(configRow).queryByRole('button')).toBeNull();

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新 agent' } });
  fireEvent.click(screen.getByRole('button', { name: '新建' }));
  const field = (await screen.findByLabelText('新的 key')) as HTMLInputElement;
  const revealed = field.closest('section')!;
  expect(field.value).toBe('hpm_the_only_showing');
  expect(within(revealed).getByText('这个 key 只显示这一次，现在复制保存好。')).toBeTruthy();
  expect(within(revealed).getByText(/claude mcp add --scope user --transport http herdr-pm .*\/mcp --header "Authorization: Bearer hpm_the_only_showing"/)).toBeTruthy();
  expect(calls().find((c) => c.method === 'POST')).toEqual({ url: '/admin/keys', method: 'POST', body: { name: '新 agent', scope: 'mcp' } });
  fireEvent.click(within(revealed).getByRole('button', { name: '我已保存' }));
  expect(screen.queryByLabelText('新的 key')).toBeNull();

  const row = within(table).getByText('gx10 agent').closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: '吊销' }));
  expect(calls().some((c) => c.method === 'DELETE')).toBe(false);
  fireEvent.click(within(row).getByRole('button', { name: '确认吊销' }));
  await waitFor(() => expect(calls().find((c) => c.method === 'DELETE')?.url).toBe('/admin/keys/k_1'));
});

test('a collector key names its machine or source in the scope it asks for', async () => {
  setToken('admin-key');
  fetchMock.mockImplementation(async (_url, init) => (init?.method === 'POST' ? json({ ...KEYS.keys[1], key: 'hpm_x' }, 201) : json(KEYS)));
  render(
    <ToastProvider>
      <KeysPage />
    </ToastProvider>,
  );
  await screen.findByRole('table');
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'gx10 采集器' } });
  fireEvent.change(screen.getByLabelText('权限'), { target: { value: 'herdr' } });
  const create = screen.getByRole('button', { name: '新建' }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('机器'), { target: { value: 'gx10-090e' } });
  fireEvent.click(create);
  await waitFor(() => expect(calls().find((c) => c.method === 'POST')?.body).toEqual({ name: 'gx10 采集器', scope: 'ingest:herdr:gx10-090e' }));
  expect(scopeLabel('ingest:paseo:paseo-mac-mini')).toBe('Paseo 采集器 · paseo-mac-mini');
});
