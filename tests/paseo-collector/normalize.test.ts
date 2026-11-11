import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { bound, isUnsettled, MAX_MESSAGE_CHARS, MAX_TOOL_CHARS, normalizeEntry } from '../../src/paseo-collector/normalize.ts';
import type { TimelineEntry, TimelinePage } from '../../src/paseo-collector/sdk.ts';
import { headTail, renderEvent, toolOutcome } from '../../src/server/paseo-content.ts';

const fixture = (name: string): TimelinePage => JSON.parse(readFileSync(new URL(`../fixtures/paseo/${name}`, import.meta.url), 'utf8')) as TimelinePage;
const started = new Date('2026-12-01T00:00:00.000Z');

describe('fixtures from daemon 0.15.0', () => {
  test.each(['claude', 'codex'])('%s rows become events with provider ids; reasoning is only counted', (provider) => {
    const page = fixture(`timeline-${provider}-after-0.json`);
    const out = page.entries.map((e) => normalizeEntry(e, page.epoch, started));
    for (const [i, n] of out.entries()) {
      const row = page.entries[i]!;
      if (row.item.type === 'reasoning') expect(n).toEqual({ filtered: 'reasoning' });
      if ('event' in n) {
        expect(n.event.seq_start).toBe(row.seqStart);
        expect(n.event.seq_end).toBe(row.seqEnd);
        expect(n.event.epoch).toBe(page.epoch);
        expect(n.event.stable_id).toBe(true);
        expect(n.event.key).toMatch(/^(msg|tool):/);
        expect(n.event.backfill).toBe(true);
      }
    }
    const tools = out.flatMap((n) => ('event' in n && n.event.tool ? [n.event.tool] : []));
    expect(tools.length).toBeGreaterThan(0);
    const failed = tools.filter((t) => t.status === 'failed');
    // The captured claude page has failed tool calls; the codex one has none in its first rows.
    if (provider === 'claude') expect(failed.length).toBeGreaterThan(0);
    for (const t of failed) {
      expect(t.error).not.toBeNull();
      expect(toolOutcome(t)).toMatch(/^失败/);
    }
  });

  test('codex shell results keep output and exit code; a non-zero exit is never shown as success', () => {
    const page = fixture('timeline-codex-after-0.json');
    const shell = page.entries.map((e) => normalizeEntry(e, page.epoch, started)).flatMap((n) => ('event' in n && n.event.tool?.exit_code != null ? [n.event] : []));
    expect(shell.length).toBeGreaterThan(0);
    for (const e of shell) {
      expect(e.tool!.output.length).toBeGreaterThan(0);
      const line = renderEvent(e);
      if (e.tool!.exit_code !== 0) expect(line).toMatch(/失败\(exit/);
      else expect(line).toMatch(/成功\(exit 0\)/);
    }
  });

  test('a large tool output is bounded at 16 KiB with its original length, and excerpted for the analysis', () => {
    const page = fixture('timeline-codex-after-0.json');
    const big = page.entries.find((e) => e.item.type === 'tool_call' && ((e.item.detail as { output?: string }).output?.length ?? 0) > MAX_TOOL_CHARS);
    expect(big).toBeDefined();
    const n = normalizeEntry(big!, page.epoch, started);
    if (!('event' in n)) throw new Error('expected an event');
    const t = n.event.tool!;
    expect(t.output.length).toBeLessThanOrEqual(MAX_TOOL_CHARS);
    expect(t.output_truncated).toEqual({ original_chars: (big!.item.detail as { output: string }).output.length, kept_chars: expect.any(Number) });
    const line = renderEvent(n.event);
    expect(line).toMatch(/采集时已截断：原长 \d+ 字符/);
    expect(line.length).toBeLessThan(6000);
  });
});

describe('rules', () => {
  test('bounding keeps head and tail and never splits a surrogate pair', () => {
    const text = '😀'.repeat(MAX_MESSAGE_CHARS); // twice the cap in UTF-16 units
    const b = bound(text, MAX_MESSAGE_CHARS);
    expect(b.text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(b.truncated!.original_chars).toBe(text.length);
    expect(() => encodeURIComponent(b.text)).not.toThrow(); // a lone surrogate would throw
    const h = headTail('a😀'.repeat(5000), 1001);
    expect(() => encodeURIComponent(h.text)).not.toThrow();
    expect(bound('short', 10)).toEqual({ text: 'short', truncated: null });
  });

  test('a row without a timestamp keeps ts null and counts as backfill', () => {
    const row: TimelineEntry = { provider: 'claude', item: { type: 'user_message', text: 'hi', messageId: 'm' }, timestamp: '', seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [] };
    const n = normalizeEntry(row, 'e', started);
    expect('event' in n && n.event).toMatchObject({ ts: null, backfill: true });
    expect(renderEvent((n as { event: Parameters<typeof renderEvent>[0] }).event)).toMatch(/^\[时间未知\] user: hi$/);
  });

  test('unknown and malformed rows are filtered by type, not passed off as content', () => {
    const row = (item: TimelineEntry['item']): TimelineEntry => ({ provider: 'x', item, timestamp: '2026-01-01T00:00:00Z', seqStart: 3, seqEnd: 3, sourceSeqRanges: [], collapsed: [] });
    expect(normalizeEntry(row({ type: 'hologram', data: 1 }), 'e', started)).toEqual({ filtered: 'hologram' });
    expect(normalizeEntry(row({ type: 'plugin', id: 'p' }), 'e', started)).toEqual({ filtered: 'plugin' });
    expect(normalizeEntry(row({ type: 'tool_call', callId: 'c', name: 'x', status: 'exploded', detail: { type: 'shell' } }), 'e', started)).toEqual({ filtered: 'tool_call:unrecognized' });
    expect(normalizeEntry(row({ type: 'assistant_message', text: '   ' }), 'e', started)).toEqual({ filtered: 'assistant_message:empty' });
    // A row without a provider id gets an epoch-scoped key and says so.
    const n = normalizeEntry(row({ type: 'error', message: 'boom' }), 'e', started);
    expect('event' in n && n.event).toMatchObject({ key: 'row:e:3:error', stable_id: false, kind: 'error' });
  });

  test('only a running tool and the last row of an active turn are unsettled', () => {
    const r = (item: TimelineEntry['item']): TimelineEntry => ({ provider: 'x', item, timestamp: '', seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [] });
    expect(isUnsettled(r({ type: 'tool_call', status: 'running' }), false, false)).toBe(true);
    expect(isUnsettled(r({ type: 'tool_call', status: 'completed' }), true, false)).toBe(false);
    expect(isUnsettled(r({ type: 'assistant_message' }), true, true)).toBe(true);
    expect(isUnsettled(r({ type: 'assistant_message' }), false, true)).toBe(false);
  });
});
