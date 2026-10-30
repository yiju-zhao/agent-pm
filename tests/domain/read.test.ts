import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  DORMANT_AFTER_DAYS,
  EVENTS_IN_DETAIL,
  getProject,
  listProjects,
  listQuestions,
} from '../../src/domain/read.ts';
import type { ProjectCard, ProjectDetail } from '../../src/domain/read.ts';
import { askUser } from '../../src/domain/questions.ts';
import { NOW, setup } from './helpers.ts';
import type { Setup } from './helpers.ts';

let t: Setup;

beforeEach(() => {
  t = setup();
});

afterEach(() => {
  t.db.close();
});

const DAY_MS = 86_400_000;

/** An ISO instant `days` days from NOW (negative: before). */
function at(days: number): string {
  return new Date(Date.parse(NOW) + days * DAY_MS).toISOString();
}

function now(): Date {
  return new Date(NOW);
}

function cards(filter: { stage?: ProjectCard['stage']; priority?: NonNullable<ProjectCard['priority']> } = {}, when = now()) {
  return listProjects(t.db, when, filter);
}

function card(id: string, when = now()): ProjectCard {
  const found = cards({}, when).find((c) => c.id === id);
  if (!found) throw new Error(`no card for ${id}`);
  return found;
}

function detail(id: string, when = now()): ProjectDetail {
  const found = getProject(t.db, when, id);
  if (!found) throw new Error(`no detail for ${id}`);
  return found;
}

const titles = (list: Array<{ title: string }>): string[] => list.map((c) => c.title);

/** Sessions whose machine `laptop` reported a heartbeat at NOW show as live; `desk` never reported, so shows offline. */
function addSession(key: string, extra: { machine?: 'laptop' | 'desk'; lifecycle?: string; ignored?: number } = {}): void {
  t.db
    .prepare(
      `INSERT OR IGNORE INTO machines (label, last_heartbeat, collector_version) VALUES ('laptop', ?, 'test')`,
    )
    .run(NOW);
  t.db
    .prepare(
      `INSERT INTO sessions (key, agent_kind, machine, terminal_id, title, lifecycle, live_status, ignored, first_seen, last_seen)
       VALUES (?, ?, ?, 'term_1', ?, ?, 'working', ?, ?, ?)`,
    )
    .run(
      key,
      key.slice(0, key.indexOf(':')),
      extra.machine ?? 'laptop',
      `title of ${key}`,
      extra.lifecycle ?? 'live',
      extra.ignored ?? 0,
      NOW,
      NOW,
    );
}

function link(session: string, project: string, extra: { ts_end?: string; milestone_id?: string } = {}): string {
  const r = t.user('link_session', { session, project, ...extra });
  expect(r.status).toBe('applied');
  return r.id;
}

/** An AI confirm (or text) question about `project_id` (a fresh project when omitted); returns its id. */
function ask(topic: string, extra: { project_id?: string; kind?: 'confirm' | 'text' } = {}): string {
  const project = extra.project_id ?? t.user('create_project', { title: `for ${topic}` }).id;
  const r =
    extra.kind === 'text'
      ? askUser(
          t.db,
          t.deps,
          {
            kind: 'text',
            prompt: `补充 ${topic}`,
            project_id: project,
            topic,
            option: { label: '写完成标准', op: 'update_project', args: { project, fields: {} }, text_arg: 'fields.done_criteria' },
            evidence: ['chunk:1'],
          },
          'ai:curator',
        )
      : askUser(
          t.db,
          t.deps,
          {
            kind: 'confirm',
            prompt: `确认 ${topic}`,
            project_id: project,
            topic,
            option: { label: '确认', op: 'update_project', args: { project, fields: { summary: topic } } },
            evidence: ['chunk:1', 'digest:2'],
          },
          'ai:curator',
        );
  if (r.status !== 'proposed') throw new Error(`ask failed: ${JSON.stringify(r)}`);
  return r.question_ids[0];
}

// ---- cards -------------------------------------------------------------------------------------------------------

