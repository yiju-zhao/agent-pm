import { afterEach, beforeEach, expect, test } from 'vitest';
import { z } from 'zod';
import { CURATOR_ACTOR, curatorTools } from '../../src/understand/curator-tools.ts';
import type { CuratorBatch } from '../../src/understand/curator-tools.ts';
import type { ToolDef, ToolOutput } from '../../src/understand/tool-def.ts';
import { count, lastEvent, NOW, row, rows, setup } from '../domain/helpers.ts';
import type { Setup } from '../domain/helpers.ts';

let t: Setup;
/** Digest ids: d1 and d2 belong to the batch, d3 is a real digest from another batch. */
let d1: number;
let d2: number;
let d3: number;
let c1: number;
let c2: number;
let tools: ToolDef[];

const D1_END = '2026-10-29T10:30:00.000Z';
const D2_END = '2026-10-29T11:15:00.000Z';
const D3_END = '2026-10-29T11:50:00.000Z';
const C1_END = '2026-10-29T09:00:00.000Z';
const C2_END = '2026-10-29T09:45:00.000Z';

function addDigest(tsEnd: string | null): number {
  const info = t.db
    .prepare(
      `INSERT INTO digests (session_key, chunk_ids, json, model, ts_start, ts_end, backfill, trivial, skipped, curated, created_at)
       VALUES ('claude:sess1111aaaabbbb', '[]', '{}', 'claude-haiku-5-5', ?, ?, 0, 0, 0, 0, ?)`,
    )
    .run('2026-10-29T08:00:00.000Z', tsEnd, NOW);
  return Number(info.lastInsertRowid);
}

function addChunk(tsEnd: string | null): number {
  const info = t.db
    .prepare(
      `INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, digested, received_at)
       VALUES ('claude:sess1111aaaabbbb', 'transcript', ?, ?, ?, ?, 'hello', 0, 0, ?)`,
    )
    .run(Math.floor(Math.random() * 1e9), 1, '2026-10-29T08:00:00.000Z', tsEnd, NOW);
  return Number(info.lastInsertRowid);
}

function addSession(key: string): void {
  t.db
    .prepare(`INSERT OR IGNORE INTO machines (label, last_heartbeat, collector_version) VALUES ('laptop', ?, 'test')`)
    .run(NOW);
  t.db
    .prepare(
      `INSERT INTO sessions (key, agent_kind, machine, terminal_id, title, lifecycle, live_status, ignored, first_seen, last_seen)
       VALUES (?, 'claude', 'laptop', 'term_1', 'a session', 'live', 'working', 0, ?, ?)`,
    )
    .run(key, NOW, NOW);
}

beforeEach(() => {
  t = setup();
  d1 = addDigest(D1_END);
  d2 = addDigest(D2_END);
  d3 = addDigest(D3_END);
  c1 = addChunk(C1_END);
  c2 = addChunk(C2_END);
  tools = curatorTools(t.db, t.deps, { digestIds: [d1, d2] });
});

afterEach(() => {
  t.db.close();
});

