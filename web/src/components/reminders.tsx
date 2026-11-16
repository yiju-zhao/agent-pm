import { useState } from 'react';
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
  waiting_external: { label: '等外部', hint: '等厂商、额度或其他人；条件满足后会自动消失', tone: 'muted' },
};

export const REMINDERS_PATH = '/reminders';

function ReminderRow({ r, reload, compact }: { r: Reminder; reload(): void; compact: boolean }) {
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
        <strong>{r.text}</strong>
        <span className="dim">
          {[r.project_id ? null : r.project_title, r.detail, r.since ? relTime(r.since, now) : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="reminder-actions">
        {r.project_id ? <a href={projectHref(r.project_id)}>{r.project_title ?? '项目'}</a> : null}
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

/** The reminders by category; `compact` shows a few per category without the put-off buttons (the command center). */
export function Reminders({ compact = false, perCategory = compact ? 3 : Infinity }: { compact?: boolean; perCategory?: number }) {
  const reminders = useApi<Reminder[]>(REMINDERS_PATH, ['projects', 'sessions', 'questions']);
  const list = reminders.data ?? [];
  if (reminders.error) return <p className="dim">{`读不到提醒：${errorText(reminders.error)}`}</p>;
  if (reminders.data === undefined) return <p className="dim">加载中…</p>;
  if (list.length === 0) return <p className="empty">没有需要提醒的事：没有 agent 在等你，项目都在推进。</p>;
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

/** How many reminders there are, for a number on the command center. */
export function useReminderCount(): number | undefined {
  return useApi<Reminder[]>(REMINDERS_PATH, ['projects', 'sessions', 'questions']).data?.length;
}
