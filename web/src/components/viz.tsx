import type { CSSProperties, ReactNode } from 'react';
import { STAGE_LABEL } from '../../../src/shared/vocab.ts';
import type { Stage } from '../../../src/shared/vocab.ts';

// Small, quiet charts for the console pages. Each one answers one question and carries its numbers in its label, so
// what it shows can also be read without seeing it.

/** A line of daily values, its last day marked. `label` says what it counts. */
export function Sparkline({ values, label, width = 112, height = 22 }: { values: number[]; label: string; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (v: number) => height - 2 - (v / max) * (height - 4);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`${label}：共 ${total}，最近一天 ${values.at(-1) ?? 0}`}>
      {total === 0 ? (
        <line x1="0" x2={width} y1={height - 2} y2={height - 2} className="spark-empty" />
      ) : (
        <>
          <polygon points={`0,${height} ${points} ${width},${height}`} className="spark-area" />
          <polyline points={points} className="spark-line" />
          <circle cx={(values.length - 1) * step} cy={y(values.at(-1) ?? 0)} r="2" className="spark-dot" />
        </>
      )}
    </svg>
  );
}

/** Bars of daily values, with a second, highlighted part of each bar (`part`) when given. */
export function DayBars({ values, part, labels, label }: { values: number[]; part?: number[]; labels: string[]; label: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className="daybars" role="img" aria-label={`${label}：${labels.map((d, i) => `${d} ${values[i]}`).join('，')}`}>
      {values.map((v, i) => (
        <div key={labels[i]} className="daybar" title={`${labels[i]} · ${v}${part ? `（其中 ${part[i]}）` : ''}`}>
          <span className="daybar-fill" style={{ height: `${(v / max) * 100}%` } as CSSProperties}>
            {part && v > 0 ? <span className="daybar-part" style={{ height: `${(part[i]! / v) * 100}%` }} /> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

const FLOW: Stage[] = ['idea', 'explore', 'build', 'verify', 'done'];

/** Where a project is on idea → explore → build → verify → done; parked, abandoned and merged say so instead. */
export function StagePipeline({ stage }: { stage: Stage }) {
  const at = FLOW.indexOf(stage);
  if (at < 0) return <span className={`stage-off stage-${stage}`}>{STAGE_LABEL[stage]}</span>;
  return (
    <span className="pipeline" role="img" aria-label={`阶段：${STAGE_LABEL[stage]}`} title={STAGE_LABEL[stage]}>
      {FLOW.map((s, i) => (
        <i key={s} className={i < at ? 'past' : i === at ? 'now' : undefined} />
      ))}
      <span className="pipeline-label">{STAGE_LABEL[stage]}</span>
    </span>
  );
}

/** Done / doing / to do as one bar. */
export function ProgressBar({ done, doing, todo }: { done: number; doing: number; todo: number }) {
  const total = done + doing + todo;
  if (total === 0) return <span className="dim">—</span>;
  return (
    <span className="progress" role="img" aria-label={`里程碑 ${done}/${total} 完成，${doing} 进行中`}>
      <span className="progress-track">
        <i className="done" style={{ width: `${(done / total) * 100}%` }} />
        <i className="doing" style={{ width: `${(doing / total) * 100}%` }} />
      </span>
      <span className="num">{`${done}/${total}`}</span>
    </span>
  );
}

/** A titled panel of a console page. `actions` sit at the right end of its head. */
export function Panel({ title, meta, actions, className = '', children }: { title: string; meta?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`panel ${className}`} aria-label={title}>
      <header className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {meta ? <span className="panel-meta">{meta}</span> : null}
        {actions ? <span className="panel-actions">{actions}</span> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** One number of a KPI strip. `tone` colours it when it needs attention. */
export function Metric({ label, value, tone, href, hint }: { label: string; value: number | string; tone?: 'warn' | 'bad' | 'ok' | 'accent'; href?: string; hint?: string }) {
  const body = (
    <>
      <span className="metric-label">{label}</span>
      <span className="metric-value num">{value}</span>
      {hint ? <span className="metric-hint">{hint}</span> : null}
    </>
  );
  const className = `metric${tone ? ` is-${tone}` : ''}`;
  return href ? <a className={className} href={href}>{body}</a> : <div className={className}>{body}</div>;
}
