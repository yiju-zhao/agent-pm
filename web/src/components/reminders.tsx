import { useEffect, useState } from 'react';
import type { Reminder, ReminderCategory } from '../../../src/domain/reminders.ts';
import { apiSend, errorText } from '../api.ts';
import { relTime } from '../format.ts';
import { useApi } from '../use-api.ts';
import { useNow } from '../use-now.ts';
import { useToast } from './toast.tsx';
import { projectHref } from './project-card.tsx';

// Reminders, grouped by what kind of nudge they are. Nothing here is a question: the work happens in the sessions,
// and a reminder goes away by itself when the sessions, projects or repositories show it moved on. The user can only
// put one off ("later", "not again" until it changes), or, for a blocker, say it is handled.

export const CATEGORY: Record<ReminderCategory, { label: string; hint: string; tone: string }> = {
  agent_waiting: { label: 'agent 在等你', hint: '有 agent 停在那里等你确认或回复', tone: 'bad' },
  waiting_you: { label: '等你回复或动手', hint: 'session 里在等你的回复、决定或操作；去那个 session 处理', tone: 'warn' },
  stalled: { label: '需要继续推进', hint: '高优先级项目一周以上没有进展', tone: 'warn' },
  unpushed: { label: '还没推送', hint: '提交两小时以上还没推送到远端', tone: 'accent' },
  source_offline: { label: '采集来源断联', hint: '检查该来源的采集器，恢复心跳后提醒会消失', tone: 'bad' },
  waiting_external: { label: '等外部', hint: '等厂商、额度或其他人；条件满足后会自动消失', tone: 'muted' },
};

export const REMINDERS_PATH = '/reminders';

