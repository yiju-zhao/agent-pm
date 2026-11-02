import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { execute } from '../../src/domain/execute.ts';
import type { DomainDeps } from '../../src/domain/types.ts';
import { openDb } from '../../src/server/db.ts';
import { SIDEBAR_PROJECT_MAX, sidebarLabels } from '../../src/server/sidebar.ts';
import { applySnapshot, listSessions } from '../../src/server/sessions-repo.ts';
import type { SnapshotSession } from '../../src/shared/protocol.ts';

const MACHINE = 'gx10-090e';
const NOW = new Date('2026-10-31T10:00:00.000Z');
const KEY_A = 'claude:5d27595b-908e-4fe5-9283-890acdbd075f';
const KEY_B = 'claude:9c1e0a77-1111-2222-3333-444455556666';

let db: DatabaseSync;
let deps: DomainDeps;

beforeEach(() => {
  db = openDb(':memory:');
  let n = 0;
  deps = { now: () => NOW, newId: (prefix) => `${prefix}_${++n}` };
});

afterEach(() => {
  db.close();
});

function session(key: string, terminal_id = 't1', extra: Partial<SnapshotSession> = {}): SnapshotSession {
  const pending = key.startsWith('pending:');
  const sep = key.indexOf(':');
  return {
    key,
    agent_kind: pending ? 'claude' : key.slice(0, sep),
    native_id: pending ? null : key.slice(sep + 1),
    pane_id: 'w1:1:1',
    terminal_id,
    workspace_id: 'w1',
    tab_id: 'w1:1',
    cwd: '/home/demo/proj',
    title: 'Some task',
    live_status: 'working',
    fidelity: pending ? 'screen' : 'full',
    transcript_path: pending ? null : '/home/demo/.claude/x.jsonl',
    ...extra,
  };
}

function snapshot(sessions: SnapshotSession[]): void {
  applySnapshot(db, { machine: MACHINE, collector_version: '0.1.0', sessions, purged: [] }, NOW);
}

function createProject(title: string): string {
  const r = execute(db, deps, { op: 'create_project', args: { title }, actor: 'user' });
  if (r.status !== 'applied') throw new Error(`create_project: ${r.status}`);
  return (r as unknown as { id: string }).id;
}

function link(sessionKey: string, project: string): void {
  const r = execute(db, deps, { op: 'link_session', args: { session: sessionKey, project }, actor: 'user' });
  if (r.status !== 'applied') throw new Error(`link_session: ${r.status}`);
}

test('short id matches the web view', () => {
  const a = 'claude:abcdef120000-aaaa-bbbb-ccccddddeeee';
  const b = 'claude:abcdef129999-aaaa-bbbb-ccccddddeeee';
  snapshot([session(a, 't1'), session(b, 't2'), session(KEY_A, 't3')]);

  const labels = sidebarLabels(db, [a, b, KEY_A]);

  const web = new Map(listSessions(db, {}, NOW).map((v) => [v.key, v.short_id]));
  expect(labels.map((l) => l.short_id)).toEqual([web.get(a), web.get(b), web.get(KEY_A)]);
  expect(labels.map((l) => l.short_id)).toEqual(['abcdef120', 'abcdef129', '5d27595b']);
});

test('short id is computed over every session row, including ended ones', () => {
  const ended = 'claude:5d27595bffff-0000-0000-0000-000000000000';
  snapshot([session(ended, 't9')]);
  snapshot([session(KEY_A, 't1')]); // the first session is no longer reported, so it ended

  const [label] = sidebarLabels(db, [KEY_A]);

  expect(label!.short_id).toBe('5d27595b-');
  expect(label!.short_id).toBe(listSessions(db, {}, NOW).find((v) => v.key === KEY_A)!.short_id);
});

test('labels come back in input order, one per key', () => {
  snapshot([session(KEY_A, 't1'), session(KEY_B, 't2')]);

  expect(sidebarLabels(db, [KEY_B, KEY_A]).map((l) => l.key)).toEqual([KEY_B, KEY_A]);
  expect(sidebarLabels(db, [])).toEqual([]);
});

