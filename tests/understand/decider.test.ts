import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { askUser } from '../../src/domain/questions.ts';
import { listQuestions } from '../../src/domain/read.ts';
import { AUTO_CONFIDENCE, jevDecider, llmDecider, pickTriage, runTriage } from '../../src/understand/decider.ts';
import type { Decider, DecisionInput } from '../../src/understand/decider.ts';
import type { LlmCall, LlmResult } from '../../src/understand/llm.ts';
import { Scheduler } from '../../src/understand/scheduler.ts';
import { NOW, setup } from '../domain/helpers.ts';
import type { Setup } from '../domain/helpers.ts';

let t: Setup;
const S = 'claude:aaaa1111';
let chunk: number;

beforeEach(() => {
  t = setup();
  t.db.prepare(`INSERT INTO sessions (key, agent_kind, machine, cwd, title, live_status, lifecycle, ignored, first_seen, last_seen) VALUES (?, 'claude', 'm', '/w', '讲故事 app', 'idle', 'live', 0, ?, ?)`).run(S, NOW, NOW);
  chunk = Number(t.db.prepare("INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill) VALUES (?, 'transcript', 1, 2, ?, ?, 'user: 在 openlingo 仓库里加绘本朗读', 0)").run(S, NOW, NOW).lastInsertRowid);
});
afterEach(() => t.db.close());

/** A decider that answers as told and remembers what it was asked. */
function scripted(answer: { option_index: number; confidence: number } | 'fail'): Decider & { inputs: DecisionInput[] } {
  const inputs: DecisionInput[] = [];
  return {
    name: 'test',
    inputs,
    async decide(input) {
      inputs.push(input);
      return answer === 'fail' ? { ok: false, kind: 'overloaded', message: 'busy' } : { ok: true, ...answer, reason: '证据里说在 openlingo 仓库' };
    },
  };
}

/** An old-style question (no why_user) that only places a session: which a decider may settle. */
function attribution(project: string): string {
  const r = askUser(t.db, t.deps, {
    kind: 'choice', prompt: '这个 session 属于哪个项目？', session_key: S, evidence: [`chunk:${chunk}`],
    options: [{ label: '关联到 openlingo', op: 'link_session', args: { session: S, project } }, { label: '都不是', op: null }],
  }, 'ai:curator') as { question_ids: string[] };
  return r.question_ids[0]!;
}

test('a sure decider settles a question that only places a session, as an AI change the user can undo', async () => {
  const p = t.user('create_project', { title: 'openlingo' }).id;
  const q = attribution(p);
  const decider = scripted({ option_index: 0, confidence: 0.92 });
  const out = await runTriage(t.db, t.deps, decider, pickTriage(t.db, t.deps.now())!);
  expect(out).toMatchObject({ status: 'decided', option_index: 0 });
  expect(decider.inputs[0]!.evidence).toContain('在 openlingo 仓库里加绘本朗读');
  expect(decider.inputs[0]!.options.map((o) => o.label)).toEqual(['关联到 openlingo', '都不是']);
  const link = t.db.prepare('SELECT actor FROM contributions WHERE session_key = ? AND project_id = ? AND deleted_at IS NULL').get(S, p);
  expect(link).toEqual({ actor: 'ai:decider' });
  const view = listQuestions(t.db, t.deps, {}).find((x) => x.id === q)!;
  expect(view).toMatchObject({ status: 'answered', resolution_note: 'auto', auto: { decider: 'test', confidence: 0.92, option_index: 0 } });
  const event = t.db.prepare('SELECT actor, reason FROM events WHERE id = ?').get(view.auto!.event_id!) as { actor: string; reason: string };
  expect(event.reason).toMatch(/^自动决定（test，置信度 0\.92）/);
  expect(t.user('revert_event', { event_id: view.auto!.event_id! }).status).toBe('applied');
});

test('an unsure decider, a failed call, or an option an AI may not carry out leaves the question to the user, looked at once', async () => {
  const p = t.user('create_project', { title: 'openlingo' }).id;
  attribution(p);
  for (const decider of [scripted({ option_index: 0, confidence: AUTO_CONFIDENCE - 0.01 }), scripted('fail')]) {
    t.db.prepare('UPDATE questions SET triaged_at = NULL').run();
    const out = await runTriage(t.db, t.deps, decider, pickTriage(t.db, t.deps.now())!);
    expect(out.status).not.toBe('decided');
  }
  expect(pickTriage(t.db, t.deps.now())).toBeNull();
  expect(listQuestions(t.db, t.deps, { status: 'pending' })).toHaveLength(1);
  expect(t.db.prepare('SELECT count(*) AS n FROM contributions').get()).toEqual({ n: 0 });

  const ignore = askUser(t.db, t.deps, { kind: 'choice', prompt: '?', session_key: S, topic: 'ignore', evidence: [`chunk:${chunk}`], options: [{ label: '不追踪', op: 'ignore_session', args: { session: S } }, { label: '保留', op: null }] }, 'ai:curator') as { question_ids: string[] };
  const out = await runTriage(t.db, t.deps, scripted({ option_index: 0, confidence: 0.99 }), pickTriage(t.db, t.deps.now())!);
  expect(out).toMatchObject({ status: 'left' });
  expect(listQuestions(t.db, t.deps, {}).find((x) => x.id === ignore.question_ids[0])!.status).toBe('pending');
});

