import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import type { SchedulerStatus } from '../../src/understand/status.ts';
import { apiSend, errorText } from './api.ts';
import { SettingsModal } from './components/settings-modal.tsx';
import type { SettingsTab } from './components/settings-modal.tsx';
import { Icon } from './components/icon.tsx';
import { useToast } from './components/toast.tsx';
import { InboxProvider, useInbox } from './inbox.tsx';
import { splitQuestions } from './home-model.ts';
import { InboxPage } from './pages/inbox.tsx';
import { HomePage } from './pages/home.tsx';
import { OverviewPage } from './pages/overview.tsx';
import { ReviewPage } from './pages/review.tsx';
import { KeysPage } from './pages/keys.tsx';
import { ProjectPage } from './pages/project.tsx';
import { SessionsPage } from './pages/sessions.tsx';
import { parseHash } from './route.ts';
import type { Route } from './route.ts';
import type { StreamState } from './stream.ts';
import { useApi, useConnectionState } from './use-api.ts';

const PAGE_TITLE: Record<Route['page'], string> = { home: '指挥台', projects: '项目', review: '复盘', project: '项目详情', sessions: 'Session', inbox: 'Inbox', keys: '接入密钥' };

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
  if (s.running === 'curate') return s.reviewing_project ? '项目重新整理中…' : '整理中…';
  if (s.running === 'restage') return '复核阶段中…';
  let text = '空闲';
  if (s.waiting_sessions > 0) text += ` · 待摘要 ${s.waiting_sessions} 个 session`;
  if (s.uncurated_digests > 0) text += ` · 待整理 ${s.uncurated_digests} 条`;
  if ((s.pending_project_reviews ?? 0) > 0) text += ` · 待整理 ${s.pending_project_reviews} 个项目`;
  return text;
}

function UnderstandingStatus() {
  const { data, error } = useApi<{ understanding: SchedulerStatus }>('/status', ['status']);
  const status = data?.understanding;
  return (
    <span className="understanding">
      <span>{status ? understandingText(status) : error ? errorText(error) : '…'}</span>
      {(status?.blocked_sessions ?? 0) > 0 ? (
        <a className="dim" href="#/sessions" title={status?.blocked_reason ?? '上游拒绝处理，原文已保留，等待审阅'}>
          {status!.blocked_sessions} 个会话有拒摘缺口
        </a>
      ) : null}
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
      <Icon name="sync" />立即同步
    </button>
  );
}

function ConnectionDot() {
  const state = useConnectionState();
  return (
    <span className={`conn conn-${state}`} title={CONNECTION_LABEL[state]}>
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
      return <OverviewPage />;
    case 'projects':
      return <HomePage />;
    case 'review':
      return <ReviewPage />;
    case 'project':
      // Keyed by id, so going from one project to another starts from an empty page.
      return <ProjectPage key={route.id} id={route.id} />;
    case 'sessions':
      return <SessionsPage />;
    case 'inbox':
      return <InboxPage />;
    case 'keys':
      return <KeysPage />;
  }
}

function InboxLink({ active }: { active: boolean }) {
  const questions = useInbox()!;
  const split = splitQuestions(questions.data ?? []);
  const count = split.needYou.length + split.attribution.length;
  const label = questions.error ? 'Inbox · 暂时无法刷新' : questions.data === undefined ? 'Inbox · 加载中' : `Inbox · ${count} 项待处理`;
  return <a className="inbox-link" href="#/inbox" onClick={questions.reload} aria-current={active ? 'page' : undefined} aria-label={label} title={label}>
    <Icon name="inbox" /><span>Inbox</span>{questions.data !== undefined && count > 0 && <span className="inbox-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}{questions.error && <span className="inbox-load-error" aria-hidden="true">!</span>}
  </a>;
}

export function App() { return <InboxProvider><Workspace /></InboxProvider>; }

function Workspace() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const route = useMemo(() => parseHash(hash), [hash]);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const closeSettings = useCallback(() => setSettingsTab(null), []);

  const here = (page: Route['page']) => (route.page === page || (page === 'projects' && route.page === 'project') ? 'page' : undefined);
  return (
    <div className="shell">
      <aside className="rail">
        <h1 className="wordmark">agent<span className="wordmark-separator">-</span>pm</h1>
        <nav aria-label="主导航">
          <a href="#/" aria-current={here('home')}><Icon name="console" />指挥台</a>
          <a href="#/projects" aria-current={here('projects')}><Icon name="projects" />项目</a>
          <a href="#/review" aria-current={here('review')}><Icon name="review" />复盘</a>
          <a href="#/sessions" aria-current={here('sessions')}><Icon name="sessions" />Session</a>
          <a href="#/keys" aria-current={here('keys')}><Icon name="key" />接入密钥</a>
        </nav>
        <div className="rail-foot">
          <ConnectionDot />
        </div>
      </aside>
      <div className="workspace">
      <header className="topbar">
        <span className="topbar-title">{PAGE_TITLE[route.page]}</span>
        <div className="topbar-status">
          <UnderstandingStatus />
          <SyncButton />
          <InboxLink active={route.page === 'inbox'} />
          <button type="button" onClick={() => setSettingsTab('access')}>
            <Icon name="settings" />设置
          </button>
        </div>
      </header>
      <Page route={route} />
      </div>
      {settingsTab !== null ? <SettingsModal initialTab={settingsTab} onClose={closeSettings} /> : null}
    </div>
  );
}
