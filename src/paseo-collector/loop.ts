import type { AgentObservation, Cursor, SnapshotV2 } from '../shared/ingest-v2.ts';
import { FatalError, RefusedError, RetryableError } from './client.ts';
import type { CenterClient } from './client.ts';
import type { PaseoCollectorConfig } from './config.ts';
import { isExcluded, isLoaded, listedLifecycle, resolveMissing, scanDirectory, toObservation } from './discovery.ts';
import type { Outbox } from './outbox.ts';
import type { DirectoryEntry, DirectoryUpdate, PaseoSdk, TimelineSignal } from './sdk.ts';
import type { StateDir } from './state-store.ts';
import { nextBatch } from './timeline.ts';

// The Paseo collector's run loop. Three things run independently, so a slow or failing one never stalls another:
//  - the heartbeat: every `heartbeatMs` a snapshot (collector alive, daemon health, the agents as last seen) renews
//    the center lease; it never waits for content;
//  - the directory: a full paginated scan every `reconcileMs` (plus the daemon's update stream between scans), with
//    exact-id checks of tracked agents a scan no longer lists;
//  - content: one serial queue per agent (outbox first, then pages after the center's committed position), at most
//    `maxConcurrentAgents` agents at a time, triggered by live timeline notifications (debounced), turn ends, reconnects,
//    and a periodic refresh of long turns. A failing agent backs off on its own.
// Nothing here writes to the daemon or changes an agent; stopping the collector leaves every agent as it was.

export const PASEO_COLLECTOR_VERSION = '0.2.0';

export type CollectorDeps = {
  sdk: PaseoSdk;
  client: CenterClient;
  state: StateDir;
  outbox: Outbox;
  now(): Date;
  log(line: string): void;
  /** Jitter source for backoff; tests pin it. */
  random?(): number;
};

type AgentState = {
  id: string;
  entry: DirectoryEntry;
  lifecycle: AgentObservation['lifecycle'];
  content: AgentObservation['content'];
  /** The center's committed position; undefined until asked (and after anything that may have moved it). */
  base: Cursor | null | undefined;
  running: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
  subscribing: boolean;
  failures: number;
  retryAt: number;
  /** Seen live (or imported) by this collector: worth a last read after it is archived. */
  tracked: boolean;
  finalRead: boolean;
  lastSyncAt: number;
  /** Reported in a snapshot after it ended (deleted, or archived and read): it can be forgotten. */
  reportedEnd: boolean;
};

const MAX_ROUNDS_PER_SYNC = 2000;
const AGENT_BACKOFF_MAX_MS = 5 * 60_000;

export class PaseoCollector {
  readonly cfg: PaseoCollectorConfig;
  private readonly deps: CollectorDeps;
  private readonly agents = new Map<string, AgentState>();
  private readonly startedAt: Date;
  private lease: { epoch: number } | null = null;
  private snapshotRev = 0;
  private directoryComplete = false;
  private identityOk: boolean | null = null;
  private lastDaemonError: string | null = null;
  private lastError: string | null = null;
  private wasConnected = false;
  private directoryUnsub: (() => void) | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private snapshotSoon: ReturnType<typeof setTimeout> | null = null;
  private heartbeatBusy = false;
  private reconcileBusy = false;
  private slots: number;
  private waiting: Array<() => void> = [];
  private stopping = false;
  private inflight = new Set<Promise<void>>();

  constructor(cfg: PaseoCollectorConfig, deps: CollectorDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.startedAt = deps.now();
    this.slots = cfg.maxConcurrentAgents;
  }

  private log(msg: string): void {
    this.deps.log(`${this.deps.now().toISOString()} herdr-pm collect-paseo [${this.cfg.sourceId}]: ${msg}`);
  }

