import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  askUser,
  AskUserInput,
  confirmOptions,
  createQuestion,
  expireQuestions,
  guardsHold,
  MAX_PENDING_AI_QUESTIONS,
  QUESTION_TTL_DAYS,
  REJECT_COOLDOWN_DAYS,
  setArgPath,
  USER_ONLY_OPS,
  withdrawStale,
} from '../../src/domain/questions.ts';
import type { QuestionDraft } from '../../src/domain/questions.ts';
import { OpRejected } from '../../src/domain/types.ts';
import type { DomainDeps } from '../../src/domain/types.ts';
import { openDb } from '../../src/server/db.ts';

const NOW = '2026-10-29T10:00:00.000Z';
const DAY_MS = 86_400_000;

let db: DatabaseSync;
let clock: Date;
let counter: number;
let deps: DomainDeps;

beforeEach(() => {
  db = openDb(':memory:');
  clock = new Date(NOW);
  counter = 0;
  deps = { now: () => clock, newId: (prefix) => `${prefix}_${++counter}` };
});

afterEach(() => {
  db.close();
});

function daysAgo(days: number): string {
  return new Date(new Date(NOW).getTime() - days * DAY_MS).toISOString();
}

let keySeq = 0;

function draft(overrides: Partial<QuestionDraft> = {}): QuestionDraft {
  return {
    kind: 'confirm',
    prompt: '完成这个项目吗？',
    options: confirmOptions('transition_stage', { project: 'p_1', stage: 'done' }),
    project_id: 'p_1',
    session_key: null,
    evidence: ['chunk:1'],
    guards: [],
    dedupe_key: `key-${++keySeq}`,
    created_by: 'ai:curator',
    ...overrides,
  };
}

type Row = Record<string, unknown>;

function question(id: string): Row {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!row) throw new Error(`no question ${id}`);
  return { ...row };
}

function evidenceOf(id: string): unknown {
  return JSON.parse(question(id).evidence as string);
}

function countQuestions(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n;
}

function seedProject(id = 'p_1', title = 'A'): void {
  db.prepare('INSERT INTO projects (id, title) VALUES (?, ?)').run(id, title);
}

/** Marks a question as the user rejected it at `resolvedAt`, the way answering it will (Task 8). */
function reject(id: string, resolvedAt: string): void {
  db.prepare("UPDATE questions SET status = 'answered', rejected = 1, resolved_at = ? WHERE id = ?").run(resolvedAt, id);
}

// createQuestion: storage

test('a new question is stored pending with its json columns, id from newId and created_at from now', () => {
  const d = draft({
    session_key: 'claude:abc',
    guards: [{ table: 'projects', id: 'p_1', col: 'stage', equals: 'build' }],
    dedupe_key: 'k-store',
  });
  expect(createQuestion(db, deps, d)).toEqual({ id: 'q_1', deduped: false });
  const row = question('q_1');
  expect(row).toMatchObject({
    kind: 'confirm',
    prompt: '完成这个项目吗？',
    project_id: 'p_1',
    session_key: 'claude:abc',
    status: 'pending',
    answer: null,
    dedupe_key: 'k-store',
    rejected: 0,
    resolution_note: null,
    created_by: 'ai:curator',
    created_at: NOW,
    resolved_at: null,
  });
  expect(JSON.parse(row.options as string)).toEqual([
    { label: '确认', op: 'transition_stage', args: { project: 'p_1', stage: 'done' } },
    { label: '拒绝', op: null },
  ]);
  expect(JSON.parse(row.guards as string)).toEqual(d.guards);
  expect(evidenceOf('q_1')).toEqual(['chunk:1']);
});

test('duplicate evidence in a new question is stored once', () => {
  const { id } = createQuestion(db, deps, draft({ evidence: ['chunk:1', 'chunk:2', 'chunk:1'] }));
  expect(evidenceOf(id)).toEqual(['chunk:1', 'chunk:2']);
});

// createQuestion: dedupe

test('same dedupe_key while pending appends evidence instead of creating a second question', () => {
  const a = createQuestion(db, deps, draft({ dedupe_key: 'k', evidence: ['chunk:1'] }));
  const b = createQuestion(db, deps, draft({ dedupe_key: 'k', evidence: ['chunk:2', 'chunk:1'] }));
  expect(b).toEqual({ id: a.id, deduped: true });
  expect(evidenceOf(a.id)).toEqual(['chunk:1', 'chunk:2']);
  expect(countQuestions()).toBe(1);
});

