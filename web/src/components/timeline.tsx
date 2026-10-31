import { useMemo } from 'react';
import type { ProjectDetail } from '../../../src/domain/read.ts';
import { shortTime, statusClass } from '../format.ts';
import { layoutTimeline } from '../timeline.ts';
import { Section } from './blocks.tsx';

/**
 * Which sessions took part in the project and when (spec 9.2): one bar per session on a common time axis, coloured
 * by what the session is doing now. A session that is still going on has a bar that reaches `now`.
 */
export function Timeline({ project, now }: { project: ProjectDetail; now: Date }) {
  const { contributions, created_at: createdAt } = project;
  const { bars, ticks } = useMemo(() => layoutTimeline(contributions, createdAt, now), [contributions, createdAt, now]);
  return (
    <Section title={`参与过的 session · ${contributions.length}`}>
      {bars.length === 0 ? (
        <p className="dim">还没有 session 参与这个项目</p>
      ) : (
        <div className="timeline">
          <div className="tl-axis" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick.pct} className="tl-tick" style={{ left: `${tick.pct}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
          <ul className="tl-rows">
            {bars.map((bar) => (
              <li key={bar.session_key} className="tl-row">
                <div
                  className={`tl-bar ${statusClass(bar.status)} st-${bar.status}`}
                  style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
                  title={`${bar.label}\n${shortTime(bar.start)} – ${shortTime(bar.end)}`}
                >
                  {bar.label}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