test('cards sort by priority with closed projects last', () => {
  t.setNow(at(-5));
  t.user('create_project', { title: 'old P1', priority: 'P1' });
  t.user('create_project', { title: 'none', stage: 'build' });
  t.setNow(at(-4));
  t.user('create_project', { title: 'new P1', priority: 'P1', stage: 'build' });
  t.user('create_project', { title: 'P2', priority: 'P2', stage: 'explore' });
  t.user('create_project', { title: 'P0', priority: 'P0' });
  t.user('create_project', { title: 'done P0', priority: 'P0', stage: 'done' });
  t.user('create_project', { title: 'abandoned P1', priority: 'P1', stage: 'abandoned' });
  t.user('create_project', { title: 'parked P3', priority: 'P3', stage: 'parked' });

  expect(titles(cards())).toEqual([
    'P0',
    'new P1', // ties on priority: the more recently active first
    'old P1',
    'P2',
    'parked P3', // parked is not closed
    'none',
    'done P0', // closed projects last, among themselves by priority
    'abandoned P1',
  ]);
});

test('listProjects filters by stage and priority', () => {
  t.user('create_project', { title: 'a', priority: 'P0', stage: 'build' });
  t.user('create_project', { title: 'b', priority: 'P1', stage: 'build' });
  t.user('create_project', { title: 'c', priority: 'P0', stage: 'explore' });

  expect(titles(cards({ stage: 'build' })).sort()).toEqual(['a', 'b']);
  expect(titles(cards({ priority: 'P0' })).sort()).toEqual(['a', 'c']);
  expect(titles(cards({ stage: 'build', priority: 'P0' }))).toEqual(['a']);
  expect(cards({ stage: 'done' })).toEqual([]);
});

test('a card carries the project fields, parsed locks and the closed flag', () => {
  const p = t.user('create_project', {
    title: '标题',
    summary: '摘要',
    why: '原因',
    done_criteria: '完成标准',
    priority: 'P2',
  }).id;
  const c = card(p);

  expect(c).toMatchObject({
    id: p,
    title: '标题',
    stage: 'idea',
    priority: 'P2',
    summary: '摘要',
    why: '原因',
    done_criteria: '完成标准',
    merged_into: null,
    created_by: 'user',
    created_at: NOW,
    closed: false,
  });
  expect(c.locks).toEqual(['done_criteria', 'priority', 'summary', 'title', 'why']);
  expect(Object.keys(c)).not.toContain('user_touched');
  expect(Object.keys(c)).not.toContain('deleted_at');
});

test('closed is true for done, abandoned and merged projects, and merged_into is shown', () => {
  const done = t.user('create_project', { title: 'done', stage: 'done' }).id;
  const gone = t.user('create_project', { title: 'gone', stage: 'abandoned' }).id;
  const target = t.user('create_project', { title: 'target' }).id;
  const merged = t.user('create_project', { title: 'merged' }).id;
  expect(t.user('transition_stage', { project: merged, stage: 'merged', merge_into: target }).status).toBe('applied');

  expect(card(done).closed).toBe(true);
  expect(card(gone).closed).toBe(true);
  expect(card(merged)).toMatchObject({ closed: true, stage: 'merged', merged_into: target });
  expect(card(target).closed).toBe(false);
});

test('an ai-created idea stays in the inbox until the user sets priority or moves the stage', () => {
  const p = t.ai('create_project', { title: '新想法' }).id;
  expect(card(p).inbox).toBe(true);
  t.user('update_project', { project: p, fields: { priority: 'P1' } });
  expect(card(p).inbox).toBe(false);

  const q = t.ai('create_project', { title: '另一个' }).id;
  expect(card(q).inbox).toBe(true);
  t.user('transition_stage', { project: q, stage: 'explore' });
  expect(card(q).inbox).toBe(false);
});

test('an idea is not in the inbox when the user made it, or once it is past idea', () => {
  const mine = t.user('create_project', { title: '我的想法' }).id;
  expect(card(mine).inbox).toBe(false);

  const forward = t.ai('create_project', { title: 'ai' }).id;
  expect(t.ai('transition_stage', { project: forward, stage: 'explore' }).status).toBe('applied');
  expect(card(forward)).toMatchObject({ stage: 'explore', inbox: false });
});

// ---- milestones, todos, blockers on the card ---------------------------------------------------------------------

