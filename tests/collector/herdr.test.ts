import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  parseHerdrSnapshot,
  parsePaneProcessInfo,
  readHerdrScreen,
  readHerdrSnapshot,
  readPaneProcess,
  reportMetadataArgs,
  reportPaneMetadata,
} from '../../src/collector/herdr.ts';

const fixture: unknown = JSON.parse(
  await readFile(new URL('../fixtures/herdr-snapshot.json', import.meta.url), 'utf8'),
);

function snapshotOf(...panes: Record<string, unknown>[]): unknown {
  return { result: { snapshot: { panes } } };
}

function agentPane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pane_id: 'p1',
    terminal_id: 'term_x1',
    workspace_id: 'w1',
    tab_id: 't1',
    cwd: '/home/demo',
    agent: 'claude',
    agent_status: 'idle',
    terminal_title_stripped: 'a title',
    ...overrides,
  };
}

test('maps agent panes to sessions, skips plain shells', () => {
  const s = parseHerdrSnapshot(fixture, 'gx10-090e');
  expect(s).toHaveLength(2);
  expect(s[0]).toMatchObject({
    key: 'claude:5d27595b-908e-4fe5-9283-890acdbd075f',
    agent_kind: 'claude',
    native_id: '5d27595b-908e-4fe5-9283-890acdbd075f',
    live_status: 'working',
  });
  expect(s[1]).toMatchObject({
    key: 'pending:gx10-090e:term_65e13dfbb5fca2',
    agent_kind: 'codex',
    native_id: null,
    live_status: 'idle',
  });
});

test('copies pane attributes and defaults fidelity to screen without a transcript', () => {
  const [first] = parseHerdrSnapshot(fixture, 'gx10-090e');
  expect(first).toEqual({
    key: 'claude:5d27595b-908e-4fe5-9283-890acdbd075f',
    agent_kind: 'claude',
    native_id: '5d27595b-908e-4fe5-9283-890acdbd075f',
    pane_id: 'w_demo1:1:1',
    terminal_id: 'term_a1b2c3d4e5f607',
    workspace_id: 'w_demo1',
    tab_id: 'w_demo1:1',
    cwd: '/home/demo/proj-a',
    title: 'Fix flaky login test',
    live_status: 'working',
    fidelity: 'screen',
    transcript_path: null,
  });
});

test('title prefers terminal_title_stripped', () => {
  const [first] = parseHerdrSnapshot(fixture, 'gx10-090e');
  expect(first.title).toBe('Fix flaky login test');
  const raw = parseHerdrSnapshot(
    snapshotOf(agentPane({ terminal_title: '✳ raw title', terminal_title_stripped: 'stripped title' })),
    'm',
  );
  expect(raw[0].title).toBe('stripped title');
});

test('title falls back to terminal_title, then to empty string', () => {
  const fallback = parseHerdrSnapshot(
    snapshotOf(agentPane({ terminal_title_stripped: undefined, terminal_title: 'raw title' })),
    'm',
  );
  expect(fallback[0].title).toBe('raw title');
  const none = parseHerdrSnapshot(snapshotOf(agentPane({ terminal_title_stripped: undefined })), 'm');
  expect(none[0].title).toBe('');
});

test('unknown status maps to unknown', () => {
  const weird = parseHerdrSnapshot(snapshotOf(agentPane({ agent_status: 'weird' })), 'm');
  expect(weird[0].live_status).toBe('unknown');
  const missing = parseHerdrSnapshot(snapshotOf(agentPane({ agent_status: undefined })), 'm');
  expect(missing[0].live_status).toBe('unknown');
  for (const status of ['idle', 'working', 'blocked', 'done', 'unknown']) {
    expect(parseHerdrSnapshot(snapshotOf(agentPane({ agent_status: status })), 'm')[0].live_status).toBe(status);
  }
});

test('missing optional string fields become empty strings instead of crashing', () => {
  const [s] = parseHerdrSnapshot(
    snapshotOf({ pane_id: 'p1', terminal_id: 'term_x1', agent: 'claude' }),
    'm',
  );
  expect(s).toMatchObject({
    key: 'pending:m:term_x1',
    workspace_id: '',
    tab_id: '',
    cwd: '',
    title: '',
    live_status: 'unknown',
  });
});

