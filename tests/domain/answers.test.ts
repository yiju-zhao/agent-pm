import { afterEach, beforeEach, expect, test } from 'vitest';
import { answerQuestion, dismissQuestion } from '../../src/domain/answers.ts';
import { HANDLERS } from '../../src/domain/execute.ts';
import { askUser, QUESTION_TTL_DAYS, REJECT_COOLDOWN_DAYS } from '../../src/domain/questions.ts';
import { OpRejected } from '../../src/domain/types.ts';
import { count, lastEvent, NOW, row, setup } from './helpers.ts';
import type { Result, Row, Setup } from './helpers.ts';

const DAY_MS = 86_400_000;

let t: Setup;
let p: string;

beforeEach(() => {
  t = setup();
  p = t.user('create_project', { title: '用户项目' }).id;
});

afterEach(() => {
  t.db.close();
});

const project = (id: string): Row => row(t.db, 'projects', id);
const question = (id: string): Row => row(t.db, 'questions', id);
const events = (): number => count(t.db, 'events');
const answer = (id: string, a: unknown): Result => answerQuestion(t.db, t.deps, id, a as { option_index: number }) as Result;
const dismiss = (id: string): Result => dismissQuestion(t.db, t.deps, id) as Result;

function daysAfterNow(days: number): string {
  return new Date(new Date(NOW).getTime() + days * DAY_MS).toISOString();
}

/** An AI proposal to finish the project: an AI may not move idea to done directly, so it becomes a question. */
function proposeDone(): string {
  return t.ai('transition_stage', { project: p, stage: 'done' }).question_ids[0];
}

function ask(input: unknown): string {
  const r = askUser(t.db, t.deps, input, 'ai:curator') as Result;
  expect(r.status).toBe('proposed');
  return r.question_ids[0];
}

/** A three-way choice: explore, build, or leave it. (An AI may not offer closing or parking this way.) */
function askChoice(): string {
  return ask({
    kind: 'choice',
    prompt: '这个项目怎么处理？',
    evidence: ['chunk:1'],
    options: [
      { label: '探索', op: 'transition_stage', args: { project: p, stage: 'explore' } },
      { label: '开工', op: 'transition_stage', args: { project: p, stage: 'build' } },
      { label: '先不处理', op: null },
    ],
  });
}

function askText(): string {
  return ask({
    kind: 'text',
    prompt: '这个项目做到什么程度算完成？',
    evidence: ['chunk:1'],
    option: { label: '填写完成标准', op: 'update_project', args: { project: p, fields: {} }, text_arg: 'fields.done_criteria' },
  });
}

// ---- answering ---------------------------------------------------------------------------------------------------

test('confirming an ai proposal executes it as the user and links the event to the question', () => {
  const q = proposeDone();
  const before = events();

  const r = answer(q, { option_index: 0 });

  expect(r).toMatchObject({ status: 'applied', question_ids: [], warnings: [] });
  expect(project(p).stage).toBe('done');
  expect(events()).toBe(before + 1);
  expect(lastEvent(t.db)).toMatchObject({ id: r.event_id, actor: 'user', op: 'transition_stage', question_id: q, reason: null });
  // The op moved the guarded stage, which withdraws the question as stale; answering must override that.
  expect(question(q)).toMatchObject({
    status: 'answered',
    answer: '{"option_index":0}',
    resolved_at: NOW,
    resolution_note: null,
    rejected: 0,
  });
});

test('choosing 拒绝 records a rejection that starts the cooldown', () => {
  const q = proposeDone();
  const before = events();

  expect(answer(q, { option_index: 1 })).toMatchObject({ status: 'applied', event_id: null, question_ids: [], warnings: [] });

  expect(events()).toBe(before);
  expect(project(p).stage).toBe('idea');
  expect(question(q)).toMatchObject({ status: 'answered', answer: '{"option_index":1}', rejected: 1, resolved_at: NOW });
  expect(t.ai('transition_stage', { project: p, stage: 'done' })).toMatchObject({ code: 'recently_rejected' });

  t.setNow(daysAfterNow(REJECT_COOLDOWN_DAYS + 1));
  expect(t.ai('transition_stage', { project: p, stage: 'done' })).toMatchObject({ status: 'proposed' });
});

