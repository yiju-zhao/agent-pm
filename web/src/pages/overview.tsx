import { useMemo, useState } from 'react';
import type { ActivityItem, ActivityKind, ActivityView } from '../../../src/domain/activity.ts';
import type { ProjectCard, QuestionView } from '../../../src/domain/read.ts';
import type { SourceCoverage } from '../../../src/server/coverage.ts';
import type { SessionListItem } from '../../../src/server/http.ts';
import { errorText } from '../api.ts';
import { projectHref } from '../components/project-card.tsx';
import { QuestionCard } from '../components/question-card.tsx';
import { Reminders, useReminderCount } from '../components/reminders.tsx';
import { DayBars, Metric, Panel, ProgressBar, Sparkline, StagePipeline } from '../components/viz.tsx';
import { relTime, shortDate, STATUS_LABEL, statusClass } from '../format.ts';
import { splitQuestions } from '../home-model.ts';
import { useInbox } from '../inbox.tsx';
import { useApi } from '../use-api.ts';
import { useNow } from '../use-now.ts';

// The command center: what needs the user now, what every agent is doing, where every goal stands, and what changed.
// It only finds and points; editing stays on the project page.

const ACTIVITY_DAYS = 14;
/** The queue shows this many decisions in full; the rest are counted and linked. */
const QUEUE_QUESTIONS = 3;
const LIVE = new Set(['working', 'blocked', 'idle', 'unknown', 'done', 'offline']);
const STATUS_ORDER = ['blocked', 'working', 'idle', 'done', 'unknown', 'offline'];

export const KIND_LABEL: Record<ActivityKind, string> = {
  decision: '决策',
  todo_done: '完成',
  milestone_done: '里程碑',
  stage: '阶段',
  blocker_set: '阻塞',
  blocker_cleared: '解除',
  project_created: '新项目',
  merge: '合并',
};

/** The viewer's offset as `Date#getTimezoneOffset` says it, for the server's day buckets. */
export function activityPath(days: number, project?: string): string {
  const tz = new Date().getTimezoneOffset();
  return `/activity?days=${days}&tz=${tz}${project ? `&project=${encodeURIComponent(project)}` : ''}`;
}

/** One item of a change feed. `titles` names its project; without one (a single project's own feed) no project is shown. */
export function ActivityRow({ item, titles, now }: { item: ActivityItem; titles?: Map<string, string>; now: Date }) {
  return (
    <li className={`feed-row kind-${item.kind}`}>
      <span className="feed-kind">{KIND_LABEL[item.kind]}</span>
      <span className="feed-text">
        {item.project_id && titles ? <a className="feed-project" href={projectHref(item.project_id)}>{titles.get(item.project_id) ?? item.project_id}</a> : null}
        <span>{item.text}</span>
      </span>
      <span className="feed-meta">
        <span>{item.actor === 'user' ? '你' : 'AI'}</span>
        <time dateTime={item.at}>{relTime(item.at, now)}</time>
      </span>
    </li>
  );
}