test('milestones_progress counts live milestones and current_milestone is the first doing, else the first todo', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  expect(card(p)).toMatchObject({ milestones_progress: { done: 0, doing: 0, todo: 0 }, current_milestone: null });

  t.user('upsert_milestone', { project: p, title: 'one', status: 'done' });
  const m2 = t.user('upsert_milestone', { project: p, title: 'two', status: 'todo' }).id;
  const m3 = t.user('upsert_milestone', { project: p, title: 'three', status: 'doing' }).id;
  const m4 = t.user('upsert_milestone', { project: p, title: 'four', status: 'doing' }).id;
  const gone = t.user('upsert_milestone', { project: p, title: 'gone', status: 'doing', position: 0 }).id;

  // The doing milestone at position 0 is deleted: it counts for nothing.
  t.user('delete_milestone', { project: p, id: gone });
  expect(card(p).milestones_progress).toEqual({ done: 1, doing: 2, todo: 1 });
  expect(card(p).current_milestone).toEqual({ id: m3, title: 'three', status: 'doing' });

  // No doing milestone left: the first todo by position.
  t.user('upsert_milestone', { project: p, id: m3, status: 'done' });
  t.user('upsert_milestone', { project: p, id: m4, status: 'done' });
  expect(card(p).current_milestone).toEqual({ id: m2, title: 'two', status: 'todo' });

  t.user('upsert_milestone', { project: p, id: m2, status: 'done' });
  expect(card(p).current_milestone).toBeNull();
});

test('open_todos skips done and deleted todos; doing first, then priority P0 to none, then oldest first', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  let day = 0;
  const add = (title: string, extra: { status?: 'todo' | 'doing' | 'done'; priority?: 'P0' | 'P1' | 'P2' | 'P3' | null }) => {
    t.setNow(at(day++));
    return t.user('upsert_todo', { project: p, title, ...extra }).id;
  };

  add('todo none early', {});
  add('todo P1', { priority: 'P1' });
  add('doing P3', { status: 'doing', priority: 'P3' });
  add('todo P0', { priority: 'P0' });
  add('done P0', { status: 'done', priority: 'P0' });
  add('doing P1', { status: 'doing', priority: 'P1' });
  add('todo P1 later', { priority: 'P1' });
  const removed = add('removed', { priority: 'P0' });
  add('todo none late', {});
  t.user('delete_todo', { project: p, id: removed });

  expect(titles(card(p).open_todos)).toEqual([
    'doing P1',
    'doing P3',
    'todo P0',
    'todo P1',
    'todo P1 later',
    'todo none early',
    'todo none late',
  ]);
});

test('todo and milestone rows have their locks parsed to arrays', () => {
  const p = t.user('create_project', { title: 'p' }).id;
  t.user('upsert_todo', { project: p, title: 'locked', priority: 'P1' });
  const todo = card(p).open_todos[0];
  expect(todo.locks).toEqual(['priority', 'title']);
  expect(todo).toMatchObject({ id: 't_1', project_id: p, title: 'locked', status: 'todo', priority: 'P1', milestone_id: null });
});

test('open_blockers lists blockers that are not cleared or deleted', () => {
  const p = t.user('create_project', { title: 'p' }).id;
  const open = t.user('set_blocker', { project: p, text: '等密钥', kind: 'external' }).id;
  const cleared = t.user('set_blocker', { project: p, text: '已解决' }).id;
  const removed = t.user('set_blocker', { project: p, text: '删掉的' }).id;
  t.user('clear_blocker', { project: p, id: cleared });
  t.user('delete_blocker', { project: p, id: removed });

  const c = card(p);
  expect(c.open_blockers.map((b) => b.id)).toEqual([open]);
  expect(c.open_blockers[0]).toMatchObject({ text: '等密钥', kind: 'external', status: 'open', cleared_at: null });
  expect(detail(p).blockers.map((b) => b.id).sort()).toEqual([open, cleared].sort());
});

// ---- sessions and activity ---------------------------------------------------------------------------------------

