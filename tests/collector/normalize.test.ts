import { expect, test } from 'vitest';
import {
  buildChunks,
  MAX_CHUNK_CHARS,
  MAX_ENTRY_CHARS,
  MAX_TOOL_SUMMARY_CHARS,
  normalizeClaude,
  normalizeCodex,
} from '../../src/collector/normalize.ts';
import type { Entry } from '../../src/collector/normalize.ts';

const MARKER = '…[已截断]';
const T1 = '2026-10-29T08:01:02.345Z';
const T2 = '2026-10-29T08:02:03.456Z';
const T3 = '2026-10-29T08:03:04.567Z';

// ---- synthetic Claude lines -------------------------------------------------

const claudeLine = (type: string, message: unknown, timestamp: string | undefined = T1) =>
  JSON.stringify({ type, timestamp, message });
const userStr = (text: string, ts = T1) => claudeLine('user', { role: 'user', content: text }, ts);
const userBlocks = (content: unknown[], ts = T1) =>
  claudeLine('user', { role: 'user', content }, ts);
const userToolResult = (output: string, ts = T1) =>
  userBlocks([{ type: 'tool_result', tool_use_id: 't1', content: output }], ts);
const asst = (content: unknown[], ts = T1) => claudeLine('assistant', { role: 'assistant', content }, ts);
const asstText = (text: string, ts = T1) => asst([{ type: 'text', text }], ts);
const asstThinking = (text: string, ts = T1) => asst([{ type: 'thinking', thinking: text }], ts);
const asstToolUse = (name: string, input: unknown, ts = T1) =>
  asst([{ type: 'tool_use', id: 't1', name, input }], ts);

// ---- synthetic Codex lines --------------------------------------------------

const codexLine = (payload: unknown, timestamp = T1, type = 'response_item') =>
  JSON.stringify({ timestamp, type, payload });
const cxMessage = (role: string, blockType: string, texts: string[], ts = T1) =>
  codexLine({ type: 'message', role, content: texts.map((text) => ({ type: blockType, text })) }, ts);
const cxUser = (text: string, ts = T1) => cxMessage('user', 'input_text', [text], ts);
const cxAsst = (text: string, ts = T1) => cxMessage('assistant', 'output_text', [text], ts);
const cxCall = (name: string, args: string, ts = T1) =>
  codexLine({ type: 'function_call', name, arguments: args, call_id: 'c1' }, ts);
const cxCustom = (name: string, input: string, ts = T1) =>
  codexLine({ type: 'custom_tool_call', name, input, call_id: 'c2', status: 'completed' }, ts);

const pairs = (entries: Entry[]) => entries.map((e) => [e.role, e.text]);

// ---- normalizeClaude --------------------------------------------------------

test('claude: keeps user text, assistant text, tool_use summary; drops thinking and tool_result', () => {
  const e = normalizeClaude([
    userStr('帮我整理目录'),
    asstThinking('...'),
    asstToolUse('Bash', { command: 'ls' }),
    userToolResult('x'.repeat(10000)),
    asstText('好的'),
  ]);
  expect(pairs(e)).toEqual([
    ['user', '帮我整理目录'],
    ['tool', 'Bash: {"command":"ls"}'],
    ['assistant', '好的'],
  ]);
});

test('claude: entry ts is the record top-level timestamp, unchanged', () => {
  const e = normalizeClaude([userStr('a', T1), asstText('b', T2), asstToolUse('Read', {}, T3)]);
  expect(e.map((x) => x.ts)).toEqual([T1, T2, T3]);
});

test('claude: user record with only tool_result blocks yields nothing; text blocks are kept and joined', () => {
  expect(normalizeClaude([userBlocks([{ type: 'tool_result', content: 'out' }, { type: 'tool_result', content: 'out2' }])])).toEqual([]);
  const e = normalizeClaude([
    userBlocks([
      { type: 'tool_result', content: 'out' },
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ]),
  ]);
  expect(pairs(e)).toEqual([['user', '第一段\n第二段']]);
});

