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
  // v2: domain layer. Every *_at / ts_* column is an ISO-8601 UTC string; JSON columns hold JSON text.
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    title TEXT,
    stage TEXT,
    stage_before_park TEXT,
    priority TEXT,
    summary TEXT,
    why TEXT,
    done_criteria TEXT,
    merged_into TEXT,
    locks TEXT DEFAULT '[]',
    created_by TEXT,
    user_touched INTEGER DEFAULT 0,
    created_at TEXT,
    deleted_at TEXT,
    vetoed INTEGER DEFAULT 0
  );
  CREATE TABLE milestones (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    title TEXT,
    status TEXT,
    position INTEGER,
    locks TEXT DEFAULT '[]',
    created_by TEXT,
    created_at TEXT,
    deleted_at TEXT,
    vetoed INTEGER DEFAULT 0
  );
  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    milestone_id TEXT,
    title TEXT,
    status TEXT,
    priority TEXT,
    locks TEXT DEFAULT '[]',
    created_by TEXT,
    created_at TEXT,
    deleted_at TEXT,
    vetoed INTEGER DEFAULT 0
  );
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    text TEXT,
    decided_at TEXT,
    evidence TEXT,
    created_by TEXT,
    created_at TEXT,
    deleted_at TEXT,
    vetoed INTEGER DEFAULT 0
  );
  CREATE TABLE blockers (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    text TEXT,
    kind TEXT,
    status TEXT,
    cleared_at TEXT,
    created_by TEXT,
    created_at TEXT,
    deleted_at TEXT,
    vetoed INTEGER DEFAULT 0
  );
  CREATE TABLE contributions (
    id TEXT PRIMARY KEY,
    session_key TEXT,
    project_id TEXT,
    milestone_id TEXT,
    summary TEXT,
    ts_start TEXT,
    ts_end TEXT,
    confidence REAL,
    actor TEXT,
    created_at TEXT,
    deleted_at TEXT,
    vetoed INTEGER DEFAULT 0,
    UNIQUE(session_key, project_id)
  );
  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    kind TEXT,
    prompt TEXT,
    options TEXT,
    project_id TEXT,
    session_key TEXT,
    status TEXT,
    answer TEXT,
    evidence TEXT,
    guards TEXT,
    dedupe_key TEXT,
    rejected INTEGER DEFAULT 0,
    resolution_note TEXT,
    created_by TEXT,
    created_at TEXT,
    resolved_at TEXT
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    occurred_at TEXT,
    recorded_at TEXT,
    actor TEXT,
    op TEXT,
    entity TEXT,
    project_id TEXT,
    args TEXT,
    before TEXT,
    after TEXT,
    reason TEXT,
    evidence TEXT,
    question_id TEXT,
    reverts INTEGER,
    reverted_by INTEGER,
    is_veto INTEGER DEFAULT 0
  );
  CREATE INDEX idx_events_project ON events(project_id, id);
  CREATE INDEX idx_questions_status ON questions(status);
  CREATE INDEX idx_questions_dedupe ON questions(dedupe_key);
  CREATE INDEX idx_contributions_project ON contributions(project_id);
  CREATE INDEX idx_todos_project ON todos(project_id);
  CREATE INDEX idx_milestones_project ON milestones(project_id);
  `,
  // v3: understanding layer. Digests are the model's per-session summaries of chunks; llm_runs logs every model call.
  `
  CREATE TABLE digests (
    id INTEGER PRIMARY KEY,
    session_key TEXT,
    chunk_ids TEXT,
    json TEXT,
    model TEXT,
    ts_start TEXT,
    ts_end TEXT,
    backfill INTEGER,
    trivial INTEGER,
    skipped INTEGER DEFAULT 0,
    curated INTEGER DEFAULT 0,
    created_at TEXT
  );
  CREATE TABLE llm_runs (
    id INTEGER PRIMARY KEY,
    role TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cost_usd REAL,
    duration_ms INTEGER,
    ok INTEGER,
    error_kind TEXT,
    error TEXT,
    ts TEXT
  );
  ALTER TABLE sessions ADD COLUMN status_changed_at TEXT;
  CREATE INDEX idx_chunks_digested ON chunks(digested, session_key);
  CREATE INDEX idx_digests_curated ON digests(curated);
  `,
  // v4: the version of the stage rules each project was last judged under (see understand/stage-guide.ts). Projects
  // that existed before the rules were written were never judged, so they start at 0; new ones start at 1.
  `
  ALTER TABLE projects ADD COLUMN stage_rules_seen INTEGER DEFAULT 1;
  UPDATE projects SET stage_rules_seen = 0;
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