test('active_sessions shows live and offline linked sessions with short ids, not ended or ignored ones', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  addSession('claude:live1111aaaabbbb');
  addSession('codex:off22222ccccdddd', { machine: 'desk' });
  addSession('claude:end33333eeeeffff', { lifecycle: 'ended' });
  addSession('claude:purge444gggghhhh', { lifecycle: 'purged' });
  addSession('claude:ignor555iiiijjjj', { ignored: 1 });
  addSession('claude:unlinked66kkkkllll');
  for (const key of [
    'claude:live1111aaaabbbb',
    'codex:off22222ccccdddd',
    'claude:end33333eeeeffff',
    'claude:purge444gggghhhh',
    'claude:ignor555iiiijjjj',
  ]) {
    link(key, p);
  }

  const active = card(p).active_sessions;
  expect(active.map((s) => s.key).sort()).toEqual(['claude:live1111aaaabbbb', 'codex:off22222ccccdddd']);
  const live = active.find((s) => s.key === 'claude:live1111aaaabbbb');
  const offline = active.find((s) => s.key === 'codex:off22222ccccdddd');
  expect(live).toEqual({
    key: 'claude:live1111aaaabbbb',
    short_id: 'live1111',
    machine: 'laptop',
    agent_kind: 'claude',
    effective_status: 'working',
    title: 'title of claude:live1111aaaabbbb',
    milestone_id: null,
  });
  expect(offline).toMatchObject({ short_id: 'off22222', machine: 'desk', agent_kind: 'codex', effective_status: 'offline' });
});

test('an unlinked session no longer counts as active', () => {
  const p = t.user('create_project', { title: 'p' }).id;
  addSession('claude:live1111aaaabbbb');
  link('claude:live1111aaaabbbb', p);
  expect(card(p).active_sessions).toHaveLength(1);

  t.user('unlink_session', { session: 'claude:live1111aaaabbbb', project: p });
  expect(card(p).active_sessions).toEqual([]);
});

test('an active session tag carries the milestone of its link', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  const m = t.user('upsert_milestone', { project: p, title: 'm' }).id;
  addSession('claude:live1111aaaabbbb');
  link('claude:live1111aaaabbbb', p, { milestone_id: m });

  expect(card(p).active_sessions[0].milestone_id).toBe(m);
});

test('last_activity_at is the later of creation and the newest linked ts_end, ignoring deleted links', () => {
  t.setNow(at(-30));
  const p = t.user('create_project', { title: 'p' }).id;
  expect(card(p).last_activity_at).toBe(at(-30));

  addSession('claude:aaaa1111xxxx', { lifecycle: 'ended' });
  addSession('claude:bbbb2222yyyy', { lifecycle: 'ended' });
  addSession('claude:cccc3333zzzz', { lifecycle: 'ended' });
  link('claude:aaaa1111xxxx', p, { ts_end: at(-20) });
  link('claude:bbbb2222yyyy', p, { ts_end: at(-10) });
  link('claude:cccc3333zzzz', p, { ts_end: at(-2) });
  expect(card(p).last_activity_at).toBe(at(-2));

  t.user('unlink_session', { session: 'claude:cccc3333zzzz', project: p });
  expect(card(p).last_activity_at).toBe(at(-10));

  t.user('unlink_session', { session: 'claude:bbbb2222yyyy', project: p });
  expect(card(p).last_activity_at).toBe(at(-20));

  // With no live link left, and for a link that ended before the project existed, creation is the floor.
  t.user('unlink_session', { session: 'claude:aaaa1111xxxx', project: p });
  addSession('claude:dddd4444wwww', { lifecycle: 'ended' });
  link('claude:dddd4444wwww', p, { ts_end: at(-40) });
  expect(card(p).last_activity_at).toBe(at(-30));
});

test('dormant_days appears after 7 days without activity and no active session', () => {
  expect(DORMANT_AFTER_DAYS).toBe(7);
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;

  expect(card(p, new Date(at(6.9))).dormant_days).toBeNull();
  expect(card(p, new Date(at(7))).dormant_days).toBe(7);
  expect(card(p, new Date(at(9.5))).dormant_days).toBe(9);
  expect(card(p, new Date(at(-1))).dormant_days).toBeNull(); // a clock behind the data is not dormancy

  // Recent session activity resets the clock.
  addSession('claude:aaaa1111xxxx', { lifecycle: 'ended' });
  link('claude:aaaa1111xxxx', p, { ts_end: at(5) });
  expect(card(p, new Date(at(9.5))).dormant_days).toBeNull();
  expect(card(p, new Date(at(12))).dormant_days).toBe(7);
});

