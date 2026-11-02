// `herdr-pm open [<短ID>]`: arguments, the questions it asks, what it prints, and the real
// process / terminal plumbing behind OpenDeps. Bundled into the single-file bun binary, so it
// imports only node built-ins and src/lookup (never the server, node:sqlite, hono or the Agent SDK).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { listAllAgents, matchShortId, normalizeShortId } from './agents.ts';
import type { LookupAgent, RunHerdr } from './agents.ts';
import { centerHint } from './center.ts';
import { describePlan, executePlan, findFocusedPane, planOpen } from './open.ts';
import type { OpenDeps, OpenPlan, RemoteMode } from './open.ts';

const DEFAULT_SERVER = 'http://localhost:7718';
const USAGE = '用法：herdr-pm open [<短ID>] [--remote split|inline] [--server <url>] [--herdr <path>] [--dry-run]';
const PANE_LIST_TIMEOUT_MS = 5000;

const STATUS_TEXT: Record<string, string> = {
  working: '运行中',
  blocked: '等你操作',
  idle: '空闲',
  done: '已完成',
};

type OpenArgs = { shortId: string | undefined; remote: RemoteMode; server: string | undefined; herdr: string; dryRun: boolean };

function parseOpenArgs(args: string[]): { error: string } | { args: OpenArgs } {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { remote: { type: 'string' }, server: { type: 'string' }, herdr: { type: 'string' }, 'dry-run': { type: 'boolean' } },
      strict: true,
      allowPositionals: true,
    });
    const { remote = 'split', server, herdr = 'herdr', 'dry-run': dryRun = false } = values;
    if (remote !== 'split' && remote !== 'inline') return { error: `--remote 只能是 split 或 inline，收到 "${remote}"` };
    if (positionals.length > 1) return { error: `多余的参数：${positionals.slice(1).join(' ')}` };
    return { args: { shortId: positionals[0], remote, server, herdr, dryRun } };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The reason without the machine name `parseAgentList` already put in front of it. */
function reasonOf(machine: string, error: string): string {
  for (const separator of [': ', '：']) {
    if (error.startsWith(`${machine}${separator}`)) return error.slice(machine.length + separator.length);
  }
  return error;
}

function summary(a: LookupAgent): string {
  const title = a.title.replace(/\s+/g, ' ').trim() || '（无标题）';
  return `${a.machine ?? '本机'} · ${a.agent_kind} · ${STATUS_TEXT[a.status] ?? a.status} · ${title}`;
}

async function focusedPaneOf(deps: OpenDeps): Promise<string | null> {
  try {
    return findFocusedPane(JSON.parse(await deps.run(['pane', 'list'], PANE_LIST_TIMEOUT_MS)) as unknown);
  } catch {
    return null;
  }
}

/**
 * Runs `herdr-pm open` and returns the exit code: 0 opened, 1 not found / ambiguous / failed to
 * open, 2 usage error; an inline attach returns ssh's own. `makeDeps` gets the `--herdr` value
 * (default `herdr`) once the arguments are parsed. In a terminal, a failure waits for Enter before
 * returning, so a popup does not vanish with its message.
 */
