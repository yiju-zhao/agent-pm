import { afterEach, beforeEach, expect, test } from 'vitest';

import { ChangeSet } from '../../src/domain/changes.ts';
import { getEvidence } from '../../src/domain/evidence.ts';
import { execute } from '../../src/domain/execute.ts';
import { getProject } from '../../src/domain/read.ts';
import { readTools } from '../../src/mcp/read-tools.ts';
import { runBlockerReview } from '../../src/understand/blocker-review.ts';
import { curatorTools } from '../../src/understand/curator-tools.ts';
import { renderProjectMarkdown } from '../../src/understand/render.ts';
import { agent, event, PaseoWriter, startCenter, type Center } from '../helpers/center.ts';

let center: Center;
const ref = 's:abcd1234#1';
const deps = { now: () => center.now, newId: (prefix: string) => prefix + '_sample' };
beforeEach(async () => {
  center = startCenter();
  const w = new PaseoWriter(center);
  await w.lease();
  await w.snapshot([agent('a', { native_id: 'abcd1234', native_id_origin: 'runtime' })]);
  const tool = event('tool:x', 3, {
    kind: 'tool',
    text: '',
    tool: {
      name: 'shell',
      input: 'private-command',
      input_truncated: null,
      output: 'output',
      output_truncated: null,
      status: 'completed',
      exit_code: 0,
      error: null,
    },
  });
  await w.batch(
    w.batchBody('a', null, { epoch: 'epoch-1', seq: 3 }, [
      event('msg:u', 1, { kind: 'user', text: 'private-question' }),
      event('msg:a', 2, { text: 'private-answer' }),
      tool,
    ]),
  );
});
afterEach(() => center.close());

test('turn evidence resolves messages and explicitly reports a dangling turn address', () => {
  expect(getEvidence(center.db, center.now, ref)).toMatchObject({
    kind: 'turn',
    turn: { items: [{ text: 'private-question' }, { text: 'private-answer' }, { tool: { name: 'shell' } }] },
  });
  expect(getEvidence(center.db, center.now, 's:abcd1234#9')).toMatchObject({ kind: 'turn', missing: true });
});

test('checking a decision is rendered, reversible, and invalidated by a change of wording', () => {
  const op = (name: Parameters<typeof execute>[2]['op'], args: Record<string, unknown>) =>
    execute(center.db, deps, { op: name, args, actor: 'user' });
  op('create_project', { title: 'sample' });
  op('record_decision', { project: 'p_sample', text: 'choice' });
  const mark = (address: string) => op('mark_checked', { item_type: 'decision', id: 'd_sample', ref: address });
  expect(mark('s:abcd1234').status).toBe('rejected');
  const checked = mark(ref);
  expect(checked.status).toBe('applied');
  const p = getProject(center.db, center.now, 'p_sample')!;
  expect(p.decisions[0]).toMatchObject({ checked_at: center.now.toISOString(), checked_ref: ref });
  expect(renderProjectMarkdown(p)).toMatch(/choice.*已核对.*s:abcd1234#1/);
  if (checked.status !== 'applied') throw Error('expected a checked event');
  op('revert_event', { event_id: checked.event_id });
  expect(getProject(center.db, center.now, 'p_sample')!.decisions[0]).toMatchObject({ checked_ref: null, checked_at: null });
  mark(ref);
  new ChangeSet(center.db).update('decisions', 'd_sample', { text: 'different' });
  expect(getProject(center.db, center.now, 'p_sample')!.decisions[0]).toMatchObject({ checked_ref: null, checked_at: null });
});

test('only explicit reads return refused text, both readers retain the gap and its addresses', async () => {
  const model = curatorTools(center.db, deps, { digestIds: [] });
  const mcp = readTools(center.db, deps);
  const read = (name: string, args: Record<string, string>, background: boolean) =>
    (background ? model : mcp).find((t) => t.name === (background ? name : 'pm_' + name))!.handler(args);
  expect((await read('get_turn', { turn: ref }, true)).text).toEqual((await read('get_turn', { turn: ref }, false)).text);
  expect((await read('get_session', { session: 's:abcd1234' }, true)).text).toEqual(
    (await read('get_session', { session: 's:abcd1234' }, false)).text,
  );
  center.db.exec('UPDATE chunks SET digest_block_id=1');
  for (const [name, args] of [
    ['get_session', { session: 's:abcd1234' }],
    ['get_turn', { turn: ref }],
  ] as const) {
    const hidden = await read(name, args, true),
      explicit = await read(name, args, false);
    expect(hidden.text).not.toMatch(/private-question|private-answer|private-command/);
    expect(hidden.text).toContain('后台不提供正文');
    expect(hidden.text).toContain(ref);
    expect(explicit.text).toContain('private-question');
    expect(explicit.text).toContain('private-answer');
    expect(explicit.text).toContain('中心没有它的摘要');
    if (name === 'get_turn') expect(explicit.text).toContain('private-command');
  }
  const raw = await mcp.find((t) => t.name === 'pm_read_raw')!.handler({ item: ref + '.1' });
  expect(raw.text).toContain('private-question');
  expect(raw.text).toContain('中心没有它的摘要');
});

test('blocker review records a check when the model opens and cites a turn', async () => {
  const user = (op: Parameters<typeof execute>[2]['op'], args: Record<string, unknown>) =>
    execute(center.db, deps, { op, args, actor: 'user' });
  user('create_project', { title: 'sample' });
  user('set_blocker', { project: 'p_sample', text: 'waiting', kind: 'user' });
  user('link_session', { project: 'p_sample', session: 'claude:abcd1234' });
  const review = await runBlockerReview(
    center.db,
    deps,
    async (call) => {
      const tool = call.tools!.find((t) => t.name === 'get_turn')!;
      expect((await tool.handler({ turn: ref })).text).toContain('private-answer');
      return {
        ok: true,
        text: '',
        structured: { verdicts: [{ blocker_id: 'b_sample', verdict: 'keep', reason: 'checked the conversation', evidence: [ref] }] },
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
        costUsd: 0,
        durationMs: 1,
      };
    },
    'test-model',
    'p_sample',
  );
  expect(review.ok).toBe(true);
  expect(getProject(center.db, center.now, 'p_sample')!.blockers[0]).toMatchObject({
    checked_ref: ref,
    checked_at: center.now.toISOString(),
  });
});
