// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthBoundary, useAdmin, authRequest } from '../../web/src/auth.tsx';
import { SettingsModal } from '../../web/src/components/settings-modal.tsx';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { AUTH_EVENT, setToken, getToken } from '../../web/src/api.ts';
const fetchMock = vi.fn<typeof fetch>();
const anonymous = { configured: true, username: null, must_change_password: false };
const signedIn = { ...anonymous, username: 'admin' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Child() { const admin = useAdmin(); return <div>工作台 {admin?.session.username}</div>; }
const show = () => render(<AuthBoundary><Child /></AuthBoundary>);
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

test('login uses username/password, removes legacy browser keys and opens the workbench', async () => {
  setToken('stale-old-key');
  fetchMock.mockImplementation(async (path) => json(path === '/auth/session' ? anonymous : signedIn));
  show(); await screen.findByRole('heading', { name: '管理员登录' });
  expect(screen.queryByLabelText('API key')).toBeNull();
  fill('密码', 'my-password-12345'); fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByText('工作台 admin')).toBeTruthy();
  const sent = fetchMock.mock.calls.find(([path]) => path === '/auth/login')![1]!;
  expect(JSON.parse(String(sent.body))).toEqual({ username: 'admin', password: 'my-password-12345' });
  expect(sent.credentials).toBe('same-origin'); expect(getToken()).toBeNull();
  expect(document.body.textContent).not.toContain('my-password-12345');
});

test('a valid cookie resumes without asking for a key; expiry returns to login', async () => {
  fetchMock.mockResolvedValue(json(signedIn)); show();
  expect(await screen.findByText('工作台 admin')).toBeTruthy();
  act(() => window.dispatchEvent(new Event(AUTH_EVENT)));
  expect(await screen.findByRole('heading', { name: '管理员登录' })).toBeTruthy();
  expect(screen.queryByText('工作台 admin')).toBeNull();
});

test('wrong credentials remain on login, show the reason and re-enable submission', async () => {
  fetchMock.mockImplementation(async (path) => path === '/auth/session' ? json(anonymous) : json({ message: '用户名或密码错误' }, 401));
  show(); await screen.findByLabelText('密码'); fill('密码', 'wrong'); fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '用户名或密码错误');
  expect((screen.getByRole('button', { name: '登录' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText('工作台 admin')).toBeNull();
});

test('a temporary password requires a new password before the app is mounted', async () => {
  fetchMock.mockImplementation(async (path) => json(path === '/auth/password' ? signedIn : { ...signedIn, must_change_password: true }));
  show(); await screen.findByLabelText('初始密码');
  expect(screen.queryByText('工作台 admin')).toBeNull();
  fill('初始密码', 'initial-password-123'); fill('新密码', 'my-new-password-456'); fill('确认新密码', 'mismatch');
  fireEvent.click(screen.getByRole('button', { name: '保存密码' }));
  expect(await screen.findByText('两次输入的新密码不一致')).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path]) => path === '/auth/password')).toBe(false);
  fill('确认新密码', 'my-new-password-456'); fireEvent.click(screen.getByRole('button', { name: '保存密码' }));
  expect(await screen.findByText('工作台 admin')).toBeTruthy();
});

test('unconfigured and network error states offer recovery', async () => {
  fetchMock.mockRejectedValueOnce(new Error('连不上服务器')); show();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '连不上服务器');
  fetchMock.mockResolvedValue(json({ ...anonymous, configured: false }));
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('heading', { name: '配置管理员账号' })).toBeTruthy();
  fetchMock.mockResolvedValue(json(anonymous)); fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
  expect(await screen.findByLabelText('密码')).toBeTruthy();
});

test('logout requests always carry the browser anti-CSRF header', async () => {
  fetchMock.mockResolvedValue(json({ ok: true })); await authRequest('logout', {});
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'X-Agent-PM': 'browser' } });
});


test('account settings logout returns to the login screen', async () => {
  fetchMock.mockImplementation(async (path) => json(path === '/auth/logout' ? { ok: true } : signedIn));
  const closed = vi.fn();
  render(<AuthBoundary><ToastProvider><SettingsModal onClose={closed} /></ToastProvider></AuthBoundary>);
  fireEvent.click(await screen.findByRole('button', { name: '退出登录' }));
  expect(await screen.findByRole('heading', { name: '管理员登录' })).toBeTruthy();
  expect(closed).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
});
