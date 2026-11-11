// A controllable in-memory Paseo daemon behind the collector's `PaseoSdk` seam. It reproduces what was verified on a
// real daemon 0.15.0: projected rows with seq ranges, `after {seq: X}` returning every row with a seq above X (so the
// row straddling a page boundary comes again), an end cursor at the highest seq consumed, a stale epoch answered with
// `staleCursor/reset` and the latest rows of the new epoch, paginated directory listing, exact-id lookup that never
// loads an agent. It has no write operations at all, and it records any timeline read of an agent that is neither
// loaded nor archived (on a real daemon that read would resume the agent).
import type {
  AgentSnapshot,
  ConnectionStatus,
  DirectoryEntry,
  DirectoryUpdate,
  ListPage,
  PaseoSdk,
  TimelineEntry,
  TimelinePage,
  TimelineSignal,
} from '../../src/paseo-collector/sdk.ts';

export const FAKE_SERVER_ID = 'srv_test_mini';

type FakeAgent = { snapshot: AgentSnapshot; project: DirectoryEntry['project']; epoch: string; rows: TimelineEntry[]; nextSeq: number; gapOnce?: boolean };

const LOADED_CAPS = { supportsStreaming: true, supportsSessionPersistence: true, supportsSessionListing: true, supportsDynamicModes: true, supportsMcpServers: true, supportsReasoningStream: true, supportsToolInvocations: true, supportsRewindConversation: true, supportsRewindFiles: true, supportsRewindBoth: true };
const STORED_CAPS = { supportsStreaming: false, supportsSessionPersistence: true, supportsDynamicModes: false, supportsMcpServers: false, supportsReasoningStream: false, supportsToolInvocations: true, supportsRewindConversation: false, supportsRewindFiles: false, supportsRewindBoth: false };

export class FakePaseo implements PaseoSdk {
  serverIdValue = FAKE_SERVER_ID;
  status: ConnectionStatus = 'idle';
  agents = new Map<string, FakeAgent>();
  /** Timeline reads that would have resumed an agent on a real daemon. Must stay empty. */
  resumedByRead: string[] = [];
  timelineReads: string[] = [];
  closed = false;
  failListPage: number | null = null;
  failTimeline = new Set<string>();
  failConnect = false;
  private timelineSubs = new Map<string, Set<(s: TimelineSignal) => void>>();
  private dirSubs = new Set<(u: DirectoryUpdate) => void>();
  private clock = Date.parse('2026-11-06T09:00:00.000Z');