  private connected(): boolean {
    return this.deps.sdk.connectionStatus() === 'connected' && this.identityOk === true;
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  /** Connects, takes the lease, scans, and starts the timers. Resolves once running; `stop()` ends it. */
  async start(): Promise<void> {
    await this.connectDaemon();
    await this.ensureLease();
    await this.reconcile();
    await this.heartbeat();
    this.timers.push(setInterval(() => void this.heartbeat(), this.cfg.heartbeatMs));
    this.timers.push(setInterval(() => void this.reconcile(), this.cfg.reconcileMs));
    for (const id of this.deps.outbox.agents()) this.request(id, 0);
  }

  /** Stops reading, lets the content step in progress finish (its batch is in the outbox either way), and disconnects. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.snapshotSoon) clearTimeout(this.snapshotSoon);
    for (const a of this.agents.values()) {
      if (a.timer) clearTimeout(a.timer);
      a.timer = null;
      a.unsubscribe?.();
      a.unsubscribe = null;
    }
    this.directoryUnsub?.();
    this.directoryUnsub = null;
    await Promise.allSettled([...this.inflight]);
    await this.deps.sdk.close().catch(() => {});
    this.deps.state.release();
  }

  /** Resolves when no content step is running or queued (for tests and orderly shutdown). */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private async connectDaemon(): Promise<void> {
    try {
      await this.deps.sdk.connect();
      this.lastDaemonError = null;
    } catch (err) {
      this.lastDaemonError = err instanceof Error ? err.message : String(err);
      this.log(`daemon unreachable: ${this.lastDaemonError}`);
      return;
    }
    this.checkIdentity();
  }

  private checkIdentity(): void {
    let actual: string;
    try {
      actual = this.deps.sdk.serverId();
    } catch {
      return;
    }
    const ok = actual === this.cfg.paseo.serverId;
    if (!ok && this.identityOk !== false) {
      this.log(`daemon at ${this.cfg.paseo.url} is ${actual}, not the configured ${this.cfg.paseo.serverId}: not reading it`);
    }
    this.identityOk = ok;
  }

  private async ensureLease(): Promise<boolean> {
    if (this.lease !== null) return true;
    try {
      const r = await this.deps.client.lease({
        source_id: this.cfg.sourceId,
        instance_id: this.deps.state.identity.instanceId,
        server_id: this.cfg.paseo.serverId,
        collector_version: PASEO_COLLECTOR_VERSION,
      });
      this.lease = { epoch: r.lease_epoch };
      // A restart of the same instance keeps its lease; its revisions continue above the last one accepted.
      this.snapshotRev = r.snapshot_rev;
      return true;
    } catch (err) {
      this.noteError('lease', err);
      return false;
    }
  }

  private noteError(what: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = `${what}: ${message}`;
    if (err instanceof RefusedError && (err.code === 'stale_lease' || err.code === 'lease_held')) this.lease = null;
    this.log(`${what} failed: ${message}${err instanceof FatalError ? ' (needs attention: check token and config)' : ''}`);
  }

  // ---- heartbeat ---------------------------------------------------------------------------------------------------

  private daemonHealth(): SnapshotV2['daemon'] {
    const status = this.deps.sdk.connectionStatus();
    if (this.identityOk === false) return { status: 'identity_mismatch', error: 'daemon server id differs from the configured one', server_id: null };
    if (status === 'connected' && this.identityOk === true) return { status: 'connected', error: null, server_id: this.cfg.paseo.serverId };
    return { status: status === 'connecting' ? 'connecting' : 'disconnected', error: this.lastDaemonError, server_id: null };
  }

  private observations(): AgentObservation[] {
    return [...this.agents.values()].map((a) => toObservation(a.entry.agent, a.lifecycle, a.content));
  }

  /** One snapshot push: collector alive, daemon health, and (when connected) the agents. Also the long-turn refresh. */
  async heartbeat(): Promise<void> {
    if (this.heartbeatBusy || this.stopping) return;
    this.heartbeatBusy = true;
    try {
      const status = this.deps.sdk.connectionStatus();
      if (status === 'connected' && this.identityOk === null) this.checkIdentity();
      const connected = this.connected();
      if (connected && !this.wasConnected && this.agents.size > 0) void this.reconcile(); // reconnected: rescan
      if (!connected) this.directoryComplete = false;
      this.wasConnected = connected;
      if (!(await this.ensureLease())) return;
      const usage = this.deps.outbox.usage();
      const body: SnapshotV2 = {
        source_id: this.cfg.sourceId,
        instance_id: this.deps.state.identity.instanceId,
        lease_epoch: this.lease!.epoch,
        collector_version: PASEO_COLLECTOR_VERSION,
        snapshot_rev: ++this.snapshotRev,
        daemon: this.daemonHealth(),
        complete: connected && this.directoryComplete,
        agents: connected ? this.observations() : [],
        diagnostics: {
          outbox_batches: usage.batches,
          outbox_bytes: usage.bytes,
          lagging_agents: [...this.agents.values()].filter((a) => a.content !== 'current').length,
          last_error: this.lastError?.slice(0, 1000) ?? null,
        },
      };
      try {
        await this.deps.client.snapshot(body);
        if (connected) {
          // Ended agents that the center has now seen as ended can be forgotten.
          for (const a of [...this.agents.values()]) {
            if (a.reportedEnd) this.agents.delete(a.id);
            else if (a.lifecycle === 'deleted' || (a.lifecycle === 'archived' && (a.finalRead || !this.canReadArchived(a)))) a.reportedEnd = true;
          }
        }
      } catch (err) {
        this.noteError('snapshot', err);
        // A revision the center already has: take the lease again, which says where the numbering stands.
        if (err instanceof RefusedError && err.code === 'stale_snapshot') this.lease = null;
      }
      // Long turns are read every so often even without notifications; agents not caught up (a step skipped for want
      // of a lease or connection, a paused outbox, a failure whose backoff passed) are tried again.
      const now = this.deps.now().getTime();
      for (const a of this.agents.values()) {
        if (!connected || !this.canRead(a) || a.running || a.timer !== null || now < a.retryAt) continue;
        if (a.content !== 'current' || (a.entry.agent.status === 'running' && now - a.lastSyncAt >= this.cfg.longTurnRefreshMs)) this.request(a.id, 0);
      }
      // Batches left from an earlier run for agents no longer listed are still owed to the center.
      if (connected) for (const id of this.deps.outbox.agents()) if (!this.agents.has(id)) this.request(id, 0);
    } finally {
      this.heartbeatBusy = false;
    }
  }

  private pushSnapshotSoon(): void {
    if (this.snapshotSoon || this.stopping) return;
    this.snapshotSoon = setTimeout(() => {
      this.snapshotSoon = null;
      void this.heartbeat();
    }, 500);
  }

  // ---- directory ---------------------------------------------------------------------------------------------------

  private stateFor(entry: DirectoryEntry): AgentState {
    let a = this.agents.get(entry.agent.id);
    if (a === undefined) {
      a = {
        id: entry.agent.id,
        entry,
        lifecycle: 'live',
        content: 'catching_up',
        base: undefined,
        running: false,
        dirty: false,
        timer: null,
        unsubscribe: null,
        subscribing: false,
        failures: 0,
        retryAt: 0,
        tracked: false,
        finalRead: false,
        lastSyncAt: 0,
        reportedEnd: false,
      };
      this.agents.set(a.id, a);
    }
    return a;
  }

  private apply(entry: DirectoryEntry, lifecycle: AgentObservation['lifecycle']): AgentState {
    const a = this.stateFor(entry);
    const wasRunning = a.entry.agent.status === 'running';
    const before = a.lifecycle;
    a.entry = entry;
    a.lifecycle = isExcluded(entry, this.cfg.exclude) ? 'excluded' : lifecycle;
    a.reportedEnd = false;
    if (a.lifecycle === 'live') a.tracked = true;
    if (a.lifecycle === 'archived' && this.cfg.includeArchivedHistory) a.tracked = true;
    if (!this.canRead(a)) {
      a.unsubscribe?.();
      a.unsubscribe = null;
      if (a.lifecycle === 'live' || a.lifecycle === 'closed') a.content = 'unloaded';
    }
    // A turn that ended, an archive to catch the last rows of, or a first sight: read.
    if ((wasRunning && entry.agent.status !== 'running') || (before !== 'archived' && a.lifecycle === 'archived') || a.lastSyncAt === 0) {
      this.request(a.id, this.cfg.debounceMs);
    }
    return a;
  }

  private canReadArchived(a: AgentState): boolean {
    return a.tracked && this.cfg.readArchivedTracked && !a.finalRead;
  }

  /** Whether reading the timeline cannot resume the agent (or, archived, is a wanted one-time history read). */
  private canRead(a: AgentState): boolean {
    if (a.lifecycle === 'live') return isLoaded(a.entry.agent);
    if (a.lifecycle === 'archived') return this.canReadArchived(a);
    return false;
  }

  /** A full directory scan plus exact-id checks; the snapshot is complete only if every step succeeded. */
  async reconcile(): Promise<void> {
    if (this.reconcileBusy || this.stopping) return;
    this.reconcileBusy = true;
    try {
      if (this.deps.sdk.connectionStatus() !== 'connected') {
        this.directoryComplete = false;
        if (this.deps.sdk.connectionStatus() !== 'connecting') await this.connectDaemon();
        if (!this.connected()) return;
      }
      if (this.identityOk === null) this.checkIdentity();
      if (!this.connected()) return;
      let listed: Map<string, DirectoryEntry>;
      try {
        listed = await scanDirectory(this.deps.sdk, { includeBackground: this.cfg.includeBackground, includeArchived: this.cfg.includeArchivedHistory });
      } catch (err) {
        this.directoryComplete = false;
        this.noteError('directory scan', err);
        return;
      }
      for (const entry of listed.values()) this.apply(entry, listedLifecycle(entry.agent));
      const missing = [...this.agents.keys()].filter((id) => !listed.has(id));
      let complete = true;
      for (const r of await resolveMissing(this.deps.sdk, missing)) {
        const a = this.agents.get(r.agentId)!;
        if ('failed' in r) {
          complete = false;
          this.log(`agent ${r.agentId}: exact lookup failed: ${r.failed}`);
          continue;
        }
        if (r.agent === null) {
          a.lifecycle = 'deleted';
          a.unsubscribe?.();
          a.unsubscribe = null;
        } else this.apply({ agent: r.agent, project: a.entry.project ?? null }, r.lifecycle);
      }
      this.directoryComplete = complete;
      await this.ensureDirectorySubscription();
      for (const a of this.agents.values()) if (this.canRead(a) && a.lifecycle === 'live') void this.ensureTimelineSubscription(a);
    } finally {
      this.reconcileBusy = false;
    }
  }

  private async ensureDirectorySubscription(): Promise<void> {
    if (this.directoryUnsub !== null) return;
    try {
      this.directoryUnsub = await this.deps.sdk.subscribeDirectory((u) => this.onDirectory(u), this.cfg.includeBackground);
    } catch (err) {
      this.noteError('directory subscription', err);
    }
  }

  private onDirectory(u: DirectoryUpdate): void {
    if (this.stopping) return;
    if (u.kind === 'remove') {
      // Out of the listing: which way it went (archived, deleted, filtered) is settled by an exact-id check.
      setTimeout(() => void this.reconcile(), 0);
      return;
    }
    if (u.entry.agent.archivedAt && !this.agents.has(u.entry.agent.id) && !this.cfg.includeArchivedHistory) return;
    const a = this.apply(u.entry, listedLifecycle(u.entry.agent));
    if (this.canRead(a) && a.lifecycle === 'live') void this.ensureTimelineSubscription(a);
    this.pushSnapshotSoon();
  }

  /** Subscribe first, then read: rows that land after the read still trigger another one. */
  private async ensureTimelineSubscription(a: AgentState): Promise<void> {
    if (a.unsubscribe !== null || a.subscribing || this.stopping) return;
    a.subscribing = true;
    try {
      const unsubscribe = await this.deps.sdk.subscribeTimeline(a.id, (s) => this.onTimeline(a.id, s));
      if (this.stopping || !this.canRead(a)) unsubscribe();
      else a.unsubscribe = unsubscribe;
      this.request(a.id, 0);
    } catch (err) {
      this.log(`agent ${a.id}: timeline subscription failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      a.subscribing = false;
    }
  }

  private onTimeline(agentId: string, s: TimelineSignal): void {
    const a = this.agents.get(agentId);
    if (a === undefined || this.stopping) return;
    switch (s.kind) {
      case 'restored':
        // Events during the disconnect are not replayed: catch up from what the center committed.
        a.base = undefined;
        this.request(agentId, 0);
        break;
      case 'replacement':
        this.request(agentId, 0);
        break;
      case 'error':
        this.log(`agent ${agentId}: timeline subscription error: ${s.error}`);
        a.unsubscribe = null;
        break;
      case 'activity':
        this.request(agentId, s.turnEnded ? 0 : this.cfg.debounceMs);
        break;
    }
  }

  // ---- content -----------------------------------------------------------------------------------------------------

  /** Asks for a content step of one agent after `delayMs` (the earliest request wins). */
  request(agentId: string, delayMs: number): void {
    const a = this.agents.get(agentId);
    if (this.stopping) return;
    if (a === undefined) {
      // Only an outbox left over from an earlier run: flush it.
      this.track(this.syncAgent(agentId));
      return;
    }
    if (a.timer !== null) return;
    a.timer = setTimeout(() => {
      a.timer = null;
      if (a.running) a.dirty = true;
      else this.track(this.syncAgent(agentId));
    }, delayMs);
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private async slot(): Promise<() => void> {
    if (this.slots > 0) {
      this.slots -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    return () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.slots += 1;
    };
  }

  private outboxFull(): boolean {
    return this.deps.outbox.usage().bytes >= this.cfg.maxOutboxBytes;
  }

  /**
   * One content step of an agent: resend its outbox, learn the center's position if unknown, then read and commit
   * batches until nothing settled is left. Errors back off this agent only.
   */
  async syncAgent(agentId: string): Promise<void> {
    const a = this.agents.get(agentId);
    if (a?.running) {
      a.dirty = true;
      return;
    }
    if (a && this.deps.now().getTime() < a.retryAt) {
      this.request(agentId, a.retryAt - this.deps.now().getTime());
      return;
    }
    if (a) a.running = true;
    const release = await this.slot();
    try {
      if (this.stopping || !(await this.ensureLease())) return;
      await this.flushOutbox(agentId, a);
      if (a === undefined || !this.connected() || !this.canRead(a)) return;
      if (this.outboxFull()) {
        a.content = 'paused';
        return;
      }
      a.content = 'catching_up';
      if (a.base === undefined) a.base = (await this.deps.client.checkpoint(agentId)).checkpoint;
      const turnActive = a.entry.agent.status === 'running' || (a.entry.agent.activeTurn ?? null) !== null;
      for (let round = 0; round < MAX_ROUNDS_PER_SYNC && !this.stopping; round++) {
        const plan = await nextBatch({ sdk: this.deps.sdk, agentId, base: a.base, turnActive, startedAt: this.startedAt, pageLimit: this.cfg.pageLimit });
        if (plan === null) break;
        const batch = { ...plan.batch, source_id: this.cfg.sourceId, instance_id: this.deps.state.identity.instanceId, lease_epoch: this.lease!.epoch };
        const file = this.deps.outbox.put(batch);
        try {
          const ack = await this.deps.client.batch(batch);
          this.deps.outbox.remove(file);
          a.base = ack.checkpoint;
        } catch (err) {
          if (err instanceof RefusedError && (err.code === 'checkpoint_mismatch' || err.code === 'batch_conflict')) {
            // Built on a position the center does not have (restored backup, lost state): rebuild from its position.
            this.deps.outbox.remove(file);
            a.base = err.checkpoint === undefined ? undefined : err.checkpoint;
            if (a.base === undefined) a.base = (await this.deps.client.checkpoint(agentId)).checkpoint;
            continue;
          }
          throw err; // the batch stays in the outbox and is resent (re-stamped with the next lease if needed)
        }
        if (!plan.progressed || !plan.more) break;
        if (this.outboxFull()) {
          a.content = 'paused';
          return;
        }
      }
      if (a.lifecycle === 'archived') a.finalRead = true;
      a.content = 'current';
      a.failures = 0;
      a.retryAt = 0;
    } catch (err) {
      if (a) {
        a.failures += 1;
        a.content = 'error';
        const base = Math.min(AGENT_BACKOFF_MAX_MS, 2000 * 2 ** Math.min(a.failures, 10));
        a.retryAt = this.deps.now().getTime() + base * (0.5 + (this.deps.random ?? Math.random)() / 2);
        if (err instanceof RefusedError && err.code === 'unknown_agent') this.pushSnapshotSoon();
        if (!(err instanceof RetryableError) || a.failures === 1 || a.failures % 10 === 0) {
          this.noteError(`agent ${agentId}`, err);
        } else if (err instanceof RefusedError) this.noteError(`agent ${agentId}`, err);
      } else this.noteError(`outbox of agent ${agentId}`, err);
    } finally {
      release();
      if (a) {
        a.running = false;
        a.lastSyncAt = this.deps.now().getTime();
        if (a.dirty && !this.stopping) {
          a.dirty = false;
          this.request(agentId, a.failures > 0 ? Math.max(0, a.retryAt - this.deps.now().getTime()) : 0);
        } else if (a.failures > 0 && !this.stopping) {
          this.request(agentId, Math.max(0, a.retryAt - this.deps.now().getTime()));
        }
      }
    }
  }

  /**
   * Resends an agent's unacknowledged batches in order, content unchanged. A batch written under an earlier lease is
   * re-stamped with the current one first (the center recognizes a retry by content, not by writer).
   */
  private async flushOutbox(agentId: string, a: AgentState | undefined): Promise<void> {
    for (let { file, batch } of this.deps.outbox.pending(agentId)) {
      if (batch.source_id !== this.cfg.sourceId) {
        this.deps.outbox.remove(file);
        continue;
      }
      if (batch.lease_epoch !== this.lease!.epoch || batch.instance_id !== this.deps.state.identity.instanceId) {
        batch = { ...batch, lease_epoch: this.lease!.epoch, instance_id: this.deps.state.identity.instanceId };
        this.deps.outbox.remove(file);
        file = this.deps.outbox.put(batch);
      }
      try {
        const ack = await this.deps.client.batch(batch);
        this.deps.outbox.remove(file);
        if (a) a.base = ack.checkpoint;
      } catch (err) {
        if (err instanceof RefusedError && (err.code === 'checkpoint_mismatch' || err.code === 'batch_conflict')) {
          // Superseded: the center is at another position. Everything still queued for this agent continues from a
          // position the center does not have; it is read again from the center's position instead.
          for (const rest of this.deps.outbox.pending(agentId)) this.deps.outbox.remove(rest.file);
          if (a) a.base = undefined;
          return;
        }
        if (err instanceof FatalError) {
          this.log(`agent ${agentId}: outbox batch ${batch.batch_id} refused (${err.message}); dropping it, content will be read again`);
          for (const rest of this.deps.outbox.pending(agentId)) this.deps.outbox.remove(rest.file);
          if (a) a.base = undefined;
          return;
        }
        throw err;
      }
    }
  }
}
