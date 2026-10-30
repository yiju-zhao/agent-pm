import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createPmClient, RetryableError } from '../../src/collector/client.ts';
import type { PmClient } from '../../src/collector/client.ts';
import type { CollectorConfig } from '../../src/collector/config.ts';
import { CursorStore } from '../../src/collector/cursor-store.ts';
import { backoffDelay, collectOnce, MAX_BACKOFF_MS, READ_MAX_BYTES } from '../../src/collector/loop.ts';
import type { Deps } from '../../src/collector/loop.ts';
import { MAX_CHUNK_CHARS } from '../../src/collector/normalize.ts';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';
import { OFFLINE_AFTER_MS } from '../../src/server/sessions-repo.ts';

const MACHINE = 'laptop';
const TOKEN = 'laptop-token';
const CWD = '/home/demo/proj';
const CLAUDE_ID = '5d27595b-908e-4fe5-9283-890acdbd075f';
const CLAUDE_KEY = `claude:${CLAUDE_ID}`;
const CODEX_ID = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';
const STARTED_AT = new Date('2026-10-29T10:00:00.000Z');
const OLD_TS = '2026-10-29T09:00:00.000Z';
const NEW_TS = '2026-10-29T10:05:00.000Z';

let dir: string;
let cfg: CollectorConfig;
let db: DatabaseSync;
let now: Date;
let pushResults: Array<{ inserted: number; duplicates: number }>;
let failChunks: boolean;
let client: PmClient;
let transcript: string;
let app: ReturnType<typeof createApp>;

/** Points the client at a brand-new server with an empty database (as after restoring an empty backup). */
function freshServer(): void {
  if (db?.isOpen) db.close();
  db = openDb(':memory:');
  app = createApp(db, { port: 1, dbPath: ':memory:', collectors: { [MACHINE]: TOKEN } }, () => now);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herdr-pm-loop-'));
  cfg = {
    server: 'http://pm.test',
    machine: MACHINE,
    token: TOKEN,
    herdrBin: 'herdr',
    claudeDir: join(dir, 'claude'),
    codexDir: join(dir, 'codex'),
    stateFile: join(dir, 'state', 'collector.json'),
    pollMs: 10_000,
  };
  now = new Date('2026-10-29T10:10:00.000Z');
  freshServer();
  const real = createPmClient({
    server: cfg.server,
    machine: MACHINE,
    token: TOKEN,
    fetch: async (input, init) => app.request(String(input), init),
  });
  pushResults = [];
  failChunks = false;
  client = {
    pushSnapshot: (p) => real.pushSnapshot(p),
    getOffset: (key) => real.getOffset(key),
    pushChunks: async (p) => {
      if (failChunks) throw new RetryableError('server unavailable');
      const r = await real.pushChunks(p);
      pushResults.push(r);
      return r;
    },
  };
  const projectDir = join(cfg.claudeDir, 'projects', '-home-demo-proj');
  await mkdir(projectDir, { recursive: true });
  transcript = join(projectDir, `${CLAUDE_ID}.jsonl`);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

type Pane = {
  pane_id: string;
  terminal_id: string;
  agent: string;
  agent_status?: string;
  agent_session?: { kind: string; value: string };
};

function claudePane(extra: Partial<Pane> = {}): Pane {
  return {
    pane_id: 'w1:p1',
    terminal_id: 'term_1',
    agent: 'claude',
    agent_status: 'working',
    agent_session: { kind: 'id', value: CLAUDE_ID },
    ...extra,
  };
}

function snapshotOf(panes: Pane[]): unknown {
  return {
    result: {
      snapshot: {
        panes: panes.map((p) => ({ workspace_id: 'w1', tab_id: 'w1:t1', cwd: CWD, terminal_title: 'Task', ...p })),
      },
    },
  };
}

type Calls = { readScreen: string[]; paneProcess: string[]; processStartTime: number[]; log: string[] };

function fakeDeps(
  panes: () => Pane[],
  opts: {
    screen?: () => string;
    process?: { pid: number; cwd: string } | null | (() => { pid: number; cwd: string } | null);
    processStart?: Date | null;
    readSnapshot?: () => Promise<unknown>;
  } = {},
): Deps & { calls: Calls } {
  const calls: Calls = { readScreen: [], paneProcess: [], processStartTime: [], log: [] };
  return {
    calls,
    readSnapshot: opts.readSnapshot ?? (async () => snapshotOf(panes())),
    readScreen: async (paneId) => {
      calls.readScreen.push(paneId);
      return opts.screen ? opts.screen() : '';
    },
    paneProcess: async (paneId) => {
      calls.paneProcess.push(paneId);
      return typeof opts.process === 'function' ? opts.process() : (opts.process ?? null);
    },
    processStartTime: async (pid) => {
      calls.processStartTime.push(pid);
      return opts.processStart ?? null;
    },
    client,
    now: () => now,
    startedAt: STARTED_AT,
    log: (line) => calls.log.push(line),
  };
}

function claudeUser(ts: string, text: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
}

function claudeAssistant(ts: string, text: string): string {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

function claudeThinking(ts: string): string {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } });
}