test('a resolved question does not absorb a new one with the same dedupe_key', () => {
  const a = createQuestion(db, deps, draft({ dedupe_key: 'k' }));
  db.prepare("UPDATE questions SET status = 'answered' WHERE id = ?").run(a.id);
  const b = createQuestion(db, deps, draft({ dedupe_key: 'k' }));
  expect(b.deduped).toBe(false);
  expect(b.id).not.toBe(a.id);
});

test('deduping is not blocked by the pending-question cap', () => {
  const first = createQuestion(db, deps, draft({ dedupe_key: 'k-first' }));
  for (let i = 1; i < MAX_PENDING_AI_QUESTIONS; i++) createQuestion(db, deps, draft());
  expect(() => createQuestion(db, deps, draft())).toThrow(OpRejected);
  expect(createQuestion(db, deps, draft({ dedupe_key: 'k-first', evidence: ['chunk:9'] }))).toEqual({
    id: first.id,
    deduped: true,
  });
  expect(evidenceOf(first.id)).toEqual(['chunk:1', 'chunk:9']);
});

// createQuestion: option validation

test('option args are validated against the op schema at creation', () => {
  expect(() =>
    createQuestion(db, deps, draft({ options: [{ label: 'x', op: 'update_project', args: { project: 'p_1' } }] })),
  ).toThrow(/invalid/);
  expect(countQuestions()).toBe(0);
});

test('an invalid option is rejected with code invalid', () => {
  const attempt = () =>
    createQuestion(db, deps, draft({ options: [{ label: 'x', op: 'transition_stage', args: { project: 'p_1', stage: 'nope' } }] }));
  expect(attempt).toThrow(OpRejected);
  try {
    attempt();
  } catch (e) {
    expect(e).toMatchObject({ name: 'OpRejected', code: 'invalid' });
  }
});

test('an option without args is checked against an empty object', () => {
  expect(() => createQuestion(db, deps, draft({ options: [{ label: 'x', op: 'ignore_session' }] }))).toThrow(/invalid/);
});

test('an option with op null needs no args, and cannot carry text_arg', () => {
  expect(createQuestion(db, deps, draft({ options: [{ label: '算了', op: null }] })).deduped).toBe(false);
  expect(() => createQuestion(db, deps, draft({ options: [{ label: 'x', op: null, text_arg: 'title' }] }))).toThrow(/invalid/);
});

test('an unknown op is rejected', () => {
  const options = [{ label: 'x', op: 'drop_table' as never, args: {} }];
  expect(() => createQuestion(db, deps, draft({ options }))).toThrow(/invalid/);
});

test('text_arg is filled with a placeholder before validating, including nested paths', () => {
  const nested = { label: '补充完成标准', op: 'update_project' as const, args: { project: 'p_1', fields: {} }, text_arg: 'fields.done_criteria' };
  expect(createQuestion(db, deps, draft({ kind: 'text', options: [nested] })).deduped).toBe(false);
  const top = { label: '记录决策', op: 'record_decision' as const, args: { project: 'p_1' }, text_arg: 'text' };
  expect(createQuestion(db, deps, draft({ kind: 'text', options: [top] })).deduped).toBe(false);
});

test('text_arg that cannot hold free text is rejected', () => {
  const badTarget = { label: 'x', op: 'update_project' as const, args: { project: 'p_1', fields: {} }, text_arg: 'fields.priority' };
  expect(() => createQuestion(db, deps, draft({ kind: 'text', options: [badTarget] }))).toThrow(/invalid/);
  const unknownTarget = { label: 'x', op: 'update_project' as const, args: { project: 'p_1', fields: {} }, text_arg: 'fields.nope' };
  expect(() => createQuestion(db, deps, draft({ kind: 'text', options: [unknownTarget] }))).toThrow(/invalid/);
  const badPath = { label: 'x', op: 'record_decision' as const, args: { project: 'p_1' }, text_arg: 'a..b' };
  expect(() => createQuestion(db, deps, draft({ kind: 'text', options: [badPath] }))).toThrow(/invalid/);
});

test('the stored option keeps the original args, not the placeholder', () => {
  const opt = { label: '补充', op: 'update_project' as const, args: { project: 'p_1', fields: {} }, text_arg: 'fields.done_criteria' };
  const { id } = createQuestion(db, deps, draft({ kind: 'text', options: [opt] }));
  expect(JSON.parse(question(id).options as string)).toEqual([opt]);
});

// createQuestion: cap

