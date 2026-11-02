import { expect, test } from 'vitest';
import type { LookupAgent, RunHerdr } from '../../src/lookup/agents.ts';
import { describePlan, executePlan, findFocusedPane, planOpen, remoteAttachArgv } from '../../src/lookup/open.ts';
import type { OpenDeps } from '../../src/lookup/open.ts';

function agent(overrides: Partial<LookupAgent> = {}): LookupAgent {
  return {
    machine: null,
    target: null,
    pane_id: 'w8:p1T',
    agent_kind: 'claude',
    native_id: 'daaf1314-be9a-4f9a-9264-4d9d1d8fa37e',
    terminal_id: 'term_65efc937b197a27',
    title: 'Herdr 项目进度管理助手',
    cwd: '/Users/eason',
    status: 'working',
    ...overrides,
  };
}

const remote = (overrides: Partial<LookupAgent> = {}) =>
  agent({ machine: 'gx10-090e', target: '100.90.216.102', pane_id: 'w1:pJ', ...overrides });

test('local agent is focused', () => {
  expect(planOpen(agent(), { mode: 'split', focusedPane: 'w8:p1X' })).toEqual({ kind: 'focus', pane_id: 'w8:p1T' });
  // the mode only matters for remote agents
  expect(planOpen(agent(), { mode: 'inline', focusedPane: null })).toEqual({ kind: 'focus', pane_id: 'w8:p1T' });
});

test('remoteAttachArgv finds herdr on the remote PATH, else in ~/.local/bin', () => {
  expect(remoteAttachArgv('100.90.216.102', 'w1:pJ')).toEqual([
    'ssh',
    '-t',
    '100.90.216.102',
    'h=$(command -v herdr || echo "$HOME/.local/bin/herdr"); exec "$h" agent attach w1:pJ',
  ]);
});

test('remote agent splits beside the focused pane', () => {
  const plan = planOpen(remote(), { mode: 'split', focusedPane: 'w8:p1T' });
  expect(plan.kind).toBe('split');
  if (plan.kind !== 'split') return;
  expect(plan.target_pane).toBe('w8:p1T');
  expect(plan.command).toContain("ssh -t '100.90.216.102'");
  expect(plan.command).toContain('agent attach w1:pJ');
  expect(plan.command).toContain('$HOME/.local/bin/herdr');
  // the remote command is one single-quoted word, so the local shell expands nothing in it
  expect(plan.command).toBe(
    `ssh -t '100.90.216.102' 'h=$(command -v herdr || echo "$HOME/.local/bin/herdr"); exec "$h" agent attach w1:pJ'`,
  );
});

test('no focused pane falls back to inline', () => {
  expect(planOpen(remote(), { mode: 'split', focusedPane: null })).toEqual({
    kind: 'inline',
    argv: remoteAttachArgv('100.90.216.102', 'w1:pJ'),
  });
});

test('mode inline gives argv', () => {
  expect(planOpen(remote(), { mode: 'inline', focusedPane: 'w8:p1T' })).toEqual({
    kind: 'inline',
    argv: remoteAttachArgv('100.90.216.102', 'w1:pJ'),
  });
});

test('unsafe pane id or target is refused', () => {
  const ctx = { mode: 'split', focusedPane: 'w8:p1T' } as const;
  expect(() => planOpen(remote({ pane_id: 'w1:p1; rm -rf ~' }), ctx)).toThrow('pane 或机器地址里有意外字符，拒绝执行');
  expect(() => planOpen(remote({ target: 'host; reboot' }), ctx)).toThrow('pane 或机器地址里有意外字符，拒绝执行');
  expect(() => planOpen(remote({ target: "h'$(id)'" }), { mode: 'inline', focusedPane: null })).toThrow('拒绝执行');
  expect(() => planOpen(remote({ target: null }), ctx)).toThrow('拒绝执行');
  // a user@host target with dots and dashes is fine
  expect(() => planOpen(remote({ target: 'bz@100.87.40.81' }), ctx)).not.toThrow();
});

test('findFocusedPane takes the pane marked focused', () => {
  const list = {
    result: {
      panes: [
        { pane_id: 'w8:p1S', focused: false },
        { pane_id: 'w8:p1T', focused: true },
        { pane_id: 'w9:p1', focused: true },
      ],
    },
  };
  expect(findFocusedPane(list)).toBe('w8:p1T');
});

