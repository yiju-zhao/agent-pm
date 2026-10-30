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

test('a v2 database upgrades to v3 and keeps its data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-pm-db-'));
  const path = join(dir, 'pm.db');
  try {
    const v2 = new DatabaseSync(path);
    v2.exec(MIGRATIONS[0]);
    v2.exec(MIGRATIONS[1]);
    v2.exec('PRAGMA user_version = 2');
    v2.prepare('INSERT INTO sessions (key, agent_kind, title) VALUES (?, ?, ?)').run('claude:abc', 'claude', 'old session');
    v2.prepare('INSERT INTO chunks (session_key, kind, offset_start, text) VALUES (?, ?, ?, ?)').run('claude:abc', 'transcript', 0, 'hello');
    v2.prepare('INSERT INTO projects (id, title) VALUES (?, ?)').run('p_1', 'A project');
    v2.close();

    const db = openDb(path);
    try {
      expect(MIGRATIONS.length).toBeGreaterThanOrEqual(3);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(db.prepare('SELECT key, agent_kind, title, status_changed_at FROM sessions').all()).toEqual([
        { key: 'claude:abc', agent_kind: 'claude', title: 'old session', status_changed_at: null },
      ]);
      expect(db.prepare('SELECT session_key, text, digested FROM chunks').all()).toEqual([
        { session_key: 'claude:abc', text: 'hello', digested: 0 },
      ]);
      expect(db.prepare('SELECT id, title FROM projects').all()).toEqual([{ id: 'p_1', title: 'A project' }]);
      expect(tableNames(db)).toEqual(expect.arrayContaining(['digests', 'llm_runs']));
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('digests and llm_runs carry the agreed columns and defaults', () => {
  const db = openDb(':memory:');
  try {
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns('digests')).toEqual([
      'id', 'session_key', 'chunk_ids', 'json', 'model', 'ts_start', 'ts_end', 'backfill', 'trivial',
      'skipped', 'curated', 'created_at',
    ]);
    expect(columns('llm_runs')).toEqual([
      'id', 'role', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cost_usd',
      'duration_ms', 'ok', 'error_kind', 'error', 'ts',
    ]);
    expect(columns('sessions')).toContain('status_changed_at');

    db.prepare('INSERT INTO digests (session_key) VALUES (?)').run('claude:abc');
    expect(db.prepare('SELECT id, skipped, curated FROM digests').get()).toEqual({ id: 1, skipped: 0, curated: 0 });
    db.prepare('INSERT INTO llm_runs (role, ok) VALUES (?, ?)').run('digest', 1);
    expect(db.prepare('SELECT id, role, ok FROM llm_runs').get()).toEqual({ id: 1, role: 'digest', ok: 1 });
  } finally {
    db.close();
  }
});

test('a fresh database has every domain table', () => {
  const db = openDb(':memory:');
  try {
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'blockers', 'chunks', 'contributions', 'decisions', 'digests', 'events', 'llm_runs', 'machines',
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
    expect(indexColumns(db, 'chunks')).toEqual(['digested,session_key']);
    expect(indexColumns(db, 'digests')).toEqual(['curated']);
  } finally {
    db.close();
  }
});
