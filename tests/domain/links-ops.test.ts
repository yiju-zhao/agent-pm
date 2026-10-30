import { afterEach, beforeEach, expect, test } from 'vitest';
import { HANDLERS } from '../../src/domain/execute.ts';
import { resolveSessionKey } from '../../src/domain/links-ops.ts';
import { OP_SCHEMAS } from '../../src/domain/ops.ts';
import { applySnapshot } from '../../src/server/sessions-repo.ts';
import type { SnapshotSession } from '../../src/shared/protocol.ts';
import { count, eventsFor, lastEvent, NOW, row, rows, setup } from './helpers.ts';
import type { Row, Setup } from './helpers.ts';

let t: Setup;

beforeEach(() => {
  t = setup();
});

afterEach(() => {
  t.db.close();
});

const S = 'claude:aaaa1111';
const S2 = 'codex:bbbb2222';

const contribution = (id = 'c_1'): Row => row(t.db, 'contributions', id);
const question = (id: string): Row => row(t.db, 'questions', id);
const session = (key: string): Row => {
  const found = t.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key);
  if (!found) throw new Error(`no session ${key}`);
  return { ...found };
};
const parse = (text: unknown): unknown => JSON.parse(String(text));

function addSession(key: string, extra: { merged_into?: string; ignored?: number } = {}): void {
  t.db
    .prepare(
      `INSERT INTO sessions (key, agent_kind, machine, terminal_id, lifecycle, live_status, ignored, merged_into,
                             first_seen, last_seen)
       VALUES (?, ?, 'laptop', 'term_1', 'live', 'idle', ?, ?, ?, ?)`,
    )
    .run(key, key.slice(0, key.indexOf(':')), extra.ignored ?? 0, extra.merged_into ?? null, NOW, NOW);
}

beforeEach(() => {
  addSession(S);
  addSession(S2);
});

function userProject(title = '用户项目'): string {
  return t.user('create_project', { title }).id;
}

// ---- registration and resolveSessionKey --------------------------------------------------------------------------

test('the three link ops are registered and create_project takes from_session', () => {
  for (const op of ['link_session', 'unlink_session', 'ignore_session'] as const) {
    expect(HANDLERS[op], op).toBeTypeOf('function');
  }
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', from_session: S }).success).toBe(true);
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', from_session: '' }).success).toBe(false);
});

test('resolveSessionKey returns the key itself, follows merged_into, and is null for an unknown session', () => {
  addSession('pending:laptop:term_1', { merged_into: S });
  expect(resolveSessionKey(t.db, S)).toBe(S);
  expect(resolveSessionKey(t.db, 'pending:laptop:term_1')).toBe(S);
  expect(resolveSessionKey(t.db, 'claude:nope')).toBeNull();
});

test('resolveSessionKey follows at most 5 merged_into hops', () => {
  const chain = ['k:0', 'k:1', 'k:2', 'k:3', 'k:4', 'k:5', 'k:6', 'k:7'];
  chain.forEach((key, i) => addSession(key, i + 1 < chain.length ? { merged_into: chain[i + 1] } : {}));
  expect(resolveSessionKey(t.db, 'k:0')).toBe('k:5');
  expect(resolveSessionKey(t.db, 'k:3')).toBe('k:7');
});

test('resolveSessionKey stops on a merged_into cycle instead of looping', () => {
  addSession('a:1', { merged_into: 'a:2' });
  addSession('a:2', { merged_into: 'a:1' });
  expect(['a:1', 'a:2']).toContain(resolveSessionKey(t.db, 'a:1'));
});

// ---- link_session ------------------------------------------------------------------------------------------------

