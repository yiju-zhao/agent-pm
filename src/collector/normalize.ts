export type Entry = { ts: string; role: 'user' | 'assistant' | 'tool'; text: string };

export type TranscriptChunk = {
  offset_start: number;
  offset_end: number;
  ts_start: string;
  ts_end: string;
  text: string;
};

export const MAX_ENTRY_CHARS = 4000;
export const MAX_TOOL_SUMMARY_CHARS = 200;
export const MAX_CHUNK_CHARS = 48000;

const TRUNCATION_MARKER = '…[已截断]';
const ENV_CONTEXT_PREFIX = '<environment_context>';

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keeps the first `max` UTF-16 units (never half a surrogate pair) and appends the marker if anything was cut. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end) + TRUNCATION_MARKER;
}

function parseRecord(line: string): Rec | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  return isRec(v) ? v : null;
}

/** The record's top-level `timestamp` if it is a string `Date` can read; records without one are not usable. */
function usableTs(rec: Rec): string | null {
  const ts = rec.timestamp;
  return typeof ts === 'string' && !Number.isNaN(Date.parse(ts)) ? ts : null;
}

function textEntry(ts: string, role: 'user' | 'assistant', text: string): Entry | null {
  if (text.trim() === '') return null;
  return { ts, role, text: truncate(text, MAX_ENTRY_CHARS) };
}

function toolEntry(ts: string, name: unknown, args: unknown): Entry | null {
  if (typeof name !== 'string' || name === '') return null;
  const raw = typeof args === 'string' ? args : (JSON.stringify(args) ?? '');
  const text = `${name}: ${truncate(raw, MAX_TOOL_SUMMARY_CHARS)}`;
  return { ts, role: 'tool', text: truncate(text, MAX_ENTRY_CHARS) };
}

function blocks(content: unknown): Rec[] {
  return Array.isArray(content) ? content.filter(isRec) : [];
}

function blockText(b: Rec): string | null {
  return typeof b.text === 'string' ? b.text : null;
}

/**
 * Keeps user text, assistant text and one-line tool_use summaries from Claude Code transcript lines.
 * Thinking, tool_result and every other record type are dropped; unparsable lines are skipped.
 */
export function normalizeClaude(lines: string[]): Entry[] {
  const out: Entry[] = [];
  const push = (e: Entry | null) => {
    if (e) out.push(e);
  };

  for (const line of lines) {
    const rec = parseRecord(line);
    if (!rec) continue;
    const ts = usableTs(rec);
    if (ts === null) continue;
    const content = isRec(rec.message) ? rec.message.content : undefined;

    if (rec.type === 'user') {
      if (typeof content === 'string') {
        push(textEntry(ts, 'user', content));
      } else {
        const texts = blocks(content)
          .filter((b) => b.type === 'text')
          .map(blockText)
          .filter((t): t is string => t !== null);
        if (texts.length > 0) push(textEntry(ts, 'user', texts.join('\n')));
      }
    } else if (rec.type === 'assistant') {
      for (const b of blocks(content)) {
        if (b.type === 'text') {
          const t = blockText(b);
          if (t !== null) push(textEntry(ts, 'assistant', t));
        } else if (b.type === 'tool_use') {
          push(toolEntry(ts, b.name, b.input));
        }
      }
    }
  }
  return out;
}

/**
 * Keeps user text, assistant text and one-line tool call summaries from Codex rollout lines.
 * Developer messages, environment_context, reasoning, tool outputs and all non-response_item records are dropped.
 */
export function normalizeCodex(lines: string[]): Entry[] {
  const out: Entry[] = [];
  const push = (e: Entry | null) => {
    if (e) out.push(e);
  };

  for (const line of lines) {
    const rec = parseRecord(line);
    if (!rec || rec.type !== 'response_item') continue;
    const ts = usableTs(rec);
    if (ts === null || !isRec(rec.payload)) continue;
    const p = rec.payload;

    if (p.type === 'message') {
      if (p.role === 'user') {
        const texts = blocks(p.content)
          .filter((b) => b.type === 'input_text')
          .map(blockText)
          .filter((t): t is string => t !== null && !t.trimStart().startsWith(ENV_CONTEXT_PREFIX));
        if (texts.length > 0) push(textEntry(ts, 'user', texts.join('\n')));
      } else if (p.role === 'assistant') {
        for (const b of blocks(p.content)) {
          if (b.type !== 'output_text') continue;
          const t = blockText(b);
          if (t !== null) push(textEntry(ts, 'assistant', t));
        }
      }
    } else if (p.type === 'function_call') {
      push(toolEntry(ts, p.name, p.arguments));
    } else if (p.type === 'custom_tool_call') {
      push(toolEntry(ts, p.name, p.input));
    }
  }
  return out;
}

/** `[YYYY-MM-DDTHH:MMZ]` (UTC, minute precision); an unparsable ts is shown as-is rather than throwing. */
function minuteStamp(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : `${d.toISOString().slice(0, 16)}Z`;
}

/**
 * Packs entries into text chunks of at most `maxChunkChars`, one `[ts] role: text` line per entry,
 * never splitting an entry across chunks (a single line longer than the limit is cut with the marker).
 *
 * `offsetStart`/`offsetEnd` are the byte range of the read that produced the entries. The server dedups on
 * `(session_key, offset_start)` and resumes from `max(offset_end)`, so chunk i gets
 * `offset_start = offsetStart * 1000 + i` (also when there is only one chunk) and only the last chunk
 * carries the real `offset_end`; the others use `offsetStart`.
 */
export function buildChunks(
  entries: Entry[],
  offsetStart: number,
  offsetEnd: number,
  opts: { maxChunkChars: number },
): TranscriptChunk[] {
  const { maxChunkChars } = opts;
  const groups: { lines: string[]; length: number; first: Entry; last: Entry }[] = [];

  for (const entry of entries) {
    const full = `[${minuteStamp(entry.ts)}] ${entry.role}: ${entry.text}`;
    const line =
      full.length <= maxChunkChars ? full : truncate(full, maxChunkChars - TRUNCATION_MARKER.length);
    const cur = groups.at(-1);
    if (cur && cur.length + 1 + line.length <= maxChunkChars) {
      cur.lines.push(line);
      cur.length += 1 + line.length;
      cur.last = entry;
    } else {
      groups.push({ lines: [line], length: line.length, first: entry, last: entry });
    }
  }

  return groups.map((g, i) => ({
    offset_start: offsetStart * 1000 + i,
    offset_end: i === groups.length - 1 ? offsetEnd : offsetStart,
    ts_start: g.first.ts,
    ts_end: g.last.ts,
    text: g.lines.join('\n'),
  }));
}
