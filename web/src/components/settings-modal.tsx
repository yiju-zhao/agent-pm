import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { CredentialMode, LlmRole, SettingsView } from '../../../src/server/settings.ts';
import { apiGet, apiSend, errorText } from '../api.ts';
import { useToast } from './toast.tsx';
import { authRequest, PasswordForm, useAdmin } from '../auth.tsx';
import { Dialog } from './dialog.tsx';
import { ConfirmButton } from './confirm-button.tsx';

export type SettingsTab = 'access' | 'models' | 'provider' | 'keys';

const TABS: Array<{ id: SettingsTab; label: string; detail: string }> = [
  { id: 'access', label: '账号与安全', detail: '登录与密码' },
  { id: 'models', label: '模型', detail: '各角色的模型选择' },
  { id: 'provider', label: '模型服务', detail: '调用身份与计费' },
];
const DESCRIPTIONS: Record<SettingsTab, { title: string; detail: string }> = {
  access: { title: '账号与安全', detail: '管理你的管理员账号和登录状态。' },
  models: { title: '模型', detail: '为摘要、整理与复核选择合适的模型。' },
  provider: { title: '模型服务', detail: '设置 agent-pm 调用 Claude 时使用的凭据。' },
  keys: { title: '接入密钥', detail: '管理 agent 和采集器访问 agent-pm 的权限。' },
};
export function SettingsModal({ initialTab = 'access', onClose }: { initialTab?: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ run(): void } | null>(null);
  const id = useId();
  const request = (run: () => void) => { if (busy) return; if (dirty) { setPending({ run }); const panel = document.getElementById(`${id}-panel`); if (panel) panel.scrollTop = 0; } else run(); };
  return <Dialog title="设置" className="settings-modal" onClose={() => request(onClose)} locked={busy}>
    <div className="settings-head"><div><h2>设置</h2><p className="dim">管理账号、模型与连接</p></div><button type="button" className="icon-btn" aria-label="关闭" disabled={busy} onClick={() => request(onClose)}>×</button></div>
    <div className="settings-body">
      <nav className="settings-nav" aria-label="设置分类">
        <p className="eyebrow">偏好设置</p>
        <div className="settings-tabs" role="tablist" aria-orientation="vertical">
          {TABS.map((item, index) => <button key={item.id} id={`${id}-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`${id}-panel`} tabIndex={tab === item.id ? 0 : -1} disabled={busy}
            onClick={() => { if (tab !== item.id) request(() => { setDirty(false); setTab(item.id); }); }}
            onKeyDown={(event) => {
              const next = (event.key === 'ArrowDown' || event.key === 'ArrowRight') ? (index + 1) % TABS.length : (event.key === 'ArrowUp' || event.key === 'ArrowLeft') ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault(); request(() => { setDirty(false); setTab(TABS[next]!.id); document.getElementById(`${id}-${TABS[next]!.id}`)?.focus(); });
            }}><span>{item.label}</span><small>{item.detail}</small></button>)}
        </div>
        <div className="settings-nav-link"><p className="eyebrow">开发者</p><a href="#/keys" onClick={(event) => { event.preventDefault(); request(() => { window.location.hash = '/keys'; onClose(); }); }}>接入密钥 <span aria-hidden="true">↗</span></a></div>
      </nav>
      <div id={`${id}-panel`} className="settings-panel" role="tabpanel" aria-label={DESCRIPTIONS[tab].title} tabIndex={0}>
        <div className="settings-panel-heading"><h3>{DESCRIPTIONS[tab].title}</h3><p className="dim">{DESCRIPTIONS[tab].detail}</p></div>
        {pending && <div className="unsaved-notice" role="alert"><p>有尚未保存的更改，要放弃吗？</p><div><button type="button" onClick={() => setPending(null)}>继续编辑</button><button type="button" className="danger" onClick={() => { const run = pending.run; setPending(null); setDirty(false); run(); }}>放弃更改</button></div></div>}
        {tab === 'access' ? <AccountTab onClose={onClose} onDirty={setDirty} onBusy={setBusy} /> : tab === 'keys' ? <KeysTab onClose={onClose} /> : <CenterTabs key={tab} tab={tab} onDirty={setDirty} onBusy={setBusy} />}
      </div>
    </div>
  </Dialog>;
}

function AccountTab({ onClose, onDirty, onBusy }: { onClose(): void; onDirty(dirty: boolean): void; onBusy(busy: boolean): void }) {
  const admin = useAdmin();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const passwordBusy = useCallback((value: boolean) => { setBusy(value); onBusy(value); }, [onBusy]);
  return <div className="settings-section">
    <div className="account-identity"><span className="account-avatar" aria-hidden="true">{(admin?.session.username ?? 'A').slice(0, 1).toUpperCase()}</span><div><strong>{admin?.session.username ?? '管理员'}</strong><p className="dim">管理员 · 账号密码登录</p></div><span className="scope-badge">已登录</span></div>
    {editingPassword ? <PasswordForm onDirty={onDirty} onBusy={passwordBusy} onSaved={(session) => { admin?.update(session); onDirty(false); onBusy(false); setBusy(false); setEditingPassword(false); toast('密码已更新'); }} /> : <div className="account-signout"><div><h3>登录密码</h3><p className="dim">建议使用独立密码，至少 12 个字符。</p></div><button type="button" onClick={() => setEditingPassword(true)}>修改密码</button></div>}
    <div className="account-signout"><div><h3>退出此浏览器</h3><p className="dim">退出后，需要重新登录才能管理项目。</p></div><button type="button" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await authRequest('logout', {}); onClose(); admin?.update({ configured: true, username: null, must_change_password: false }); }
      catch (error) { toast(errorText(error)); }
      finally { setBusy(false); }
    }}>退出登录</button></div>
  </div>;
}

/** The tabs that read and change the center's settings. */
function CenterTabs({ tab, onDirty, onBusy }: { tab: SettingsTab; onDirty(dirty: boolean): void; onBusy(busy: boolean): void }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<SettingsView>('/admin/settings', { auth: true }).then(
      (v) => live && setView(v),
      (err: unknown) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [tab]);

  if (error !== null) return <p role="alert">{error}</p>;
  if (view === null) return <p className="dim">加载中…</p>;
  return tab === 'models' ? <ModelsTab view={view} onChange={setView} onDirty={onDirty} onBusy={onBusy} /> : <ProviderTab view={view} onChange={setView} onDirty={onDirty} onBusy={onBusy} />;
}

const CUSTOM = '__custom__';

type EditorProps = { view: SettingsView; onChange(v: SettingsView): void; onDirty(dirty: boolean): void; onBusy(busy: boolean): void };

function ModelsTab({ view, onChange, onDirty, onBusy }: EditorProps) {
  const toast = useToast();
  const [draft, setDraft] = useState<Record<LlmRole, string>>(view.models);
  const [custom, setCustom] = useState<Partial<Record<LlmRole, boolean>>>(() =>
    Object.fromEntries(view.roles.map(({ role }) => [role, !view.model_options.some((o) => o.id === view.models[role])])),
  );
  const [busy, setBusy] = useState(false);
  const changed = view.roles.filter(({ role }) => draft[role].trim() !== view.models[role]);

  useEffect(() => { onDirty(changed.length > 0); }, [changed.length, onDirty]);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const patch = Object.fromEntries(changed.map(({ role }) => [role, draft[role].trim()]));
      onChange(await apiSend<SettingsView>('PUT', '/admin/settings/models', { models: patch }));
      toast('模型已保存，下一次调用开始生效');
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-section" onSubmit={save}>
      <p className="settings-info">更改从下一次模型调用生效，无需重启服务。</p>
      {view.roles.map(({ role, label, detail }) => (
        <div key={role} className="settings-row">
          <div>
            <label htmlFor={`model-${role}`}>{label}</label>
            <div className="dim small">{detail}</div>
          </div>
          <div className="settings-control">
            <select
              id={`model-${role}`}
              disabled={busy}
              value={custom[role] ? CUSTOM : draft[role]}
              onChange={(e) => {
                const v = e.target.value;
                setCustom((c) => ({ ...c, [role]: v === CUSTOM }));
                if (v !== CUSTOM) setDraft((d) => ({ ...d, [role]: v }));
              }}
            >
              {view.model_options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
              <option value={CUSTOM}>其他模型 ID…</option>
            </select>
            {custom[role] ? (
              <input
                disabled={busy}
                aria-label={`${label} 的模型 ID`}
                value={draft[role]}
                placeholder="例如 claude-sonnet-5-5"
                onChange={(e) => setDraft((d) => ({ ...d, [role]: e.target.value }))}
              />
            ) : null}
          </div>
        </div>
      ))}
      <div className="settings-savebar"><span className="dim" role="status">{changed.length ? '有未保存的更改' : '所有更改已保存'}</span><button type="button" disabled={busy || !changed.length} onClick={() => { setDraft(view.models); setCustom(Object.fromEntries(view.roles.map(({ role }) => [role, !view.model_options.some((o) => o.id === view.models[role])]))); }}>重置</button><button type="submit" className="primary" disabled={busy || !changed.length}>{busy ? '正在保存…' : '保存更改'}</button></div>
    </form>
  );
}

const MODE_TEXT: Record<CredentialMode, { title: string; detail: string }> = {
  login: { title: '中心机器的 Claude Code 登录', detail: '默认。用 mac-mini 上已登录的 Claude 账号，按订阅计费。' },
  oauth_token: { title: 'Claude OAuth token', detail: '在任意机器上运行 `claude setup-token` 得到，按订阅计费。' },
  api_key: { title: 'Anthropic API key', detail: '按 token 计费到这个 API key 所属的 API 账户，不走订阅。' },
};

function ProviderTab({ view, onChange, onDirty, onBusy }: EditorProps) {
  const toast = useToast();
  const [mode, setMode] = useState<CredentialMode>(view.provider.mode);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const secretId = useId();
  const stored = mode === 'login' ? undefined : view.provider.stored[mode];
  const needsSecret = mode !== 'login' && stored === undefined && secret.trim() === '';

  const changed = mode !== view.provider.mode || secret.trim() !== '';
  useEffect(() => { onDirty(changed); }, [changed, onDirty]);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  const run = async (fn: () => Promise<SettingsView>, done: string) => {
    setBusy(true);
    try {
      const next = await fn();
      onChange(next); setMode(next.provider.mode);
      setSecret('');
      toast(done);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = secret.trim() === '' ? { mode } : { mode, secret: secret.trim() };
    void run(() => apiSend<SettingsView>('PUT', '/admin/settings/provider', body), '凭据已保存，下一次调用开始生效');
  };

  const origin = { settings: '已保存的设置', config: '来自中心配置', default: '默认凭据' }[view.provider.origin];
  return (
    <form className="settings-section" onSubmit={save}>
      <p className="settings-info">
        当前使用：<b>{MODE_TEXT[view.provider.mode].title}</b>
        <span className="dim">（{origin}）</span>
      </p>
      <fieldset className="settings-modes">
        <legend>调用方式</legend>
        {(Object.keys(MODE_TEXT) as CredentialMode[]).map((m) => (
          <label key={m} className={`settings-mode ${mode === m ? 'is-selected' : ''}`}>
            <input type="radio" name="credential-mode" disabled={busy} value={m} checked={mode === m} onChange={() => { setMode(m); setSecret(''); }} />
            <span>
              <b>{MODE_TEXT[m].title}</b>
              {m !== 'login' && view.provider.stored[m] !== undefined ? <span className="tag">已保存 …{view.provider.stored[m]}</span> : null}
              <br />
              <span className="dim">{MODE_TEXT[m].detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {mode !== 'login' ? (
        <>
          <label htmlFor={secretId}>{stored === undefined ? '粘贴新的值' : '换一个（留空则用已保存的）'}</label>
          <input
            id={secretId}
            type="password"
            autoComplete="off"
            disabled={busy || !view.secrets_writable}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          {!view.secrets_writable ? <p className="dim">这个中心启动时没有指定存放密钥的位置，不能在网页里保存。</p> : null}
          <p className="field-help">凭据安全保存在中心服务器，保存后仅显示末四位。这里的凭据用于调用模型，接入密钥在独立页面管理。</p>
        </>
      ) : null}
      <div className="settings-savebar"><span className="dim" role="status">{changed ? '有未保存的更改' : '所有更改已保存'}</span>
        <button type="submit" className="primary" disabled={busy || needsSecret || !changed || (secret.trim() !== '' && !view.secrets_writable)}>{busy ? '正在保存…' : '保存更改'}</button>
      </div>
      {mode !== 'login' && stored !== undefined && <div className="provider-remove"><p className="dim">如果此凭据正在使用，删除后模型服务将回到默认凭据。</p><ConfirmButton label="删除已保存的凭据" confirmLabel="确认删除凭据" onConfirm={async () => { if (!busy) await run(() => apiSend<SettingsView>('DELETE', `/admin/settings/provider/${mode}`), '凭据已删除'); }} /></div>}
    </form>
  );
}

function KeysTab({ onClose }: { onClose: () => void }) {
  return <div className="settings-section"><p>为 agent 和采集器创建专属密钥、查看使用情况，或吊销不再使用的连接。</p><a className="button primary" href="#/keys" onClick={onClose}>管理接入密钥 ↗</a></div>;
}