test('linking creates one contribution and one event filed under the project', () => {
  const p = userProject();
  const r = t.ai('link_session', {
    session: S,
    project: p,
    summary: '调研 dLLM 基线',
    ts_start: '2026-10-29T10:00:00Z',
    ts_end: '2026-10-29T11:00:00Z',
    confidence: 0.8,
  });
  expect(r).toMatchObject({ status: 'applied', id: 'c_1', question_ids: [] });
  expect(contribution()).toMatchObject({
    session_key: S,
    project_id: p,
    milestone_id: null,
    summary: '调研 dLLM 基线',
    ts_start: '2026-10-29T10:00:00.000Z',
    ts_end: '2026-10-29T11:00:00.000Z',
    confidence: 0.8,
    actor: 'ai:curator',
    created_at: NOW,
    deleted_at: null,
    vetoed: 0,
  });
  const events = eventsFor(t.db, p).filter((e) => e.op === 'link_session');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ id: r.event_id, entity: 'contributions:c_1', project_id: p, actor: 'ai:curator', is_veto: 0 });
});

test('a bare link leaves summary, times and confidence empty', () => {
  const p = userProject();
  t.user('link_session', { session: S, project: p });
  expect(contribution()).toMatchObject({
    actor: 'user',
    milestone_id: null,
    summary: null,
    ts_start: null,
    ts_end: null,
    confidence: null,
  });
});

test('linking twice widens the time range and keeps one row', () => {
  const p = userProject();
  const s = S;
  t.ai('link_session', { session: s, project: p, ts_start: '2026-10-29T10:00:00Z', ts_end: '2026-10-29T11:00:00Z' });
  t.ai('link_session', { session: s, project: p, ts_start: '2026-10-29T09:00:00Z', ts_end: '2026-10-29T10:30:00Z' });
  expect(rows(t.db, 'contributions')).toEqual([
    expect.objectContaining({ ts_start: '2026-10-29T09:00:00.000Z', ts_end: '2026-10-29T11:00:00.000Z' }),
  ]);
  // A later range only moves the end; an inner range changes nothing.
  t.ai('link_session', { session: s, project: p, ts_start: '2026-10-29T10:10:00Z', ts_end: '2026-10-29T12:00:00Z' });
  expect(contribution()).toMatchObject({ ts_start: '2026-10-29T09:00:00.000Z', ts_end: '2026-10-29T12:00:00.000Z' });
  expect(count(t.db, 'contributions')).toBe(1);
});

test('a link that gives a range to a row without one just sets it', () => {
  const p = userProject();
  t.ai('link_session', { session: S, project: p });
  t.ai('link_session', { session: S, project: p, ts_start: '2026-10-29T10:00:00Z', ts_end: '2026-10-29T11:00:00Z' });
  expect(contribution()).toMatchObject({ ts_start: '2026-10-29T10:00:00.000Z', ts_end: '2026-10-29T11:00:00.000Z' });
});

test('relinking changes only the fields that were passed; milestone_id null clears it', () => {
  const p = userProject();
  const m = t.user('upsert_milestone', { project: p, title: '基线' }).id;
  t.ai('link_session', { session: S, project: p, milestone_id: m, summary: '第一版', confidence: 0.5 });
  t.ai('link_session', { session: S, project: p, confidence: 0.9 });
  expect(contribution()).toMatchObject({ milestone_id: m, summary: '第一版', confidence: 0.9 });
  t.ai('link_session', { session: S, project: p, summary: '第二版' });
  expect(contribution()).toMatchObject({ milestone_id: m, summary: '第二版', confidence: 0.9 });
  t.ai('link_session', { session: S, project: p, milestone_id: null });
  expect(contribution()).toMatchObject({ milestone_id: null, summary: '第二版' });
});

test('relinking with nothing new changes nothing and writes no event', () => {
  const p = userProject();
  t.ai('link_session', { session: S, project: p, summary: 's' });
  const before = count(t.db, 'events');
  expect(t.ai('link_session', { session: S, project: p, summary: 's' })).toMatchObject({ status: 'applied', event_id: null });
  expect(count(t.db, 'events')).toBe(before);
});

test('one session can be linked to several projects, one row each', () => {
  const a = userProject('A');
  const b = userProject('B');
  t.ai('link_session', { session: S, project: a });
  t.ai('link_session', { session: S, project: b });
  expect(rows(t.db, 'contributions').map((c) => [c.session_key, c.project_id])).toEqual([[S, a], [S, b]]);
});

