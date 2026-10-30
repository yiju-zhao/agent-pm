import { afterEach, beforeEach, expect, test } from 'vitest';
import { entityKey, parseEntityKey } from '../../src/domain/changes.ts';
import { HANDLERS } from '../../src/domain/execute.ts';
import { getProject } from '../../src/domain/read.ts';
import { lastEvent, NOW, row, setup } from './helpers.ts';
import type { Row, Setup } from './helpers.ts';

let t: Setup;

beforeEach(() => {
  t = setup();
});

afterEach(() => {
  t.db.close();
});

const S = 'claude:aaaa1111';
const LATER = '2026-10-29T13:00:00.000Z';

const project = (id: string): Row => row(t.db, 'projects', id);
const todo = (id: string): Row => row(t.db, 'todos', id);
const milestone = (id: string): Row => row(t.db, 'milestones', id);
const contribution = (id: string): Row => row(t.db, 'contributions', id);
const event = (id: number): Row => row(t.db, 'events', String(id));
const eventCount = (): number => (t.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
const locks = (r: Row): string[] => JSON.parse(String(r.locks));
const session = (key: string): Row => ({ ...t.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key) });

function addSession(key: string): void {
  t.db
    .prepare("INSERT INTO sessions (key, agent_kind, machine, ignored, first_seen, last_seen) VALUES (?, 'claude', 'laptop', 0, ?, ?)")
    .run(key, NOW, NOW);
}

beforeEach(() => {
  addSession(S);
});

// ---- registration and entity keys --------------------------------------------------------------------------------

test('revert_event is registered and AI may not call it', () => {
  expect(HANDLERS.revert_event).toBeTypeOf('function');
  const e = t.ai('create_project', { title: 'x' }).event_id;
  expect(t.ai('revert_event', { event_id: e })).toMatchObject({ status: 'rejected', code: 'user_only' });
});

test('entity keys split on the first colon only, so session keys keep theirs', () => {
  expect(entityKey('sessions', S)).toBe(`sessions:${S}`);
  expect(parseEntityKey(`sessions:${S}`)).toEqual({ table: 'sessions', id: S });
  expect(parseEntityKey('projects:p_1')).toEqual({ table: 'projects', id: 'p_1' });
  expect(() => parseEntityKey('nope:x')).toThrow();
  expect(() => parseEntityKey('projects')).toThrow();
});

// ---- veto: reverting AI events -----------------------------------------------------------------------------------

test('reverting an ai field change restores the old value, locks the field and counts as a veto', () => {
  const p = t.ai('create_project', { title: 'x', summary: '原来的' }).id; // AI 建的，字段没锁，AI 的修改才会直接生效
  const e = t.ai('update_project', { project: p, fields: { summary: 'AI 写的' } }).event_id;
  t.user('revert_event', { event_id: e });
  expect(project(p)).toMatchObject({ summary: '原来的' });
  expect(JSON.parse(project(p).locks as string)).toContain('summary');
  expect(lastEvent(t.db)).toMatchObject({ op: 'revert_event', reverts: e, is_veto: 1 });
  expect(t.ai('update_project', { project: p, fields: { summary: '又改' } })).toMatchObject({ status: 'proposed' });
});

test('the revert event is filed under the original project, logs the write-back and marks the original', () => {
  const p = t.ai('create_project', { title: 'x', summary: '原来的' }).id;
  const e = t.ai('update_project', { project: p, fields: { summary: 'AI 写的' } }).event_id as number;
  t.setNow(LATER);
  const r = t.user('revert_event', { event_id: e });
  expect(r).toMatchObject({ status: 'applied' });
  const revert = event(r.event_id as number);
  expect(revert).toMatchObject({ op: 'revert_event', actor: 'user', project_id: p, reverts: e, reverted_by: null });
  expect(JSON.parse(String(revert.args))).toEqual({ event_id: e });
  expect(JSON.parse(String(revert.before))).toEqual({ [`projects:${p}`]: { summary: 'AI 写的', locks: '[]' } });
  expect(JSON.parse(String(revert.after))).toEqual({ [`projects:${p}`]: { summary: '原来的', locks: '["summary"]' } });
  expect(event(e).reverted_by).toBe(r.event_id);
});