test('panes without pane_id or terminal_id are skipped, the rest still parse', () => {
  const s = parseHerdrSnapshot(
    snapshotOf(
      agentPane({ pane_id: undefined }),
      agentPane({ terminal_id: '' }),
      agentPane({ pane_id: 'p2', terminal_id: 'term_ok' }),
      null as unknown as Record<string, unknown>,
    ),
    'm',
  );
  expect(s.map((x) => x.terminal_id)).toEqual(['term_ok']);
});

test('panes with an empty or non-string agent are treated as plain shells', () => {
  const s = parseHerdrSnapshot(
    snapshotOf(agentPane({ agent: '' }), agentPane({ agent: 42 }), agentPane({ agent: null })),
    'm',
  );
  expect(s).toEqual([]);
});

test('agent_session without a usable id value falls back to a pending key', () => {
  const cases: unknown[] = [
    { source: 's', agent: 'claude', kind: 'id', value: '' },
    { source: 's', agent: 'claude', kind: 'id' },
    { source: 's', agent: 'claude', kind: 'id', value: 7 },
    { source: 's', agent: 'claude', kind: 'path', value: '/some/file' },
    null,
    'nope',
  ];
  for (const agent_session of cases) {
    const [s] = parseHerdrSnapshot(snapshotOf(agentPane({ agent_session })), 'm');
    expect(s).toMatchObject({ key: 'pending:m:term_x1', native_id: null });
  }
});

test('invalid input throws a clear error', () => {
  expect(() => parseHerdrSnapshot(null, 'm')).toThrow(/herdr snapshot/);
  expect(() => parseHerdrSnapshot('text', 'm')).toThrow(/herdr snapshot/);
  expect(() => parseHerdrSnapshot([], 'm')).toThrow(/herdr snapshot/);
  expect(() => parseHerdrSnapshot({}, 'm')).toThrow(/result\.snapshot\.panes/);
  expect(() => parseHerdrSnapshot({ result: {} }, 'm')).toThrow(/result\.snapshot\.panes/);
  expect(() => parseHerdrSnapshot({ result: { snapshot: {} } }, 'm')).toThrow(/result\.snapshot\.panes/);
  expect(() => parseHerdrSnapshot({ result: { snapshot: { panes: {} } } }, 'm')).toThrow(/result\.snapshot\.panes/);
});

test('an empty panes array is valid and yields no sessions', () => {
  expect(parseHerdrSnapshot(snapshotOf(), 'm')).toEqual([]);
});

let binDir: string;

async function fakeHerdr(name: string, script: string): Promise<string> {
  const path = join(binDir, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  binDir = await mkdtemp(join(tmpdir(), 'herdr-pm-test-'));
});
afterAll(async () => {
  await rm(binDir, { recursive: true, force: true });
});

test('readHerdrSnapshot runs `<bin> api snapshot` and parses stdout as JSON', async () => {
  const bin = await fakeHerdr(
    'ok',
    '[ "$1 $2" = "api snapshot" ] || { echo "bad args: $*" >&2; exit 2; }\necho \'{"result":{"snapshot":{"panes":[]}}}\'',
  );
  await expect(readHerdrSnapshot(bin)).resolves.toEqual({ result: { snapshot: { panes: [] } } });
});

test('readHerdrSnapshot throws with stderr on non-zero exit', async () => {
  const bin = await fakeHerdr('fail', 'echo "socket not found" >&2\nexit 3');
  await expect(readHerdrSnapshot(bin)).rejects.toThrow(/socket not found/);
});

test('readHerdrSnapshot throws a clear error on non-JSON output', async () => {
  const bin = await fakeHerdr('garbage', 'echo "not json"');
  await expect(readHerdrSnapshot(bin)).rejects.toThrow(/herdr api snapshot.*JSON/);
});

test('readHerdrSnapshot throws when the binary does not exist', async () => {
  await expect(readHerdrSnapshot(join(binDir, 'missing'))).rejects.toThrow(/herdr api snapshot/);
});

function processInfo(groupId: number, procs: Record<string, unknown>[]): unknown {
  return {
    id: 'cli:pane:process-info',
    result: {
      type: 'pane_process_info',
      process_info: { pane_id: 'w1:p1', shell_pid: 100, foreground_process_group_id: groupId, foreground_processes: procs },
    },
  };
}

