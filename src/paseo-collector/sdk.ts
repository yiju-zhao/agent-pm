// The thin seam between the Paseo collector and `@getpaseo/client`. Everything else in src/paseo-collector talks to the
// `PaseoSdk` interface below, so tests inject a fake and the SDK is only loaded (dynamically) when `collect-paseo` runs.
//
// Only read operations are exposed: directory listing and its update stream, exact-id agent lookup, timeline pages and
// live timeline notifications. Nothing here creates, messages, stops, archives or reloads an agent.
//
// Facts verified against a real daemon 0.15.0 with SDK 0.15.0 (see docs/superpowers/plans/2026-11-04-06-paseo-collector.md,
// "实施记录"):
//  - The daemon answers every timeline fetch with the `projected` projection, whatever is asked.
//  - A timeline fetch of an agent that is not loaded in the daemon resumes it from persistence (an interactive provider
//    session for a non-archived agent; a history-only session for an archived one). `isLoaded` tells them apart.
//  - `after {seq: X}` returns every row that has a source seq > X, so the row straddling a page boundary comes again.
//  - A cursor of a replaced epoch comes back with `staleCursor: true, reset: true` and the latest rows of the new epoch.
import type { PaseoAgent, PaseoAgentTimelineEvent, PaseoClient } from '@getpaseo/client';

export type TimelineCursor = { epoch: string; seq: number };

/** The subset of an agent snapshot the collector reads. */
export type AgentSnapshot = {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  title: string | null;
  status: string;
  archivedAt?: string | null;
  updatedAt: string;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  pendingPermissions: unknown[];
  lastError?: string;
  runtimeInfo?: { sessionId: string | null } | null;
  persistence?: { sessionId: string } | null;
  capabilities: Record<string, unknown>;
  availableModes: unknown[];
  labels: Record<string, string>;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  providerUnavailable?: boolean;
};

export type DirectoryEntry = { agent: AgentSnapshot; project?: { projectKey?: string; projectName?: string } | null };

/** One projected timeline row. `item` keeps the daemon's shape; the normalizer decides what it understands. */
export type TimelineEntry = {
  provider: string;
  item: { type: string; [key: string]: unknown };
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: Array<{ startSeq: number; endSeq: number }>;
  turnId?: string;
  collapsed: string[];
};

export type TimelinePage = {
  agent: AgentSnapshot | null;
  epoch: string;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
  startCursor: TimelineCursor | null;
  endCursor: TimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  entries: TimelineEntry[];
  error: string | null;
};

/** Live timeline notifications, reduced to what the collector acts on: they only ever trigger a page fetch. */
export type TimelineSignal =
  | { kind: 'activity'; turnEnded: boolean }
  | { kind: 'restored' }
  | { kind: 'replacement'; epoch: string }
  | { kind: 'error'; error: string };

export type DirectoryUpdate = { kind: 'upsert'; entry: DirectoryEntry } | { kind: 'remove'; agentId: string };

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'disposed';

export type ListPage = { entries: DirectoryEntry[]; nextCursor: string | null; hasMore: boolean };

export interface PaseoSdk {
  connect(): Promise<void>;
  close(): Promise<void>;
  /** The daemon's server id from its hello; throws before the first successful connect. */
  serverId(): string;
  connectionStatus(): ConnectionStatus;
  listAgents(opts: { cursor?: string; limit: number; includeArchived: boolean; includeBackground: boolean }): Promise<ListPage>;
  /** Exact-id lookup (`fetch_agent_request`): never loads the agent; `null` when the daemon does not know the id. */
  fetchAgent(agentId: string): Promise<AgentSnapshot | null>;
  fetchTimeline(agentId: string, opts: { direction: 'tail' | 'after' | 'before'; cursor?: TimelineCursor; limit: number }): Promise<TimelinePage>;
  /** Resolves once the daemon confirmed the subscription; the returned function releases it. */
  subscribeTimeline(agentId: string, onSignal: (signal: TimelineSignal) => void): Promise<() => void>;
  /** Starts the daemon's directory update stream; resolves once it is established. */
  subscribeDirectory(onUpdate: (update: DirectoryUpdate) => void, includeBackground: boolean): Promise<() => void>;
}

/** Capabilities a stored (not loaded) agent reports in daemon 0.15.0: `buildStoredAgentPayload`'s fixed defaults. */
const STORED_CAPABILITY_KEYS = [
  'supportsStreaming',
  'supportsSessionPersistence',
  'supportsDynamicModes',
  'supportsMcpServers',
  'supportsReasoningStream',
  'supportsToolInvocations',
  'supportsRewindConversation',
  'supportsRewindFiles',
  'supportsRewindBoth',
];

