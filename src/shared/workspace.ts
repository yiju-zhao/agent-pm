import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

// What a session's working directory looks like as a repository, read where the session runs, so the center's model
// can tell what really happened (pushed or not, which branch, what was committed) instead of trusting old words.
// Strictly read-only: plain `git` reads with GIT_OPTIONAL_LOCKS=0, so even `git status` never refreshes the index or
// takes a lock. Not a repository, git missing, or slow: null, and nothing else changes.

const exec = promisify(execFile);
const TIMEOUT_MS = 3000;
export const WORKSPACE_TTL_MS = 120_000;

export const Workspace = z.object({
  root: z.string().max(1000),
  branch: z.string().max(300).nullable(),
  /** Commits ahead of / behind the upstream; null without one. */
  ahead: z.int().nonnegative().nullable(),
  behind: z.int().nonnegative().nullable(),
  /** Changed or untracked paths. */
  dirty: z.int().nonnegative(),
  /** The latest commits on HEAD, newest first. */
  recent: z.array(z.object({ sha: z.string().max(40), at: z.string().max(40), subject: z.string().max(300) })).max(5),
  checked_at: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    timeout: TIMEOUT_MS,
    maxBuffer: 1 << 20,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return stdout;
}

/** `## main...origin/main [ahead 2, behind 1]` → branch and counts. */
export function parseBranchLine(line: string): Pick<Workspace, 'branch' | 'ahead' | 'behind'> {
  const m = /^## (?:No commits yet on )?([^.\s]+(?:\.(?!\.)[^.\s]*)*)(\.\.\.(\S+))?(?: \[(.*)\])?/.exec(line);
  if (!m) return { branch: null, ahead: null, behind: null };
  const branch = m[1] === 'HEAD' ? null : m[1]!;
  if (!m[2]) return { branch, ahead: null, behind: null };
  const info = m[4] ?? '';
  const ahead = /ahead (\d+)/.exec(info);
  const behind = /behind (\d+)/.exec(info);
  return { branch, ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** The repository state of `cwd`, or null (see the header). */
export async function probeWorkspace(cwd: string, now: () => Date = () => new Date()): Promise<Workspace | null> {
  if (!cwd) return null;
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (!root) return null;
    const status = (await git(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'])).split('\n').filter(Boolean);
    const log = await git(cwd, ['log', '-5', '--format=%h%x09%cI%x09%s']).catch(() => '');
    const recent = log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha = '', at = '', ...rest] = l.split('\t');
        return { sha, at, subject: rest.join('\t').slice(0, 300) };
      });
    return { root, ...parseBranchLine(status[0] ?? ''), dirty: Math.max(0, status.length - 1), recent, checked_at: now().toISOString() };
  } catch {
    return null;
  }
}

/** One probe per directory per `WORKSPACE_TTL_MS`, so a collector polling every few seconds does not run git each time. */
export class WorkspaceCache {
  private readonly entries = new Map<string, { at: number; value: Promise<Workspace | null> }>();
  private readonly now: () => Date;
  private readonly probe: (cwd: string, now: () => Date) => Promise<Workspace | null>;

  constructor(now: () => Date = () => new Date(), probe: (cwd: string, now: () => Date) => Promise<Workspace | null> = probeWorkspace) {
    this.now = now;
    this.probe = probe;
  }

  get(cwd: string): Promise<Workspace | null> {
    const t = this.now().getTime();
    const hit = this.entries.get(cwd);
    if (hit && t - hit.at < WORKSPACE_TTL_MS) return hit.value;
    const value = this.probe(cwd, this.now);
    this.entries.set(cwd, { at: t, value });
    return value;
  }
}
