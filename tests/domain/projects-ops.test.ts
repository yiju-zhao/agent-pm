import { afterEach, beforeEach, expect, test } from 'vitest';
import { execute, HANDLERS } from '../../src/domain/execute.ts';
import { MAX_PENDING_AI_QUESTIONS } from '../../src/domain/questions.ts';
import type { OpName } from '../../src/domain/ops.ts';
import { count, eventsFor, lastEvent, NOW, row, setup } from './helpers.ts';
import type { Row, Setup } from './helpers.ts';

let t: Setup;

beforeEach(() => {
  t = setup();
});

afterEach(() => {
  t.db.close();
});

const project = (id: string): Row => row(t.db, 'projects', id);
const question = (id: string): Row => row(t.db, 'questions', id);
const locks = (id: string): string[] => JSON.parse(project(id).locks as string);
const events = (id: string): Row[] => eventsFor(t.db, id);

/** A project the AI created, so none of its fields are locked. */
function aiProject(title = 'AI 项目'): string {
  return t.ai('create_project', { title }).id;
}

function userProject(title = '用户项目'): string {
  return t.user('create_project', { title }).id;
}

function markDeleted(id: string): void {
  t.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(NOW, id);
}

// ---- envelope ----------------------------------------------------------------------------------------------------

test('every applied op writes exactly one event in the same transaction', () => {
  const r = t.user('create_project', { title: 'dLLM 评测' });
  expect(r).toMatchObject({ status: 'applied', id: 'p_1', question_ids: [], warnings: [] });
  expect(events('p_1')).toHaveLength(1);
  expect(events('p_1')[0]).toMatchObject({
    id: r.event_id,
    actor: 'user',
    op: 'create_project',
    entity: 'projects:p_1',
    project_id: 'p_1',
    reason: null,
    evidence: '[]',
    question_id: null,
    is_veto: 0,
  });
  expect(JSON.parse(events('p_1')[0].args as string)).toEqual({ title: 'dLLM 评测' });
});

test('ai write without reason or evidence is rejected and writes nothing', () => {
  expect(t.ai('create_project', { title: 'x' }, { reason: '' })).toMatchObject({ status: 'rejected', code: 'missing_reason' });
  expect(t.ai('create_project', { title: 'x' }, { reason: '   ' })).toMatchObject({ code: 'missing_reason' });
  expect(t.ai('create_project', { title: 'x' }, { evidence: ['see chat'] })).toMatchObject({ code: 'missing_evidence' });
  expect(t.ai('create_project', { title: 'x' }, { evidence: [] })).toMatchObject({ code: 'missing_evidence' });
  expect(t.ai('create_project', { title: 'x' }, { evidence: ['chunk:1', 'chunk 2'] })).toMatchObject({ code: 'missing_evidence' });
  expect(execute(t.db, t.deps, { op: 'create_project', args: { title: 'x' }, actor: 'ai:curator' })).toMatchObject({
    code: 'missing_reason',
  });
  expect(count(t.db, 'projects')).toBe(0);
  expect(count(t.db, 'events')).toBe(0);
});

test('ai reason and evidence are stored on the event', () => {
  t.ai('create_project', { title: 'x' }, { reason: '对话里提到', evidence: ['chunk:12#L40', 'digest:7'] });
  expect(lastEvent(t.db)).toMatchObject({ actor: 'ai:curator', reason: '对话里提到', evidence: '["chunk:12#L40","digest:7"]' });
});

test('bad args are invalid and the message names the path', () => {
  const p = userProject();
  const r = t.user('update_project', { project: p, fields: { title: '' } });
  expect(r).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(r.message).toContain('fields.title');
  expect(t.user('update_project', { project: p, fields: {} })).toMatchObject({ code: 'invalid' });
  expect(t.user('create_project', { title: 'x', extra: 1 })).toMatchObject({ code: 'invalid' });
  expect(t.user('no_such_op' as OpName, {})).toMatchObject({ code: 'invalid' });
});

test('an op without a registered handler is invalid', () => {
  const handler = HANDLERS.create_project;
  delete HANDLERS.create_project;
  try {
    expect(t.user('create_project', { title: 'x' })).toMatchObject({ code: 'invalid' });
  } finally {
    HANDLERS.create_project = handler;
  }
});