test('findFocusedPane gives null when nothing is focused or the input is odd', () => {
  expect(findFocusedPane({ result: { panes: [{ pane_id: 'w8:p1S', focused: false }, { pane_id: 'w8:p1T' }] } })).toBeNull();
  expect(findFocusedPane({ result: { panes: [{ focused: true }] } })).toBeNull();
  expect(findFocusedPane({ result: { panes: [] } })).toBeNull();
  expect(findFocusedPane({ result: {} })).toBeNull();
  expect(findFocusedPane(null)).toBeNull();
  expect(findFocusedPane('nope')).toBeNull();
});

function fakeDeps(run: RunHerdr, spawnInteractive: OpenDeps['spawnInteractive'] = async () => 0): OpenDeps {
  return {
    run,
    spawnInteractive,
    fetch: (async () => {
      throw new Error('executePlan must not touch the network');
    }) as typeof fetch,
    prompt: async () => null,
    interactive: false,
    env: {},
  };
}

test('executePlan focus runs herdr agent focus and returns 0', async () => {
  const calls: string[][] = [];
  const code = await executePlan(
    { kind: 'focus', pane_id: 'w8:p1T' },
    fakeDeps(async (args) => {
      calls.push(args);
      return '{}';
    }),
  );
  expect(code).toBe(0);
  expect(calls).toEqual([['agent', 'focus', 'w8:p1T']]);
});

test('executePlan split runs the attach in the new pane', async () => {
  const calls: string[][] = [];
  const run: RunHerdr = async (args) => {
    calls.push(args);
    return args[1] === 'split' ? JSON.stringify({ result: { pane: { pane_id: 'w8:p9' } } }) : '{}';
  };
  const plan = planOpen(remote(), { mode: 'split', focusedPane: 'w8:p1T' });
  const code = await executePlan(plan, fakeDeps(run));
  expect(code).toBe(0);
  if (plan.kind !== 'split') throw new Error('expected a split plan');
  expect(calls).toEqual([
    ['pane', 'split', 'w8:p1T', '--direction', 'right', '--focus'],
    ['pane', 'run', 'w8:p9', `${plan.command}; exit`],
  ]);
});

test('executePlan split rejects when herdr gives no new pane id, and runs nothing in it', async () => {
  const calls: string[][] = [];
  const run: RunHerdr = async (args) => {
    calls.push(args);
    return JSON.stringify({ result: { type: 'ok' } });
  };
  await expect(executePlan({ kind: 'split', target_pane: 'w8:p1T', command: 'ssh -t x y' }, fakeDeps(run))).rejects.toThrow(
    'herdr 没有返回新分屏的 pane ID',
  );
  expect(calls).toHaveLength(1);
});

test('executePlan split rejects when the split output is not JSON', async () => {
  await expect(
    executePlan({ kind: 'split', target_pane: 'w8:p1T', command: 'ssh -t x y' }, fakeDeps(async () => 'not json')),
  ).rejects.toThrow('herdr 没有返回新分屏的 pane ID');
});

test('executePlan inline spawns the argv and returns the exit code of ssh', async () => {
  const spawned: string[][] = [];
  const argv = remoteAttachArgv('100.90.216.102', 'w1:pJ');
  const run: RunHerdr = async () => {
    throw new Error('inline must not call herdr');
  };
  const code = await executePlan(
    { kind: 'inline', argv },
    fakeDeps(run, async (a) => {
      spawned.push(a);
      return 255;
    }),
  );
  expect(code).toBe(255);
  expect(spawned).toEqual([argv]);
});

test('a failing herdr call rejects executePlan with its message', async () => {
  await expect(
    executePlan(
      { kind: 'focus', pane_id: 'w8:p1T' },
      fakeDeps(async () => {
        throw new Error('pane w8:p1T 不存在');
      }),
    ),
  ).rejects.toThrow('pane w8:p1T 不存在');
});

test('describePlan shows the commands that would run', () => {
  expect(describePlan({ kind: 'focus', pane_id: 'w8:p1T' })).toBe('herdr agent focus w8:p1T');
  const inline = planOpen(remote(), { mode: 'inline', focusedPane: null });
  expect(describePlan(inline)).toBe(
    `ssh -t '100.90.216.102' 'h=$(command -v herdr || echo "$HOME/.local/bin/herdr"); exec "$h" agent attach w1:pJ'`,
  );
  const split = planOpen(remote(), { mode: 'split', focusedPane: 'w8:p1T' });
  const text = describePlan(split);
  expect(text).toContain('herdr pane split w8:p1T --direction right --focus');
  expect(text).toContain("ssh -t '100.90.216.102'");
});
