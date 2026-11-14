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

test('center settings use the signed-in session and never request a browser API key', async () => {
  fetchMock.mockResolvedValue(json(view()));
  modal('models');
  expect(await screen.findByLabelText('整理员')).toBeTruthy();
  expect(screen.queryByLabelText('API key')).toBeNull();
  expect(fetchMock.mock.calls[0][1]?.credentials).toBe('same-origin');
});

test('models: one menu per role; saving sends only what changed; another model id can be typed in', async () => {
  setToken('admin-key');
  fetchMock.mockImplementation(async (_url, init) => (init?.method === 'PUT' ? json(view({ models: { digest: 'claude-haiku-5-5', curate: 'claude-opus-5-5', restage: 'my-model-1' } })) : json(view())));
  modal('models');
  const curate = (await screen.findByLabelText('整理员')) as HTMLSelectElement;
  expect(curate.value).toBe('claude-sonnet-5-5');
  const save = screen.getByRole('button', { name: '保存更改' }) as HTMLButtonElement;
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
  const save = screen.getByRole('button', { name: '保存更改' }) as HTMLButtonElement;
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

test('key creation is explicit, reveals once, and requires acknowledgement; revoke explains impact', async () => {
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') return json({ ...KEYS.keys[1], id: 'k_2', name: '新 agent', key: 'hpm_the_only_showing' }, 201);
    if (init?.method === 'DELETE') return json({ revoked: true });
    return json(KEYS);
  });
  render(<ToastProvider><KeysPage /></ToastProvider>);
  const table = await screen.findByRole('table');
  expect(within(table).queryByText('userToken（配置文件）')).toBeNull();
  const config = screen.getByText('userToken（配置文件）').closest('li')!;
  expect(within(config).queryByRole('button')).toBeNull();
  expect(screen.queryByLabelText('名称')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '＋ 创建密钥' }));
  expect(within(screen.getByLabelText('用途')).queryByText('管理员脚本')).toBeNull();
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新 agent' } });
  fireEvent.click(screen.getByRole('button', { name: '创建密钥' }));
  const field = await screen.findByLabelText('新的 key') as HTMLInputElement;
  expect(field.value).toBe('hpm_the_only_showing');
  expect(screen.getByText(/claude mcp add/).textContent).toContain('agent-pm');
  expect(screen.getByText(/claude mcp add/).textContent).not.toContain(field.value);
  expect(calls().find((c) => c.method === 'POST')).toEqual({ url: '/admin/keys', method: 'POST', body: { name: '新 agent', scope: 'mcp' } });
  expect((screen.getByRole('button', { name: '完成' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('我已安全保存密钥'));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  expect(screen.queryByLabelText('新的 key')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '吊销 gx10 agent' }));
  expect(calls().some((c) => c.method === 'DELETE')).toBe(false);
  expect(screen.getByText(/立即失去访问权限/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(calls().some((c) => c.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '吊销 gx10 agent' }));
  fireEvent.click(screen.getByRole('button', { name: '确认吊销' }));
  await waitFor(() => expect(calls().find((c) => c.method === 'DELETE')?.url).toBe('/admin/keys/k_1'));
});

test('a collector key requires a machine and sends its restricted scope', async () => {
  fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST' ? json({ ...KEYS.keys[1], key: 'hpm_x' }, 201) : json(KEYS));
  render(<ToastProvider><KeysPage /></ToastProvider>);
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: '＋ 创建密钥' }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'gx10 采集器' } });
  fireEvent.change(screen.getByLabelText('用途'), { target: { value: 'herdr' } });
  const create = screen.getByRole('button', { name: '创建密钥' }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('绑定机器'), { target: { value: 'gx10-090e' } });
  fireEvent.click(create);
  await waitFor(() => expect(calls().find((c) => c.method === 'POST')?.body).toEqual({ name: 'gx10 采集器', scope: 'ingest:herdr:gx10-090e' }));
  expect(scopeLabel('ingest:paseo:paseo-mac-mini')).toBe('Paseo 采集器 · paseo-mac-mini');
});

test('revoked keys stay out of the default list and search and status filters work together', async () => {
  fetchMock.mockResolvedValue(json({ ...KEYS, keys: [...KEYS.keys, { ...KEYS.keys[1], id: 'k_old', name: '旧采集器', scope: 'ingest:herdr:laptop', revoked_at: '2026-11-11T00:00:00Z' }] }));
  render(<ToastProvider><KeysPage /></ToastProvider>);
  const table = await screen.findByRole('table');
  expect(within(table).queryByText('旧采集器')).toBeNull();
  fireEvent.change(screen.getByLabelText('筛选状态'), { target: { value: 'revoked' } });
  expect(within(table).getByText('旧采集器')).toBeTruthy();
  expect(within(table).queryByText('gx10 agent')).toBeNull();
  fireEvent.change(screen.getByLabelText('搜索密钥'), { target: { value: 'missing' } });
  expect(screen.getByText('没有符合条件的密钥')).toBeTruthy();
});

test('unsaved settings survive tab navigation until changes are discarded', async () => {
  fetchMock.mockImplementation(async () => json(view()));
  modal('models');
  fireEvent.change(await screen.findByLabelText('整理员'), { target: { value: 'claude-opus-5-5' } });
  fireEvent.click(screen.getByRole('tab', { name: /模型服务/ }));
  expect(screen.getByText('有尚未保存的更改，要放弃吗？')).toBeTruthy();
  expect((screen.getByLabelText('整理员') as HTMLSelectElement).value).toBe('claude-opus-5-5');
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.queryByText('有尚未保存的更改，要放弃吗？')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /模型服务/ }));
  fireEvent.click(screen.getByRole('button', { name: '放弃更改' }));
  expect(await screen.findByText('调用方式')).toBeTruthy();
  expect(calls().some((c) => c.method === 'PUT')).toBe(false);
});

test('failed creation keeps the form for retry without revealing a secret', async () => {
  fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST' ? json({ error: 'invalid', message: '名称无效' }, 400) : json(KEYS));
  render(<ToastProvider><KeysPage /></ToastProvider>);
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: '＋ 创建密钥' }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'test agent' } });
  fireEvent.click(screen.getByRole('button', { name: '创建密钥' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('test agent');
  expect(screen.queryByLabelText('新的 key')).toBeNull();
  expect((screen.getByRole('button', { name: '创建密钥' }) as HTMLButtonElement).disabled).toBe(false);
});


test('account password drafts are protected when closing settings', async () => {
  modal('access');
  fireEvent.click(screen.getByRole('button', { name: '修改密码' }));
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'unsaved-password' } });
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(screen.getByText('有尚未保存的更改，要放弃吗？')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect((screen.getByLabelText('当前密码') as HTMLInputElement).value).toBe('unsaved-password');
});
