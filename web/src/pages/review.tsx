import { useMemo, useState } from 'react';
import type { ActivityItem, ActivityKind, ActivityView, ProjectActivity } from '../../../src/domain/activity.ts';
import { STAGE_LABEL } from '../../../src/shared/vocab.ts';
import { errorText } from '../api.ts';
import { copyText } from '../copy.ts';
import { projectHref } from '../components/project-card.tsx';
import { useToast } from '../components/toast.tsx';
import { Metric, Panel } from '../components/viz.tsx';
import { shortTime } from '../format.ts';
import { useApi } from '../use-api.ts';
import { useNow } from '../use-now.ts';
import { ActivityRow, activityPath, KIND_LABEL } from './overview.tsx';

// Looking back over a period: where the work went (a project × day heat map), what happened (milestones on a time
// line), and a written summary per project that can be copied out as Markdown.

const RANGES = [7, 14, 30, 90];
const GLYPH: Partial<Record<ActivityKind, string>> = { decision: '◆', todo_done: '✓', milestone_done: '✓', stage: '▲', merge: '▲', blocker_set: '!' };
const KINDS: ActivityKind[] = ['decision', 'todo_done', 'milestone_done', 'stage', 'blocker_set', 'blocker_cleared', 'project_created', 'merge'];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const weekday = (day: string) => '日一二三四五六'[new Date(`${day}T12:00:00`).getDay()];

function marksOf(p: ProjectActivity): number {
  return p.marks.reduce((n, m) => n + Object.values(m).reduce((x, y) => x + (y ?? 0), 0), 0);
}

/** Projects that did anything in the period, most work first; the rest only when asked. */
function ranked(a: ActivityView): ProjectActivity[] {
  return [...a.projects].filter((p) => p.totals.chunks > 0 || marksOf(p) > 0).sort((x, y) => y.totals.chunks - x.totals.chunks || marksOf(y) - marksOf(x));
}

function HeatRow({ label, href, values, marks, max, total, share, sub }: {
  label: string; href?: string; values: number[]; marks?: ProjectActivity['marks']; max: number; total: number; share: number; sub?: string;
}) {
  return (
    <div className="heat-row" role="row">
      <span className="heat-label" role="rowheader">
        {href ? <a href={href}>{label}</a> : label}
        {sub ? <span className="cell-sub">{sub}</span> : null}
      </span>
      {values.map((v, i) => {
        const m = marks?.[i] ?? {};
        const glyphs = (Object.keys(m) as ActivityKind[]).filter((k) => GLYPH[k]).map((k) => GLYPH[k]);
        const detail = (Object.entries(m) as Array<[ActivityKind, number]>).map(([k, n]) => `${KIND_LABEL[k]} ${n}`).join('，');
        return (
          <span key={i} role="cell" className={v === 0 ? 'heat-cell is-zero' : 'heat-cell'} style={{ '--v': v === 0 ? 0 : 0.18 + 0.82 * (v / max) } as React.CSSProperties} title={`${v} 段${detail ? `；${detail}` : ''}`}>
            {glyphs.length > 0 ? <span className="heat-glyph">{[...new Set(glyphs)].join('')}</span> : null}
          </span>
        );
      })}
      <span className="heat-total" role="cell">
        <span className="num">{total}</span>
        <span className="share"><i style={{ width: `${Math.round(share * 100)}%` }} /></span>
      </span>
    </div>
  );
}

function Heatmap({ a }: { a: ActivityView }) {
  const rows = ranked(a);
  const max = Math.max(1, ...rows.flatMap((p) => p.daily), ...a.unlinked_daily);
  const all = Math.max(1, sum(a.total_daily));
  const dense = a.days.length > 31;
  return (
    <div className="heat" role="table" aria-label="项目 × 日期 投入" style={{ '--days': a.days.length } as React.CSSProperties}>
      <div className="heat-row heat-head" role="row">
        <span className="heat-label" role="columnheader">项目</span>
        {a.days.map((d, i) => (
          <span key={d} className="heat-day" role="columnheader" title={d}>
            {dense ? (i % 7 === 0 ? d.slice(5) : '') : <>{d.slice(8)}<small>{weekday(d)}</small></>}
          </span>
        ))}
        <span className="heat-total" role="columnheader">合计</span>
      </div>
      {rows.map((p) => (
        <HeatRow key={p.id} label={p.title} href={projectHref(p.id)} values={p.daily} marks={p.marks} max={max} total={p.totals.chunks} share={p.totals.chunks / all} sub={`${p.priority ?? '—'} · ${STAGE_LABEL[p.stage]}`} />
      ))}
      {sum(a.unlinked_daily) > 0 ? <HeatRow label="未归属项目" values={a.unlinked_daily} max={max} total={sum(a.unlinked_daily)} share={sum(a.unlinked_daily) / all} sub="session 还没有关联项目" /> : null}
      {rows.length === 0 && sum(a.unlinked_daily) === 0 ? <p className="empty">这段时间没有收到对话内容。</p> : null}
      <p className="legend">颜色越深投入越多（按收到的对话段数）。◆ 决策 · ✓ 完成 · ▲ 阶段变化 · ! 新阻塞。一个 session 关联多个项目时各算一次。</p>
    </div>
  );
}