async function writeLines(path: string, lines: string[]): Promise<void> {
  await writeFile(path, lines.map((l) => `${l}\n`).join(''));
}

async function appendLines(path: string, lines: string[]): Promise<void> {
  await appendFile(path, lines.map((l) => `${l}\n`).join(''));
}

async function size(path: string): Promise<number> {
  return (await stat(path)).size;
}

type ChunkRow = {
  session_key: string;
  kind: string;
  offset_start: number;
  offset_end: number;
  ts_start: string;
  ts_end: string;
  text: string;
  backfill: number;
};

function chunks(): ChunkRow[] {
  return db
    .prepare('SELECT session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill FROM chunks ORDER BY id')
    .all() as ChunkRow[];
}

function sessionRow(key: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM sessions WHERE key = ?').get(key) as Record<string, unknown> | undefined;
}

async function savedState(): Promise<{ cursors: Record<string, { offset: number }> }> {
  return JSON.parse(await readFile(cfg.stateFile, 'utf8'));
}

test('first run reads transcript from 0 and marks old chunks as backfill', async () => {
  await writeLines(transcript, [claudeUser(OLD_TS, 'fix the bug'), claudeAssistant(OLD_TS, 'done')]);
  const store = await CursorStore.load(cfg.stateFile);

  const result = await collectOnce(cfg, store, fakeDeps(() => [claudePane()]));

  expect(result).toEqual({ sessions: 1, chunksPushed: 1, errors: 0 });
  const end = await size(transcript);
  const rows = chunks();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ session_key: CLAUDE_KEY, kind: 'transcript', offset_start: 0, offset_end: end, backfill: 1 });
  expect(rows[0]!.text).toContain('user: fix the bug');
  expect(rows[0]!.text).toContain('assistant: done');
  expect(sessionRow(CLAUDE_KEY)).toMatchObject({ fidelity: 'full', transcript_path: transcript, lifecycle: 'live' });
  expect(store.get(CLAUDE_KEY)).toEqual({ path: transcript, offset: end, fidelity: 'full' });
  expect((await savedState()).cursors[CLAUDE_KEY]!.offset).toBe(end);
});

test('second run pushes only the new tail', async () => {
  await writeLines(transcript, [claudeUser(OLD_TS, 'first question')]);
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [claudePane()]);
  await collectOnce(cfg, store, deps);
  const firstEnd = await size(transcript);

  await appendLines(transcript, [claudeUser(NEW_TS, 'second question')]);
  // A half-written line must not be read yet.
  await appendFile(transcript, '{"type":"user","timest');
  const result = await collectOnce(cfg, store, deps);

  expect(result.chunksPushed).toBe(1);
  const rows = chunks();
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ offset_start: firstEnd * 1000, backfill: 0 });
  expect(rows[1]!.text).toContain('second question');
  expect(rows[1]!.text).not.toContain('first question');
  const tailEnd = (await size(transcript)) - '{"type":"user","timest'.length;
  expect(rows[1]!.offset_end).toBe(tailEnd);
  expect(store.get(CLAUDE_KEY)!.offset).toBe(tailEnd);

  expect((await collectOnce(cfg, store, deps)).chunksPushed).toBe(0);
  expect(chunks()).toHaveLength(2);
});