test('ai may not unlock fields or revert events', () => {
  const p = userProject();
  expect(t.ai('unlock_field', { table: 'projects', id: p, field: 'title' })).toMatchObject({ code: 'user_only' });
  expect(t.ai('revert_event', { event_id: 1 })).toMatchObject({ code: 'user_only' });
  expect(locks(p)).toEqual(['title']);
});

test('occurred_at defaults to now and can be supplied; recorded_at is always now', () => {
  t.user('create_project', { title: 'a' });
  expect(lastEvent(t.db)).toMatchObject({ occurred_at: NOW, recorded_at: NOW });

  t.setNow('2026-10-29T13:00:00.000Z');
  execute(t.db, t.deps, { op: 'create_project', args: { title: 'b' }, actor: 'user', occurred_at: '2026-10-28T09:30:00Z' });
  expect(lastEvent(t.db)).toMatchObject({ occurred_at: '2026-10-28T09:30:00.000Z', recorded_at: '2026-10-29T13:00:00.000Z' });
  expect(project('p_2').created_at).toBe('2026-10-29T13:00:00.000Z');

  expect(
    execute(t.db, t.deps, { op: 'create_project', args: { title: 'c' }, actor: 'user', occurred_at: 'yesterday' }),
  ).toMatchObject({ code: 'invalid' });
});

test('question_id from the input is recorded on the event', () => {
  execute(t.db, t.deps, { op: 'create_project', args: { title: 'a' }, actor: 'user', question_id: 'q_9' });
  expect(lastEvent(t.db).question_id).toBe('q_9');
});

test('an op that changes nothing is applied without an event', () => {
  const p = userProject();
  const r = t.user('update_project', { project: p, fields: { title: '用户项目' } });
  expect(r).toMatchObject({ status: 'applied', event_id: null, question_ids: [] });
  expect(events(p)).toHaveLength(1);
});

// ---- create_project ----------------------------------------------------------------------------------------------

test('user create defaults to idea, marks user_touched and locks the given fields', () => {
  const p = t.user('create_project', { title: '  标题  ', summary: '摘要', priority: null }).id;
  expect(project(p)).toMatchObject({
    title: '标题',
    summary: '摘要',
    priority: null,
    stage: 'idea',
    created_by: 'user',
    user_touched: 1,
    created_at: NOW,
    deleted_at: null,
    vetoed: 0,
  });
  expect(locks(p)).toEqual(['priority', 'summary', 'title']);
});

test('ai create records the ai as creator and locks nothing', () => {
  const p = t.ai('create_project', { title: 'x', summary: 's', priority: 'P2' }).id;
  expect(project(p)).toMatchObject({ stage: 'idea', created_by: 'ai:curator', user_touched: 0, priority: 'P2' });
  expect(locks(p)).toEqual([]);
});

test('ai can only create projects in idea', () => {
  expect(t.ai('create_project', { title: 'x', stage: 'build' })).toMatchObject({ code: 'not_allowed' });
  expect(count(t.db, 'projects')).toBe(0);
  expect(t.ai('create_project', { title: 'x', stage: 'idea' })).toMatchObject({ status: 'applied' });
});

test('the user may create a project in any stage except merged', () => {
  expect(project(t.user('create_project', { title: 'x', stage: 'build' }).id).stage).toBe('build');
  expect(t.user('create_project', { title: 'y', stage: 'merged' })).toMatchObject({ code: 'invalid' });
});

// ---- update_project ----------------------------------------------------------------------------------------------

test('user edit writes and locks the fields', () => {
  const p = aiProject();
  const r = t.user('update_project', { project: p, fields: { title: '新标题', why: '因为' } });
  expect(r).toMatchObject({ status: 'applied', event_id: expect.any(Number) });
  expect(project(p)).toMatchObject({ title: '新标题', why: '因为' });
  expect(locks(p)).toEqual(['title', 'why']);
  expect(lastEvent(t.db)).toMatchObject({ project_id: p, op: 'update_project' });
});

test('user edit locks a field even when the value is unchanged', () => {
  const p = aiProject('同名');
  t.user('update_project', { project: p, fields: { title: '同名' } });
  expect(locks(p)).toEqual(['title']);
});

test('ai edit of unlocked fields applies directly and locks nothing', () => {
  const p = aiProject();
  expect(t.ai('update_project', { project: p, fields: { summary: '摘要', priority: 'P1' } })).toMatchObject({
    status: 'applied',
    question_ids: [],
  });
  expect(project(p)).toMatchObject({ summary: '摘要', priority: 'P1', user_touched: 0 });
  expect(locks(p)).toEqual([]);
});