test('ai questions are capped at MAX_PENDING_AI_QUESTIONS; user-created are not', () => {
  for (let i = 0; i < MAX_PENDING_AI_QUESTIONS; i++) createQuestion(db, deps, draft());
  try {
    createQuestion(db, deps, draft());
    expect.unreachable('the 31st ai question should be rejected');
  } catch (e) {
    expect(e).toBeInstanceOf(OpRejected);
    expect((e as OpRejected).code).toBe('question_limit');
  }
  expect(countQuestions()).toBe(MAX_PENDING_AI_QUESTIONS);
  expect(createQuestion(db, deps, draft({ created_by: 'user' })).deduped).toBe(false);
  expect(countQuestions()).toBe(MAX_PENDING_AI_QUESTIONS + 1);
});

test('only pending ai questions count towards the cap', () => {
  createQuestion(db, deps, draft({ created_by: 'user' }));
  const ids: string[] = [];
  for (let i = 0; i < MAX_PENDING_AI_QUESTIONS - 1; i++) ids.push(createQuestion(db, deps, draft()).id);
  // 29 ai + 1 user pending: still room for one more ai question
  expect(createQuestion(db, deps, draft()).deduped).toBe(false);
  expect(() => createQuestion(db, deps, draft())).toThrow(OpRejected);
  // resolving one frees a slot
  db.prepare("UPDATE questions SET status = 'withdrawn' WHERE id = ?").run(ids[0]);
  expect(createQuestion(db, deps, draft()).deduped).toBe(false);
});

test('createQuestion expires questions past their time limit first, so they neither hold cap slots nor absorb a new one', () => {
  const old: string[] = [];
  for (let i = 0; i < MAX_PENDING_AI_QUESTIONS; i++) old.push(createQuestion(db, deps, draft({ dedupe_key: `old-${i}` })).id);
  db.prepare('UPDATE questions SET created_at = ?').run(daysAgo(QUESTION_TTL_DAYS + 1));

  const fresh = createQuestion(db, deps, draft({ dedupe_key: 'old-0', evidence: ['chunk:9'] }));
  expect(fresh.deduped).toBe(false);
  expect(question(old[0])).toMatchObject({ status: 'expired', resolved_at: NOW });
  expect(evidenceOf(old[0])).toEqual(['chunk:1']);
  expect(question(old[MAX_PENDING_AI_QUESTIONS - 1]).status).toBe('expired');
});

test('pending ai questions about a deleted project do not count towards the cap', () => {
  seedProject('p_gone', 'gone');
  seedProject('p_live', 'live');
  for (let i = 0; i < MAX_PENDING_AI_QUESTIONS; i++) createQuestion(db, deps, draft({ project_id: 'p_gone' }));
  expect(() => createQuestion(db, deps, draft({ project_id: 'p_live' }))).toThrow(OpRejected);

  db.prepare("UPDATE projects SET deleted_at = ? WHERE id = 'p_gone'").run(NOW);
  expect(createQuestion(db, deps, draft({ project_id: 'p_live' })).deduped).toBe(false);
  // Questions with no project still count.
  for (let i = 1; i < MAX_PENDING_AI_QUESTIONS; i++) createQuestion(db, deps, draft({ project_id: null }));
  expect(() => createQuestion(db, deps, draft({ project_id: null }))).toThrow(OpRejected);
});

// createQuestion: cooldown

test('a question rejected within REJECT_COOLDOWN_DAYS blocks the same dedupe_key; after the cooldown it is allowed', () => {
  const a = createQuestion(db, deps, draft({ dedupe_key: 'k' }));
  reject(a.id, daysAgo(REJECT_COOLDOWN_DAYS - 1));
  try {
    createQuestion(db, deps, draft({ dedupe_key: 'k' }));
    expect.unreachable('should be in cooldown');
  } catch (e) {
    expect(e).toBeInstanceOf(OpRejected);
    expect((e as OpRejected).code).toBe('recently_rejected');
  }
  expect(countQuestions()).toBe(1);

  reject(a.id, daysAgo(REJECT_COOLDOWN_DAYS + 1));
  expect(createQuestion(db, deps, draft({ dedupe_key: 'k' })).deduped).toBe(false);
});

test('the cooldown starts when the user rejected, not when the question was created', () => {
  const a = createQuestion(db, deps, draft({ dedupe_key: 'k' }));
  db.prepare('UPDATE questions SET created_at = ? WHERE id = ?').run(daysAgo(20), a.id);
  reject(a.id, daysAgo(1));
  expect(() => createQuestion(db, deps, draft({ dedupe_key: 'k' }))).toThrow(OpRejected);
});

test('the cooldown only covers rejections of the same dedupe_key', () => {
  const a = createQuestion(db, deps, draft({ dedupe_key: 'k' }));
  reject(a.id, daysAgo(1));
  expect(createQuestion(db, deps, draft({ dedupe_key: 'other' })).deduped).toBe(false);
});