function ReminderRow({ r, reload, compact, inProject = false }: { r: Reminder; reload(): void; compact: boolean; inProject?: boolean }) {
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const act = async (send: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await send();
      toast(done);
      reload();
    } catch (err) {
      toast(errorText(err));
    }
    setBusy(false);
  };
  const snooze = (hours: number | null) => act(() => apiSend('POST', '/reminders/snooze', { key: r.key, hours }), hours === null ? '不再提醒，内容有变化时会重新出现' : '明天再提醒');
  const blockerId = r.key.startsWith('blocker:') ? r.key.slice('blocker:'.length) : null;
  return (
    <li className={`reminder tone-${CATEGORY[r.category].tone}`} aria-label={r.text}>
      <span className="reminder-text">
        {inProject ? <span className={`reminder-kind tone-${CATEGORY[r.category].tone}`}>{CATEGORY[r.category].label}</span> : null}
        <strong>{r.text}</strong>
        <span className="dim">
          {[r.project_id ? null : r.project_title, r.detail, r.since ? relTime(r.since, now) : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="reminder-actions">
        {r.project_id && !inProject ? <a href={projectHref(r.project_id)}>{r.project_title ?? '项目'}</a> : null}
        {!compact ? (
          <>
            {blockerId && r.project_id ? (
              <button type="button" disabled={busy} onClick={() => void act(() => apiSend('PATCH', `/projects/${encodeURIComponent(r.project_id!)}/blockers/${encodeURIComponent(blockerId)}`, { status: 'cleared' }), '已标记为处理完')}>
                已处理
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void snooze(24)}>明天再提醒</button>
            <button type="button" className="linklike" disabled={busy} onClick={() => void snooze(null)}>不再提醒</button>
          </>
        ) : null}
      </span>
    </li>
  );
}

/**
 * The reminders, by category (the command center: `compact`, a few per category, no put-off buttons) or by project
 * (the Inbox: each project's reminders together, the projects that wait on the user first).
 */
export function Reminders({ compact = false, perCategory = compact ? 3 : Infinity, groupBy = 'category' }: { compact?: boolean; perCategory?: number; groupBy?: 'category' | 'project' }) {
  const reminders = useApi<Reminder[]>(REMINDERS_PATH, ['projects', 'sessions', 'questions']);
  // Crossing the heartbeat threshold and a snooze expiring can both happen without a stream event.
  useEffect(() => {
    const timer = setInterval(reminders.reload, 60_000);
    return () => clearInterval(timer);
  }, [reminders.reload]);
  const list = reminders.data ?? [];
  if (reminders.error) return <p className="dim">{`读不到提醒：${errorText(reminders.error)}`}</p>;
  if (reminders.data === undefined) return <p className="dim">加载中…</p>;
  if (list.length === 0) return <p className="empty">没有需要提醒的事：没有 agent 在等你，项目都在推进。</p>;
  if (groupBy === 'project') return <ByProject list={list} reload={reminders.reload} />;
  const groups = (Object.keys(CATEGORY) as ReminderCategory[]).map((c) => ({ c, items: list.filter((r) => r.category === c) })).filter((g) => g.items.length > 0);
  return (
    <div className="reminders">
      {groups.map(({ c, items }) => (
        <section key={c} className={`reminder-group tone-${CATEGORY[c].tone}`} aria-label={CATEGORY[c].label}>
          <h4 className="group-label">{`${CATEGORY[c].label} · ${items.length}`}</h4>
          {!compact ? <p className="dim reminder-hint">{CATEGORY[c].hint}</p> : null}
          <ul className="reminder-list">
            {items.slice(0, perCategory).map((r) => <ReminderRow key={r.key} r={r} reload={reminders.reload} compact={compact} />)}
          </ul>
          {items.length > perCategory ? <a className="queue-more" href="#/inbox">{`另有 ${items.length - perCategory} 条 → Inbox`}</a> : null}
        </section>
      ))}
    </div>
  );
}

const RANK = Object.keys(CATEGORY) as ReminderCategory[];

/** Each project's reminders together, most pressing first inside; projects ordered by their most pressing reminder. */
function ByProject({ list, reload }: { list: Reminder[]; reload(): void }) {
  const groups = new Map<string, { id: string | null; title: string; items: Reminder[] }>();
  for (const r of list) {
    const key = r.project_id ?? '';
    const g = groups.get(key) ?? { id: r.project_id, title: r.project_title ?? '未归属项目', items: [] };
    g.items.push(r);
    groups.set(key, g);
  }
  const top = (g: { items: Reminder[] }) => Math.min(...g.items.map((r) => RANK.indexOf(r.category)));
  const ordered = [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => RANK.indexOf(a.category) - RANK.indexOf(b.category)) }))
    .sort((a, b) => (a.id === null ? 1 : 0) - (b.id === null ? 1 : 0) || top(a) - top(b) || b.items.length - a.items.length || a.title.localeCompare(b.title));
  return (
    <div className="reminders by-project">
      {ordered.map((g) => {
        const counts = RANK.map((c) => [c, g.items.filter((r) => r.category === c).length] as const).filter(([, n]) => n > 0);
        return (
          <section key={g.id ?? 'none'} className={`reminder-project tone-${CATEGORY[g.items[0]!.category].tone}`} aria-label={g.title}>
            <header className="reminder-project-head">
              {g.id ? <a href={projectHref(g.id)}><strong>{g.title}</strong></a> : <strong>{g.title}</strong>}
              <span className="reminder-counts">{counts.map(([c, n]) => <span key={c} className={`reminder-kind tone-${CATEGORY[c].tone}`}>{`${CATEGORY[c].label} ${n}`}</span>)}</span>
            </header>
            <ul className="reminder-list">
              {g.items.map((r) => <ReminderRow key={r.key} r={r} reload={reload} compact={false} inProject />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** How many reminders there are, for a number on the command center. */
export function useReminderCount(): number | undefined {
  return useApi<Reminder[]>(REMINDERS_PATH, ['projects', 'sessions', 'questions']).data?.length;
}
