import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { MIGRATIONS, openDb } from '../../src/server/db.ts';

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

function indexColumns(db: DatabaseSync, table: string): string[] {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string; origin: string }[];
  return indexes
    .filter((i) => i.origin === 'c')
    .map((i) => {
      const cols = db.prepare(`PRAGMA index_info(${i.name})`).all() as { seqno: number; name: string }[];
      return cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name).join(',');
    })
    .sort();
}

test('a v1 database (ingestion only) upgrades to v2 and keeps its sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-pm-db-'));
  const path = join(dir, 'pm.db');
  try {
    const v1 = new DatabaseSync(path);
    v1.exec(MIGRATIONS[0]);
    v1.exec('PRAGMA user_version = 1');
    v1.prepare('INSERT INTO sessions (key, agent_kind, title) VALUES (?, ?, ?)').run('claude:abc', 'claude', 'old session');
    v1.close();

    const db = openDb(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(MIGRATIONS.length).toBeGreaterThanOrEqual(2);
      expect(db.prepare('SELECT key, agent_kind, title FROM sessions').all()).toEqual([
        { key: 'claude:abc', agent_kind: 'claude', title: 'old session' },
      ]);
      const names = tableNames(db);
      expect(names).toEqual(expect.arrayContaining(['projects', 'events', 'questions', 'contributions']));
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fresh database has every domain table', () => {
  const db = openDb(':memory:');
  try {
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'blockers', 'chunks', 'contributions', 'decisions', 'events', 'machines',
        'milestones', 'projects', 'questions', 'sessions', 'todos',
      ]),
    );
  } finally {
    db.close();
  }
});

test('domain tables carry the agreed defaults', () => {
  const db = openDb(':memory:');
  try {
    db.prepare('INSERT INTO projects (id, title) VALUES (?, ?)').run('p_1', 'A');
    db.prepare('INSERT INTO milestones (id, project_id) VALUES (?, ?)').run('m_1', 'p_1');
    db.prepare('INSERT INTO todos (id, project_id) VALUES (?, ?)').run('t_1', 'p_1');
    db.prepare('INSERT INTO questions (id) VALUES (?)').run('q_1');
    db.prepare('INSERT INTO events (op) VALUES (?)').run('create_project');
    expect(db.prepare('SELECT locks, user_touched, vetoed FROM projects').get()).toEqual({ locks: '[]', user_touched: 0, vetoed: 0 });
    expect(db.prepare('SELECT locks, vetoed FROM milestones').get()).toEqual({ locks: '[]', vetoed: 0 });
    expect(db.prepare('SELECT locks, vetoed FROM todos').get()).toEqual({ locks: '[]', vetoed: 0 });
    expect(db.prepare('SELECT rejected FROM questions').get()).toEqual({ rejected: 0 });
    expect(db.prepare('SELECT id, is_veto FROM events').get()).toEqual({ id: 1, is_veto: 0 });
  } finally {
    db.close();
  }
});

test('a session links to a project at most once', () => {
  const db = openDb(':memory:');
  try {
    const insert = db.prepare('INSERT INTO contributions (id, session_key, project_id) VALUES (?, ?, ?)');
    insert.run('c_1', 'claude:abc', 'p_1');
    insert.run('c_2', 'claude:abc', 'p_2');
    expect(() => insert.run('c_3', 'claude:abc', 'p_1')).toThrow(/UNIQUE/);
  } finally {
    db.close();
  }
});

test('lookup indexes exist', () => {
  const db = openDb(':memory:');
  try {
    expect(indexColumns(db, 'events')).toEqual(['project_id,id']);
    expect(indexColumns(db, 'questions')).toEqual(['dedupe_key', 'status']);
    expect(indexColumns(db, 'contributions')).toEqual(['project_id']);
    expect(indexColumns(db, 'todos')).toEqual(['project_id']);
    expect(indexColumns(db, 'milestones')).toEqual(['project_id']);
  } finally {
    db.close();
  }
});
