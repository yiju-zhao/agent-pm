import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { execute } from '../../src/domain/execute.ts';
import type { OpName } from '../../src/domain/ops.ts';
import type { DomainDeps, IdPrefix } from '../../src/domain/types.ts';
import type { ServerConfig } from '../../src/server/config.ts';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';
import type { MergePreviewView } from '../../src/server/merge-routes.ts';
import type { LlmCall, LlmResult } from '../../src/understand/llm.ts';
import { MAX_WINDOWS, WINDOW_CHARS } from '../../src/understand/merge-preview.ts';

// The merge flow through its public surface: the HTTP routes, a scripted model, and the project API to see the result.

const USER_TOKEN = 'user-token-0123456789abcdef';
const NOW = '2026-11-13T10:00:00.000Z';
const config: ServerConfig = { port: 1, dbPath: ':memory:', userToken: USER_TOKEN, mcpToken: 'mcp-token-0123456789abcdef', collectors: {} };
const A = 'codex:aaaaaaaa';
const B = 'codex:bbbbbbbb';
const C = 'codex:cccccccc';

let db: DatabaseSync;
let deps: DomainDeps;
let app: ReturnType<typeof createApp>;
let calls: LlmCall[];
/** What the scripted model answers; replaced per test. */
let answer: (call: LlmCall) => LlmResult | Promise<LlmResult>;