function MachineLoad({ a }: { a: ActivityView }) {
  const max = Math.max(1, ...a.machines.flatMap((m) => m.daily));
  const all = Math.max(1, sum(a.total_daily));
  return (
    <div className="heat heat-compact" role="table" aria-label="机器 × 日期 负载" style={{ '--days': a.days.length } as React.CSSProperties}>
      {a.machines.map((m) => <HeatRow key={m.machine} label={m.machine} values={m.daily} max={max} total={sum(m.daily)} share={sum(m.daily) / all} />)}
      {a.machines.length === 0 ? <p className="empty">没有数据。</p> : null}
    </div>
  );
}

function Timeline({ a, titles }: { a: ActivityView; titles: Map<string, string> }) {
  const now = useNow();
  const [kinds, setKinds] = useState<Set<ActivityKind>>(new Set(KINDS));
  const counts = Object.fromEntries(KINDS.map((k) => [k, a.items.filter((i) => i.kind === k).length])) as Record<ActivityKind, number>;
  const shown = a.items.filter((i) => kinds.has(i.kind));
  const byDay = new Map<string, ActivityItem[]>();
  for (const item of shown) {
    const day = a.days[item.day]!;
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  const toggle = (k: ActivityKind) => setKinds((cur) => {
    const next = new Set(cur);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  });
  return (
    <>
      <div className="chips" role="group" aria-label="事件类型">
        {KINDS.filter((k) => counts[k] > 0).map((k) => (
          <button key={k} type="button" className={`chip-toggle kind-${k}`} aria-pressed={kinds.has(k)} onClick={() => toggle(k)}>{`${KIND_LABEL[k]} ${counts[k]}`}</button>
        ))}
      </div>
      {shown.length === 0 ? <p className="empty">没有符合条件的事件。</p> : null}
      <ol className="day-groups">
        {[...byDay.entries()].map(([day, items]) => (
          <li key={day}>
            <h3 className="day-label"><span>{day}</span><span className="dim">{`周${weekday(day)} · ${items.length} 条`}</span></h3>
            <ul className="feed">{items.map((item) => <ActivityRow key={`${item.event_id}-${item.kind}-${item.text}`} item={item} titles={titles} now={now} />)}</ul>
          </li>
        ))}
      </ol>
    </>
  );
}

/** The period as Markdown: per project, what was done, decided, moved and blocked. */
export function summaryMarkdown(a: ActivityView, rangeDays: number): string {
  const lines = [`# 工作复盘 · ${a.days[0]} ~ ${a.days.at(-1)}（${rangeDays} 天）`, ''];
  const items = (p: ProjectActivity, ks: ActivityKind[]) => a.items.filter((i) => i.project_id === p.id && ks.includes(i.kind));
  const rows = ranked(a);
  lines.push(`- 收到对话 ${sum(a.total_daily)} 段，涉及 ${rows.length} 个项目；未归属项目 ${sum(a.unlinked_daily)} 段`);
  lines.push(`- 决策 ${a.items.filter((i) => i.kind === 'decision').length} 条，完成 ${a.items.filter((i) => i.kind === 'todo_done' || i.kind === 'milestone_done').length} 项，阶段变化 ${a.items.filter((i) => i.kind === 'stage' || i.kind === 'merge').length} 次`, '');
  for (const p of rows) {
    lines.push(`## ${p.title}（${p.priority ?? '未定'} · ${STAGE_LABEL[p.stage]}）`, `投入 ${p.totals.chunks} 段，${p.totals.sessions} 个 session`);
    const section = (title: string, ks: ActivityKind[]) => {
      const list = items(p, ks);
      if (list.length === 0) return;
      lines.push(`- ${title}：`);
      for (const i of [...list].reverse()) lines.push(`  - ${shortTime(i.at)} ${i.text}`);
    };
    section('完成', ['todo_done', 'milestone_done']);
    section('决策', ['decision']);
    section('阶段', ['stage', 'merge']);
    section('新阻塞', ['blocker_set']);
    section('解除阻塞', ['blocker_cleared']);
    lines.push('');
  }
  return lines.join('\n');
}

function Summaries({ a, rangeDays }: { a: ActivityView; rangeDays: number }) {
  const toast = useToast();
  const rows = ranked(a);
  const stalled = a.projects.filter((p) => !p.closed && (p.priority === 'P0' || p.priority === 'P1') && p.totals.chunks === 0 && marksOf(p) === 0);
  const pick = (p: ProjectActivity, ks: ActivityKind[]) => a.items.filter((i) => i.project_id === p.id && ks.includes(i.kind));
  const copy = async () => toast((await copyText(summaryMarkdown(a, rangeDays))) ? '已复制复盘总结（Markdown）' : '复制失败，浏览器不允许访问剪贴板');
  return (
    <Panel title="项目总结" meta={`${rows.length} 个项目有进展${stalled.length > 0 ? ` · ${stalled.length} 个高优先级项目停滞` : ''}`} actions={<button type="button" onClick={() => void copy()}>复制为 Markdown</button>} className="summaries">
      {stalled.length > 0 ? (
        <p className="callout is-warn">
          {'这段时间没有任何进展的高优先级项目：'}
          {stalled.map((p, i) => <span key={p.id}>{i > 0 ? '、' : ''}<a href={projectHref(p.id)}>{`${p.title}（${p.priority}）`}</a></span>)}
        </p>
      ) : null}
      <div className="summary-grid">
        {rows.map((p) => {
          const done = pick(p, ['todo_done', 'milestone_done']);
          const decisions = pick(p, ['decision']);
          const stages = pick(p, ['stage', 'merge']);
          const opened = pick(p, ['blocker_set']);
          return (
            <article key={p.id} className="summary-card" aria-label={p.title}>
              <header>
                <a href={projectHref(p.id)}><strong>{p.title}</strong></a>
                <span className="dim">{`${p.priority ?? '—'} · ${STAGE_LABEL[p.stage]}`}</span>
              </header>
              <dl className="summary-stats">
                <div><dt>投入</dt><dd className="num">{p.totals.chunks}</dd></div>
                <div><dt>完成</dt><dd className="num">{done.length}</dd></div>
                <div><dt>决策</dt><dd className="num">{decisions.length}</dd></div>
                <div><dt>阻塞 +/−</dt><dd className="num">{`${p.totals.blockers_opened}/${p.totals.blockers_cleared}`}</dd></div>
              </dl>
              {stages.length > 0 ? <p className="summary-line"><span className="tag">阶段</span><span>{stages.map((s) => s.text).reverse().join('；')}</span></p> : null}
              {done.length > 0 ? <ul className="summary-list">{done.slice(0, 4).map((i) => <li key={`${i.event_id}${i.text}`}><span className="ok-mark">✓</span><span className="summary-text">{i.text}</span></li>)}{done.length > 4 ? <li className="dim">{`…另 ${done.length - 4} 项`}</li> : null}</ul> : null}
              {decisions.length > 0 ? <ul className="summary-list">{decisions.slice(0, 2).map((i) => <li key={`${i.event_id}${i.text}`}><span className="dec-mark">◆</span><span className="summary-text">{i.text}</span></li>)}{decisions.length > 2 ? <li className="dim">{`…另 ${decisions.length - 2} 条决策`}</li> : null}</ul> : null}
              {opened.length > 0 ? <ul className="summary-list">{opened.slice(0, 2).map((i) => <li key={`${i.event_id}${i.text}`}><span className="bad-mark">!</span><span className="summary-text">{i.text}</span></li>)}{opened.length > 2 ? <li className="dim">{`…另 ${opened.length - 2} 个新阻塞`}</li> : null}</ul> : null}
              {done.length + decisions.length + stages.length + opened.length === 0 ? <p className="dim">只有对话，没有记录到决策、完成或阶段变化。</p> : null}
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

export function ReviewPage() {
  const [days, setDays] = useState(14);
  const activity = useApi<ActivityView>(activityPath(days), ['projects']);
  const a = activity.data;
  const titles = useMemo(() => new Map((a?.projects ?? []).map((p) => [p.id, p.title])), [a]);
  const count = (ks: ActivityKind[]) => (a?.items ?? []).filter((i) => ks.includes(i.kind)).length;
  return (
    <main data-page="review" className="console">
      <div className="page-head">
        <h2 className="page-title">复盘</h2>
        <div className="seg" role="group" aria-label="时间范围">
          {RANGES.map((r) => <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)}>{`${r} 天`}</button>)}
        </div>
      </div>
      {activity.error !== null ? (
        <div className="error-bar" role="alert"><span>{errorText(activity.error)}</span><button type="button" onClick={activity.reload}>重试</button></div>
      ) : null}
      {a === undefined ? <div className="dim">加载中…</div> : (
        <>
          <div className="metrics" role="group" aria-label="期间指标">
            <Metric label="对话段" value={sum(a.total_daily)} hint={`未归属 ${sum(a.unlinked_daily)}`} />
            <Metric label="有进展的项目" value={ranked(a).length} />
            <Metric label="决策" value={count(['decision'])} tone="accent" />
            <Metric label="完成" value={count(['todo_done', 'milestone_done'])} tone="ok" />
            <Metric label="阶段变化" value={count(['stage', 'merge'])} />
            <Metric label="阻塞 新增/解除" value={`${count(['blocker_set'])}/${count(['blocker_cleared'])}`} tone={count(['blocker_set']) > count(['blocker_cleared']) ? 'warn' : undefined} />
          </div>
          <div className="console-grid review-grid">
            <Panel title="投入分布" meta={`${a.days[0]} ~ ${a.days.at(-1)}`} className="span-all"><Heatmap a={a} /></Panel>
            <Panel title="机器负载" className="machines"><MachineLoad a={a} /></Panel>
            <Panel title="关键事件" meta={`${a.items.length} 条`} className="events"><Timeline a={a} titles={titles} /></Panel>
            <Summaries a={a} rangeDays={days} />
          </div>
        </>
      )}
    </main>
  );
}
