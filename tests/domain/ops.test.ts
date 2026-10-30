import { expect, test } from 'vitest';
import { EVIDENCE_RE, OP_SCHEMAS } from '../../src/domain/ops.ts';
import type { OpArgs, OpName } from '../../src/domain/ops.ts';

/** One minimal valid argument object per operation. */
const MINIMAL: Record<OpName, unknown> = {
  create_project: { title: 'A' },
  update_project: { project: 'p_1', fields: { title: 'B' } },
  transition_stage: { project: 'p_1', stage: 'explore' },
  unlock_field: { table: 'projects', id: 'p_1', field: 'title' },
  upsert_milestone: { project: 'p_1' },
  upsert_todo: { project: 'p_1' },
  record_decision: { project: 'p_1', text: 'use sqlite' },
  set_blocker: { project: 'p_1' },
  delete_milestone: { project: 'p_1', id: 'm_1' },
  delete_todo: { project: 'p_1', id: 't_1' },
  delete_decision: { project: 'p_1', id: 'd_1' },
  delete_blocker: { project: 'p_1', id: 'b_1' },
  clear_blocker: { project: 'p_1', id: 'b_1' },
  link_session: { session: 'claude:abc', project: 'p_1' },
  unlink_session: { session: 'claude:abc', project: 'p_1' },
  ignore_session: { session: 'claude:abc' },
  revert_event: { event_id: 1 },
};

const OPS = Object.keys(OP_SCHEMAS) as OpName[];

test('every operation accepts its minimal arguments and rejects unknown keys', () => {
  expect([...OPS].sort()).toEqual(Object.keys(MINIMAL).sort());
  for (const op of OPS) {
    expect(OP_SCHEMAS[op].safeParse(MINIMAL[op]).success, `${op} minimal`).toBe(true);
    const withExtra = { ...(MINIMAL[op] as object), bogus: 1 };
    expect(OP_SCHEMAS[op].safeParse(withExtra).success, `${op} strict`).toBe(false);
    expect(OP_SCHEMAS[op].safeParse({}).success, `${op} empty`).toBe(false);
  }
});

test('schemas are strict and trim-check text', () => {
  expect(OP_SCHEMAS.create_project.safeParse({ title: '  ' }).success).toBe(false);
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', bogus: 1 }).success).toBe(false);
  expect(OP_SCHEMAS.update_project.safeParse({ project: 'p_1', fields: {} }).success).toBe(false);
});

test('text is trimmed and length-limited', () => {
  const parsed = OP_SCHEMAS.create_project.parse({ title: '  Hello  ', summary: ' s ' });
  expect(parsed.title).toBe('Hello');
  expect(parsed.summary).toBe('s');
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x'.repeat(200) }).success).toBe(true);
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', summary: 'x'.repeat(4000) }).success).toBe(true);
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', summary: 'x'.repeat(4001) }).success).toBe(false);
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', summary: '   ' }).success).toBe(false);
  expect(OP_SCHEMAS.record_decision.safeParse({ project: 'p_1', text: '\n\t ' }).success).toBe(false);
  expect(OP_SCHEMAS.upsert_todo.safeParse({ project: 'p_1', title: ' ' }).success).toBe(false);
});

test('ids must be non-empty strings', () => {
  expect(OP_SCHEMAS.transition_stage.safeParse({ project: '', stage: 'build' }).success).toBe(false);
  expect(OP_SCHEMAS.delete_todo.safeParse({ project: 'p_1', id: '' }).success).toBe(false);
  expect(OP_SCHEMAS.delete_todo.safeParse({ project: 'p_1', id: 5 }).success).toBe(false);
});

test('priority is P0-P3 or null', () => {
  for (const priority of ['P0', 'P1', 'P2', 'P3', null]) {
    expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', priority }).success).toBe(true);
    expect(OP_SCHEMAS.upsert_todo.safeParse({ project: 'p_1', priority }).success).toBe(true);
    expect(OP_SCHEMAS.update_project.safeParse({ project: 'p_1', fields: { priority } }).success).toBe(true);
  }
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', priority: 'P4' }).success).toBe(false);
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', priority: 'p1' }).success).toBe(false);
});

test('stage must be a known stage', () => {
  for (const stage of ['idea', 'explore', 'build', 'verify', 'done', 'parked', 'abandoned', 'merged']) {
    expect(OP_SCHEMAS.transition_stage.safeParse({ project: 'p_1', stage }).success).toBe(true);
  }
  expect(OP_SCHEMAS.transition_stage.safeParse({ project: 'p_1', stage: 'launch' }).success).toBe(false);
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', stage: 'launch' }).success).toBe(false);
  expect(OP_SCHEMAS.transition_stage.safeParse({ project: 'p_1', stage: 'merged', merge_into: 'p_2' }).success).toBe(true);
});

test('update_project needs at least one real field and only accepts project fields', () => {
  expect(OP_SCHEMAS.update_project.safeParse({ project: 'p_1', fields: { title: undefined } }).success).toBe(false);
  expect(OP_SCHEMAS.update_project.safeParse({ project: 'p_1', fields: { priority: null } }).success).toBe(true);
  expect(OP_SCHEMAS.update_project.safeParse({ project: 'p_1', fields: { stage: 'build' } }).success).toBe(false);
  expect(OP_SCHEMAS.update_project.safeParse({ project: 'p_1', fields: { title: 'x'.repeat(201) } }).success).toBe(false);
  expect(OP_SCHEMAS.update_project.safeParse({ project: 'p_1' }).success).toBe(false);
});