test('reverting an ai link leaves a vetoed tombstone, so the ai cannot relink directly', () => {
  const p = t.ai('create_project', { title: 'x' }).id;
  const link = t.ai('link_session', { session: S, project: p });
  t.setNow(LATER);
  expect(t.user('revert_event', { event_id: link.event_id })).toMatchObject({ status: 'applied' });
  expect(contribution(link.id)).toMatchObject({ deleted_at: LATER, vetoed: 1 });
  expect(lastEvent(t.db)).toMatchObject({ is_veto: 1, project_id: p });
  expect(t.ai('link_session', { session: S, project: p })).toMatchObject({ status: 'proposed' });
  expect(contribution(link.id).deleted_at).toBe(LATER);
});

test('reverting an ai-created todo tombstones it with veto', () => {
  const p = t.user('create_project', { title: 'x' }).id;
  const created = t.ai('upsert_todo', { project: p, title: 'AI 的 todo' });
  t.setNow(LATER);
  t.user('revert_event', { event_id: created.event_id });
  expect(todo(created.id)).toMatchObject({ title: 'AI 的 todo', deleted_at: LATER, vetoed: 1, locks: '[]' });
  expect(t.ai('upsert_todo', { project: p, id: created.id, title: '复活' })).toMatchObject({ status: 'rejected', code: 'vetoed' });
});

test('reverting an ai create_project from a session tombstones the project and its link', () => {
  const r = t.ai('create_project', { title: 'x', from_session: S });
  t.setNow(LATER);
  t.user('revert_event', { event_id: r.event_id });
  expect(project(r.id)).toMatchObject({ deleted_at: LATER, vetoed: 1 });
  expect(contribution('c_1')).toMatchObject({ deleted_at: LATER, vetoed: 1 });
});

test('reverting an ai milestone delete restores the milestone and relocks the detached todos', () => {
  const p = t.user('create_project', { title: 'x' }).id;
  const m = t.ai('upsert_milestone', { project: p, title: 'M' }).id;
  const td = t.ai('upsert_todo', { project: p, title: 'T', milestone_id: m }).id;
  const e = t.ai('delete_milestone', { project: p, id: m }).event_id;
  expect(todo(td).milestone_id).toBeNull();
  t.user('revert_event', { event_id: e });
  expect(milestone(m)).toMatchObject({ deleted_at: null, vetoed: 0, locks: '[]' });
  expect(todo(td)).toMatchObject({ milestone_id: m });
  expect(locks(todo(td))).toEqual(['milestone_id']);
  expect(lastEvent(t.db)).toMatchObject({ is_veto: 1 });
});

test('an ai event whose revert leaves a row deleted vetoes that row', () => {
  const p = t.ai('create_project', { title: 'x' }).id;
  const link = t.ai('link_session', { session: S, project: p });
  t.ai('unlink_session', { session: S, project: p }); // AI 自己取消，不是否决
  expect(contribution(link.id).vetoed).toBe(0);
  const relink = t.ai('link_session', { session: S, project: p }).event_id; // 复活墓碑
  t.user('revert_event', { event_id: relink });
  expect(contribution(link.id).deleted_at).not.toBeNull();
  expect(contribution(link.id).vetoed).toBe(1);
});

// ---- reverting user events ---------------------------------------------------------------------------------------

test('reverting a user delete restores the item and clears the veto', () => {
  const p = t.user('create_project', { title: 'x' }).id;
  const td = t.user('upsert_todo', { project: p, title: 'T' }).id;
  const del = t.user('delete_todo', { project: p, id: td }).event_id;
  expect(todo(td)).toMatchObject({ vetoed: 1 });
  t.user('revert_event', { event_id: del });
  expect(todo(td)).toMatchObject({ deleted_at: null, vetoed: 0, locks: '["title"]' });
  expect(lastEvent(t.db)).toMatchObject({ op: 'revert_event', reverts: del, is_veto: 0 });
});