function byName(list: ToolDef[], name: string): ToolDef {
  const found = list.find((tool) => tool.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function names(list: ToolDef[]): string[] {
  return list.map((tool) => tool.name);
}

/** Calls a tool and parses its text as the OpResult JSON. */
async function call(name: string, args: Record<string, unknown>): Promise<{ out: ToolOutput; result: Record<string, any> }> {
  const out = await byName(tools, name).handler(args);
  let result: Record<string, any> = {};
  try {
    result = JSON.parse(out.text) as Record<string, any>;
  } catch {
    // Not JSON (a validation or evidence message); the caller looks at `out.text`.
  }
  return { out, result };
}

const cite = (...ids: number[]) => ids.map((id) => `digest:${id}`);

// ---- the tool set ------------------------------------------------------------------------------------------------

test('the curator gets exactly the write tools of spec section 11, ask_user and a read-only get_project', () => {
  expect(names(tools)).toEqual([
    'create_project',
    'update_project',
    'transition_stage',
    'upsert_milestone',
    'upsert_todo',
    'record_decision',
    'set_blocker',
    'clear_blocker',
    'link_session',
    'ignore_session',
    'ask_user',
    'get_project',
  ]);
});

test('no user-only, delete or unlink tools are exposed', () => {
  const exposed = names(tools);
  expect(exposed).not.toEqual(expect.arrayContaining(['unlock_field']));
  for (const forbidden of ['unlock_field', 'revert_event', 'unlink_session']) expect(exposed).not.toContain(forbidden);
  expect(exposed.filter((n) => n.startsWith('delete_'))).toEqual([]);
});

test('every write tool takes reason, evidence and occurred_at on top of its operation fields, and tells the model so', () => {
  const writeTools = tools.filter((tool) => tool.name !== 'get_project' && tool.name !== 'ask_user');
  expect(writeTools).toHaveLength(10);
  for (const tool of writeTools) {
    expect(Object.keys(tool.input), tool.name).toEqual(expect.arrayContaining(['reason', 'evidence', 'occurred_at']));
    expect(tool.description, tool.name).toContain('reason');
    expect(tool.description, tool.name).toContain('evidence');
  }
  expect(Object.keys(byName(tools, 'create_project').input)).toEqual(expect.arrayContaining(['title', 'summary', 'why', 'from_session']));
  expect(Object.keys(byName(tools, 'update_project').input)).toEqual(expect.arrayContaining(['project', 'fields']));
});

test('ask_user is described with its evidence requirement and takes the flat AskUserInput fields', () => {
  const ask = byName(tools, 'ask_user');
  expect(ask.description).toContain('evidence');
  expect(Object.keys(ask.input)).toEqual(
    expect.arrayContaining(['kind', 'prompt', 'project_id', 'session_key', 'topic', 'evidence', 'options', 'option', 'reason']),
  );
});

test('CURATOR_ACTOR is ai:curator', () => {
  expect(CURATOR_ACTOR).toBe('ai:curator');
});

// ---- write tools -------------------------------------------------------------------------------------------------

test('write tools call execute as ai:curator and return the OpResult', async () => {
  const { out, result } = await call('create_project', { title: '新课题', reason: '对话里提出', evidence: [`digest:${d1}`] });
  expect(out.isError).toBeFalsy();
  expect(result).toMatchObject({ status: 'applied' });
  expect(typeof result.id).toBe('string');
  expect(lastEvent(t.db)).toMatchObject({ actor: 'ai:curator', op: 'create_project', reason: '对话里提出' });
  expect(JSON.parse(lastEvent(t.db).evidence as string)).toEqual([`digest:${d1}`]);
  expect(row(t.db, 'projects', result.id)).toMatchObject({ title: '新课题' });
});

test('every write tool reaches its operation with its own fields', async () => {
  addSession('claude:link1111aaaabbbb');
  addSession('claude:ign11111aaaabbbb');
  const evidence = cite(d1);
  const common = { reason: 'because', evidence };

  // An AI can only create a project in idea.
  const rejectedStage = await call('create_project', { title: 'Q', stage: 'explore', ...common });
  expect(rejectedStage.result).toMatchObject({ status: 'rejected', code: 'not_allowed' });
  const created = (await call('create_project', { title: 'P', ...common })).result;
  const p = created.id as string;
  expect(created.status).toBe('applied');

  expect((await call('update_project', { project: p, fields: { summary: 'S' }, ...common })).result.status).toBe('applied');
  expect(row(t.db, 'projects', p)).toMatchObject({ summary: 'S' });

  expect((await call('transition_stage', { project: p, stage: 'explore', ...common })).result.status).toBe('applied');
  expect(row(t.db, 'projects', p)).toMatchObject({ stage: 'explore' });

  const m = (await call('upsert_milestone', { project: p, title: 'M1', ...common })).result;
  expect(m.status).toBe('applied');
  const todo = (await call('upsert_todo', { project: p, title: 'T1', milestone_id: m.id, ...common })).result;
  expect(todo.status).toBe('applied');
  expect(row(t.db, 'todos', todo.id)).toMatchObject({ title: 'T1', milestone_id: m.id });

  expect((await call('record_decision', { project: p, text: '用 SQLite', ...common })).result.status).toBe('applied');
  expect(count(t.db, 'decisions')).toBe(1);

  const b = (await call('set_blocker', { project: p, text: '等额度', kind: 'external', ...common })).result;
  expect(b.status).toBe('applied');
  expect((await call('clear_blocker', { project: p, id: b.id, ...common })).result.status).toBe('applied');

  expect((await call('link_session', { session: 'claude:link1111aaaabbbb', project: p, ...common })).result.status).toBe('applied');
  expect(rows(t.db, 'contributions')).toHaveLength(1);

  // `ignored` defaults to true in the operation's schema; an AI can only suggest ignoring, so the user is asked.
  const ignored = (await call('ignore_session', { session: 'claude:ign11111aaaabbbb', ...common })).result;
  expect(ignored.status).toBe('proposed');
  expect(JSON.parse(row(t.db, 'questions', ignored.question_ids[0]).options as string)[0]).toMatchObject({
    op: 'ignore_session',
    args: { session: 'claude:ign11111aaaabbbb', ignored: true },
  });
  expect(t.db.prepare('SELECT ignored FROM sessions WHERE key = ?').get('claude:ign11111aaaabbbb')).toMatchObject({ ignored: 0 });

  for (const event of t.db.prepare('SELECT actor FROM events').all()) expect(event).toMatchObject({ actor: 'ai:curator' });
});

test('a completion attempt comes back as proposed, not applied', async () => {
  const p = t.user('create_project', { title: 'P', stage: 'build' }).id;
  const { out, result } = await call('transition_stage', { project: p, stage: 'done', reason: '做完了', evidence: cite(d1) });
  expect(out.isError).toBeFalsy();
  expect(result).toMatchObject({ status: 'proposed' });
  expect(result.question_ids).toHaveLength(1);
  expect(row(t.db, 'projects', p)).toMatchObject({ stage: 'build' });
  expect(row(t.db, 'questions', result.question_ids[0])).toMatchObject({ status: 'pending', created_by: 'ai:curator' });
});

test('rejections are returned as isError with the rejection code', async () => {
  const missing = await call('update_project', { project: 'p_nope', fields: { summary: 'x' }, reason: 'r', evidence: cite(d1) });
  expect(missing.out.isError).toBe(true);
  expect(missing.result).toMatchObject({ status: 'rejected', code: 'not_found' });

  const blankReason = await call('create_project', { title: 'x', reason: '  ', evidence: cite(d1) });
  expect(blankReason.out.isError).toBe(true);
  expect(blankReason.result).toMatchObject({ status: 'rejected', code: 'missing_reason' });

  const badArgs = await call('create_project', { title: 'x'.repeat(201), reason: 'r', evidence: cite(d1) });
  expect(badArgs.out.isError).toBe(true);
  expect(badArgs.result).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(count(t.db, 'projects')).toBe(0);
});

test('arguments that do not fit the tool come back as isError instead of throwing', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['create_project', { reason: 'r', evidence: cite(d1) }],
    ['create_project', { title: 'x', evidence: cite(d1) }],
    ['create_project', { title: 'x', reason: 'r' }],
    ['create_project', { title: 'x', reason: 'r', evidence: [] }],
    ['create_project', { title: 'x', reason: 'r', evidence: cite(d1), surprise: 1 }],
    ['create_project', { title: 7, reason: 'r', evidence: cite(d1) }],
    ['transition_stage', { project: 'p_1', stage: 'finished', reason: 'r', evidence: cite(d1) }],
  ];
  for (const [name, args] of cases) {
    const out = await byName(tools, name).handler(args);
    expect(out.isError, JSON.stringify(args)).toBe(true);
    expect(out.text.length).toBeGreaterThan(0);
  }
  expect(count(t.db, 'projects')).toBe(0);
  expect(count(t.db, 'events')).toBe(0);
});

