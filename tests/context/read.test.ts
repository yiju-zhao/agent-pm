import { afterEach, beforeEach, expect, test } from 'vitest';

import { markOverviewRead, readItem, readOverview, readSession, readTurn } from '../../src/context/read.ts';
import type { TimelineEvent } from '../../src/shared/ingest-v2.ts';
import { agent, event, PaseoWriter, SERVER_ID, startCenter, type Center } from '../helpers/center.ts';

let center: Center;
let writer: PaseoWriter;
const short = 'abcd1234';
const input = 'shell ' + '数'.repeat(565);
const output = 'partial output 🧪'.repeat(400);
const error = 'Traceback: boom';
const transcript = `【输入】\n${input}\n\n【输出】\n${output}\n\n【错误】\n${error}`;
const tool = event('tool:x', 2, {
  kind: 'tool',
  text: '',
  tool: {
    name: 'shell', input, output, error, status: 'failed', exit_code: 1,
    input_truncated: { original_chars: 900, kept_chars: input.length },
    output_truncated: { original_chars: 9000, kept_chars: output.length },
  },
});

beforeEach(async () => {
  center = startCenter();
  writer = new PaseoWriter(center);
  await writer.lease();
  await writer.snapshot([agent('agent', { native_id: short, native_id_origin: 'runtime', status: 'working' })]);
});
afterEach(() => center.close());

async function deliver(events: TimelineEvent[]): Promise<void> {
  const end = { epoch: 'epoch-1', seq: events.at(-1)!.seq_end };
  expect((await writer.batch(writer.batchBody('agent', null, end, events))).status).toBe(200);
}

function questions(count: number): TimelineEvent[] {
  return Array.from({ length: count }, (_, index) => event('msg:' + index, index + 1, { kind: 'user', text: 'request ' + index }));
}

test('the overview shows the current turn and its initiating message for a running session', async () => {
  await deliver(questions(2));
  expect(readOverview(center.db, center.now, 'reader').running).toMatchObject([{ address: 's:abcd1234', turn: 2, user: 'request 1' }]);
});

test('the overview identifies a source with an expired heartbeat', () => {
  center.advance(3600_000);
  expect(readOverview(center.db, center.now, 'reader').sources[0].state).toBe('offline');
});

test('the session outline defaults to the latest thirty turns', async () => {
  await deliver(questions(35));
  const outline = readSession(center.db, center.now, short, {});
  expect(outline.earlier).toBe(5);
  expect(outline.turns.map(turn => turn.n)).toEqual(Array.from({ length: 30 }, (_, index) => index + 6));
});

test('before returns only the turns preceding the requested number', async () => {
  await deliver(questions(7));
  const outline = readSession(center.db, center.now, short, { before: 6 });
  expect(outline.turns.map(turn => turn.n)).toEqual([1, 2, 3, 4, 5]);
});

test('a turn outline links its opening message, final answer and tool counts to one address', async () => {
  await deliver([...questions(1), tool, event('msg:last', 3, { text: 'final answer' })]);
  expect(readSession(center.db, center.now, short, {}).turns).toMatchObject([
    { address: 's:abcd1234#1', user: 'request 0', assistant: 'final answer', tool_calls: 1, tool_failures: 1 },
  ]);
});

test('the turn layer keeps messages in full and limits tool input to a summary', async () => {
  await deliver([...questions(1), tool]);
  expect(readTurn(center.db, short, 1).items).toMatchObject([
    { text: 'request 0' },
    { tool: { name: 'shell', input: input.slice(0, 200), status: 'failed', exit_code: 1 }, address: 's:abcd1234#1.2' },
  ]);
});

test('the first raw page counts Unicode characters across all tool sections', async () => {
  await deliver([tool]);
  expect(readItem(center.db, short, 1, 1, { offset: 0 })).toMatchObject({
    text: Array.from(transcript).slice(0, 4000).join(''), next_offset: 4000, total: Array.from(transcript).length,
  });
});

