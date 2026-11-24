import { afterEach, beforeEach, expect, test } from 'vitest';
import { listReminders, snoozeReminder } from '../../src/domain/reminders.ts';
import { setup } from './helpers.ts';
import type { Setup } from './helpers.ts';

let t: Setup;
const NOW = '2026-11-16T12:00:00.000Z';
const S = 'claude:aaaa1111';
let p: string;

beforeEach(() => {
  t = setup();
  t.setNow(NOW);
  t.db.prepare("INSERT INTO ingest_sources (source_id, kind, machine, collector_heartbeat) VALUES ('herdr:mini', 'herdr', 'mini', ?)").run(NOW);
  t.db.prepare(`INSERT INTO sessions (key, agent_kind, machine, cwd, title, live_status, lifecycle, ignored, first_seen, last_seen, status_changed_at) VALUES (?, 'claude', 'mini', '/w/agent-pm', '打磨采集', 'idle', 'live', 0, ?, ?, ?)`).run(S, NOW, NOW, NOW);
  t.db.prepare(`INSERT INTO session_sources (source_id, external_id, session_key, machine, live_status, lifecycle, last_seen, workspace) VALUES ('herdr:mini', ?, ?, 'mini', 'idle', 'live', ?, NULL)`).run(S, S, NOW);
  p = t.user('create_project', { title: 'agent-pm', priority: 'P1' }).id;
  t.user('link_session', { session: S, project: p });
});
afterEach(() => t.db.close());

const keys = () => listReminders(t.db, t.deps.now()).map((r) => [r.category, r.key]);
const workspace = (ahead: number, at: string) =>
  t.db.prepare('UPDATE session_sources SET workspace = ? WHERE session_key = ?').run(JSON.stringify({ root: '/w/agent-pm', branch: 'master', ahead, behind: 0, dirty: 0, recent: [{ sha: 'abc1234', at, subject: 'feat' }], checked_at: NOW }), S);

test('blockers waiting on the user or the world are reminders; technical ones are the agents’ and are not', () => {
  const you = t.ai('set_blocker', { project: p, text: '等你试听成片', kind: 'user' }).id;
  const ext = t.ai('set_blocker', { project: p, text: '等华硕售后', kind: 'external' }).id;
  t.ai('set_blocker', { project: p, text: 'adapter 设计未定', kind: 'technical' });
  expect(keys()).toEqual([['waiting_you', `blocker:${you}`], ['waiting_external', `blocker:${ext}`]]);
  // Resolved by the review (or the user): gone.
  t.ai('clear_blocker', { project: p, id: you });
  expect(keys()).toEqual([['waiting_external', `blocker:${ext}`]]);
});

test('an agent waiting for the user is a reminder only while it waits', () => {
  const status = (s: string) => t.db.prepare('UPDATE session_sources SET live_status = ? WHERE session_key = ?').run(s, S);
  status('blocked');
  expect(listReminders(t.db, t.deps.now())).toMatchObject([{ category: 'agent_waiting', key: `session:${S}`, project_title: 'agent-pm', text: '「打磨采集」在等你操作' }]);
  status('working');
  expect(keys()).toEqual([]);
});

test('commits left unpushed for two hours are a reminder until they are pushed', () => {
  workspace(5, '2026-11-16T11:00:00Z');
  expect(keys()).toEqual([]);
  workspace(5, '2026-11-16T09:00:00Z');
  expect(listReminders(t.db, t.deps.now())).toMatchObject([{ category: 'unpushed', text: 'agent-pm 的 master 有 5 个提交没有推送', project_id: p }]);
  workspace(0, '2026-11-16T09:00:00Z');
  expect(keys()).toEqual([]);
});

test('a P0/P1 project quiet for a week is a reminder to move it on', () => {
  t.db.prepare('DELETE FROM contributions').run();
  t.db.prepare("UPDATE projects SET created_at = '2026-11-01T00:00:00Z' WHERE id = ?").run(p);
  expect(listReminders(t.db, t.deps.now())).toMatchObject([{ category: 'stalled', key: `stalled:${p}`, text: 'P1 项目「agent-pm」已经 15 天没有进展' }]);
});

test('"later" hides a reminder for a while; "not again" until what it says changes', () => {
  const b = t.ai('set_blocker', { project: p, text: '等你试听成片', kind: 'user' }).id;
  expect(snoozeReminder(t.db, t.deps.now(), `blocker:${b}`, 24)).toBe(true);
  expect(keys()).toEqual([]);
  t.setNow('2026-11-17T12:00:01.000Z');
  expect(keys()).toEqual([['waiting_you', `blocker:${b}`]]);
  expect(snoozeReminder(t.db, t.deps.now(), `blocker:${b}`, null)).toBe(true);
  t.setNow('2026-12-30T00:00:00.000Z');
  expect(keys()).toEqual([]);
  t.ai('set_blocker', { project: p, id: b, text: '等你试听第二版成片' });
  expect(keys()).toEqual([['waiting_you', `blocker:${b}`]]);
  expect(snoozeReminder(t.db, t.deps.now(), 'blocker:nope', 1)).toBe(false);
});

test('a configured source warns after an hour, snoozes per outage, and clears on recovery', () => {
  const config = { collectors: { mini: 'test' } };
  const sources = { config, startedAt: new Date(NOW) };
  const reminders = () => listReminders(t.db, t.deps.now(), sources).filter(r => r.category === 'source_offline');
  expect(reminders()).toHaveLength(0);
  t.setNow('2026-11-16T13:01:00.000Z');
  expect(reminders().map(r => r.key)).toEqual(['source:herdr:mini']);
  expect(snoozeReminder(t.db, t.deps.now(), 'source:herdr:mini', null, sources)).toBe(true);
  t.setNow('2026-11-21T12:00:00.000Z');
  expect(reminders()).toHaveLength(0);
  t.db.prepare('UPDATE ingest_sources SET collector_heartbeat=?').run(t.deps.now().toISOString());
  expect(reminders()).toHaveLength(0);
  t.setNow('2026-11-21T13:01:00.000Z');
  expect(reminders()).toHaveLength(1);
  t.db.prepare('UPDATE ingest_sources SET collector_heartbeat=?').run(t.deps.now().toISOString());
  expect(reminders()).toHaveLength(0);
});

test('never-reported sources have a grace period; retired sources stay out of reminders', () => {
  const sources = { config: { collectors: { unused: 'test' } }, startedAt: new Date(NOW) };
  const offline = () => listReminders(t.db, t.deps.now(), sources).filter(r => r.category === 'source_offline');
  expect(offline()).toHaveLength(0);
  t.setNow('2026-11-16T13:01:00.000Z');
  expect(offline().map(r => r.key)).toEqual(['source:herdr:unused']);
  expect(snoozeReminder(t.db, t.deps.now(), 'source:herdr:unused', 24, sources)).toBe(true);
  expect(offline()).toHaveLength(0);
  t.setNow('2026-11-17T13:02:00.000Z');
  expect(offline().map(r => r.key)).toEqual(['source:herdr:unused']);
});
