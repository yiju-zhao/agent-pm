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
  // v5: ingestion sources. A session can be observed by several sources (a herdr collector per machine, a Paseo
  // collector per daemon); each keeps its own observation, heartbeat, checkpoints and evidence, and `sessions` stays the
  // logical session with its columns as the projection of its sources (see server/sources-repo.ts). Every existing
  // machine becomes the source `herdr:<machine>`, every existing session an observation of its machine's source.
  `
  CREATE TABLE ingest_sources (
    source_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    machine TEXT NOT NULL,
    server_id TEXT,
    collector_version TEXT,
    collector_heartbeat TEXT,
    daemon_status TEXT,
    daemon_error TEXT,
    daemon_checked_at TEXT,
    last_snapshot_at TEXT,
    lease_instance TEXT,
    lease_epoch INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    snapshot_rev INTEGER NOT NULL DEFAULT 0,
    diagnostics TEXT
  );
  CREATE TABLE session_sources (
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    provider TEXT,
    native_id TEXT,
    native_id_origin TEXT,
    machine TEXT,
    pane_id TEXT,
    terminal_id TEXT,
    workspace_id TEXT,
    tab_id TEXT,
    cwd TEXT,
    title TEXT,
    fidelity TEXT,
    transcript_path TEXT,
    live_status TEXT,
    raw_status TEXT,
    attention TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'live',
    end_reason TEXT,
    content_state TEXT,
    identity_note TEXT,
    first_seen TEXT,
    last_seen TEXT,
    status_changed_at TEXT,
    PRIMARY KEY (source_id, external_id)
  );
  CREATE INDEX idx_session_sources_key ON session_sources(session_key);
  ALTER TABLE sessions ADD COLUMN content_owner TEXT;
  ALTER TABLE chunks ADD COLUMN source_id TEXT;
  CREATE TABLE source_offsets (
    source_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    offset_end INTEGER NOT NULL,
    updated_at TEXT,
    PRIMARY KEY (source_id, session_key)
  );
  CREATE TABLE ingest_streams (
    source_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    epoch TEXT,
    seq INTEGER,
    state TEXT,
    last_batch_id TEXT,
    events_total INTEGER NOT NULL DEFAULT 0,
    last_event_ts TEXT,
    overlap_until TEXT,
    updated_at TEXT,
    PRIMARY KEY (source_id, stream_id)
  );
  CREATE TABLE ingest_batches (
    source_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    ack TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (source_id, batch_id)
  );
  CREATE TABLE source_events (
    id INTEGER PRIMARY KEY,
    source_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    base_key TEXT,
    event_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    session_key TEXT,
    batch_id TEXT,
    epoch TEXT,
    seq_start INTEGER,
    seq_end INTEGER,
    kind TEXT,
    ts TEXT,
    ts_known INTEGER NOT NULL DEFAULT 1,
    backfill INTEGER,
    received_at TEXT,
    text TEXT,
    meta TEXT,
    disposition TEXT NOT NULL,
    UNIQUE (source_id, stream_id, event_key, content_hash)
  );
  CREATE INDEX idx_source_events_key ON source_events(source_id, stream_id, event_key, revision);
  CREATE INDEX idx_source_events_base ON source_events(source_id, stream_id, base_key);
  CREATE INDEX idx_source_events_session ON source_events(session_key);
  CREATE TABLE chunk_sources (
    chunk_id INTEGER NOT NULL,
    source_event_id INTEGER NOT NULL,
    PRIMARY KEY (chunk_id, source_event_id)
  );
  CREATE INDEX idx_chunk_sources_event ON chunk_sources(source_event_id);
  CREATE TABLE ingest_gaps (
    id INTEGER PRIMARY KEY,
    source_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    epoch TEXT,
    from_seq INTEGER,
    to_seq INTEGER,
    reason TEXT NOT NULL,
    detected_at TEXT NOT NULL
  );
  CREATE INDEX idx_ingest_gaps_stream ON ingest_gaps(source_id, stream_id);
  CREATE TABLE content_handovers (
    id INTEGER PRIMARY KEY,
    session_key TEXT NOT NULL,
    from_source TEXT,
    to_source TEXT NOT NULL,
    boundary_ts TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX idx_content_handovers_key ON content_handovers(session_key, to_source);

  INSERT INTO ingest_sources (source_id, kind, machine, collector_version, collector_heartbeat, last_snapshot_at)
    SELECT 'herdr:' || label, 'herdr', label, collector_version, last_heartbeat, last_heartbeat FROM machines;
  INSERT OR IGNORE INTO ingest_sources (source_id, kind, machine)
    SELECT DISTINCT 'herdr:' || machine, 'herdr', machine FROM sessions WHERE machine IS NOT NULL AND machine != '';
  INSERT INTO session_sources (
    source_id, external_id, session_key, provider, native_id, native_id_origin, machine, pane_id, terminal_id,
    workspace_id, tab_id, cwd, title, fidelity, transcript_path, live_status, raw_status, lifecycle, end_reason,
    first_seen, last_seen, status_changed_at
  )
    SELECT 'herdr:' || machine, key, coalesce(merged_into, key), agent_kind, native_id,
      CASE WHEN native_id IS NULL THEN NULL ELSE 'herdr' END, machine, pane_id, terminal_id, workspace_id, tab_id, cwd,
      title, fidelity, transcript_path, live_status, live_status,
      CASE WHEN merged_into IS NOT NULL THEN 'ended' ELSE coalesce(lifecycle, 'live') END,
      CASE WHEN merged_into IS NOT NULL THEN 'merged' END,
      first_seen, last_seen, status_changed_at
    FROM sessions WHERE machine IS NOT NULL AND machine != '';
  UPDATE chunks SET source_id = (
    SELECT 'herdr:' || s.machine FROM sessions s WHERE s.key = chunks.session_key AND s.machine IS NOT NULL AND s.machine != ''
  ) WHERE kind IN ('transcript', 'screen');
  UPDATE sessions SET content_owner = 'herdr:' || machine
    WHERE machine IS NOT NULL AND machine != ''
      AND EXISTS (SELECT 1 FROM chunks c WHERE c.session_key = sessions.key AND c.kind IN ('transcript', 'screen'));
  INSERT INTO source_offsets (source_id, session_key, offset_end, updated_at)
    SELECT 'herdr:' || s.machine, c.session_key, max(c.offset_end), NULL
    FROM chunks c JOIN sessions s ON s.key = c.session_key
    WHERE c.kind = 'transcript' AND s.machine IS NOT NULL AND s.machine != '' AND c.offset_end IS NOT NULL
    GROUP BY c.session_key;
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
