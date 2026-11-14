// Where stored chunk text is shorter than what the agent's conversation held, and which kind of shortening it is.
// Chunk text is `[time] role: text` lines (continuation lines belong to the entry above them), and every cut leaves a
// marker. The kinds matter because they are not equally bad:
//  - `message`: a user or assistant message was cut when it was collected. What was dropped is not at the center.
//  - `tool`: only a tool call's summary or output was cut, which every collector does by design.
//  - `excerpt` (Paseo): the chunk shows part of an event whose fuller copy the center keeps in `source_events`.

export type ContentCuts = { message: boolean; tool: boolean; excerpt: boolean };

const ENTRY_RE = /^\[[^\]]*\] (user|assistant|tool|error|notice)(（续）)?: /;
const COLLECTED_CUT = '…[已截断]';
const UPSTREAM_CUT = '…[采集时已截断';
const MIDDLE_CUT_RE = /…\[中间省略 \d+ 字符\]…/;

/** The cuts in one chunk's text. `herdr`: whether a herdr collector produced the chunk (else the center built it from Paseo events). */
export function contentCuts(text: string, herdr: boolean): ContentCuts {
  const cuts: ContentCuts = { message: false, tool: false, excerpt: false };
  if (!text.includes('…[')) return cuts;
  let role = 'user';
  for (const line of text.split('\n')) {
    const entry = ENTRY_RE.exec(line);
    if (entry) role = entry[1]!;
    const middle = MIDDLE_CUT_RE.test(line);
    // A herdr collector cuts in the text itself; for Paseo the middle cut is the center's excerpt of a kept event.
    const collected = line.includes(COLLECTED_CUT) || line.includes(UPSTREAM_CUT) || (herdr && middle);
    if (collected) cuts[role === 'tool' ? 'tool' : 'message'] = true;
    if (!herdr && middle) cuts.excerpt = true;
  }
  return cuts;
}

/** Whether a chunk with this `source_id` came from a herdr collector (chunks older than sources did too). */
export function isHerdrChunk(sourceId: string | null): boolean {
  return sourceId === null || sourceId.startsWith('herdr:');
}
