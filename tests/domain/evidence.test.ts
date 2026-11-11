import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  EVIDENCE_CHUNK_CHARS,
  EVIDENCE_MAX_CHUNKS,
  getEvidence,
  parseEvidenceRef,
} from '../../src/domain/evidence.ts';
import { openDb } from '../../src/server/db.ts';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const KEY = 'claude:5d27595b-908e-4fe5-9283-890acdbd075f';
const TS1 = '2026-10-29T09:00:00.000Z';
const TS2 = '2026-10-29T09:30:00.000Z';

let db: DatabaseSync;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

function addSession(key: string, extra: { merged_into?: string } = {}): void {
  db.prepare(
    `INSERT INTO machines (label, last_heartbeat, collector_version) VALUES ('laptop', ?, 'test')
     ON CONFLICT(label) DO NOTHING`,
  ).run(NOW.toISOString());
  db.prepare(
    `INSERT INTO sessions (key, agent_kind, machine, terminal_id, title, lifecycle, live_status, merged_into, first_seen, last_seen)
     VALUES (?, ?, 'laptop', 'term_1', ?, 'live', 'working', ?, ?, ?)`,
  ).run(key, key.slice(0, key.indexOf(':')), `title of ${key}`, extra.merged_into ?? null, TS1, TS1);
}

