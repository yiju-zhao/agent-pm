import { expect, test } from 'vitest';
import {
  MACHINE_TIMEOUT_MS,
  listAllAgents,
  matchShortId,
  normalizeShortId,
  parseAgentList,
  parseMachineList,
} from '../../src/lookup/agents.ts';
import type { LookupAgent, RunHerdr } from '../../src/lookup/agents.ts';

// Shapes captured from `herdr agent list` and `herdr machine list --json` on 2026-10-31.
function agentEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: 'claude',
    agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: '1badafbd-1536-4c62-97d5-476c19663133' },
    agent_status: 'idle',
    cwd: '/Users/eason',
    focused: false,
    pane_id: 'w8:p1X',
    tab_id: 'w8:t1',
    terminal_id: 'term_65f14b8f928f72f',
    terminal_title: '✳ Supastack.ai 脚手架变现',
    terminal_title_stripped: 'Supastack.ai 脚手架变现',
    workspace_id: 'w8',
    ...overrides,
  };
}

function agentList(...agents: Record<string, unknown>[]): unknown {
  return { id: 'cli:agent:list', result: { agents, type: 'agent_list' } };
}

function machineEntry(label: string, target: string, enabled = true): Record<string, unknown> {
  return { id: `id-${label}`, label, target, session: 'default', enabled, selected: false };
}

const THREE_MACHINES = [
  machineEntry('mac-mini', '100.111.225.68'),
  machineEntry('gx10-090e', '100.90.216.102'),
  machineEntry('gx10-c757', 'bz@100.87.40.81'),
];

function agent(overrides: Partial<LookupAgent> = {}): LookupAgent {
  return {
    machine: null,
    target: null,
    pane_id: 'w1:p1',
    agent_kind: 'claude',
    native_id: '0d67da1f-aaaa-bbbb-cccc-111122223333',
    terminal_id: 'term_65e0001',
    title: 'a title',
    cwd: '/home/demo',
    status: 'idle',
    ...overrides,
  };
}

type Call = { args: string[]; timeoutMs: number };

