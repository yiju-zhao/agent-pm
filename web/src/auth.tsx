import { createContext, useContext, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { AUTH_EVENT, enableCookieAuthentication, setToken } from './api.ts';

export type LoginSession = { configured: boolean; username: string | null; must_change_password: boolean };
const AuthContext = createContext<{ session: LoginSession; update(session: LoginSession): void } | null>(null);
export const useAdmin = () => useContext(AuthContext);

export async function authRequest(path: string, body?: unknown): Promise<LoginSession> {
  const response = await fetch(`/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Agent-PM': 'browser' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? '暂时无法登录，请重试');
  return data;
}

export function AuthBoundary({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<LoginSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    enableCookieAuthentication();
    setError(null);
    void authRequest('session').then((next) => { setToken(null); setSession(next); }, (err: Error) => setError(err.message));
  };
  useEffect(load, []);
  useEffect(() => {
    const expired = () => setSession((s) => s ? { ...s, username: null } : s);
    window.addEventListener(AUTH_EVENT, expired);
    return () => window.removeEventListener(AUTH_EVENT, expired);
  }, []);
  // Old browser keys are discarded after a successful login; web requests use the HttpOnly session cookie.
  const update = (next: LoginSession) => { setToken(null); setSession(next); };
  if (!session) return <main className="login-page"><h1>agent-pm</h1>{error ? <><p role="alert">{error}</p><button onClick={load}>重试</button></> : <p role="status">正在连接…</p>}</main>;
  if (!session.username || session.must_change_password) return (
    <main className="login-page">
      <h1>agent-pm</h1>
      {!session.configured ? <><h2>配置管理员账号</h2><p>请在中心机器运行管理员初始化命令，然后刷新页面。</p><code>npm run setup:admin -- --config /path/to/server.json</code><button onClick={load}>重新检查</button></> : session.must_change_password ? <PasswordForm initial onSaved={update} /> : <LoginForm onLogin={update} />}
    </main>
  );
  return <AuthContext.Provider value={{ session, update }}>{children}</AuthContext.Provider>;
}

function LoginForm({ onLogin }: { onLogin(session: LoginSession): void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { onLogin(await authRequest('login', { username, password })); }
    catch (err) { setError(err instanceof Error ? err.message : '登录失败'); }
    finally { setBusy(false); }
  };
  return <form className="account-form" onSubmit={submit}>
    <h2>管理员登录</h2><p className="dim">登录后即可管理项目和设置。</p>
    <label htmlFor="admin-username">用户名</label><input id="admin-username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={64} disabled={busy} />
    <label htmlFor="admin-password">密码</label><input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={1024} disabled={busy} />
    {error ? <p role="alert">{error}</p> : null}<button type="submit" disabled={busy || !username || !password}>{busy ? '登录中…' : '登录'}</button>
  </form>;
}

export function PasswordForm({ initial = false, onSaved, onDirty, onBusy }: { initial?: boolean; onSaved(session: LoginSession): void; onDirty?(dirty: boolean): void; onBusy?(busy: boolean): void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = current !== '' || password !== '' || confirmation !== '';
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmation) { setMessage('两次输入的新密码不一致'); return; }
    setBusy(true); setMessage(null);
    try { const next = await authRequest('password', { current_password: current, password }); setCurrent(''); setPassword(''); setConfirmation(''); setMessage('密码已更新'); onSaved(next); }
    catch (err) { setMessage(err instanceof Error ? err.message : '修改失败'); }
    finally { setBusy(false); }
  };
  return <form className="account-form" onSubmit={submit}>
    <h2>{initial ? '设置你的密码' : '修改密码'}</h2>
    <p className="dim">{initial ? '首次登录，请将初始密码更换为自己的密码。' : '修改后，其他浏览器需要重新登录。'}</p>
    <label htmlFor="current-password">{initial ? '初始密码' : '当前密码'}</label><input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required maxLength={1024} disabled={busy} />
    <label htmlFor="new-password">新密码</label><input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} maxLength={1024} disabled={busy} /><p className="dim">至少12个字符</p>
    <label htmlFor="confirm-password">确认新密码</label><input id="confirm-password" type="password" autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required minLength={12} maxLength={1024} disabled={busy} />
    {message ? <p role="status">{message}</p> : null}<button type="submit" disabled={busy || !current || password.length < 12 || !confirmation}>{busy ? '保存中…' : '保存密码'}</button>
  </form>;
}