test('cursor does not advance when push fails; next run re-sends same range', async () => {
  await writeLines(transcript, [claudeUser(OLD_TS, 'first')]);
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [claudePane()]);
  await collectOnce(cfg, store, deps);
  const firstEnd = await size(transcript);
  await appendLines(transcript, [claudeUser(NEW_TS, 'second')]);

  failChunks = true;
  await expect(collectOnce(cfg, store, deps)).rejects.toBeInstanceOf(RetryableError);
  expect(store.get(CLAUDE_KEY)!.offset).toBe(firstEnd);
  expect((await savedState()).cursors[CLAUDE_KEY]!.offset).toBe(firstEnd);
  expect(chunks()).toHaveLength(1);

  failChunks = false;
  const result = await collectOnce(cfg, await CursorStore.load(cfg.stateFile), deps);
  expect(result.chunksPushed).toBe(1);
  expect(pushResults.at(-1)).toEqual({ inserted: 1, duplicates: 0 });
  expect(chunks()[1]).toMatchObject({ offset_start: firstEnd * 1000, offset_end: await size(transcript) });
});

test('lost state file: resumes from server max offset, no duplicates', async () => {
  await writeLines(transcript, [claudeUser(OLD_TS, 'q'), claudeAssistant(OLD_TS, 'a')]);
  const deps = fakeDeps(() => [claudePane()]);
  const first = await CursorStore.load(cfg.stateFile);
  await collectOnce(cfg, first, deps);
  const serverEnd = await size(transcript);
  // A thinking-only line yields no entries: nothing is pushed for it (the server's max offset_end
  // stays behind), but the local cursor still moves past it.
  await appendLines(transcript, [claudeThinking(NEW_TS)]);
  expect((await collectOnce(cfg, first, deps)).chunksPushed).toBe(0);
  const end = await size(transcript);
  expect(first.get(CLAUDE_KEY)!.offset).toBe(end);
  expect(chunks()).toHaveLength(1);
  expect(chunks()[0]!.offset_end).toBe(serverEnd);

  await unlink(cfg.stateFile);
  pushResults = [];
  const fresh = await CursorStore.load(cfg.stateFile);
  expect(fresh.get(CLAUDE_KEY)).toBeUndefined();
  await collectOnce(cfg, fresh, deps);

  const inserted = pushResults.reduce((n, r) => n + r.inserted, 0);
  const duplicates = pushResults.reduce((n, r) => n + r.duplicates, 0);
  expect(inserted).toBe(0);
  expect(duplicates).toBe(0);
  expect(chunks()).toHaveLength(1);
  expect(fresh.get(CLAUDE_KEY)!.offset).toBe(end);
});

test('server database restored from an empty backup: a new collector process re-sends everything', async () => {
  await writeLines(transcript, [claudeUser(OLD_TS, 'first question')]);
  const deps = fakeDeps(() => [claudePane()]);
  const store = await CursorStore.load(cfg.stateFile);
  await collectOnce(cfg, store, deps);
  await appendLines(transcript, [claudeUser(NEW_TS, 'second question')]);
  await collectOnce(cfg, store, deps);
  expect(chunks()).toHaveLength(2);
  const end = await size(transcript);

  freshServer();
  pushResults = [];
  // A new process: same state file (cursor at the end), but nothing checked against the server yet.
  const restarted = await CursorStore.load(cfg.stateFile);
  expect(restarted.get(CLAUDE_KEY)!.offset).toBe(end);
  await collectOnce(cfg, restarted, deps);

  expect(pushResults.reduce((n, r) => n + r.inserted, 0)).toBeGreaterThan(0);
  const text = chunks().map((c) => c.text).join('\n');
  expect(text).toContain('first question');
  expect(text).toContain('second question');
  expect(Math.max(...chunks().map((c) => c.offset_end))).toBe(end);
  expect(restarted.get(CLAUDE_KEY)!.offset).toBe(end);

  // Later ticks of the same process trust the local cursor again.
  pushResults = [];
  expect((await collectOnce(cfg, restarted, deps)).chunksPushed).toBe(0);
  expect(pushResults).toEqual([]);
});