test('reverting a user field edit restores the value and leaves locks alone', () => {
  const p = t.ai('create_project', { title: 'x', summary: '原来的' }).id;
  const e = t.user('update_project', { project: p, fields: { summary: '用户写的' } }).event_id;
  t.user('revert_event', { event_id: e });
  expect(project(p)).toMatchObject({ summary: '原来的', locks: '["summary"]' });
  expect(lastEvent(t.db)).toMatchObject({ is_veto: 0 });
});

test('reverting a user creation tombstones without veto', () => {
  const p = t.user('create_project', { title: 'x' }).id;
  const created = t.user('upsert_todo', { project: p, title: 'T' });
  t.setNow(LATER);
  t.user('revert_event', { event_id: created.event_id });
  expect(todo(created.id)).toMatchObject({ deleted_at: LATER, vetoed: 0 });
});

test('reverting a stage transition restores stage, stage_before_park and merged_into', () => {
  const p = t.user('create_project', { title: 'x' }).id;
  const q = t.user('create_project', { title: 'y' }).id;
  t.user('transition_stage', { project: p, stage: 'explore' });
  const park = t.user('transition_stage', { project: p, stage: 'parked' }).event_id;
  expect(project(p)).toMatchObject({ stage: 'parked', stage_before_park: 'explore' });
  t.user('revert_event', { event_id: park });
  expect(project(p)).toMatchObject({ stage: 'explore', stage_before_park: null });

  const merge = t.user('transition_stage', { project: p, stage: 'merged', merge_into: q }).event_id;
  expect(project(p)).toMatchObject({ stage: 'merged', merged_into: q });
  t.user('revert_event', { event_id: merge });
  expect(project(p)).toMatchObject({ stage: 'explore', merged_into: null });
});

test('reverting ignore_session restores the flag', () => {
  const e = t.user('ignore_session', { session: S }).event_id;
  expect(session(S).ignored).toBe(1);
  t.user('revert_event', { event_id: e });
  expect(session(S).ignored).toBe(0);
  expect(lastEvent(t.db)).toMatchObject({ op: 'revert_event', reverts: e, project_id: null, entity: `sessions:${S}` });
});

// ---- conflicts and rejections ------------------------------------------------------------------------------------

test('revert after a later change to the same column is a conflict naming the column', () => {
  const p = t.ai('create_project', { title: 'x', summary: '原来的' }).id;
  const e = t.ai('update_project', { project: p, fields: { summary: 'A' } }).event_id;
  t.user('update_project', { project: p, fields: { summary: 'B' } });
  const before = eventCount();
  expect(t.user('revert_event', { event_id: e })).toMatchObject({
    code: 'conflict',
    message: expect.stringContaining(`projects:${p}.summary`),
  });
  expect(project(p).summary).toBe('B');
  expect(eventCount()).toBe(before);
  expect(event(e as number).reverted_by).toBeNull();
});

test('a later change to another column does not block the revert', () => {
  const p = t.ai('create_project', { title: 'x', summary: '原来的' }).id;
  const e = t.ai('update_project', { project: p, fields: { summary: 'A' } }).event_id;
  t.user('update_project', { project: p, fields: { why: '因为' } });
  expect(t.user('revert_event', { event_id: e })).toMatchObject({ status: 'applied' });
  expect(project(p)).toMatchObject({ summary: '原来的', why: '因为' });
  expect(locks(project(p))).toEqual(['summary', 'why']);
});

test('a conflict on any row blocks the whole revert', () => {
  const p = t.user('create_project', { title: 'x' }).id;
  const m = t.ai('upsert_milestone', { project: p, title: 'M' }).id;
  const m2 = t.user('upsert_milestone', { project: p, title: 'M2' }).id;
  const td = t.ai('upsert_todo', { project: p, title: 'T', milestone_id: m }).id;
  const e = t.ai('delete_milestone', { project: p, id: m }).event_id;
  t.user('upsert_todo', { project: p, id: td, milestone_id: m2 });
  expect(t.user('revert_event', { event_id: e })).toMatchObject({
    code: 'conflict',
    message: expect.stringContaining(`todos:${td}.milestone_id`),
  });
  expect(milestone(m).deleted_at).not.toBeNull();
  expect(todo(td).milestone_id).toBe(m2);
});

