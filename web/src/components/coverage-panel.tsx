import { useState } from 'react';
import type { SourceCoverage } from '../../../src/server/coverage.ts';
import { errorText } from '../api.ts';
import { relTime } from '../format.ts';
import { useApi } from '../use-api.ts';

const STATE_LABEL: Record<SourceCoverage['state'], string> = {
  never_reported: '已配置，但从未上报',
  offline: '采集器离线',
  daemon_down: 'daemon 未连接',
  ok: '在线',
};
const GAP_LABEL: Record<string, string> = {
  upstream_gap: '上游缺口',
  epoch_replaced: '时间线被替换',
  history_unavailable: '历史不可读',
  unverified_overlap: '重叠未核实',
};

/** The found sessions by what became of them, leaving out the empty groups. */
function breakdown(s: SourceCoverage): string {
  const parts = [['活跃', s.sessions.live], ['已结束', s.sessions.ended], ['原文已删', s.sessions.purged], ['未跟踪', s.sessions.untracked], ['你已忽略', s.sessions.ignored]] as const;
  const shown = parts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`);
  return shown.length === 0 ? '还没有发现 session' : `session：${shown.join(' · ')}`;
}

/** What is wrong or incomplete about one source, in words; empty when nothing is. */
function shortfalls(s: SourceCoverage): string[] {
  const c = s.content;
  const out: string[] = [];
  if (c.without_content > 0) out.push(`${c.without_content} 个 session 没有任何正文`);
  if (c.screen_only > 0) out.push(`${c.screen_only} 个只有屏幕快照`);
  if (c.unloaded > 0) out.push(`${c.unloaded} 个未加载（只有元数据）`);
  if (c.catching_up > 0) out.push(`${c.catching_up} 个仍在补采`);
  if (c.paused > 0) out.push(`${c.paused} 个因积压暂停`);
  if (c.error > 0) out.push(`${c.error} 个读取出错`);
  for (const [reason, n] of Object.entries(s.gaps)) out.push(`${GAP_LABEL[reason] ?? reason} ${n} 处`);
  if (c.refused_chunks > 0) out.push(`${c.refused_chunks} 段被上游拒摘，原文保留`);
  if (c.truncated_chunks > 0) out.push(`${c.truncated_chunks}/${c.chunks} 段有消息在采集时被截断（被截掉的部分中心没有）`);
  if (s.backlog !== null && s.backlog.outbox_batches > 0) out.push(`采集器还有 ${s.backlog.outbox_batches} 批未送达`);
  if (s.last_error) out.push(`最近错误：${s.last_error}`);
  return out;
}

/**
 * Per source: whether it reports at all, how many sessions it found, how many of those have content, and what is
 * known to be missing. Read only when opened. "Online" and "found" are shown apart from "content arrived" on purpose.
 */
export function CoveragePanel({ now }: { now: Date }) {
  const [open, setOpen] = useState(false);
  const { data, error, reload } = useApi<SourceCoverage[]>(open ? '/coverage' : null, ['sessions'], { auth: true });
  const attention = (data ?? []).filter((s) => s.state !== 'ok' || shortfalls(s).length > 0).length;
  return (
    <details className="coverage" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="coverage-title">采集覆盖核验</span>
        <span className="dim">{data === undefined ? '每个来源实际收到了什么、缺什么' : `${data.length} 个来源 · ${attention === 0 ? '未发现已知缺口' : `${attention} 个需要关注`}`}</span>
      </summary>
      {error !== null ? (
        <div className="error-bar" role="alert">
          <span>{errorText(error)}</span>
          <button type="button" onClick={reload}>重试</button>
        </div>
      ) : null}
      {data === undefined ? (error === null && open ? <div className="dim">加载中…</div> : null) : (
        <>
          <p className="dim">这里统计的是已经到达中心的内容。采集器从未见过的 session 无法计数，见每个来源下的「采集不到的范围」。</p>
          <ul className="coverage-list">
            {data.map((s) => {
              const issues = shortfalls(s);
              const tone = s.state === 'never_reported' || s.state === 'offline' ? 'bad' : s.state !== 'ok' || issues.length > 0 ? 'warn' : 'ok';
              return (
                <li key={s.source_id} aria-label={s.source_id} className={`coverage-card is-${tone}`}>
                  <div className="coverage-head">
                    <span className="coverage-dot" aria-hidden="true" />
                    <strong>{s.source_id}</strong>
                    <span className="tag">{`${s.kind === 'paseo' ? 'Paseo' : 'herdr'} · ${s.machine}`}</span>
                    <span className="coverage-state">{STATE_LABEL[s.state]}</span>
                    {s.collector_heartbeat ? <span className="dim">{`最近心跳 ${relTime(s.collector_heartbeat, now)}`}</span> : null}
                  </div>
                  <dl className="coverage-stats">
                    <div><dt>发现</dt><dd>{s.sessions.total}</dd></div>
                    <div><dt>有正文</dt><dd>{s.content.with_content}</dd></div>
                    <div><dt>正文段</dt><dd>{s.content.chunks}</dd></div>
                    <div><dt>待摘要</dt><dd>{s.content.undigested_chunks}</dd></div>
                  </dl>
                  <div className="dim">{breakdown(s)}</div>
                  {issues.length > 0 ? (
                    <ul className="coverage-issues" aria-label="缺口">
                      {issues.map((issue) => <li key={issue}>{issue}</li>)}
                    </ul>
                  ) : s.state === 'never_reported' ? null : <div className="coverage-fine">未发现已知缺口</div>}
                  {s.content.tool_cut_chunks + s.content.excerpted_chunks > 0 ? <div className="dim">{`按设计的缩减：${s.content.tool_cut_chunks} 段只截了工具内容${s.content.excerpted_chunks > 0 ? `，${s.content.excerpted_chunks} 段是较长事件的节选（中心保留更完整的事件副本）` : ''}`}</div> : null}
                  <details>
                    <summary className="dim">采集不到的范围</summary>
                    <ul>{s.limits.map((l) => <li key={l}>{l}</li>)}</ul>
                  </details>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </details>
  );
}
