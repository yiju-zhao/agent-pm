import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { defaultOpenDeps, runOpen } from '../../src/lookup/command.ts';
import type { OpenDeps } from '../../src/lookup/open.ts';

// Shapes captured from `herdr agent list`, `herdr machine list --json` and `herdr pane list` on 2026-10-31.
function agentEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: 'claude',
    agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: '0d67da1f-aaaa-4bbb-8ccc-111122223333' },
    agent_status: 'idle',
    cwd: '/Users/eason',
    focused: false,
    pane_id: 'w8:p1T',
    tab_id: 'w8:t1',
    terminal_id: 'term_65efc937b197a27',
    terminal_title_stripped: '重构采集器',
    workspace_id: 'w8',
    ...overrides,
  };
}

const agentList = (...agents: Record<string, unknown>[]) =>
  JSON.stringify({ id: 'cli:agent:list', result: { agents, type: 'agent_list' } });

const MACHINES = JSON.stringify([
  { id: 'a', label: 'mac-mini', target: '100.111.225.68', session: 'default', enabled: true, selected: false },
  { id: 'b', label: 'gx10-090e', target: '100.90.216.102', session: 'default', enabled: true, selected: false },
  { id: 'c', label: 'gx10-c757', target: 'bz@100.87.40.81', session: 'default', enabled: true, selected: false },
]);

const paneList = (focused: string | null) =>
  JSON.stringify({
    result: {
      panes: [
        { pane_id: 'w8:p1S', focused: focused === 'w8:p1S' },
        { pane_id: 'w8:p1T', focused: focused === 'w8:p1T' },
      ],
    },
  });

const STATE_CHANGING = [['agent', 'focus'], ['agent', 'attach'], ['pane', 'split'], ['pane', 'run']];
const changesState = (args: string[]) => STATE_CHANGING.some(([a, b]) => args[0] === a && args[1] === b);

type Setup = {
  /** What each herdr call answers: `agent list` text per machine (null = this machine); an Error rejects. */
  lists?: Record<string, string | Error>;
  focusedPane?: string | null;
  interactive?: boolean;
  env?: Record<string, string | undefined>;
  answers?: Array<string | null>;
  center?: () => Response | Promise<Response>;
  spawnCode?: number;
  runFails?: (args: string[]) => Error | undefined;
};

function setup(s: Setup = {}) {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  const prompts: string[] = [];
  const urls: string[] = [];
  const answers = [...(s.answers ?? [])];
  const lists = s.lists ?? {};
  const deps: OpenDeps = {
    run: async (args) => {
      calls.push(args);
      const failure = s.runFails?.(args);
      if (failure) throw failure;
      const key = args[0] === '--machine' ? args[1]! : '';
      if (args.join(' ') === 'machine list --json') return MACHINES;
      if (args[args.length - 2] === 'agent' && args[args.length - 1] === 'list') {
        const answer = lists[key] ?? agentList();
        if (answer instanceof Error) throw answer;
        return answer;
      }
      if (args.join(' ') === 'pane list') return paneList(s.focusedPane === undefined ? 'w8:p1T' : s.focusedPane);
      if (args[0] === 'pane' && args[1] === 'split') return JSON.stringify({ result: { pane: { pane_id: 'w8:p9' } } });
      return '{}';
    },
    spawnInteractive: async (argv) => {
      spawned.push(argv);
      return s.spawnCode ?? 0;
    },
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (!s.center) throw new Error('connect ECONNREFUSED');
      return s.center();
    }) as typeof fetch,
    prompt: async (question) => {
      prompts.push(question);
      return answers.length > 0 ? answers.shift()! : null;
    },
    interactive: s.interactive ?? false,
    env: s.env ?? {},
  };
  return { deps, calls, spawned, prompts, urls };
}

async function open(args: string[], s: Setup = {}) {
  const t = setup(s);
  const out: string[] = [];
  const err: string[] = [];
  const herdrBins: string[] = [];
  const code = await runOpen(args, { stdout: (x) => out.push(x), stderr: (x) => err.push(x) }, (bin) => {
    herdrBins.push(bin);
    return t.deps;
  });
  return { ...t, code, stdout: out.join(''), stderr: err.join(''), herdrBins };
}