test('link_session rejects an unknown session, an unknown project and a deleted project', () => {
  const p = userProject();
  expect(t.user('link_session', { session: 'claude:nope', project: p })).toMatchObject({ status: 'rejected', code: 'not_found' });
  expect(t.user('link_session', { session: S, project: 'p_99' })).toMatchObject({ status: 'rejected', code: 'not_found' });
  t.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(NOW, p);
  expect(t.user('link_session', { session: S, project: p })).toMatchObject({ status: 'rejected', code: 'not_found' });
  expect(count(t.db, 'contributions')).toBe(0);
  expect(count(t.db, 'events')).toBe(1); // only the create_project
});

test('an AI may not link to a merged project, a user may', () => {
  const a = userProject('A');
  const b = userProject('B');
  t.user('transition_stage', { project: a, stage: 'merged', merge_into: b });
  expect(t.ai('link_session', { session: S, project: a })).toMatchObject({ status: 'rejected', code: 'merged' });
  expect(t.user('link_session', { session: S, project: a })).toMatchObject({ status: 'applied' });
});

test('the milestone must be a live milestone of the same project', () => {
  const p = userProject('A');
  const other = userProject('B');
  const foreign = t.user('upsert_milestone', { project: other, title: '别处' }).id;
  const gone = t.user('upsert_milestone', { project: p, title: '已删' }).id;
  t.user('delete_milestone', { project: p, id: gone });
  for (const milestone_id of [foreign, gone, 'm_99']) {
    expect(t.user('link_session', { session: S, project: p, milestone_id }), milestone_id).toMatchObject({
      status: 'rejected',
      code: 'invalid',
    });
    expect(t.ai('link_session', { session: S, project: p, milestone_id }), milestone_id).toMatchObject({ code: 'invalid' });
  }
  expect(count(t.db, 'contributions')).toBe(0);
  // The same rule holds when the row already exists.
  t.user('link_session', { session: S, project: p });
  expect(t.user('link_session', { session: S, project: p, milestone_id: foreign })).toMatchObject({ code: 'invalid' });
  expect(contribution().milestone_id).toBeNull();
});

test('after the user unlinks, an ai relink becomes a confirm question instead of a link', () => {
  const p = userProject('dLLM 评测');
  const s = S;
  t.user('link_session', { session: s, project: p });
  t.user('unlink_session', { session: s, project: p });
  const r = t.ai('link_session', { session: s, project: p, summary: '又在做它' }, { reason: '它在跑评测', evidence: ['chunk:9#L3'] });
  expect(r).toMatchObject({ status: 'proposed', question_ids: ['q_1'] });
  expect(contribution()).toMatchObject({ vetoed: 1, deleted_at: NOW });

  const q = question('q_1');
  expect(q).toMatchObject({
    kind: 'confirm',
    prompt: `AI 想把 session ${s} 重新关联到「dLLM 评测」（你之前取消过）：它在跑评测`,
    project_id: p,
    session_key: s,
    status: 'pending',
    dedupe_key: `link:${s}:${p}`,
    created_by: 'ai:curator',
  });
  expect(parse(q.guards)).toEqual([{ table: 'contributions', id: 'c_1', col: 'deleted_at', equals: NOW }]);
  expect(parse(q.evidence)).toEqual(['chunk:9#L3']);
  expect(parse(q.options)).toEqual([
    { label: '确认', op: 'link_session', args: { session: s, project: p, summary: '又在做它' } },
    { label: '拒绝', op: null },
  ]);
});

test('the user can relink a vetoed pair directly', () => {
  const p = userProject();
  const m = t.user('upsert_milestone', { project: p, title: 'm' }).id;
  t.user('link_session', { session: S, project: p, ts_start: '2026-10-29T10:00:00Z', ts_end: '2026-10-29T11:00:00Z' });
  t.user('unlink_session', { session: S, project: p });
  const r = t.user('link_session', { session: S, project: p, milestone_id: m, summary: '回来了', ts_end: '2026-10-29T12:00:00Z' });
  expect(r).toMatchObject({ status: 'applied', id: 'c_1' });
  expect(count(t.db, 'contributions')).toBe(1);
  expect(contribution()).toMatchObject({
    deleted_at: null,
    vetoed: 0,
    actor: 'user',
    milestone_id: m,
    summary: '回来了',
    ts_start: '2026-10-29T10:00:00.000Z',
    ts_end: '2026-10-29T12:00:00.000Z',
  });
});