test('following raw page offsets reconstructs the entire tool input, output and error', async () => {
  await deliver([tool]);
  const pages: string[] = [];
  let offset: number | null = 0;
  do {
    const page = readItem(center.db, short, 1, 1, { offset });
    pages.push(page.text);
    offset = page.next_offset;
  } while (offset !== null);
  expect(pages.join('')).toBe(transcript);
});

test('raw tool input and output carry independent upstream truncation lengths', async () => {
  await deliver([tool]);
  expect(readItem(center.db, short, 1, 1, { offset: 0 }).truncated).toEqual({
    input: { original_chars: 900, kept_chars: input.length }, output: { original_chars: 9000, kept_chars: output.length },
  });
});

test('a missing original returns the three-part upstream pointer', async () => {
  await deliver(questions(1));
  center.db.exec("UPDATE source_events SET text=NULL WHERE event_key='msg:0'");
  expect(readItem(center.db, short, 1, 1, { offset: 0 })).toMatchObject({
    missing: true, text: '原文不在库里', pointer: { server_id: SERVER_ID, agent_id: 'agent', event_key: 'msg:0' },
  });
});

test('an absent turn is identified in the error', () => {
  expect(() => readTurn(center.db, short, 2)).toThrow(/回合/);
});

test('an absent session is identified in the error', () => {
  expect(() => readSession(center.db, center.now, 'missing', {})).toThrow(/session/);
});

test('a new overview reader sees changes from the last day', () => {
  const insert = center.db.prepare("INSERT INTO events(project_id,op,recorded_at) VALUES ('p_one','record_decision',?)");
  insert.run(new Date(center.now.getTime() - 25 * 3600_000).toISOString());
  insert.run(center.now.toISOString());
  expect(readOverview(center.db, center.now, 'reader').changes).toMatchObject([{ decisions: 1 }]);
});

test('a decision added after marking the overview read is counted once', () => {
  markOverviewRead(center.db, 'reader', center.now);
  center.db.prepare("INSERT INTO events(project_id,op,recorded_at) VALUES ('p_one','record_decision',?)").run(center.now.toISOString());
  expect(readOverview(center.db, center.now, 'reader').changes).toMatchObject([{ project_id: 'p_one', decisions: 1 }]);
});

test('marking an overview read clears its changes', () => {
  center.db.prepare("INSERT INTO events(project_id,op,recorded_at) VALUES ('p_one','record_decision',?)").run(center.now.toISOString());
  markOverviewRead(center.db, 'reader', center.now);
  expect(readOverview(center.db, center.now, 'reader').changes).toEqual([]);
});

test('pending reminders precede more recent questions', async () => {
  await writer.snapshot([agent('agent', { native_id: short, native_id_origin: 'runtime', status: 'blocked' })]);
  center.advance(1000);
  center.db.prepare("INSERT INTO questions(id,prompt,status,created_at) VALUES ('q_one','confirm','pending',?)").run(center.now.toISOString());
  expect(readOverview(center.db, center.now, 'reader').pending.map(item => item.ref)).toEqual(['s:abcd1234', 'q_one']);
});

test('a session without indexed turns has a digest outline', () => {
  center.db.exec(
    "INSERT INTO sessions(key,native_id) VALUES ('claude:oldsession','oldsession'); INSERT INTO digests(session_key,json) VALUES ('claude:oldsession','{}')",
  );
  expect(readSession(center.db, center.now, 'oldsessi', {})).toMatchObject({ turns: [], no_turn_index: true, digests: [{ json: '{}' }] });
});

test('the overview counts a refused window only under refusals', async () => {
  await deliver(questions(1));
  center.db.exec(`INSERT INTO digest_blocks(session_key, chunk_ids, message, created_at)
    SELECT session_key, json_array(id), 'refused', received_at FROM chunks;
    UPDATE chunks SET digest_block_id=(SELECT id FROM digest_blocks)`);
  expect(readOverview(center.db, center.now, 'reader')).toMatchObject({ undigested: 0, refusals: 1 });
});