  // ---- PaseoSdk ----------------------------------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.failConnect) {
      this.status = 'disconnected';
      throw new Error('connect ECONNREFUSED');
    }
    this.status = 'connected';
  }
  async close(): Promise<void> {
    this.closed = true;
    this.status = 'disposed';
  }
  serverId(): string {
    if (this.status !== 'connected') throw new Error('not connected');
    return this.serverIdValue;
  }
  connectionStatus(): ConnectionStatus {
    return this.status;
  }
  private online(): void {
    if (this.status !== 'connected') throw new Error('not connected');
  }

  async listAgents(o: { cursor?: string; limit: number; includeArchived: boolean; includeBackground: boolean }): Promise<ListPage> {
    this.online();
    const ids = [...this.agents.values()].filter((a) => o.includeArchived || !a.snapshot.archivedAt).map((a) => a.snapshot.id).sort();
    const start = o.cursor === undefined ? 0 : Number(o.cursor);
    const page = Math.floor(start / o.limit);
    if (this.failListPage !== null && page === this.failListPage) throw new Error('directory page failed');
    const slice = ids.slice(start, start + o.limit);
    const hasMore = start + o.limit < ids.length;
    return { entries: slice.map((id) => this.entry(id)), nextCursor: hasMore ? String(start + o.limit) : null, hasMore };
  }

  async fetchAgent(agentId: string): Promise<AgentSnapshot | null> {
    this.online();
    return this.agents.get(agentId)?.snapshot ?? null;
  }

  async fetchTimeline(agentId: string, o: { direction: 'tail' | 'after' | 'before'; cursor?: { epoch: string; seq: number }; limit: number }): Promise<TimelinePage> {
    this.online();
    const a = this.agents.get(agentId);
    if (a === undefined) throw new Error(`unknown agent ${agentId}`);
    this.timelineReads.push(agentId);
    const loaded = a.snapshot.status !== 'closed' && a.snapshot.availableModes.length > 0;
    if (!loaded && !a.snapshot.archivedAt) this.resumedByRead.push(agentId);
    if (this.failTimeline.has(agentId)) throw new Error('timeline read failed');
    const rows = [...a.rows].sort((x, y) => x.seqStart - y.seqStart);
    const minSeq = rows[0]?.seqStart ?? 0;
    const maxSeq = rows.reduce((m, r) => Math.max(m, r.seqEnd), 0);
    const page = (entries: TimelineEntry[], extra: Partial<TimelinePage>): TimelinePage => ({
      agent: a.snapshot,
      epoch: a.epoch,
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
      startCursor: entries[0] ? { epoch: a.epoch, seq: entries[0].seqStart } : null,
      endCursor: entries.length ? { epoch: a.epoch, seq: Math.max(...entries.map((e) => e.seqStart)) } : null,
      hasOlder: entries.length > 0 && entries[0]!.seqStart > minSeq,
      hasNewer: false,
      entries: structuredClone(entries),
      error: null,
      ...extra,
    });
    const limit = o.limit === 0 ? Infinity : o.limit;
    if (o.direction === 'tail' || o.cursor === undefined) {
      const tail = rows.slice(Math.max(0, rows.length - limit));
      return page(tail, { endCursor: tail.length ? { epoch: a.epoch, seq: maxSeq } : null });
    }
    if (o.cursor.epoch !== a.epoch) {
      const tail = rows.slice(Math.max(0, rows.length - limit));
      return page(tail, { staleCursor: true, reset: true, endCursor: tail.length ? { epoch: a.epoch, seq: maxSeq } : null });
    }
    const after = rows.filter((r) => r.seqEnd > o.cursor!.seq);
    const taken = after.slice(0, limit);
    const gap = a.gapOnce === true;
    a.gapOnce = false;
    const hasNewer = after.length > taken.length;
    // Like the daemon: a page that reaches the end ends at the highest seq; a cut page at its last row's first seq.
    const endSeq = hasNewer ? Math.max(...taken.map((e) => e.seqStart)) : maxSeq;
    return page(taken, { hasNewer, gap, endCursor: taken.length ? { epoch: a.epoch, seq: endSeq } : null });
  }

  async subscribeTimeline(agentId: string, onSignal: (s: TimelineSignal) => void): Promise<() => void> {
    this.online();
    let set = this.timelineSubs.get(agentId);
    if (!set) this.timelineSubs.set(agentId, (set = new Set()));
    set.add(onSignal);
    return () => set!.delete(onSignal);
  }

  async subscribeDirectory(onUpdate: (u: DirectoryUpdate) => void): Promise<() => void> {
    this.online();
    this.dirSubs.add(onUpdate);
    return () => this.dirSubs.delete(onUpdate);
  }

  // ---- control -----------------------------------------------------------------------------------------------------

  private entry(id: string): DirectoryEntry {
    const a = this.agents.get(id)!;
    return structuredClone({ agent: a.snapshot, project: a.project });
  }

  addAgent(id: string, o: { provider?: string; nativeId?: string | null; status?: string; loaded?: boolean; projectKey?: string } = {}): void {
    const loaded = o.loaded ?? true;
    const snapshot: AgentSnapshot = {
      id,
      provider: o.provider ?? 'claude',
      cwd: '/work/proj',
      workspaceId: 'ws_1',
      title: `agent ${id}`,
      status: o.status ?? (loaded ? 'idle' : 'closed'),
      archivedAt: null,
      updatedAt: new Date(this.clock).toISOString(),
      activeTurn: null,
      pendingPermissions: [],
      runtimeInfo: { sessionId: o.nativeId === undefined ? `native-${id}` : o.nativeId },
      persistence: o.nativeId === null ? null : { sessionId: o.nativeId ?? `native-${id}` },
      capabilities: loaded ? LOADED_CAPS : STORED_CAPS,
      availableModes: loaded ? [{ id: 'default' }] : [],
      labels: {},
    };
    this.agents.set(id, { snapshot, project: { projectKey: o.projectKey ?? 'proj', projectName: 'proj' }, epoch: `epoch-${id}-1`, rows: [], nextSeq: 1 });
    this.emitDir({ kind: 'upsert', entry: this.entry(id) });
  }

  /** Appends a projected row spanning `span` canonical seqs; returns it (mutable, to simulate projection updates). */
  addRow(id: string, item: TimelineEntry['item'], span = 1): TimelineEntry {
    const a = this.agents.get(id)!;
    this.clock += 1000;
    const row: TimelineEntry = {
      provider: a.snapshot.provider,
      item,
      timestamp: new Date(this.clock).toISOString(),
      seqStart: a.nextSeq,
      seqEnd: a.nextSeq + span - 1,
      sourceSeqRanges: [{ startSeq: a.nextSeq, endSeq: a.nextSeq + span - 1 }],
      collapsed: span > 1 ? ['assistant_merge'] : [],
    };
    a.nextSeq += span;
    a.rows.push(row);
    this.emitTimeline(id, { kind: 'activity', turnEnded: false });
    return row;
  }

  user(id: string, text: string, messageId = `u-${Math.random().toString(36).slice(2)}`): TimelineEntry {
    return this.addRow(id, { type: 'user_message', text, messageId });
  }
  assistant(id: string, text: string, messageId = `a-${Math.random().toString(36).slice(2)}`, span = 1): TimelineEntry {
    return this.addRow(id, { type: 'assistant_message', text, messageId }, span);
  }
  tool(id: string, o: { command: string; output?: string; status?: string; exitCode?: number; error?: unknown }, callId = `c-${Math.random().toString(36).slice(2)}`): TimelineEntry {
    return this.addRow(id, { type: 'tool_call', callId, name: 'shell', status: o.status ?? 'completed', error: o.error ?? null, detail: { type: 'shell', command: o.command, output: o.output ?? '', ...(o.exitCode === undefined ? {} : { exitCode: o.exitCode }) } }, 2);
  }
  reasoning(id: string, text: string): TimelineEntry {
    return this.addRow(id, { type: 'reasoning', text });
  }

  setStatus(id: string, status: string): void {
    const a = this.agents.get(id)!;
    a.snapshot.status = status;
    a.snapshot.activeTurn = status === 'running' ? { turnId: 't', startedAt: null } : null;
    this.emitDir({ kind: 'upsert', entry: this.entry(id) });
    if (status !== 'running') this.emitTimeline(id, { kind: 'activity', turnEnded: true });
  }

  /** Permissions pending (blocked). */
  setPermissions(id: string, n: number): void {
    this.agents.get(id)!.snapshot.pendingPermissions = Array.from({ length: n }, () => ({}));
    this.emitDir({ kind: 'upsert', entry: this.entry(id) });
  }

  archive(id: string): void {
    const a = this.agents.get(id)!;
    a.snapshot.archivedAt = new Date(this.clock).toISOString();
    a.snapshot.status = 'closed';
    a.snapshot.availableModes = [];
    a.snapshot.capabilities = STORED_CAPS;
    this.emitDir({ kind: 'remove', agentId: id });
  }

  remove(id: string): void {
    this.agents.delete(id);
    this.emitDir({ kind: 'remove', agentId: id });
  }

  /** The provider timeline is rebuilt: a new epoch, seqs from 1 again, same rows (and provider ids). */
  replaceEpoch(id: string): void {
    const a = this.agents.get(id)!;
    const n = Number(a.epoch.split('-').at(-1)) + 1;
    a.epoch = `epoch-${id}-${n}`;
    let seq = 1;
    for (const r of a.rows) {
      const span = r.seqEnd - r.seqStart + 1;
      r.seqStart = seq;
      r.seqEnd = seq + span - 1;
      seq += span;
    }
    a.nextSeq = seq;
    this.emitTimeline(id, { kind: 'replacement', epoch: a.epoch });
  }

  disconnect(): void {
    this.status = 'disconnected';
  }
  reconnect(): void {
    this.status = 'connected';
    for (const id of this.timelineSubs.keys()) this.emitTimeline(id, { kind: 'restored' });
  }

  emitTimeline(id: string, s: TimelineSignal): void {
    if (this.status !== 'connected') return; // live events during a disconnect are lost, as on a real daemon
    for (const h of this.timelineSubs.get(id) ?? []) h(s);
  }
  private emitDir(u: DirectoryUpdate): void {
    if (this.status !== 'connected') return;
    for (const h of this.dirSubs) h(u);
  }
}