// ---- evidence ----------------------------------------------------------------------------------------------------

test('evidence must cite a digest of this batch or an existing chunk', async () => {
  const unknown = await call('create_project', { title: 'x', reason: 'r', evidence: ['digest:999'] });
  expect(unknown.out.isError).toBe(true);
  expect(unknown.out.text).toContain('digest:999');
  expect(count(t.db, 'projects')).toBe(0);

  // A real digest, but not part of this batch.
  const other = await call('create_project', { title: 'x', reason: 'r', evidence: [`digest:${d3}`] });
  expect(other.out.isError).toBe(true);
  expect(other.out.text).toContain(`digest:${d3}`);
  expect(count(t.db, 'projects')).toBe(0);

  const noChunk = await call('create_project', { title: 'x', reason: 'r', evidence: ['chunk:999'] });
  expect(noChunk.out.isError).toBe(true);
  expect(noChunk.out.text).toContain('chunk:999');
  expect(count(t.db, 'projects')).toBe(0);

  const okChunk = await call('create_project', { title: 'x', reason: 'r', evidence: [`chunk:${c1}#L40`] });
  expect(okChunk.out.isError).toBeFalsy();
  expect(okChunk.result).toMatchObject({ status: 'applied' });
});

test('the message names every bad reference, and nothing is written when one of several is bad', async () => {
  const out = await byName(tools, 'create_project').handler({
    title: 'x',
    reason: 'r',
    evidence: [`digest:${d1}`, 'digest:999', `digest:${d3}`, 'chunk:998'],
  });
  expect(out.isError).toBe(true);
  for (const bad of ['digest:999', `digest:${d3}`, 'chunk:998']) expect(out.text).toContain(bad);
  expect(out.text).not.toContain(`digest:${d1},`);
  expect(count(t.db, 'projects')).toBe(0);
  expect(count(t.db, 'events')).toBe(0);
});

