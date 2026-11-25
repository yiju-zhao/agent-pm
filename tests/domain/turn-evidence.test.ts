import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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

test('turn evidence returns the messages and tool summary', () => {
  expect(getEvidence(center.db, center.now, ref)).toMatchObject({
    kind: 'turn',
    turn: { items: [{ text: 'private-question' }, { text: 'private-answer' }, { tool: { name: 'shell' } }] },
  });
});

test('turn evidence identifies a dangling address', () => {
  expect(getEvidence(center.db, center.now, 's:abcd1234#9')).toMatchObject({ kind: 'turn', missing: true });
});

describe('decision checks', () => {
  const op = (name: Parameters<typeof execute>[2]['op'], args: Record<string, unknown>) =>
    execute(center.db, deps, { op: name, args, actor: 'user' });
  const mark = (address: string) => op('mark_checked', { item_type: 'decision', id: 'd_sample', ref: address });
  const project = () => getProject(center.db, center.now, 'p_sample')!;

  beforeEach(() => {
    op('create_project', { title: 'sample' });
    op('record_decision', { project: 'p_sample', text: 'choice' });
  });

  test('a decision check rejects a session address', () => {
    expect(mark('s:abcd1234').status).toBe('rejected');
  });

  test('a decision check records the turn, time and ledger event', () => {
    const checked = mark(ref);
    expect(checked.status).toBe('applied');
    expect(project().decisions[0]).toMatchObject({ checked_at: center.now.toISOString(), checked_ref: ref });
    expect(center.db.prepare("SELECT count(*) n FROM events WHERE op='mark_checked'").get()).toEqual({ n: 1 });
  });

  test('a checked decision renders its evidence address on the same line', () => {
    mark(ref);
    expect(renderProjectMarkdown(project())).toMatch(/choice.*已核对.*s:abcd1234#1/);
  });

  test('reverting a check restores the original decision fields', () => {
    const checked = mark(ref);
    if (checked.status !== 'applied') throw Error('expected a checked event');
    op('revert_event', { event_id: checked.event_id });
    expect(project().decisions[0]).toMatchObject({ checked_ref: null, checked_at: null });
  });

  test('a wording change invalidates the decision check in the recorded change', () => {
    mark(ref);
    const changes = new ChangeSet(center.db);
    changes.update('decisions', 'd_sample', { text: 'different' });
    expect(changes.changes[0]).toMatchObject({
      before: { text: 'choice', checked_ref: ref, checked_at: center.now.toISOString() },
      after: { text: 'different', checked_ref: null, checked_at: null },
    });
    expect(project().decisions[0]).toMatchObject({ checked_ref: null, checked_at: null });
  });
});

describe('refusal visibility', () => {
  function read(name: string, args: Record<string, string>, background: boolean) {
    const tools = background ? curatorTools(center.db, deps, { digestIds: [] }) : readTools(center.db, deps);
    return tools.find(tool => tool.name === (background ? name : 'pm_' + name))!.handler(args);
  }

  test('both readers return identical unquarantined content', async () => {
    for (const [name, args] of [['get_turn', { turn: ref }], ['get_session', { session: 's:abcd1234' }]] as const) {
      expect((await read(name, args, true)).text).toBe((await read(name, args, false)).text);
    }
  });

  test('the background reader masks quarantined excerpts and tool inputs while retaining addresses', async () => {
    center.db.exec('UPDATE chunks SET digest_block_id=1');
    for (const [name, args] of [['get_turn', { turn: ref }], ['get_session', { session: 's:abcd1234' }]] as const) {
      const hidden = await read(name, args, true);
      expect(hidden.text).not.toMatch(/private-question|private-answer|private-command/);
      expect(hidden.text).toContain('后台不提供正文');
      expect(hidden.text).toContain(ref);
    }
  });

  test('explicit reads show quarantined text with the missing-summary notice', async () => {
    center.db.exec('UPDATE chunks SET digest_block_id=1');
    const session = await read('get_session', { session: 's:abcd1234' }, false);
    const turn = await read('get_turn', { turn: ref }, false);
    const raw = await read('read_raw', { item: ref + '.1' }, false);
    for (const response of [session, turn, raw]) {
      expect(response.text).toContain('private-question');
      expect(response.text).toContain('中心没有它的摘要');
    }
    expect(session.text).toContain('private-answer');
    expect(turn.text).toContain('private-command');
  });
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