test('project is null without links, the title with one, title +N with several', () => {
  snapshot([session(KEY_A, 't1'), session(KEY_B, 't2')]);
  const alpha = createProject('Alpha');
  const beta = createProject('Beta');
  const gamma = createProject('Gamma');

  expect(sidebarLabels(db, [KEY_A, KEY_B]).map((l) => l.project)).toEqual([null, null]);

  link(KEY_A, beta);
  expect(sidebarLabels(db, [KEY_A, KEY_B]).map((l) => l.project)).toEqual(['Beta', null]);

  link(KEY_A, gamma);
  link(KEY_A, alpha);
  // sessionLinks orders by project title, so Alpha is first
  expect(sidebarLabels(db, [KEY_A, KEY_B]).map((l) => l.project)).toEqual(['Alpha +2', null]);
});

test('a deleted link no longer counts', () => {
  snapshot([session(KEY_A, 't1')]);
  const alpha = createProject('Alpha');
  const beta = createProject('Beta');
  link(KEY_A, alpha);
  link(KEY_A, beta);
  const r = execute(db, deps, { op: 'unlink_session', args: { session: KEY_A, project: beta }, actor: 'user' });
  expect(r.status).toBe('applied');

  expect(sidebarLabels(db, [KEY_A])[0]!.project).toBe('Alpha');
});

test('long title is cut to 15 chars plus …', () => {
  snapshot([session(KEY_A, 't1')]);
  const title = '一二三四五六七八九十一二三四五六七八九十';
  expect([...title]).toHaveLength(20);
  link(KEY_A, createProject(title));

  expect(SIDEBAR_PROJECT_MAX).toBe(16);
  expect(sidebarLabels(db, [KEY_A])[0]!.project).toBe('一二三四五六七八九十一二三四五…');

  link(KEY_A, createProject('零')); // sorts after the long title (code point order), so the long one stays first
  expect(sidebarLabels(db, [KEY_A])[0]!.project).toBe('一二三四五六七八九十一二三四五… +1');
});

test('a title of exactly the maximum length is kept whole, one more is cut', () => {
  snapshot([session(KEY_A, 't1'), session(KEY_B, 't2')]);
  const exact = 'a'.repeat(SIDEBAR_PROJECT_MAX);
  link(KEY_A, createProject(exact));
  link(KEY_B, createProject('b'.repeat(SIDEBAR_PROJECT_MAX + 1)));

  const [a, b] = sidebarLabels(db, [KEY_A, KEY_B]);
  expect(a!.project).toBe(exact);
  expect(b!.project).toBe(`${'b'.repeat(SIDEBAR_PROJECT_MAX - 1)}…`);
});

test('titles are cut by code point, not UTF-16 unit', () => {
  snapshot([session(KEY_A, 't1'), session(KEY_B, 't2')]);
  // each of these is one code point but two UTF-16 units
  link(KEY_A, createProject('𠀀'.repeat(SIDEBAR_PROJECT_MAX)));
  link(KEY_B, createProject('𠀀'.repeat(SIDEBAR_PROJECT_MAX + 1)));

  const [whole, cut] = sidebarLabels(db, [KEY_A, KEY_B]);
  expect(whole!.project).toBe('𠀀'.repeat(SIDEBAR_PROJECT_MAX));
  expect(cut!.project).toBe(`${'𠀀'.repeat(SIDEBAR_PROJECT_MAX - 1)}…`);
});

test('merged pending key reports the target\'s short id and links under the original key', () => {
  const pending = `pending:${MACHINE}:t1`;
  snapshot([session(pending, 't1')]);
  snapshot([session(KEY_A, 't1')]); // the native session appears on the same terminal: pending merges into it
  const project = createProject('Alpha');
  link(KEY_A, project);

  const [label] = sidebarLabels(db, [pending]);

  expect(label).toEqual({ key: pending, short_id: '5d27595b', project: 'Alpha' });
});

test('unknown key still gets an entry', () => {
  const unknown = 'claude:0d67da1f-0000-0000-0000-000000000000';

  expect(sidebarLabels(db, [unknown])).toEqual([{ key: unknown, short_id: '0d67da1f', project: null }]);
});