test('questions about the user’s authority, conflicts, risks, and free text are never given to a decider', () => {
  const p = t.user('create_project', { title: 'p' }).id;
  for (const why of ['user_authority', 'conflict', 'risk'] as const) {
    askUser(t.db, t.deps, { kind: 'confirm', prompt: why, context: 'c', why_user: why, project_id: p, topic: why, evidence: [`chunk:${chunk}`], option: { label: '记下', op: 'record_decision', args: { project: p, text: 'x' } } }, 'ai:curator');
  }
  askUser(t.db, t.deps, { kind: 'text', prompt: '?', context: 'c', why_user: 'missing_information', project_id: p, evidence: [`chunk:${chunk}`], option: { label: '写', op: 'update_project', args: { project: p, fields: {} }, text_arg: 'fields.why' } }, 'ai:curator');
  // A domain proposal (the user's locked text) has its own why.
  t.user('update_project', { project: p, fields: { title: '用户的标题' } });
  t.ai('update_project', { project: p, fields: { title: 'AI 的标题' } });
  expect(pickTriage(t.db, t.deps.now())).toBeNull();
  const missing = askUser(t.db, t.deps, { kind: 'confirm', prompt: '评测集是 v2 吗？', context: 'c', why_user: 'missing_information', project_id: p, topic: 'm', evidence: [`chunk:${chunk}`], option: { label: '是 v2', op: 'record_decision', args: { project: p, text: '评测集用 v2' } } }, 'ai:curator') as { question_ids: string[] };
  expect(pickTriage(t.db, t.deps.now())!.id).toBe(missing.question_ids[0]);
});

test('the scheduler settles such questions before digesting, with the curator model when no Jev key is set', async () => {
  const p = t.user('create_project', { title: 'openlingo' }).id;
  attribution(p);
  const calls: LlmCall[] = [];
  const runner = async (call: LlmCall): Promise<LlmResult> => {
    calls.push(call);
    return { ok: true, text: '', structured: { option_index: 0, confidence: 0.9, reason: '仓库一致' }, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 }, costUsd: 0, durationMs: 1 };
  };
  const scheduler = new Scheduler(t.db, t.deps, runner, { digest: 'd', curate: 'c-model' });
  expect(await scheduler.tick()).toBe('curated');
  expect(calls[0]).toMatchObject({ role: 'curate', model: 'c-model' });
  expect(calls[0]!.prompt).toContain('这个 session 属于哪个项目？');
  expect(listQuestions(t.db, t.deps, { status: 'pending' })).toHaveLength(0);
});

test('Jev is asked one typed choice question with the options as criteria, and its answer maps back', async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ answers: { answer: { type: 'choice', choice: 'o1', confidence: 0.87 } } })));
  const jev = jevDecider({ key: 'k-secret', fetch: fetchMock as unknown as typeof fetch });
  const out = await jev.decide({ question: '属于哪个？', context: null, options: [{ label: 'A', detail: null }, { label: 'B', detail: '第二个' }], project: null, sessions: '', evidence: 'e' });
  expect(out).toEqual({ ok: true, option_index: 1, confidence: 0.87, reason: 'Jev 按证据判断' });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://api.typesafe.ai/v1/systemone');
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k-secret');
  const body = JSON.parse(init.body as string);
  expect(body.questions.answer).toMatchObject({ type: 'choice', criteria: { o0: 'A', o1: 'B：第二个' } });
  expect(body.state).toMatchObject({ question: '属于哪个？', evidence: 'e' });

  const down = jevDecider({ key: 'k', fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch });
  expect(await down.decide({ question: 'q', context: null, options: [], project: null, sessions: '', evidence: '' })).toMatchObject({ ok: false, kind: 'jev' });
});

test('the LLM decider logs its call and refuses an answer that does not fit', async () => {
  const decider = llmDecider(t.db, t.deps, async () => ({ ok: true, text: '', structured: { option_index: 'x' }, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 }, costUsd: 0, durationMs: 1 }), () => 'm');
  expect(await decider.decide({ question: 'q', context: null, options: [{ label: 'A', detail: null }], project: null, sessions: '', evidence: '' })).toMatchObject({ ok: false, kind: 'bad_output' });
  expect(t.db.prepare('SELECT ok, error_kind FROM llm_runs').get()).toEqual({ ok: 0, error_kind: 'bad_output' });
});