test('a user edit while a proposal is pending withdraws it; answering it later returns not_pending and keeps the user value', () => {
  t.user('update_project', { project: p, fields: { title: '用户标题' } });
  const q = t.ai('update_project', { project: p, fields: { title: 'AI 标题' } }).question_ids[0];
  t.user('update_project', { project: p, fields: { title: '用户又改了' } });
  expect(question(q)).toMatchObject({ status: 'withdrawn', resolution_note: 'stale' });
  const before = events();

  expect(answer(q, { option_index: 0 })).toMatchObject({ status: 'rejected', code: 'not_pending' });

  expect(project(p).title).toBe('用户又改了');
  expect(events()).toBe(before);
});

test('a choice question runs the option that was picked', () => {
  const q = askChoice();

  expect(answer(q, { option_index: 1 })).toMatchObject({ status: 'applied' });

  expect(project(p).stage).toBe('build');
  expect(lastEvent(t.db)).toMatchObject({ actor: 'user', question_id: q });
  expect(question(q)).toMatchObject({ status: 'answered', answer: '{"option_index":1}', rejected: 0 });
});

test('a choice question whose picked option is a no-op is answered and rejected', () => {
  const q = askChoice();
  const before = events();

  expect(answer(q, { option_index: 2 })).toMatchObject({ status: 'applied', event_id: null });

  expect(events()).toBe(before);
  expect(project(p).stage).toBe('idea');
  expect(question(q)).toMatchObject({ status: 'answered', rejected: 1, resolved_at: NOW });
});

test('a text question passes the typed text into its op', () => {
  const q = askText();

  const r = answer(q, { text: '跑通 3 个基准' });

  expect(r).toMatchObject({ status: 'applied' });
  expect(project(p).done_criteria).toBe('跑通 3 个基准');
  expect(lastEvent(t.db)).toMatchObject({ actor: 'user', op: 'update_project', question_id: q });
  expect(question(q)).toMatchObject({
    status: 'answered',
    answer: '{"option_index":0,"text":"跑通 3 个基准"}',
    resolved_at: NOW,
    rejected: 0,
  });
});

test('typed text the op refuses is invalid and keeps the question pending so the user can retype', () => {
  const q = askText();
  const before = events();

  const r = answer(q, { text: '字'.repeat(4001) });

  expect(r).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(question(q)).toMatchObject({ status: 'pending', answer: null, resolution_note: null, resolved_at: null, rejected: 0 });
  expect(events()).toBe(before);
  expect(project(p).done_criteria).toBeNull();

  expect(answer(q, { text: '跑通 3 个基准' })).toMatchObject({ status: 'applied' });
  expect(project(p).done_criteria).toBe('跑通 3 个基准');
  expect(question(q)).toMatchObject({ status: 'answered', answer: '{"option_index":0,"text":"跑通 3 个基准"}' });
});

test('an answer that does not fit the question is invalid and leaves the question pending', () => {
  const text = askText();
  const choice = askChoice();
  const before = events();

  const bad: Array<[string, unknown]> = [
    [text, {}],
    [text, { text: '' }],
    [text, { text: '   ' }],
    [text, { text: 42 }],
    [text, { option_index: 0 }],
    [choice, {}],
    [choice, { text: '搁置' }],
    [choice, { option_index: -1 }],
    [choice, { option_index: 3 }],
    [choice, { option_index: 0.5 }],
    [choice, { option_index: '0' }],
    [choice, { option_index: null }],
    [choice, null],
  ];
  for (const [id, a] of bad) {
    expect(answer(id, a), JSON.stringify(a)).toMatchObject({ status: 'rejected', code: 'invalid' });
    expect(question(id).status).toBe('pending');
  }
  expect(events()).toBe(before);
  expect(project(p)).toMatchObject({ stage: 'idea', done_criteria: null });
});

test('answering an unknown, already answered or expired question returns not_found / not_pending and runs nothing', () => {
  expect(answer('q_nope', { option_index: 0 })).toMatchObject({ status: 'rejected', code: 'not_found' });

  const q = proposeDone();
  answer(q, { option_index: 0 });
  const before = events();
  expect(answer(q, { option_index: 0 })).toMatchObject({ status: 'rejected', code: 'not_pending' });
  expect(events()).toBe(before);

  const old = askChoice();
  t.setNow(daysAfterNow(QUESTION_TTL_DAYS + 1));
  expect(answer(old, { option_index: 0 })).toMatchObject({ status: 'rejected', code: 'not_pending' });
  expect(question(old)).toMatchObject({ status: 'expired', resolved_at: daysAfterNow(QUESTION_TTL_DAYS + 1) });
  expect(project(p).stage).toBe('done');
  expect(events()).toBe(before);
});