test('unlock_field only covers projects, todos and milestones', () => {
  for (const table of ['projects', 'todos', 'milestones']) {
    expect(OP_SCHEMAS.unlock_field.safeParse({ table, id: 'x', field: 'title' }).success).toBe(true);
  }
  expect(OP_SCHEMAS.unlock_field.safeParse({ table: 'decisions', id: 'x', field: 'text' }).success).toBe(false);
  expect(OP_SCHEMAS.unlock_field.safeParse({ table: 'projects', id: 'x', field: '' }).success).toBe(false);
});

test('milestone and todo fields', () => {
  expect(OP_SCHEMAS.upsert_milestone.safeParse({ project: 'p_1', status: 'doing', position: 0 }).success).toBe(true);
  expect(OP_SCHEMAS.upsert_milestone.safeParse({ project: 'p_1', status: 'blocked' }).success).toBe(false);
  expect(OP_SCHEMAS.upsert_milestone.safeParse({ project: 'p_1', position: -1 }).success).toBe(false);
  expect(OP_SCHEMAS.upsert_milestone.safeParse({ project: 'p_1', position: 1.5 }).success).toBe(false);
  expect(OP_SCHEMAS.upsert_todo.safeParse({ project: 'p_1', milestone_id: null }).success).toBe(true);
  expect(OP_SCHEMAS.upsert_todo.safeParse({ project: 'p_1', milestone_id: 'm_1', status: 'done' }).success).toBe(true);
  expect(OP_SCHEMAS.upsert_todo.safeParse({ project: 'p_1', milestone_id: '' }).success).toBe(false);
});

test('blocker kind', () => {
  for (const kind of ['user', 'external', 'technical']) {
    expect(OP_SCHEMAS.set_blocker.safeParse({ project: 'p_1', kind }).success).toBe(true);
  }
  expect(OP_SCHEMAS.set_blocker.safeParse({ project: 'p_1', kind: 'other' }).success).toBe(false);
});

test('link_session fields', () => {
  const ok = { session: 'claude:abc', project: 'p_1' };
  expect(OP_SCHEMAS.link_session.safeParse({ ...ok, milestone_id: null, summary: 's', confidence: 0 }).success).toBe(true);
  expect(OP_SCHEMAS.link_session.safeParse({ ...ok, confidence: 1 }).success).toBe(true);
  expect(OP_SCHEMAS.link_session.safeParse({ ...ok, confidence: 1.01 }).success).toBe(false);
  expect(OP_SCHEMAS.link_session.safeParse({ ...ok, confidence: -0.1 }).success).toBe(false);
  expect(OP_SCHEMAS.link_session.safeParse({ ...ok, ts_start: 'yesterday' }).success).toBe(false);
  expect(OP_SCHEMAS.link_session.safeParse({ ...ok, ts_start: '2026-10-29T10:00:00.000Z', ts_end: '2026-10-29T11:00:00.000Z' }).success).toBe(true);
});

test('timestamps are validated and normalised to toISOString format', () => {
  const parsed = OP_SCHEMAS.record_decision.parse({ project: 'p_1', text: 'x', decided_at: '2026-10-29T10:00:00Z' });
  expect(parsed.decided_at).toBe('2026-10-29T10:00:00.000Z');
  expect(OP_SCHEMAS.record_decision.safeParse({ project: 'p_1', text: 'x', decided_at: '2026-10-29' }).success).toBe(false);
  expect(OP_SCHEMAS.record_decision.safeParse({ project: 'p_1', text: 'x', decided_at: 'soon' }).success).toBe(false);
});

test('ignore_session defaults to ignoring', () => {
  const parsed: OpArgs<'ignore_session'> = OP_SCHEMAS.ignore_session.parse({ session: 'claude:abc' });
  expect(parsed.ignored).toBe(true);
  expect(OP_SCHEMAS.ignore_session.parse({ session: 'claude:abc', ignored: false }).ignored).toBe(false);
  expect(OP_SCHEMAS.ignore_session.safeParse({ session: 'claude:abc', ignored: 'no' }).success).toBe(false);
});

test('revert_event needs a positive integer', () => {
  expect(OP_SCHEMAS.revert_event.safeParse({ event_id: 0 }).success).toBe(false);
  expect(OP_SCHEMAS.revert_event.safeParse({ event_id: -3 }).success).toBe(false);
  expect(OP_SCHEMAS.revert_event.safeParse({ event_id: 1.5 }).success).toBe(false);
  expect(OP_SCHEMAS.revert_event.safeParse({ event_id: '4' }).success).toBe(false);
  expect(OP_SCHEMAS.revert_event.safeParse({ event_id: 4 }).success).toBe(true);
});

test('evidence format', () => {
  expect(['chunk:123#L40', 'digest:4812'].every((e) => EVIDENCE_RE.test(e))).toBe(true);
  expect(EVIDENCE_RE.test('see chat')).toBe(false);
});

test('evidence format edge cases', () => {
  for (const ok of ['event:12', 'question:q_ab12', 'chunk:1#L1-L9', 'digest:abc_DEF9']) {
    expect(EVIDENCE_RE.test(ok), ok).toBe(true);
  }
  for (const bad of ['chunk:1#', 'chunk:', 'chunk:12#L 40', 'chunk:12 ', ' chunk:12', 'file:12', 'chunk:a-b', 'chunk:1\nchunk:2']) {
    expect(EVIDENCE_RE.test(bad), JSON.stringify(bad)).toBe(false);
  }
});