test('answered or withdrawn questions that were not rejected do not start a cooldown', () => {
  const a = createQuestion(db, deps, draft({ dedupe_key: 'k' }));
  db.prepare("UPDATE questions SET status = 'answered', resolved_at = ? WHERE id = ?").run(daysAgo(1), a.id);
  const b = createQuestion(db, deps, draft({ dedupe_key: 'k' }));
  db.prepare("UPDATE questions SET status = 'withdrawn', resolution_note = 'stale', resolved_at = ? WHERE id = ?").run(daysAgo(1), b.id);
  expect(createQuestion(db, deps, draft({ dedupe_key: 'k' })).deduped).toBe(false);
});

test('a rejection within the cooldown also blocks user-created questions', () => {
  const a = createQuestion(db, deps, draft({ dedupe_key: 'k' }));
  reject(a.id, daysAgo(1));
  expect(() => createQuestion(db, deps, draft({ dedupe_key: 'k', created_by: 'user' }))).toThrow(OpRejected);
});

// guardsHold

test('guardsHold is true only while every guard row still has the expected value', () => {
  seedProject('p_1', 'A');
  const guard = { table: 'projects' as const, id: 'p_1', col: 'title', equals: 'A' };
  expect(guardsHold(db, [])).toBe(true);
  expect(guardsHold(db, [guard])).toBe(true);
  db.prepare("UPDATE projects SET title = 'B' WHERE id = 'p_1'").run();
  expect(guardsHold(db, [guard])).toBe(false);
  db.prepare("UPDATE projects SET title = 'A' WHERE id = 'p_1'").run();
  seedProject('p_2', 'Z');
  expect(guardsHold(db, [guard, { table: 'projects', id: 'p_2', col: 'title', equals: 'Z' }])).toBe(true);
  expect(guardsHold(db, [guard, { table: 'projects', id: 'p_2', col: 'title', equals: 'Y' }])).toBe(false);
});

test('guardsHold fails for a missing row or an unknown column, and matches null with null', () => {
  seedProject();
  expect(guardsHold(db, [{ table: 'projects', id: 'p_missing', col: 'title', equals: 'A' }])).toBe(false);
  expect(guardsHold(db, [{ table: 'projects', id: 'p_1', col: 'nope', equals: 'A' }])).toBe(false);
  expect(guardsHold(db, [{ table: 'projects', id: 'p_1', col: 'nope', equals: null }])).toBe(false);
  expect(guardsHold(db, [{ table: 'projects', id: 'p_1', col: 'stage', equals: null }])).toBe(true);
  expect(guardsHold(db, [{ table: 'projects', id: 'p_1', col: 'stage', equals: 'build' }])).toBe(false);
  expect(guardsHold(db, [{ table: 'projects', id: 'p_1', col: 'user_touched', equals: 0 }])).toBe(true);
});

test('guardsHold reads sessions by their key', () => {
  db.prepare("INSERT INTO sessions (key) VALUES ('claude:abc')").run();
  expect(guardsHold(db, [{ table: 'sessions', id: 'claude:abc', col: 'key', equals: 'claude:abc' }])).toBe(true);
  expect(guardsHold(db, [{ table: 'sessions', id: 'claude:zzz', col: 'key', equals: 'claude:zzz' }])).toBe(false);
});

// withdrawStale

test('withdrawStale withdraws questions whose guard no longer holds and leaves others', () => {
  seedProject('p_1', 'A');
  seedProject('p_2', 'C');
  const q1 = createQuestion(db, deps, draft({ guards: [{ table: 'projects', id: 'p_1', col: 'title', equals: 'A' }] })).id;
  const q2 = createQuestion(db, deps, draft({ guards: [{ table: 'projects', id: 'p_2', col: 'title', equals: 'C' }] })).id;
  const q3 = createQuestion(db, deps, draft({ guards: [] })).id;
  db.prepare("UPDATE projects SET title = 'B' WHERE id = 'p_1'").run();
  clock = new Date('2026-10-29T11:00:00.000Z');

  expect(withdrawStale(db, deps, [{ table: 'projects', id: 'p_1' }])).toEqual([q1]);

  expect(question(q1)).toMatchObject({ status: 'withdrawn', resolution_note: 'stale', resolved_at: '2026-10-29T11:00:00.000Z', rejected: 0 });
  expect(question(q2)).toMatchObject({ status: 'pending', resolution_note: null, resolved_at: null });
  expect(question(q3)).toMatchObject({ status: 'pending', resolution_note: null });
});

test('withdrawStale leaves a question alone when its guards still hold', () => {
  seedProject();
  const q = createQuestion(db, deps, draft({ guards: [{ table: 'projects', id: 'p_1', col: 'title', equals: 'A' }] })).id;
  expect(withdrawStale(db, deps, [{ table: 'projects', id: 'p_1' }])).toEqual([]);
  expect(question(q).status).toBe('pending');
});

