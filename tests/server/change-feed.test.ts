import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { answerQuestion } from '../../src/domain/answers.ts';
import { execute } from '../../src/domain/execute.ts';
import type { DomainDeps } from '../../src/domain/types.ts';
import { ChangeFeed, diffFeed, readFeedState } from '../../src/server/change-feed.ts';
import { openDb } from '../../src/server/db.ts';
import { applySnapshot } from '../../src/server/sessions-repo.ts';
import type { SnapshotSession } from '../../src/shared/protocol.ts';
import { STREAM_MAX_EVENTS } from '../../src/shared/stream-protocol.ts';
import type { StreamMessage } from '../../src/shared/stream-protocol.ts';
import { disabledStatus } from '../../src/understand/status.ts';
import type { SchedulerStatus } from '../../src/understand/status.ts';

const T0 = '2026-10-30T10:00:00.000Z';
const CLAUDE_KEY = 'claude:5d27595b-908e-4fe5-9283-890acdbd075f';

let db: DatabaseSync;
let now: Date;
let deps: DomainDeps;
let status: SchedulerStatus;

beforeEach(() => {
  db = openDb(':memory:');
  now = new Date(T0);
  let n = 0;
  deps = { now: () => now, newId: (prefix) => `${prefix}_${++n}` };
  status = disabledStatus();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

const read = () => readFeedState(db, now, status);
const after = (seconds: number) => new Date(new Date(T0).getTime() + seconds * 1000);

function createProject(title = '项目'): { id: string; event_id: number } {
  const r = execute(db, deps, { op: 'create_project', args: { title }, actor: 'user' });
  if (r.status !== 'applied') throw new Error(`create_project: ${r.status}`);
  return r as unknown as { id: string; event_id: number };
}

function session(live_status: SnapshotSession['live_status']): SnapshotSession {
  return {
    key: CLAUDE_KEY,
    agent_kind: 'claude',
    native_id: CLAUDE_KEY.slice('claude:'.length),
    pane_id: 'w1:1:1',
    terminal_id: 't1',
    workspace_id: 'w1',
    tab_id: 'w1:1',
    cwd: '/home/demo/proj',
    title: 'Some task',
    live_status,
    fidelity: 'full',
    transcript_path: '/home/demo/.claude/x.jsonl',
  };
}

function snapshot(live_status: SnapshotSession['live_status']): void {
  applySnapshot(db, { machine: 'gx10', collector_version: '0.1.0', sessions: [session(live_status)], purged: [] }, now);
}

const types = (messages: StreamMessage[]) => messages.map((m) => m.type);

test('no change, no message', () => {
  createProject();
  snapshot('idle');
  const a = read();
  const b = read();
  expect(b).toEqual(a);
  expect(diffFeed(db, a, b)).toEqual([]);
});

test('new event', () => {
  const before = read();
  expect(before.eventId).toBe(0);
  const p = createProject();
  expect(diffFeed(db, before, read())).toEqual([
    { type: 'events', events: [{ id: p.event_id, project_id: p.id, op: 'create_project', actor: 'user' }], more: false },
  ]);
});

test('more than 200 events', () => {
  const before = read();
  const insert = db.prepare("INSERT INTO events (occurred_at, recorded_at, actor, op, entity, project_id) VALUES (?, ?, 'user', 'set_field', 'project', 'p_1')");
  for (let i = 0; i < STREAM_MAX_EVENTS + 1; i++) insert.run(T0, T0);
  const messages = diffFeed(db, before, read());
  expect(messages).toHaveLength(1);
  const [msg] = messages;
  if (msg?.type !== 'events') throw new Error('expected events');
  expect(msg.events).toHaveLength(200);
  expect(msg.more).toBe(true);
  expect(msg.events[0]!.id).toBe(1);
  expect(msg.events.at(-1)!.id).toBe(200);
});

test('question created and answered each emit questions', () => {
  const p = createProject();
  const s0 = read();
  // An AI may not move idea to done directly, so this becomes a question.
  const proposed = execute(db, deps, {
    op: 'transition_stage',
    args: { project: p.id, stage: 'done' },
    actor: 'ai:curator',
    reason: 'r',
    evidence: ['chunk:1'],
  }) as unknown as { status: string; question_ids: string[] };
  expect(proposed.status).toBe('proposed');
  const s1 = read();
  expect(types(diffFeed(db, s0, s1))).toContain('questions');

  now = after(60);
  expect(answerQuestion(db, deps, proposed.question_ids[0]!, { option_index: 0 }).status).toBe('applied');
  const s2 = read();
  expect(types(diffFeed(db, s1, s2))).toContain('questions');
});

test('session status change emits sessions', () => {
  snapshot('idle');
  const s0 = read();
  snapshot('working');
  expect(types(diffFeed(db, s0, read()))).toEqual(['sessions']);
});

test('machine going offline emits sessions without any write', () => {
  snapshot('working');
  now = after(60);
  const online = read();
  now = after(181);
  const offline = read();
  expect(offline.sessions).not.toBe(online.sessions);
  expect(diffFeed(db, online, offline)).toEqual([{ type: 'sessions' }]);
});

test('status change emits status', () => {
  const s0 = read();
  status = { ...status, enabled: true, running: 'digest' };
  expect(diffFeed(db, s0, read())).toEqual([{ type: 'status' }]);
});

test('messages come in a fixed order: events, questions, sessions, status', () => {
  const p = createProject();
  const s0 = read();
  execute(db, deps, { op: 'transition_stage', args: { project: p.id, stage: 'done' }, actor: 'ai:curator', reason: 'r', evidence: ['chunk:1'] });
  createProject('另一个');
  snapshot('idle');
  status = { ...status, last_error: 'boom' };
  expect(types(diffFeed(db, s0, read()))).toEqual(['events', 'questions', 'sessions', 'status']);
});

test('subscribe starts polling and the last unsubscribe stops it', () => {
  vi.useFakeTimers();
  const feed = new ChangeFeed(db, { now: () => now, status: () => status });
  const got: StreamMessage[] = [];
  const unsubscribe = feed.subscribe((m) => got.push(m));
  const p = createProject();
  vi.advanceTimersByTime(1000);
  expect(got).toEqual([
    { type: 'events', events: [{ id: p.event_id, project_id: p.id, op: 'create_project', actor: 'user' }], more: false },
  ]);

  unsubscribe();
  createProject('又一个');
  vi.advanceTimersByTime(5000);
  expect(got).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  feed.stop();
});

test('a throwing listener does not starve the others', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const feed = new ChangeFeed(db, { now: () => now, status: () => status });
  const got: StreamMessage[] = [];
  feed.subscribe(() => {
    throw new Error('listener broke');
  });
  feed.subscribe((m) => got.push(m));
  createProject();
  feed.poll();
  expect(types(got)).toEqual(['events']);
  expect(errors).toHaveBeenCalled();
  feed.stop();
});

test('an error while polling is logged and the timer keeps running', () => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let failing = false;
  const feed = new ChangeFeed(db, {
    now: () => now,
    status: () => {
      if (failing) throw new Error('status broke');
      return status;
    },
  });
  const got: StreamMessage[] = [];
  feed.subscribe((m) => got.push(m));
  failing = true;
  vi.advanceTimersByTime(1000);
  expect(errors).toHaveBeenCalledTimes(1);
  failing = false;
  createProject();
  vi.advanceTimersByTime(1000);
  expect(types(got)).toEqual(['events']);
  feed.stop();
  expect(vi.getTimerCount()).toBe(0);
});