test('parsePaneProcessInfo picks the foreground process group leader', () => {
  const info = processInfo(300, [
    { pid: 200, name: 'caffeinate', cwd: '/elsewhere' },
    { pid: 300, name: 'codex', cwd: '/home/demo/proj' },
  ]);
  expect(parsePaneProcessInfo(info)).toEqual({ pid: 300, cwd: '/home/demo/proj' });
});

test('parsePaneProcessInfo falls back to the first foreground process and tolerates junk', () => {
  expect(parsePaneProcessInfo(processInfo(999, [{ pid: 'x' }, { pid: 201 }]))).toEqual({ pid: 201, cwd: '' });
  expect(parsePaneProcessInfo(processInfo(1, []))).toBeNull();
  expect(parsePaneProcessInfo({ result: {} })).toBeNull();
  expect(parsePaneProcessInfo(null)).toBeNull();
});

test('readPaneProcess runs `<bin> pane process-info --pane <id>`; null on failure', async () => {
  const json = JSON.stringify(processInfo(42, [{ pid: 42, cwd: '/w' }]));
  const bin = await fakeHerdr(
    'pinfo',
    `[ "$*" = "pane process-info --pane w1:p1" ] || { echo "bad args: $*" >&2; exit 2; }\necho '${json}'`,
  );
  await expect(readPaneProcess(bin, 'w1:p1')).resolves.toEqual({ pid: 42, cwd: '/w' });
  await expect(readPaneProcess(bin, 'w1:p2')).resolves.toBeNull();
});

test('readHerdrScreen runs `<bin> agent read <pane> --source recent-unwrapped --lines 200`', async () => {
  const bin = await fakeHerdr(
    'screen',
    '[ "$*" = "agent read w1:p1 --source recent-unwrapped --lines 200" ] || { echo "bad args: $*" >&2; exit 2; }\nprintf "line 1\\nline 2\\n"',
  );
  await expect(readHerdrScreen(bin, 'w1:p1')).resolves.toBe('line 1\nline 2\n');
  await expect(readHerdrScreen(bin, 'w1:p2')).rejects.toThrow(/bad args/);
});

test('reportMetadataArgs sets pm_sid and pm with the ttl', () => {
  expect(reportMetadataArgs('w1:p1', { pm_sid: '0d67da1f', pm: 'dLLM评测' }, 600_000)).toEqual([
    'pane',
    'report-metadata',
    'w1:p1',
    '--source',
    'herdr-pm',
    '--token',
    'pm_sid=0d67da1f',
    '--token',
    'pm=dLLM评测',
    '--ttl-ms',
    '600000',
  ]);
});

test('reportMetadataArgs clears the pm token when the session has no project', () => {
  const args = reportMetadataArgs('w1:p1', { pm_sid: '0d67da1f', pm: null }, 600_000);
  expect(args).toContain('--clear-token');
  expect(args[args.indexOf('--clear-token') + 1]).toBe('pm');
  expect(args.some((a) => a.startsWith('pm='))).toBe(false);
  expect(args).toContain('pm_sid=0d67da1f');
  expect(args.slice(-2)).toEqual(['--ttl-ms', '600000']);
});

test('reportPaneMetadata runs `<bin> pane report-metadata ...`; rejects with stderr on failure', async () => {
  const bin = await fakeHerdr(
    'report',
    `[ "$*" = "pane report-metadata w1:p1 --source herdr-pm --token pm_sid=0d67da1f --clear-token pm --ttl-ms 600000" ] || { echo "bad args: $*" >&2; exit 2; }`,
  );
  await expect(reportPaneMetadata(bin, 'w1:p1', { pm_sid: '0d67da1f', pm: null }, 600_000)).resolves.toBeUndefined();
  await expect(reportPaneMetadata(bin, 'w1:p2', { pm_sid: '0d67da1f', pm: null }, 600_000)).rejects.toThrow(/bad args/);
  await expect(reportPaneMetadata(join(binDir, 'missing'), 'w1:p1', { pm_sid: 'x', pm: null }, 1)).rejects.toThrow(
    /report-metadata/,
  );
});