export async function runOpen(
  args: string[],
  io: { stdout(text: string): void; stderr(text: string): void },
  makeDeps: (herdrBin: string) => OpenDeps,
): Promise<number> {
  const usageError = (message: string) => {
    io.stderr(`herdr-pm open: ${message}\n${USAGE}\n`);
    return 2;
  };
  const parsed = parseOpenArgs(args);
  if ('error' in parsed) return usageError(parsed.error);
  const { remote, dryRun } = parsed.args;
  const deps = makeDeps(parsed.args.herdr);

  const finish = async (code: number) => {
    if (code !== 0 && deps.interactive) await deps.prompt('按回车关闭');
    return code;
  };
  const fail = (code: number, message: string) => {
    io.stderr(`${message}\n`);
    return finish(code);
  };

  let raw: string;
  if (parsed.args.shortId !== undefined) {
    raw = parsed.args.shortId;
  } else {
    if (!deps.interactive) return usageError('缺少短 ID（不在终端里时必须作为参数给出）');
    const typed = await deps.prompt('短 ID：');
    if (typed === null) {
      io.stderr('已取消\n');
      return 1;
    }
    if (typed.trim() === '') return fail(1, '已取消');
    raw = typed;
  }
  const sid = normalizeShortId(raw);
  if (sid === null) return fail(2, `短 ID 格式不对：${raw.trim()}`);

  io.stdout(`正在查找 ${sid}…\n`);
  const { agents, unreachable } = await listAllAgents(deps.run);
  for (const { machine, error } of unreachable) io.stderr(`连不上：${machine}（${reasonOf(machine, error)}）\n`);

  const matches = matchShortId(agents, sid);
  if (matches.length === 0) {
    const server = parsed.args.server || deps.env.HERDR_PM_SERVER || DEFAULT_SERVER;
    return fail(1, (await centerHint(deps.fetch, server, sid)) ?? `没有找到短 ID 为 ${sid} 的 agent`);
  }

  let agent: LookupAgent;
  if (matches.length === 1) {
    agent = matches[0]!;
    io.stdout(`找到：${summary(agent)}\n`);
  } else {
    matches.forEach((m, i) => io.stdout(`[${i + 1}] ${summary(m)} · ${m.pane_id}\n`));
    if (!deps.interactive) return fail(1, '匹配到多个，请用更长的短 ID');
    const answer = (await deps.prompt('选择编号（回车取消）：'))?.trim() ?? '';
    if (answer === '') return fail(1, '已取消');
    const picked = /^\d+$/.test(answer) ? matches[Number(answer) - 1] : undefined;
    if (picked === undefined) return fail(1, `没有这个编号：${answer}`);
    agent = picked;
  }

  // Outside herdr there is no pane to split beside, so a remote agent is attached right here.
  const mode: RemoteMode = deps.env.HERDR_ENV === '1' ? remote : 'inline';
  const focusedPane = agent.machine !== null && mode === 'split' ? await focusedPaneOf(deps) : null;
  let plan: OpenPlan;
  try {
    plan = planOpen(agent, { mode, focusedPane });
  } catch (err) {
    return fail(1, errorText(err));
  }
  if (dryRun) {
    io.stdout(`将执行：${describePlan(plan)}\n`);
    return 0;
  }

  let code: number;
  try {
    code = await executePlan(plan, deps);
  } catch (err) {
    return fail(1, `打开失败：${errorText(err)}`);
  }
  if (code === 0) {
    if (plan.kind === 'focus') io.stdout(`已切换到 ${plan.pane_id}\n`);
    if (plan.kind === 'split') io.stdout('已在右侧分屏打开（ctrl+b q 退出 attach）\n');
  }
  return finish(code);
}

/**
 * `herdr <args>` as a promise of its stdout. No shell. When `timeoutMs` runs out the child is
 * killed and the promise rejects at once, without waiting for the pipes to close: `herdr --machine`
 * runs ssh underneath, and a hung ssh can keep the pipes open long after herdr itself is gone.
 * The message of a rejection starts with the reason (first line of stderr, `超时（8 秒）`), never
 * Node's own `Command failed: …`, because callers show only that first line.
 */
function execHerdr(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(
      () =>
        settle(() => {
          child.kill('SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
          reject(new Error(`超时（${timeoutMs / 1000} 秒）`));
        }),
      timeoutMs,
    );
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err: NodeJS.ErrnoException) =>
      settle(() =>
        reject(new Error(err.code === 'ENOENT' ? `找不到 herdr 可执行文件：${bin}` : `无法运行 ${bin}：${err.message}`, { cause: err })),
      ),
    );
    child.on('close', (code) =>
      settle(() => {
        if (code === 0) return resolve(stdout);
        const reason = stderr.split('\n').find((line) => line.trim() !== '');
        reject(new Error(reason?.trim() ?? `herdr 退出码 ${code ?? '未知'}`));
      }),
    );
  });
}

function spawnInteractive(argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit' });
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(new Error(err.code === 'ENOENT' ? `找不到 ${argv[0]}` : `无法运行 ${argv[0]}：${err.message}`, { cause: err })),
    );
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** One line from the terminal; null on Ctrl-D or Ctrl-C. A fresh interface per question, closed after it. */
async function prompt(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = rl.question(question).catch(() => null);
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
    return await Promise.race([answer, closed]);
  } finally {
    rl.close();
  }
}

/** The real thing: herdr (`herdrBin`) and ssh as child processes, this process's terminal, global fetch. */
export function defaultOpenDeps(herdrBin: string): OpenDeps {
  const run: RunHerdr = (args, timeoutMs) => execHerdr(herdrBin, args, timeoutMs);
  return {
    run,
    spawnInteractive,
    fetch,
    prompt,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    env: process.env,
  };
}
