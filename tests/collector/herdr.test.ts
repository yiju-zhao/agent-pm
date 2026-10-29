import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { parseHerdrSnapshot, readHerdrSnapshot } from '../../src/collector/herdr.ts';

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
