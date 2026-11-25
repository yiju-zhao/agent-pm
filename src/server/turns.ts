import type { DatabaseSync } from 'node:sqlite';

import { transaction } from './db.ts';

export type Turn = {
  n: number;
  turn_id: string | null;
  first_key: string;
  last_key: string;
  ts_start: string | null;
  ts_end: string | null;
  tool_calls: number;
  tool_failures: number;
};

export function listTurns(db: DatabaseSync, sessionKey: string): Turn[] {
  return db
    .prepare(
      `SELECT n, turn_id, first_key, last_key, ts_start, ts_end, tool_calls, tool_failures
    FROM turns WHERE session_key=? ORDER BY n`,
    )
    .all(sessionKey) as Turn[];
}

type TurnEvent = {
  id: number;
  first_event: number;
  event_key: string;
  turn_id: string | null;
  kind: string;
  ts: string | null;
  failed: number;
};

function indexTurnEvents(db: DatabaseSync, sessionKey: string, events: TurnEvent[]): void {
  let tail = db.prepare('SELECT n, turn_id, has_user FROM turns WHERE session_key=? ORDER BY n DESC LIMIT 1').get(sessionKey) as
    { n: number; turn_id: string | null; has_user: number } | undefined;
  const start = db.prepare(`INSERT INTO turns(session_key, n, turn_id, first_key, last_key, ts_start, ts_end, tool_calls, tool_failures, has_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const extend = db.prepare(`UPDATE turns SET last_key=?, ts_end=?, tool_calls=tool_calls+?, tool_failures=tool_failures+?, has_user=?
    WHERE session_key=? AND n=?`);
  const link = db.prepare('INSERT INTO turn_items(session_key, event_key, n, first_event, latest_event) VALUES (?, ?, ?, ?, ?)');
  const prior = db.prepare(`SELECT i.n, e.kind, e.turn_id, coalesce(json_extract(e.meta, '$.tool.status')='failed', 0) AS failed
    FROM turn_items i JOIN source_events e ON e.id=i.latest_event WHERE i.session_key=? AND i.event_key=?`);
  const revise = db.prepare('UPDATE turn_items SET latest_event=? WHERE session_key=? AND event_key=?');
  const recount = db.prepare(`UPDATE turns SET tool_failures=tool_failures+?,
    ts_start=CASE WHEN first_key=? THEN ? ELSE ts_start END, ts_end=CASE WHEN last_key=? THEN ? ELSE ts_end END
    WHERE session_key=? AND n=?`);
  for (const e of events) {
    const previous = prior.get(sessionKey, e.event_key);
    if (previous) {
      if (previous.kind !== e.kind || previous.turn_id !== e.turn_id) {
        rebuildTurns(db, sessionKey);
        return;
      }
      revise.run(e.id, sessionKey, e.event_key);
      recount.run(e.failed - Number(previous.failed), e.event_key, e.ts, e.event_key, e.ts, sessionKey, previous.n);
      continue;
    }
    const isUser = e.kind === 'user';
    const isTool = Number(e.kind === 'tool');
    let hasBoundary: boolean;
    if (e.turn_id !== null) {
      hasBoundary = e.turn_id !== tail?.turn_id;
    } else {
      hasBoundary = isUser && (tail?.has_user === 1 || tail?.turn_id != null);
    }
    if (!tail || hasBoundary) {
      tail = { n: (tail?.n ?? 0) + 1, turn_id: e.turn_id, has_user: Number(isUser) };
      start.run(sessionKey, tail.n, e.turn_id, e.event_key, e.event_key, e.ts, e.ts, isTool, e.failed, tail.has_user);
    } else {
      tail.has_user = Number(isUser || tail.has_user === 1);
      extend.run(e.event_key, e.ts, isTool, e.failed, tail.has_user, sessionKey, tail.n);
    }
    link.run(sessionKey, e.event_key, tail.n, e.first_event, e.id);
  }
}

const eventColumns =
  "e.id,e.event_key,e.turn_id,e.kind,e.ts,coalesce(e.kind='tool' AND json_extract(e.meta,'$.tool.status')='failed',0) AS failed";

export function rebuildTurns(db: DatabaseSync, sessionKey: string): void {
  if (!db.isTransaction) return transaction(db, () => rebuildTurns(db, sessionKey));
  db.prepare('DELETE FROM turn_items WHERE session_key=?').run(sessionKey);
  db.prepare('DELETE FROM turns WHERE session_key=?').run(sessionKey);
  const rows = db
    .prepare(
      `SELECT ${eventColumns}, versions.first_event FROM
    (SELECT min(id) AS first_event, max(id) AS latest_event FROM source_events
     WHERE session_key=? AND source_id NOT LIKE 'herdr:%' GROUP BY event_key) versions
    JOIN source_events e ON e.id=versions.latest_event ORDER BY versions.first_event`,
    )
    .all(sessionKey) as TurnEvent[];
  indexTurnEvents(db, sessionKey, rows);
}

export function updateTurns(db: DatabaseSync, sessionKey: string, inserted: number[], regroup: boolean): void {
  if (!inserted.length && !regroup) return;
  // A center upgraded with existing history can receive a batch before the offline rebuild is run.
  if (regroup || !db.prepare('SELECT 1 FROM turns WHERE session_key=? LIMIT 1').get(sessionKey)) {
    rebuildTurns(db, sessionKey);
    return;
  }
  const rows = db
    .prepare(`SELECT ${eventColumns}, e.id AS first_event FROM source_events e WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .all(JSON.stringify(inserted)) as TurnEvent[];
  indexTurnEvents(db, sessionKey, rows);
}