test('server database restored from an older backup: only the lost gap is re-sent, with no duplicates', async () => {
  await writeLines(transcript, [claudeUser(OLD_TS, 'kept')]);
  const deps = fakeDeps(() => [claudePane()]);
  const store = await CursorStore.load(cfg.stateFile);
  await collectOnce(cfg, store, deps);
  const backupEnd = await size(transcript);
  await appendLines(transcript, [claudeUser(NEW_TS, 'lost one')]);
  await collectOnce(cfg, store, deps);
  await appendLines(transcript, [claudeUser(NEW_TS, 'lost two')]);
  await collectOnce(cfg, store, deps);
  const before = chunks();
  expect(before).toHaveLength(3);

  // Restoring the backup taken after the first push drops everything the server stored since.
  db.prepare('DELETE FROM chunks WHERE offset_start >= ?').run(backupEnd * 1000);
  pushResults = [];
  await collectOnce(cfg, await CursorStore.load(cfg.stateFile), deps);

  expect(pushResults).toEqual([{ inserted: 1, duplicates: 0 }]);
  const after = chunks();
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(before[0]);
  // The gap is re-read in one window starting at the server's max offset_end.
  expect(after[1]).toMatchObject({ offset_start: backupEnd * 1000, offset_end: await size(transcript) });
  expect(after[1]!.text).toContain('lost one');
  expect(after[1]!.text).toContain('lost two');
});

test('a normal collector restart against the same server database re-sends nothing', async () => {
  await writeLines(transcript, [claudeUser(OLD_TS, 'q'), claudeAssistant(OLD_TS, 'a')]);
  const deps = fakeDeps(() => [claudePane()]);
  await collectOnce(cfg, await CursorStore.load(cfg.stateFile), deps);
  await appendLines(transcript, [claudeUser(NEW_TS, 'more')]);
  // A thinking-only tail: the local cursor passes it, the server's max offset_end stays behind it.
  await appendLines(transcript, [claudeThinking(NEW_TS)]);
  const store = await CursorStore.load(cfg.stateFile);
  await collectOnce(cfg, store, deps);
  expect(chunks()).toHaveLength(2);

  pushResults = [];
  const restarted = await CursorStore.load(cfg.stateFile);
  expect((await collectOnce(cfg, restarted, deps)).chunksPushed).toBe(0);
  expect(pushResults).toEqual([]);
  expect(chunks()).toHaveLength(2);
  expect(restarted.get(CLAUDE_KEY)!.offset).toBe(await size(transcript));
});

test('a transcript truncated or replaced below the cursor is logged with the session key', async () => {
  await writeLines(transcript, [claudeUser(OLD_TS, 'a long first question'), claudeAssistant(OLD_TS, 'a long first answer')]);
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [claudePane()]);
  await collectOnce(cfg, store, deps);
  expect(deps.calls.log).toEqual([]);

  await writeLines(transcript, [claudeUser(NEW_TS, 'short')]);
  await collectOnce(cfg, store, deps);

  expect(deps.calls.log).toHaveLength(1);
  expect(deps.calls.log[0]).toContain(CLAUDE_KEY);
  expect(deps.calls.log[0]).toMatch(/truncated or replaced/);
  expect(store.get(CLAUDE_KEY)!.offset).toBe(await size(transcript));
});

function heartbeats(): string | undefined {
  return (db.prepare('SELECT last_heartbeat FROM machines WHERE label = ?').get(MACHINE) as { last_heartbeat: string } | undefined)
    ?.last_heartbeat;
}