/** A fake `herdr`: answers by argument list with JSON text, or rejects when the answer is an Error. */
function fakeRun(answers: { machines?: unknown; local?: unknown; remote?: Record<string, unknown | Error> }) {
  const calls: Call[] = [];
  const run: RunHerdr = async (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    let answer: unknown;
    if (args.join(' ') === 'machine list --json') answer = answers.machines ?? [];
    else if (args.join(' ') === 'agent list') answer = answers.local ?? agentList();
    else if (args[0] === '--machine' && args.slice(2).join(' ') === 'agent list') answer = answers.remote?.[args[1]!];
    else throw new Error(`unexpected herdr call: ${args.join(' ')}`);
    if (answer === undefined) throw new Error(`no answer for: ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    return JSON.stringify(answer);
  };
  return { run, calls };
}

test('normalizeShortId trims, lowercases and accepts a plain short id', () => {
  expect(normalizeShortId('  0D67DA1F\n')).toBe('0d67da1f');
});

test('normalizeShortId keeps what follows the last colon of a pasted key', () => {
  expect(normalizeShortId('claude:0d67da1f-aaaa')).toBe('0d67da1f-aaaa');
  expect(normalizeShortId('pending:gx10:term_65f14b8f')).toBe('term_65f14b8f');
});

test('normalizeShortId strips paired quotes and backticks', () => {
  expect(normalizeShortId('"0d67da1f"')).toBe('0d67da1f');
  expect(normalizeShortId("'0d67da1f'")).toBe('0d67da1f');
  expect(normalizeShortId('`0d67da1f`')).toBe('0d67da1f');
  expect(normalizeShortId(' "`claude:0D67DA1F`" ')).toBe('0d67da1f');
});

test.each(['abc', '', '0d67 da1f', '$(rm)', 'claude:', '"0d67da1f', 'a'.repeat(65)])(
  'normalizeShortId rejects %j',
  (input) => {
    expect(normalizeShortId(input)).toBeNull();
  },
);

test('parseAgentList maps the real herdr agent list output', () => {
  const json = agentList(
    agentEntry(),
    agentEntry({ pane_id: 'w9:p1', agent_session: null, terminal_id: 'term_65f058b', terminal_title_stripped: 'LinkedIn' }),
  );
  expect(parseAgentList(json, null)).toEqual([
    {
      machine: null,
      target: null,
      pane_id: 'w8:p1X',
      agent_kind: 'claude',
      native_id: '1badafbd-1536-4c62-97d5-476c19663133',
      terminal_id: 'term_65f14b8f928f72f',
      title: 'Supastack.ai 脚手架变现',
      cwd: '/Users/eason',
      status: 'idle',
    },
    {
      machine: null,
      target: null,
      pane_id: 'w9:p1',
      agent_kind: 'claude',
      native_id: null,
      terminal_id: 'term_65f058b',
      title: 'LinkedIn',
      cwd: '/Users/eason',
      status: 'idle',
    },
  ]);
});

test('parseAgentList fills machine and target for a remote machine', () => {
  const [a] = parseAgentList(agentList(agentEntry()), { label: 'gx10-c757', target: 'bz@100.87.40.81' });
  expect(a).toMatchObject({ machine: 'gx10-c757', target: 'bz@100.87.40.81' });
});

test('parseAgentList: native_id is null unless agent_session is a non-empty id', () => {
  const json = agentList(
    agentEntry({ pane_id: 'p1', agent_session: { kind: 'path', value: '/x/y.jsonl' } }),
    agentEntry({ pane_id: 'p2', agent_session: { kind: 'id', value: '' } }),
    agentEntry({ pane_id: 'p3', agent_session: undefined }),
  );
  expect(parseAgentList(json, null).map((a) => a.native_id)).toEqual([null, null, null]);
});

test('parseAgentList falls back to terminal_title when there is no stripped title', () => {
  const json = agentList(agentEntry({ terminal_title_stripped: undefined, terminal_title: '✳ raw title' }));
  expect(parseAgentList(json, null)[0]!.title).toBe('✳ raw title');
});

test('parseAgentList skips entries without pane_id or terminal_id', () => {
  const json = agentList(
    agentEntry({ pane_id: undefined }),
    agentEntry({ terminal_id: undefined }),
    agentEntry({ pane_id: 'w2:p2' }),
  );
  expect(parseAgentList(json, null).map((a) => a.pane_id)).toEqual(['w2:p2']);
});

test('parseAgentList throws, naming the machine, when the output has the wrong shape', () => {
  expect(() => parseAgentList({ result: {} }, { label: 'gx10-090e', target: 't' })).toThrow(/gx10-090e/);
  expect(() => parseAgentList('nope', null)).toThrow(/本机/);
});

test('parseMachineList returns enabled machines only', () => {
  const json = [machineEntry('mac-mini', '100.111.225.68'), machineEntry('old', '1.2.3.4', false)];
  expect(parseMachineList(json)).toEqual([{ label: 'mac-mini', target: '100.111.225.68' }]);
});

test('parseMachineList throws when the output is not a list', () => {
  expect(() => parseMachineList({ machines: [] })).toThrow();
});

test('listAllAgents queries every enabled machine in parallel', async () => {
  const { run, calls } = fakeRun({
    machines: [...THREE_MACHINES, machineEntry('disabled', '9.9.9.9', false)],
    local: agentList(agentEntry({ pane_id: 'l:1' })),
    remote: {
      'mac-mini': agentList(agentEntry({ pane_id: 'm:1' })),
      'gx10-090e': agentList(agentEntry({ pane_id: 'g1:1' })),
      'gx10-c757': agentList(agentEntry({ pane_id: 'g2:1' })),
    },
  });
  const { agents, unreachable } = await listAllAgents(run);
  expect(unreachable).toEqual([]);
  expect(agents.map((a) => [a.machine, a.pane_id])).toEqual([
    [null, 'l:1'],
    ['mac-mini', 'm:1'],
    ['gx10-090e', 'g1:1'],
    ['gx10-c757', 'g2:1'],
  ]);
  expect(agents.find((a) => a.machine === 'gx10-c757')!.target).toBe('bz@100.87.40.81');
  expect(calls.map((c) => c.args)).toContainEqual(['--machine', 'gx10-090e', 'agent', 'list']);
  expect(calls.map((c) => c.args)).not.toContainEqual(['--machine', 'disabled', 'agent', 'list']);
});

test('listAllAgents starts all machine queries before any of them finishes', async () => {
  let inFlight = 0;
  let peak = 0;
  const run: RunHerdr = async (args) => {
    if (args.join(' ') === 'machine list --json') return JSON.stringify(THREE_MACHINES);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return JSON.stringify(agentList());
  };
  await listAllAgents(run);
  expect(peak).toBe(4); // local + three remote machines
});

test('an unreachable machine is reported, the others still answer', async () => {
  const { run } = fakeRun({
    machines: THREE_MACHINES,
    local: agentList(agentEntry({ pane_id: 'l:1' })),
    remote: {
      'mac-mini': agentList(agentEntry({ pane_id: 'm:1' })),
      'gx10-090e': agentList(agentEntry({ pane_id: 'g1:1' })),
      'gx10-c757': new Error('ssh: connect to host 100.87.40.81 port 22: timed out\nsecond line'),
    },
  });
  const { agents, unreachable } = await listAllAgents(run);
  expect(unreachable).toEqual([{ machine: 'gx10-c757', error: 'ssh: connect to host 100.87.40.81 port 22: timed out' }]);
  expect(agents.map((a) => a.pane_id)).toEqual(['l:1', 'm:1', 'g1:1']);
});

test('a machine that answers with garbage is reported unreachable', async () => {
  const { run } = fakeRun({ machines: [machineEntry('mac-mini', 't')], remote: { 'mac-mini': { result: 'bad' } } });
  const { unreachable } = await listAllAgents(run);
  expect(unreachable).toHaveLength(1);
  expect(unreachable[0]!.machine).toBe('mac-mini');
});

test('a local failure is reported as 本机 and remote machines are still queried', async () => {
  const { run } = fakeRun({
    machines: [machineEntry('mac-mini', 't')],
    local: new Error('herdr: command not found'),
    remote: { 'mac-mini': agentList(agentEntry({ pane_id: 'm:1' })) },
  });
  const { agents, unreachable } = await listAllAgents(run);
  expect(unreachable).toEqual([{ machine: '本机', error: 'herdr: command not found' }]);
  expect(agents.map((a) => a.pane_id)).toEqual(['m:1']);
});

test('a failing machine list is reported as 机器列表 and the local agents are still listed', async () => {
  const { run } = fakeRun({ machines: new Error('herdr too old'), local: agentList(agentEntry({ pane_id: 'l:1' })) });
  const { agents, unreachable } = await listAllAgents(run);
  expect(unreachable).toEqual([{ machine: '机器列表', error: 'herdr too old' }]);
  expect(agents.map((a) => a.pane_id)).toEqual(['l:1']);
});

test('a rejection that is not an Error, or has an empty message, still gives a readable reason', async () => {
  const run: RunHerdr = async (args) => {
    if (args.join(' ') === 'machine list --json') return '[]';
    if (args.join(' ') === 'agent list') throw 'plain string failure';
    throw new Error('unreachable');
  };
  expect((await listAllAgents(run)).unreachable).toEqual([{ machine: '本机', error: 'plain string failure' }]);
  const empty: RunHerdr = async (args) => {
    if (args.join(' ') === 'machine list --json') return '[]';
    throw new Error('');
  };
  const { unreachable } = await listAllAgents(empty);
  expect(unreachable[0]!.error).not.toBe('');
});

test('machines are queried with the timeout', async () => {
  const { run, calls } = fakeRun({
    machines: THREE_MACHINES,
    remote: { 'mac-mini': agentList(), 'gx10-090e': agentList(), 'gx10-c757': agentList() },
  });
  await listAllAgents(run);
  expect(calls).toHaveLength(5);
  expect(calls.map((c) => c.timeoutMs)).toEqual(Array(5).fill(MACHINE_TIMEOUT_MS));
  expect(MACHINE_TIMEOUT_MS).toBe(8000);
});

test('matchShortId matches a native id by prefix', () => {
  const a = agent();
  const b = agent({ pane_id: 'w1:p2', native_id: 'ffffffff-0000', terminal_id: 'term_other' });
  expect(matchShortId([a, b], '0d67da1f')).toEqual([a]);
  expect(matchShortId([a, b], '0d67da1f-aaaa-bbbb')).toEqual([a]);
  expect(matchShortId([a, b], 'a67da1f')).toEqual([]);
});

test('matchShortId matches the terminal id when there is no native id yet', () => {
  const pending = agent({ native_id: null, terminal_id: 'term_65e0abc' });
  expect(matchShortId([agent(), pending], 'term_65e')).toEqual([pending]);
});

test('matchShortId does not fall back to the terminal id when a native id exists', () => {
  const a = agent({ terminal_id: 'term_65e0001' });
  expect(matchShortId([a], 'term_65e')).toEqual([]);
});

test('matchShortId is case insensitive', () => {
  const a = agent({ native_id: 'ABCDEF12-0000' });
  const t = agent({ pane_id: 'w2:p2', native_id: null, terminal_id: 'TERM_65E0002' });
  expect(matchShortId([a, t], 'abcdef12')).toEqual([a]);
  expect(matchShortId([a, t], 'TERM_65e')).toEqual([t]);
});

test('matchShortId returns both panes when two resumed the same session', () => {
  const a = agent({ machine: 'gx10-090e', target: 't', pane_id: 'w1:p1' });
  const b = agent({ machine: 'gx10-090e', target: 't', pane_id: 'w3:p2', terminal_id: 'term_other' });
  expect(matchShortId([a, b], '0d67da1f')).toEqual([a, b]);
});

test('matchShortId keeps one entry per pane id on the same machine, not across machines', () => {
  const a = agent({ machine: 'gx10-090e', target: 't', pane_id: 'w1:p1' });
  const dup = agent({ machine: 'gx10-090e', target: 't', pane_id: 'w1:p1' });
  const sameIdElsewhere = agent({ machine: 'mac-mini', target: 'u', pane_id: 'w1:p1' });
  const local = agent({ machine: null, target: null, pane_id: 'w1:p1' });
  expect(matchShortId([a, dup, sameIdElsewhere, local], '0d67da1f')).toEqual([a, sameIdElsewhere, local]);
});

test('matchShortId matches nothing for an empty id', () => {
  expect(matchShortId([agent()], '')).toEqual([]);
});
