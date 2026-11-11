import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { CredentialMode, LlmRole, SettingsView } from '../../../src/server/settings.ts';
import { apiGet, apiSend, errorText, getToken, setToken } from '../api.ts';
import { useToast } from './toast.tsx';

export type SettingsTab = 'access' | 'models' | 'provider' | 'keys';

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'access', label: '访问' },
  { id: 'models', label: '模型' },
  { id: 'provider', label: '模型凭据' },
  { id: 'keys', label: 'API Keys' },
];

/**
 * The settings, one modal with a tab per concern: which key this browser uses, the model of each LLM role, the
 * credential model calls run under, and a way to the API key page. Everything but the first tab is the center's and
 * needs an admin key; without one, those tabs say so and point at the first.
 */
export function SettingsModal({ initialTab = 'access', onClose }: { initialTab?: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [hasToken, setHasToken] = useState(getToken() !== null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="settings-head">
          <h2 id={titleId}>设置</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-tabs" role="tablist" aria-orientation="vertical">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="settings-panel" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label}>
            {tab === 'access' ? <AccessTab onSaved={() => setHasToken(getToken() !== null)} onClose={onClose} /> : null}
            {tab !== 'access' && !hasToken ? (
              <div className="settings-note">
                <p>这一项是中心的设置，需要管理员 API key。</p>
                <button type="button" onClick={() => setTab('access')}>
                  先设置访问 key
                </button>
              </div>
            ) : null}
            {tab !== 'access' && hasToken ? <CenterTabs tab={tab} onClose={onClose} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AccessTab({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const inputId = useId();
  const current = getToken();
  const token = value.trim();

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (token === '') return;
    // Blocked site data: closing as if saved would leave the person wondering why the next write asks again.
    if (!setToken(token)) {
      toast('无法保存 key（浏览器禁止了本地存储）');
      return;
    }
    onSaved();
    onClose();
  };
  const clear = () => {
    setToken(null);
    onSaved();
    onClose();
  };

  return (
    <form className="settings-section" onSubmit={save}>
      <p className="dim">
        这个浏览器访问中心用的 key，只存在本浏览器里。网页上的修改、查看对话原文和这里的中心设置都需要<b>管理员</b>权限的 key：
        配置文件里的 userToken，或在 API Keys 页新建的管理员 key。
      </p>
      <p>{current === null ? '当前：未设置' : `当前：已设置（…${current.slice(-4)}）`}</p>
      <label htmlFor={inputId}>API key</label>
      <input id={inputId} type="password" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="modal-actions">
        <button type="submit" disabled={token === ''}>
          保存
        </button>
        <button type="button" onClick={clear}>
          清除
        </button>
        <button type="button" onClick={onClose}>
          取消
        </button>
      </div>
    </form>
  );
}

/** The tabs that read and change the center's settings. */
function CenterTabs({ tab, onClose }: { tab: SettingsTab; onClose: () => void }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (tab === 'keys') return;
    let live = true;
    apiGet<SettingsView>('/admin/settings', { auth: true }).then(
      (v) => live && setView(v),
      (err: unknown) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [tab]);

  if (tab === 'keys') return <KeysTab onClose={onClose} />;
  if (error !== null) return <p role="alert">{error}</p>;
  if (view === null) return <p className="dim">加载中…</p>;
  return tab === 'models' ? <ModelsTab view={view} onChange={setView} /> : <ProviderTab view={view} onChange={setView} />;
}

const CUSTOM = '__custom__';

function ModelsTab({ view, onChange }: { view: SettingsView; onChange: (v: SettingsView) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Record<LlmRole, string>>(view.models);
  const [custom, setCustom] = useState<Partial<Record<LlmRole, boolean>>>(() =>
    Object.fromEntries(view.roles.map(({ role }) => [role, !view.model_options.some((o) => o.id === view.models[role])])),
  );
  const [busy, setBusy] = useState(false);
  const changed = view.roles.filter(({ role }) => draft[role].trim() !== view.models[role]);

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
      <p className="dim">中心理解层的每个角色用哪个模型。改动从下一次模型调用开始生效，不用重启。</p>
      {view.roles.map(({ role, label, detail }) => (
        <div key={role} className="settings-row">
          <div>
            <label htmlFor={`model-${role}`}>{label}</label>
            <div className="dim small">{detail}</div>
          </div>
          <div className="settings-control">
            <select
              id={`model-${role}`}
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
                aria-label={`${label} 的模型 ID`}
                value={draft[role]}
                placeholder="例如 claude-sonnet-5-5"
                onChange={(e) => setDraft((d) => ({ ...d, [role]: e.target.value }))}
              />
            ) : null}
          </div>
        </div>
      ))}
      <div className="modal-actions">
        <button type="submit" disabled={busy || changed.length === 0}>
          保存
        </button>
      </div>
    </form>
  );
}

const MODE_TEXT: Record<CredentialMode, { title: string; detail: string }> = {
  login: { title: '中心机器的 Claude Code 登录', detail: '默认。用 mac-mini 上已登录的 Claude 账号，按订阅计费。' },
  oauth_token: { title: 'Claude OAuth token', detail: '在任意机器上运行 `claude setup-token` 得到，按订阅计费。' },
  api_key: { title: 'Anthropic API key', detail: '按 token 计费到这个 API key 所属的 API 账户，不走订阅。' },
};

function ProviderTab({ view, onChange }: { view: SettingsView; onChange: (v: SettingsView) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<CredentialMode>(view.provider.mode);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const secretId = useId();
  const stored = mode === 'login' ? undefined : view.provider.stored[mode];
  const needsSecret = mode !== 'login' && stored === undefined && secret.trim() === '';

  const run = async (fn: () => Promise<SettingsView>, done: string) => {
    setBusy(true);
    try {
      onChange(await fn());
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

  const origin = { settings: '在这里选择的', config: '配置文件里的 oauthTokenFile', default: '默认' }[view.provider.origin];
  return (
    <form className="settings-section" onSubmit={save}>
      <p>
        当前使用：<b>{MODE_TEXT[view.provider.mode].title}</b>
        <span className="dim">（{origin}）</span>
      </p>
      <fieldset className="settings-modes">
        <legend>模型调用用哪个凭据</legend>
        {(Object.keys(MODE_TEXT) as CredentialMode[]).map((m) => (
          <label key={m} className="settings-mode">
            <input type="radio" name="credential-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
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
            disabled={!view.secrets_writable}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          {!view.secrets_writable ? <p className="dim">这个中心启动时没有指定存放密钥的位置，不能在网页里保存。</p> : null}
          <p className="dim">保存在中心机器上配置文件旁的 secrets 目录（只有本用户可读），不进数据库，也不会再显示出来。</p>
        </>
      ) : null}
      <div className="modal-actions">
        <button type="submit" disabled={busy || needsSecret}>
          保存
        </button>
        {mode !== 'login' && stored !== undefined ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => apiSend<SettingsView>('DELETE', `/admin/settings/provider/${mode}`), '已删除')}
          >
            删除已保存的
          </button>
        ) : null}
      </div>
    </form>
  );
}

function KeysTab({ onClose }: { onClose: () => void }) {
  return (
    <div className="settings-section">
      <p>中心只有一种凭据：API key。每个 key 有一个权限范围，决定它能做什么：</p>
      <ul className="settings-scopes">
        <li>
          <b>管理员</b>：网页上的修改、查看对话原文、管理 key 和这些设置。只给你自己用。
        </li>
        <li>
          <b>Agent（MCP）</b>：各机器上的 coding agent 用，只能读看板和用 pm_report 上报。
        </li>
        <li>
          <b>herdr 采集器</b> / <b>Paseo 采集器</b>：只能上报自己那台机器或那个 Paseo 来源的数据。
        </li>
      </ul>
      <p className="dim">新建的 key 只存哈希，只在创建时显示一次；可以随时吊销。配置文件里的 token 仍然有效，在列表里显示为只读。</p>
      <div className="modal-actions">
        <a
          className="button"
          href="#/keys"
          onClick={() => {
            onClose();
          }}
        >
          打开 API Keys 管理
        </a>
      </div>
    </div>
  );
}