test('a live or offline linked session keeps a project from going dormant', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  addSession('claude:aaaa1111xxxx');
  link('claude:aaaa1111xxxx', p);
  const later = new Date(at(30));
  // laptop's heartbeat is 30 days old by then, so the session reads as offline, which still counts as active.
  expect(card(p, later).active_sessions[0].effective_status).toBe('offline');
  expect(card(p, later).dormant_days).toBeNull();

  // An ignored session does not.
  t.db.prepare("UPDATE sessions SET ignored = 1 WHERE key = 'claude:aaaa1111xxxx'").run();
  expect(card(p, later).dormant_days).toBe(30);
});

// ---- questions on the card ---------------------------------------------------------------------------------------

test('pending_questions lists only the project\'s pending questions, newest first', () => {
  const a = t.user('create_project', { title: 'a' }).id;
  const b = t.user('create_project', { title: 'b' }).id;

  t.setNow(at(0));
  const first = ask('one', { project_id: a });
  t.setNow(at(1));
  const second = ask('two', { project_id: a });
  ask('other', { project_id: b });
  t.db.prepare("UPDATE questions SET status = 'answered' WHERE id = ?").run(first);
  t.setNow(at(2));
  const third = ask('three', { project_id: a });

  expect(card(a, new Date(at(2))).pending_questions.map((q) => q.id)).toEqual([third, second]);
  expect(card(b, new Date(at(2))).pending_questions).toHaveLength(1);
});

test('a card does not show a pending question that is past its time limit', () => {
  const p = t.user('create_project', { title: 'p' }).id;
  ask('old', { project_id: p });
  expect(card(p, new Date(at(29))).pending_questions).toHaveLength(1);
  expect(card(p, new Date(at(31))).pending_questions).toEqual([]);
});

// ---- detail ------------------------------------------------------------------------------------------------------

test('detail lists events newest first, tombstones, and contributions with their session', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  addSession('claude:live1111aaaabbbb');
  addSession('codex:off22222ccccdddd', { machine: 'desk' });
  addSession('claude:gone3333eeeeffff', { lifecycle: 'ended' });

  const m = t.user('upsert_milestone', { project: p, title: '里程碑' }).id;
  const todoVeto = t.user('upsert_todo', { project: p, title: '用户删掉的 todo' }).id;
  const decision = t.user('record_decision', { project: p, text: '决定用 SQLite' }).id;
  const blockerVeto = t.user('set_blocker', { project: p, text: '用户删掉的阻塞' }).id;
  const aiTodo = t.ai('upsert_todo', { project: p, title: 'AI 的 todo' }).id;
  link('claude:live1111aaaabbbb', p, { ts_end: at(-1), milestone_id: m });
  link('codex:off22222ccccdddd', p, { ts_end: at(-3) });
  link('claude:gone3333eeeeffff', p);
  t.user('unlink_session', { session: 'claude:gone3333eeeeffff', project: p });

  t.setNow(at(1));
  t.user('delete_todo', { project: p, id: todoVeto });
  t.setNow(at(2));
  t.user('delete_blocker', { project: p, id: blockerVeto });
  // An AI deleting its own item leaves no tombstone worth keeping.
  t.ai('delete_todo', { project: p, id: aiTodo });

  const d = detail(p);
  expect(d.id).toBe(p);
  expect(d.milestones.map((x) => x.id)).toEqual([m]);
  expect(d.todos.map((x) => x.id)).toEqual([]);
  expect(d.decisions.map((x) => ({ id: x.id, text: x.text, evidence: x.evidence }))).toEqual([
    { id: decision, text: '决定用 SQLite', evidence: [] },
  ]);
  expect(d.blockers).toEqual([]);

  // Events: newest first, only this project's.
  const ops = d.events.map((e) => e.op);
  expect(ops).toEqual([
    'delete_todo', // the AI's own
    'delete_blocker',
    'delete_todo',
    'unlink_session',
    'link_session',
    'link_session',
    'link_session',
    'upsert_todo',
    'set_blocker',
    'record_decision',
    'upsert_todo',
    'upsert_milestone',
    'create_project',
  ]);
  const ids = d.events.map((e) => e.id);
  expect(ids).toEqual([...ids].sort((a, b) => b - a));

  // Tombstones: the user's vetoes only, newest first; the unlinked session's label is its key.
  expect(d.tombstones).toEqual([
    { table: 'blockers', id: blockerVeto, label: '用户删掉的阻塞', deleted_at: at(2) },
    { table: 'todos', id: todoVeto, label: '用户删掉的 todo', deleted_at: at(1) },
    { table: 'contributions', id: 'c_3', label: 'claude:gone3333eeeeffff', deleted_at: NOW },
  ]);

  // Contributions: live links only, newest ts_end first, each with its session tag.
  expect(d.contributions.map((c) => c.session_key)).toEqual(['claude:live1111aaaabbbb', 'codex:off22222ccccdddd']);
  expect(d.contributions[0]).toMatchObject({
    id: 'c_1',
    project_id: p,
    milestone_id: m,
    ts_end: at(-1),
    actor: 'user',
    session: { key: 'claude:live1111aaaabbbb', short_id: 'live1111', milestone_id: m, effective_status: 'working' },
  });
  expect(d.contributions[1].session).toMatchObject({ key: 'codex:off22222ccccdddd', effective_status: 'offline' });
});