test('withdrawStale only looks at questions guarding a touched row', () => {
  seedProject('p_1', 'A');
  seedProject('p_2', 'C');
  const q = createQuestion(db, deps, draft({ guards: [{ table: 'projects', id: 'p_2', col: 'title', equals: 'C' }] })).id;
  db.prepare("UPDATE projects SET title = 'changed' WHERE id = 'p_2'").run();
  expect(withdrawStale(db, deps, [{ table: 'projects', id: 'p_1' }])).toEqual([]);
  expect(question(q).status).toBe('pending');
  expect(withdrawStale(db, deps, [{ table: 'projects', id: 'p_2' }])).toEqual([q]);
});

test('withdrawStale re-checks every guard of a touched question and handles a deleted row', () => {
  seedProject('p_1', 'A');
  seedProject('p_2', 'C');
  const q = createQuestion(db, deps, {
    ...draft(),
    guards: [
      { table: 'projects', id: 'p_1', col: 'title', equals: 'A' },
      { table: 'projects', id: 'p_2', col: 'title', equals: 'C' },
    ],
  }).id;
  db.prepare("DELETE FROM projects WHERE id = 'p_2'").run();
  expect(withdrawStale(db, deps, [{ table: 'projects', id: 'p_1' }])).toEqual([q]);
});

test('withdrawStale ignores resolved questions and an empty touched list, and returns ids oldest first', () => {
  seedProject();
  const guards = [{ table: 'projects' as const, id: 'p_1', col: 'title', equals: 'A' }];
  const done = createQuestion(db, deps, draft({ guards })).id;
  db.prepare("UPDATE questions SET status = 'answered' WHERE id = ?").run(done);
  const a = createQuestion(db, deps, draft({ guards })).id;
  const b = createQuestion(db, deps, draft({ guards })).id;
  db.prepare("UPDATE projects SET title = 'B' WHERE id = 'p_1'").run();

  expect(withdrawStale(db, deps, [])).toEqual([]);
  expect(withdrawStale(db, deps, [{ table: 'projects', id: 'p_1' }])).toEqual([a, b]);
  expect(question(done).status).toBe('answered');
  expect(withdrawStale(db, deps, [{ table: 'projects', id: 'p_1' }])).toEqual([]);
});

test('a withdrawn stale question does not start a cooldown', () => {
  seedProject();
  const guards = [{ table: 'projects' as const, id: 'p_1', col: 'title', equals: 'A' }];
  createQuestion(db, deps, draft({ dedupe_key: 'k', guards }));
  db.prepare("UPDATE projects SET title = 'B' WHERE id = 'p_1'").run();
  withdrawStale(db, deps, [{ table: 'projects', id: 'p_1' }]);
  expect(createQuestion(db, deps, draft({ dedupe_key: 'k' })).deduped).toBe(false);
});

// expireQuestions

test('expireQuestions expires pending questions older than QUESTION_TTL_DAYS', () => {
  const old = createQuestion(db, deps, draft()).id;
  const fresh = createQuestion(db, deps, draft()).id;
  const answered = createQuestion(db, deps, draft()).id;
  db.prepare('UPDATE questions SET created_at = ? WHERE id = ?').run(daysAgo(QUESTION_TTL_DAYS + 1), old);
  db.prepare('UPDATE questions SET created_at = ? WHERE id = ?').run(daysAgo(QUESTION_TTL_DAYS - 1), fresh);
  db.prepare("UPDATE questions SET created_at = ?, status = 'answered' WHERE id = ?").run(daysAgo(QUESTION_TTL_DAYS + 5), answered);

  expect(expireQuestions(db, deps)).toBe(1);

  expect(question(old)).toMatchObject({ status: 'expired', resolved_at: NOW, rejected: 0 });
  expect(question(fresh).status).toBe('pending');
  expect(question(answered).status).toBe('answered');
  expect(expireQuestions(db, deps)).toBe(0);
});

test('an expired question frees its dedupe_key and its cap slot', () => {
  const old = createQuestion(db, deps, draft({ dedupe_key: 'k' })).id;
  db.prepare('UPDATE questions SET created_at = ? WHERE id = ?').run(daysAgo(QUESTION_TTL_DAYS + 1), old);
  expireQuestions(db, deps);
  expect(createQuestion(db, deps, draft({ dedupe_key: 'k' })).deduped).toBe(false);
});

// setArgPath / confirmOptions

