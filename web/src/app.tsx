import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import type { SchedulerStatus } from '../../src/understand/status.ts';
import { AUTH_EVENT, apiSend, errorText, setToken } from './api.ts';
import { useToast } from './components/toast.tsx';
import { HomePage } from './pages/home.tsx';
import { ProjectPage } from './pages/project.tsx';
import { SessionsPage } from './pages/sessions.tsx';
import { parseHash } from './route.ts';
import type { Route } from './route.ts';
import type { StreamState } from './stream.ts';
import { useApi, useConnectionState } from './use-api.ts';

const CONNECTION_LABEL: Record<StreamState, string> = { open: '已连接', connecting: '重连中', closed: '已断开' };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `HH:mm` in the browser's time zone. */
function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The one-line summary of the understanding layer shown in the header. */
function understandingText(s: SchedulerStatus): string {
  if (!s.enabled) return '理解层未开启';
  if (s.paused_until !== null) {
    const detail = [s.pause_reason, `${clock(s.paused_until)} 恢复`].filter((part) => part).join('，');
    return `整理已暂停（${detail}）`;
  }
  if (s.running === 'digest') return '摘要中…';
  if (s.running === 'curate') return '整理中…';
  let text = '空闲';
  if (s.waiting_sessions > 0) text += ` · 待摘要 ${s.waiting_sessions} 个 session`;
  if (s.uncurated_digests > 0) text += ` · 待整理 ${s.uncurated_digests} 条`;
  return text;
}

function UnderstandingStatus() {
  const { data, error } = useApi<{ understanding: SchedulerStatus }>('/status', ['status']);
  const status = data?.understanding;
  return (
    <span className="understanding">
      <span>{status ? understandingText(status) : error ? errorText(error) : '…'}</span>
      {status?.last_error ? (
        <span className="warn" title={status.last_error}>
          ⚠
        </span>
      ) : null}
    </span>
  );
}

function SyncButton() {
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    try {
      await apiSend('POST', '/sync');
      toast('已开始同步');
    } catch (err) {
      toast(errorText(err));
    } finally {
      setSyncing(false);
    }
  };
  return (
    <button type="button" onClick={sync} disabled={syncing}>
      立即同步
    </button>
  );
}

function ConnectionDot() {
  const state = useConnectionState();
  return (
    <span className={`conn conn-${state}`}>
      <i className="dot" aria-hidden="true" />
      {CONNECTION_LABEL[state]}
    </span>
  );
}

function TokenDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('');
  const titleId = useId();
  const inputId = useId();
  const token = value.trim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (token === '') return;
    setToken(token);
    onClose();
  };
  const clear = () => {
    setToken(null);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={save}>
        <h2 id={titleId}>设置 token</h2>
        <label htmlFor={inputId}>token</label>
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
    </div>
  );
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'home':
      return <HomePage />;
    case 'project':
      // Keyed by id, so going from one project to another starts from an empty page.
      return <ProjectPage key={route.id} id={route.id} />;
    case 'sessions':
      return <SessionsPage />;
  }
}

export function App() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const route = useMemo(() => parseHash(hash), [hash]);
  const [tokenOpen, setTokenOpen] = useState(false);
  const closeToken = useCallback(() => setTokenOpen(false), []);

  // A write without a token, or with one the server refused, asks for the token here.
  useEffect(() => {
    const open = () => setTokenOpen(true);
    window.addEventListener(AUTH_EVENT, open);
    return () => window.removeEventListener(AUTH_EVENT, open);
  }, []);

  return (
    <>
      <header className="topbar">
        <h1>herdr-pm</h1>
        <nav>
          <a href="#/" aria-current={route.page === 'home' ? 'page' : undefined}>
            首页
          </a>
          <a href="#/sessions" aria-current={route.page === 'sessions' ? 'page' : undefined}>
            Session
          </a>
        </nav>
        <div className="topbar-status">
          <UnderstandingStatus />
          <SyncButton />
          <ConnectionDot />
          <button type="button" onClick={() => setTokenOpen(true)}>
            设置 token
          </button>
        </div>
      </header>
      <Page route={route} />
      {tokenOpen ? <TokenDialog onClose={closeToken} /> : null}
    </>
  );
}