test('when a guard no longer holds the question is withdrawn as stale, even if the answer is also invalid', () => {
  const q = proposeDone();
  // Change the guarded column behind the pipeline's back so nothing withdrew the question earlier.
  t.db.prepare("UPDATE projects SET stage = 'build' WHERE id = ?").run(p);
  const before = events();

  expect(answer(q, { option_index: 99 })).toMatchObject({ status: 'rejected', code: 'stale' });

  expect(question(q)).toMatchObject({ status: 'withdrawn', resolution_note: 'stale', resolved_at: NOW, rejected: 0, answer: null });
  expect(project(p).stage).toBe('build');
  expect(events()).toBe(before);
});

test('when the bound op is rejected the question is withdrawn with that code', () => {
  const q = ask({
    kind: 'confirm',
    prompt: '改这个项目的标题吗？',
    evidence: ['chunk:1'],
    option: { label: '确认', op: 'update_project', args: { project: 'p_missing', fields: { title: 'x' } } },
  });
  const before = events();

  const r = answer(q, { option_index: 0 });

  expect(r).toMatchObject({ status: 'rejected', code: 'not_found' });
  expect(question(q)).toMatchObject({ status: 'withdrawn', resolution_note: 'not_found', resolved_at: NOW, rejected: 0, answer: null });
  expect(events()).toBe(before);
});

test('a bound op that fails after writing is rolled back, and the withdrawal still sticks', () => {
  t.user('update_project', { project: p, fields: { title: '用户标题' } });
  const q = t.ai('update_project', { project: p, fields: { title: 'AI 标题' } }).question_ids[0];
  const before = events();

  const real = HANDLERS.update_project!;
  HANDLERS.update_project = (ctx, args) => {
    real(ctx, args);
    throw new OpRejected('conflict', 'changed under us');
  };
  let r: Result;
  try {
    r = answer(q, { option_index: 0 });
  } finally {
    HANDLERS.update_project = real;
  }

  expect(r).toMatchObject({ status: 'rejected', code: 'conflict', message: 'changed under us' });
  expect(project(p).title).toBe('用户标题');
  expect(events()).toBe(before);
  expect(question(q)).toMatchObject({ status: 'withdrawn', resolution_note: 'conflict', resolved_at: NOW, answer: null });
  // The failed transaction is gone: the database accepts a normal operation afterwards.
  expect(t.user('update_project', { project: p, fields: { title: '之后' } })).toMatchObject({ status: 'applied' });
});

// ---- dismissing --------------------------------------------------------------------------------------------------

test('dismiss withdraws with rejected=1 and starts the cooldown', () => {
  const q = proposeDone();
  const before = events();

  expect(dismiss(q)).toMatchObject({ status: 'applied', event_id: null, question_ids: [], warnings: [] });

  expect(question(q)).toMatchObject({ status: 'withdrawn', rejected: 1, resolution_note: 'dismissed', resolved_at: NOW, answer: null });
  expect(project(p).stage).toBe('idea');
  expect(events()).toBe(before);
  expect(t.ai('transition_stage', { project: p, stage: 'done' })).toMatchObject({ code: 'recently_rejected' });
});

test('dismiss only works on a pending question', () => {
  expect(dismiss('q_nope')).toMatchObject({ status: 'rejected', code: 'not_found' });

  const q = proposeDone();
  dismiss(q);
  expect(dismiss(q)).toMatchObject({ status: 'rejected', code: 'not_pending' });
  expect(answer(q, { option_index: 0 })).toMatchObject({ status: 'rejected', code: 'not_pending' });
  expect(project(p).stage).toBe('idea');

  const answered = askChoice();
  answer(answered, { option_index: 2 });
  expect(dismiss(answered)).toMatchObject({ status: 'rejected', code: 'not_pending' });
  expect(question(answered)).toMatchObject({ status: 'answered', resolution_note: null });

  // A question past its time-to-live is expired first, so dismissing it must not count as a rejection.
  const old = askText();
  t.setNow(daysAfterNow(QUESTION_TTL_DAYS + 1));
  expect(dismiss(old)).toMatchObject({ status: 'rejected', code: 'not_pending' });
  expect(question(old)).toMatchObject({ status: 'expired', rejected: 0 });
});
