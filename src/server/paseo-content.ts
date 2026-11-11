import type { TimelineEvent, ToolInfo, Truncation } from '../shared/ingest-v2.ts';

// How preserved Paseo timeline events become chunk text for the understanding layer. The source events keep the
// collector's bounded copy (64 KiB of message text, 16 KiB of tool input/output); the chunk text is a smaller excerpt
// per event, so one long tool output cannot fill an analysis window. Every cut is marked with what was left out, and a
// cut made upstream (by the collector) is marked too: excerpts never pass for the whole text.

/** Most characters of one user/assistant message in chunk text. */
export const DIGEST_MESSAGE_CHARS = 8000;
/** Most characters of a tool's input summary in chunk text. */
export const DIGEST_TOOL_INPUT_CHARS = 600;
/** Most characters of a tool's output in chunk text. */
export const DIGEST_TOOL_OUTPUT_CHARS = 2000;
/** Most characters of one chunk (as herdr's MAX_CHUNK_CHARS). */
export const PASEO_CHUNK_CHARS = 48000;

function safeEnd(s: string, end: number): number {
  const c = s.charCodeAt(end - 1);
  return c >= 0xd800 && c <= 0xdbff ? end - 1 : end;
}
function safeStart(s: string, start: number): number {
  const c = s.charCodeAt(start);
  return c >= 0xdc00 && c <= 0xdfff ? start + 1 : start;
}

/** The text cut to about `max` UTF-16 units, keeping its head and tail, never splitting a surrogate pair. */
export function headTail(text: string, max: number): { text: string; omitted: number } {
  if (text.length <= max) return { text, omitted: 0 };
  const headLen = safeEnd(text, Math.floor(max * 0.6));
  const tailStart = safeStart(text, text.length - (max - Math.floor(max * 0.6)));
  const omitted = tailStart - headLen;
  return { text: `${text.slice(0, headLen)}\n…[中间省略 ${omitted} 字符]…\n${text.slice(tailStart)}`, omitted };
}

function upstreamNote(t: Truncation): string {
  return t === null ? '' : ` …[采集时已截断：原长 ${t.original_chars} 字符，保留 ${t.kept_chars}]`;
}

function minuteStamp(ts: string | null): string {
  if (ts === null) return '[时间未知]';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? `[${ts}]` : `[${d.toISOString().slice(0, 16)}Z]`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A tool's outcome as words: a failed call or a non-zero exit code is never shown as success. */
export function toolOutcome(tool: ToolInfo): string {
  if (tool.status === 'running') return '未完成';
  if (tool.status === 'canceled') return '已取消';
  if (tool.status === 'failed') return tool.exit_code !== null ? `失败(exit ${tool.exit_code})` : '失败';
  if (tool.exit_code !== null && tool.exit_code !== 0) return `失败(exit ${tool.exit_code})`;
  return tool.exit_code === 0 ? '成功(exit 0)' : '完成';
}

/** One event as chunk text. `continuation` renders only the part a revision appended to text already delivered. */
export function renderEvent(e: Pick<TimelineEvent, 'kind' | 'ts' | 'text' | 'text_truncated' | 'tool' | 'item_type'>, continuation?: string): string {
  const ts = minuteStamp(e.ts);
  if (e.kind === 'tool' && e.tool !== null) {
    const input = headTail(oneLine(e.tool.input), DIGEST_TOOL_INPUT_CHARS).text;
    const head = `${ts} tool: ${e.tool.name}${input ? ` ${input}` : ''}${upstreamNote(e.tool.input_truncated)} → ${toolOutcome(e.tool)}`;
    const error = e.tool.error ? `\n  错误：${headTail(e.tool.error, DIGEST_TOOL_OUTPUT_CHARS).text}` : '';
    const output = e.tool.output.trim() === '' ? '' : `\n  输出：${headTail(e.tool.output, DIGEST_TOOL_OUTPUT_CHARS).text}${upstreamNote(e.tool.output_truncated)}`;
    return head + error + output;
  }
  const role = e.kind === 'user' || e.kind === 'assistant' ? e.kind : e.kind === 'error' ? 'error' : 'notice';
  if (continuation !== undefined) return `${ts} ${role}（续）: ${headTail(continuation, DIGEST_MESSAGE_CHARS).text}${upstreamNote(e.text_truncated)}`;
  return `${ts} ${role}: ${headTail(e.text, DIGEST_MESSAGE_CHARS).text}${upstreamNote(e.text_truncated)}`;
}

/** Lines packed into chunks of at most `max` characters, in order; a single line longer than `max` goes alone. */
export function packLines<T extends { text: string }>(lines: T[], max = PASEO_CHUNK_CHARS): T[][] {
  const groups: T[][] = [];
  let size = 0;
  for (const line of lines) {
    const cur = groups.at(-1);
    if (cur !== undefined && size + 1 + line.text.length <= max) {
      cur.push(line);
      size += 1 + line.text.length;
    } else {
      groups.push([line]);
      size = line.text.length;
    }
  }
  return groups;
}
