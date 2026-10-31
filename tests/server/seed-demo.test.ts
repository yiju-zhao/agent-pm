import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getProject, listProjects, listQuestions } from '../../src/domain/read.ts';
import { defaultDeps } from '../../src/domain/types.ts';
import { openDb } from '../../src/server/db.ts';
import { listSessions } from '../../src/server/sessions-repo.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'scripts', 'seed-demo.ts');

let dir: string;
let dbPath: string;
let opened: DatabaseSync | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-pm-seed-'));
  dbPath = join(dir, 'demo.db');
});

afterEach(() => {
  opened?.close();
  opened = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the script the way `npm run seed:demo` does, with stdout and stderr captured instead of printed. */
function seed(...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status ?? -1, stdout: e.stdout, stderr: e.stderr };
  }
}

function open(): DatabaseSync {
  opened = openDb(dbPath);
  return opened;
}

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('builds a demo database and exits 0', () => {
  const run = seed(dbPath);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(dbPath);
  expect(existsSync(dbPath)).toBe(true);
});

test('five projects: one new idea, one closed, one dormant, and the P0 in build', () => {
  expect(seed(dbPath).status).toBe(0);
  const projects = listProjects(open(), new Date(), {});
  expect(projects).toHaveLength(5);
  expect(projects.filter((p) => p.inbox)).toHaveLength(1);
  expect(projects.filter((p) => p.closed)).toHaveLength(1);
  expect(projects.filter((p) => p.dormant_days !== null)).toHaveLength(1);
  expect(projects.filter((p) => p.stage === 'parked')).toHaveLength(1);
  const p0 = projects.filter((p) => p.priority === 'P0');
  expect(p0).toHaveLength(1);
  expect(p0[0].stage).toBe('build');
});

test('the idea an AI made is in the inbox, and the dormant one is neither closed nor in the inbox', () => {
  expect(seed(dbPath).status).toBe(0);
  const projects = listProjects(open(), new Date(), {});
  const idea = projects.find((p) => p.inbox)!;
  expect(idea.stage).toBe('idea');
  expect(idea.created_by).toBe('ai:curator');
  const dormant = projects.find((p) => p.dormant_days !== null)!;
  expect(dormant.closed).toBe(false);
  expect(dormant.inbox).toBe(false);
  expect(dormant.dormant_days).toBeGreaterThanOrEqual(7);
  expect(dormant.active_sessions).toEqual([]);
});

test('the P0 project has three milestones, todos, an open blocker, a decision with chunk evidence and live sessions', () => {
  expect(seed(dbPath).status).toBe(0);
  const db = open();
  const now = new Date();
  const p0 = getProject(db, now, listProjects(db, now, { priority: 'P0' })[0].id)!;
  expect(p0.milestones.map((m) => m.status).sort()).toEqual(['doing', 'done', 'todo']);
  expect(p0.todos.length).toBeGreaterThanOrEqual(2);
  expect(p0.open_blockers).toHaveLength(1);
  expect(p0.decisions).toHaveLength(1);
  const [ref] = p0.decisions[0].evidence;
  expect(ref).toMatch(/^chunk:[1-9][0-9]*$/);
  const chunk = db.prepare('SELECT id FROM chunks WHERE id = ?').get(Number(ref.slice('chunk:'.length)));
  expect(chunk).toBeDefined();
  expect(p0.active_sessions.length).toBeGreaterThanOrEqual(2);
  expect(p0.pending_questions.length).toBeGreaterThanOrEqual(1);
  expect(p0.summary).toBeTruthy();
  expect(p0.locks).not.toContain('summary');
});

test('pending questions: a choice, a text, and one about a session that belongs to no project yet', () => {
  expect(seed(dbPath).status).toBe(0);
  const db = open();
  const pending = listQuestions(db, defaultDeps(), { status: 'pending' });
  expect(pending.length).toBeGreaterThanOrEqual(3);
  expect(pending.some((q) => q.kind === 'choice')).toBe(true);
  expect(pending.some((q) => q.kind === 'text')).toBe(true);
  const attribution = pending.filter((q) => q.session_key !== null && q.project_id === null);
  expect(attribution.length).toBeGreaterThanOrEqual(1);
  expect(db.prepare('SELECT key FROM sessions WHERE key = ?').get(attribution[0].session_key!)).toBeDefined();
});

test('six sessions on two machines, with every kind of status and one that only has the screen', () => {
  expect(seed(dbPath).status).toBe(0);
  const sessions = listSessions(open(), {}, new Date());
  expect(sessions).toHaveLength(6);
  expect(new Set(sessions.map((s) => s.machine)).size).toBe(2);
  const statuses = new Set(sessions.map((s) => s.effective_status));
  for (const status of ['working', 'idle', 'blocked', 'ended']) expect(statuses.has(status as never), status).toBe(true);
  expect(sessions.filter((s) => s.fidelity === 'screen')).toHaveLength(1);
  for (const s of sessions) expect(s.chunk_count, s.key).toBe(2);
});

test('an AI event was reverted, so the event log has a revert chain', () => {
  expect(seed(dbPath).status).toBe(0);
  const db = open();
  const reverted = db.prepare('SELECT id, actor, reverted_by FROM events WHERE reverted_by IS NOT NULL').all() as Array<{
    id: number;
    actor: string;
    reverted_by: number;
  }>;
  expect(reverted.length).toBeGreaterThanOrEqual(1);
  expect(reverted[0].actor).toBe('ai:curator');
  const revert = db.prepare('SELECT actor, op, reverts FROM events WHERE id = ?').get(reverted[0].reverted_by) as {
    actor: string;
    op: string;
    reverts: number;
  };
  expect(revert).toEqual({ actor: 'user', op: 'revert_event', reverts: reverted[0].id });
});

test('refuses to touch an existing file: exits non-zero, says why, and leaves the data as it was', () => {
  expect(seed(dbPath).status).toBe(0);
  const before = hash(dbPath);
  const run = seed(dbPath);
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain(dbPath);
  expect(run.stderr).toContain('已存在');
  expect(hash(dbPath)).toBe(before);
  expect(listProjects(open(), new Date(), {})).toHaveLength(5);
});

test('without a path it prints the usage and exits non-zero', () => {
  const run = seed();
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain('seed-demo.ts <dbPath>');
});

test('a path in a directory that does not exist fails without leaving anything behind', () => {
  const missing = join(dir, 'no-such-dir', 'demo.db');
  const run = seed(missing);
  expect(run.status).not.toBe(0);
  expect(existsSync(join(dir, 'no-such-dir'))).toBe(false);
});
