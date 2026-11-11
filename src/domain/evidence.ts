import type { DatabaseSync } from 'node:sqlite';
import { getSession } from '../server/sessions-repo.ts';
import type { SessionView } from '../server/sessions-repo.ts';
import type { Digest } from '../understand/digest.ts';

/** A digest shows at most this many of its chunks, lowest id first. */
export const EVIDENCE_MAX_CHUNKS = 20;
/** A chunk's text is cut to this many characters. */
export const EVIDENCE_CHUNK_CHARS = 4000;

/**
 * Where a chunk came from. A herdr chunk: its source (`herdr:<machine>`). A Paseo chunk: its source, the Paseo agent id
 * (not the provider's session id), the timeline epoch and seq range of the events in it, how many there are, and
 * whether any of them was already cut by the collector or had no timestamp of its own. `null` for chunks that predate
 * sources (and `report` chunks).
 */
export type EvidenceSource = {
  source_id: string;
  kind: 'herdr' | 'paseo';
  agent_id: string | null;
  epoch: string | null;
  seq_start: number | null;
  seq_end: number | null;
  events: number;
  truncated_upstream: boolean;
  ts_unknown: boolean;
};

export type EvidenceChunk = {
  id: number;
  kind: string;
  ts_start: string | null;
  ts_end: string | null;
  text: string;
  /** The text shown here was cut to `EVIDENCE_CHUNK_CHARS`. */
  truncated: boolean;
  source: EvidenceSource | null;
};

export type EvidenceView = {
  ref: string;
  kind: 'digest' | 'chunk';
  id: number;
  /** The key recorded on the chunk or digest; `session` is the session it is known by now. */
  session_key: string;
  session: SessionView | null;
  ts_start: string | null;
  ts_end: string | null;
  /** Always `null` for a chunk, and when the digest's JSON cannot be read. */
  digest: Digest | null;
  /** A chunk: itself. A digest: the first `EVIDENCE_MAX_CHUNKS` of its `chunk_ids` by id. */
  chunks: EvidenceChunk[];
};

type ChunkRaw = { id: number; session_key: string; kind: string; ts_start: string | null; ts_end: string | null; text: string | null; source_id: string | null };
type DigestRaw = { id: number; session_key: string; chunk_ids: string | null; json: string | null; ts_start: string | null; ts_end: string | null };

/** Only `digest:<n>` and `chunk:<n>` with `n` a positive integer written without sign, zeros or exponent. */
export function parseEvidenceRef(ref: string): { kind: 'digest' | 'chunk'; id: number } | null {
  const m = /^(digest|chunk):([1-9][0-9]*)$/.exec(ref);
  if (m === null) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) ? { kind: m[1] as 'digest' | 'chunk', id } : null;
}

const CHUNK_COLUMNS = 'id, session_key, kind, ts_start, ts_end, text, source_id';

/** The text cut to `EVIDENCE_CHUNK_CHARS`, without leaving half of a surrogate pair at the end. */
function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= EVIDENCE_CHUNK_CHARS) return { text, truncated: false };
  let end = EVIDENCE_CHUNK_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function chunkSource(db: DatabaseSync, r: ChunkRaw): EvidenceSource | null {
  if (r.source_id === null) return null;
  if (r.source_id.startsWith('herdr:')) {
    return { source_id: r.source_id, kind: 'herdr', agent_id: null, epoch: null, seq_start: null, seq_end: null, events: 0, truncated_upstream: false, ts_unknown: false };
  }
  const events = db
    .prepare(
      `SELECT e.stream_id, e.epoch, e.seq_start, e.seq_end, e.ts_known, e.meta FROM chunk_sources cs
       JOIN source_events e ON e.id = cs.source_event_id WHERE cs.chunk_id = ? ORDER BY e.seq_start, e.id`,
    )
    .all(r.id) as Array<{ stream_id: string; epoch: string | null; seq_start: number | null; seq_end: number | null; ts_known: number; meta: string | null }>;
  const truncated = (meta: string | null): boolean => {
    try {
      const m = JSON.parse(meta ?? '{}') as { text_truncated?: unknown; tool?: { input_truncated?: unknown; output_truncated?: unknown } | null };
      return m.text_truncated != null || m.tool?.input_truncated != null || m.tool?.output_truncated != null;
    } catch {
      return false;
    }
  };
  const seqs = events.flatMap((e) => [e.seq_start, e.seq_end]).filter((n): n is number => n !== null);
  return {
    source_id: r.source_id,
    kind: 'paseo',
    agent_id: events[0]?.stream_id ?? null,
    epoch: events[0]?.epoch ?? null,
    seq_start: seqs.length ? Math.min(...seqs) : null,
    seq_end: seqs.length ? Math.max(...seqs) : null,
    events: events.length,
    truncated_upstream: events.some((e) => truncated(e.meta)),
    ts_unknown: events.some((e) => e.ts_known === 0),
  };
}

function chunkView(db: DatabaseSync, r: ChunkRaw): EvidenceChunk {
  return { id: r.id, kind: r.kind, ts_start: r.ts_start, ts_end: r.ts_end, ...cut(r.text ?? ''), source: chunkSource(db, r) };
}

/** The digest JSON as an object; `null` when it is missing, not JSON, or not an object. */
function parseDigest(text: string | null): Digest | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Digest) : null;
  } catch {
    return null;
  }
}

/** The positive integers in a JSON array column, lowest first, without repeats; anything else counts as empty. */
function chunkIds(text: string | null): number[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((v): v is number => Number.isSafeInteger(v) && (v as number) > 0);
    return [...new Set(ids)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * What a `digest:<id>` or `chunk:<id>` reference points at, with the session it came from (following a merged key) and
 * the conversation text, so the page can show the source of a decision. `null` when the reference is malformed or
 * names nothing. Text is cut to `EVIDENCE_CHUNK_CHARS` per chunk; nothing is written.
 */
export function getEvidence(db: DatabaseSync, now: Date, ref: string): EvidenceView | null {
  const parsed = parseEvidenceRef(ref);
  if (parsed === null) return null;

  if (parsed.kind === 'chunk') {
    const chunk = db.prepare(`SELECT ${CHUNK_COLUMNS} FROM chunks WHERE id = ?`).get(parsed.id) as ChunkRaw | undefined;
    if (chunk === undefined) return null;
    return {
      ref,
      kind: 'chunk',
      id: chunk.id,
      session_key: chunk.session_key,
      session: getSession(db, chunk.session_key, now),
      ts_start: chunk.ts_start,
      ts_end: chunk.ts_end,
      digest: null,
      chunks: [chunkView(db, chunk)],
    };
  }

  const digest = db
    .prepare('SELECT id, session_key, chunk_ids, json, ts_start, ts_end FROM digests WHERE id = ?')
    .get(parsed.id) as DigestRaw | undefined;
  if (digest === undefined) return null;

  const ids = chunkIds(digest.chunk_ids).slice(0, EVIDENCE_MAX_CHUNKS);
  const chunks =
    ids.length === 0
      ? []
      : (db
          .prepare(`SELECT ${CHUNK_COLUMNS} FROM chunks WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`)
          .all(...ids) as ChunkRaw[]);
  return {
    ref,
    kind: 'digest',
    id: digest.id,
    session_key: digest.session_key,
    session: getSession(db, digest.session_key, now),
    ts_start: digest.ts_start,
    ts_end: digest.ts_end,
    digest: parseDigest(digest.json),
    chunks: chunks.map((c) => chunkView(db, c)),
  };
}
