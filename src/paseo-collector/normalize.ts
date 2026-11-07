import type { TimelineEvent, ToolInfo, Truncation } from '../shared/ingest-v2.ts';
import type { TimelineEntry } from './sdk.ts';

// Projected Paseo timeline rows → bounded, source-located events (the v2 `TimelineEvent`). Kept: user and assistant
// text, tool calls with their input, result, failure and exit code, errors and notices. Dropped (and only counted):
// reasoning, plugin items and any row kind this version does not know; an unknown shape is never passed off as parsed
// content. Long text keeps its head and tail with an explicit marker, and says how long it was.

/** Most UTF-16 units kept of one user or assistant message. */
export const MAX_MESSAGE_CHARS = 64 * 1024;
/** Most UTF-16 units kept of a tool's input and of its output, each. */
export const MAX_TOOL_CHARS = 16 * 1024;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `text` cut to about `max` units keeping head and tail, never splitting a surrogate pair, with what was cut. */
export function bound(text: string, max: number): { text: string; truncated: Truncation } {
  if (text.length <= max) return { text, truncated: null };
  const marker = (n: number) => `\n…[省略 ${n} 字符]…\n`;
  const budget = max - marker(text.length).length;
  let headEnd = Math.floor(budget * 0.6);
  if (text.charCodeAt(headEnd - 1) >= 0xd800 && text.charCodeAt(headEnd - 1) <= 0xdbff) headEnd -= 1;
  let tailStart = text.length - (budget - Math.floor(budget * 0.6));
  if (text.charCodeAt(tailStart) >= 0xdc00 && text.charCodeAt(tailStart) <= 0xdfff) tailStart += 1;
  const kept = headEnd + (text.length - tailStart);
  return { text: `${text.slice(0, headEnd)}${marker(tailStart - headEnd)}${text.slice(tailStart)}`, truncated: { original_chars: text.length, kept_chars: kept } };
}

function json(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** A tool's input summary and output as text, by detail type; unknown detail types fall back to their JSON. */
function toolText(detail: Rec): { input: string; output: string; exitCode: number | null } {
  const exitCode = typeof detail.exitCode === 'number' ? detail.exitCode : null;
  switch (detail.type) {
    case 'shell':
      return { input: str(detail.command), output: str(detail.output), exitCode };
    case 'read':
      return { input: str(detail.filePath), output: str(detail.content), exitCode };
    case 'edit':
      return { input: str(detail.filePath), output: str(detail.unifiedDiff) || [str(detail.oldString), str(detail.newString)].filter(Boolean).join('\n→\n'), exitCode };
    case 'write':
      return { input: str(detail.filePath), output: str(detail.content), exitCode };
    case 'search':
      return { input: str(detail.query), output: str(detail.content) || (Array.isArray(detail.filePaths) ? detail.filePaths.join('\n') : ''), exitCode };
    case 'fetch':
      return { input: str(detail.url), output: str(detail.result), exitCode };
    case 'sub_agent':
      return { input: [str(detail.subAgentType), str(detail.description)].filter(Boolean).join(': '), output: str(detail.log), exitCode };
    case 'plain_text':
      return { input: str(detail.label), output: str(detail.text), exitCode };
    case 'plan':
      return { input: '', output: str(detail.text), exitCode };
    case 'unknown':
      return { input: json(detail.input), output: json(detail.output), exitCode };
    default:
      return { input: json({ ...detail, type: undefined }), output: '', exitCode };
  }
}

function errorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') return error;
  if (isRec(error)) {
    if (typeof error.message === 'string') return error.message;
    if (typeof error.content === 'string') return error.content;
    if (Array.isArray(error.content)) return error.content.map((c) => (isRec(c) && typeof c.text === 'string' ? c.text : json(c))).join('\n');
  }
  return json(error);
}

const TOOL_STATUSES = new Set(['running', 'completed', 'failed', 'canceled']);

export type Normalized = { event: TimelineEvent } | { filtered: string };

/**
 * One projected row as an event, or the item type it was filtered as. `epoch` is the page's epoch. `backfill` says
 * whether the row predates this collector run (by the row's own timestamp; a row without one counts as backfill, and
 * its `ts` stays null rather than becoming the time it was read).
 */
export function normalizeEntry(entry: TimelineEntry, epoch: string, startedAt: Date): Normalized {
  const item = entry.item as Rec & { type: string };
  const tsOk = typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp));
  const ts = tsOk ? new Date(entry.timestamp).toISOString() : null;
  const rowKey = `row:${epoch}:${entry.seqStart}:${item.type}`;
  const base = {
    item_type: item.type,
    epoch,
    seq_start: entry.seqStart,
    seq_end: entry.seqEnd,
    ts,
    backfill: ts === null || Date.parse(ts) < startedAt.getTime(),
    tool: null,
  };
  const message = (kind: 'user' | 'assistant' | 'error' | 'notice', raw: string, id?: unknown): Normalized => {
    if (raw.trim() === '') return { filtered: `${item.type}:empty` };
    const b = bound(raw, MAX_MESSAGE_CHARS);
    const stable = typeof id === 'string' && id !== '';
    return { event: { ...base, key: stable ? `msg:${id}` : rowKey, stable_id: stable, kind, text: b.text, text_truncated: b.truncated } };
  };

  switch (item.type) {
    case 'user_message':
      return message('user', str(item.text), item.messageId);
    case 'assistant_message':
      return message('assistant', str(item.text), item.messageId);
    case 'error':
      return message('error', str(item.message));
    case 'notification':
      return message('notice', `${str(item.level)}: ${str(item.message)}`);
    case 'compaction':
      return item.status === 'completed' ? message('notice', '上下文已压缩') : { filtered: 'compaction:loading' };
    case 'todo': {
      const items = Array.isArray(item.items) ? item.items.filter(isRec) : [];
      return message('notice', items.map((t) => `${t.completed === true || t.status === 'completed' ? '[x]' : '[ ]'} ${str(t.text)}`).join('\n'));
    }
    case 'tool_call': {
      const callId = str(item.callId);
      const status = str(item.status);
      if (!isRec(item.detail) || !TOOL_STATUSES.has(status) || str(item.name) === '') return { filtered: 'tool_call:unrecognized' };
      const t = toolText(item.detail);
      const input = bound(t.input, MAX_TOOL_CHARS);
      const output = bound(t.output, MAX_TOOL_CHARS);
      const err = errorText(item.error);
      const tool: ToolInfo = {
        name: str(item.name).slice(0, 200),
        status: status as ToolInfo['status'],
        exit_code: t.exitCode,
        input: input.text,
        input_truncated: input.truncated,
        output: output.text,
        output_truncated: output.truncated,
        error: err === null ? null : bound(err, MAX_TOOL_CHARS).text,
      };
      return {
        event: { ...base, key: callId ? `tool:${callId}` : rowKey, stable_id: callId !== '', kind: 'tool', text: '', text_truncated: null, tool },
      };
    }
    default:
      // reasoning, plugin and anything newer than this collector.
      return { filtered: item.type };
  }
}

/**
 * Whether a row may still change: a tool call that is still running, or the last row of an agent whose turn is still
 * active (projected assistant text and reasoning keep growing until the turn ends). Such rows are held back: they are
 * not delivered yet and the committed position stops before them.
 */
export function isUnsettled(entry: TimelineEntry, isLastRow: boolean, turnActive: boolean): boolean {
  if (entry.item.type === 'tool_call' && entry.item.status === 'running') return true;
  return isLastRow && turnActive;
}