let offset = 0;
/** Inserts a chunk and returns its id. */
function addChunk(session_key: string, text: string, extra: { kind?: string; ts_start?: string | null; ts_end?: string | null } = {}): number {
  offset += 1;
  const info = db
    .prepare(
      `INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      session_key,
      extra.kind ?? 'transcript',
      offset,
      offset + 1,
      extra.ts_start === undefined ? TS1 : extra.ts_start,
      extra.ts_end === undefined ? TS2 : extra.ts_end,
      text,
      TS2,
    );
  return Number(info.lastInsertRowid);
}

/** Inserts a digest and returns its id; `json` is stored as given (a string is stored raw). */
function addDigest(session_key: string, chunkIds: unknown, json: unknown): number {
  const info = db
    .prepare(
      `INSERT INTO digests (session_key, chunk_ids, json, model, ts_start, ts_end, backfill, trivial, skipped, curated, created_at)
       VALUES (?, ?, ?, 'm', ?, ?, 0, 0, 0, 0, ?)`,
    )
    .run(
      session_key,
      typeof chunkIds === 'string' ? chunkIds : JSON.stringify(chunkIds),
      json === null ? null : typeof json === 'string' ? json : JSON.stringify(json),
      TS1,
      TS2,
      TS2,
    );
  return Number(info.lastInsertRowid);
}

const DIGEST = {
  topics: [{ label: 'a', summary: 'b', likely_project_ids: [], is_new_topic: true, confidence: 0.5 }],
  decisions: [{ text: '用 SQLite', quote_ref: 'chunk:1' }],
  progress: [],
  todos_added: [],
  todos_done: [],
  blockers: [],
  open_questions: [],
  trivial: false,
};

test('parseEvidenceRef accepts only digest:<n> and chunk:<n> with a positive integer', () => {
  expect(parseEvidenceRef('digest:3')).toEqual({ kind: 'digest', id: 3 });
  expect(parseEvidenceRef('chunk:12')).toEqual({ kind: 'chunk', id: 12 });
  for (const bad of ['chunk:0', 'digest:-1', 'digest:1e3', 'digest:03', 'foo:1', 'digest:', 'chunk:abc', '', 'digest:1 ']) {
    expect(parseEvidenceRef(bad), bad).toBeNull();
  }
});

test('chunk evidence', () => {
  addSession(KEY);
  const id = addChunk(KEY, '你好', { kind: 'transcript' });
  addChunk(KEY, 'other');

  const view = getEvidence(db, NOW, `chunk:${id}`);
  expect(view).not.toBeNull();
  expect(view).toMatchObject({
    ref: `chunk:${id}`,
    kind: 'chunk',
    id,
    session_key: KEY,
    ts_start: TS1,
    ts_end: TS2,
    digest: null,
  });
  expect(view!.session?.short_id).toBe('5d27595b');
  expect(view!.chunks).toEqual([{ id, kind: 'transcript', ts_start: TS1, ts_end: TS2, text: '你好', truncated: false, source: null }]);
});

test('digest evidence carries the parsed digest and its chunks', () => {
  addSession(KEY);
  const a = addChunk(KEY, 'one');
  const b = addChunk(KEY, 'two');
  const id = addDigest(KEY, [b, a], DIGEST);

  const view = getEvidence(db, NOW, `digest:${id}`)!;
  expect(view).toMatchObject({ ref: `digest:${id}`, kind: 'digest', id, session_key: KEY, ts_start: TS1, ts_end: TS2 });
  expect(view.digest).toEqual(DIGEST);
  expect(view.chunks.map((c) => c.id)).toEqual([a, b]);
});

test('digest evidence lists its chunks in id order, capped', () => {
  addSession(KEY);
  const ids = Array.from({ length: 25 }, () => addChunk(KEY, 'x'));
  const shuffled = [...ids].reverse();
  [shuffled[0], shuffled[7]] = [shuffled[7], shuffled[0]];
  const id = addDigest(KEY, shuffled, DIGEST);

  const view = getEvidence(db, NOW, `digest:${id}`)!;
  expect(EVIDENCE_MAX_CHUNKS).toBe(20);
  expect(view.chunks).toHaveLength(20);
  const got = view.chunks.map((c) => c.id);
  expect(got).toEqual([...got].sort((x, y) => x - y));
  expect(got).toEqual(ids.slice(0, 20));
});

test('long chunk text is cut', () => {
  addSession(KEY);
  const long = addChunk(KEY, 'a'.repeat(5000));
  const exact = addChunk(KEY, 'b'.repeat(EVIDENCE_CHUNK_CHARS));
  const short = addChunk(KEY, 'short');

  expect(EVIDENCE_CHUNK_CHARS).toBe(4000);
  const cut = getEvidence(db, NOW, `chunk:${long}`)!.chunks[0];
  expect(cut.text).toHaveLength(4000);
  expect(cut.truncated).toBe(true);
  expect(getEvidence(db, NOW, `chunk:${exact}`)!.chunks[0]).toMatchObject({ truncated: false });
  expect(getEvidence(db, NOW, `chunk:${short}`)!.chunks[0].truncated).toBe(false);
});

test('a cut never leaves half of a surrogate pair', () => {
  addSession(KEY);
  const id = addChunk(KEY, `${'a'.repeat(3999)}😀tail`);
  const cut = getEvidence(db, NOW, `chunk:${id}`)!.chunks[0];
  expect(cut.truncated).toBe(true);
  expect(cut.text).toBe('a'.repeat(3999));
});

test('follows a merged session key', () => {
  const real = 'claude:aaaaaaaa-1111-2222-3333-444444444444';
  const pending = 'pending:laptop:term_1';
  addSession(real);
  addSession(pending, { merged_into: real });
  const id = addChunk(pending, 'before the id was known');

  const view = getEvidence(db, NOW, `chunk:${id}`)!;
  expect(view.session_key).toBe(pending);
  expect(view.session?.key).toBe(real);
});

test('a chunk of a session that no longer exists has session null', () => {
  const id = addChunk('claude:gone-0000', 'orphan');
  const view = getEvidence(db, NOW, `chunk:${id}`)!;
  expect(view.session).toBeNull();
  expect(view.session_key).toBe('claude:gone-0000');
});

test('malformed digest json gives digest null', () => {
  addSession(KEY);
  const c = addChunk(KEY, 'one');
  for (const json of ['{not json', null, '[1,2]', '"text"', 'null']) {
    const id = addDigest(KEY, [c], json);
    const view = getEvidence(db, NOW, `digest:${id}`)!;
    expect(view.digest, String(json)).toBeNull();
    expect(view.chunks.map((x) => x.id)).toEqual([c]);
  }
});

test('malformed chunk_ids give no chunks, and ids that are gone are skipped', () => {
  addSession(KEY);
  const c = addChunk(KEY, 'one');
  expect(getEvidence(db, NOW, `digest:${addDigest(KEY, 'oops', DIGEST)}`)!.chunks).toEqual([]);
  expect(getEvidence(db, NOW, `digest:${addDigest(KEY, [c, 9999, 'x', 1.5], DIGEST)}`)!.chunks.map((x) => x.id)).toEqual([c]);
});

test('unknown or malformed refs give null', () => {
  addSession(KEY);
  expect(getEvidence(db, NOW, 'chunk:999')).toBeNull();
  expect(getEvidence(db, NOW, 'digest:999')).toBeNull();
  expect(getEvidence(db, NOW, 'chunk:abc')).toBeNull();
});