const ok = (structured: unknown): LlmResult => ({ ok: true, text: '', structured, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 }, costUsd: 0, durationMs: 1 });
const chunkIds = (prompt: string) => [...prompt.matchAll(/<chunk id="(\d+)">/g)].map((m) => Number(m[1]));
const factIds = (prompt: string) => [...prompt.matchAll(/（chunk ([\d, ]+)）/g)].flatMap((m) => m[1]!.split(',').map(Number));
/** A well-formed draft resting on the first chunk the prompt offers. */
function draft(prompt: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = chunkIds(prompt)[0] ?? factIds(prompt)[0]!;
  return {
    title: '采集可靠性',
    title_change_reason: '目标已从泛泛的采集变成采集可靠性',
    summary: '为看板用户补齐漏采的会话内容',
    why: '项目判断依赖完整证据',
    done_criteria: ['中文批次入库', '关窗尾部补读'],
    unknowns: ['真实机器尚未对账'],
    evidence: [{ field: 'summary', chunk_ids: [id] }, { field: 'done_criteria', chunk_ids: [id] }],
    ...over,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  const counters = new Map<IdPrefix, number>();
  deps = {
    now: () => new Date(NOW),
    newId: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${n}`;
    },
  };
  calls = [];
  answer = (call) => ok(draft(call.prompt));
  const runner = async (call: LlmCall) => {
    calls.push(call);
    return answer(call);
  };
  app = createApp(db, config, deps.now, deps.newId, { mergeLlm: { runner, model: () => 'test-model' } });
  for (const key of [A, B, C]) {
    db.prepare(
      `INSERT INTO sessions (key, agent_kind, machine, cwd, title, live_status, lifecycle, ignored, first_seen, last_seen)
       VALUES (?, 'codex', 'laptop', '/work', 'task', 'idle', 'live', 0, ?, ?)`,
    ).run(key, NOW, NOW);
  }
});
afterEach(() => db.close());

let offset = 0;
function chunk(key: string, text: string): number {
  offset += 1;
  const info = db.prepare("INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill) VALUES (?, 'transcript', ?, ?, ?, ?, ?, 0)").run(key, offset, offset, NOW, NOW, text);
  return Number(info.lastInsertRowid);
}
const op = (name: OpName, args: unknown, actor: 'user' | 'ai:curator' = 'user') => execute(db, deps, { op: name, args, actor, ...(actor === 'user' ? {} : { reason: 'r', evidence: ['chunk:1'] }) }) as { id: string; event_id: number };
function project(title: string, sessions: string[]): string {
  const id = op('create_project', { title, summary: `${title}旧简介` }, 'ai:curator').id;
  for (const key of sessions) op('link_session', { session: key, project: id });
  return id;
}
async function http(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { method, headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
/** Starts a preview and waits until it is no longer generating. */
async function preview(source: string, body: { target: string; sessions?: string[] }): Promise<MergePreviewView> {
  const started = await http('POST', `/projects/${source}/merge-previews`, body);
  expect(started.status).toBe(202);
  for (let i = 0; i < 200; i++) {
    const view = (await http('GET', `/merge-previews/${started.body.id}`)).body as MergePreviewView;
    if (view.status !== 'generating') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('preview never finished');
}
const detail = async (id: string) => (await http('GET', `/projects/${id}`)).body;
const sessionsOf = async (id: string) => ((await detail(id)).contributions as Array<{ session_key: string }>).map((c) => c.session_key).sort();
/** Everything a merge may change, to show that a preview alone changes none of it. */
const formal = () => JSON.stringify([db.prepare('SELECT * FROM projects ORDER BY id').all(), db.prepare('SELECT * FROM contributions ORDER BY id').all(), db.prepare('SELECT * FROM events ORDER BY id').all()]);

test('a partial merge previews from the chosen sessions only, changes nothing until confirmed, then applies what was shown and can be undone', async () => {
  const source = project('杂项', [A, B]);
  const target = project('采集', [C]);
  chunk(A, '[10:00] user: 修复中文批次超限');
  const tail = chunk(A, '[18:00] assistant: 最终验收：2002 条归档全部入库 TAIL-FACT');
  chunk(B, '[11:00] user: UNSELECTED 重做登录页');
  chunk(C, '[09:00] user: 关窗后补读尾部');
  answer = (call) => ok(draft(call.prompt, { evidence: [{ field: 'summary', chunk_ids: [tail] }, { field: 'done_criteria', chunk_ids: [tail] }] }));
  const before = formal();

  const view = await preview(source, { target, sessions: [A] });
  expect(view).toMatchObject({ status: 'ready', mode: 'sessions', stale: false, sessions: [A], session_labels: { [A]: 'task · laptop', [C]: 'task · laptop' } });
  expect(formal()).toBe(before);
  // The model read the raw content of the chosen and the target sessions, the late fact included, never summarized.
  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toContain('TAIL-FACT');
  expect(calls[0]!.prompt).toContain('关窗后补读尾部');
  expect(calls[0]!.prompt).not.toContain('UNSELECTED');
  expect(calls[0]!.prompt).not.toContain('杂项旧简介');
  expect(view.coverage).toMatchObject({ layer: 'chunks', mode: 'direct', sessions: [{ session_key: A, side: 'source', status: 'read', chunks_read: 2 }, { session_key: C, side: 'target', status: 'read' }] });
  expect(view.changes).toMatchObject({
    links: [{ session: A, target: 'add', source: 'remove' }],
    source_merged: false,
    source_remaining_sessions: [B],
    fields: expect.arrayContaining([{ field: 'title', before: '采集', after: '采集可靠性', locked: false }]),
  });
  expect(view.draft!.evidence[0]).toEqual({ field: 'summary', chunk_ids: [tail] });

  const applied = await http('POST', `/merge-previews/${view.id}/apply`, {});
  expect(applied.status).toBe(200);
  expect(calls).toHaveLength(1); // confirming never asks the model again
  expect(await detail(target)).toMatchObject({ title: view.draft!.title, summary: view.draft!.summary, why: view.draft!.why, done_criteria: '- 中文批次入库\n- 关窗尾部补读' });
  expect(await sessionsOf(target)).toEqual([A, C]);
  expect(await sessionsOf(source)).toEqual([B]);
  expect(await detail(source)).toMatchObject({ stage: 'idea', title: '杂项' });
  expect((await http('GET', `/merge-previews/${view.id}`)).body.status).toBe('applied');
  expect((await http('POST', `/merge-previews/${view.id}/apply`, {})).status).toBe(409);

  expect((await http('POST', `/events/${applied.body.event_id}/revert`)).status).toBe(200);
  expect(await sessionsOf(source)).toEqual([A, B]);
  expect(await sessionsOf(target)).toEqual([C]);
  expect(await detail(target)).toMatchObject({ title: '采集', summary: '采集旧简介' });
});

test('a whole-project merge links every source session without the model choosing them', async () => {
  const source = project('来源', [A, B]);
  const target = project('目标', [B]);
  chunk(A, 'a');
  chunk(B, 'b');
  const view = await preview(source, { target });
  expect(view.changes).toMatchObject({ source_merged: true, links: [{ session: A, target: 'add', source: 'keep' }, { session: B, target: 'keep', source: 'keep' }] });
  expect(calls[0]!.tools).toBeUndefined();
  expect(calls[0]!.prompt).toContain('来源旧简介');
  expect((await http('POST', `/merge-previews/${view.id}/apply`, {})).status).toBe(200);
  expect(await sessionsOf(target)).toEqual([A, B]);
  expect(await detail(source)).toMatchObject({ stage: 'merged', merged_into: target });
});

test('a failed, refused, malformed or unsupported draft leaves a failed preview and no change, without another attempt', async () => {
  const source = project('来源', [A]);
  const target = project('目标', [C]);
  chunk(A, 'a');
  const answers: Array<(call: LlmCall) => LlmResult> = [
    () => ({ ok: false, kind: 'refused', message: 'cannot help', durationMs: 1 }),
    () => ({ ok: false, kind: 'overloaded', message: 'busy', durationMs: 1 }),
    () => ok({ title: '只有标题' }),
    (call) => ok(draft(call.prompt, { evidence: [{ field: 'summary', chunk_ids: [99999] }, { field: 'done_criteria', chunk_ids: [99999] }] })),
    (call) => ok(draft(call.prompt, { evidence: [] })),
    (call) => ok(draft(call.prompt, { done_criteria: ['x'.repeat(301)] })),
  ];
  const before = formal();
  for (const next of answers) {
    calls = [];
    answer = next;
    const view = await preview(source, { target });
    expect(view).toMatchObject({ status: 'failed', draft: null, changes: null });
    expect(view.error).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect((await http('POST', `/merge-previews/${view.id}/apply`, {})).status).toBe(409);
    expect(formal()).toBe(before);
  }
  // Every call is on the record: four failed ones (the last for a criterion too long to store), and two that answered with a draft the checks then discarded.
  expect(db.prepare('SELECT sum(ok = 0) AS failed, count(*) AS n FROM llm_runs').get()).toEqual({ failed: 4, n: 6 });
});

test('ignored and provider-refused sessions are gaps: their content is never sent, and the preview says so', async () => {
  const source = project('来源', [A, B]);
  const target = project('目标', [C]);
  chunk(A, 'IGNORED-CONTENT');
  const denied = chunk(B, 'REFUSED-CONTENT');
  chunk(B, 'LATER-CONTENT');
  chunk(C, 'readable');
  op('ignore_session', { session: A, ignored: true });
  const block = db.prepare("INSERT INTO digest_blocks (session_key, chunk_ids, message, created_at) VALUES (?, ?, 'refused', ?)").run(B, JSON.stringify([denied]), NOW);
  db.prepare('UPDATE chunks SET digest_block_id=? WHERE id=?').run(block.lastInsertRowid, denied);
  const view = await preview(source, { target });
  expect(view.status).toBe('ready');
  expect(calls[0]!.prompt).not.toContain('IGNORED-CONTENT');
  expect(calls[0]!.prompt).not.toContain('REFUSED-CONTENT');
  expect(calls[0]!.prompt).toContain('LATER-CONTENT');
  expect(view.coverage!.sessions).toMatchObject([{ session_key: A, status: 'ignored', chunks_read: 0 }, { session_key: B, status: 'partial', chunks_read: 1, refused_chunks: 1 }, { session_key: C, status: 'read' }]);
  expect(db.prepare('SELECT count(*) AS n FROM digest_blocks').get()).toEqual({ n: 1 });

  const none = project('空来源', []);
  op('ignore_session', { session: C, ignored: true });
  calls = [];
  const empty = await preview(none, { target });
  expect(empty).toMatchObject({ status: 'failed' });
  expect(calls).toHaveLength(0);
});

test('a long history is read window by window, and a fact at its very end reaches the draft with its chunk', async () => {
  const source = project('来源', [A]);
  const target = project('目标', [C]);
  for (let i = 0; i < 5; i++) chunk(A, `${i} ${'x'.repeat(WINDOW_CHARS / 2)}`);
  const last = chunk(A, 'assistant: 结论：改为只读对账 FINAL-DECISION');
  chunk(C, 'target content');
  answer = (call) => {
    if (call.prompt.includes('<chunk id=')) {
      const ids = chunkIds(call.prompt);
      return ok({ facts: [{ type: 'decision', text: call.prompt.includes('FINAL-DECISION') ? '最后决定只读对账' : '中间过程', chunk_ids: [ids.at(-1)!] }, { type: 'status', text: '没有依据的说法', chunk_ids: [424242] }] });
    }
    return ok(draft(call.prompt, { evidence: [{ field: 'summary', chunk_ids: [last] }, { field: 'done_criteria', chunk_ids: [last] }] }));
  };
  const view = await preview(source, { target });
  expect(view.status).toBe('ready');
  expect(view.coverage).toMatchObject({ mode: 'condensed', model_calls: calls.length });
  expect(calls.length).toBeGreaterThan(3);
  const final = calls.at(-1)!.prompt;
  expect(final).toContain('最后决定只读对账');
  expect(final).toContain(`chunk ${last}`);
  expect(final).not.toContain('没有依据的说法');
  expect(view.coverage!.sessions[0]).toMatchObject({ session_key: A, status: 'read', chunks_read: 6, chunks_total: 6 });
});

test('a history beyond the window budget keeps each session’s start and latest content and reports what was skipped', async () => {
  const source = project('来源', [A]);
  const target = project('目标', []);
  const total = MAX_WINDOWS + 6;
  for (let i = 0; i < total; i++) chunk(A, `${i === 0 ? 'FIRST-GOAL' : i === total - 1 ? 'LATEST-RESULT' : `MIDDLE-${i}`} ${'y'.repeat(WINDOW_CHARS - 100)}`);
  answer = (call) => (call.prompt.includes('<chunk id=') ? ok({ facts: [{ type: 'status', text: 'f', chunk_ids: [chunkIds(call.prompt)[0]!] }] }) : ok(draft(call.prompt)));
  const view = await preview(source, { target });
  const read = calls.map((c) => c.prompt).join('\n');
  expect(read).toContain('FIRST-GOAL');
  expect(read).toContain('LATEST-RESULT');
  expect(read).not.toContain('MIDDLE-3 ');
  expect(calls).toHaveLength(MAX_WINDOWS + 1);
  expect(view.coverage!.sessions[0]).toMatchObject({ status: 'partial', chunks_total: total, chunks_read: MAX_WINDOWS });
  expect(calls.at(-1)!.prompt).toContain('partial');
});

test('a preview goes stale when its inputs change, and one overtaken while it was being written fails', async () => {
  const source = project('来源', [A, B]);
  const target = project('目标', [C]);
  chunk(A, 'a');
  const view = await preview(source, { target, sessions: [A] });
  chunk(A, 'the session went on');
  const after = (await http('GET', `/merge-previews/${view.id}`)).body as MergePreviewView;
  expect(after).toMatchObject({ status: 'ready', stale: true, changes: null });
  const refused = await http('POST', `/merge-previews/${view.id}/apply`, {});
  expect(refused).toMatchObject({ status: 409, body: { error: 'stale' } });
  expect(await sessionsOf(target)).toEqual([C]);

  answer = (call) => {
    op('update_project', { project: target, fields: { why: '用户在生成期间改了' } });
    return ok(draft(call.prompt));
  };
  expect(await preview(source, { target, sessions: [A] })).toMatchObject({ status: 'failed', draft: null });
  // Building it again from the current state works.
  answer = (call) => ok(draft(call.prompt));
  const fresh = await preview(source, { target, sessions: [A] });
  expect(fresh.changes!.fields).toContainEqual({ field: 'why', before: '用户在生成期间改了', after: '项目判断依赖完整证据', locked: true });
  expect((await http('POST', `/merge-previews/${fresh.id}/apply`, {})).status).toBe(200);
  expect((await detail(target)).why).toBe('用户在生成期间改了');
});

test('the routes need the user, a valid scope and the understanding layer', async () => {
  const source = project('来源', [A]);
  const target = project('目标', []);
  expect((await app.request(`/projects/${source}/merge-previews`, { method: 'POST', body: '{}' })).status).toBe(401);
  expect((await http('POST', `/projects/${source}/merge-previews`, { target, sessions: [B] })).status).toBe(400);
  expect((await http('POST', `/projects/${source}/merge-previews`, { target: source })).status).toBe(400);
  expect((await http('POST', `/projects/p_missing/merge-previews`, { target })).status).toBe(404);
  expect((await http('GET', '/merge-previews/mp_missing')).status).toBe(404);
  const off = createApp(db, config, deps.now, deps.newId);
  const res = await off.request(`/projects/${source}/merge-previews`, { method: 'POST', headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ target }) });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: 'understanding_disabled' });
});

test('only one preview is drafted at a time, and a draft may leave why and the criteria empty rather than invent them', async () => {
  const source = project('来源', [A]);
  const target = project('目标', []);
  chunk(A, 'a');
  let release = () => {};
  answer = (call) => new Promise((resolve) => (release = () => resolve(ok(draft(call.prompt, { why: '', done_criteria: [], evidence: [{ field: 'summary', chunk_ids: [chunkIds(call.prompt)[0]!] }] })))));
  const first = await http('POST', `/projects/${source}/merge-previews`, { target });
  expect(first.status).toBe(202);
  expect(await http('POST', `/projects/${source}/merge-previews`, { target })).toMatchObject({ status: 409, body: { error: 'conflict' } });
  await new Promise((r) => setTimeout(r, 5));
  release();
  await new Promise((r) => setTimeout(r, 5));
  const view = (await http('GET', `/merge-previews/${first.body.id}`)).body as MergePreviewView;
  expect(view).toMatchObject({ status: 'ready', draft: { why: '', done_criteria: '' } });
  expect(view.changes!.fields.map((f) => f.field)).toEqual(['title', 'summary']);
  expect(view.draft!.title_change_reason).toBe('目标已从泛泛的采集变成采集可靠性');
  expect(calls[0]!.system).toContain('不要为了填满而编写');
});

test('a draft keeps the target project title unless it says why the name no longer fits, and is told the sessions project names', async () => {
  const source = project('来源', [A]);
  const target = project('agent-pm', [C]);
  db.prepare("INSERT INTO session_sources (source_id, external_id, session_key, project_name, lifecycle) VALUES ('paseo-x', 'agent-a', ?, 'agent-pm', 'live')").run(A);
  chunk(A, 'a');
  answer = (call) => ok(draft(call.prompt, { title: '另起的名字', title_change_reason: '' }));
  const kept = await preview(source, { target });
  expect(kept.draft).toMatchObject({ title: 'agent-pm', title_change_reason: null });
  expect(kept.changes!.fields.map((f) => f.field)).not.toContain('title');
  expect(calls[0]!.prompt).toContain('- agent-pm（1 个 session）');
  expect(calls[0]!.system).toContain('title 默认沿用目标项目现在的标题');
});
