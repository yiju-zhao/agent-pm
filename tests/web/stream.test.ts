// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { StreamMessage } from '../../src/shared/stream-protocol.ts';
import { RECONNECT_DELAYS_MS, StreamClient, streamUrl, topicsFor } from '../../web/src/stream.ts';
import type { StreamState, Topic } from '../../web/src/stream.ts';

/** A WebSocket that does nothing by itself: the tests call open() / receive() / drop() to play the server. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static failNext = false;
  readonly url: string;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    if (FakeSocket.failNext) {
      FakeSocket.failNext = false;
      throw new Error('constructor failed');
    }
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close(): void {
    this.closeCalls++;
  }
  open(): void {
    this.onopen?.();
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  fail(): void {
    this.onerror?.();
  }
  drop(): void {
    this.onclose?.();
  }
}

const WebSocketImpl = FakeSocket as unknown as typeof WebSocket;
const make = () => new StreamClient('ws://host/stream', { WebSocketImpl });
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

beforeEach(() => {
  FakeSocket.instances = [];
  FakeSocket.failNext = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('reconnects with backoff 1s 2s 4s 8s 10s 10s', () => {
  expect(RECONNECT_DELAYS_MS).toEqual([1000, 2000, 4000, 8000, 10000]);
  const client = make();
  client.start();
  expect(FakeSocket.instances).toHaveLength(1);
  expect(last().url).toBe('ws://host/stream');

  const expected = [1000, 2000, 4000, 8000, 10000, 10000, 10000];
  expected.forEach((delay, i) => {
    last().drop();
    vi.advanceTimersByTime(delay - 1);
    expect(FakeSocket.instances).toHaveLength(i + 1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(i + 2);
  });
});

test('an open resets the backoff', () => {
  const client = make();
  client.start();
  last().drop();
  vi.advanceTimersByTime(1000);
  last().drop();
  vi.advanceTimersByTime(2000);
  expect(FakeSocket.instances).toHaveLength(3);
  last().open();
  last().drop();
  vi.advanceTimersByTime(999);
  expect(FakeSocket.instances).toHaveLength(3);
  vi.advanceTimersByTime(1);
  expect(FakeSocket.instances).toHaveLength(4);
});

test('an error followed by a close schedules one reconnect, and a repeated close does not schedule a second', () => {
  const client = make();
  client.start();
  const first = last();
  first.fail();
  first.drop();
  first.drop();
  vi.advanceTimersByTime(1000);
  expect(FakeSocket.instances).toHaveLength(2);
  vi.advanceTimersByTime(60_000);
  expect(FakeSocket.instances).toHaveLength(2);
});

test('a WebSocket constructor that throws is retried like a closed connection', () => {
  const states: StreamState[] = [];
  const client = make();
  client.onState((s) => states.push(s));
  FakeSocket.failNext = true;
  client.start();
  expect(FakeSocket.instances).toHaveLength(0);
  vi.advanceTimersByTime(1000);
  expect(FakeSocket.instances).toHaveLength(1);
  last().open();
  expect(states.at(-1)).toBe('open');
});

test('state is connecting, open, connecting again while it retries, and closed once stopped', () => {
  const client = make();
  const states: StreamState[] = [];
  client.onState((s) => states.push(s));
  expect(client.state).toBe('closed');
  client.start();
  expect(client.state).toBe('connecting');
  last().open();
  expect(client.state).toBe('open');
  last().drop();
  expect(client.state).toBe('connecting');
  vi.advanceTimersByTime(1000);
  last().open();
  client.stop();
  expect(client.state).toBe('closed');
  expect(states).toEqual(['connecting', 'open', 'connecting', 'open', 'closed']);
});

test('stop() closes the socket and does not reconnect, even if the socket reports its close later', () => {
  const client = make();
  client.start();
  const socket = last();
  socket.open();
  client.stop();
  expect(socket.closeCalls).toBe(1);
  socket.drop();
  vi.advanceTimersByTime(60_000);
  expect(FakeSocket.instances).toHaveLength(1);
});

test('stop() cancels a pending reconnect timer', () => {
  const client = make();
  client.start();
  last().drop();
  client.stop();
  vi.advanceTimersByTime(60_000);
  expect(FakeSocket.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('start() twice opens one socket; start() after stop() connects again', () => {
  const client = make();
  client.start();
  client.start();
  expect(FakeSocket.instances).toHaveLength(1);
  client.stop();
  client.start();
  expect(FakeSocket.instances).toHaveLength(2);
});

test('topic listeners get the topics of each message until they unsubscribe', () => {
  const client = make();
  const seen: Topic[][] = [];
  const off = client.onTopics((topics) => seen.push(topics));
  client.start();
  last().receive(JSON.stringify({ type: 'hello' }));
  last().receive(JSON.stringify({ type: 'questions' }));
  expect(seen).toEqual([['all'], ['questions', 'projects']]);
  off();
  last().receive(JSON.stringify({ type: 'status' }));
  expect(seen).toHaveLength(2);
});

test('garbage messages are ignored', () => {
  const client = make();
  const seen: Topic[][] = [];
  client.onTopics((topics) => seen.push(topics));
  client.start();
  const socket = last();
  for (const junk of [
    'not json',
    '',
    'null',
    '42',
    '[]',
    '{}',
    '{"type":"nope"}',
    '{"type":7}',
    '{"type":"events"}',
    '{"type":"events","events":"x","more":false}',
    '{"type":"events","events":[{"id":1}],"more":false}',
    new ArrayBuffer(4),
    undefined,
  ]) {
    expect(() => socket.receive(junk)).not.toThrow();
  }
  expect(seen).toEqual([]);
});

test('a throwing topic listener does not stop the others', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const client = make();
  const seen: Topic[][] = [];
  client.onTopics(() => {
    throw new Error('boom');
  });
  client.onTopics((topics) => seen.push(topics));
  client.start();
  last().receive(JSON.stringify({ type: 'hello' }));
  expect(seen).toEqual([['all']]);
  expect(error).toHaveBeenCalledTimes(1);
});

test('topicsFor maps every message type', () => {
  const hello: StreamMessage = { type: 'hello' };
  expect(topicsFor(hello)).toEqual(['all']);

  const events: StreamMessage = {
    type: 'events',
    events: [
      { id: 1, project_id: 'p_1', op: 'project.create', actor: 'user' },
      { id: 2, project_id: null, op: 'session.ignore', actor: 'user' },
      { id: 3, project_id: 'p_2', op: 'todo.add', actor: 'ai' },
    ],
    more: false,
  };
  expect(topicsFor(events)).toEqual(['projects', 'questions', 'project:p_1', 'project:p_2']);

  // The same project twice is one topic.
  expect(
    topicsFor({
      type: 'events',
      events: [
        { id: 1, project_id: 'p_1', op: 'a', actor: 'user' },
        { id: 2, project_id: 'p_1', op: 'b', actor: 'user' },
      ],
      more: false,
    }),
  ).toEqual(['projects', 'questions', 'project:p_1']);

  expect(topicsFor({ type: 'events', events: [], more: false })).toEqual(['projects', 'questions']);
  expect(topicsFor({ type: 'events', events: [], more: true })).toEqual(['all']);
  expect(topicsFor({ ...events, more: true })).toEqual(['all']);
  expect(topicsFor({ type: 'questions' })).toEqual(['questions', 'projects']);
  expect(topicsFor({ type: 'sessions' })).toEqual(['sessions', 'projects']);
  expect(topicsFor({ type: 'status' })).toEqual(['status']);
});

test('streamUrl follows the page scheme', () => {
  expect(streamUrl({ protocol: 'http:', host: 'mac-mini:8787' })).toBe('ws://mac-mini:8787/stream');
  expect(streamUrl({ protocol: 'https:', host: 'pm.example.com' })).toBe('wss://pm.example.com/stream');
});