test('setArgPath sets a top-level key and returns a new object', () => {
  const args = { project: 'p_1' };
  const out = setArgPath(args, 'text', 'hi');
  expect(out).toEqual({ project: 'p_1', text: 'hi' });
  expect(args).toEqual({ project: 'p_1' });
});

test('setArgPath sets nested keys, keeping siblings and not touching the original', () => {
  const args = { project: 'p_1', fields: { title: 'T' } };
  const out = setArgPath(args, 'fields.done_criteria', 'ship it');
  expect(out).toEqual({ project: 'p_1', fields: { title: 'T', done_criteria: 'ship it' } });
  expect(args).toEqual({ project: 'p_1', fields: { title: 'T' } });
  expect(out.fields).not.toBe(args.fields);
});

test('setArgPath creates missing parents and replaces a parent that is not an object', () => {
  expect(setArgPath({ project: 'p_1' }, 'fields.done_criteria', 'x')).toEqual({ project: 'p_1', fields: { done_criteria: 'x' } });
  expect(setArgPath({ fields: 'oops' }, 'fields.done_criteria', 'x')).toEqual({ fields: { done_criteria: 'x' } });
  expect(setArgPath({}, 'a.b.c', 1)).toEqual({ a: { b: { c: 1 } } });
});

test('setArgPath rejects malformed paths with code invalid', () => {
  for (const path of ['', 'a..b', '.a', 'a.', 'a b', 'a-b']) {
    expect(() => setArgPath({}, path, 'x'), path).toThrow(OpRejected);
  }
});

test('confirmOptions pairs the op with a 拒绝 option that does nothing', () => {
  const args = { project: 'p_1', stage: 'done' };
  expect(confirmOptions('transition_stage', args)).toEqual([
    { label: '确认', op: 'transition_stage', args },
    { label: '拒绝', op: null },
  ]);
});

// askUser

const askBase = { prompt: '这个 session 属于哪个项目？', evidence: ['chunk:12#L40'] };
const linkOption = { label: '关联到 p_1', op: 'link_session', args: { session: 'claude:abc', project: 'p_1' } };

test('askUser choice stores the question and reports it as proposed', () => {
  const options = [linkOption, { label: '都不是', op: null }];
  const input = { kind: 'choice', ...askBase, project_id: 'p_1', session_key: 'claude:abc', options };
  expect(askUser(db, deps, input, 'ai:curator')).toEqual({ status: 'proposed', question_ids: ['q_1'] });
  expect(question('q_1')).toMatchObject({
    kind: 'choice',
    prompt: askBase.prompt,
    project_id: 'p_1',
    session_key: 'claude:abc',
    status: 'pending',
    created_by: 'ai:curator',
    dedupe_key: 'ask:p_1:claude:abc:choice',
  });
  expect(JSON.parse(question('q_1').options as string)).toEqual(options);
  expect(JSON.parse(question('q_1').guards as string)).toEqual([]);
  expect(evidenceOf('q_1')).toEqual(['chunk:12#L40']);
});

test('askUser confirm appends the 拒绝 option and text requires text_arg', () => {
  const confirm = { kind: 'confirm', ...askBase, option: { label: '开工', op: 'transition_stage', args: { project: 'p_1', stage: 'build' } } };
  expect(askUser(db, deps, confirm, 'ai:curator')).toMatchObject({ status: 'proposed' });
  expect(JSON.parse(question('q_1').options as string)).toEqual([
    { label: '开工', op: 'transition_stage', args: { project: 'p_1', stage: 'build' } },
    { label: '拒绝', op: null },
  ]);

  const textOption = { label: '补充', op: 'update_project', args: { project: 'p_1', fields: {} } };
  const missing = askUser(db, deps, { kind: 'text', ...askBase, option: textOption }, 'ai:curator');
  expect(missing).toMatchObject({ status: 'rejected', code: 'invalid' });
  const ok = askUser(db, deps, { kind: 'text', ...askBase, option: { ...textOption, text_arg: 'fields.done_criteria' } }, 'ai:curator');
  expect(ok).toMatchObject({ status: 'proposed' });
  expect(JSON.parse(question('q_2').options as string)).toEqual([{ ...textOption, text_arg: 'fields.done_criteria' }]);
});

test('askUser requires the confirm option to have an op and no text_arg', () => {
  const noOp = { kind: 'confirm', ...askBase, option: { label: '好', op: null } };
  expect(askUser(db, deps, noOp, 'ai:curator')).toMatchObject({ status: 'rejected', code: 'invalid' });
  const withText = {
    kind: 'confirm',
    ...askBase,
    option: { label: '好', op: 'record_decision', args: { project: 'p_1' }, text_arg: 'text' },
  };
  expect(askUser(db, deps, withText, 'ai:curator')).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(countQuestions()).toBe(0);
});

