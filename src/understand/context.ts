import type { DatabaseSync } from 'node:sqlite';
import { sessionProjectName } from '../domain/project-names.ts';
import { sessionEffectiveStatus } from '../server/sources-repo.ts';
import { Workspace } from '../shared/workspace.ts';
import { neutralizeTags } from './digest.ts';

// One session's context for any background model call: what it is, where it runs, its status, the state of its
// repository on disk (as its collector last read it), and what it was doing in its earlier digests. Every call that
// judges a session (digesting, curating, reviewing blockers, deciding questions) gets the same picture, so a judgment
// rests on what the session and its files show now, not only on the window or digest in front of the model.

const STATUS: Record<string, string> = { working: '运行中', blocked: '等用户操作', idle: '空闲', done: '已完成', unknown: '未知', offline: '离线', ended: '已结束', purged: '已清除' };
/** Earlier digests of the session shown, newest last. */
export const EARLIER_DIGESTS = 3;

const clean = (text: string) => neutralizeTags(text.replace(/\s+/g, ' ').trim(), 'chunk', 'digest', 'session', 'evidence', 'project');

/** The repository state of a session as its collectors last reported it, newest report first; null when none did. */
export function sessionWorkspace(db: DatabaseSync, key: string): Workspace | null {
  const row = db.prepare('SELECT workspace FROM session_sources WHERE session_key = ? AND workspace IS NOT NULL ORDER BY last_seen DESC LIMIT 1').get(key) as { workspace: string } | undefined;
  if (!row) return null;
  try {
    const parsed = Workspace.safeParse(JSON.parse(row.workspace));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A workspace as lines a model reads at a glance. */
export function workspaceLines(w: Workspace): string[] {
  const sync = w.ahead === null ? '没有上游分支' : w.ahead === 0 && w.behind === 0 ? '与上游一致' : `领先上游 ${w.ahead} 个提交、落后 ${w.behind} 个`;
  return [
    `- 仓库：${clean(w.root)}，分支 ${clean(w.branch ?? '（游离 HEAD）')}，${sync}，${w.dirty === 0 ? '没有未提交的改动' : `${w.dirty} 个文件有未提交的改动`}（读取于 ${w.checked_at.slice(0, 16)}）`,
    ...(w.recent.length > 0 ? ['- 最近提交：', ...w.recent.map((c) => `  - ${c.sha} ${c.at.slice(0, 16)} ${clean(c.subject)}`)] : []),
  ];
}

/** What the session's latest digests before `before` (an ISO time; omitted: any) recorded as progress and decisions. */
function earlierWork(db: DatabaseSync, key: string, before?: string): string[] {
  const rows = db
    .prepare(
      `SELECT ts_end, json FROM digests WHERE session_key = ? AND json IS NOT NULL ${before ? 'AND ts_end <= ?' : ''} ORDER BY ts_end DESC, id DESC LIMIT ?`,
    )
    .all(...(before ? [key, before, EARLIER_DIGESTS] : [key, EARLIER_DIGESTS])) as Array<{ ts_end: string | null; json: string }>;
  const lines: string[] = [];
  for (const r of rows.reverse()) {
    try {
      const d = JSON.parse(r.json) as { progress?: Array<string | { text: string }>; decisions?: Array<{ text: string }>; topics?: Array<{ label: string }> };
      const parts = [
        ...(d.topics ?? []).map((t) => t.label),
        ...(d.progress ?? []).map(p => typeof p === 'string' ? p : p.text),
        ...(d.decisions ?? []).map((x) => `决定：${x.text}`),
      ].slice(0, 6);
      if (parts.length > 0) lines.push(`  - ${(r.ts_end ?? '').slice(0, 16)}：${clean(parts.join('；')).slice(0, 400)}`);
    } catch {
      // A digest that does not parse says nothing here.
    }
  }
  return lines.length > 0 ? ['- 之前在做：', ...lines] : [];
}

/**
 * The context block of session `key` (see the header). `before` limits the earlier digests to those up to that time
 * (the digester passes the start of its window); `earlier: false` leaves them out.
 */
export function sessionContext(db: DatabaseSync, key: string, now: Date, opts: { before?: string; earlier?: boolean } = {}): string {
  if (key.startsWith('report:')) return '- 来自 pm_report 上报（agent 主动上报）';
  const s = db.prepare('SELECT agent_kind, machine, cwd, title, last_seen FROM sessions WHERE key = ?').get(key) as
    | { agent_kind: string | null; machine: string | null; cwd: string | null; title: string | null; last_seen: string | null }
    | undefined;
  if (!s) return `- session：${key}（没有 session 记录）`;
  const name = sessionProjectName(db, key);
  const status = sessionEffectiveStatus(db, key, now);
  const workspace = sessionWorkspace(db, key);
  return [
    `- session：${clean(s.title ?? '') || key}（${key}）`,
    ...(name ? [`- 所在项目：${clean(name)}（Paseo 项目名或工作目录名）`] : []),
    `- agent：${clean(s.agent_kind ?? '?')}，机器：${clean(s.machine ?? '?')}，状态：${STATUS[status ?? ''] ?? status ?? '未知'}，最近活动：${(s.last_seen ?? '').slice(0, 16)}`,
    `- 工作目录：${clean(s.cwd ?? '') || '未知'}`,
    ...(workspace ? workspaceLines(workspace) : ['- 仓库：没有读到（不是 git 仓库，或采集器较旧）']),
    ...(opts.earlier === false ? [] : earlierWork(db, key, opts.before)),
  ].join('\n');
}

/** The context blocks of a project's linked sessions, most recently active first, at most `limit`. */
export function projectSessionsContext(db: DatabaseSync, projectId: string, now: Date, limit = 6): string {
  const keys = (db
    .prepare(
      `SELECT c.session_key AS key FROM contributions c LEFT JOIN sessions s ON s.key = c.session_key
       WHERE c.project_id = ? AND c.deleted_at IS NULL ORDER BY s.last_seen DESC LIMIT ?`,
    )
    .all(projectId, limit) as Array<{ key: string }>).map((r) => r.key);
  return keys.map((k) => sessionContext(db, k, now, { earlier: false })).join('\n\n') || '（没有关联的 session）';
}