test('detail contributions include ended and ignored sessions, and a link to an unknown session has session null', () => {
  const p = t.user('create_project', { title: 'p' }).id;
  addSession('claude:end33333eeeeffff', { lifecycle: 'ended' });
  addSession('claude:ignor555iiiijjjj', { ignored: 1 });
  link('claude:end33333eeeeffff', p, { ts_end: at(-2) });
  link('claude:ignor555iiiijjjj', p, { ts_end: at(-1) });
  // A link whose session row has since been removed.
  t.db
    .prepare(
      `INSERT INTO contributions (id, session_key, project_id, actor, created_at) VALUES ('c_x', 'claude:nosuchsession', ?, 'user', ?)`,
    )
    .run(p, NOW);

  const d = detail(p);
  expect(d.contributions.map((c) => [c.session_key, c.session?.effective_status ?? null])).toEqual([
    ['claude:ignor555iiiijjjj', 'working'],
    ['claude:end33333eeeeffff', 'ended'],
    ['claude:nosuchsession', null],
  ]);
  expect(d.active_sessions.map((s) => s.key)).toEqual([]);
});

test('a contribution on a deleted milestone is shown without a milestone', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  const keep = t.user('upsert_milestone', { project: p, title: 'keep' }).id;
  const drop = t.user('upsert_milestone', { project: p, title: 'drop' }).id;
  addSession('claude:aaaa1111xxxx');
  addSession('claude:bbbb2222yyyy');
  link('claude:aaaa1111xxxx', p, { milestone_id: keep, ts_end: at(-1) });
  link('claude:bbbb2222yyyy', p, { milestone_id: drop, ts_end: at(-2) });
  t.user('delete_milestone', { project: p, id: drop });
  // The contribution row itself still points at the deleted milestone.
  const raw = t.db.prepare("SELECT milestone_id FROM contributions WHERE session_key = 'claude:bbbb2222yyyy'").get() as {
    milestone_id: string;
  };
  expect(raw.milestone_id).toBe(drop);

  const d = detail(p);
  expect(d.contributions.map((c) => c.milestone_id)).toEqual([keep, null]);
  expect(d.contributions.map((c) => c.session?.milestone_id)).toEqual([keep, null]);
  expect(Object.fromEntries(d.active_sessions.map((s) => [s.key, s.milestone_id]))).toEqual({
    'claude:aaaa1111xxxx': keep,
    'claude:bbbb2222yyyy': null,
  });
  // The milestone is a tombstone only if the user vetoed it; here the user deleted it.
  expect(d.tombstones.map((x) => [x.table, x.label])).toEqual([['milestones', 'drop']]);
});