test('user edit locks the field; ai update of a locked field becomes a confirm question, unlocked fields still apply', () => {
  const p = aiProject();
  t.user('update_project', { project: p, fields: { title: '用户标题' } });
  const r = t.ai('update_project', { project: p, fields: { title: 'AI 标题', summary: '新摘要' } });
  expect(r).toMatchObject({ status: 'applied', question_ids: [expect.any(String)] });
  expect(project(p)).toMatchObject({ title: '用户标题', summary: '新摘要' });
  const q = question(r.question_ids[0]);
  expect(q.prompt).toBe('AI 想修改你锁定的字段（title）：r');
  expect(q).toMatchObject({
    kind: 'confirm',
    status: 'pending',
    project_id: p,
    created_by: 'ai:curator',
    dedupe_key: `update:projects:${p}:title`,
    evidence: '["chunk:1"]',
  });
  expect(JSON.parse(q.guards as string)).toEqual([{ table: 'projects', id: p, col: 'title', equals: '用户标题' }]);
  expect(JSON.parse(q.options as string)).toEqual([
    { label: '确认', op: 'update_project', args: { project: p, fields: { title: 'AI 标题' } } },
    { label: '拒绝', op: null },
  ]);
});

test('ai update of only locked fields is proposed as one question with the fields sorted', () => {
  const p = userProject();
  t.user('update_project', { project: p, fields: { summary: 's', priority: 'P1' } });
  const r = t.ai('update_project', { project: p, fields: { title: 't', summary: 'AI', priority: 'P0' } }, { reason: '优先级变了' });
  expect(r).toMatchObject({ status: 'proposed', question_ids: [expect.any(String)] });
  const q = question(r.question_ids[0]);
  expect(q.prompt).toBe('AI 想修改你锁定的字段（priority、summary、title）：优先级变了');
  expect(q.dedupe_key).toBe(`update:projects:${p}:priority,summary,title`);
  expect(JSON.parse(q.guards as string)).toHaveLength(3);
  expect(events(p)).toHaveLength(2);
});

test('ai proposing a locked field value it already has asks nothing', () => {
  const p = userProject('同名');
  expect(t.ai('update_project', { project: p, fields: { title: '同名' } })).toMatchObject({
    status: 'applied',
    event_id: null,
    question_ids: [],
  });
  expect(count(t.db, 'questions')).toBe(0);
});

test('the same ai proposal twice reuses the pending question', () => {
  const p = userProject();
  const first = t.ai('update_project', { project: p, fields: { title: 'A' } });
  const second = t.ai('update_project', { project: p, fields: { title: 'A' } }, { evidence: ['chunk:2'] });
  expect(second).toMatchObject({ status: 'proposed', question_ids: first.question_ids });
  expect(question(first.question_ids[0]).evidence).toBe('["chunk:1","chunk:2"]');
});

test('a user edit withdraws a pending ai proposal whose guard no longer holds', () => {
  const p = userProject();
  const q = t.ai('update_project', { project: p, fields: { title: 'AI 标题' } }).question_ids[0];
  t.user('update_project', { project: p, fields: { summary: '无关' } });
  expect(question(q).status).toBe('pending');
  t.user('update_project', { project: p, fields: { title: '用户又改了' } });
  expect(question(q)).toMatchObject({ status: 'withdrawn', resolution_note: 'stale' });
});

test('a failed proposal becomes a warning when other changes applied', () => {
  const p = userProject();
  const fill = t.db.prepare(
    "INSERT INTO questions (id, kind, prompt, options, status, evidence, guards, dedupe_key, created_by, created_at) VALUES (?, 'confirm', 'x', '[]', 'pending', '[]', '[]', ?, 'ai:other', ?)",
  );
  for (let i = 0; i < MAX_PENDING_AI_QUESTIONS; i++) fill.run(`fill_${i}`, `fill-${i}`, NOW);

  const r = t.ai('update_project', { project: p, fields: { title: 'AI 标题', summary: '新摘要' } });
  expect(r).toMatchObject({ status: 'applied', question_ids: [], warnings: [expect.stringMatching(/^question_limit: /)] });
  expect(project(p).summary).toBe('新摘要');
});