/** Deps whose clock moves `stepMs` forward on every chunk push, recording each snapshot push time. */
function slowPushDeps(panes: () => Pane[], stepMs: number, opts: Parameters<typeof fakeDeps>[1] = {}) {
  const deps = fakeDeps(panes, opts);
  const snapshots: string[] = [];
  deps.client = {
    pushSnapshot: async (p) => {
      snapshots.push(now.toISOString());
      return client.pushSnapshot(p);
    },
    getOffset: (key) => client.getOffset(key),
    pushChunks: async (p) => {
      const r = await client.pushChunks(p);
      now = new Date(now.getTime() + stepMs);
      return r;
    },
  };
  return { deps, snapshots };
}

test('a long initial import re-pushes the snapshot heartbeat between read windows', async () => {
  // ~9 MB of complete lines: three read windows of at most READ_MAX_BYTES.
  const line = claudeUser(OLD_TS, 'x'.repeat(100_000));
  await writeLines(transcript, Array.from({ length: Math.ceil((2 * READ_MAX_BYTES + 1_000_000) / line.length) }, () => line));
  const start = now;
  const { deps, snapshots } = slowPushDeps(() => [claudePane()], 40_000);

  await collectOnce(cfg, await CursorStore.load(cfg.stateFile), deps);

  // Pushes end at +40 s, +80 s, +120 s; the heartbeat is due (>= 60 s) only before the third window.
  const at = (ms: number) => new Date(start.getTime() + ms).toISOString();
  expect(snapshots).toEqual([at(0), at(80_000)]);
  expect(heartbeats()).toBe(at(80_000));
  expect(chunks().at(-1)!.offset_end).toBe(await size(transcript));
});

test('a slow tick re-pushes the snapshot heartbeat between sessions', async () => {
  await writeLines(transcript, [claudeUser(NEW_TS, 'hello')]);
  const start = now;
  const { deps, snapshots } = slowPushDeps(
    () => [claudePane(), { pane_id: 'w1:p3', terminal_id: 'term_3', agent: 'opencode', agent_status: 'idle' }],
    70_000,
    { screen: () => 'opencode> ' },
  );

  await collectOnce(cfg, await CursorStore.load(cfg.stateFile), deps);

  expect(snapshots).toEqual([start.toISOString(), new Date(start.getTime() + 70_000).toISOString()]);
  // The screen chunk keeps the tick's timestamp.
  expect(chunks().at(-1)).toMatchObject({ kind: 'screen', offset_start: start.getTime() });
});

test('id-less codex resolved via matchRollout becomes native key with full fidelity', async () => {
  const startedAt = new Date(now.getTime() - 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dayDir = join(cfg.codexDir, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  await mkdir(dayDir, { recursive: true });
  const rollout = join(dayDir, `rollout-2026-10-29T10-09-00-${CODEX_ID}.jsonl`);
  const metaTs = new Date(startedAt.getTime() + 2_000).toISOString();
  await writeLines(rollout, [
    JSON.stringify({ timestamp: metaTs, type: 'session_meta', payload: { id: CODEX_ID, cwd: CWD, timestamp: metaTs } }),
    JSON.stringify({
      timestamp: NEW_TS,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'refactor the parser' }] },
    }),
  ]);
  const pane: Pane = { pane_id: 'w1:p2', terminal_id: 'term_2', agent: 'codex', agent_status: 'working' };
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [pane], { process: { pid: 4242, cwd: CWD }, processStart: startedAt });

  const result = await collectOnce(cfg, store, deps);

  const key = `codex:${CODEX_ID}`;
  expect(result).toEqual({ sessions: 1, chunksPushed: 1, errors: 0 });
  expect(deps.calls.processStartTime).toEqual([4242]);
  expect(sessionRow(key)).toMatchObject({ native_id: CODEX_ID, fidelity: 'full', transcript_path: rollout, terminal_id: 'term_2' });
  expect(sessionRow(`pending:${MACHINE}:term_2`)).toBeUndefined();
  expect(chunks()).toHaveLength(1);
  expect(chunks()[0]).toMatchObject({ session_key: key, kind: 'transcript', offset_start: 0 });
  expect(chunks()[0]!.text).toContain('refactor the parser');
  expect(deps.calls.readScreen).toEqual([]);

  // The resolution is cached: the next tick neither rescans rollouts nor asks for the start time again.
  await appendLines(rollout, [
    JSON.stringify({
      timestamp: NEW_TS,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'parser refactored' }] },
    }),
  ]);
  expect((await collectOnce(cfg, store, deps)).chunksPushed).toBe(1);
  expect(deps.calls.processStartTime).toEqual([4242]);
  expect(chunks()[1]!.text).toContain('parser refactored');
});