test('askUser choice needs between 2 and 6 options', () => {
  const opt = (n: number) => ({ label: `o${n}`, op: null });
  const ask = (n: number) =>
    askUser(db, deps, { kind: 'choice', ...askBase, topic: `t${n}`, options: Array.from({ length: n }, (_, i) => opt(i)) }, 'ai:curator');
  expect(ask(1)).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(ask(2)).toMatchObject({ status: 'proposed' });
  expect(ask(6)).toMatchObject({ status: 'proposed' });
  expect(ask(7)).toMatchObject({ status: 'rejected', code: 'invalid' });
});

test('askUser requires at least one well-formed evidence entry', () => {
  const options = [linkOption, { label: '否', op: null }];
  const ask = (evidence: unknown) => askUser(db, deps, { kind: 'choice', prompt: 'q?', options, evidence }, 'ai:curator');
  expect(ask([])).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(ask(['just some text'])).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(ask(['chunk:1', 'bogus'])).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(ask(undefined)).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(ask(['digest:4812', 'question:q_ab12'])).toMatchObject({ status: 'proposed' });
});

test('askUser rejects unknown keys, unknown kinds and non-objects without throwing', () => {
  const options = [linkOption, { label: '否', op: null }];
  expect(askUser(db, deps, { kind: 'choice', ...askBase, options, extra: 1 }, 'ai:curator')).toMatchObject({ code: 'invalid' });
  expect(askUser(db, deps, { kind: 'poll', ...askBase, options }, 'ai:curator')).toMatchObject({ code: 'invalid' });
  expect(askUser(db, deps, null, 'ai:curator')).toMatchObject({ code: 'invalid' });
  expect(askUser(db, deps, 'hello', 'ai:curator')).toMatchObject({ code: 'invalid' });
});

test('an ai may not ask its own way to close, merge or park a project; those come only from domain proposals', () => {
  for (const stage of ['done', 'abandoned', 'merged', 'parked']) {
    const args = { project: 'p_1', stage, ...(stage === 'merged' ? { merge_into: 'p_2' } : {}) };
    const confirm = { kind: 'confirm', ...askBase, topic: `c-${stage}`, option: { label: '加个 todo', op: 'transition_stage', args } };
    expect(askUser(db, deps, confirm, 'ai:curator'), stage).toMatchObject({
      status: 'rejected',
      code: 'invalid',
      message: expect.stringContaining(stage),
    });
    const choice = { kind: 'choice', ...askBase, topic: `ch-${stage}`, options: [{ label: '好', op: 'transition_stage', args }, { label: '不', op: null }] };
    expect(askUser(db, deps, choice, 'ai:curator'), stage).toMatchObject({ status: 'rejected', code: 'invalid' });
  }
  expect(countQuestions()).toBe(0);

  // Other stages are fine, and so is the user asking.
  const build = { kind: 'confirm', ...askBase, topic: 'build', option: { label: '开工', op: 'transition_stage', args: { project: 'p_1', stage: 'build' } } };
  expect(askUser(db, deps, build, 'ai:curator')).toMatchObject({ status: 'proposed' });
  const done = { kind: 'confirm', ...askBase, topic: 'done', option: { label: '完成', op: 'transition_stage', args: { project: 'p_1', stage: 'done' } } };
  expect(askUser(db, deps, done, 'user')).toMatchObject({ status: 'proposed' });
  // The domain's own proposal (built by transition_stage) still goes through createQuestion.
  expect(createQuestion(db, deps, draft())).toMatchObject({ deduped: false });
});

test('askUser validates option args at creation and reports it as invalid', () => {
  const bad = { label: '关联', op: 'link_session', args: { session: 'claude:abc' } };
  const result = askUser(db, deps, { kind: 'choice', ...askBase, options: [bad, { label: '否', op: null }] }, 'ai:curator');
  expect(result).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(countQuestions()).toBe(0);
});

test('askUser builds the dedupe_key from project, session and topic or kind', () => {
  const options = [linkOption, { label: '否', op: null }];
  const keyOf = (id: string) => question(id).dedupe_key;
  askUser(db, deps, { kind: 'choice', ...askBase, options }, 'ai:curator');
  askUser(db, deps, { kind: 'choice', ...askBase, project_id: 'p_1', topic: 'which-project', options }, 'ai:curator');
  askUser(db, deps, { kind: 'choice', ...askBase, session_key: 'claude:abc', options }, 'ai:curator');
  expect(keyOf('q_1')).toBe('ask:-:-:choice');
  expect(keyOf('q_2')).toBe('ask:p_1:-:which-project');
  expect(keyOf('q_3')).toBe('ask:-:claude:abc:choice');
});