test('claude: an assistant record with several blocks yields one entry per text/tool_use block, in order', () => {
  const e = normalizeClaude([
    asst([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: '先看一下' },
      { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/a' } },
      { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'x' } },
      { type: 'text', text: '看完了' },
    ]),
  ]);
  expect(pairs(e)).toEqual([
    ['assistant', '先看一下'],
    ['tool', 'Read: {"file_path":"/a"}'],
    ['tool', 'Grep: {"pattern":"x"}'],
    ['assistant', '看完了'],
  ]);
});

test('claude: non-conversation record types are dropped', () => {
  const lines = [
    JSON.stringify({ type: 'attachment', timestamp: T1, attachment: { type: 'x' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'hello' }),
    JSON.stringify({ type: 'mode', mode: 'default' }),
    JSON.stringify({ type: 'api-request-foo', timestamp: T1 }),
    JSON.stringify({ type: 'system', timestamp: T1, content: 'x' }),
    userStr('留下'),
  ];
  expect(pairs(normalizeClaude(lines))).toEqual([['user', '留下']]);
});

test('claude: records without a usable timestamp are skipped', () => {
  const e = normalizeClaude([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'no ts' } }),
    claudeLine('user', { role: 'user', content: 'bad ts' }, 'yesterday-ish'),
    JSON.stringify({ type: 'user', timestamp: 12345, message: { role: 'user', content: 'numeric ts' } }),
    userStr('ok'),
  ]);
  expect(pairs(e)).toEqual([['user', 'ok']]);
});

test('claude: blank text is not an entry', () => {
  expect(normalizeClaude([userStr(''), userStr('   \n'), asstText('  ')])).toEqual([]);
});

test('claude: malformed records are skipped, never thrown', () => {
  const lines = [
    '',
    'not json',
    '{"type":"user"',
    '42',
    'null',
    '[]',
    '"str"',
    '{"type":"brand-new-type"}',
    '{}',
    JSON.stringify({ type: 'user', timestamp: T1 }),
    JSON.stringify({ type: 'user', timestamp: T1, message: null }),
    JSON.stringify({ type: 'user', timestamp: T1, message: { content: 42 } }),
    JSON.stringify({ type: 'user', timestamp: T1, message: { content: [null, 1, 'x', { type: 'text' }, { type: 'text', text: 5 }] } }),
    JSON.stringify({ type: 'assistant', timestamp: T1, message: { content: 'plain string' } }),
    JSON.stringify({ type: 'assistant', timestamp: T1, message: { content: [{ type: 'tool_use', input: {} }] } }),
    JSON.stringify({ type: 'assistant', timestamp: T1, message: { content: [null, 7, { type: 'tool_use', name: 5 }] } }),
    userStr('hi'),
  ];
  expect(normalizeClaude(lines)).toHaveLength(1);
});

test('bad json lines and unknown record types are skipped', () => {
  expect(normalizeClaude(['not json', '{"type":"brand-new-type"}', userStr('hi')])).toHaveLength(1);
  expect(normalizeCodex(['not json', '{"type":"brand-new-type"}', cxUser('hi')])).toHaveLength(1);
});

test('long entry is truncated to MAX_ENTRY_CHARS with marker', () => {
  const [e] = normalizeClaude([asstText('x'.repeat(50000))]);
  expect(e!.text.length).toBeLessThanOrEqual(4000 + 20);
  expect(e!.text.endsWith('…[已截断]')).toBe(true);
  expect(e!.text).toBe('x'.repeat(MAX_ENTRY_CHARS) + MARKER);
});

test('entry exactly MAX_ENTRY_CHARS long is not truncated', () => {
  const [e] = normalizeClaude([userStr('y'.repeat(MAX_ENTRY_CHARS))]);
  expect(e!.text).toBe('y'.repeat(MAX_ENTRY_CHARS));
});