test('confirming the relink question links the pair and settles the question', () => {
  const p = userProject();
  t.user('link_session', { session: S, project: p });
  t.user('unlink_session', { session: S, project: p });
  const q = t.ai('link_session', { session: S, project: p }).question_ids[0];
  const option = (parse(question(q).options) as Array<{ op: string | null; args?: object }>)[0];
  expect(t.user(option.op as 'link_session', option.args)).toMatchObject({ status: 'applied' });
  expect(contribution()).toMatchObject({ deleted_at: null, vetoed: 0 });
});

test('a relink question is withdrawn once the user relinks the pair directly', () => {
  const p = userProject();
  t.user('link_session', { session: S, project: p });
  t.user('unlink_session', { session: S, project: p });
  const q = t.ai('link_session', { session: S, project: p }).question_ids[0];
  t.user('link_session', { session: S, project: p });
  expect(question(q)).toMatchObject({ status: 'withdrawn', resolution_note: 'stale' });
});

test('asking twice to relink the same pair shares one question', () => {
  const p = userProject();
  t.user('link_session', { session: S, project: p });
  t.user('unlink_session', { session: S, project: p });
  const first = t.ai('link_session', { session: S, project: p }, { evidence: ['chunk:1'] });
  const second = t.ai('link_session', { session: S, project: p }, { evidence: ['chunk:2'] });
  expect(second.question_ids).toEqual(first.question_ids);
  expect(count(t.db, 'questions')).toBe(1);
  expect(parse(question(first.question_ids[0]).evidence)).toEqual(['chunk:1', 'chunk:2']);
});

test('a link the AI removed itself can be restored by anyone', () => {
  const p = userProject();
  t.ai('link_session', { session: S, project: p, summary: '第一次' });
  t.ai('unlink_session', { session: S, project: p });
  expect(contribution()).toMatchObject({ deleted_at: NOW, vetoed: 0 });

  expect(t.ai('link_session', { session: S, project: p, summary: 'AI 又关联' })).toMatchObject({ status: 'applied' });
  expect(contribution()).toMatchObject({ deleted_at: null, vetoed: 0, summary: 'AI 又关联', actor: 'ai:curator' });

  t.ai('unlink_session', { session: S, project: p });
  expect(t.user('link_session', { session: S, project: p })).toMatchObject({ status: 'applied' });
  expect(contribution()).toMatchObject({ deleted_at: null, vetoed: 0, actor: 'user' });
  expect(count(t.db, 'contributions')).toBe(1);
});

test('a user link takes over an AI link, so the AI can no longer unlink it directly', () => {
  const p = userProject();
  t.ai('link_session', { session: S, project: p });
  t.user('link_session', { session: S, project: p, summary: '我确认' });
  expect(contribution()).toMatchObject({ actor: 'user', summary: '我确认' });
  expect(t.ai('unlink_session', { session: S, project: p })).toMatchObject({ status: 'proposed' });
  expect(contribution().deleted_at).toBeNull();
});

test('linking a merged pending key links its native session', () => {
  const P = 'pending:laptop:term_1';
  addSession(P, { merged_into: S });
  const p = userProject();
  const r = t.ai('link_session', { session: P, project: p });
  expect(r).toMatchObject({ status: 'applied' });
  expect(contribution()).toMatchObject({ session_key: S, project_id: p });
  // The pending key and the native key are the same session: no second row.
  t.ai('link_session', { session: S, project: p, summary: '同一个' });
  expect(count(t.db, 'contributions')).toBe(1);
});