/**
 * Whether the daemon holds this agent in memory, so reading its timeline cannot resume it. A `closed` agent is not
 * loaded. Daemon 0.15.0 has no explicit flag, so an agent whose snapshot is the stored-record projection (no modes and
 * exactly the fixed default capability set) counts as not loaded either; anything else counts as loaded. An unknown
 * snapshot shape errs towards "not loaded": the cost is a delay in reading, never a resumed agent.
 */
export function isLoaded(agent: AgentSnapshot): boolean {
  if (agent.status === 'closed') return false;
  if (agent.availableModes.length > 0) return true;
  const keys = Object.keys(agent.capabilities ?? {}).sort();
  const storedShape =
    keys.length === STORED_CAPABILITY_KEYS.length && STORED_CAPABILITY_KEYS.every((k) => keys.includes(k)) && agent.capabilities.supportsStreaming === false;
  return !storedShape && agent.capabilities.supportsStreaming === true;
}

/** The provider's own session id: the runtime's when it reports one, else the persisted handle's. */
export function nativeSessionId(agent: AgentSnapshot): { id: string; origin: 'runtime' | 'persistence' } | null {
  const runtime = agent.runtimeInfo?.sessionId;
  if (typeof runtime === 'string' && runtime !== '') return { id: runtime, origin: 'runtime' };
  const persisted = agent.persistence?.sessionId;
  if (typeof persisted === 'string' && persisted !== '') return { id: persisted, origin: 'persistence' };
  return null;
}

function toAgent(a: PaseoAgent): AgentSnapshot {
  return a as unknown as AgentSnapshot;
}

function toSignal(event: PaseoAgentTimelineEvent): TimelineSignal | null {
  const e = event.event as { type: string; epoch?: string; error?: string };
  switch (e.type) {
    case 'subscription_restored':
      return { kind: 'restored' };
    case 'replacement':
      return { kind: 'replacement', epoch: String(e.epoch) };
    case 'error':
      return { kind: 'error', error: String(e.error) };
    case 'turn_completed':
    case 'turn_failed':
    case 'turn_canceled':
      return { kind: 'activity', turnEnded: true };
    default:
      return { kind: 'activity', turnEnded: false };
  }
}

/** Loads `@getpaseo/client` and wraps a client for one daemon. Reconnects are left to the SDK. */
export async function createPaseoSdk(opts: { url: string; password?: string; connectTimeoutMs?: number }): Promise<PaseoSdk> {
  const { createPaseoClient } = await import('@getpaseo/client');
  const client: PaseoClient = createPaseoClient({
    url: opts.url,
    password: opts.password,
    clientId: 'agent-pm-paseo-collector',
    connectTimeoutMs: opts.connectTimeoutMs ?? 15_000,
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 30_000 },
  });
  return {
    connect: () => client.connect(),
    close: () => client.close(),
    serverId: () => client.agents.ref('server-id-probe').address.serverId,
    connectionStatus: () => client.getConnectionState().status,
    async listAgents({ cursor, limit, includeArchived, includeBackground }) {
      const page = await client.agents.list({
        includeBackground,
        ...(includeArchived ? { filter: { includeArchived: true, includeBackground } } : {}),
        page: { limit, ...(cursor ? { cursor } : {}) },
      });
      return {
        entries: page.entries.map((e) => ({ agent: toAgent(e.agent), project: e.project })),
        nextCursor: page.pageInfo.nextCursor,
        hasMore: page.pageInfo.hasMore,
      };
    },
    async fetchAgent(agentId) {
      const result = await client.agents.ref(agentId).refresh();
      return result?.agent ? toAgent(result.agent) : null;
    },
    async fetchTimeline(agentId, { direction, cursor, limit }) {
      const page = await client.agents.ref(agentId).timeline.refetch({ direction, cursor, limit, projection: 'projected' });
      return { ...page, agent: page.agent ? toAgent(page.agent) : null } as unknown as TimelinePage;
    },
    async subscribeTimeline(agentId, onSignal) {
      const sub = client.agents.ref(agentId).timeline.subscribe((event) => {
        const signal = toSignal(event);
        if (signal) onSignal(signal);
      });
      await sub.ready;
      return () => sub();
    },
    async subscribeDirectory(onUpdate, includeBackground) {
      const off = client.agents.subscribe((update) => {
        if (update.kind === 'upsert') onUpdate({ kind: 'upsert', entry: { agent: toAgent(update.agent), project: update.project ?? null } });
        else if (update.kind === 'remove') onUpdate({ kind: 'remove', agentId: update.agentId });
      });
      try {
        const listed = await client.agents.list({ subscribe: {}, includeBackground, page: { limit: 1 } });
        await listed.subscription.ready;
        return () => {
          off();
          void listed.subscription.release().catch(() => {});
        };
      } catch (err) {
        off();
        throw err;
      }
    },
  };
}
