import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createPaseoSdk, isLoaded, nativeSessionId } from '../../src/paseo-collector/sdk.ts';
import type { AgentSnapshot, DirectoryEntry, TimelinePage } from '../../src/paseo-collector/sdk.ts';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/paseo/${name}`, import.meta.url), 'utf8')) as T;

describe('fixtures captured from daemon 0.15.0', () => {
  const directory = fixture<{ entries: DirectoryEntry[] }>('directory.json');

  test('a closed agent is a stored record, not loaded; the others are loaded', () => {
    const closed = directory.entries.filter((e) => e.agent.status === 'closed');
    expect(closed.length).toBeGreaterThan(0);
    for (const e of closed) expect(isLoaded(e.agent)).toBe(false);
    for (const e of directory.entries.filter((x) => x.agent.status !== 'closed')) expect(isLoaded(e.agent)).toBe(true);
  });

  test('a stored-record snapshot that still says idle counts as not loaded', () => {
    const closed = directory.entries.find((e) => e.agent.status === 'closed')!.agent;
    expect(isLoaded({ ...closed, status: 'idle' })).toBe(false);
  });

  test('native id prefers the runtime id and falls back to the persisted handle', () => {
    const agent = directory.entries[0]!.agent;
    expect(nativeSessionId({ ...agent, runtimeInfo: { sessionId: 'r' }, persistence: { sessionId: 'p' } })).toEqual({ id: 'r', origin: 'runtime' });
    expect(nativeSessionId({ ...agent, runtimeInfo: { sessionId: null }, persistence: { sessionId: 'p' } })).toEqual({ id: 'p', origin: 'persistence' });
    expect(nativeSessionId({ ...agent, runtimeInfo: null, persistence: null } as AgentSnapshot)).toBeNull();
  });

  test.each(['claude', 'codex'])('%s timeline pages have the verified shape', (provider) => {
    const page = fixture<TimelinePage>(`timeline-${provider}-after-0.json`);
    expect((page as TimelinePage & { projection: string }).projection).toBe('projected');
    expect(page.entries.length).toBeGreaterThan(0);
    // seqStart never decreases; every message and tool row carries a provider id.
    page.entries.forEach((e, i) => i > 0 && expect(e.seqStart).toBeGreaterThanOrEqual(page.entries[i - 1]!.seqStart));
    for (const e of page.entries) {
      if (e.item.type === 'user_message' || e.item.type === 'assistant_message') expect(typeof e.item.messageId).toBe('string');
      if (e.item.type === 'tool_call') expect(typeof e.item.callId).toBe('string');
    }
    // The end cursor is the highest canonical seq consumed, which can sit inside the last row's range.
    const last = page.entries.at(-1)!;
    expect(page.endCursor!.seq).toBeGreaterThanOrEqual(last.seqStart);
    const next = fixture<TimelinePage>(`timeline-${provider}-after-page2.json`);
    expect(next.entries[0]!.seqEnd).toBeGreaterThan(page.endCursor!.seq);
  });

  test.each(['claude', 'codex'])('%s: a replaced epoch comes back as a stale cursor with the new epoch', (provider) => {
    const stale = fixture<TimelinePage>(`timeline-${provider}-stale-epoch.json`);
    expect(stale.staleCursor).toBe(true);
    expect(stale.reset).toBe(true);
    const atEnd = fixture<TimelinePage>(`timeline-${provider}-at-end.json`);
    expect(atEnd.entries).toEqual([]);
    expect(atEnd.endCursor).toBeNull();
    expect(atEnd.hasNewer).toBe(false);
  });

  test('failed tool calls keep a non-null error and codex shell calls an exit code', () => {
    const rows = [...fixture<TimelinePage>('timeline-claude-after-0.json').entries, ...fixture<TimelinePage>('timeline-codex-after-0.json').entries];
    const failed = rows.filter((e) => e.item.type === 'tool_call' && e.item.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const f of failed) expect(f.item.error).not.toBeNull();
    const codexShell = fixture<TimelinePage>('timeline-codex-after-0.json').entries.find(
      (e) => e.item.type === 'tool_call' && (e.item.detail as { type: string }).type === 'shell',
    );
    expect(typeof (codexShell!.item.detail as { exitCode?: number }).exitCode).toBe('number');
  });
});

// Read-only contract check against a real daemon: PASEO_CONTRACT_URL=ws://host:port/ws npx vitest run tests/paseo-collector/sdk.test.ts
const url = process.env.PASEO_CONTRACT_URL;
describe.skipIf(!url)('real daemon (read-only)', () => {
  test('identity, full directory pagination and timeline paging of loaded agents', { timeout: 120_000 }, async () => {
    const sdk = await createPaseoSdk({ url: url!, password: process.env.PASEO_CONTRACT_PASSWORD || undefined });
    await sdk.connect();
    try {
      expect(sdk.serverId()).toMatch(/\S/);
      expect(sdk.connectionStatus()).toBe('connected');
      const all: DirectoryEntry[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await sdk.listAgents({ cursor, limit: 2, includeArchived: false, includeBackground: true });
        all.push(...page.entries);
        if (!page.hasMore || page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(new Set(all.map((e) => e.agent.id)).size).toBe(all.length);
      const exact = await sdk.fetchAgent(all[0]!.agent.id);
      expect(exact?.id).toBe(all[0]!.agent.id);
      expect(await sdk.fetchAgent('00000000-0000-0000-0000-000000000000')).toBeNull();
      for (const e of all.filter((x) => isLoaded(x.agent) && ['claude', 'codex'].includes(x.agent.provider)).slice(0, 2)) {
        const tail = await sdk.fetchTimeline(e.agent.id, { direction: 'tail', limit: 1 });
        const first = await sdk.fetchTimeline(e.agent.id, { direction: 'after', cursor: { epoch: tail.epoch, seq: 0 }, limit: 5 });
        expect(first.epoch).toBe(tail.epoch);
        expect(first.staleCursor).toBe(false);
        const stale = await sdk.fetchTimeline(e.agent.id, { direction: 'after', cursor: { epoch: 'not-an-epoch', seq: 1 }, limit: 1 });
        expect(stale.staleCursor).toBe(true);
      }
    } finally {
      await sdk.close();
    }
  });
});