test('a digest or chunk reference without a numeric id is refused', async () => {
  for (const ref of ['digest:abc', 'chunk:x1', 'digest:1.5']) {
    const out = await byName(tools, 'create_project').handler({ title: 'x', reason: 'r', evidence: [ref] });
    expect(out.isError, ref).toBe(true);
  }
  expect(count(t.db, 'projects')).toBe(0);
});

test('event and question references go through unchecked; execute validates the format', async () => {
  const ok = await call('create_project', { title: 'x', reason: 'r', evidence: ['event:7', 'question:q_ab12'] });
  expect(ok.result).toMatchObject({ status: 'applied' });

  const bad = await call('create_project', { title: 'y', reason: 'r', evidence: ['some words'] });
  expect(bad.out.isError).toBe(true);
  expect(bad.result).toMatchObject({ status: 'rejected', code: 'missing_evidence' });
  expect(count(t.db, 'projects')).toBe(1);
});

// ---- occurred_at -------------------------------------------------------------------------------------------------

test('occurred_at defaults to the latest ts_end of the cited digests', async () => {
  await call('create_project', { title: 'both', reason: 'r', evidence: cite(d1, d2) });
  expect(lastEvent(t.db).occurred_at).toBe(D2_END);
  await call('create_project', { title: 'first only', reason: 'r', evidence: cite(d1) });
  expect(lastEvent(t.db).occurred_at).toBe(D1_END);
});

test('when only chunks are cited, occurred_at is the latest ts_end of those chunks', async () => {
  await call('create_project', { title: 'chunks', reason: 'r', evidence: [`chunk:${c1}`, `chunk:${c2}#L3`] });
  expect(lastEvent(t.db).occurred_at).toBe(C2_END);
});

test('cited digests take precedence over cited chunks', async () => {
  await call('create_project', { title: 'mixed', reason: 'r', evidence: [`chunk:${c2}`, `digest:${d1}`] });
  expect(lastEvent(t.db).occurred_at).toBe(D1_END);
});

test('with no digest or chunk to date it, occurred_at is left to execute (now)', async () => {
  await call('create_project', { title: 'refs', reason: 'r', evidence: ['event:7'] });
  expect(lastEvent(t.db).occurred_at).toBe(NOW);

  // Cited rows that carry no timestamp do not date it either.
  const undated = addDigest(null);
  const undatedChunk = addChunk(null);
  const dated = curatorTools(t.db, t.deps, { digestIds: [undated] });
  await byName(dated, 'create_project').handler({ title: 'undated', reason: 'r', evidence: [`digest:${undated}`, `chunk:${undatedChunk}`] });
  expect(lastEvent(t.db).occurred_at).toBe(NOW);
});

test('an occurred_at the model passes wins over the default', async () => {
  const at = '2026-10-28T08:00:00.000Z';
  await call('create_project', { title: 'explicit', reason: 'r', evidence: cite(d2), occurred_at: at });
  expect(lastEvent(t.db).occurred_at).toBe(at);

  const bad = await call('create_project', { title: 'bad date', reason: 'r', evidence: cite(d2), occurred_at: 'yesterday' });
  expect(bad.out.isError).toBe(true);
  expect(bad.result).toMatchObject({ status: 'rejected', code: 'invalid' });
});