test('tombstones label every item type and never include other projects\' vetoes', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  const other = t.user('create_project', { title: 'other', stage: 'build' }).id;
  addSession('claude:aaaa1111xxxx');
  addSession('claude:bbbb2222yyyy');

  const m = t.user('upsert_milestone', { project: p, title: 'M' }).id;
  const todo = t.user('upsert_todo', { project: p, title: 'T' }).id;
  const dec = t.user('record_decision', { project: p, text: 'D' }).id;
  const blk = t.user('set_blocker', { project: p, text: 'B' }).id;
  t.user('delete_milestone', { project: p, id: m });
  t.user('delete_todo', { project: p, id: todo });
  t.user('delete_decision', { project: p, id: dec });
  t.user('delete_blocker', { project: p, id: blk });
  link('claude:aaaa1111xxxx', p);
  t.user('unlink_session', { session: 'claude:aaaa1111xxxx', project: p });

  const otherTodo = t.user('upsert_todo', { project: other, title: 'elsewhere' }).id;
  t.user('delete_todo', { project: other, id: otherTodo });
  link('claude:bbbb2222yyyy', other);
  t.user('unlink_session', { session: 'claude:bbbb2222yyyy', project: other });

  const labels = detail(p)
    .tombstones.map((x) => `${x.table}:${x.label}`)
    .sort();
  expect(labels).toEqual([
    'blockers:B',
    'contributions:claude:aaaa1111xxxx',
    'decisions:D',
    'milestones:M',
    'todos:T',
  ]);
  expect(detail(other).tombstones.map((x) => x.label).sort()).toEqual(['claude:bbbb2222yyyy', 'elsewhere']);
});

test('a re-linked session is live again and no longer a tombstone', () => {
  const p = t.user('create_project', { title: 'p' }).id;
  addSession('claude:aaaa1111xxxx');
  link('claude:aaaa1111xxxx', p);
  t.user('unlink_session', { session: 'claude:aaaa1111xxxx', project: p });
  expect(detail(p).tombstones).toHaveLength(1);

  link('claude:aaaa1111xxxx', p);
  const d = detail(p);
  expect(d.tombstones).toEqual([]);
  expect(d.contributions).toHaveLength(1);
});

test('events parse their JSON columns and carry revert and veto links', () => {
  const p = t.ai('create_project', { title: 'ai idea' }, { reason: '看到的', evidence: ['chunk:9#L3'] }).id;
  const edit = t.ai('update_project', { project: p, fields: { summary: 'AI 写的' } }, { reason: '补摘要', evidence: ['digest:5'] });
  const undo = t.user('revert_event', { event_id: edit.event_id });
  expect(undo.status).toBe('applied');

  const events = detail(p).events;
  const [revert, edited, created] = events;

  expect(created).toMatchObject({
    op: 'create_project',
    actor: 'ai:curator',
    reason: '看到的',
    evidence: ['chunk:9#L3'],
    question_id: null,
    reverts: null,
    is_veto: false,
  });
  expect(created.args).toEqual({ title: 'ai idea' });
  expect(created.entity).toBe(`projects:${p}`);
  expect(created.after).toMatchObject({ [`projects:${p}`]: { title: 'ai idea' } });
  expect(created.before).toEqual({ [`projects:${p}`]: null });
  expect(typeof created.occurred_at).toBe('string');
  expect(typeof created.recorded_at).toBe('string');

  expect(edited).toMatchObject({ op: 'update_project', evidence: ['digest:5'], reverted_by: revert.id, is_veto: false });
  expect(edited.before).toEqual({ [`projects:${p}`]: { summary: null } });
  expect(edited.after).toEqual({ [`projects:${p}`]: { summary: 'AI 写的' } });

  expect(revert).toMatchObject({ op: 'revert_event', actor: 'user', reverts: edited.id, reverted_by: null, is_veto: true });
});

test('detail events are capped at EVENTS_IN_DETAIL, newest kept', () => {
  expect(EVENTS_IN_DETAIL).toBe(200);
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  const todo = t.user('upsert_todo', { project: p, title: 'busy' }).id;
  for (let i = 0; i < EVENTS_IN_DETAIL + 5; i++) {
    t.user('upsert_todo', { project: p, id: todo, title: `rev ${i}` });
  }

  const events = detail(p).events;
  expect(events).toHaveLength(EVENTS_IN_DETAIL);
  expect(events[0].after).toEqual({ [`todos:${todo}`]: { title: `rev ${EVENTS_IN_DETAIL + 4}` } });
  // The oldest events (create_project, the first upsert_todo) fell off the end.
  expect(events.some((e) => e.op === 'create_project')).toBe(false);
});

test('detail has everything a card has', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build', priority: 'P1' }).id;
  t.user('upsert_milestone', { project: p, title: 'm', status: 'doing' });
  t.user('upsert_todo', { project: p, title: 't' });
  expect(detail(p)).toMatchObject(card(p));
});

