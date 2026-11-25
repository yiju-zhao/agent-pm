import { afterEach, beforeEach, expect, test } from 'vitest';

import { readOverview, markOverviewRead, readSession, readTurn, readItem } from '../../src/context/read.ts';
import { agent, event, PaseoWriter, SERVER_ID, startCenter, type Center } from '../helpers/center.ts';

let center: Center;
let writer: PaseoWriter;
const short = 'abcd1234';
beforeEach(async () => {
  center = startCenter();
  writer = new PaseoWriter(center);
  await writer.lease();
  await writer.snapshot([agent('agent', { native_id: short, native_id_origin: 'runtime', status: 'working' })]);
});
afterEach(() => center.close());

test('the outline pages backwards and links the overview to the latest turn', async () => {
  const events = Array.from({ length: 35 }, (_, i) => event('msg:' + i, i + 1, { kind: 'user', text: 'request ' + i }));
  await writer.batch(writer.batchBody('agent', null, { epoch: 'epoch-1', seq: 35 }, events));
  const outline = readSession(center.db, center.now, short, {});
  expect(outline.turns).toHaveLength(30);
  expect(outline.earlier).toBe(5);
  expect(outline.turns[0]).toMatchObject({ address: 's:abcd1234#6', user: 'request 5' });
  expect(readSession(center.db, center.now, short, { before: 6 }).turns.map((t) => t.n)).toEqual([1, 2, 3, 4, 5]);
  expect(readOverview(center.db, center.now, 'reader').running[0]).toMatchObject({ address: 's:abcd1234', turn: 35, user: 'request 34' });
  center.advance(3600_000);
  expect(readOverview(center.db, center.now, 'reader').sources[0].state).toBe('offline');
});

test('raw pages preserve tool output and its upstream pointer when text is missing', async () => {
  const output = 'abc'.repeat(3000);
  const tool = event('tool:x', 2, {
    kind: 'tool',
    text: '',
    tool: {
      name: 'shell',
      input: 'inspect',
      input_truncated: null,
      output,
      output_truncated: { original_chars: 10000, kept_chars: 9000 },
      status: 'completed',
      error: null,
      exit_code: 0,
    },
  });
  await writer.batch(
    writer.batchBody('agent', null, { epoch: 'epoch-1', seq: 2 }, [event('msg:q', 1, { kind: 'user', text: 'question' }), tool]),
  );
  expect(readTurn(center.db, short, 1).items).toMatchObject([
    { text: 'question' },
    { tool: { name: 'shell', exit_code: 0 }, address: 's:abcd1234#1.2' },
  ]);
  const first = readItem(center.db, short, 1, 2, { offset: 0 });
  const formatted = '【输入】\ninspect\n\n【输出】\n' + output;
  expect(first).toMatchObject({ next_offset: 4000, total: formatted.length, truncated: { input: null, output: { original_chars: 10000, kept_chars: 9000 } } });
  expect(
    first.text + readItem(center.db, short, 1, 2, { offset: 4000 }).text + readItem(center.db, short, 1, 2, { offset: 8000 }).text,
  ).toBe(formatted);
  center.db.exec("UPDATE source_events SET text=NULL WHERE event_key='msg:q'");
  expect(readItem(center.db, short, 1, 1, { offset: 0 })).toMatchObject({
    missing: true,
    pointer: { server_id: SERVER_ID, agent_id: 'agent', event_key: 'msg:q' },
  });
  expect(() => readTurn(center.db, short, 2)).toThrow(/回合/);
  expect(() => readSession(center.db, center.now, 'missing', {})).toThrow(/session/);
});

test('overview readers start at the last day and advance independently', () => {
  const insert = center.db.prepare("INSERT INTO events(project_id,op,recorded_at) VALUES ('p_one','record_decision',?)");
  insert.run(new Date(center.now.getTime() - 25 * 3600_000).toISOString());
  insert.run(center.now.toISOString());
  expect(readOverview(center.db, center.now, 'a').changes).toMatchObject([{ decisions: 1 }]);
  markOverviewRead(center.db, 'a', center.now);
  expect(readOverview(center.db, center.now, 'a').changes).toEqual([]);
  expect(readOverview(center.db, center.now, 'b').changes).toMatchObject([{ decisions: 1 }]);
});

test('pending reminders precede more recent questions', async () => {
  await writer.snapshot([agent('agent', { native_id: short, native_id_origin: 'runtime', status: 'blocked' })]);
  center.advance(1000);
  center.db
    .prepare("INSERT INTO questions(id,prompt,status,created_at) VALUES ('q_one','confirm','pending',?)")
    .run(center.now.toISOString());
  const pending = readOverview(center.db, center.now, 'reader').pending;
  expect(pending.map((p) => p.ref)).toEqual(['s:abcd1234', 'q_one']);
});

test('a session without indexed turns has a digest outline', () => {
  center.db.exec(
    "INSERT INTO sessions(key,native_id) VALUES ('claude:oldsession','oldsession'); INSERT INTO digests(session_key,json) VALUES ('claude:oldsession','{}')",
  );
  expect(readSession(center.db, center.now, 'oldsessi', {})).toMatchObject({ turns: [], no_turn_index: true, digests: [{ json: '{}' }] });
});

test('raw paging preserves the entire tool input, output and error in order', async () => {
  const input = 'shell ' + '数'.repeat(565);
  const output = 'partial output 🧪'.repeat(400);
  const error = 'Traceback: boom';
  const tool = event('tool:long', 1, {
    kind: 'tool',
    text: '',
    tool: {
      name: 'shell', input, output, error, status: 'failed', exit_code: 1,
      input_truncated: { original_chars: 900, kept_chars: input.length },
      output_truncated: { original_chars: 9000, kept_chars: output.length },
    },
  });
  await writer.batch(writer.batchBody('agent', null, { epoch: 'epoch-1', seq: 1 }, [tool]));
  const pages: string[] = [];
  let offset: number | null = 0;
  do {
    const page = readItem(center.db, short, 1, 1, { offset });
    expect(Array.from(page.text).length).toBeLessThanOrEqual(4000);
    pages.push(page.text);
    offset = page.next_offset;
  } while (offset !== null);
  expect(pages.join('')).toBe(`【输入】\n${input}\n\n【输出】\n${output}\n\n【错误】\n${error}`);
});

test('the overview counts a refused window only under refusals', async () => {
  await writer.batch(writer.batchBody('agent', null, { epoch: 'epoch-1', seq: 1 }, [event('msg:one', 1)]));
  center.db.exec(`INSERT INTO digest_blocks(session_key, chunk_ids, message, created_at)
    SELECT session_key, json_array(id), 'refused', received_at FROM chunks;
    UPDATE chunks SET digest_block_id=(SELECT id FROM digest_blocks)`);
  expect(readOverview(center.db, center.now, 'reader')).toMatchObject({ undigested: 0, refusals: 1 });
});
