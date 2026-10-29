import { DatabaseSync } from 'node:sqlite';

/** Append-only: entry i upgrades a database from `user_version` i to i + 1. Never edit a shipped entry. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE machines (
    label TEXT PRIMARY KEY,
    last_heartbeat TEXT,
    collector_version TEXT
  );
  CREATE TABLE sessions (
    key TEXT PRIMARY KEY,
    agent_kind TEXT,
    native_id TEXT,
    machine TEXT,
    pane_id TEXT,
    terminal_id TEXT,
    workspace_id TEXT,
    tab_id TEXT,
    cwd TEXT,
    title TEXT,
    live_status TEXT,
    lifecycle TEXT,
    fidelity TEXT,
    transcript_path TEXT,
    predecessor_key TEXT,
    merged_into TEXT,
    ignored INTEGER DEFAULT 0,
    first_seen TEXT,
    last_seen TEXT
  );
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    session_key TEXT,
    kind TEXT,
    offset_start INTEGER,
    offset_end INTEGER,
    ts_start TEXT,
    ts_end TEXT,
    text TEXT,
    backfill INTEGER,
    digested INTEGER DEFAULT 0,
    received_at TEXT,
    UNIQUE(session_key, offset_start)
  );
  `,
];

/** Opens (creating if needed) the central database in WAL mode and applies pending migrations. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = user_version; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return db;
}

/** Runs `fn` inside BEGIN/COMMIT, rolling back and rethrowing if it throws. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