function ActionQueue({ coverage, questions, titles, now, reload }: {
  coverage: SourceCoverage[] | undefined; questions: QuestionView[]; titles: Map<string, string>; now: Date; reload(): void;
}) {
  const { needYou, attribution } = splitQuestions(questions);
  const faults = (coverage ?? []).filter((s) => s.state !== 'ok');
  return (
    <Panel title="行动队列" meta={`${needYou.length + attribution.length} 个需要你决策 · 提醒随进展自动更新`} className="queue">
      <div className="queue-group">
        <h3 className="group-label">{`需要你决策 · ${needYou.length + attribution.length}`}</h3>
        <p className="dim queue-note">只有看板本身的事（项目归并、阶段、你锁定的内容）需要在这里决定。</p>
        {needYou.length + attribution.length === 0 ? <p className="empty">没有需要你在 agent-pm 里决定的事。</p> : null}
        {needYou.slice(0, QUEUE_QUESTIONS).map((q) => <QuestionCard key={q.id} question={q} projectTitle={q.project_id ? titles.get(q.project_id) : undefined} onDone={reload} />)}
        {needYou.length > QUEUE_QUESTIONS ? <a className="queue-more" href="#/inbox">{`另有 ${needYou.length - QUEUE_QUESTIONS} 个待决定 → Inbox`}</a> : null}
        {attribution.length > 0 ? (
          <a className="queue-row" href="#/inbox">
            <span className="tag is-warn">归属</span>
            <span className="queue-text">{`${attribution.length} 个 session 等你决定属于哪个项目`}</span>
            <span className="queue-go">去 Inbox</span>
          </a>
        ) : null}
      </div>
      <div className="queue-group">
        <h3 className="group-label">提醒</h3>
        <p className="dim queue-note">从 session、项目和仓库的实际状态得出；去对应的 session 处理，进展后会自动消失。</p>
        <Reminders compact />
      </div>
      {faults.length > 0 ? (
        <div className="queue-group">
          <h3 className="group-label">{`采集异常 · ${faults.length}`}</h3>
          {faults.map((s) => (
            <a key={s.source_id} className="queue-row" href="#/sessions">
              <span className="tag is-bad">采集</span>
              <span className="queue-text">
                <strong>{s.source_id}</strong>
                <span className="dim">{` · ${s.state === 'never_reported' ? '已配置但从未上报' : s.state === 'offline' ? `采集器离线，最近心跳 ${s.collector_heartbeat ? relTime(s.collector_heartbeat, now) : '无'}` : 'daemon 未连接'}`}</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function Fleet({ sessions, now }: { sessions: SessionListItem[]; now: Date }) {
  const live = sessions.filter((s) => LIVE.has(s.effective_status) && !s.ignored);
  const machines = [...new Set(live.map((s) => s.machine))].sort();
  const count = (list: SessionListItem[], status: string) => list.filter((s) => s.effective_status === status).length;
  return (
    <Panel
      title="运行态势"
      meta={`${machines.length} 台机器 · ${live.length} 个 session · ${count(live, 'working')} 运行中 · ${count(live, 'blocked')} 等你操作`}
      actions={<a href="#/sessions">全部 session</a>}
      className="fleet"
    >
      {live.length === 0 ? <p className="empty">没有在线的 session。</p> : null}
      {machines.map((machine) => {
        const list = live.filter((s) => s.machine === machine).sort((a, b) => STATUS_ORDER.indexOf(a.effective_status) - STATUS_ORDER.indexOf(b.effective_status));
        return (
          <div key={machine} className="lane" role="group" aria-label={machine}>
            <div className="lane-head">
              <strong>{machine}</strong>
              <span className="lane-counts">
                {STATUS_ORDER.filter((st) => count(list, st) > 0).map((st) => (
                  <span key={st}><i className={`sdot ${statusClass(st)}`} />{`${count(list, st)} ${STATUS_LABEL[st]}`}</span>
                ))}
              </span>
            </div>
            <ul className="lane-chips">
              {list.map((s) => (
                <li key={s.key}>
                  <a className={`chip st-${s.effective_status}`} href={s.linked_projects[0] ? projectHref(s.linked_projects[0].id) : '#/sessions'} title={`${s.title}\n${s.cwd}\n${STATUS_LABEL[s.effective_status] ?? s.effective_status} · ${relTime(s.last_seen, now)} · ${s.short_id}`}>
                    <i className={`sdot ${statusClass(s.effective_status)}`} />
                    <span className="chip-title">{s.title || s.short_id}</span>
                    <span className={s.linked_projects.length === 0 ? 'chip-project is-unlinked' : 'chip-project'}>{s.linked_projects[0]?.title ?? '未归属'}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </Panel>
  );
}

function Portfolio({ cards, activity, now }: { cards: ProjectCard[]; activity: ActivityView | undefined; now: Date }) {
  const [showClosed, setShowClosed] = useState(false);
  const daily = new Map((activity?.projects ?? []).map((p) => [p.id, p.daily]));
  const rows = cards.filter((c) => showClosed || !c.closed);
  const open = cards.filter((c) => !c.closed).length;
  const milestones = rows.some((c) => c.milestones_progress.done + c.milestones_progress.doing + c.milestones_progress.todo > 0);
  return (
    <Panel
      title="项目组合"
      meta={`${open} 个进行中 · ${cards.length - open} 个已关闭`}
      actions={
        <>
          <label className="inline-check"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />显示已关闭</label>
          <a href="#/projects">项目列表</a>
        </>
      }
      className="portfolio"
    >
      <div className="table-wrap">
        <table className="grid-table">
          <thead>
            <tr>
              <th scope="col">优先级</th>
              <th scope="col">项目</th>
              <th scope="col">阶段</th>
              {milestones ? <th scope="col">里程碑</th> : null}
              <th scope="col">{`${ACTIVITY_DAYS} 天投入`}</th>
              <th scope="col" className="num">Session</th>
              <th scope="col" className="num">阻塞</th>
              <th scope="col" className="num">待决</th>
              <th scope="col">最近活动</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={c.closed ? 'is-closed' : c.dormant_days !== null ? 'is-dormant' : undefined}>
                <td><span className={`tag prio-${(c.priority ?? 'none').toLowerCase()}`}>{c.priority ?? '—'}</span></td>
                <td className="cell-title">
                  <a href={projectHref(c.id)}>{c.title}</a>
                  {c.inbox ? <span className="tag is-accent">新</span> : null}
                  {c.current_milestone ? <span className="cell-sub">{`当前：${c.current_milestone.title}`}</span> : c.summary ? <span className="cell-sub">{c.summary}</span> : null}
                </td>
                <td><StagePipeline stage={c.stage} /></td>
                {milestones ? <td><ProgressBar {...c.milestones_progress} /></td> : null}
                <td>{daily.has(c.id) ? <Sparkline values={daily.get(c.id)!} label={`${c.title} ${ACTIVITY_DAYS} 天投入`} /> : <span className="dim">…</span>}</td>
                <td className="num">{c.active_sessions.length || <span className="dim">0</span>}</td>
                <td className="num">{c.open_blockers.length > 0 ? <span className="is-bad-text">{c.open_blockers.length}</span> : <span className="dim">0</span>}</td>
                <td className="num">{c.pending_questions.length > 0 ? <span className="is-warn-text">{c.pending_questions.length}</span> : <span className="dim">0</span>}</td>
                <td className="cell-time">{c.dormant_days !== null && !c.closed ? <span className="is-warn-text">{`${c.dormant_days} 天未动`}</span> : relTime(c.last_activity_at, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p className="empty">还没有项目。</p> : null}
    </Panel>
  );
}

export function OverviewPage() {
  const projects = useApi<ProjectCard[]>('/projects', ['projects']);
  const sessions = useApi<SessionListItem[]>('/sessions', ['sessions', 'projects']);
  const activity = useApi<ActivityView>(activityPath(ACTIVITY_DAYS), ['projects', 'sessions']);
  const coverage = useApi<SourceCoverage[]>('/coverage', ['sessions'], { auth: true });
  const inbox = useInbox();
  const now = useNow();
  const cards = projects.data ?? [];
  const list = sessions.data ?? [];
  const titles = useMemo(() => new Map(cards.map((c) => [c.id, c.title])), [cards]);
  const pending = splitQuestions(inbox?.data ?? []);
  const live = list.filter((s) => LIVE.has(s.effective_status) && !s.ignored);
  const unlinked = live.filter((s) => s.linked_projects.length === 0);
  const reminderCount = useReminderCount();
  const faults = (coverage.data ?? []).filter((s) => s.state !== 'ok').length;
  const a = activity.data;
  const reload = () => {
    projects.reload();
    sessions.reload();
  };
  const errors = [projects.error, sessions.error, activity.error].filter((e) => e !== null);

  return (
    <main data-page="home" className="console">
      {errors.length > 0 ? (
        <div className="error-bar" role="alert">
          <span>{errorText(errors[0])}</span>
          <button type="button" onClick={() => { reload(); activity.reload(); }}>重试</button>
        </div>
      ) : null}
      <div className="metrics" role="group" aria-label="关键指标">
        <Metric label="需要你决策" value={pending.needYou.length + pending.attribution.length} tone={pending.needYou.length + pending.attribution.length > 0 ? 'warn' : undefined} href="#/inbox" />
        <Metric label="等你操作" value={live.filter((s) => s.effective_status === 'blocked').length} tone={live.some((s) => s.effective_status === 'blocked') ? 'bad' : undefined} />
        <Metric label="运行中" value={live.filter((s) => s.effective_status === 'working').length} tone="ok" hint={`共 ${live.length} 个在线`} href="#/sessions" />
        <Metric label="未归属 session" value={unlinked.length} tone={unlinked.length > 0 ? 'warn' : undefined} href="#/sessions" />
        <Metric label="提醒" value={reminderCount ?? '—'} tone={(reminderCount ?? 0) > 0 ? 'accent' : undefined} href="#/inbox" hint="随进展自动更新" />
        <Metric label="采集异常" value={coverage.data === undefined ? '—' : faults} tone={faults > 0 ? 'bad' : undefined} href="#/sessions" hint={coverage.data === undefined ? '需要登录' : undefined} />
      </div>
      <div className="console-grid">
        <ActionQueue coverage={coverage.data} questions={inbox?.data ?? []} titles={titles} now={now} reload={reload} />
        <Fleet sessions={list} now={now} />
        <Portfolio cards={cards} activity={a} now={now} />
        <Panel title="工作量" meta={a ? `近 ${ACTIVITY_DAYS} 天收到 ${a.total_daily.reduce((x, y) => x + y, 0)} 段对话，其中未归属 ${a.unlinked_daily.reduce((x, y) => x + y, 0)} 段` : '加载中…'} actions={<a href="#/review">打开复盘 →</a>} className="volume">
          {a ? (
            <>
              <DayBars values={a.total_daily} part={a.unlinked_daily} labels={a.days} label="每天收到的对话段数" />
              <div className="axis"><span>{shortDate(a.days[0]!)}</span><span>今天</span></div>
              <p className="legend"><i className="lg-total" />已归属项目 <i className="lg-part" />未归属</p>
            </>
          ) : null}
        </Panel>
        <Panel title="最近变化" meta={a ? `近 ${ACTIVITY_DAYS} 天 ${a.items.length} 条` : undefined} actions={<a href="#/review">全部变化 →</a>} className="changes">
          {a && a.items.length === 0 ? <p className="empty">这段时间没有决策、完成或阶段变化。</p> : null}
          <ul className="feed">{(a?.items ?? []).slice(0, 14).map((item) => <ActivityRow key={`${item.event_id}-${item.kind}-${item.text}`} item={item} titles={titles} now={now} />)}</ul>
        </Panel>
      </div>
    </main>
  );
}