test('a veto on a native key blocks an AI relink that comes in through its merged pending key', () => {
  const P = 'pending:laptop:term_1';
  addSession(P, { merged_into: S });
  const p = userProject();
  t.user('link_session', { session: S, project: p });
  t.user('unlink_session', { session: S, project: p });
  expect(t.ai('link_session', { session: P, project: p })).toMatchObject({ status: 'proposed' });
  expect(question('q_1')).toMatchObject({ session_key: S, dedupe_key: `link:${S}:${p}` });
  expect(parse(question('q_1').options)).toMatchObject([{ args: { session: S, project: p } }, {}]);
});

test('a link made on a pending key follows the session through the snapshot merge', () => {
  const machine = 'laptop';
  const snapshot = (sessions: SnapshotSession[], at: string) =>
    applySnapshot(t.db, { machine, collector_version: '0.1.0', sessions, purged: [] }, new Date(at));
  const reported = (key: string, native: string | null): SnapshotSession => ({
    key,
    agent_kind: 'codex',
    native_id: native,
    pane_id: 'w1:1:1',
    terminal_id: 'term_9',
    workspace_id: 'w1',
    tab_id: 'w1:1',
    cwd: '/x',
    title: 't',
    live_status: 'working',
    fidelity: native ? 'full' : 'screen',
    transcript_path: native ? '/x.jsonl' : null,
  });
  const P = 'pending:laptop:term_9';
  const N = 'codex:cccc3333';
  snapshot([reported(P, null)], '2026-10-29T10:00:00Z');
  const p = userProject();
  t.ai('link_session', { session: P, project: p });
  expect(contribution().session_key).toBe(P);

  snapshot([reported(N, 'cccc3333')], '2026-10-29T10:00:10Z');
  expect(contribution().session_key).toBe(N);
  expect(t.ai('link_session', { session: P, project: p, summary: '合并后' })).toMatchObject({ status: 'applied' });
  expect(rows(t.db, 'contributions')).toEqual([expect.objectContaining({ session_key: N, summary: '合并后' })]);
});

// ---- unlink_session ----------------------------------------------------------------------------------------------

test('unlink_session with no live link is not_found', () => {
  const p = userProject();
  expect(t.user('unlink_session', { session: S, project: p })).toMatchObject({ status: 'rejected', code: 'not_found' });
  expect(t.ai('unlink_session', { session: S, project: p })).toMatchObject({ code: 'not_found' });
  expect(t.user('unlink_session', { session: 'claude:nope', project: p })).toMatchObject({ code: 'not_found' });
  expect(t.user('unlink_session', { session: S, project: 'p_99' })).toMatchObject({ code: 'not_found' });
  t.user('link_session', { session: S, project: p });
  t.user('unlink_session', { session: S, project: p });
  expect(t.user('unlink_session', { session: S, project: p })).toMatchObject({ code: 'not_found' });
  expect(t.ai('unlink_session', { session: S, project: p })).toMatchObject({ code: 'not_found' });
});

test('a user unlink leaves a vetoing tombstone and a veto event', () => {
  const p = userProject();
  t.user('link_session', { session: S, project: p });
  const r = t.user('unlink_session', { session: S, project: p });
  expect(r).toMatchObject({ status: 'applied' });
  expect(contribution()).toMatchObject({ deleted_at: NOW, vetoed: 1 });
  expect(lastEvent(t.db)).toMatchObject({ id: r.event_id, op: 'unlink_session', entity: 'contributions:c_1', project_id: p, is_veto: 1 });
});

test('a user unlink of an AI link is also a veto', () => {
  const p = userProject();
  t.ai('link_session', { session: S, project: p });
  t.user('unlink_session', { session: S, project: p });
  expect(contribution()).toMatchObject({ vetoed: 1 });
  expect(t.ai('link_session', { session: S, project: p })).toMatchObject({ status: 'proposed' });
});

test('an AI unlink of an AI link is a plain tombstone', () => {
  const p = userProject();
  t.ai('link_session', { session: S, project: p });
  const r = t.ai('unlink_session', { session: S, project: p });
  expect(r).toMatchObject({ status: 'applied' });
  expect(contribution()).toMatchObject({ deleted_at: NOW, vetoed: 0 });
  expect(lastEvent(t.db)).toMatchObject({ op: 'unlink_session', is_veto: 0 });
});