test('truncation does not split a surrogate pair', () => {
  // 1 + 2k units: the MAX_ENTRY_CHARS boundary falls between the halves of an emoji.
  const [e] = normalizeClaude([userStr('a' + '😀'.repeat(3000))]);
  expect(e!.text.endsWith(MARKER)).toBe(true);
  expect(e!.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(e!.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test('tool summary: the part after "<name>: " is cut to MAX_TOOL_SUMMARY_CHARS and marked', () => {
  const [e] = normalizeClaude([asstToolUse('Bash', { command: 'z'.repeat(500) })]);
  const full = JSON.stringify({ command: 'z'.repeat(500) });
  expect(e!.role).toBe('tool');
  expect(e!.text).toBe('Bash: ' + full.slice(0, MAX_TOOL_SUMMARY_CHARS) + MARKER);
  expect(MAX_TOOL_SUMMARY_CHARS).toBe(200);
});

test('tool summary exactly MAX_TOOL_SUMMARY_CHARS long is not marked', () => {
  const pad = 'q'.repeat(MAX_TOOL_SUMMARY_CHARS - JSON.stringify({ c: '' }).length);
  const [e] = normalizeClaude([asstToolUse('T', { c: pad })]);
  expect(e!.text).toBe('T: ' + JSON.stringify({ c: pad }));
  expect(e!.text.endsWith(MARKER)).toBe(false);
});

test('claude: tool_use without input still yields a summary line', () => {
  const [e] = normalizeClaude([asst([{ type: 'tool_use', name: 'TodoRead' }])]);
  expect(e!.text).toBe('TodoRead: ');
});

// ---- normalizeCodex ---------------------------------------------------------

test('codex: skips developer and environment_context, keeps output_text and function_call', () => {
  const e = normalizeCodex([
    cxMessage('developer', 'input_text', ['系统提示']),
    cxUser('<environment_context>\n<cwd>/x</cwd>\n</environment_context>'),
    cxUser('修一下这个 bug', T1),
    codexLine({ type: 'reasoning', summary: [], content: null, encrypted_content: 'zzz' }, T1),
    cxCall('shell', '{"command":["ls"]}', T2),
    codexLine({ type: 'function_call_output', call_id: 'c1', output: 'o'.repeat(5000) }, T2),
    cxAsst('已修复', T3),
  ]);
  expect(pairs(e)).toEqual([
    ['user', '修一下这个 bug'],
    ['tool', 'shell: {"command":["ls"]}'],
    ['assistant', '已修复'],
  ]);
  expect(e.map((x) => x.ts)).toEqual([T1, T2, T3]);
});

test('codex: environment_context check ignores leading whitespace; other blocks of the message are kept', () => {
  const e = normalizeCodex([
    cxMessage('user', 'input_text', ['  \n<environment_context>x</environment_context>', '真正的问题', '续']),
  ]);
  expect(pairs(e)).toEqual([['user', '真正的问题\n续']]);
  expect(normalizeCodex([cxUser('\n\t <environment_context>only</environment_context>')])).toEqual([]);
});

test('codex: custom_tool_call uses its input string', () => {
  const e = normalizeCodex([cxCustom('apply_patch', '*** Begin Patch\n' + 'p'.repeat(400), T2)]);
  const raw = '*** Begin Patch\n' + 'p'.repeat(400);
  expect(e).toEqual([{ ts: T2, role: 'tool', text: 'apply_patch: ' + raw.slice(0, MAX_TOOL_SUMMARY_CHARS) + MARKER }]);
});

test('codex: only response_item records count; event_msg, turn_context, token_count etc. are dropped', () => {
  const e = normalizeCodex([
    codexLine({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'event' }] }, T1, 'event_msg'),
    JSON.stringify({ timestamp: T1, type: 'turn_context', payload: { cwd: '/x' } }),
    JSON.stringify({ timestamp: T1, type: 'event_msg', payload: { type: 'token_count' } }),
    JSON.stringify({ timestamp: T1, type: 'session_meta', payload: { id: 'x' } }),
    cxMessage('user', 'output_text', ['wrong block type for user']),
    cxMessage('assistant', 'input_text', ['wrong block type for assistant']),
    codexLine({ type: 'custom_tool_call_output', call_id: 'c', output: 'out' }),
    cxAsst('留下'),
  ]);
  expect(pairs(e)).toEqual([['assistant', '留下']]);
});

test('codex: records without a usable timestamp are skipped', () => {
  const e = normalizeCodex([
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'no ts' }] } }),
    cxUser('bad ts', 'garbage'),
    cxUser('ok'),
  ]);
  expect(pairs(e)).toEqual([['user', 'ok']]);
});

