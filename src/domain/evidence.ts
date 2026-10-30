import type { DatabaseSync } from 'node:sqlite';
import { getSession } from '../server/sessions-repo.ts';
import type { SessionView } from '../server/sessions-repo.ts';
import type { Digest } from '../understand/digest.ts';

/** A digest shows at most this many of its chunks, lowest id first. */
export const EVIDENCE_MAX_CHUNKS = 20;
/** A chunk's text is cut to this many characters. */
export const EVIDENCE_CHUNK_CHARS = 4000;

export type EvidenceChunk = {
  id: number;
  kind: string;
  ts_start: string | null;
  ts_end: string | null;
  text: string;
  truncated: boolean;
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

type ChunkRaw = { id: number; session_key: string; kind: string; ts_start: string | null; ts_end: string | null; text: string | null };
type DigestRaw = { id: number; session_key: string; chunk_ids: string | null; json: string | null; ts_start: string | null; ts_end: string | null };

/** Only `digest:<n>` and `chunk:<n>` with `n` a positive integer written without sign, zeros or exponent. */
export function parseEvidenceRef(ref: string): { kind: 'digest' | 'chunk'; id: number } | null {
  const m = /^(digest|chunk):([1-9][0-9]*)$/.exec(ref);
  if (m === null) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) ? { kind: m[1] as 'digest' | 'chunk', id } : null;
}

const CHUNK_COLUMNS = 'id, session_key, kind, ts_start, ts_end, text';

/** The text cut to `EVIDENCE_CHUNK_CHARS`, without leaving half of a surrogate pair at the end. */
function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= EVIDENCE_CHUNK_CHARS) return { text, truncated: false };
  let end = EVIDENCE_CHUNK_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function chunkView(r: ChunkRaw): EvidenceChunk {
  return { id: r.id, kind: r.kind, ts_start: r.ts_start, ts_end: r.ts_end, ...cut(r.text ?? '') };
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
      chunks: [chunkView(chunk)],
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
    chunks: chunks.map(chunkView),
  };
}