test('deleted projects are absent from the list and getProject returns null', () => {
  const keep = t.user('create_project', { title: 'keep' }).id;
  const drop = t.user('create_project', { title: 'drop' }).id;
  t.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(NOW, drop);

  expect(cards().map((c) => c.id)).toEqual([keep]);
  expect(getProject(t.db, now(), drop)).toBeNull();
  expect(getProject(t.db, now(), 'p_nope')).toBeNull();
  expect(getProject(t.db, now(), keep)).not.toBeNull();
});

test('read models write nothing', () => {
  const p = t.user('create_project', { title: 'p', stage: 'build' }).id;
  addSession('claude:aaaa1111xxxx');
  link('claude:aaaa1111xxxx', p);
  const snapshot = () => JSON.stringify(['projects', 'todos', 'contributions', 'events', 'questions', 'sessions'].map((table) => t.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  cards();
  detail(p);
  expect(snapshot()).toBe(before);
});

// ---- questions ---------------------------------------------------------------------------------------------------

test('question views hide the bound ops', () => {
  ask('one');
  const views = listQuestions(t.db, t.deps, {});

  expect(views[0].options[0]).toEqual({ label: '确认', has_op: true });
  expect(views[0].options[1]).toEqual({ label: '拒绝', has_op: false });
  expect(JSON.stringify(views)).not.toContain('update_project');
  expect(JSON.stringify(views)).not.toContain('"args"');
  expect(JSON.stringify(views)).not.toContain('"op"');
});

test('a text question shows the text_arg path so the page knows to render an input', () => {
  ask('two', { kind: 'text' });
  const [view] = listQuestions(t.db, t.deps, {});
  expect(view.kind).toBe('text');
  expect(view.options).toEqual([{ label: '写完成标准', has_op: true, text_arg: 'fields.done_criteria' }]);
});

test('a question view has the fields in the brief and nothing internal', () => {
  const project = t.user('create_project', { title: 'p' }).id;
  const id = ask('three', { project_id: project });
  const [view] = listQuestions(t.db, t.deps, {});

  expect(view).toEqual({
    id,
    kind: 'confirm',
    prompt: '确认 three',
    options: [
      { label: '确认', has_op: true },
      { label: '拒绝', has_op: false },
    ],
    project_id: project,
    session_key: null,
    status: 'pending',
    evidence: ['chunk:1', 'digest:2'],
    created_by: 'ai:curator',
    created_at: NOW,
    resolution_note: null,
  });
});

test('listQuestions filters by status and project, newest first', () => {
  const a = t.user('create_project', { title: 'a' }).id;
  const b = t.user('create_project', { title: 'b' }).id;
  t.setNow(at(0));
  const q1 = ask('one', { project_id: a });
  t.setNow(at(1));
  const q2 = ask('two', { project_id: b });
  t.setNow(at(2));
  const q3 = ask('three', { project_id: a });
  t.db.prepare("UPDATE questions SET status = 'withdrawn', resolution_note = 'stale' WHERE id = ?").run(q2);

  expect(listQuestions(t.db, t.deps, {}).map((q) => q.id)).toEqual([q3, q2, q1]);
  expect(listQuestions(t.db, t.deps, { status: 'pending' }).map((q) => q.id)).toEqual([q3, q1]);
  expect(listQuestions(t.db, t.deps, { project_id: a }).map((q) => q.id)).toEqual([q3, q1]);
  expect(listQuestions(t.db, t.deps, { project_id: a, status: 'withdrawn' })).toEqual([]);
  const withdrawn = listQuestions(t.db, t.deps, { status: 'withdrawn' });
  expect(withdrawn.map((q) => [q.id, q.resolution_note])).toEqual([[q2, 'stale']]);
});

test('listQuestions expires questions past their time limit before listing', () => {
  const q = ask('old');
  t.setNow(at(31));

  expect(listQuestions(t.db, t.deps, { status: 'pending' })).toEqual([]);
  expect(listQuestions(t.db, t.deps, { status: 'expired' }).map((v) => v.id)).toEqual([q]);
  expect(t.db.prepare('SELECT status FROM questions WHERE id = ?').get(q)).toEqual({ status: 'expired' });
});
