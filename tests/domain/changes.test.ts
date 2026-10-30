import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { addLocks, appendEvent, ChangeSet, LOCKABLE, netChanges, readLocks, readRow } from '../../src/domain/changes.ts';
import type { Change } from '../../src/domain/changes.ts';
import { openDb } from '../../src/server/db.ts';

let db: DatabaseSync;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

function totalChanges(): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

function seedProject(): ChangeSet {
  const cs = new ChangeSet(db);
  cs.insert('projects', { id: 'p_1', title: 'A', summary: 's' });
  return cs;
}

const baseEvent = {
  occurred_at: '2026-10-29T10:00:00.000Z',
  recorded_at: '2026-10-29T10:00:01.000Z',
  actor: 'user',
  op: 'update_project',
  project_id: 'p_1',
  args: { project: 'p_1' },
  reason: null,
  evidence: [] as string[],
  question_id: null,
};

test('insert records every inserted column with a null before', () => {
  const cs = seedProject();
  expect(cs.changes).toEqual([
    { table: 'projects', id: 'p_1', before: null, after: { id: 'p_1', title: 'A', summary: 's' } },
  ]);
  expect(readRow(db, 'projects', 'p_1')).toMatchObject({ id: 'p_1', title: 'A', summary: 's', locks: '[]', vetoed: 0 });
});

test('insert and update ignore undefined values', () => {
  const cs = new ChangeSet(db);
  cs.insert('projects', { id: 'p_1', title: 'A', summary: undefined });
  expect(cs.changes[0].after).toEqual({ id: 'p_1', title: 'A' });
  expect(cs.update('projects', 'p_1', { title: undefined, why: undefined })).toBe(false);
  expect(cs.changes).toHaveLength(1);
});

test('update records only columns whose value changed', () => {
  const cs = seedProject();
  expect(cs.update('projects', 'p_1', { title: 'B', summary: 's' })).toBe(true);
  expect(cs.changes.at(-1)).toEqual({ table: 'projects', id: 'p_1', before: { title: 'A' }, after: { title: 'B' } });
  expect(readRow(db, 'projects', 'p_1')).toMatchObject({ title: 'B', summary: 's' });
});

test('update can set a column to null and back', () => {
  const cs = seedProject();
  cs.update('projects', 'p_1', { priority: 'P1' });
  const cs2 = new ChangeSet(db);
  expect(cs2.update('projects', 'p_1', { priority: null })).toBe(true);
  expect(cs2.changes).toEqual([{ table: 'projects', id: 'p_1', before: { priority: 'P1' }, after: { priority: null } }]);
  expect(readRow(db, 'projects', 'p_1')?.priority).toBeNull();
});

test('update with no actual change returns false and records nothing', () => {
  const cs = seedProject();
  const before = totalChanges();
  const length = cs.changes.length;
  expect(cs.update('projects', 'p_1', { title: 'A', summary: 's' })).toBe(false);
  expect(cs.changes).toHaveLength(length);
  expect(totalChanges()).toBe(before);
});

test('two updates of one row merge into one change keeping the earliest before', () => {
  const setup = seedProject();
  expect(setup.changes).toHaveLength(1);
  const cs = new ChangeSet(db);
  cs.update('projects', 'p_1', { title: 'B' });
  cs.update('projects', 'p_1', { title: 'C' });
  expect(cs.changes).toEqual([{ table: 'projects', id: 'p_1', before: { title: 'A' }, after: { title: 'C' } }]);
});

test('a later update of another column joins the same change', () => {
  seedProject();
  const cs = new ChangeSet(db);
  cs.update('projects', 'p_1', { title: 'B' });
  cs.update('projects', 'p_1', { summary: 'z', title: 'C' });
  expect(cs.changes).toEqual([
    { table: 'projects', id: 'p_1', before: { title: 'A', summary: 's' }, after: { title: 'C', summary: 'z' } },
  ]);
});

test('an update after an insert in the same change set is its own change; later updates merge into it', () => {
  const cs = seedProject();
  cs.update('projects', 'p_1', { title: 'B' });
  cs.update('projects', 'p_1', { title: 'C' });
  expect(cs.changes).toEqual([
    { table: 'projects', id: 'p_1', before: null, after: { id: 'p_1', title: 'A', summary: 's' } },
    { table: 'projects', id: 'p_1', before: { title: 'A' }, after: { title: 'C' } },
  ]);
});

test('changes to different rows stay separate and keep first-touched order', () => {
  seedProject().insert('milestones', { id: 'm_1', project_id: 'p_1', title: 'M' });
  const cs = new ChangeSet(db);
  cs.update('projects', 'p_1', { title: 'B' });
  cs.update('milestones', 'm_1', { status: 'doing' });
  cs.update('projects', 'p_1', { summary: 'z' });
  expect(cs.changes.map((c) => `${c.table}:${c.id}`)).toEqual(['projects:p_1', 'milestones:m_1']);
  expect(cs.changes[1]).toEqual({ table: 'milestones', id: 'm_1', before: { status: null }, after: { status: 'doing' } });
});