test('an AI unlink of a link the user made becomes a confirm question', () => {
  const p = userProject('dLLM 评测');
  t.user('link_session', { session: S, project: p });
  const r = t.ai('unlink_session', { session: S, project: p }, { reason: '它其实在做别的' });
  expect(r).toMatchObject({ status: 'proposed', question_ids: ['q_1'] });
  expect(contribution().deleted_at).toBeNull();

  const q = question('q_1');
  expect(q).toMatchObject({
    kind: 'confirm',
    prompt: `AI 想取消你建立的关联：session ${S} ↔「dLLM 评测」：它其实在做别的`,
    project_id: p,
    session_key: S,
    dedupe_key: `unlink:${S}:${p}`,
  });
  expect(parse(q.guards)).toEqual([{ table: 'contributions', id: 'c_1', col: 'deleted_at', equals: null }]);
  expect(parse(q.options)).toEqual([
    { label: '确认', op: 'unlink_session', args: { session: S, project: p } },
    { label: '拒绝', op: null },
  ]);
});

test('confirming the unlink question unlinks as a veto; the question goes stale if the link is removed first', () => {
  const p = userProject();
  t.user('link_session', { session: S, project: p });
  const q = t.ai('unlink_session', { session: S, project: p }).question_ids[0];
  const option = (parse(question(q).options) as Array<{ op: string | null; args?: object }>)[0];
  expect(t.user(option.op as 'unlink_session', option.args)).toMatchObject({ status: 'applied' });
  expect(contribution()).toMatchObject({ vetoed: 1 });
  expect(question(q)).toMatchObject({ status: 'withdrawn', resolution_note: 'stale' });
});

test('unlinking through a merged pending key finds the native link', () => {
  const P = 'pending:laptop:term_1';
  addSession(P, { merged_into: S });
  const p = userProject();
  t.user('link_session', { session: S, project: p });
  expect(t.user('unlink_session', { session: P, project: p })).toMatchObject({ status: 'applied' });
  expect(contribution()).toMatchObject({ session_key: S, vetoed: 1 });
});

// ---- ignore_session ----------------------------------------------------------------------------------------------

test('ai ignore_session is proposed; user ignore_session sets the flag', () => {
  const r = t.ai('ignore_session', { session: S }, { reason: '只是个临时 shell' });
  expect(r).toMatchObject({ status: 'proposed', question_ids: ['q_1'] });
  expect(session(S).ignored).toBe(0);
  expect(question('q_1')).toMatchObject({
    kind: 'confirm',
    prompt: `AI 建议不再追踪 session ${S}：只是个临时 shell`,
    project_id: null,
    session_key: S,
    dedupe_key: `ignore:${S}`,
  });
  expect(parse(question('q_1').guards)).toEqual([{ table: 'sessions', id: S, col: 'ignored', equals: 0 }]);
  expect(parse(question('q_1').options)).toEqual([
    { label: '确认', op: 'ignore_session', args: { session: S, ignored: true } },
    { label: '拒绝', op: null },
  ]);

  const u = t.user('ignore_session', { session: S });
  expect(u).toMatchObject({ status: 'applied' });
  expect(session(S).ignored).toBe(1);
  expect(lastEvent(t.db)).toMatchObject({ id: u.event_id, op: 'ignore_session', entity: `sessions:${S}`, project_id: null, is_veto: 0 });
  expect(question('q_1')).toMatchObject({ status: 'withdrawn', resolution_note: 'stale' });

  t.user('ignore_session', { session: S, ignored: false });
  expect(session(S).ignored).toBe(0);
});

test('confirming the ignore question ignores the session', () => {
  const q = t.ai('ignore_session', { session: S }).question_ids[0];
  const option = (parse(question(q).options) as Array<{ op: string | null; args?: object }>)[0];
  expect(t.user(option.op as 'ignore_session', option.args)).toMatchObject({ status: 'applied' });
  expect(session(S).ignored).toBe(1);
});