test('a failed proposal with nothing else to do is rejected with its code', () => {
  const p = userProject();
  t.db
    .prepare(
      "INSERT INTO questions (id, kind, prompt, options, status, evidence, guards, dedupe_key, rejected, created_by, created_at, resolved_at) VALUES ('q_old', 'confirm', 'x', '[]', 'answered', '[]', '[]', ?, 1, 'ai:curator', ?, ?)",
    )
    .run(`update:projects:${p}:title`, NOW, NOW);
  expect(t.ai('update_project', { project: p, fields: { title: 'AI 标题' } })).toMatchObject({
    status: 'rejected',
    code: 'recently_rejected',
  });
});

test('updating a missing or deleted project is not_found', () => {
  expect(t.user('update_project', { project: 'p_404', fields: { title: 'x' } })).toMatchObject({ code: 'not_found' });
  const p = userProject();
  markDeleted(p);
  expect(t.user('update_project', { project: p, fields: { title: 'x' } })).toMatchObject({ code: 'not_found' });
  expect(t.ai('update_project', { project: p, fields: { title: 'x' } })).toMatchObject({ code: 'not_found' });
});

// ---- transition_stage --------------------------------------------------------------------------------------------

test('ai stepping forward applies; ai completing, abandoning, parking or going back is proposed', () => {
  const p = aiProject();
  expect(t.ai('transition_stage', { project: p, stage: 'explore' })).toMatchObject({ status: 'applied' });
  for (const stage of ['done', 'abandoned', 'parked', 'idea', 'verify']) {
    expect(t.ai('transition_stage', { project: p, stage })).toMatchObject({ status: 'proposed' });
  }
  expect(project(p).stage).toBe('explore');
});

test('an ai stage proposal names the stages and guards the current stage', () => {
  const p = aiProject('dLLM 评测');
  const r = t.ai('transition_stage', { project: p, stage: 'done' }, { reason: '评测跑完了' });
  const q = question(r.question_ids[0]);
  expect(q.prompt).toBe('AI 建议把「dLLM 评测」从idea转到完成：评测跑完了');
  expect(q.dedupe_key).toBe(`stage:${p}:done`);
  expect(JSON.parse(q.guards as string)).toEqual([{ table: 'projects', id: p, col: 'stage', equals: 'idea' }]);
  expect(JSON.parse(q.options as string)[0]).toEqual({ label: '确认', op: 'transition_stage', args: { project: p, stage: 'done' } });
});

test('an ai merge proposal names the target', () => {
  const a = aiProject('A 项目');
  const b = aiProject('B 项目');
  const r = t.ai('transition_stage', { project: a, stage: 'merged', merge_into: b });
  expect(r).toMatchObject({ status: 'proposed' });
  const q = question(r.question_ids[0]);
  expect(q.prompt).toBe('AI 建议把「A 项目」从idea合并到「B 项目」：r');
  expect(JSON.parse(q.options as string)[0].args).toEqual({ project: a, stage: 'merged', merge_into: b });
  expect(project(a).stage).toBe('idea');
});

test('ai cannot resume a parked project or reopen a closed one', () => {
  const p = aiProject();
  t.user('transition_stage', { project: p, stage: 'parked' });
  expect(t.ai('transition_stage', { project: p, stage: 'idea' })).toMatchObject({ status: 'proposed' });
  t.user('transition_stage', { project: p, stage: 'done' });
  expect(t.ai('transition_stage', { project: p, stage: 'verify' })).toMatchObject({ status: 'proposed' });
  expect(project(p).stage).toBe('done');
});

test('a transition to the current stage is invalid', () => {
  const p = userProject();
  expect(t.user('transition_stage', { project: p, stage: 'idea' })).toMatchObject({ code: 'invalid' });
});

test('parking remembers the previous stage and unparking clears it', () => {
  const p = userProject();
  t.user('transition_stage', { project: p, stage: 'build' });
  t.user('transition_stage', { project: p, stage: 'parked' });
  expect(project(p)).toMatchObject({ stage: 'parked', stage_before_park: 'build' });
  t.user('transition_stage', { project: p, stage: 'build' });
  expect(project(p)).toMatchObject({ stage: 'build', stage_before_park: null });
});

test('merge sets merged_into; ai writes to a merged project are rejected with the target', () => {
  const a = userProject('A');
  const b = userProject('B');
  t.user('transition_stage', { project: a, stage: 'merged', merge_into: b });
  expect(project(a)).toMatchObject({ stage: 'merged', merged_into: b });
  expect(t.ai('update_project', { project: a, fields: { summary: 'x' } })).toMatchObject({
    code: 'merged',
    message: expect.stringContaining(b),
  });
  expect(t.ai('transition_stage', { project: a, stage: 'idea' })).toMatchObject({ code: 'merged' });
});