test('update of a missing row or a missing column throws', () => {
  seedProject();
  const cs = new ChangeSet(db);
  expect(() => cs.update('projects', 'p_nope', { title: 'B' })).toThrow(/projects:p_nope/);
  expect(() => cs.update('projects', 'p_1', { no_such_column: 'x' })).toThrow(/no_such_column/);
  expect(cs.changes).toEqual([]);
});

test('update cannot change the primary key', () => {
  seedProject();
  const cs = new ChangeSet(db);
  expect(() => cs.update('projects', 'p_1', { id: 'p_2' })).toThrow(/primary key/);
  expect(readRow(db, 'projects', 'p_1')).toBeDefined();
});

test('table and column names outside the whitelist are refused, values are bound as parameters', () => {
  seedProject();
  const cs = new ChangeSet(db);
  expect(() => cs.update('events' as 'projects', '1', { op: 'x' })).toThrow(/unknown domain table/);
  expect(() => cs.update('__proto__' as 'projects', '1', { op: 'x' })).toThrow(/unknown domain table/);
  expect(() => cs.update('projects', 'p_1', { 'title = 1, summary': 'x' })).toThrow(/invalid column/);
  expect(() => cs.insert('projects', { id: 'p_2', 'title) VALUES (1); --': 'x' })).toThrow(/invalid column/);
  expect(() => readRow(db, 'events' as 'projects', '1')).toThrow(/unknown domain table/);

  const nasty = "x'); DROP TABLE projects; --";
  cs.update('projects', 'p_1', { title: nasty });
  expect(readRow(db, 'projects', 'p_1')?.title).toBe(nasty);
});

test('insert needs a string primary key', () => {
  const cs = new ChangeSet(db);
  expect(() => cs.insert('projects', { title: 'A' })).toThrow(/primary key/);
  expect(() => cs.insert('projects', { id: '', title: 'A' })).toThrow(/primary key/);
});

test('sessions rows are addressed by key', () => {
  db.prepare('INSERT INTO sessions (key, agent_kind) VALUES (?, ?)').run('claude:x', 'claude');
  expect(readRow(db, 'sessions', 'claude:x')).toMatchObject({ key: 'claude:x', ignored: 0 });
  const cs = new ChangeSet(db);
  expect(cs.update('sessions', 'claude:x', { ignored: 1 })).toBe(true);
  expect(cs.changes).toEqual([{ table: 'sessions', id: 'claude:x', before: { ignored: 0 }, after: { ignored: 1 } }]);
  expect(readRow(db, 'sessions', 'claude:x')?.ignored).toBe(1);
});

test('readRow returns undefined for a missing row', () => {
  expect(readRow(db, 'projects', 'p_nope')).toBeUndefined();
  expect(readRow(db, 'sessions', 'nope')).toBeUndefined();
});

test('appendEvent stores before/after keyed by table:id and entity of the first change', () => {
  const cs = seedProject();
  const id = appendEvent(db, { ...baseEvent, op: 'create_project', changes: cs.changes });
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown>;
  expect(row.entity).toBe('projects:p_1');
  expect(JSON.parse(row.before as string)).toEqual({ 'projects:p_1': null });
  expect(JSON.parse(row.after as string)).toEqual({ 'projects:p_1': { id: 'p_1', title: 'A', summary: 's' } });
});

test('appendEvent stores the envelope fields and returns increasing ids', () => {
  const cs = seedProject();
  const first = appendEvent(db, { ...baseEvent, changes: cs.changes, evidence: ['chunk:1#L2'], reason: 'because', actor: 'ai:curator', question_id: 'q_1' });
  const second = appendEvent(db, { ...baseEvent, changes: [], project_id: null, args: null });
  expect(second).toBe(first + 1);
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(first) as Record<string, unknown>;
  expect(row).toMatchObject({
    occurred_at: '2026-10-29T10:00:00.000Z',
    recorded_at: '2026-10-29T10:00:01.000Z',
    actor: 'ai:curator',
    op: 'update_project',
    project_id: 'p_1',
    reason: 'because',
    question_id: 'q_1',
    reverts: null,
    reverted_by: null,
    is_veto: 0,
  });
  expect(JSON.parse(row.args as string)).toEqual({ project: 'p_1' });
  expect(JSON.parse(row.evidence as string)).toEqual(['chunk:1#L2']);
  const empty = db.prepare('SELECT * FROM events WHERE id = ?').get(second) as Record<string, unknown>;
  expect(empty).toMatchObject({ entity: null, project_id: null, args: 'null', evidence: '[]' });
  expect(JSON.parse(empty.before as string)).toEqual({});
  expect(JSON.parse(empty.after as string)).toEqual({});
});

test('appendEvent keys every change and records revert and veto flags', () => {
  const setup = seedProject();
  expect(setup.changes).toHaveLength(1);
  const cs = new ChangeSet(db);
  cs.update('projects', 'p_1', { title: 'B' });
  cs.insert('milestones', { id: 'm_1', project_id: 'p_1' });
  const id = appendEvent(db, { ...baseEvent, changes: cs.changes, reverts: 7, is_veto: true });
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown>;
  expect(row).toMatchObject({ entity: 'projects:p_1', reverts: 7, is_veto: 1 });
  expect(JSON.parse(row.before as string)).toEqual({ 'projects:p_1': { title: 'A' }, 'milestones:m_1': null });
  expect(JSON.parse(row.after as string)).toEqual({
    'projects:p_1': { title: 'B' },
    'milestones:m_1': { id: 'm_1', project_id: 'p_1' },
  });
});