const SID = '0d67da1f';

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the promise to reject');
}
const stateChanging = (calls: string[][]) => calls.filter(changesState);

test('found locally: focuses and prints 已切换到', async () => {
  const r = await open([SID], { lists: { '': agentList(agentEntry({ agent_status: 'working' })) } });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`正在查找 ${SID}…\n找到：本机 · claude · 运行中 · 重构采集器\n已切换到 w8:p1T\n`);
  expect(r.stderr).toBe('');
  expect(stateChanging(r.calls)).toEqual([['agent', 'focus', 'w8:p1T']]);
  expect(r.spawned).toEqual([]);
});

test('the short id is cleaned up before it is looked up', async () => {
  const r = await open(['  0D67DA1F\n'], { lists: { '': agentList(agentEntry()) } });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain(`正在查找 ${SID}…`);
  const pasted = await open([`claude:0d67da1f-aaaa-4bbb-8ccc-111122223333`], { lists: { '': agentList(agentEntry()) } });
  expect(pasted.code).toBe(0);
  expect(pasted.stdout).toContain('正在查找 0d67da1f-aaaa-4bbb-8ccc-111122223333…');
});

test.each([
  ['working', '运行中'],
  ['blocked', '等你操作'],
  ['idle', '空闲'],
  ['done', '已完成'],
  ['unknown', 'unknown'],
])('status %s is shown as %s', async (status, text) => {
  const r = await open([SID], { lists: { '': agentList(agentEntry({ agent_status: status })) } });
  expect(r.stdout).toContain(`找到：本机 · claude · ${text} · 重构采集器`);
});

test('ambiguous, non-interactive: lists candidates and exits 1, nothing executed', async () => {
  const lists = {
    '': agentList(agentEntry({ pane_id: 'w8:p1T' }), agentEntry({ pane_id: 'w9:p2', terminal_title_stripped: '另一个窗口' })),
  };
  const r = await open([SID], { lists });
  expect(r.code).toBe(1);
  expect(r.stdout).toContain('[1] 本机 · claude · 空闲 · 重构采集器 · w8:p1T\n');
  expect(r.stdout).toContain('[2] 本机 · claude · 空闲 · 另一个窗口 · w9:p2\n');
  expect(r.stderr).toContain('匹配到多个，请用更长的短 ID');
  expect(stateChanging(r.calls)).toEqual([]);
  expect(r.spawned).toEqual([]);
  expect(r.prompts).toEqual([]);
});

test('ambiguous, interactive: picking 2 opens the second', async () => {
  const lists = { '': agentList(agentEntry({ pane_id: 'w8:p1T' }), agentEntry({ pane_id: 'w9:p2' })) };
  const r = await open([SID], { lists, interactive: true, answers: ['2'] });
  expect(r.code).toBe(0);
  expect(r.prompts).toEqual(['选择编号（回车取消）：']);
  expect(stateChanging(r.calls)).toEqual([['agent', 'focus', 'w9:p2']]);
  expect(r.stdout).toContain('已切换到 w9:p2');
});

test('ambiguous, interactive: Enter cancels, a wrong number is refused, and neither opens anything', async () => {
  const lists = { '': agentList(agentEntry({ pane_id: 'w8:p1T' }), agentEntry({ pane_id: 'w9:p2' })) };
  const cancelled = await open([SID], { lists, interactive: true, answers: ['', ''] });
  expect(cancelled.code).toBe(1);
  expect(cancelled.stderr).toContain('已取消');
  expect(cancelled.prompts).toEqual(['选择编号（回车取消）：', '按回车关闭']);
  expect(stateChanging(cancelled.calls)).toEqual([]);

  for (const answer of ['3', '0', 'x', '1x']) {
    const wrong = await open([SID], { lists, interactive: true, answers: [answer, ''] });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain(`没有这个编号：${answer}`);
    expect(stateChanging(wrong.calls)).toEqual([]);
  }
});

test('the same session in one pane on two machines is two candidates, with the machine named', async () => {
  const lists = { '': agentList(agentEntry()), 'gx10-090e': agentList(agentEntry({ pane_id: 'w1:pJ' })) };
  const r = await open([SID], { lists });
  expect(r.code).toBe(1);
  expect(r.stdout).toContain('[1] 本机 · claude');
  expect(r.stdout).toContain('[2] gx10-090e · claude');
});

