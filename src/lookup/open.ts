// Plan and execute "open this agent": focus a local one, attach to a remote one. Pure apart from
// the injected OpenDeps. Bundled into the single-file bun binary, so it imports only src/lookup.
import type { LookupAgent, RunHerdr } from './agents.ts';

export type RemoteMode = 'split' | 'inline';

export type OpenPlan =
  /** `herdr agent focus <pane>` */
  | { kind: 'focus'; pane_id: string }
  /** `herdr pane split <target> --direction right --focus`, then `pane run <new pane> "<command>; exit"` */
  | { kind: 'split'; target_pane: string; command: string }
  /** Run ssh right here, with this terminal's stdio. */
  | { kind: 'inline'; argv: string[] };

export type OpenDeps = {
  run: RunHerdr;
  /** Runs a program with this terminal's stdio and resolves with its exit code. */
  spawnInteractive(argv: string[]): Promise<number>;
  fetch: typeof fetch;
  /** Asks one line; null on EOF / Ctrl-D / Ctrl-C. */
  prompt(question: string): Promise<string | null>;
  /** stdin and stdout are both a terminal. */
  interactive: boolean;
  env: Record<string, string | undefined>;
};

/** How long one local herdr call that changes the UI may take. */
const ACTION_TIMEOUT_MS = 10_000;

// Values that end up inside a shell command are checked against these, never escaped.
const PANE_ID = /^[A-Za-z0-9:_-]+$/;
const SSH_TARGET = /^[A-Za-z0-9@._-]+$/;

/**
 * The ssh command that attaches to `paneId` on `target`. Non-interactive ssh has no herdr on its
 * PATH on these machines (it lives in ~/.local/bin), so the remote side looks for it itself.
 */
export function remoteAttachArgv(target: string, paneId: string): string[] {
  return ['ssh', '-t', target, `h=$(command -v herdr || echo "$HOME/.local/bin/herdr"); exec "$h" agent attach ${paneId}`];
}

function singleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** An ssh argv as one shell command: `ssh -t` stays bare, the target and the remote command are quoted. */
function sshShellForm(argv: string[]): string {
  return argv.map((word, i) => (i < 2 ? word : singleQuote(word))).join(' ');
}

/**
 * Local agent: focus its pane. Remote agent: attach over ssh, in a new split beside `focusedPane`
 * when the mode is `split` and there is such a pane, else right here (`inline`). Throws, without
 * building anything, when a remote pane id or ssh target has characters outside the whitelist.
 */
export function planOpen(agent: LookupAgent, ctx: { mode: RemoteMode; focusedPane: string | null }): OpenPlan {
  if (agent.machine === null) return { kind: 'focus', pane_id: agent.pane_id };
  if (agent.target === null || !PANE_ID.test(agent.pane_id) || !SSH_TARGET.test(agent.target)) {
    throw new Error('pane 或机器地址里有意外字符，拒绝执行');
  }
  const argv = remoteAttachArgv(agent.target, agent.pane_id);
  if (ctx.mode === 'split' && ctx.focusedPane !== null && ctx.focusedPane !== '') {
    return { kind: 'split', target_pane: ctx.focusedPane, command: sshShellForm(argv) };
  }
  return { kind: 'inline', argv };
}

/** The first pane marked `focused: true` in the JSON of `herdr pane list`; null when none is. */
export function findFocusedPane(paneListJson: unknown): string | null {
  const panes = (paneListJson as { result?: { panes?: unknown } } | null)?.result?.panes;
  if (!Array.isArray(panes)) return null;
  for (const pane of panes as Array<{ focused?: unknown; pane_id?: unknown } | null>) {
    if (pane?.focused === true && typeof pane.pane_id === 'string' && pane.pane_id !== '') return pane.pane_id;
  }
  return null;
}

/** The commands a plan stands for, in one line of text (what `--dry-run` shows). */
export function describePlan(plan: OpenPlan): string {
  switch (plan.kind) {
    case 'focus':
      return `herdr agent focus ${plan.pane_id}`;
    case 'split':
      return `herdr pane split ${plan.target_pane} --direction right --focus，然后在新分屏里运行：${plan.command}; exit`;
    case 'inline':
      return sshShellForm(plan.argv);
  }
}

/** The new pane's id out of the JSON of `herdr pane split`; null when it is not there. */
function newPaneId(output: string): string | null {
  try {
    const id = (JSON.parse(output) as { result?: { pane?: { pane_id?: unknown } } } | null)?.result?.pane?.pane_id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/**
 * Carries a plan out and resolves with the exit code: 0 for `focus` and `split`, ssh's own for
 * `inline`. Rejects with a Chinese message when herdr (or spawning ssh) fails.
 */
export async function executePlan(plan: OpenPlan, deps: OpenDeps): Promise<number> {
  switch (plan.kind) {
    case 'focus':
      await deps.run(['agent', 'focus', plan.pane_id], ACTION_TIMEOUT_MS);
      return 0;
    case 'split': {
      const output = await deps.run(['pane', 'split', plan.target_pane, '--direction', 'right', '--focus'], ACTION_TIMEOUT_MS);
      const pane = newPaneId(output);
      if (pane === null) throw new Error('herdr 没有返回新分屏的 pane ID');
      // `; exit` closes the split when the attach ends.
      await deps.run(['pane', 'run', pane, `${plan.command}; exit`], ACTION_TIMEOUT_MS);
      return 0;
    }
    case 'inline':
      return deps.spawnInteractive(plan.argv);
  }
}