test('unresolvable session falls back to screen and dedupes identical screens', async () => {
  let screen = 'opencode> waiting for input';
  let status = 'idle';
  const pane = (): Pane => ({ pane_id: 'w1:p3', terminal_id: 'term_3', agent: 'opencode', agent_status: status });
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [pane()], { screen: () => screen });

  expect(await collectOnce(cfg, store, deps)).toEqual({ sessions: 1, chunksPushed: 1, errors: 0 });
  const key = `pending:${MACHINE}:term_3`;
  expect(sessionRow(key)).toMatchObject({ fidelity: 'screen', transcript_path: null });
  expect(chunks()[0]).toMatchObject({
    session_key: key,
    kind: 'screen',
    offset_start: now.getTime(),
    offset_end: now.getTime(),
    ts_start: now.toISOString(),
    ts_end: now.toISOString(),
    text: screen,
    backfill: 0,
  });

  now = new Date(now.getTime() + 10_000);
  expect((await collectOnce(cfg, store, deps)).chunksPushed).toBe(0);
  expect(chunks()).toHaveLength(1);

  // While the agent is working the screen is not read at all.
  status = 'working';
  screen = 'opencode> thinking...';
  now = new Date(now.getTime() + 10_000);
  const reads = deps.calls.readScreen.length;
  expect((await collectOnce(cfg, store, deps)).chunksPushed).toBe(0);
  expect(deps.calls.readScreen).toHaveLength(reads);

  status = 'done';
  screen = `${'x'.repeat(MAX_CHUNK_CHARS)}TAIL`;
  now = new Date(now.getTime() + 10_000);
  expect((await collectOnce(cfg, store, deps)).chunksPushed).toBe(1);
  const last = chunks().at(-1)!;
  expect(last).toMatchObject({ kind: 'screen', offset_start: now.getTime() });
  expect(last.text).toHaveLength(MAX_CHUNK_CHARS);
  expect(last.text.endsWith('TAIL')).toBe(true);
});

test('claude session without a transcript file yet falls back to screen', async () => {
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [claudePane({ agent_status: 'idle' })], { screen: () => 'claude> ' });

  await collectOnce(cfg, store, deps);

  expect(sessionRow(CLAUDE_KEY)).toMatchObject({ fidelity: 'screen', transcript_path: null });
  expect(chunks()[0]).toMatchObject({ session_key: CLAUDE_KEY, kind: 'screen' });
});

test('herdr snapshot failure throws so runCollector can back off', async () => {
  const store = await CursorStore.load(cfg.stateFile);
  const failing = fakeDeps(() => [], {
    readSnapshot: async () => {
      throw new Error('herdr api snapshot failed: no server running');
    },
  });
  await expect(collectOnce(cfg, store, failing)).rejects.toThrow('no server running');

  const garbage = fakeDeps(() => [], { readSnapshot: async () => ({ result: {} }) });
  await expect(collectOnce(cfg, store, garbage)).rejects.toThrow('invalid herdr snapshot');

  expect(db.prepare('SELECT count(*) AS n FROM machines').get()).toEqual({ n: 0 });
});