test('appendEvent collapses an insert followed by updates into one net insert', () => {
  const cs = seedProject();
  cs.update('projects', 'p_1', { title: 'B' });
  cs.update('projects', 'p_1', { why: 'because' });
  const id = appendEvent(db, { ...baseEvent, op: 'create_project', changes: cs.changes });
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown>;
  expect(row.entity).toBe('projects:p_1');
  expect(JSON.parse(row.before as string)).toEqual({ 'projects:p_1': null });
  expect(JSON.parse(row.after as string)).toEqual({
    'projects:p_1': { id: 'p_1', title: 'B', summary: 's', why: 'because' },
  });
});

test('netChanges drops columns that end where they started and rows left with nothing', () => {
  const cs = new ChangeSet(db);
  cs.insert('projects', { id: 'p_1', title: 'A', summary: 's' });
  cs.insert('projects', { id: 'p_2', title: 'X', summary: 's' });
  const later = new ChangeSet(db);
  later.update('projects', 'p_1', { title: 'B', summary: 't' });
  later.update('projects', 'p_1', { title: 'A' });
  later.update('projects', 'p_2', { title: 'Y' });
  later.update('projects', 'p_2', { title: 'X' });
  expect(netChanges(later.changes)).toEqual([
    { table: 'projects', id: 'p_1', before: { summary: 's' }, after: { summary: 't' } },
  ]);
  expect(netChanges([{ table: 'projects', id: 'p_1', before: { title: 'A' }, after: { title: 'A' } }])).toEqual([]);
});

test('appendEvent records only the net change of a column changed and changed back', () => {
  seedProject();
  const cs = new ChangeSet(db);
  cs.update('projects', 'p_1', { title: 'B', summary: 't' });
  cs.update('projects', 'p_1', { title: 'A' });
  const id = appendEvent(db, { ...baseEvent, changes: cs.changes });
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown>;
  expect(JSON.parse(row.before as string)).toEqual({ 'projects:p_1': { summary: 's' } });
  expect(JSON.parse(row.after as string)).toEqual({ 'projects:p_1': { summary: 't' } });
});

test('appendEvent does not alter the changes it was given', () => {
  const cs = seedProject();
  cs.update('projects', 'p_1', { title: 'B' });
  const snapshot = structuredClone(cs.changes);
  appendEvent(db, { ...baseEvent, changes: cs.changes });
  expect(cs.changes).toEqual(snapshot);
});

test('the before JSON of an event is enough to restore the row', () => {
  seedProject();
  const cs = new ChangeSet(db);
  cs.update('projects', 'p_1', { title: 'B', summary: 'z' });
  const id = appendEvent(db, { ...baseEvent, changes: cs.changes });
  const row = db.prepare('SELECT before FROM events WHERE id = ?').get(id) as { before: string };
  const before = JSON.parse(row.before) as Record<string, Record<string, string>>;
  const restore = new ChangeSet(db);
  restore.update('projects', 'p_1', before['projects:p_1']);
  expect(readRow(db, 'projects', 'p_1')).toMatchObject({ title: 'A', summary: 's' });
});

test('LOCKABLE lists the user-lockable fields per table', () => {
  expect(LOCKABLE).toEqual({
    projects: ['title', 'summary', 'why', 'done_criteria', 'priority'],
    todos: ['title', 'status', 'priority', 'milestone_id'],
    milestones: ['title', 'status', 'position'],
  });
});

test('readLocks parses the locks column and tolerates junk', () => {
  expect(readLocks({ locks: '["title","why"]' })).toEqual(['title', 'why']);
  expect(readLocks({ locks: '[]' })).toEqual([]);
  expect(readLocks({})).toEqual([]);
  expect(readLocks({ locks: null })).toEqual([]);
  expect(readLocks({ locks: 'not json' })).toEqual([]);
  expect(readLocks({ locks: '{"a":1}' })).toEqual([]);
  expect(readLocks({ locks: '["title",3]' })).toEqual(['title']);
});

test('addLocks keeps only lockable fields, dedupes and sorts', () => {
  expect(addLocks({ locks: '["title"]' }, ['priority', 'title', 'stage'])).toBe('["priority","title"]');
  expect(addLocks({}, [])).toBe('[]');
  expect(addLocks({ locks: '["why"]' }, ['summary'])).toBe('["summary","why"]');
  expect(addLocks({ locks: '["bogus"]' }, ['position'])).toBe('["position"]');
});

test('a Change survives a JSON round trip unchanged', () => {
  const cs = seedProject();
  cs.update('projects', 'p_1', { title: 'B' });
  const copy = JSON.parse(JSON.stringify(cs.changes)) as Change[];
  expect(copy).toEqual(cs.changes);
});