test('asking the same thing twice appends evidence and returns the same question id', () => {
  const options = [linkOption, { label: '否', op: null }];
  const first = askUser(db, deps, { kind: 'choice', prompt: 'q?', evidence: ['chunk:1'], topic: 't', options }, 'ai:curator');
  const second = askUser(db, deps, { kind: 'choice', prompt: 'q?', evidence: ['chunk:2'], topic: 't', options }, 'ai:curator');
  expect(first).toEqual({ status: 'proposed', question_ids: ['q_1'] });
  expect(second).toEqual({ status: 'proposed', question_ids: ['q_1'] });
  expect(evidenceOf('q_1')).toEqual(['chunk:1', 'chunk:2']);
  expect(countQuestions()).toBe(1);
});

test('askUser surfaces the question cap and the cooldown as rejections and leaves nothing behind', () => {
  const options = [linkOption, { label: '否', op: null }];
  const ask = (topic: string, actor: 'user' | 'ai:curator' = 'ai:curator') =>
    askUser(db, deps, { kind: 'choice', prompt: 'q?', evidence: ['chunk:1'], topic, options }, actor);

  for (let i = 0; i < MAX_PENDING_AI_QUESTIONS; i++) expect(ask(`t${i}`)).toMatchObject({ status: 'proposed' });
  expect(ask('one-more')).toMatchObject({ status: 'rejected', code: 'question_limit' });
  expect(countQuestions()).toBe(MAX_PENDING_AI_QUESTIONS);
  expect(ask('one-more', 'user')).toMatchObject({ status: 'proposed' });

  reject('q_1', daysAgo(1));
  expect(ask('t0')).toMatchObject({ status: 'rejected', code: 'recently_rejected' });
});

// user-only ops

const UNLOCK = { label: '解锁', op: 'unlock_field' as const, args: { table: 'projects', id: 'p_1', field: 'title' } };
const REVERT = { label: '撤销', op: 'revert_event' as const, args: { event_id: 1 } };

test('USER_ONLY_OPS lists the operations an AI may never put in a question', () => {
  expect([...USER_ONLY_OPS]).toEqual(['unlock_field', 'revert_event']);
});

test('an AI cannot bind unlock_field or revert_event to an option through askUser', () => {
  for (const bound of [UNLOCK, REVERT]) {
    const confirm = askUser(db, deps, { kind: 'confirm', ...askBase, option: bound }, 'ai:curator');
    expect(confirm).toMatchObject({ status: 'rejected', code: 'invalid' });
    expect((confirm as { message: string }).message).toMatch(new RegExp(`${bound.op} is user-only`));

    const choice = askUser(db, deps, { kind: 'choice', ...askBase, options: [bound, { label: '否', op: null }] }, 'ai:curator');
    expect(choice).toMatchObject({ status: 'rejected', code: 'invalid' });

    const text = askUser(db, deps, { kind: 'text', ...askBase, option: { ...bound, text_arg: 'field' } }, 'ai:curator');
    expect(text).toMatchObject({ status: 'rejected', code: 'invalid' });
  }
  expect(countQuestions()).toBe(0);
});

test('createQuestion refuses user-only ops for any ai creator, even when it would only dedupe', () => {
  const first = createQuestion(db, deps, draft({ dedupe_key: 'k', evidence: ['chunk:1'] }));
  const sneaky = draft({ dedupe_key: 'k', evidence: ['chunk:2'], options: [UNLOCK, { label: '拒绝', op: null }] });
  expect(() => createQuestion(db, deps, sneaky)).toThrow(/unlock_field is user-only/);
  expect(() => createQuestion(db, deps, { ...sneaky, created_by: 'ai:other' })).toThrow(OpRejected);
  expect(() => createQuestion(db, deps, { ...sneaky, options: [REVERT] })).toThrow(/revert_event is user-only/);
  expect(evidenceOf(first.id)).toEqual(['chunk:1']);
  expect(countQuestions()).toBe(1);
});

test('a user-created question may bind user-only ops', () => {
  const direct = createQuestion(db, deps, draft({ created_by: 'user', options: [UNLOCK, REVERT, { label: '否', op: null }] }));
  expect(direct.deduped).toBe(false);
  const viaAsk = askUser(db, deps, { kind: 'confirm', ...askBase, option: UNLOCK }, 'user');
  expect(viaAsk).toMatchObject({ status: 'proposed' });
});

test('AskUserInput is exported as a schema usable on its own', () => {
  const parsed = AskUserInput.safeParse({ kind: 'choice', ...askBase, options: [linkOption, { label: '否', op: null }] });
  expect(parsed.success).toBe(true);
});