test('the user can still edit a merged project, and unmerging clears merged_into', () => {
  const a = userProject('A');
  const b = userProject('B');
  t.user('transition_stage', { project: a, stage: 'merged', merge_into: b });
  expect(t.user('update_project', { project: a, fields: { summary: 'x' } })).toMatchObject({ status: 'applied' });
  t.user('transition_stage', { project: a, stage: 'explore' });
  expect(project(a)).toMatchObject({ stage: 'explore', merged_into: null });
});

test('merge into self, a missing, a deleted or a merged project is invalid', () => {
  const a = userProject('A');
  const b = userProject('B');
  const c = userProject('C');
  const d = userProject('D');
  markDeleted(c);
  t.user('transition_stage', { project: d, stage: 'merged', merge_into: b });
  for (const target of [a, 'p_404', c, d]) {
    expect(t.user('transition_stage', { project: a, stage: 'merged', merge_into: target })).toMatchObject({ code: 'invalid' });
  }
  expect(t.user('transition_stage', { project: a, stage: 'merged' })).toMatchObject({ code: 'invalid' });
  expect(t.user('transition_stage', { project: a, stage: 'done', merge_into: b })).toMatchObject({ code: 'invalid' });
  expect(project(a)).toMatchObject({ stage: 'idea', merged_into: null });
});

test('user setting priority or stage marks the project user_touched', () => {
  const p = aiProject();
  t.user('update_project', { project: p, fields: { title: '改标题' } });
  expect(project(p).user_touched).toBe(0);
  t.user('update_project', { project: p, fields: { priority: 'P0' } });
  expect(project(p).user_touched).toBe(1);

  const q = aiProject();
  t.ai('transition_stage', { project: q, stage: 'explore' });
  expect(project(q).user_touched).toBe(0);
  t.user('transition_stage', { project: q, stage: 'build' });
  expect(project(q).user_touched).toBe(1);
});

// ---- unlock_field ------------------------------------------------------------------------------------------------

test('user unlock removes the lock so the ai may edit the field again', () => {
  const p = userProject();
  t.user('update_project', { project: p, fields: { summary: 's' } });
  expect(t.user('unlock_field', { table: 'projects', id: p, field: 'title' })).toMatchObject({
    status: 'applied',
    event_id: expect.any(Number),
  });
  expect(locks(p)).toEqual(['summary']);
  expect(lastEvent(t.db)).toMatchObject({ op: 'unlock_field', project_id: p });
  expect(t.ai('update_project', { project: p, fields: { title: 'AI 标题' } })).toMatchObject({ status: 'applied', question_ids: [] });
});

test('unlocking a field that is not locked changes nothing', () => {
  const p = aiProject();
  expect(t.user('unlock_field', { table: 'projects', id: p, field: 'title' })).toMatchObject({ status: 'applied', event_id: null });
  expect(events(p)).toHaveLength(1);
});

test('unlocking a field that cannot be locked is invalid', () => {
  const p = userProject();
  expect(t.user('unlock_field', { table: 'projects', id: p, field: 'stage' })).toMatchObject({ code: 'invalid' });
  expect(t.user('unlock_field', { table: 'todos', id: p, field: 'position' })).toMatchObject({ code: 'invalid' });
});

test('unlocking a todo field records the todo project on the event', () => {
  const p = userProject();
  t.db
    .prepare("INSERT INTO todos (id, project_id, title, status, locks, created_by, created_at) VALUES ('t_1', ?, 'x', 'todo', '[\"status\",\"title\"]', 'user', ?)")
    .run(p, NOW);
  t.user('unlock_field', { table: 'todos', id: 't_1', field: 'title' });
  expect(row(t.db, 'todos', 't_1').locks).toBe('["status"]');
  expect(lastEvent(t.db)).toMatchObject({ entity: 'todos:t_1', project_id: p });
});

test('unlocking on a missing or deleted row is not_found', () => {
  expect(t.user('unlock_field', { table: 'projects', id: 'p_404', field: 'title' })).toMatchObject({ code: 'not_found' });
  expect(t.user('unlock_field', { table: 'milestones', id: 'm_404', field: 'title' })).toMatchObject({ code: 'not_found' });
  const p = userProject();
  markDeleted(p);
  expect(t.user('unlock_field', { table: 'projects', id: p, field: 'title' })).toMatchObject({ code: 'not_found' });
});
