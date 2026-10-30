import { afterEach, beforeEach, expect, test } from 'vitest';
import { execute, HANDLERS } from '../../src/domain/execute.ts';
import { MAX_PENDING_AI_QUESTIONS } from '../../src/domain/questions.ts';
import { count, eventsFor, lastEvent, NOW, row, rows, setup } from './helpers.ts';
import type { Row, Setup } from './helpers.ts';

let t: Setup;

beforeEach(() => {
  t = setup();
});

afterEach(() => {
  t.db.close();
});

const question = (id: string): Row => row(t.db, 'questions', id);
const locks = (table: string, id: string): string[] => JSON.parse(row(t.db, table, id).locks as string);
const lastRow = (table: string): Row => rows(t.db, table).at(-1) as Row;
const eventCount = (): number => count(t.db, 'events');

function userProject(title = '用户项目'): string {
  return t.user('create_project', { title }).id;
}

function aiProject(title = 'AI 项目'): string {
  return t.ai('create_project', { title }).id;
}

/** A todo the AI created: not user-created, nothing locked. */
function aiTodo(project: string, title = 'AI todo'): string {
  return t.ai('upsert_todo', { project, title }).id;
}

function aiMilestone(project: string, title = 'AI 里程碑'): string {
  return t.ai('upsert_milestone', { project, title }).id;
}

// ---- registration ------------------------------------------------------------------------------------------------

test('all nine item ops are registered', () => {
  for (const op of [
    'upsert_milestone',
    'delete_milestone',
    'upsert_todo',
    'delete_todo',
    'record_decision',
    'delete_decision',
    'set_blocker',
    'clear_blocker',
    'delete_blocker',
  ] as const) {
    expect(HANDLERS[op], op).toBeTypeOf('function');
  }
});

// ---- milestones --------------------------------------------------------------------------------------------------