test('reverting a creation whose row is already deleted is a conflict', () => {
  const p = t.user('create_project', { title: 'x' }).id;
  const created = t.ai('upsert_todo', { project: p, title: 'T' });
  t.ai('delete_todo', { project: p, id: created.id });
  expect(t.user('revert_event', { event_id: created.event_id })).toMatchObject({
    code: 'conflict',
    message: expect.stringContaining(`todos:${created.id}`),
  });
  expect(todo(created.id).vetoed).toBe(0);
});

test('reverting an event whose row no longer exists is a conflict', () => {
  const p = t.ai('create_project', { title: 'x' }).id;
  const link = t.ai('link_session', { session: S, project: p });
  t.db.prepare('DELETE FROM contributions WHERE id = ?').run(link.id);
  expect(t.user('revert_event', { event_id: link.event_id })).toMatchObject({
    code: 'conflict',
    message: expect.stringContaining(`contributions:${link.id}`),
  });
});

test('reverting twice, or an unknown event, is rejected', () => {
  const p = t.ai('create_project', { title: 'x', summary: '原来的' }).id;
  const e = t.ai('update_project', { project: p, fields: { summary: 'A' } }).event_id;
  const revert = t.user('revert_event', { event_id: e }).event_id;
  expect(t.user('revert_event', { event_id: e })).toMatchObject({ status: 'rejected', code: 'already_reverted' });
  t.user('revert_event', { event_id: revert });
  expect(t.user('revert_event', { event_id: revert })).toMatchObject({ status: 'rejected', code: 'already_reverted' });
  expect(t.user('revert_event', { event_id: 999 })).toMatchObject({ status: 'rejected', code: 'not_found' });
});

// ---- reverting a revert ------------------------------------------------------------------------------------------

test('reverting a veto writes the ai value back, keeps the lock and is not a veto', () => {
  const p = t.ai('create_project', { title: 'x', summary: '原来的' }).id;
  const e = t.ai('update_project', { project: p, fields: { summary: 'AI 写的' } }).event_id;
  const revert = t.user('revert_event', { event_id: e }).event_id as number;
  const r = t.user('revert_event', { event_id: revert });
  expect(r).toMatchObject({ status: 'applied' });
  expect(project(p)).toMatchObject({ summary: 'AI 写的', locks: '["summary"]' });
  expect(event(r.event_id as number)).toMatchObject({ op: 'revert_event', actor: 'user', reverts: revert, is_veto: 0 });
  expect(event(revert).reverted_by).toBe(r.event_id);

  // A revert of a revert of a revert follows the same rule.
  const third = t.user('revert_event', { event_id: r.event_id });
  expect(third).toMatchObject({ status: 'applied' });
  expect(project(p)).toMatchObject({ summary: '原来的', locks: '["summary"]' });
  expect(lastEvent(t.db)).toMatchObject({ reverts: r.event_id, is_veto: 0 });
});

test('reverting a revert after a later change to the same column is a conflict', () => {
  const p = t.ai('create_project', { title: 'x', summary: '原来的' }).id;
  const e = t.ai('update_project', { project: p, fields: { summary: 'A' } }).event_id;
  const revert = t.user('revert_event', { event_id: e }).event_id as number;
  t.user('update_project', { project: p, fields: { summary: 'B' } });
  expect(t.user('revert_event', { event_id: revert })).toMatchObject({
    code: 'conflict',
    message: expect.stringContaining(`projects:${p}.summary`),
  });
  expect(project(p).summary).toBe('B');
});

// ---- undoing a creation the user built on --------------------------------------------------------------------------

