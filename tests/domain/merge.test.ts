import { afterEach, beforeEach, expect, test } from 'vitest';
import { mergePlan, mergeSignature, resolveMergeScope } from '../../src/domain/merge.ts';
import type { MergeScope } from '../../src/domain/merge.ts';
import { getProject } from '../../src/domain/read.ts';
import { NOW, setup } from './helpers.ts';
import type { Setup } from './helpers.ts';

let t: Setup;
const A = 'codex:aaaaaaaa';
const B = 'codex:bbbbbbbb';
const C = 'codex:cccccccc';
const DRAFT = { title: '统一的采集可靠性', summary: '为运维解决采集漏数', why: '看板依赖完整数据', done_criteria: '- 中文批次入库\n- 关窗尾部补读' };

beforeEach(() => {
  t = setup();
});
afterEach(() => t.db.close());

function session(key: string): void {
  t.db.prepare(
    `INSERT INTO sessions (key, agent_kind, machine, cwd, title, live_status, lifecycle, ignored, first_seen, last_seen)
     VALUES (?, 'codex', 'laptop', '/work', 'task', 'idle', 'live', 0, ?, ?)`,
  ).run(key, NOW, NOW);
}
function project(title: string, sessions: string[] = []): string {
  // Made by the curator, so no field is locked yet.
  const id = t.ai('create_project', { title, summary: `${title} 的旧简介` }).id;
  for (const key of sessions) t.user('link_session', { session: key, project: id, summary: `${key} 在 ${title}` });
  return id;
}
/** Stores a ready preview of `scope` as the preview service would. */
function preview(scope: MergeScope, draft = DRAFT): string {
  const id = t.deps.newId('mp');
  t.db.prepare(
    `INSERT INTO merge_previews (id, source_id, target_id, mode, session_keys, status, signature, draft, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
  ).run(id, scope.source, scope.target, scope.mode, JSON.stringify(scope.sessions), mergeSignature(t.db, scope), JSON.stringify(draft), NOW, NOW);
  return id;
}
const apply = (id: string, scope: MergeScope, overwrite: string[] = []) => t.user('apply_merge', { preview: id, ...scope, overwrite_locked: overwrite });
const linked = (id: string) => getProject(t.db, t.deps.now(), id)!.contributions.map((c) => c.session_key).sort();
const stage = (id: string) => getProject(t.db, t.deps.now(), id)!.stage;

beforeEach(() => {
  for (const key of [A, B, C]) session(key);
});

test('a partial merge moves only the chosen links and keeps the source project and its other sessions', () => {
  const source = project('来源', [A, B]);
  const target = project('目标', [C]);
  t.user('link_session', { session: A, project: project('旁观', []) });
  const scope = resolveMergeScope(t.db, source, target, [A]);
  expect(mergePlan(t.db, scope)).toEqual({
    links: [{ session: A, target: 'add', source: 'remove' }],
    source_stage: 'idea',
    source_merged: false,
    source_remaining_sessions: [B],
  });

  expect(apply(preview(scope), scope).status).toBe('applied');
  expect(linked(target)).toEqual([A, C]);
  expect(linked(source)).toEqual([B]);
  expect(stage(source)).toBe('idea');
  // The session's link to an unrelated project and the session itself are untouched.
  expect(t.db.prepare("SELECT count(*) AS n FROM contributions WHERE session_key = ? AND deleted_at IS NULL").get(A)).toEqual({ n: 2 });
  expect(getProject(t.db, t.deps.now(), target)).toMatchObject(DRAFT);
  expect(getProject(t.db, t.deps.now(), source)).toMatchObject({ title: '来源', summary: '来源 的旧简介' });
});

test('a whole-project merge links every source session to the target once and marks the source merged', () => {
  const source = project('来源', [A, B]);
  const target = project('目标', [B, C]);
  const scope = resolveMergeScope(t.db, source, target);
  expect(mergePlan(t.db, scope).links).toEqual([
    { session: A, target: 'add', source: 'keep' },
    { session: B, target: 'keep', source: 'keep' },
  ]);
  expect(apply(preview(scope), scope).status).toBe('applied');
  expect(linked(target)).toEqual([A, B, C]);
  expect(t.db.prepare('SELECT count(*) AS n FROM contributions WHERE project_id = ?').get(target)).toEqual({ n: 3 });
  expect(getProject(t.db, t.deps.now(), source)).toMatchObject({ stage: 'merged', merged_into: target });
});

test('merging through the stage operation alone also links the source sessions, except one the user took back from the target', () => {
  const source = project('来源', [A, B]);
  const target = project('目标', [B]);
  t.user('unlink_session', { session: B, project: target });
  expect(t.user('transition_stage', { project: source, stage: 'merged', merge_into: target }).status).toBe('applied');
  expect(linked(target)).toEqual([A]);
});

test('a preview shows a link the user took back as restored, and applying it restores it', () => {
  const source = project('来源', [A]);
  const target = project('目标', [A]);
  t.user('unlink_session', { session: A, project: target });
  const scope = resolveMergeScope(t.db, source, target);
  expect(mergePlan(t.db, scope).links).toEqual([{ session: A, target: 'restore_vetoed', source: 'keep' }]);
  expect(apply(preview(scope), scope).status).toBe('applied');
  expect(linked(target)).toEqual([A]);
});

test('a draft field left empty for want of evidence keeps what the target has', () => {
  const source = project('来源', [A]);
  const target = project('目标', []);
  t.ai('update_project', { project: target, fields: { why: '原有的原因' } });
  const scope = resolveMergeScope(t.db, source, target);
  expect(apply(preview(scope, { ...DRAFT, why: '', done_criteria: '' }), scope).status).toBe('applied');
  expect(getProject(t.db, t.deps.now(), target)).toMatchObject({ title: DRAFT.title, why: '原有的原因', done_criteria: null });
});

test('a preview is refused once a project, a link or session content changed, and nothing is written', () => {
  const changes: Array<(p: { source: string; target: string }) => void> = [
    (p) => t.user('update_project', { project: p.target, fields: { summary: '用户刚改过' } }),
    (p) => t.user('link_session', { session: B, project: p.target }),
    (p) => t.user('unlink_session', { session: A, project: p.source }),
    () => t.db.prepare("INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill) VALUES (?, 'transcript', 1, 2, ?, ?, 'new evidence', 0)").run(A, NOW, NOW),
    () => t.user('ignore_session', { session: C, ignored: true }),
  ];
  for (const change of changes) {
    t.db.close();
    t = setup();
    for (const key of [A, B, C]) session(key);
    const source = project('来源', [A, B]);
    const target = project('目标', [C]);
    const scope = resolveMergeScope(t.db, source, target, [A]);
    const id = preview(scope);
    change({ source, target });
    const before = t.db.prepare('SELECT count(*) AS n FROM events').get();
    expect(apply(id, scope)).toMatchObject({ status: 'rejected', code: 'stale' });
    expect(t.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual(before);
    expect(t.db.prepare('SELECT status FROM merge_previews WHERE id = ?').get(id)).toEqual({ status: 'ready' });
    expect(linked(target)).not.toContain(A);
  }
});

test('a preview applies once, and only with the scope it was built for', () => {
  const source = project('来源', [A, B]);
  const target = project('目标', []);
  const scope = resolveMergeScope(t.db, source, target, [A]);
  const id = preview(scope);
  expect(apply(id, { ...scope, sessions: [A, B] })).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(linked(target)).toEqual([]);
  expect(apply(id, scope).status).toBe('applied');
  expect(apply(id, scope)).toMatchObject({ status: 'rejected', code: 'not_pending' });
  expect(t.ai('apply_merge', { preview: id, ...scope })).toMatchObject({ status: 'rejected', code: 'user_only' });
});

test('a locked target field keeps the user text unless the overwrite is confirmed; written fields become locked', () => {
  const source = project('来源', [A]);
  const target = project('目标', []);
  t.user('update_project', { project: target, fields: { why: '用户写的原因' } });
  const scope = resolveMergeScope(t.db, source, target);
  expect(apply(preview(scope), scope).status).toBe('applied');
  const kept = getProject(t.db, t.deps.now(), target)!;
  expect(kept).toMatchObject({ title: DRAFT.title, why: '用户写的原因', done_criteria: DRAFT.done_criteria });
  expect(kept.locks).toEqual(expect.arrayContaining(['title', 'summary', 'why', 'done_criteria']));

  const second = project('第二来源', [B]);
  const again = resolveMergeScope(t.db, second, target);
  expect(apply(preview(again, { ...DRAFT, why: '确认后的原因' }), again, ['why']).status).toBe('applied');
  expect(getProject(t.db, t.deps.now(), target)!.why).toBe('确认后的原因');
});

test('undoing a merge restores the links, the source stage and the target text', () => {
  const source = project('来源', [A, B]);
  const target = project('目标', [C]);
  const partial = resolveMergeScope(t.db, source, target, [A]);
  const first = apply(preview(partial), partial);
  expect(t.user('revert_event', { event_id: first.event_id }).status).toBe('applied');
  expect(linked(source)).toEqual([A, B]);
  expect(linked(target)).toEqual([C]);
  expect(getProject(t.db, t.deps.now(), target)).toMatchObject({ title: '目标', summary: '目标 的旧简介' });
  // After the undo an AI may link the session to the source again: the tombstone is gone, not vetoed.
  expect(t.db.prepare('SELECT deleted_at, vetoed FROM contributions WHERE session_key = ? AND project_id = ?').get(A, source)).toEqual({ deleted_at: null, vetoed: 0 });

  const whole = resolveMergeScope(t.db, source, target);
  const second = apply(preview(whole), whole);
  expect(stage(source)).toBe('merged');
  expect(t.user('revert_event', { event_id: second.event_id }).status).toBe('applied');
  expect(stage(source)).toBe('idea');
  expect(linked(target)).toEqual([C]);
  expect(linked(source)).toEqual([A, B]);
});

test('the scope refuses sessions the source does not have, merged or deleted projects, and merging into itself', () => {
  const source = project('来源', [A]);
  const target = project('目标', []);
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  expect(code(() => resolveMergeScope(t.db, source, target, [B]))).toBe('invalid');
  expect(code(() => resolveMergeScope(t.db, source, target, []))).toBe('invalid');
  expect(code(() => resolveMergeScope(t.db, source, source))).toBe('invalid');
  expect(code(() => resolveMergeScope(t.db, 'p_missing', target))).toBe('not_found');
  t.user('transition_stage', { project: source, stage: 'merged', merge_into: target });
  expect(code(() => resolveMergeScope(t.db, source, target))).toBe('invalid');
});