test('a ts_end that is not a clean ISO instant is normalised or ignored instead of failing the write', async () => {
  const offset = addDigest('2026-10-29T18:00:00+08:00');
  const junk = addDigest('not a time');
  const list = curatorTools(t.db, t.deps, { digestIds: [offset, junk] });
  const create = byName(list, 'create_project');

  const out = await create.handler({ title: 'offset', reason: 'r', evidence: [`digest:${offset}`, `digest:${junk}`] });
  expect(out.isError).toBeFalsy();
  expect(lastEvent(t.db).occurred_at).toBe('2026-10-29T10:00:00.000Z');
});

// ---- ask_user ----------------------------------------------------------------------------------------------------

test('ask_user stores the question as ai:curator and reports it as proposed', async () => {
  const { out, result } = await call('ask_user', {
    kind: 'choice',
    prompt: '这个 session 属于哪个项目？',
    project_id: null,
    session_key: 'claude:sess1111aaaabbbb',
    topic: 'which-project',
    evidence: [`digest:${d1}`],
    reason: '摘要里看不出来',
    options: [
      { label: '新建项目', op: 'create_project', args: { title: '新课题', from_session: 'claude:sess1111aaaabbbb' } },
      { label: '都不是', op: null },
    ],
  });
  expect(out.isError).toBeFalsy();
  expect(result).toMatchObject({ status: 'proposed' });
  expect(row(t.db, 'questions', result.question_ids[0])).toMatchObject({
    kind: 'choice',
    created_by: 'ai:curator',
    session_key: 'claude:sess1111aaaabbbb',
    dedupe_key: 'ask:-:claude:sess1111aaaabbbb:which-project',
  });
});

test('ask_user accepts the confirm and text shapes', async () => {
  const confirm = await call('ask_user', {
    kind: 'confirm',
    prompt: '开工吗？',
    topic: 'c',
    evidence: [`chunk:${c1}`],
    option: { label: '开工', op: 'transition_stage', args: { project: 'p_1', stage: 'build' } },
  });
  expect(confirm.result).toMatchObject({ status: 'proposed' });
  expect(JSON.parse(row(t.db, 'questions', confirm.result.question_ids[0]).options as string)).toEqual([
    { label: '开工', op: 'transition_stage', args: { project: 'p_1', stage: 'build' } },
    { label: '拒绝', op: null },
  ]);

  const text = await call('ask_user', {
    kind: 'text',
    prompt: '完成标准是什么？',
    topic: 't',
    evidence: [`chunk:${c1}`],
    option: { label: '补充', op: 'update_project', args: { project: 'p_1', fields: {} }, text_arg: 'fields.done_criteria' },
  });
  expect(text.result).toMatchObject({ status: 'proposed' });
});

test('ask_user checks its evidence like the write tools do', async () => {
  const base = { kind: 'confirm', prompt: '开工吗？', option: { label: '开工', op: 'transition_stage', args: { project: 'p_1', stage: 'build' } } };
  for (const evidence of [['digest:999'], [`digest:${d3}`], ['chunk:999']]) {
    const out = await byName(tools, 'ask_user').handler({ ...base, evidence });
    expect(out.isError, evidence[0]).toBe(true);
    expect(out.text).toContain(evidence[0]);
  }
  const noEvidence = await byName(tools, 'ask_user').handler({ ...base, evidence: [] });
  expect(noEvidence.isError).toBe(true);
  expect(count(t.db, 'questions')).toBe(0);
});

test('ask_user passes a rejection from askUser back as isError', async () => {
  // An AI may not offer its own way to close a project.
  const { out, result } = await call('ask_user', {
    kind: 'confirm',
    prompt: '加个 todo 吗？',
    evidence: cite(d1),
    option: { label: '加个 todo', op: 'transition_stage', args: { project: 'p_1', stage: 'done' } },
  });
  expect(out.isError).toBe(true);
  expect(result).toMatchObject({ status: 'rejected', code: 'invalid' });

  const wrongShape = await call('ask_user', { kind: 'choice', prompt: 'q?', evidence: cite(d1) });
  expect(wrongShape.out.isError).toBe(true);
  expect(wrongShape.result).toMatchObject({ status: 'rejected', code: 'invalid' });

  const malformed = await byName(tools, 'ask_user').handler({ kind: 'poll', prompt: 'q?', evidence: cite(d1) });
  expect(malformed.isError).toBe(true);
  expect(count(t.db, 'questions')).toBe(0);
});