test('codex: malformed records are skipped, never thrown', () => {
  const lines = [
    '',
    'oops',
    '7',
    'null',
    '[1]',
    JSON.stringify({ timestamp: T1, type: 'response_item' }),
    JSON.stringify({ timestamp: T1, type: 'response_item', payload: null }),
    JSON.stringify({ timestamp: T1, type: 'response_item', payload: 'x' }),
    JSON.stringify({ timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'user' } }),
    JSON.stringify({ timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'user', content: 'str' } }),
    JSON.stringify({ timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [null, 3, { type: 'output_text' }] } }),
    JSON.stringify({ timestamp: T1, type: 'response_item', payload: { type: 'function_call', arguments: '{}' } }),
    JSON.stringify({ timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call', name: 9 } }),
    cxAsst('hi'),
  ];
  expect(normalizeCodex(lines)).toHaveLength(1);
});

// ---- buildChunks ------------------------------------------------------------

const manyEntries = (): Entry[] =>
  Array.from({ length: 30 }, (_, i) => ({
    ts: `2026-10-29T08:${String(i).padStart(2, '0')}:07.123Z`,
    role: (['user', 'assistant', 'tool'] as const)[i % 3]!,
    text: String(i % 10).repeat(4000),
  })); // 30 * ~4030 ≈ 121k

test('buildChunks formats lines and splits at MAX_CHUNK_CHARS without splitting an entry', () => {
  const entries = manyEntries();
  const chunks = buildChunks(entries, 0, 999, { maxChunkChars: 48000 });
  expect(chunks.length).toBeGreaterThanOrEqual(3);
  expect(chunks.every((c) => c.text.length <= 48000)).toBe(true);
  expect(chunks[0]!.text.split('\n')[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\] (user|assistant|tool): /);
  expect(MAX_CHUNK_CHARS).toBe(48000);

  // Every entry appears exactly once, whole, in order.
  const allLines = chunks.flatMap((c) => c.text.split('\n'));
  expect(allLines).toHaveLength(entries.length);
  allLines.forEach((line, i) => {
    expect(line).toBe(`[2026-10-29T08:${String(i).padStart(2, '0')}Z] ${entries[i]!.role}: ${entries[i]!.text}`);
  });
});

test('buildChunks: a chunk is filled up to the limit, lines joined with a newline', () => {
  const e = (ch: string): Entry => ({ ts: T1, role: 'user', text: ch.repeat(10) });
  const lineLen = `[2026-10-29T08:01Z] user: ${'a'.repeat(10)}`.length;
  // Room for exactly two lines plus the joining newline.
  const chunks = buildChunks([e('a'), e('b'), e('c')], 0, 1, { maxChunkChars: lineLen * 2 + 1 });
  expect(chunks.map((c) => c.text.split('\n').length)).toEqual([2, 1]);
  expect(chunks[0]!.text.length).toBe(lineLen * 2 + 1);
});

