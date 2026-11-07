import type { SourceView } from '../../../src/server/sources-repo.ts';
import type { EvidenceSource } from '../../../src/domain/evidence.ts';

const KIND_LABEL: Record<string, string> = { herdr: 'herdr', paseo: 'Paseo' };

const CONTENT_LABEL: Record<string, string> = {
  catching_up: '采集中',
  unloaded: '未加载，暂不读取',
  error: '读取出错',
  paused: '积压暂停',
};

/** Why one source's observation is not plain "fresh and current", in words; `null` when it is. */
export function sourceNote(s: SourceView): string | null {
  const notes: string[] = [];
  if (s.lifecycle === 'ended') notes.push(s.end_reason === 'archived' ? '已归档' : '已结束');
  else if (s.lifecycle === 'purged') notes.push('原文已删除');
  else if (s.lifecycle === 'untracked') notes.push('未跟踪');
  else if (!s.collector_alive) notes.push('采集器离线');
  else if (s.kind === 'paseo' && s.daemon_status !== 'connected') notes.push(s.daemon_status === 'identity_mismatch' ? 'daemon 身份不符' : 'daemon 断开');
  else if (!s.fresh) notes.push('观察过期');
  if (s.content_state !== null && CONTENT_LABEL[s.content_state]) notes.push(CONTENT_LABEL[s.content_state]!);
  if (s.gaps > 0) notes.push(`${s.gaps} 处缺口`);
  if (s.identity_note) notes.push('身份待核对');
  return notes.length === 0 ? null : notes.join('，');
}

/** One small tag per source of a session: which collector sees it, whether its content feeds the analysis, and lag. */
export function SourceBadges({ sources }: { sources: SourceView[] }) {
  if (sources.length === 0) return null;
  return (
    <>
      {sources.map((s) => {
        const note = sourceNote(s);
        const role = s.content_role === 'owner' ? '主内容' : s.content_role === 'standby' ? '备用' : null;
        const label = [KIND_LABEL[s.kind] ?? s.kind, role].filter(Boolean).join(' · ');
        const title = [`${s.source_id}（${s.machine ?? '?'}）`, s.kind === 'paseo' ? `agent ${s.external_id}` : null, note, s.identity_note].filter(Boolean).join('\n');
        return (
          <span key={`${s.source_id}:${s.external_id}`} className={note === null ? 'tag source' : 'tag source warn'} title={title}>
            {note === null ? label : `${label}（${note}）`}
          </span>
        );
      })}
    </>
  );
}

/** Where a chunk of evidence came from, in one line; `null` for chunks that predate sources. */
export function evidenceSourceLine(s: EvidenceSource | null): string | null {
  if (s === null) return null;
  if (s.kind === 'herdr') return `来源 ${s.source_id}`;
  const parts = [`来源 ${s.source_id}`, s.agent_id ? `agent ${s.agent_id}` : null, s.seq_start !== null ? `seq ${s.seq_start}–${s.seq_end}` : null, `${s.events} 条`];
  if (s.truncated_upstream) parts.push('采集时已截断');
  if (s.ts_unknown) parts.push('部分时间未知');
  return parts.filter(Boolean).join(' · ');
}
