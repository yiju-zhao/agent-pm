import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SchedulerStatus } from '../../src/understand/status.ts';
import { AUTH_EVENT, apiSend, errorText } from './api.ts';
import { SettingsModal } from './components/settings-modal.tsx';
import type { SettingsTab } from './components/settings-modal.tsx';
import { Icon } from './components/icon.tsx';
import { useToast } from './components/toast.tsx';
import { HomePage } from './pages/home.tsx';
import { KeysPage } from './pages/keys.tsx';
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
  if (s.running === 'restage') return '复核阶段中…';
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
        <span className="warn" role="img" aria-label="最近一次出错" title={status.last_error}>
          <Icon name="warning" />
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
    case 'keys':
      return <KeysPage />;
  }
}

export function App() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const route = useMemo(() => parseHash(hash), [hash]);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const closeSettings = useCallback(() => setSettingsTab(null), []);

  // A write without a key, or with one the server refused, asks for the key here.
  useEffect(() => {
    const open = () => setSettingsTab('access');
    window.addEventListener(AUTH_EVENT, open);
    return () => window.removeEventListener(AUTH_EVENT, open);
  }, []);

  return (
    <>
      <header className="topbar">
        <h1>agent-pm</h1>
        <nav>
          <a href="#/" aria-current={route.page === 'home' ? 'page' : undefined}>
            首页
          </a>
          <a href="#/sessions" aria-current={route.page === 'sessions' ? 'page' : undefined}>
            Session
          </a>
          <a href="#/keys" aria-current={route.page === 'keys' ? 'page' : undefined}>
            API Keys
          </a>
        </nav>
        <div className="topbar-status">
          <UnderstandingStatus />
          <SyncButton />
          <ConnectionDot />
          <button type="button" onClick={() => setSettingsTab('access')}>
            设置
          </button>
        </div>
      </header>
      <Page route={route} />
      {settingsTab !== null ? <SettingsModal initialTab={settingsTab} onClose={closeSettings} /> : null}
    </>
  );
}