test('pushes the snapshot before any chunks', async () => {
  await writeLines(transcript, [claudeUser(NEW_TS, 'hello')]);
  const order: string[] = [];
  const deps = fakeDeps(() => [claudePane()]);
  deps.client = {
    pushSnapshot: async (p) => {
      order.push('snapshot');
      return client.pushSnapshot(p);
    },
    pushChunks: async (p) => {
      order.push('chunks');
      return client.pushChunks(p);
    },
    getOffset: async (key) => {
      order.push('offset');
      return client.getOffset(key);
    },
  };
  await collectOnce(cfg, await CursorStore.load(cfg.stateFile), deps);
  expect(order).toEqual(['snapshot', 'offset', 'chunks']);
});

test('a session reported twice is processed once (last wins)', async () => {
  await writeLines(transcript, [claudeUser(NEW_TS, 'hello')]);
  const deps = fakeDeps(() => [claudePane({ pane_id: 'w1:p1' }), claudePane({ pane_id: 'w1:p9' })]);
  const result = await collectOnce(cfg, await CursorStore.load(cfg.stateFile), deps);
  expect(result).toEqual({ sessions: 1, chunksPushed: 1, errors: 0 });
  expect(sessionRow(CLAUDE_KEY)).toMatchObject({ pane_id: 'w1:p9' });
  expect(chunks()).toHaveLength(1);
});

test('a transcript that disappears while the session is live is skipped without losing the cursor', async () => {
  await writeLines(transcript, [claudeUser(NEW_TS, 'hello')]);
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [claudePane()]);
  await collectOnce(cfg, store, deps);
  const cursor = store.get(CLAUDE_KEY);

  await unlink(transcript);
  await collectOnce(cfg, store, deps);
  expect(store.get(CLAUDE_KEY)).toEqual(cursor);
});

test('hourly purge check reports vanished sessions whose transcript is gone', async () => {
  await writeLines(transcript, [claudeUser(NEW_TS, 'hello')]);
  const store = await CursorStore.load(cfg.stateFile);
  let panes = [claudePane()];
  const deps = fakeDeps(() => panes);
  await collectOnce(cfg, store, deps);
  expect(store.lastPurgeCheck).toEqual(now);

  // The session is closed in herdr and its transcript deleted.
  panes = [];
  await unlink(transcript);
  now = new Date(now.getTime() + 30 * 60_000);
  await collectOnce(cfg, store, deps);
  expect(sessionRow(CLAUDE_KEY)).toMatchObject({ lifecycle: 'ended' });

  now = new Date(now.getTime() + 30 * 60_000);
  await collectOnce(cfg, store, deps);
  expect(sessionRow(CLAUDE_KEY)).toMatchObject({ lifecycle: 'purged' });
  expect(store.get(CLAUDE_KEY)).toBeUndefined();
  expect(store.lastPurgeCheck).toEqual(now);
  const saved = JSON.parse(await readFile(cfg.stateFile, 'utf8'));
  expect(saved.lastPurgeCheck).toBe(now.toISOString());
});

test('id-less codex that cannot be matched stays on screen and is retried at most once a minute', async () => {
  const pane: Pane = { pane_id: 'w1:p2', terminal_id: 'term_2', agent: 'codex', agent_status: 'idle' };
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [pane], { process: { pid: 4242, cwd: CWD }, processStart: now, screen: () => 'codex> ' });

  await collectOnce(cfg, store, deps);
  expect(sessionRow(`pending:${MACHINE}:term_2`)).toMatchObject({ fidelity: 'screen' });
  now = new Date(now.getTime() + 10_000);
  await collectOnce(cfg, store, deps);
  expect(deps.calls.processStartTime).toEqual([4242]);
  now = new Date(now.getTime() + 60_000);
  await collectOnce(cfg, store, deps);
  expect(deps.calls.processStartTime).toEqual([4242, 4242]);
});

