import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { parseBranchLine, probeWorkspace, WorkspaceCache } from '../../src/shared/workspace.ts';

let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ws-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('the branch line gives the branch and how far it is from its upstream', () => {
  expect(parseBranchLine('## main...origin/main [ahead 2, behind 1]')).toEqual({ branch: 'main', ahead: 2, behind: 1 });
  expect(parseBranchLine('## feat/x...origin/feat/x')).toEqual({ branch: 'feat/x', ahead: 0, behind: 0 });
  expect(parseBranchLine('## main')).toEqual({ branch: 'main', ahead: null, behind: null });
  expect(parseBranchLine('## HEAD (no branch)')).toEqual({ branch: null, ahead: null, behind: null });
});

test('a repository is read without changing anything in it: branch, unpushed commits, dirty files, recent commits', async () => {
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  await writeFile(join(work, 'a.txt'), 'a');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'push', '-q', 'origin', 'main');
  await writeFile(join(work, 'b.txt'), 'b');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'second, not pushed');
  await writeFile(join(work, 'c.txt'), 'dirty');
  const index = join(work, '.git', 'index');
  const before = { bytes: await readFile(index), mtime: (await stat(index)).mtimeMs };

  const w = await probeWorkspace(work, () => new Date('2026-11-15T00:00:00Z'));
  expect(w).toMatchObject({ branch: 'main', ahead: 1, behind: 0, dirty: 1, checked_at: '2026-11-15T00:00:00.000Z' });
  expect(w!.recent.map((c) => c.subject)).toEqual(['second, not pushed', 'first']);
  expect((await readFile(index)).equals(before.bytes)).toBe(true);
  expect((await stat(index)).mtimeMs).toBe(before.mtime);
});

test('not a repository, or no directory: null', async () => {
  expect(await probeWorkspace(dir)).toBeNull();
  expect(await probeWorkspace(join(dir, 'missing'))).toBeNull();
  expect(await probeWorkspace('')).toBeNull();
});

test('a directory is probed once per two minutes', async () => {
  let calls = 0;
  let now = new Date('2026-11-15T00:00:00Z');
  const cache = new WorkspaceCache(() => now, async () => (calls++, null));
  await cache.get('/a');
  await cache.get('/a');
  now = new Date('2026-11-15T00:01:59Z');
  await cache.get('/a');
  expect(calls).toBe(1);
  now = new Date('2026-11-15T00:02:01Z');
  await cache.get('/a');
  await cache.get('/b');
  expect(calls).toBe(3);
});