test('undoing an ai create_project after the user only edited its fields is allowed, and can itself be undone', () => {
  const p = t.ai('create_project', { title: 'x', from_session: S });
  t.user('update_project', { project: p.id, fields: { summary: '我写的', priority: 'P0' } });
  t.setNow(LATER);
  const undo = t.user('revert_event', { event_id: p.event_id });
  expect(undo).toMatchObject({ status: 'applied' });
  expect(project(p.id)).toMatchObject({ deleted_at: LATER, vetoed: 1 });
  expect(getProject(t.db, new Date(LATER), p.id)).toBeNull();

  const redo = t.user('revert_event', { event_id: undo.event_id });
  expect(redo).toMatchObject({ status: 'applied' });
  expect(project(p.id)).toMatchObject({ deleted_at: null, vetoed: 0, summary: '我写的', priority: 'P0' });
  expect(contribution('c_1')).toMatchObject({ deleted_at: null, vetoed: 0 });
  expect(lastEvent(t.db)).toMatchObject({ reverts: undo.event_id, is_veto: 0 });
  expect(getProject(t.db, new Date(LATER), p.id)).toMatchObject({ id: p.id, summary: '我写的', priority: 'P0' });
});

test('undoing an ai create_project the user added a todo to is a conflict naming the todo', () => {
  const p = t.ai('create_project', { title: 'x' });
  const td = t.user('upsert_todo', { project: p.id, title: '我的 todo' }).id;
  const before = eventCount();
  expect(t.user('revert_event', { event_id: p.event_id })).toMatchObject({
    status: 'rejected',
    code: 'conflict',
    message: expect.stringContaining(`todos:${td}`),
  });
  expect(project(p.id).deleted_at).toBeNull();
  expect(eventCount()).toBe(before);
});

test.each([
  ['milestones', (p: string) => t.user('upsert_milestone', { project: p, title: 'M' }).id],
  ['decisions', (p: string) => t.user('record_decision', { project: p, text: '定了' }).id],
  ['blockers', (p: string) => t.user('set_blocker', { project: p, text: '卡住', kind: 'external' }).id],
  ['contributions', (p: string) => t.user('link_session', { session: S, project: p }).id],
])('undoing an ai create_project with a live user-made %s row is a conflict', (table, make) => {
  const p = t.ai('create_project', { title: 'x' });
  const id = make(p.id);
  expect(t.user('revert_event', { event_id: p.event_id })).toMatchObject({
    code: 'conflict',
    message: expect.stringContaining(`${table}:${id}`),
  });
});

test('ai-made dependents and deleted user items do not block undoing a create_project', () => {
  const p = t.ai('create_project', { title: 'x' });
  t.ai('link_session', { session: S, project: p.id });
  const aiTodo = t.ai('upsert_todo', { project: p.id, title: 'AI 的' }).id;
  const mine = t.user('upsert_todo', { project: p.id, title: '我的' }).id;
  t.user('delete_todo', { project: p.id, id: mine });
  expect(t.user('revert_event', { event_id: p.event_id })).toMatchObject({ status: 'applied' });
  expect(todo(aiTodo).deleted_at).toBeNull();
});

test('undoing a user create_project from a session is not blocked by its own link', () => {
  const p = t.user('create_project', { title: 'x', from_session: S });
  expect(contribution('c_1').actor).toBe('user');
  expect(t.user('revert_event', { event_id: p.event_id })).toMatchObject({ status: 'applied' });
  expect(contribution('c_1').deleted_at).not.toBeNull();
});

test('undoing an ai milestone the user attached a todo to is a conflict; an ai todo does not block', () => {
  const p = t.user('create_project', { title: 'x' }).id;
  const m = t.ai('upsert_milestone', { project: p, title: 'M' });
  t.ai('upsert_todo', { project: p, title: 'AI 的', milestone_id: m.id });
  const td = t.user('upsert_todo', { project: p, title: '我的', milestone_id: m.id }).id;
  expect(t.user('revert_event', { event_id: m.event_id })).toMatchObject({
    code: 'conflict',
    message: expect.stringContaining(`todos:${td}`),
  });
  t.user('upsert_todo', { project: p, id: td, milestone_id: null });
  expect(t.user('revert_event', { event_id: m.event_id })).toMatchObject({ status: 'applied' });
});

test('an event that only changed locks has nothing to revert', () => {
  const p = t.user('create_project', { title: 'x', summary: 's' }).id;
  const e = t.user('unlock_field', { table: 'projects', id: p, field: 'summary' }).event_id;
  expect(t.user('revert_event', { event_id: e })).toMatchObject({ status: 'rejected', code: 'not_revertible' });
  expect(event(e as number).reverted_by).toBeNull();
});