test('ask_user refuses an AI text option that would make the user type a stage', async () => {
  const { out, result } = await call('ask_user', {
    kind: 'text',
    prompt: '项目现在处于哪个阶段？',
    evidence: cite(d1),
    option: { label: '输入阶段', op: 'transition_stage', args: { project: 'p_1' }, text_arg: 'stage' },
  });
  expect(out.isError).toBe(true);
  expect(result).toMatchObject({ status: 'rejected', code: 'invalid' });
  expect(count(t.db, 'questions')).toBe(0);
});

// ---- get_project -------------------------------------------------------------------------------------------------

test('get_project returns the project as Markdown and is an error for an unknown or vetoed project', async () => {
  const p = t.user('create_project', { title: '看板', summary: '收拢各终端的工作' }).id;
  const found = await byName(tools, 'get_project').handler({ project_id: p });
  expect(found.isError).toBeFalsy();
  expect(found.text).toContain('看板');
  expect(found.text).toContain('收拢各终端的工作');

  const missing = await byName(tools, 'get_project').handler({ project_id: 'p_nope' });
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain('p_nope');

  const noArgs = await byName(tools, 'get_project').handler({});
  expect(noArgs.isError).toBe(true);
});

test('get_project changes nothing', async () => {
  const p = t.user('create_project', { title: '看板' }).id;
  const before = count(t.db, 'events');
  await byName(tools, 'get_project').handler({ project_id: p });
  expect(count(t.db, 'events')).toBe(before);
});

test('each tool input is a zod raw shape that builds an object schema', () => {
  for (const tool of tools) expect(() => z.object(tool.input), tool.name).not.toThrow();
});

// ---- run state ---------------------------------------------------------------------------------------------------

test('the batch counts tool calls that came back applied or proposed (questions included), and nothing else', async () => {
  const batch: CuratorBatch = { digestIds: [d1, d2] };
  const list = curatorTools(t.db, t.deps, batch);
  const run = (name: string, args: Record<string, unknown>) => byName(list, name).handler(args);

  const p = JSON.parse((await run('create_project', { title: 'P', reason: 'r', evidence: cite(d1) })).text).id as string;
  expect(batch.landedWrites).toBe(1);
  // A rejection, bad arguments, unusable evidence and a read do not count.
  await run('update_project', { project: 'p_nope', fields: { summary: 'x' }, reason: 'r', evidence: cite(d1) });
  await run('upsert_todo', { project: p, reason: 'r', evidence: cite(d1) });
  await run('upsert_todo', { project: p, title: 'T', reason: 'r', evidence: cite(d3) });
  await run('get_project', { project_id: p });
  expect(batch.landedWrites).toBe(1);
  // A proposal (here: a completion turned into a question) landed too.
  await run('transition_stage', { project: p, stage: 'done', reason: 'r', evidence: cite(d1) });
  expect(batch.landedWrites).toBe(2);
  // A question is state too: asking again under another topic would duplicate it.
  const asked = await run('ask_user', {
    kind: 'choice',
    prompt: '归属？',
    project_id: p,
    session_key: null,
    topic: 'owner',
    evidence: cite(d1),
    options: [
      { label: '是', op: null },
      { label: '否', op: null },
    ],
  });
  expect(asked.isError).toBeFalsy();
  expect(batch.landedWrites).toBe(3);
});

test('once the batch is closed every tool refuses without touching anything', async () => {
  const p = t.user('create_project', { title: 'P' }).id;
  const batch: CuratorBatch = { digestIds: [d1] };
  const list = curatorTools(t.db, t.deps, batch);
  batch.closed = true;
  const before = count(t.db, 'events');

  for (const [name, args] of [
    ['create_project', { title: 'Q', reason: 'r', evidence: cite(d1) }],
    ['upsert_todo', { project: p, title: 'T', reason: 'r', evidence: cite(d1) }],
    ['ask_user', { kind: 'confirm', prompt: '?', evidence: cite(d1), option: { label: 'ok', op: null } }],
    ['get_project', { project_id: p }],
  ] as const) {
    const out = await byName(list, name).handler(args);
    expect(out, name).toEqual({ text: 'this curate run has ended', isError: true });
  }
  expect(count(t.db, 'events')).toBe(before);
  expect(count(t.db, 'projects')).toBe(1);
  expect(count(t.db, 'questions')).toBe(0);
});
