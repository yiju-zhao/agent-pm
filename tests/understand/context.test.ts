import { afterEach, beforeEach, expect, test } from 'vitest';
import { projectSessionsContext, sessionContext } from '../../src/understand/context.ts';
import { buildDigestPrompt, loadDigestContext, nextWindow } from '../../src/understand/digest.ts';
import { setup } from '../domain/helpers.ts';
import type { Setup } from '../domain/helpers.ts';

let t: Setup;
const S = 'claude:aaaa1111';
const WS = { root: '/work/agent-pm', branch: 'master', ahead: 4, behind: 0, dirty: 2, recent: [{ sha: 'cc5c33e', at: '2026-11-15T20:30:00Z', subject: 'feat: review open blockers' }], checked_at: '2026-11-15T20:40:00.000Z' };

beforeEach(() => {
  t = setup();
  t.setNow('2026-11-15T21:00:00.000Z');
  t.db.prepare(`INSERT INTO sessions (key, agent_kind, machine, cwd, title, live_status, lifecycle, ignored, first_seen, last_seen) VALUES (?, 'claude', 'mac-mini', '/work/agent-pm', '打磨采集', 'working', 'live', 0, ?, ?)`).run(S, '2026-11-15T00:00:00Z', '2026-11-15T20:59:00Z');
  t.db.prepare("INSERT INTO session_sources (source_id, external_id, session_key, project_name, lifecycle, last_seen, workspace) VALUES ('paseo-mini', 'a1', ?, 'agent-pm', 'live', ?, ?)").run(S, '2026-11-15T20:59:00Z', JSON.stringify(WS));
  const digest = (ts: string, progress: string) => t.db.prepare("INSERT INTO digests (session_key, chunk_ids, json, model, ts_start, ts_end, backfill, trivial, skipped, curated, created_at) VALUES (?, '[]', ?, 'm', ?, ?, 0, 0, 0, 1, ?)").run(S, JSON.stringify({ topics: [], decisions: [{ text: '只读对账', quote_ref: 'chunk:1' }], progress: [progress], todos_added: [], todos_done: [], blockers: [], open_questions: [], trivial: false }), ts, ts, ts);
  digest('2026-11-15T10:00:00Z', '修了字节预算');
  digest('2026-11-15T20:00:00Z', '加了阻塞复核');
});
afterEach(() => t.db.close());

test('a session’s context says what it is, its repository as read on disk, and what it was doing before', () => {
  const text = sessionContext(t.db, S, t.deps.now(), { before: '2026-11-15T12:00:00Z' });
  expect(text).toContain('- session：打磨采集（claude:aaaa1111）');
  expect(text).toContain('- 所在项目：agent-pm');
  expect(text).toContain('机器：mac-mini');
  expect(text).toContain('- 仓库：/work/agent-pm，分支 master，领先上游 4 个提交、落后 0 个，2 个文件有未提交的改动');
  expect(text).toContain('cc5c33e 2026-11-15T20:30 feat: review open blockers');
  expect(text).toContain('修了字节预算；决定：只读对账');
  expect(text).not.toContain('加了阻塞复核');
});

test('the digester and the project-level calls are given it', () => {
  t.db.prepare("INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill) VALUES (?, 'transcript', 1, 2, ?, ?, 'x', 0)").run(S, '2026-11-15T20:50:00Z', '2026-11-15T20:50:00Z');
  const w = nextWindow(t.db, S, 'realtime')!;
  const { prompt } = buildDigestPrompt(w, loadDigestContext(t.db, t.deps.now(), S, w.tsStart));
  expect(prompt).toContain('领先上游 4 个提交');
  expect(prompt).toContain('加了阻塞复核');
  const p = t.user('create_project', { title: 'agent-pm' }).id;
  t.user('link_session', { session: S, project: p });
  expect(projectSessionsContext(t.db, p, t.deps.now())).toContain('分支 master');
});
