import { afterEach, beforeEach, expect, test } from 'vitest';
import { pickBlockerReview, runBlockerReview } from '../../src/understand/blocker-review.ts';
import type { LlmCall, LlmResult } from '../../src/understand/llm.ts';
import { Scheduler } from '../../src/understand/scheduler.ts';
import { setup } from '../domain/helpers.ts';
import type { Setup } from '../domain/helpers.ts';

let t: Setup;
const S = 'claude:aaaa1111';
let p: string;
let calls: LlmCall[];

beforeEach(() => {
  t = setup();
  t.setNow('2026-11-10T10:00:00.000Z');
  t.db.prepare(`INSERT INTO sessions (key, agent_kind, machine, cwd, title, live_status, lifecycle, ignored, first_seen, last_seen) VALUES (?, 'claude', 'm', '/w', 't', 'idle', 'live', 0, ?, ?)`).run(S, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
  p = t.user('create_project', { title: 'open-evo' }).id;
  t.user('link_session', { session: S, project: p });
  calls = [];
});
afterEach(() => t.db.close());

function blocker(text: string, kind = 'technical'): string {
  return t.ai('set_blocker', { project: p, text, kind }).id;
}
function digest(ts: string, progress: string): number {
  const json = JSON.stringify({ topics: [], decisions: [], progress: [progress], todos_added: [], todos_done: [], blockers: [], open_questions: [], trivial: false });
  return Number(t.db.prepare("INSERT INTO digests (session_key, chunk_ids, json, model, ts_start, ts_end, backfill, trivial, skipped, curated, created_at) VALUES (?, '[]', ?, 'm', ?, ?, 0, 0, 0, 1, ?)").run(S, json, ts, ts, ts).lastInsertRowid);
}
const answer = (verdicts: unknown[]) => async (call: LlmCall): Promise<LlmResult> => {
  calls.push(call);
  return { ok: true, text: '', structured: { verdicts }, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 }, costUsd: 0, durationMs: 1 };
};
const open = () => (t.db.prepare("SELECT id, kind FROM blockers WHERE status = 'open' ORDER BY rowid").all() as Array<{ id: string; kind: string }>);

test('verdicts are carried out by code: resolved and expired ones are cleared, a progress note becomes a todo, the rest stay', async () => {
  const fixed = blocker('DCR-09 返回旧结果');
  const quota = blocker('5 小时用量上限，19:00 重置', 'external');
  const note = blocker('第 5 波新代码尚未在 GPU 上运行');
  const real = blocker('需用户放行保留文件', 'technical');
  const dup = blocker('需用户放行那批保留文件', 'user');
  t.setNow('2026-11-12T10:00:00.000Z');
  const d = digest('2026-11-11T10:00:00.000Z', 'DCR-09 已修复并通过回归测试');
  const out = await runBlockerReview(t.db, t.deps, answer([
    { blocker_id: fixed, verdict: 'resolved', reason: '已修复', evidence: [`digest:${d}`] },
    { blocker_id: quota, verdict: 'expired', reason: '重置时间已过', evidence: [] },
    { blocker_id: note, verdict: 'todo', reason: '这是待验证事项', evidence: [], todo_title: '在 L40 上跑第 5 波冒烟' },
    { blocker_id: real, verdict: 'duplicate', reason: '与下一条相同', evidence: [] },
    { blocker_id: dup, verdict: 'keep', reason: '仍需用户放行', evidence: [] },
  ]), 'm', p);
  expect(out).toEqual({ ok: true, applied: { keep: 1, resolved: 1, expired: 1, duplicate: 1, todo: 1 } });
  expect(open()).toEqual([{ id: dup, kind: 'user' }]);
  expect(t.db.prepare("SELECT title, created_by FROM todos WHERE project_id = ?").all(p)).toEqual([{ title: '在 L40 上跑第 5 波冒烟', created_by: 'ai:curator' }]);
  const cleared = t.db.prepare("SELECT reason, evidence FROM events WHERE op = 'clear_blocker' ORDER BY id").all() as Array<{ reason: string; evidence: string }>;
  expect(cleared[0]).toMatchObject({ reason: '阻塞复核（resolved）：已修复', evidence: `["digest:${d}"]` });
  expect(JSON.parse(cleared[1]!.evidence)[0]).toMatch(/^event:\d+$/);
  expect(calls[0]!.prompt).toContain('DCR-09 已修复并通过回归测试');
  expect(calls[0]!.prompt).toContain('现在是 2026-11-12T10:00:00.000Z');
});

test('"resolved" without a digest that shows it is not acted on; a wrong kind is corrected', async () => {
  const b = blocker('等 GPU');
  const k = blocker('需要用户授权多卡训练');
  await runBlockerReview(t.db, t.deps, answer([
    { blocker_id: b, verdict: 'resolved', reason: '可能好了', evidence: ['digest:999'] },
    { blocker_id: k, verdict: 'keep', reason: '要用户批准', evidence: [], kind: 'user' },
  ]), 'm', p);
  expect(open()).toEqual([{ id: b, kind: 'technical' }, { id: k, kind: 'user' }]);
});

