import { afterEach, beforeEach, expect, test } from 'vitest';

import { listTurns, rebuildTurns } from '../../src/server/turns.ts';
import type { Cursor, TimelineEvent } from '../../src/shared/ingest-v2.ts';
import { agent, event, PaseoWriter, startCenter } from '../helpers/center.ts';
import type { Center } from '../helpers/center.ts';

const AGENT_ID = 'agent-1';
const EPOCH = 'epoch-1';

let center: Center;
let writer: PaseoWriter;

beforeEach(async () => {
  center = startCenter();
  writer = new PaseoWriter(center);
  await writer.lease();
  await writer.snapshot([agent(AGENT_ID)]);
});

afterEach(() => center.close());

function userMessage(seq: number, turnId: string | null): TimelineEvent {
  return event(`msg:user-${seq}`, seq, { kind: 'user', item_type: 'user_message', turn_id: turnId });
}

function reply(seq: number, turnId: string | null): TimelineEvent {
  return event(`msg:reply-${seq}`, seq, { turn_id: turnId });
}

function toolCall(seq: number, turnId: string | null, status: 'completed' | 'failed' | 'running'): TimelineEvent {
  return event(`tool:call-${seq}`, seq, {
    kind: 'tool',
    item_type: 'tool_call',
    text: '',
    turn_id: turnId,
    tool: { name: 'shell', status, exit_code: status === 'failed' ? 1 : null, input: 'npm test', input_truncated: null, output: '', output_truncated: null, error: null },
  });
}

/** Delivers `events` as the batch that follows `base` and returns the key of the session they belong to. */
async function deliver(events: TimelineEvent[], base: Cursor | null = null): Promise<string> {
  const sent = await writer.batch(writer.batchBody(AGENT_ID, base, { epoch: EPOCH, seq: events[events.length - 1]!.seq_end }, events));
  expect(sent.status).toBe(200);
  return sent.json.session_key as string;
}

test('events that share a turn id form one turn, and turns are numbered in arrival order', async () => {
  const sessionKey = await deliver([userMessage(1, 'turn-a'), reply(2, 'turn-a'), userMessage(3, 'turn-b'), reply(4, 'turn-b')]);
  expect(listTurns(center.db, sessionKey).map((turn) => [turn.n, turn.turn_id])).toEqual([
    [1, 'turn-a'],
    [2, 'turn-b'],
  ]);
});

test('a turn records its first and last event and the time between them', async () => {
  const sessionKey = await deliver([userMessage(1, 'turn-a'), toolCall(2, 'turn-a', 'completed'), reply(3, 'turn-a')]);
  expect(listTurns(center.db, sessionKey)).toMatchObject([
    { first_key: 'msg:user-1', last_key: 'msg:reply-3', ts_start: '2026-11-06T09:00:01.000Z', ts_end: '2026-11-06T09:00:03.000Z' },
  ]);
});

test('tool calls are counted per turn, and only failed ones count as failures', async () => {
  const sessionKey = await deliver([
    userMessage(1, 'turn-a'),
    toolCall(2, 'turn-a', 'completed'),
    toolCall(3, 'turn-a', 'failed'),
    toolCall(4, 'turn-a', 'running'),
  ]);
  expect(listTurns(center.db, sessionKey)).toMatchObject([{ tool_calls: 3, tool_failures: 1 }]);
});

test('without turn ids, each user message starts a new turn', async () => {
  const sessionKey = await deliver([userMessage(1, null), reply(2, null), userMessage(3, null), reply(4, null)]);
  expect(listTurns(center.db, sessionKey).map((turn) => [turn.turn_id, turn.first_key, turn.last_key])).toEqual([
    [null, 'msg:user-1', 'msg:reply-2'],
    [null, 'msg:user-3', 'msg:reply-4'],
  ]);
});

test('without turn ids, events before the first user message join the first turn', async () => {
  const sessionKey = await deliver([reply(1, null), userMessage(2, null), reply(3, null)]);
  expect(listTurns(center.db, sessionKey).map((turn) => [turn.first_key, turn.last_key])).toEqual([['msg:reply-1', 'msg:reply-3']]);
});

test('a later batch of the same turn extends it instead of starting a new one', async () => {
  await deliver([userMessage(1, 'turn-a'), toolCall(2, 'turn-a', 'completed')]);
  const sessionKey = await deliver([reply(3, 'turn-a')], { epoch: EPOCH, seq: 2 });
  expect(listTurns(center.db, sessionKey)).toMatchObject([{ n: 1, last_key: 'msg:reply-3', tool_calls: 1 }]);
});

test('a later batch with another turn id appends a turn', async () => {
  await deliver([userMessage(1, 'turn-a'), reply(2, 'turn-a')]);
  const sessionKey = await deliver([userMessage(3, 'turn-b')], { epoch: EPOCH, seq: 2 });
  expect(listTurns(center.db, sessionKey).map((turn) => turn.turn_id)).toEqual(['turn-a', 'turn-b']);
});

test('rebuilding from the stored events gives the same turns as ingestion did', async () => {
  await deliver([userMessage(1, 'turn-a'), toolCall(2, 'turn-a', 'failed')]);
  const sessionKey = await deliver([reply(3, 'turn-a'), userMessage(4, 'turn-b'), reply(5, 'turn-b')], { epoch: EPOCH, seq: 2 });
  const fromIngestion = listTurns(center.db, sessionKey);
  rebuildTurns(center.db, sessionKey);
  expect(listTurns(center.db, sessionKey)).toEqual(fromIngestion);
});

test('a session without source events has no turns', () => {
  expect(listTurns(center.db, 'no-such-session')).toEqual([]);
});

test('a replaced epoch replays the same event keys without duplicating turns', async () => {
  const events = [userMessage(1, 'a'), reply(2, 'a')];
  const session = await deliver(events);
  const before = listTurns(center.db, session);
  const next = { epoch: 'next', seq: 2 };
  const batch = writer.batchBody(AGENT_ID, { epoch: EPOCH, seq: 2 }, next, events.map(e => ({ ...e, epoch: 'next' })), {
    reset: { previous_epoch: EPOCH, reason: 'replacement' },
  });
  expect((await writer.batch(batch)).status).toBe(200);
  expect(listTurns(center.db, session)).toEqual(before);
});

test('a completed tool revision replaces its running observation in the same turn', async () => {
  const session = await deliver([userMessage(1, 'a'), toolCall(2, 'a', 'running')]);
  await deliver([toolCall(2, 'a', 'failed')], { epoch: EPOCH, seq: 2 });
  expect(listTurns(center.db, session)).toMatchObject([{ tool_calls: 1, tool_failures: 1 }]);
});