test('buildChunks: ts_start/ts_end are the full timestamps of the first/last entry in each chunk', () => {
  const entries: Entry[] = [
    { ts: T1, role: 'user', text: 'a'.repeat(30) },
    { ts: T2, role: 'assistant', text: 'b'.repeat(30) },
    { ts: T3, role: 'tool', text: 'c'.repeat(30) },
  ];
  const [one] = buildChunks(entries, 0, 5, { maxChunkChars: 48000 });
  expect(one).toMatchObject({ ts_start: T1, ts_end: T3 });

  const split = buildChunks(entries, 0, 5, { maxChunkChars: 130 });
  expect(split.map((c) => [c.ts_start, c.ts_end])).toEqual([
    [T1, T2],
    [T3, T3],
  ]);
});

test('buildChunks: the line prefix is minute precision in UTC', () => {
  const [c] = buildChunks(
    [{ ts: '2026-10-29T09:30:15+08:00', role: 'user', text: 'hi' }],
    0,
    1,
    { maxChunkChars: 48000 },
  );
  expect(c!.text).toBe('[2026-10-29T01:30Z] user: hi');
  expect(c!.ts_start).toBe('2026-10-29T09:30:15+08:00');
});

test('split chunks share the byte range: only the last chunk carries the real offset_end', () => {
  const chunks = buildChunks(manyEntries(), 7, 999, { maxChunkChars: 48000 });
  const n = chunks.length;
  expect(n).toBeGreaterThanOrEqual(3);
  chunks.forEach((c, i) => {
    expect(c.offset_start).toBe(7 * 1000 + i);
    expect(c.offset_end).toBe(i === n - 1 ? 999 : 7);
  });
  expect(new Set(chunks.map((c) => c.offset_start)).size).toBe(n);
  expect(Math.max(...chunks.map((c) => c.offset_end))).toBe(999);
});

test('single-chunk read is also scaled: offset_start === offsetStart * 1000, offset_end is the raw end', () => {
  const entries: Entry[] = [{ ts: T1, role: 'user', text: 'hi' }];
  expect(buildChunks(entries, 5, 80, { maxChunkChars: 48000 })).toEqual([
    {
      offset_start: 5000,
      offset_end: 80,
      ts_start: T1,
      ts_end: T1,
      text: '[2026-10-29T08:01Z] user: hi',
    },
  ]);
  // A scaled key can never collide with a real byte offset used by another read of the same session.
  const [a] = buildChunks(entries, 5, 80, { maxChunkChars: 48000 });
  const [b] = buildChunks(entries, 5000, 6000, { maxChunkChars: 48000 });
  expect(a!.offset_start).not.toBe(b!.offset_start);
});

test('buildChunks: one over-long line is capped at maxChunkChars', () => {
  const [c, ...rest] = buildChunks([{ ts: T1, role: 'user', text: 'w'.repeat(500) }], 0, 1, { maxChunkChars: 100 });
  expect(rest).toEqual([]);
  expect(c!.text.length).toBeLessThanOrEqual(100);
  expect(c!.text.startsWith('[2026-10-29T08:01Z] user: www')).toBe(true);
  expect(c!.text.endsWith(MARKER)).toBe(true);
});

test('buildChunks: a line that exactly fits maxChunkChars is left alone', () => {
  const prefix = '[2026-10-29T08:01Z] user: ';
  const [c] = buildChunks([{ ts: T1, role: 'user', text: 'v'.repeat(100 - prefix.length) }], 0, 1, { maxChunkChars: 100 });
  expect(c!.text).toBe(prefix + 'v'.repeat(100 - prefix.length));
  expect(c!.text.length).toBe(100);
});

test('buildChunks: an invalid ts does not throw', () => {
  const [c] = buildChunks([{ ts: 'garbage', role: 'user', text: 'x' }], 0, 1, { maxChunkChars: 48000 });
  expect(c!.text).toBe('[garbage] user: x');
});

test('empty entries produce no chunks', () => {
  expect(buildChunks([], 0, 10, { maxChunkChars: 48000 })).toEqual([]);
});