test('not found with a center hint prints the hint', async () => {
  const r = await open([SID], {
    center: () =>
      Response.json([{ machine: 'gx10-090e', agent_kind: 'claude', effective_status: 'ended', title: '重构采集器' }]),
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toBe('这个 session 已结束（gx10-090e · 重构采集器）\n');
  expect(r.urls).toEqual([`http://localhost:7718/sessions/by-short-id/${SID}`]);
});

test('not found without a center hint says so, and a dead center changes nothing else', async () => {
  const r = await open([SID]);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe(`没有找到短 ID 为 ${SID} 的 agent\n`);
});

/** A trimmed SessionView as the center returns it. */
const centerView = (overrides: Record<string, unknown> = {}) => ({
  machine: 'gx10-090e',
  agent_kind: 'codex',
  effective_status: 'working',
  title: '重构采集器',
  terminal_id: 'term_abc',
  ...overrides,
});
// A codex pane herdr reports without a session id: the center knows its rollout's native id, herdr only the terminal.
const idlessCodex = (overrides: Record<string, unknown> = {}) =>
  agentEntry({ agent: 'codex', agent_session: null, terminal_id: 'term_abc', ...overrides });

test('a live local session the center knows by terminal id is focused although herdr lists no session id for it', async () => {
  const r = await open([SID], {
    lists: { '': agentList(idlessCodex({ pane_id: 'w3:p1' }), agentEntry({ terminal_id: 'term_other', pane_id: 'w4:p1', agent_session: { kind: 'id', value: 'ffffffff-0000' } })) },
    center: () => Response.json([centerView({ machine: 'laptop' })]),
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`正在查找 ${SID}…\n找到：本机 · codex · 空闲 · 重构采集器\n已切换到 w3:p1\n`);
  expect(r.stderr).toBe('');
  expect(stateChanging(r.calls)).toEqual([['agent', 'focus', 'w3:p1']]);
  // The center is asked once, and only for the pasted id.
  expect(r.urls).toEqual([`http://localhost:7718/sessions/by-short-id/${SID}`]);
});

test('a live remote session found by terminal id is opened like any remote agent', async () => {
  const r = await open([SID], {
    lists: { 'gx10-090e': agentList(idlessCodex({ pane_id: 'w1:pJ' })) },
    center: () => Response.json([centerView()]),
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('找到：gx10-090e · codex · 空闲 · 重构采集器');
  // outside herdr a remote agent is attached right here
  expect(r.spawned).toEqual([['ssh', '-t', '100.90.216.102', expect.stringContaining('agent attach w1:pJ')]]);

  const inHerdr = await open([SID], {
    lists: { 'gx10-090e': agentList(idlessCodex({ pane_id: 'w1:pJ' })) },
    center: () => Response.json([centerView()]),
    env: { HERDR_ENV: '1' },
  });
  expect(stateChanging(inHerdr.calls).map((c) => c.slice(0, 2))).toEqual([['pane', 'split'], ['pane', 'run']]);
});

test('an offline session is looked up by terminal id too: its collector is down, its pane may be fine', async () => {
  const r = await open([SID], {
    lists: { '': agentList(idlessCodex({ pane_id: 'w3:p1' })) },
    center: () => Response.json([centerView({ effective_status: 'offline' })]),
  });
  expect(r.code).toBe(0);
  expect(stateChanging(r.calls)).toEqual([['agent', 'focus', 'w3:p1']]);
});

test('an ended session in a pane herdr still lists is not opened: the hint is printed', async () => {
  for (const effective_status of ['ended', 'purged']) {
    const r = await open([SID], {
      lists: { '': agentList(idlessCodex({ pane_id: 'w3:p1' })) },
      center: () => Response.json([centerView({ effective_status })]),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('这个 session 已结束（gx10-090e · 重构采集器）\n');
    expect(stateChanging(r.calls)).toEqual([]);
    expect(r.spawned).toEqual([]);
  }
});

test('a live session whose terminal herdr does not list, or whose center row has no terminal, prints the hint', async () => {
  const gone = await open([SID], {
    lists: { '': agentList(idlessCodex({ terminal_id: 'term_else' })) },
    center: () => Response.json([centerView()]),
  });
  expect(gone.code).toBe(1);
  expect(gone.stderr).toBe('中心记录：gx10-090e · codex · 重构采集器，但 herdr 里没找到\n');
  const unknown = await open([SID], {
    lists: { '': agentList(idlessCodex()) },
    center: () => Response.json([centerView({ terminal_id: null })]),
  });
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toBe('中心记录：gx10-090e · codex · 重构采集器，但 herdr 里没找到\n');
  expect(stateChanging(unknown.calls)).toEqual([]);
});

test('only the live sessions of the center are matched by terminal id', async () => {
  const r = await open([SID], {
    lists: { '': agentList(idlessCodex({ pane_id: 'w3:p1' }), idlessCodex({ pane_id: 'w5:p1', terminal_id: 'term_old' })) },
    center: () => Response.json([centerView({ effective_status: 'ended', terminal_id: 'term_old' }), centerView()]),
  });
  expect(r.code).toBe(0);
  expect(stateChanging(r.calls)).toEqual([['agent', 'focus', 'w3:p1']]);
});

test('several live sessions of the center in several panes ask which one is meant', async () => {
  const lists = {
    '': agentList(idlessCodex({ pane_id: 'w3:p1' }), idlessCodex({ pane_id: 'w5:p1', terminal_id: 'term_def' })),
  };
  const center = () => Response.json([centerView(), centerView({ terminal_id: 'term_def' }), centerView()]);
  const listed = await open([SID], { lists, center });
  expect(listed.code).toBe(1);
  expect(listed.stdout).toContain('[1] 本机 · codex');
  expect(listed.stdout).toContain('[2] 本机 · codex');
  expect(listed.stdout).toContain('w3:p1\n');
  expect(listed.stdout).toContain('w5:p1\n');
  expect(listed.stderr).toContain('匹配到多个，请用更长的短 ID');
  expect(stateChanging(listed.calls)).toEqual([]);

  const picked = await open([SID], { lists, center, interactive: true, answers: ['2'] });
  expect(picked.code).toBe(0);
  expect(stateChanging(picked.calls)).toEqual([['agent', 'focus', 'w5:p1']]);
});

test('with the center down an id-less pane is simply not found', async () => {
  const r = await open([SID], { lists: { '': agentList(idlessCodex()) } });
  expect(r.code).toBe(1);
  expect(r.stderr).toBe(`没有找到短 ID 为 ${SID} 的 agent\n`);
  expect(stateChanging(r.calls)).toEqual([]);
  expect(r.spawned).toEqual([]);
});

test('--server and HERDR_PM_SERVER choose the center', async () => {
  const viaFlag = await open([SID, '--server', 'http://pm.test:9000']);
  expect(viaFlag.urls).toEqual([`http://pm.test:9000/sessions/by-short-id/${SID}`]);
  const viaEnv = await open([SID], { env: { HERDR_PM_SERVER: 'http://env.test:7718' } });
  expect(viaEnv.urls).toEqual([`http://env.test:7718/sessions/by-short-id/${SID}`]);
  const both = await open([SID, '--server', 'http://pm.test:9000'], { env: { HERDR_PM_SERVER: 'http://env.test:7718' } });
  expect(both.urls).toEqual([`http://pm.test:9000/sessions/by-short-id/${SID}`]);
});

test('the center is not asked when the agent is found', async () => {
  const r = await open([SID], { lists: { '': agentList(agentEntry()) } });
  expect(r.urls).toEqual([]);
});

test('unreachable machines are listed, and the others are still searched', async () => {
  const r = await open([SID], {
    lists: {
      'gx10-c757': new Error('超时（8 秒）'),
      'mac-mini': new Error('ssh: connect to host 100.111.225.68 port 22: Connection refused'),
      'gx10-090e': agentList(agentEntry({ pane_id: 'w1:pJ' })),
    },
    env: {},
  });
  expect(r.stderr).toContain('连不上：mac-mini（ssh: connect to host 100.111.225.68 port 22: Connection refused）\n');
  expect(r.stderr).toContain('连不上：gx10-c757（超时（8 秒））\n');
  // found on gx10-090e anyway; outside herdr that opens inline
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('找到：gx10-090e · claude · 空闲 · 重构采集器');
  expect(r.spawned).toHaveLength(1);
});

test('a reason that already starts with the machine name is not repeated', async () => {
  const r = await open([SID], { lists: { 'gx10-c757': '{"result":{}}' } });
  expect(r.stderr).toContain('连不上：gx10-c757（herdr agent list 的输出格式不对');
  expect(r.stderr).not.toContain('gx10-c757: ');
  expect(r.stderr).not.toContain('（gx10-c757');
});

test('unreachable machines show up before a not-found conclusion', async () => {
  const r = await open([SID], { lists: { 'gx10-c757': new Error('超时（8 秒）') } });
  expect(r.code).toBe(1);
  expect(r.stderr).toBe(`连不上：gx10-c757（超时（8 秒））\n没有找到短 ID 为 ${SID} 的 agent\n`);
});

test('bad short id exits 2 with 短 ID 格式不对', async () => {
  const r = await open(['ab!']);
  expect(r.code).toBe(2);
  expect(r.stderr).toBe('短 ID 格式不对：ab!\n');
  expect(r.calls).toEqual([]);
});

test('outside herdr the remote mode is inline', async () => {
  const lists = { 'gx10-090e': agentList(agentEntry({ pane_id: 'w1:pJ' })) };
  const r = await open([SID, '--remote', 'split'], { lists, env: {}, spawnCode: 0 });
  expect(r.code).toBe(0);
  expect(r.spawned).toEqual([
    ['ssh', '-t', '100.90.216.102', 'h=$(command -v herdr || echo "$HOME/.local/bin/herdr"); exec "$h" agent attach w1:pJ'],
  ]);
  expect(r.calls.some((c) => c[0] === 'pane')).toBe(false);
});

test('inline attach returns the exit code of ssh', async () => {
  const lists = { 'gx10-090e': agentList(agentEntry({ pane_id: 'w1:pJ' })) };
  const r = await open([SID, '--remote', 'inline'], { lists, env: { HERDR_ENV: '1' }, spawnCode: 255 });
  expect(r.code).toBe(255);
  expect(r.calls.some((c) => c[0] === 'pane')).toBe(false);
});

test('inside herdr a remote agent opens in a split beside the focused pane', async () => {
  const lists = { 'gx10-090e': agentList(agentEntry({ pane_id: 'w1:pJ' })) };
  const r = await open([SID], { lists, env: { HERDR_ENV: '1' }, focusedPane: 'w8:p1T' });
  expect(r.code).toBe(0);
  expect(stateChanging(r.calls)).toEqual([
    ['pane', 'split', 'w8:p1T', '--direction', 'right', '--focus'],
    [
      'pane',
      'run',
      'w8:p9',
      `ssh -t '100.90.216.102' 'h=$(command -v herdr || echo "$HOME/.local/bin/herdr"); exec "$h" agent attach w1:pJ'; exit`,
    ],
  ]);
  expect(r.stdout).toContain('已在右侧分屏打开（ctrl+b q 退出 attach）');
  expect(r.spawned).toEqual([]);
});

test('inside herdr with no focused pane the remote agent opens inline', async () => {
  const lists = { 'gx10-090e': agentList(agentEntry({ pane_id: 'w1:pJ' })) };
  const r = await open([SID], { lists, env: { HERDR_ENV: '1' }, focusedPane: null });
  expect(r.code).toBe(0);
  expect(r.spawned).toHaveLength(1);
  expect(stateChanging(r.calls)).toEqual([]);
});

test('--herdr names the herdr binary for makeDeps, default herdr', async () => {
  expect((await open([SID, '--herdr', '/opt/herdr'])).herdrBins).toEqual(['/opt/herdr']);
  expect((await open([SID])).herdrBins).toEqual(['herdr']);
});

test('--dry-run prints the plan and executes nothing', async () => {
  const remoteLists = { 'gx10-090e': agentList(agentEntry({ pane_id: 'w1:pJ' })) };
  const remoteSplit = await open([SID, '--dry-run'], { lists: remoteLists, env: { HERDR_ENV: '1' } });
  expect(remoteSplit.code).toBe(0);
  expect(remoteSplit.stdout).toContain('找到：gx10-090e · claude');
  expect(remoteSplit.stdout).toContain('将执行：herdr pane split w8:p1T --direction right --focus');
  expect(remoteSplit.stdout).toContain("ssh -t '100.90.216.102'");
  expect(remoteSplit.stdout).not.toContain('已在右侧分屏打开');

  const remoteInline = await open([SID, '--dry-run'], { lists: remoteLists, env: {} });
  expect(remoteInline.stdout).toContain("将执行：ssh -t '100.90.216.102' 'h=$(command -v herdr");

  const local = await open([SID, '--dry-run'], { lists: { '': agentList(agentEntry()) } });
  expect(local.code).toBe(0);
  expect(local.stdout).toContain('将执行：herdr agent focus w8:p1T\n');
  expect(local.stdout).not.toContain('已切换到');

  for (const r of [remoteSplit, remoteInline, local]) {
    expect(stateChanging(r.calls)).toEqual([]);
    expect(r.spawned).toEqual([]);
  }
});

test('interactive failure waits for 按回车关闭', async () => {
  const r = await open([SID], { interactive: true, answers: [''] });
  expect(r.code).toBe(1);
  expect(r.prompts).toEqual(['按回车关闭']);
  // the message is on screen before the wait
  expect(r.stderr).toContain('没有找到');
});

test('interactive success and non-interactive failure do not wait', async () => {
  const found = await open([SID], { interactive: true, lists: { '': agentList(agentEntry()) } });
  expect(found.code).toBe(0);
  expect(found.prompts).toEqual([]);
  expect((await open([SID])).prompts).toEqual([]);
});

test('interactive, a bad short id also waits', async () => {
  const r = await open(['ab!'], { interactive: true, answers: [''] });
  expect(r.code).toBe(2);
  expect(r.prompts).toEqual(['按回车关闭']);
});

test('interactive without an argument asks for the short id', async () => {
  const r = await open([], { interactive: true, answers: [` ${SID.toUpperCase()} `], lists: { '': agentList(agentEntry()) } });
  expect(r.code).toBe(0);
  expect(r.prompts).toEqual(['短 ID：']);
  expect(stateChanging(r.calls)).toEqual([['agent', 'focus', 'w8:p1T']]);
});

test('interactive, no short id typed (Enter or Ctrl-D) opens nothing', async () => {
  const enter = await open([], { interactive: true, answers: ['', ''] });
  expect(enter.code).toBe(1);
  expect(enter.stderr).toContain('已取消');
  expect(enter.calls).toEqual([]);
  const eof = await open([], { interactive: true, answers: [null] });
  expect(eof.code).toBe(1);
  expect(eof.calls).toEqual([]);
});

test('without a short id and without a terminal it is a usage error', async () => {
  const r = await open([]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('缺少短 ID');
  expect(r.stderr).toContain('herdr-pm open [<短ID>] [--remote split|inline]');
  expect(r.calls).toEqual([]);
});

test.each([
  [['--remote', 'sideways', SID], '--remote'],
  [['--bogus', SID], '--bogus'],
  [[SID, 'second'], '多余的参数'],
  [[SID, '--server'], '--server'],
])('bad arguments %j are a usage error', async (args, mention) => {
  const r = await open(args);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(mention);
  expect(r.stderr).toContain('用法：herdr-pm open');
  expect(r.calls).toEqual([]);
});

test('a failing open reports 打开失败 and exits 1', async () => {
  const r = await open([SID], {
    lists: { '': agentList(agentEntry()) },
    runFails: (args) => (args[0] === 'agent' && args[1] === 'focus' ? new Error('pane w8:p1T 不存在') : undefined),
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toBe('打开失败：pane w8:p1T 不存在\n');
});

test('an unsafe pane id is refused and nothing runs', async () => {
  const lists = { 'gx10-090e': agentList(agentEntry({ pane_id: 'w1:p1; rm -rf ~' })) };
  const r = await open([SID], { lists, env: { HERDR_ENV: '1' } });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('pane 或机器地址里有意外字符，拒绝执行');
  expect(stateChanging(r.calls)).toEqual([]);
  expect(r.spawned).toEqual([]);
});

test('a failing pane list falls back to inline', async () => {
  const lists = { 'gx10-090e': agentList(agentEntry({ pane_id: 'w1:pJ' })) };
  const r = await open([SID], {
    lists,
    env: { HERDR_ENV: '1' },
    runFails: (args) => (args[0] === 'pane' && args[1] === 'list' ? new Error('boom') : undefined),
  });
  expect(r.code).toBe(0);
  expect(r.spawned).toHaveLength(1);
});

// --- the real RunHerdr, driven through a fake herdr executable ---

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-pm-open-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeHerdr(script: string): string {
  const path = join(dir, 'herdr');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

test('defaultOpenDeps.run returns stdout and passes the arguments through without a shell', async () => {
  const bin = fakeHerdr('for a in "$@"; do printf "[%s]" "$a"; done');
  const out = await defaultOpenDeps(bin).run(['agent', 'list', 'a b', '$HOME;x'], 5000);
  expect(out).toBe('[agent][list][a b][$HOME;x]');
});

test('defaultOpenDeps.run rejects with the first line of stderr, not Node\'s "Command failed"', async () => {
  const bin = fakeHerdr('printf "\\n  ssh: connect to host 10.0.0.9 port 22: Connection refused\\nsecond line\\n" >&2; exit 255');
  const err = await rejection(defaultOpenDeps(bin).run(['--machine', 'x', 'agent', 'list'], 5000));
  expect(err.message.split('\n')[0]).toBe('ssh: connect to host 10.0.0.9 port 22: Connection refused');
  expect(err.message).not.toContain('Command failed');
});

test('defaultOpenDeps.run says the exit code when herdr fails without stderr', async () => {
  const err = await rejection(defaultOpenDeps(fakeHerdr('exit 3')).run(['agent', 'list'], 5000));
  expect(err.message).toBe('herdr 退出码 3');
});

test('defaultOpenDeps.run times out by killing herdr, even when a child keeps the pipe open', async () => {
  // `sleep` outlives its parent shell and keeps stdout open, like an ssh started by `herdr --machine`
  const bin = fakeHerdr('sleep 5; echo late');
  const started = Date.now();
  const err = await rejection(defaultOpenDeps(bin).run(['--machine', 'gx10-c757', 'agent', 'list'], 300));
  expect(err.message).toBe('超时（0.3 秒）');
  expect(Date.now() - started).toBeLessThan(2500);
});

test('defaultOpenDeps.run names a missing herdr binary', async () => {
  const err = await rejection(defaultOpenDeps(join(dir, 'no-such-herdr')).run(['agent', 'list'], 5000));
  expect(err.message.split('\n')[0]).toBe(`找不到 herdr 可执行文件：${join(dir, 'no-such-herdr')}`);
});

test('defaultOpenDeps.spawnInteractive returns the exit code of the program', async () => {
  const deps = defaultOpenDeps('herdr');
  expect(await deps.spawnInteractive(['sh', '-c', 'exit 0'])).toBe(0);
  expect(await deps.spawnInteractive(['sh', '-c', 'exit 7'])).toBe(7);
  await expect(deps.spawnInteractive([join(dir, 'no-such-ssh')])).rejects.toThrow(/找不到/);
});

test('defaultOpenDeps reports a terminal only when stdin and stdout both are one', () => {
  const stdin = process.stdin.isTTY;
  const stdout = process.stdout.isTTY;
  expect(defaultOpenDeps('herdr').interactive).toBe(stdin === true && stdout === true);
});

test('src/lookup imports only node built-ins, zod, src/shared and itself, so the bun single-file build never pulls in node:sqlite or hono', () => {
  const root = new URL('../../src/lookup/', import.meta.url);
  const files = readdirSync(root).filter((name) => name.endsWith('.ts'));
  expect(files).toEqual(expect.arrayContaining(['agents.ts', 'center.ts', 'command.ts', 'open.ts']));
  for (const file of files) {
    const source = readFileSync(new URL(file, root), 'utf8');
    const specifiers = [...source.matchAll(/^(?:import|export)\s[^;]*?from\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/gms)].map((m) => m[1] ?? m[2]!);
    for (const spec of specifiers) {
      expect(spec, `${file} imports ${spec}`).toMatch(/^(node:[a-z/_]+|zod|\.\/[a-z-]+\.ts|\.\.\/shared\/[a-z-]+\.ts)$/);
    }
  }
});