test('a project is reviewed again only after new digests arrive, and a failed call changes nothing', async () => {
  blocker('等 GPU');
  expect(pickBlockerReview(t.db, t.deps.now())).toBe(p);
  const failed = await runBlockerReview(t.db, t.deps, async () => ({ ok: false, kind: 'overloaded', message: 'busy', durationMs: 1 }), 'm', p);
  expect(failed).toMatchObject({ ok: false, kind: 'overloaded' });
  expect(pickBlockerReview(t.db, t.deps.now())).toBe(p);
  await runBlockerReview(t.db, t.deps, answer([]), 'm', p);
  expect(pickBlockerReview(t.db, t.deps.now())).toBeNull();
  t.setNow('2026-11-11T10:00:00.000Z');
  digest('2026-11-11T09:00:00.000Z', '新进展');
  expect(pickBlockerReview(t.db, t.deps.now())).toBe(p);
});

test('the scheduler reviews blockers when nothing more urgent is waiting', async () => {
  const b = blocker('5 小时用量上限', 'external');
  // The link made above queued a project review, which comes first; this test is about what runs after.
  t.db.prepare("UPDATE project_reviews SET status = 'done'").run();
  const scheduler = new Scheduler(t.db, t.deps, answer([{ blocker_id: b, verdict: 'expired', reason: '已过', evidence: [] }]), { digest: 'd', curate: 'c-model' });
  expect(await scheduler.tick()).toBe('curated');
  expect(calls[0]).toMatchObject({ role: 'curate', model: 'c-model' });
  expect(open()).toEqual([]);
});

test('evidence from other sessions that name the same thing is read, so work finished elsewhere clears the blocker', async () => {
  const b = blocker('git push origin master 被拦下，需用户推送 gx10-090e 的修复', 'user');
  t.db.prepare(`INSERT INTO sessions (key, agent_kind, machine, cwd, title, live_status, lifecycle, ignored, first_seen, last_seen) VALUES ('codex:other', 'codex', 'm', '/x', 'x', 'idle', 'live', 0, ?, ?)`).run('2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
  const json = JSON.stringify({ topics: [], decisions: [], progress: ['已执行 git push origin master，gx10-090e 修复已推送'], todos_added: [], todos_done: [], blockers: [], open_questions: [], trivial: false });
  const other = Number(t.db.prepare("INSERT INTO digests (session_key, chunk_ids, json, model, ts_start, ts_end, backfill, trivial, skipped, curated, created_at) VALUES ('codex:other', '[]', ?, 'm', ?, ?, 0, 0, 0, 1, ?)").run(json, '2026-11-11T00:00:00Z', '2026-11-11T00:00:00Z', '2026-11-11T00:00:00Z').lastInsertRowid);
  t.db.prepare("INSERT INTO ingest_sources (source_id, kind, machine, collector_version, collector_heartbeat) VALUES ('herdr:gx10-090e', 'herdr', 'gx10-090e', '0.1.0', '2026-11-07T08:15:45Z')").run();
  await runBlockerReview(t.db, t.deps, answer([{ blocker_id: b, verdict: 'resolved', reason: '另一个会话里已经推送', evidence: [`digest:${other}`] }]), 'm', p);
  expect(open()).toEqual([]);
  expect(calls[0]!.prompt).toContain('已执行 git push origin master');
  expect(calls[0]!.prompt).toContain('采集来源 herdr:gx10-090e：版本 0.1.0，最近心跳 2026-11-07T08:15:45Z');
});

test('a blocker that still waits on the user is kept as it is and asked about nowhere: it shows as a reminder', async () => {
  const action = blocker('需用户输入 sudo 密码运行降级脚本', 'user');
  await runBlockerReview(t.db, t.deps, answer([{ blocker_id: action, verdict: 'keep', reason: '没有证据显示已执行', evidence: [] }]), 'm', p);
  expect(open()).toEqual([{ id: action, kind: 'user' }]);
  expect(t.db.prepare('SELECT count(*) AS n FROM questions').get()).toEqual({ n: 0 });
  expect(calls[0]!.system).not.toContain('question');
});

test('every open blocker is looked at again after six hours even without new digests, and at once on a sync', async () => {
  blocker('等华硕售后', 'external');
  await runBlockerReview(t.db, t.deps, answer([]), 'm', p);
  expect(pickBlockerReview(t.db, t.deps.now())).toBeNull();
  t.setNow('2026-11-10T15:59:00.000Z');
  expect(pickBlockerReview(t.db, t.deps.now())).toBeNull();
  t.setNow('2026-11-10T16:01:00.000Z');
  expect(pickBlockerReview(t.db, t.deps.now())).toBe(p);
  await runBlockerReview(t.db, t.deps, answer([]), 'm', p);
  expect(pickBlockerReview(t.db, t.deps.now())).toBeNull();
  const { requestBlockerReviews } = await import('../../src/understand/blocker-review.ts');
  requestBlockerReviews(t.db);
  expect(pickBlockerReview(t.db, t.deps.now())).toBe(p);
});
