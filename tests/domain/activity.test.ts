import { afterEach, beforeEach, expect, test } from 'vitest';
import { getActivity } from '../../src/domain/activity.ts';
import { setup } from './helpers.ts';
import type { Setup } from './helpers.ts';

// The period view the overview and the review page are drawn from, over operations run the way the server runs them.

let t: Setup;
const A = 'codex:aaaaaaaa';
const B = 'codex:bbbbbbbb';
const C = 'codex:cccccccc';
beforeEach(() => {
  t = setup();
  t.setNow('2026-11-15T03:00:00.000Z');
  for (const [key, machine] of [[A, 'mini'], [B, 'gx10'], [C, 'gx10']] as const) {
    t.db.prepare(
      `INSERT INTO sessions (key, agent_kind, machine, cwd, title, live_status, lifecycle, ignored, first_seen, last_seen)
       VALUES (?, 'codex', ?, '/w', 't', 'idle', 'live', 0, ?, ?)`,
    ).run(key, machine, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
  }
});
afterEach(() => t.db.close());

let offset = 0;
function chunk(key: string, at: string, kind = 'transcript'): void {
  offset += 1;
  t.db.prepare('INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(key, kind, offset, offset, at, at, 'x');
}
/** Runs an operation as if it happened at `at`. */
function at<T>(iso: string, fn: () => T): T {
  t.setNow(iso);
  const out = fn();
  t.setNow('2026-11-15T03:00:00.000Z');
  return out;
}

test('work is bucketed by local day, counted for each linked project, and unlinked work is kept apart', () => {
  const p = t.user('create_project', { title: '采集' }).id;
  const q = t.user('create_project', { title: '合并' }).id;
  t.user('link_session', { session: A, project: p });
  t.user('link_session', { session: A, project: q });
  t.user('link_session', { session: B, project: q });
  // UTC-5: 2026-11-14 23:30 local is 04:30Z on the 15th; 2026-11-15 01:00 local is 06:00Z, after "now" (03:00Z = 22:00 local on the 14th).
  chunk(A, '2026-11-14T02:00:00.000Z'); // 13th local (21:00)
  chunk(A, '2026-11-14T20:00:00.000Z'); // 14th local
  chunk(B, '2026-11-14T21:00:00.000Z'); // 14th local
  chunk(C, '2026-11-14T22:00:00.000Z'); // 14th local, no project
  chunk(C, '2026-11-14T22:30:00.000Z', 'screen'); // screens are not counted
  chunk(A, '2026-11-01T00:00:00.000Z'); // before the period
  const v = getActivity(t.db, new Date('2026-11-15T03:00:00.000Z'), { days: 3, tzOffsetMinutes: 300 });
  expect(v.days).toEqual(['2026-11-12', '2026-11-13', '2026-11-14']);
  expect(v.total_daily).toEqual([0, 1, 3]);
  expect(v.unlinked_daily).toEqual([0, 0, 1]);
  const by = Object.fromEntries(v.projects.map((x) => [x.title, x]));
  expect(by['采集']!.daily).toEqual([0, 1, 1]);
  expect(by['合并']!.daily).toEqual([0, 1, 2]);
  expect(by['合并']!.totals).toMatchObject({ chunks: 3, sessions: 2 });
  expect(v.machines).toEqual([{ machine: 'gx10', daily: [0, 0, 2] }, { machine: 'mini', daily: [0, 1, 1] }]);
});

test('milestones of the period come from the event log, newest first, and undone events are left out', () => {
  const p = at('2026-11-13T10:00:00.000Z', () => t.user('create_project', { title: '采集', stage: 'build' }).id);
  at('2026-11-13T11:00:00.000Z', () => t.ai('record_decision', { project: p, text: '只读对账' }));
  const todo = at('2026-11-13T12:00:00.000Z', () => t.user('upsert_todo', { project: p, title: '补读尾部' }).id);
  at('2026-11-14T09:00:00.000Z', () => t.user('upsert_todo', { project: p, id: todo, status: 'done' }));
  const blocker = at('2026-11-14T09:30:00.000Z', () => t.user('set_blocker', { project: p, text: 'SSH 被拒' }).id);
  at('2026-11-14T10:00:00.000Z', () => t.user('clear_blocker', { project: p, id: blocker }));
  at('2026-11-14T11:00:00.000Z', () => t.user('transition_stage', { project: p, stage: 'verify' }));
  const undone = at('2026-11-14T12:00:00.000Z', () => t.user('record_decision', { project: p, text: '后来撤销的决定' }));
  at('2026-11-14T12:30:00.000Z', () => t.user('revert_event', { event_id: undone.event_id }));

  const v = getActivity(t.db, new Date('2026-11-15T03:00:00.000Z'), { days: 3, tzOffsetMinutes: 0 });
  expect(v.items.map((i) => [i.kind, i.text, v.days[i.day]])).toEqual([
    ['stage', '构建 → 验证', '2026-11-14'],
    ['blocker_cleared', 'SSH 被拒', '2026-11-14'],
    ['blocker_set', 'SSH 被拒', '2026-11-14'],
    ['todo_done', '补读尾部', '2026-11-14'],
    ['decision', '只读对账', '2026-11-13'],
    ['project_created', '采集', '2026-11-13'],
  ]);
  const project = v.projects.find((x) => x.id === p)!;
  expect(project.totals).toMatchObject({ decisions: 1, done: 1, stage_changes: 1, blockers_opened: 1, blockers_cleared: 1 });
  expect(project.marks[v.days.indexOf('2026-11-14')]).toMatchObject({ todo_done: 1, stage: 1 });
  expect(v.items.find((i) => i.kind === 'decision')!.actor).toBe('ai:curator');
});

test('one project only, when asked', () => {
  const p = t.user('create_project', { title: '采集' }).id;
  const q = t.user('create_project', { title: '别的' }).id;
  t.user('link_session', { session: A, project: p });
  t.user('link_session', { session: B, project: q });
  chunk(A, '2026-11-15T01:00:00.000Z');
  chunk(B, '2026-11-15T01:00:00.000Z');
  const v = getActivity(t.db, new Date('2026-11-15T03:00:00.000Z'), { days: 1, tzOffsetMinutes: 0, project: p });
  expect(v.projects.map((x) => x.id)).toEqual([p]);
  expect(v.total_daily).toEqual([1]);
  expect(v.items.every((i) => i.project_id === p)).toBe(true);
});