test('backoffDelay doubles pollMs per consecutive failure up to 2 minutes, below the offline threshold', () => {
  // Ruling R8: a recovered machine must be back before it would show offline for long.
  expect(MAX_BACKOFF_MS).toBe(120_000);
  expect(MAX_BACKOFF_MS).toBeLessThan(OFFLINE_AFTER_MS);
  expect(backoffDelay(10_000, 0)).toBe(10_000);
  expect(backoffDelay(10_000, 1)).toBe(20_000);
  expect(backoffDelay(10_000, 3)).toBe(80_000);
  expect(backoffDelay(10_000, 4)).toBe(120_000);
  expect(backoffDelay(10_000, 5000)).toBe(120_000);
});

test('a failing session is logged and skipped; later sessions are still collected', async () => {
  if (process.getuid?.() === 0) return; // root can read a chmod 000 file
  const badId = '11111111-2222-3333-4444-555555555555';
  const bad = join(cfg.claudeDir, 'projects', '-home-demo-proj', `${badId}.jsonl`);
  await writeLines(bad, [claudeUser(NEW_TS, 'secret')]);
  await chmod(bad, 0o000);
  await writeLines(transcript, [claudeUser(NEW_TS, 'healthy')]);
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [
    claudePane({ pane_id: 'w1:p0', terminal_id: 'term_0', agent_session: { kind: 'id', value: badId } }),
    claudePane(),
  ]);

  try {
    const result = await collectOnce(cfg, store, deps);
    expect(result).toEqual({ sessions: 2, chunksPushed: 1, errors: 1 });
  } finally {
    await chmod(bad, 0o600);
  }
  expect(chunks().map((c) => c.session_key)).toEqual([CLAUDE_KEY]);
  // The bad session's cursor stays where the server says (0); nothing past it is claimed.
  expect(store.get(`claude:${badId}`)).toEqual({ path: bad, offset: 0, fidelity: 'full' });
  expect(deps.calls.log).toHaveLength(1);
  expect(deps.calls.log[0]).toContain(`claude:${badId}`);
  expect(deps.calls.log[0]).toMatch(/EACCES/);
});

test('a server outage during one session still fails the whole tick', async () => {
  await writeLines(transcript, [claudeUser(NEW_TS, 'hello')]);
  failChunks = true;
  await expect(collectOnce(cfg, await CursorStore.load(cfg.stateFile), fakeDeps(() => [claudePane()]))).rejects.toBeInstanceOf(
    RetryableError,
  );
});

test('a resolved id-less codex keeps its native key when the process lookup fails transiently', async () => {
  const startedAt = new Date(now.getTime() - 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dayDir = join(cfg.codexDir, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  await mkdir(dayDir, { recursive: true });
  const rollout = join(dayDir, `rollout-2026-10-29T10-09-00-${CODEX_ID}.jsonl`);
  const metaTs = startedAt.toISOString();
  await writeLines(rollout, [
    JSON.stringify({ timestamp: metaTs, type: 'session_meta', payload: { id: CODEX_ID, cwd: CWD, timestamp: metaTs } }),
  ]);
  let proc: { pid: number; cwd: string } | null = { pid: 4242, cwd: CWD };
  const pane: Pane = { pane_id: 'w1:p2', terminal_id: 'term_2', agent: 'codex', agent_status: 'idle' };
  const store = await CursorStore.load(cfg.stateFile);
  const deps = fakeDeps(() => [pane], { process: () => proc, processStart: startedAt, screen: () => 'codex> ' });
  await collectOnce(cfg, store, deps);
  const key = `codex:${CODEX_ID}`;
  expect(sessionRow(key)).toMatchObject({ fidelity: 'full', lifecycle: 'live' });

  proc = null;
  now = new Date(now.getTime() + 10_000);
  await collectOnce(cfg, store, deps);
  expect(sessionRow(key)).toMatchObject({ fidelity: 'full', lifecycle: 'live', transcript_path: rollout });
  expect(sessionRow(`pending:${MACHINE}:term_2`)).toBeUndefined();
  expect(deps.calls.readScreen).toEqual([]);
});
