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
  // v6: API keys and settings. One kind of key for everyone (the user, agents, collectors), told apart by its scope;
  // only a key's hash is stored. Tokens in the server config keep working beside these (see server/keys.ts).
  // `settings` holds what the web UI may change at run time (models; which provider credential is in use), never a
  // secret: provider secrets live in files next to the config.
  `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    created_by TEXT,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // v7: a single administrator account and revocable browser sessions; no plaintext passwords or session tokens.
  `
  CREATE TABLE admin_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE admin_sessions (
    hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX admin_sessions_expiry ON admin_sessions (expires_at);
  `,
  // v8: provider-refused digest windows await review; never retry, skip, or mark their content digested.
  `
  CREATE TABLE digest_blocks (
    session_key TEXT PRIMARY KEY,
    chunk_ids TEXT NOT NULL,
    message TEXT NOT NULL,
    run_id INTEGER,
    created_at TEXT NOT NULL
  );
  `,
  // v9: durable project-wide reorganization requested by a user's structural edit.
  `
  CREATE TABLE project_reviews (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    chunk_cutoff INTEGER NOT NULL,
    digest_cutoff INTEGER,
    cursor INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id,event_id)
  );
  CREATE INDEX idx_project_reviews_pending ON project_reviews(status,retry_at,id);
  `,
  // v10: merge previews. A draft of the merged project built from session evidence; nothing in the domain tables changes
  // until the user applies it, and `signature` (the inputs it was built from) refuses an apply after they changed.
  `
  CREATE TABLE merge_previews (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    session_keys TEXT NOT NULL,
    status TEXT NOT NULL,
    signature TEXT NOT NULL,
    draft TEXT,
    coverage TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // v11: the project a session belongs to in Paseo (projects are named after it), and questions written for a quick
  // answer: what happened, why the user has to decide, and what the AI recommends. `triaged_at` marks a question an
  // automatic decider has looked at, whatever it concluded.
  `
  ALTER TABLE session_sources ADD COLUMN project_name TEXT;
  ALTER TABLE questions ADD COLUMN context TEXT;
  ALTER TABLE questions ADD COLUMN why_user TEXT;
  ALTER TABLE questions ADD COLUMN recommended INTEGER;
  ALTER TABLE questions ADD COLUMN recommend_reason TEXT;
  ALTER TABLE questions ADD COLUMN triaged_at TEXT;
  `,
  // v12: when an open blocker was last checked against what happened since (see understand/blocker-review.ts).
  `
  ALTER TABLE blockers ADD COLUMN reviewed_at TEXT;
  `,
  // v13: the repository state of a session's working directory as its collector last read it (JSON; see
  // shared/workspace.ts), so the models judge from what is on disk, not only from what was said.
  `
  ALTER TABLE session_sources ADD COLUMN workspace TEXT;
  `,
  // v14: reminders the user put off. A reminder is derived from sessions, projects and repositories (see
  // domain/reminders.ts); this only keeps "not now" (until a time) or "not again" (until it changes, by fingerprint).
  `
  CREATE TABLE reminder_snoozes (
    key TEXT PRIMARY KEY,
    until TEXT,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // v15: keep each refused window and point its original chunks at it. Retain even malformed legacy records.
  `
  ALTER TABLE digest_blocks RENAME TO old_digest_blocks;
  CREATE TABLE digest_blocks (
    id INTEGER PRIMARY KEY,
    session_key TEXT NOT NULL,
    chunk_ids TEXT NOT NULL,
    message TEXT NOT NULL,
    run_id INTEGER,
    created_at TEXT NOT NULL,
    needs_review INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX digest_blocks_session ON digest_blocks(session_key);
  ALTER TABLE chunks ADD COLUMN digest_block_id INTEGER;
  CREATE INDEX chunks_refused ON chunks(digest_block_id) WHERE digest_block_id IS NOT NULL;
  INSERT INTO digest_blocks(session_key,chunk_ids,message,run_id,created_at)
    SELECT session_key,chunk_ids,message,run_id,created_at FROM old_digest_blocks;
  -- A pending session may already have acquired a native key. Follow its persisted identity before matching IDs.
  WITH RECURSIVE aliases(original, session_key) AS (
    SELECT session_key,session_key FROM digest_blocks
    UNION SELECT a.original,s.merged_into FROM aliases a JOIN sessions s ON s.key=a.session_key WHERE s.merged_into IS NOT NULL
  )
  UPDATE digest_blocks AS b SET session_key=coalesce((
    SELECT a.session_key FROM aliases a JOIN sessions s ON s.key=a.session_key
    WHERE a.original=b.session_key AND s.merged_into IS NULL
  ),b.session_key);
  UPDATE chunks AS c SET digest_block_id=b.id
    FROM digest_blocks b, json_each(CASE WHEN json_valid(b.chunk_ids) THEN b.chunk_ids ELSE '[]' END) j
    WHERE j.type='integer' AND c.id=j.value AND c.session_key=b.session_key
      AND json_type(CASE WHEN json_valid(b.chunk_ids) THEN b.chunk_ids ELSE 'null' END)='array';
  UPDATE digest_blocks AS b SET needs_review=1 WHERE
    CASE WHEN NOT json_valid(chunk_ids) THEN 1
         WHEN json_type(chunk_ids)!='array' OR json_array_length(chunk_ids)=0 THEN 1
         ELSE json_array_length(chunk_ids)!=(SELECT count(*) FROM chunks c WHERE c.digest_block_id=b.id) END;
  -- A damaged list cannot identify the exact input. Hold its pre-refusal candidates for manual matching;
  -- later arrivals remain eligible. A valid list containing missing numeric IDs needs no speculative match.
  UPDATE chunks AS c SET digest_block_id=b.id FROM digest_blocks b
    WHERE b.needs_review=1 AND c.session_key=b.session_key AND c.digested=0 AND c.digest_block_id IS NULL
      AND (c.received_at IS NULL OR c.received_at<=b.created_at)
      AND CASE WHEN NOT json_valid(b.chunk_ids) THEN 1
               WHEN json_type(b.chunk_ids)!='array' OR json_array_length(b.chunk_ids)=0 THEN 1
               ELSE EXISTS (SELECT 1 FROM json_each(b.chunk_ids) WHERE type!='integer') END;
  DROP TABLE old_digest_blocks;
  `,
  `ALTER TABLE source_events ADD COLUMN turn_id TEXT;`,
  `CREATE TABLE turns (
    session_key TEXT NOT NULL, n INTEGER NOT NULL, turn_id TEXT, first_key TEXT NOT NULL, last_key TEXT NOT NULL,
    ts_start TEXT, ts_end TEXT, tool_calls INTEGER NOT NULL, tool_failures INTEGER NOT NULL, has_user INTEGER NOT NULL,
    PRIMARY KEY(session_key,n)
  );
  CREATE TABLE turn_items (
    session_key TEXT NOT NULL, event_key TEXT NOT NULL, n INTEGER NOT NULL, first_event INTEGER NOT NULL,
    latest_event INTEGER NOT NULL UNIQUE, PRIMARY KEY(session_key,event_key)
  );
  CREATE INDEX turn_item_order ON turn_items(session_key,n,first_event);`,
  `
  CREATE VIRTUAL TABLE search_index USING fts5(body,ref UNINDEXED,kind UNINDEXED,project_id UNINDEXED,session_key UNINDEXED,ts UNINDEXED,tokenize='trigram');
  CREATE VIEW search_projects AS SELECT rowid AS identity,
    rowid*8+0 AS docid,trim(coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(why,'')||' '||coalesce(done_criteria,'')) AS body,id AS ref,'project' AS kind,id AS project_id,
    NULL AS session_key,created_at AS ts FROM projects WHERE deleted_at IS NULL;
CREATE VIEW search_milestones AS SELECT rowid AS identity,
    rowid*8+1 AS docid,title AS body,id AS ref,'milestone' AS kind,project_id AS project_id,
    NULL AS session_key,created_at AS ts FROM milestones WHERE deleted_at IS NULL;
CREATE VIEW search_todos AS SELECT rowid AS identity,
    rowid*8+2 AS docid,title AS body,id AS ref,'todo' AS kind,project_id AS project_id,
    NULL AS session_key,created_at AS ts FROM todos WHERE deleted_at IS NULL;
CREATE VIEW search_decisions AS SELECT rowid AS identity,
    rowid*8+3 AS docid,text AS body,id AS ref,'decision' AS kind,project_id AS project_id,
    NULL AS session_key,coalesce(decided_at,created_at) AS ts FROM decisions WHERE deleted_at IS NULL;
CREATE VIEW search_blockers AS SELECT rowid AS identity,
    rowid*8+4 AS docid,text AS body,id AS ref,'blocker' AS kind,project_id AS project_id,
    NULL AS session_key,created_at AS ts FROM blockers WHERE deleted_at IS NULL;
  CREATE VIEW search_digests AS SELECT id AS identity,id*8+5 AS docid,coalesce((SELECT group_concat(CASE WHEN j.type='object' THEN trim(coalesce(json_extract(j.value,'$.label'),'')||' '||coalesce(json_extract(j.value,'$.summary'),json_extract(j.value,'$.text'),'')) ELSE j.value END, ' ')
   FROM json_each(d.json,'$.topics') j),'')||' '||coalesce((SELECT group_concat(CASE WHEN j.type='object' THEN trim(coalesce(json_extract(j.value,'$.label'),'')||' '||coalesce(json_extract(j.value,'$.summary'),json_extract(j.value,'$.text'),'')) ELSE j.value END, ' ')
   FROM json_each(d.json,'$.progress') j),'')||' '||coalesce((SELECT group_concat(CASE WHEN j.type='object' THEN trim(coalesce(json_extract(j.value,'$.label'),'')||' '||coalesce(json_extract(j.value,'$.summary'),json_extract(j.value,'$.text'),'')) ELSE j.value END, ' ')
   FROM json_each(d.json,'$.decisions') j),'')||' '||coalesce((SELECT group_concat(CASE WHEN j.type='object' THEN trim(coalesce(json_extract(j.value,'$.label'),'')||' '||coalesce(json_extract(j.value,'$.summary'),json_extract(j.value,'$.text'),'')) ELSE j.value END, ' ')
   FROM json_each(d.json,'$.blockers') j),'') AS body,
    'digest:'||id AS ref,'digest' AS kind,NULL AS project_id,session_key,coalesce(ts_end,created_at) AS ts
    FROM digests d WHERE json_valid(json) AND skipped=0;
  CREATE VIEW search_turn_items AS SELECT i.latest_event AS identity,i.latest_event*8+6 AS docid,e.text AS body,
    's:'||substr(coalesce(s.native_id,s.terminal_id,substr(i.session_key,instr(i.session_key,':')+1)),1,8)||'#'||i.n AS ref,
    'message' AS kind,NULL AS project_id,i.session_key,e.ts
    FROM turn_items i JOIN source_events e ON e.id=i.latest_event LEFT JOIN sessions s ON s.key=i.session_key
    WHERE e.kind IN ('user','assistant') AND e.text IS NOT NULL;
  CREATE TRIGGER index_projects_insert AFTER INSERT ON projects BEGIN INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_projects WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_projects_update AFTER UPDATE ON projects BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+0; INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_projects WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_projects_delete AFTER DELETE ON projects BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+0; END;
CREATE TRIGGER index_milestones_insert AFTER INSERT ON milestones BEGIN INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_milestones WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_milestones_update AFTER UPDATE ON milestones BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+1; INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_milestones WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_milestones_delete AFTER DELETE ON milestones BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+1; END;
CREATE TRIGGER index_todos_insert AFTER INSERT ON todos BEGIN INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_todos WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_todos_update AFTER UPDATE ON todos BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+2; INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_todos WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_todos_delete AFTER DELETE ON todos BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+2; END;
CREATE TRIGGER index_decisions_insert AFTER INSERT ON decisions BEGIN INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_decisions WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_decisions_update AFTER UPDATE ON decisions BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+3; INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_decisions WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_decisions_delete AFTER DELETE ON decisions BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+3; END;
CREATE TRIGGER index_blockers_insert AFTER INSERT ON blockers BEGIN INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_blockers WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_blockers_update AFTER UPDATE ON blockers BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+4; INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_blockers WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_blockers_delete AFTER DELETE ON blockers BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+4; END;
CREATE TRIGGER index_digests_insert AFTER INSERT ON digests BEGIN INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_digests WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_digests_update AFTER UPDATE ON digests BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+5; INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_digests WHERE identity=NEW.rowid; END;
      CREATE TRIGGER index_digests_delete AFTER DELETE ON digests BEGIN DELETE FROM search_index WHERE rowid=OLD.rowid*8+5; END;
CREATE TRIGGER index_turn_items_insert AFTER INSERT ON turn_items BEGIN INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_turn_items WHERE identity=NEW.latest_event; END;
      CREATE TRIGGER index_turn_items_update AFTER UPDATE ON turn_items BEGIN DELETE FROM search_index WHERE rowid=OLD.latest_event*8+6; INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_turn_items WHERE identity=NEW.latest_event; END;
      CREATE TRIGGER index_turn_items_delete AFTER DELETE ON turn_items BEGIN DELETE FROM search_index WHERE rowid=OLD.latest_event*8+6; END;
  CREATE TRIGGER index_message_text AFTER UPDATE OF text ON source_events WHEN OLD.kind IN ('user','assistant') BEGIN
    DELETE FROM search_index WHERE rowid=OLD.id*8+6;
    INSERT INTO search_index(rowid,body,ref,kind,project_id,session_key,ts) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_turn_items WHERE identity=NEW.id;
  END;
`,
  `CREATE TABLE reader_cursors(reader TEXT PRIMARY KEY,last_event_id INTEGER NOT NULL,last_seen_at TEXT NOT NULL);
   CREATE VIEW context_turn_events AS
   SELECT i.session_key,i.n,i.first_event,i.latest_event,i.event_key,e.kind,e.text,e.meta,e.ts,e.stream_id,s.server_id,
     EXISTS(SELECT 1 FROM source_events v JOIN chunk_sources x ON x.source_event_id=v.id
       JOIN chunks c ON c.id=x.chunk_id WHERE v.session_key=i.session_key AND v.event_key=i.event_key
       AND c.digest_block_id IS NOT NULL) AS refused
   FROM turn_items i JOIN source_events e ON e.id=i.latest_event JOIN ingest_sources s ON s.source_id=e.source_id;
   CREATE INDEX source_event_revisions ON source_events(session_key,event_key,id);`,
  `ALTER TABLE digests ADD COLUMN turn_start INTEGER;
   ALTER TABLE digests ADD COLUMN turn_end INTEGER;
   ALTER TABLE sessions ADD COLUMN card TEXT;
   ALTER TABLE sessions ADD COLUMN card_as_of_turn INTEGER;`,
  ['decisions','blockers','todos','milestones'].map(table => {
    const column = table==='decisions' || table==='blockers' ? 'text' : 'title';
    return `ALTER TABLE ${table} ADD COLUMN checked_at TEXT;
      ALTER TABLE ${table} ADD COLUMN checked_ref TEXT;
      CREATE TRIGGER invalidate_check_${table} AFTER UPDATE OF ${column} ON ${table}
      WHEN NEW.${column} IS NOT OLD.${column} AND NEW.checked_ref IS NOT NULL AND OLD.checked_ref IS NEW.checked_ref
      BEGIN UPDATE ${table} SET checked_ref=NULL,checked_at=NULL WHERE id=NEW.id; END;`;
  }).join('\n'),
  `DROP TRIGGER invalidate_check_decisions;
   DROP TRIGGER invalidate_check_blockers;
   DROP TRIGGER invalidate_check_todos;
   DROP TRIGGER invalidate_check_milestones;`,
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