test('an AI proposal to ignore twice shares one question', () => {
  const a = t.ai('ignore_session', { session: S }, { evidence: ['chunk:1'] });
  const b = t.ai('ignore_session', { session: S }, { evidence: ['chunk:2'] });
  expect(b.question_ids).toEqual(a.question_ids);
  expect(count(t.db, 'questions')).toBe(1);
});

test('an AI proposal to ignore an already ignored session asks nothing; un-ignoring is proposed with its own wording', () => {
  addSession('claude:cccc3333', { ignored: 1 });
  const key = 'claude:cccc3333';
  expect(t.ai('ignore_session', { session: key })).toMatchObject({ status: 'applied', event_id: null, question_ids: [] });
  expect(count(t.db, 'questions')).toBe(0);

  const r = t.ai('ignore_session', { session: key, ignored: false }, { reason: '其实在干活' });
  expect(r).toMatchObject({ status: 'proposed' });
  expect(question(r.question_ids[0]).prompt).toBe(`AI 建议恢复追踪 session ${key}：其实在干活`);
  expect(parse(question(r.question_ids[0]).guards)).toEqual([{ table: 'sessions', id: key, col: 'ignored', equals: 1 }]);
});

test('ignore_session on an unknown session is not_found; a merged pending key ignores the native session', () => {
  expect(t.user('ignore_session', { session: 'claude:nope' })).toMatchObject({ status: 'rejected', code: 'not_found' });
  expect(t.ai('ignore_session', { session: 'claude:nope' })).toMatchObject({ code: 'not_found' });
  const P = 'pending:laptop:term_1';
  addSession(P, { merged_into: S });
  t.user('ignore_session', { session: P });
  expect(session(S).ignored).toBe(1);
  expect(session(P).ignored).toBe(0);
});

test('ignoring an already ignored session as the user changes nothing', () => {
  t.user('ignore_session', { session: S });
  const before = count(t.db, 'events');
  expect(t.user('ignore_session', { session: S })).toMatchObject({ status: 'applied', event_id: null });
  expect(count(t.db, 'events')).toBe(before);
});

// ---- create_project from_session ---------------------------------------------------------------------------------

test('create_project with from_session links it in the same event', () => {
  const r = t.user('create_project', { title: '从 session 开的项目', from_session: S });
  expect(r).toMatchObject({ status: 'applied', id: 'p_1' });
  expect(count(t.db, 'events')).toBe(1);
  expect(rows(t.db, 'contributions')).toEqual([
    expect.objectContaining({ id: 'c_1', session_key: S, project_id: 'p_1', actor: 'user', deleted_at: null }),
  ]);
  const event = lastEvent(t.db);
  expect(event).toMatchObject({ id: r.event_id, op: 'create_project', project_id: 'p_1', entity: 'projects:p_1' });
  expect(Object.keys(parse(event.after) as object).sort()).toEqual(['contributions:c_1', 'projects:p_1']);
  expect(parse(event.args)).toEqual({ title: '从 session 开的项目', from_session: S });
});

test('an AI create_project with from_session links as that AI', () => {
  const r = t.ai('create_project', { title: 'AI 开的', from_session: S });
  expect(r).toMatchObject({ status: 'applied', id: 'p_1' });
  expect(contribution()).toMatchObject({ actor: 'ai:curator', session_key: S, project_id: 'p_1' });
  expect(count(t.db, 'events')).toBe(1);
});

test('create_project with an unknown from_session is rejected and creates nothing', () => {
  expect(t.user('create_project', { title: 'x', from_session: 'claude:nope' })).toMatchObject({ status: 'rejected', code: 'not_found' });
  expect(t.ai('create_project', { title: 'x', from_session: 'claude:nope' })).toMatchObject({ code: 'not_found' });
  expect(count(t.db, 'projects')).toBe(0);
  expect(count(t.db, 'contributions')).toBe(0);
  expect(count(t.db, 'events')).toBe(0);
});

test('create_project from a merged pending key links the native session', () => {
  const P = 'pending:laptop:term_1';
  addSession(P, { merged_into: S });
  t.user('create_project', { title: 'x', from_session: P });
  expect(contribution()).toMatchObject({ session_key: S });
});