test('creating a milestone appends it after the existing ones', () => {
  const p = userProject();
  const other = userProject('别的项目');
  const first = t.user('upsert_milestone', { project: p, title: '第一' });
  const second = t.user('upsert_milestone', { project: p, title: '第二' });
  t.user('upsert_milestone', { project: other, title: '别处', position: 9 });
  const third = t.ai('upsert_milestone', { project: p, title: '第三' });
  expect([first, second, third].map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
  expect([first.id, second.id, third.id].map((id) => row(t.db, 'milestones', id).position)).toEqual([0, 1, 2]);
});

test('a new milestone after a deleted one still counts only live milestones', () => {
  const p = userProject();
  t.user('upsert_milestone', { project: p, title: 'a' });
  const b = t.user('upsert_milestone', { project: p, title: 'b' }).id;
  t.user('delete_milestone', { project: p, id: b });
  const c = t.user('upsert_milestone', { project: p, title: 'c' }).id;
  expect(row(t.db, 'milestones', c).position).toBe(1);
});

test('user-created milestone: defaults, created_by, event under the project, locks only the given fields', () => {
  const p = userProject();
  const r = t.user('upsert_milestone', { project: p, title: '打通链路' });
  expect(r).toMatchObject({ status: 'applied', id: 'm_1', question_ids: [], warnings: [] });
  expect(row(t.db, 'milestones', 'm_1')).toMatchObject({
    project_id: p,
    title: '打通链路',
    status: 'todo',
    position: 0,
    created_by: 'user',
    created_at: NOW,
    deleted_at: null,
    vetoed: 0,
  });
  expect(locks('milestones', 'm_1')).toEqual(['title']);
  expect(lastEvent(t.db)).toMatchObject({ op: 'upsert_milestone', project_id: p, entity: 'milestones:m_1', is_veto: 0 });

  const r2 = t.user('upsert_milestone', { project: p, title: 'x', status: 'doing', position: 5 });
  expect(locks('milestones', r2.id)).toEqual(['position', 'status', 'title']);
});

test('ai-created milestone locks nothing and records the ai as creator', () => {
  const p = aiProject();
  const m = aiMilestone(p);
  expect(row(t.db, 'milestones', m)).toMatchObject({ created_by: 'ai:curator', status: 'todo', position: 0 });
  expect(locks('milestones', m)).toEqual([]);
});

test('creating a milestone needs a title', () => {
  const p = userProject();
  expect(t.user('upsert_milestone', { project: p })).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(t.user('upsert_milestone', { project: p, status: 'doing' })).toMatchObject({ code: 'invalid' });
  expect(count(t.db, 'milestones')).toBe(0);
});

test('user edit of a milestone writes and locks the given fields', () => {
  const p = userProject();
  const m = aiMilestone(p);
  const r = t.user('upsert_milestone', { project: p, id: m, status: 'doing' });
  expect(r).toMatchObject({ status: 'applied', id: m });
  expect(row(t.db, 'milestones', m)).toMatchObject({ status: 'doing', title: 'AI 里程碑' });
  expect(locks('milestones', m)).toEqual(['status']);
  t.user('upsert_milestone', { project: p, id: m, position: 3 });
  expect(locks('milestones', m)).toEqual(['position', 'status']);
});

test('ai editing a locked milestone field is proposed; unlocked fields apply', () => {
  const p = aiProject();
  const m = aiMilestone(p);
  t.user('upsert_milestone', { project: p, id: m, title: '用户标题' });
  const r = t.ai('upsert_milestone', { project: p, id: m, title: 'AI 标题', status: 'done' }, { reason: '看起来做完了' });
  expect(r).toMatchObject({ status: 'applied', question_ids: [expect.any(String)] });
  expect(row(t.db, 'milestones', m)).toMatchObject({ title: '用户标题', status: 'done' });
  const q = question(r.question_ids[0]);
  expect(q).toMatchObject({
    kind: 'confirm',
    status: 'pending',
    prompt: 'AI 想修改你锁定的字段（title）：看起来做完了',
    project_id: p,
    created_by: 'ai:curator',
    dedupe_key: `update:milestones:${m}:title`,
  });
  expect(JSON.parse(q.guards as string)).toEqual([{ table: 'milestones', id: m, col: 'title', equals: '用户标题' }]);
  expect(JSON.parse(q.options as string)).toEqual([
    { label: '确认', op: 'upsert_milestone', args: { project: p, id: m, title: 'AI 标题' } },
    { label: '拒绝', op: null },
  ]);
});

test('ai milestone edit that only touches locked fields is proposed, nothing applied', () => {
  const p = userProject();
  const m = t.user('upsert_milestone', { project: p, title: 'a', status: 'doing' }).id;
  const before = eventCount();
  const r = t.ai('upsert_milestone', { project: p, id: m, title: 'b', status: 'done' });
  expect(r).toMatchObject({ status: 'proposed', question_ids: [expect.any(String)] });
  expect(eventCount()).toBe(before);
  expect(question(r.question_ids[0]).dedupe_key).toBe(`update:milestones:${m}:status,title`);
  expect(question(r.question_ids[0]).prompt).toBe('AI 想修改你锁定的字段（status、title）：r');
});

// ---- todos -------------------------------------------------------------------------------------------------------

test('creating a todo: defaults, created_by, locks on user create only', () => {
  const p = userProject();
  const r = t.user('upsert_todo', { project: p, title: '写迁移' });
  expect(r).toMatchObject({ status: 'applied', id: 't_1' });
  expect(row(t.db, 'todos', 't_1')).toMatchObject({
    project_id: p,
    title: '写迁移',
    status: 'todo',
    priority: null,
    milestone_id: null,
    created_by: 'user',
    created_at: NOW,
    deleted_at: null,
    vetoed: 0,
  });
  expect(locks('todos', 't_1')).toEqual(['title']);

  const m = aiMilestone(p);
  const full = t.user('upsert_todo', { project: p, title: 'x', status: 'doing', priority: 'P1', milestone_id: m });
  expect(locks('todos', full.id)).toEqual(['milestone_id', 'priority', 'status', 'title']);
  expect(row(t.db, 'todos', full.id)).toMatchObject({ status: 'doing', priority: 'P1', milestone_id: m });

  const explicitNull = t.user('upsert_todo', { project: p, title: 'y', priority: null });
  expect(locks('todos', explicitNull.id)).toEqual(['priority', 'title']);

  const mine = aiTodo(p);
  expect(row(t.db, 'todos', mine)).toMatchObject({ created_by: 'ai:curator' });
  expect(locks('todos', mine)).toEqual([]);
});

test('creating a todo needs a title', () => {
  const p = userProject();
  expect(t.user('upsert_todo', { project: p })).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(t.ai('upsert_todo', { project: p, status: 'done' })).toMatchObject({ code: 'invalid' });
  expect(count(t.db, 'todos')).toBe(0);
});

test('todo cannot point at a milestone of another project', () => {
  const a = userProject('A');
  const b = userProject('B');
  const milestoneOfB = t.user('upsert_milestone', { project: b, title: 'b' }).id;
  expect(t.user('upsert_todo', { project: a, title: 'x', milestone_id: milestoneOfB })).toMatchObject({ code: 'invalid' });
  expect(t.ai('upsert_todo', { project: a, title: 'x', milestone_id: milestoneOfB })).toMatchObject({ code: 'invalid' });
  expect(count(t.db, 'todos')).toBe(0);

  const todo = aiTodo(a);
  expect(t.user('upsert_todo', { project: a, id: todo, milestone_id: milestoneOfB })).toMatchObject({ code: 'invalid' });
  expect(row(t.db, 'todos', todo).milestone_id).toBeNull();
});

test('todo cannot point at a missing or deleted milestone, but may be detached with null', () => {
  const p = userProject();
  const m = aiMilestone(p);
  expect(t.user('upsert_todo', { project: p, title: 'x', milestone_id: 'm_nope' })).toMatchObject({ code: 'invalid' });
  const todo = t.user('upsert_todo', { project: p, title: 'x', milestone_id: m }).id;
  t.user('delete_milestone', { project: p, id: m });
  expect(t.user('upsert_todo', { project: p, title: 'y', milestone_id: m })).toMatchObject({ code: 'invalid' });
  expect(t.user('upsert_todo', { project: p, id: todo, milestone_id: null })).toMatchObject({ status: 'applied' });
});

test('item id that belongs to another project is not_found', () => {
  const a = userProject('A');
  const b = userProject('B');
  const todoOfB = t.user('upsert_todo', { project: b, title: 'b' }).id;
  expect(t.user('upsert_todo', { project: a, id: todoOfB, title: 'x' })).toMatchObject({ status: 'rejected', code: 'not_found' });
  expect(t.ai('upsert_todo', { project: a, id: todoOfB, title: 'x' })).toMatchObject({ code: 'not_found' });
  expect(t.user('delete_todo', { project: a, id: todoOfB })).toMatchObject({ code: 'not_found' });
  expect(row(t.db, 'todos', todoOfB)).toMatchObject({ title: 'b', deleted_at: null });
});

test('a missing item id is not_found, never a crash', () => {
  const p = userProject();
  expect(t.user('upsert_todo', { project: p, id: 't_nope', title: 'x' })).toMatchObject({ code: 'not_found' });
  expect(t.user('upsert_milestone', { project: p, id: 'm_nope', title: 'x' })).toMatchObject({ code: 'not_found' });
  expect(t.user('set_blocker', { project: p, id: 'b_nope', text: 'x' })).toMatchObject({ code: 'not_found' });
  expect(t.user('clear_blocker', { project: p, id: 'b_nope' })).toMatchObject({ code: 'not_found' });
  expect(t.user('delete_decision', { project: p, id: 'd_nope' })).toMatchObject({ code: 'not_found' });
});

test('every item op needs a live project; ai gets merged for a merged one', () => {
  expect(t.user('upsert_todo', { project: 'p_nope', title: 'x' })).toMatchObject({ code: 'not_found' });
  expect(t.user('record_decision', { project: 'p_nope', text: 'x' })).toMatchObject({ code: 'not_found' });

  const a = userProject('A');
  const b = userProject('B');
  const todo = t.user('upsert_todo', { project: a, title: 'x' }).id;
  t.user('transition_stage', { project: a, stage: 'merged', merge_into: b });
  const r = t.ai('upsert_todo', { project: a, title: 'y' });
  expect(r).toMatchObject({ code: 'merged' });
  expect(r.message).toContain(b);
  expect(t.ai('delete_todo', { project: a, id: todo })).toMatchObject({ code: 'merged' });
  expect(t.user('upsert_todo', { project: a, id: todo, status: 'done' })).toMatchObject({ status: 'applied' });
});

test('user edit of a todo writes and locks the given fields', () => {
  const p = userProject();
  const todo = aiTodo(p);
  t.user('upsert_todo', { project: p, id: todo, status: 'doing', priority: 'P0' });
  expect(row(t.db, 'todos', todo)).toMatchObject({ status: 'doing', priority: 'P0', title: 'AI todo' });
  expect(locks('todos', todo)).toEqual(['priority', 'status']);
  expect(lastEvent(t.db)).toMatchObject({ op: 'upsert_todo', project_id: p, actor: 'user' });
});

test('ai editing a locked todo field is proposed; unlocked fields apply', () => {
  const p = aiProject();
  const todo = aiTodo(p);
  t.user('upsert_todo', { project: p, id: todo, status: 'doing' });
  const r = t.ai('upsert_todo', { project: p, id: todo, status: 'done', priority: 'P2', title: '改名' }, { reason: '做完了' });
  expect(r).toMatchObject({ status: 'applied', question_ids: [expect.any(String)] });
  expect(row(t.db, 'todos', todo)).toMatchObject({ status: 'doing', priority: 'P2', title: '改名' });
  expect(locks('todos', todo)).toEqual(['status']);
  const q = question(r.question_ids[0]);
  expect(q).toMatchObject({
    kind: 'confirm',
    prompt: 'AI 想修改你锁定的字段（status）：做完了',
    project_id: p,
    dedupe_key: `update:todos:${todo}:status`,
    evidence: '["chunk:1"]',
  });
  expect(JSON.parse(q.guards as string)).toEqual([{ table: 'todos', id: todo, col: 'status', equals: 'doing' }]);
  expect(JSON.parse(q.options as string)).toEqual([
    { label: '确认', op: 'upsert_todo', args: { project: p, id: todo, status: 'done' } },
    { label: '拒绝', op: null },
  ]);
});

test('ai proposing a locked todo field to a value it already has asks nothing', () => {
  const p = userProject();
  const todo = t.user('upsert_todo', { project: p, title: '同名' }).id;
  const before = eventCount();
  expect(t.ai('upsert_todo', { project: p, id: todo, title: '同名' })).toMatchObject({
    status: 'applied',
    event_id: null,
    question_ids: [],
  });
  expect(eventCount()).toBe(before);
  expect(count(t.db, 'questions')).toBe(0);
});

test('a locked todo milestone_id proposal carries the milestone through; confirming applies it as the user', () => {
  const p = userProject();
  const m = aiMilestone(p);
  const todo = t.user('upsert_todo', { project: p, title: 'x', milestone_id: null }).id;
  const r = t.ai('upsert_todo', { project: p, id: todo, milestone_id: m });
  expect(r.status).toBe('proposed');
  const option = JSON.parse(question(r.question_ids[0]).options as string)[0];
  expect(t.user(option.op, option.args)).toMatchObject({ status: 'applied' });
  expect(row(t.db, 'todos', todo).milestone_id).toBe(m);
});

test('the same ai todo proposal twice reuses the pending question; a user edit withdraws it', () => {
  const p = userProject();
  const todo = t.user('upsert_todo', { project: p, title: '原题' }).id;
  const first = t.ai('upsert_todo', { project: p, id: todo, title: 'A' });
  const second = t.ai('upsert_todo', { project: p, id: todo, title: 'A' }, { evidence: ['chunk:2'] });
  expect(second).toMatchObject({ status: 'proposed', question_ids: first.question_ids });
  expect(question(first.question_ids[0]).evidence).toBe('["chunk:1","chunk:2"]');
  t.user('upsert_todo', { project: p, id: todo, title: '用户又改了' });
  expect(question(first.question_ids[0])).toMatchObject({ status: 'withdrawn', resolution_note: 'stale' });
});

test('a failed todo proposal becomes a warning when other fields applied', () => {
  const p = userProject();
  const todo = t.user('upsert_todo', { project: p, title: '原题' }).id;
  const fill = t.db.prepare(
    "INSERT INTO questions (id, kind, prompt, options, status, evidence, guards, dedupe_key, created_by, created_at) VALUES (?, 'confirm', 'x', '[]', 'pending', '[]', '[]', ?, 'ai:other', ?)",
  );
  for (let i = 0; i < MAX_PENDING_AI_QUESTIONS; i++) fill.run(`fill_${i}`, `fill-${i}`, NOW);
  const r = t.ai('upsert_todo', { project: p, id: todo, title: 'AI 标题', status: 'doing' });
  expect(r).toMatchObject({ status: 'applied', question_ids: [], warnings: [expect.stringMatching(/^question_limit: /)] });
  expect(row(t.db, 'todos', todo)).toMatchObject({ title: '原题', status: 'doing' });
});

// ---- deleting ----------------------------------------------------------------------------------------------------

test('user delete leaves a vetoed tombstone; ai cannot touch it again', () => {
  const p = userProject();
  const todo = aiTodo(p);
  const r = t.user('delete_todo', { project: p, id: todo });
  expect(r).toMatchObject({ status: 'applied' });
  expect(row(t.db, 'todos', todo)).toMatchObject({ vetoed: 1, deleted_at: NOW });
  expect(lastEvent(t.db)).toMatchObject({ op: 'delete_todo', project_id: p, actor: 'user', is_veto: 1 });

  expect(t.ai('upsert_todo', { project: p, id: todo, status: 'done' })).toMatchObject({ status: 'rejected', code: 'vetoed' });
  expect(t.ai('upsert_todo', { project: p, id: todo, title: '换个说法再来' })).toMatchObject({ code: 'vetoed' });
  expect(t.ai('delete_todo', { project: p, id: todo })).toMatchObject({ code: 'vetoed' });
  expect(row(t.db, 'todos', todo)).toMatchObject({ vetoed: 1, deleted_at: NOW, status: 'todo' });
});

test('user delete of an item that is already gone is not_found; user cannot edit a tombstone', () => {
  const p = userProject();
  const todo = aiTodo(p);
  t.user('delete_todo', { project: p, id: todo });
  const before = eventCount();
  expect(t.user('delete_todo', { project: p, id: todo })).toMatchObject({ code: 'not_found' });
  expect(t.user('upsert_todo', { project: p, id: todo, title: 'x' })).toMatchObject({ code: 'not_found' });
  expect(eventCount()).toBe(before);
});

test('an item the ai deleted (no veto) is simply gone for everyone', () => {
  const p = userProject();
  const todo = aiTodo(p);
  expect(t.ai('delete_todo', { project: p, id: todo })).toMatchObject({ status: 'applied', question_ids: [] });
  expect(row(t.db, 'todos', todo)).toMatchObject({ vetoed: 0, deleted_at: NOW });
  expect(lastEvent(t.db)).toMatchObject({ actor: 'ai:curator', is_veto: 0 });
  expect(t.ai('upsert_todo', { project: p, id: todo, status: 'done' })).toMatchObject({ code: 'not_found' });
  expect(t.user('upsert_todo', { project: p, id: todo, status: 'done' })).toMatchObject({ code: 'not_found' });
});

test('ai deleting a user-created item is proposed', () => {
  const p = userProject();
  const todo = t.user('upsert_todo', { project: p, title: '我的 todo' }).id;
  const before = eventCount();
  const r = t.ai('delete_todo', { project: p, id: todo }, { reason: '重复了' });
  expect(r).toMatchObject({ status: 'proposed', question_ids: [expect.any(String)] });
  expect(eventCount()).toBe(before);
  expect(row(t.db, 'todos', todo).deleted_at).toBeNull();
  const q = question(r.question_ids[0]);
  expect(q).toMatchObject({
    kind: 'confirm',
    prompt: 'AI 想删除你编辑过的todo「我的 todo」：重复了',
    project_id: p,
    created_by: 'ai:curator',
    dedupe_key: `delete:todos:${todo}`,
  });
  expect(JSON.parse(q.guards as string)).toEqual([{ table: 'todos', id: todo, col: 'deleted_at', equals: null }]);
  expect(JSON.parse(q.options as string)).toEqual([
    { label: '确认', op: 'delete_todo', args: { project: p, id: todo } },
    { label: '拒绝', op: null },
  ]);
});

test('ai deleting an ai-created item the user edited is proposed; an untouched ai-created one is deleted without veto', () => {
  const p = aiProject();
  const edited = aiTodo(p, '被用户改过');
  const untouched = aiTodo(p, '没人动过');
  t.user('upsert_todo', { project: p, id: edited, priority: 'P1' });

  expect(t.ai('delete_todo', { project: p, id: edited })).toMatchObject({ status: 'proposed' });
  expect(row(t.db, 'todos', edited).deleted_at).toBeNull();

  expect(t.ai('delete_todo', { project: p, id: untouched })).toMatchObject({ status: 'applied', question_ids: [] });
  expect(row(t.db, 'todos', untouched)).toMatchObject({ deleted_at: NOW, vetoed: 0 });
});

test('confirming an ai delete proposal deletes as the user: vetoed tombstone', () => {
  const p = userProject();
  const todo = t.user('upsert_todo', { project: p, title: 'x' }).id;
  const q = t.ai('delete_todo', { project: p, id: todo }).question_ids[0];
  const option = JSON.parse(question(q).options as string)[0];
  expect(t.user(option.op, option.args)).toMatchObject({ status: 'applied' });
  expect(row(t.db, 'todos', todo)).toMatchObject({ vetoed: 1, deleted_at: NOW });
  expect(question(q)).toMatchObject({ status: 'withdrawn', resolution_note: 'stale' });
});

test('delete prompts name the kind of item and use the text of decisions and blockers', () => {
  const p = userProject();
  const m = t.user('upsert_milestone', { project: p, title: '里程碑 A' }).id;
  const d = t.user('record_decision', { project: p, text: '用 SQLite' }).id;
  const b = t.user('set_blocker', { project: p, text: '等 GPU' }).id;
  const prompt = (r: { question_ids: string[] }): string => question(r.question_ids[0]).prompt as string;
  expect(prompt(t.ai('delete_milestone', { project: p, id: m }))).toBe('AI 想删除你编辑过的里程碑「里程碑 A」：r');
  expect(prompt(t.ai('delete_decision', { project: p, id: d }))).toBe('AI 想删除你编辑过的决策「用 SQLite」：r');
  expect(prompt(t.ai('delete_blocker', { project: p, id: b }))).toBe('AI 想删除你编辑过的阻塞「等 GPU」：r');
});

test('deleting a milestone detaches its todos in the same event', () => {
  const p = userProject();
  const m = aiMilestone(p);
  const mine = t.user('upsert_todo', { project: p, title: 'a', milestone_id: m }).id;
  const theirs = aiTodo(p, 'b');
  t.ai('upsert_todo', { project: p, id: theirs, milestone_id: m });
  const otherMilestone = aiMilestone(p, '另一个');
  const stays = aiTodo(p, 'c');
  t.ai('upsert_todo', { project: p, id: stays, milestone_id: otherMilestone });
  const eventsBefore = eventCount();

  expect(t.user('delete_milestone', { project: p, id: m })).toMatchObject({ status: 'applied' });

  expect(eventCount()).toBe(eventsBefore + 1);
  expect(row(t.db, 'todos', mine).milestone_id).toBeNull();
  expect(row(t.db, 'todos', theirs).milestone_id).toBeNull();
  expect(row(t.db, 'todos', stays).milestone_id).toBe(otherMilestone);
  expect(row(t.db, 'milestones', m)).toMatchObject({ vetoed: 1, deleted_at: NOW });

  const e = lastEvent(t.db);
  expect(e).toMatchObject({ op: 'delete_milestone', project_id: p, is_veto: 1 });
  const after = JSON.parse(e.after as string);
  expect(Object.keys(after).sort()).toEqual([`milestones:${m}`, `todos:${mine}`, `todos:${theirs}`].sort());
  expect(after[`todos:${mine}`]).toEqual({ milestone_id: null });
  expect(JSON.parse(e.before as string)[`todos:${mine}`]).toEqual({ milestone_id: m });
});

test('an ai deleting an ai-created milestone also detaches the todos', () => {
  const p = aiProject();
  const m = aiMilestone(p);
  const todo = aiTodo(p);
  t.ai('upsert_todo', { project: p, id: todo, milestone_id: m });
  expect(t.ai('delete_milestone', { project: p, id: m })).toMatchObject({ status: 'applied' });
  expect(row(t.db, 'todos', todo).milestone_id).toBeNull();
  expect(row(t.db, 'milestones', m)).toMatchObject({ vetoed: 0, deleted_at: NOW });
});

test('ai deleting its own milestone is proposed when a user-locked todo is attached to it', () => {
  const p = aiProject();
  const m = aiMilestone(p, 'AI 的里程碑');
  const todo = t.user('upsert_todo', { project: p, title: '用户的 todo', milestone_id: m }).id;
  expect(locks('todos', todo)).toContain('milestone_id');
  const before = eventCount();

  const r = t.ai('delete_milestone', { project: p, id: m }, { reason: '里程碑重复了' });

  expect(r).toMatchObject({ status: 'proposed', question_ids: [expect.any(String)] });
  expect(eventCount()).toBe(before);
  expect(row(t.db, 'milestones', m)).toMatchObject({ deleted_at: null, vetoed: 0 });
  expect(row(t.db, 'todos', todo).milestone_id).toBe(m);

  const q = question(r.question_ids[0]);
  expect(q).toMatchObject({
    kind: 'confirm',
    prompt: 'AI 想删除你编辑过的里程碑「AI 的里程碑」：里程碑重复了',
    project_id: p,
    dedupe_key: `delete:milestones:${m}`,
  });
  expect(JSON.parse(q.guards as string)).toEqual([{ table: 'milestones', id: m, col: 'deleted_at', equals: null }]);
  expect(JSON.parse(q.options as string)).toEqual([
    { label: '确认', op: 'delete_milestone', args: { project: p, id: m } },
    { label: '拒绝', op: null },
  ]);

  const option = JSON.parse(q.options as string)[0];
  expect(t.user(option.op, option.args)).toMatchObject({ status: 'applied' });
  expect(row(t.db, 'milestones', m)).toMatchObject({ vetoed: 1, deleted_at: NOW });
  expect(row(t.db, 'todos', todo).milestone_id).toBeNull();
});

test('ai deleting its own milestone applies when no live attached todo has a locked milestone_id', () => {
  const p = aiProject();
  const m = aiMilestone(p);
  // The user made this todo (title locked) but the AI attached it, so milestone_id is not locked.
  const userTodo = t.user('upsert_todo', { project: p, title: '用户的 todo' }).id;
  t.ai('upsert_todo', { project: p, id: userTodo, milestone_id: m });
  // A user-locked todo that was deleted no longer holds the milestone.
  const gone = t.user('upsert_todo', { project: p, title: '已删除', milestone_id: m }).id;
  t.user('delete_todo', { project: p, id: gone });
  expect(locks('todos', userTodo)).not.toContain('milestone_id');

  expect(t.ai('delete_milestone', { project: p, id: m })).toMatchObject({ status: 'applied', question_ids: [] });
  expect(row(t.db, 'milestones', m)).toMatchObject({ vetoed: 0, deleted_at: NOW });
  expect(row(t.db, 'todos', userTodo).milestone_id).toBeNull();
  expect(row(t.db, 'todos', gone).milestone_id).toBe(m);
});

test('a proposed milestone delete leaves the todos attached', () => {
  const p = userProject();
  const m = t.user('upsert_milestone', { project: p, title: 'm' }).id;
  const todo = t.user('upsert_todo', { project: p, title: 'x', milestone_id: m }).id;
  expect(t.ai('delete_milestone', { project: p, id: m })).toMatchObject({ status: 'proposed' });
  expect(row(t.db, 'todos', todo).milestone_id).toBe(m);
});

test('deleted todos that pointed at a milestone are left alone', () => {
  const p = userProject();
  const m = aiMilestone(p);
  const todo = t.user('upsert_todo', { project: p, title: 'x', milestone_id: m }).id;
  t.user('delete_todo', { project: p, id: todo });
  t.user('delete_milestone', { project: p, id: m });
  expect(row(t.db, 'todos', todo).milestone_id).toBe(m);
});

// ---- decisions ---------------------------------------------------------------------------------------------------

test('decision defaults decided_at to occurred_at and stores the evidence', () => {
  const p = aiProject();
  t.ai('record_decision', { project: p, text: '用 SQLite' }, { evidence: ['chunk:7#L3'] });
  expect(lastRow('decisions')).toMatchObject({
    project_id: p,
    text: '用 SQLite',
    decided_at: NOW,
    evidence: '["chunk:7#L3"]',
    created_by: 'ai:curator',
    created_at: NOW,
    deleted_at: null,
    vetoed: 0,
  });
  expect(lastEvent(t.db)).toMatchObject({ op: 'record_decision', project_id: p, entity: 'decisions:d_1' });
});

test('decided_at follows the occurred_at the caller passes, and an explicit decided_at wins', () => {
  const p = userProject();
  const at = '2026-10-01T08:30:00.000Z';
  const r = execute(t.db, t.deps, { op: 'record_decision', args: { project: p, text: '早就定了' }, actor: 'user', occurred_at: at });
  expect(r).toMatchObject({ status: 'applied', id: 'd_1' });
  expect(row(t.db, 'decisions', 'd_1')).toMatchObject({ decided_at: at, created_at: NOW, evidence: '[]', created_by: 'user' });

  t.user('record_decision', { project: p, text: '另一个', decided_at: '2026-09-01T00:00:00Z' });
  expect(lastRow('decisions')).toMatchObject({ decided_at: '2026-09-01T00:00:00.000Z' });
});

test('user decision delete is a veto; ai deleting a user decision is proposed; ai-recorded one is deleted quietly', () => {
  const p = userProject();
  const mine = t.user('record_decision', { project: p, text: '我定的' }).id;
  const theirs = t.ai('record_decision', { project: p, text: 'AI 记的' }).id;

  expect(t.ai('delete_decision', { project: p, id: mine })).toMatchObject({ status: 'proposed' });
  expect(t.ai('delete_decision', { project: p, id: theirs })).toMatchObject({ status: 'applied' });
  expect(row(t.db, 'decisions', theirs)).toMatchObject({ deleted_at: NOW, vetoed: 0 });

  const other = t.ai('record_decision', { project: p, text: '又一个' }).id;
  t.user('delete_decision', { project: p, id: other });
  expect(row(t.db, 'decisions', other)).toMatchObject({ deleted_at: NOW, vetoed: 1 });
  expect(lastEvent(t.db).is_veto).toBe(1);
  expect(t.ai('delete_decision', { project: p, id: other })).toMatchObject({ code: 'vetoed' });
});

// ---- blockers ----------------------------------------------------------------------------------------------------

test('creating a blocker: defaults and created_by', () => {
  const p = userProject();
  const r = t.user('set_blocker', { project: p, text: '等 GPU 配额' });
  expect(r).toMatchObject({ status: 'applied', id: 'b_1' });
  expect(row(t.db, 'blockers', 'b_1')).toMatchObject({
    project_id: p,
    text: '等 GPU 配额',
    kind: 'technical',
    status: 'open',
    cleared_at: null,
    created_by: 'user',
    created_at: NOW,
    deleted_at: null,
    vetoed: 0,
  });
  const ai = t.ai('set_blocker', { project: p, text: '需要用户决定', kind: 'user' });
  expect(row(t.db, 'blockers', ai.id)).toMatchObject({ kind: 'user', status: 'open', created_by: 'ai:curator' });
});

test('creating a blocker needs text', () => {
  const p = userProject();
  expect(t.user('set_blocker', { project: p })).toMatchObject({ code: 'invalid' });
  expect(t.ai('set_blocker', { project: p, kind: 'external' })).toMatchObject({ code: 'invalid' });
  expect(count(t.db, 'blockers')).toBe(0);
});

test('editing a blocker changes its text and kind for both user and ai, locking nothing', () => {
  const p = userProject();
  const b = t.user('set_blocker', { project: p, text: '原文' }).id;
  expect(t.ai('set_blocker', { project: p, id: b, text: 'AI 改的', kind: 'external' })).toMatchObject({ status: 'applied', id: b });
  expect(row(t.db, 'blockers', b)).toMatchObject({ text: 'AI 改的', kind: 'external', status: 'open' });
  expect(t.user('set_blocker', { project: p, id: b, kind: 'user' })).toMatchObject({ status: 'applied' });
  expect(row(t.db, 'blockers', b)).toMatchObject({ text: 'AI 改的', kind: 'user' });
  expect(row(t.db, 'blockers', b)).not.toHaveProperty('locks');
});

test('clear_blocker marks it cleared with the time', () => {
  const p = userProject();
  const b = t.user('set_blocker', { project: p, text: 'x' }).id;
  t.setNow('2026-10-30T09:00:00.000Z');
  expect(t.ai('clear_blocker', { project: p, id: b })).toMatchObject({ status: 'applied' });
  expect(row(t.db, 'blockers', b)).toMatchObject({ status: 'cleared', cleared_at: '2026-10-30T09:00:00.000Z' });
  expect(lastEvent(t.db)).toMatchObject({ op: 'clear_blocker', project_id: p, is_veto: 0 });
});

test('clearing an already cleared blocker changes nothing and writes no event', () => {
  const p = userProject();
  const b = t.user('set_blocker', { project: p, text: 'x' }).id;
  t.user('clear_blocker', { project: p, id: b });
  const clearedAt = row(t.db, 'blockers', b).cleared_at;
  t.setNow('2026-11-01T00:00:00.000Z');
  const before = eventCount();
  expect(t.user('clear_blocker', { project: p, id: b })).toMatchObject({ status: 'applied', event_id: null });
  expect(t.ai('clear_blocker', { project: p, id: b })).toMatchObject({ status: 'applied', event_id: null });
  expect(eventCount()).toBe(before);
  expect(row(t.db, 'blockers', b).cleared_at).toBe(clearedAt);
});

test('a deleted blocker cannot be cleared; user delete of a blocker is a veto', () => {
  const p = userProject();
  const b = t.ai('set_blocker', { project: p, text: 'x' }).id;
  t.user('delete_blocker', { project: p, id: b });
  expect(row(t.db, 'blockers', b)).toMatchObject({ deleted_at: NOW, vetoed: 1 });
  expect(lastEvent(t.db).is_veto).toBe(1);
  expect(t.ai('clear_blocker', { project: p, id: b })).toMatchObject({ code: 'vetoed' });
  expect(t.ai('set_blocker', { project: p, id: b, text: 'y' })).toMatchObject({ code: 'vetoed' });
  expect(t.user('clear_blocker', { project: p, id: b })).toMatchObject({ code: 'not_found' });
});

test('blocker ids of another project are not_found', () => {
  const a = userProject('A');
  const b = userProject('B');
  const blockerOfB = t.user('set_blocker', { project: b, text: 'x' }).id;
  expect(t.user('clear_blocker', { project: a, id: blockerOfB })).toMatchObject({ code: 'not_found' });
  expect(t.user('delete_blocker', { project: a, id: blockerOfB })).toMatchObject({ code: 'not_found' });
  expect(row(t.db, 'blockers', blockerOfB).status).toBe('open');
});

// ---- events ------------------------------------------------------------------------------------------------------

test('every item op writes one event filed under the project', () => {
  const p = userProject();
  t.user('upsert_milestone', { project: p, title: 'm' });
  t.user('upsert_todo', { project: p, title: 't' });
  t.user('record_decision', { project: p, text: 'd' });
  t.user('set_blocker', { project: p, text: 'b' });
  expect(eventsFor(t.db, p).map((e) => e.op)).toEqual([
    'create_project',
    'upsert_milestone',
    'upsert_todo',
    'record_decision',
    'set_blocker',
  ]);
});

test('ai item ops need a reason and evidence like any other ai write', () => {
  const p = userProject();
  expect(t.ai('upsert_todo', { project: p, title: 'x' }, { reason: '' })).toMatchObject({ code: 'missing_reason' });
  expect(t.ai('record_decision', { project: p, text: 'x' }, { evidence: [] })).toMatchObject({ code: 'missing_evidence' });
  expect(count(t.db, 'todos')).toBe(0);
  expect(count(t.db, 'decisions')).toBe(0);
});
