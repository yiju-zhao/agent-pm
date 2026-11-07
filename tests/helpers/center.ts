// A real center (temporary SQLite database + the Hono app) with a controllable clock, plus builders for herdr and
// Paseo pushes. Used by the center tests and by the collector integration tests, which call the app in-process.
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';
import type { ServerConfig } from '../../src/server/config.ts';
import type { AgentObservation, BatchV2, SnapshotV2, TimelineEvent } from '../../src/shared/ingest-v2.ts';
import type { ChunkPush, SnapshotPush, SnapshotSession } from '../../src/shared/protocol.ts';

export const MACHINE = 'mac-mini';
export const HERDR_TOKEN = 'herdr-mac-mini-token';
export const PASEO_SOURCE = 'paseo-mac-mini';
export const PASEO_TOKEN = 'paseo-mac-mini-token-0123456789';
export const SERVER_ID = 'srv_test_mini';
export const OTHER_SOURCE = 'paseo-gx10';
export const OTHER_TOKEN = 'paseo-gx10-token-0123456789abc';

export const config: ServerConfig = {
  port: 7718,
  dbPath: ':memory:',
  userToken: 'user-secret-token-0123456789',
  mcpToken: 'mcp-secret-token-0123456789',
  collectors: { [MACHINE]: HERDR_TOKEN, 'gx10-090e': 'herdr-gx10-token' },
  paseoCollectors: {
    [PASEO_SOURCE]: { token: PASEO_TOKEN, machine: MACHINE, serverId: SERVER_ID },
    [OTHER_SOURCE]: { token: OTHER_TOKEN, machine: 'gx10-090e', serverId: 'srv_test_gx10' },
  },
};

export type Center = {
  db: DatabaseSync;
  app: ReturnType<typeof createApp>;
  now: Date;
  advance(ms: number): void;
  close(): void;
};

export function startCenter(path = ':memory:', start = new Date('2026-11-06T10:00:00.000Z')): Center {
  const db = openDb(path);
  const center: Center = {
    db,
    now: start,
    app: undefined as unknown as ReturnType<typeof createApp>,
    advance(ms) {
      center.now = new Date(center.now.getTime() + ms);
    },
    close() {
      db.close();
    },
  };
  center.app = createApp(db, config, () => center.now);
  return center;
}

export async function call(center: Center, method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await center.app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// ---- herdr ---------------------------------------------------------------------------------------------------------

export function herdrSession(key: string, extra: Partial<SnapshotSession> = {}): SnapshotSession {
  const sep = key.indexOf(':');
  const pending = key.startsWith('pending:');
  return {
    key,
    agent_kind: pending ? 'codex' : key.slice(0, sep),
    native_id: pending ? null : key.slice(sep + 1),
    pane_id: 'w1:1:1',
    terminal_id: 'term_1',
    workspace_id: 'w1',
    tab_id: 'w1:1',
    cwd: '/work/proj',
    title: 'herdr task',
    live_status: 'working',
    fidelity: pending ? 'screen' : 'full',
    transcript_path: pending ? null : `/home/u/.claude/${key.slice(sep + 1)}.jsonl`,
    ...extra,
  };
}

export function herdrSnapshot(sessions: SnapshotSession[], machine = MACHINE, purged: string[] = []): SnapshotPush {
  return { machine, collector_version: '0.1.0', sessions, purged };
}

export function herdrChunks(key: string, from: number, to: number, text = `herdr text ${from}`, machine = MACHINE): ChunkPush {
  return {
    machine,
    chunks: [{ session_key: key, kind: 'transcript', offset_start: from * 1000, offset_end: to, ts_start: '2026-11-06T09:59:00.000Z', ts_end: '2026-11-06T09:59:30.000Z', text, backfill: false }],
  };
}

// ---- Paseo ---------------------------------------------------------------------------------------------------------

export function agent(agentId: string, extra: Partial<AgentObservation> = {}): AgentObservation {
  return {
    agent_id: agentId,
    provider: 'claude',
    native_id: null,
    native_id_origin: null,
    cwd: '/work/proj',
    title: 'paseo task',
    workspace_id: 'ws_1',
    raw_status: 'running',
    status: 'working',
    attention: null,
    lifecycle: 'live',
    content: 'current',
    ...extra,
  };
}

/** A Paseo writer: holds the lease and numbers its snapshots. */
export class PaseoWriter {
  rev = 0;
  epoch = 0;
  readonly center: Center;
  readonly instance: string;
  readonly token: string;
  readonly sourceId: string;
  readonly serverId: string;
  constructor(center: Center, instance = 'instance-a-0001', token = PASEO_TOKEN, sourceId = PASEO_SOURCE, serverId = SERVER_ID) {
    this.center = center;
    this.instance = instance;
    this.token = token;
    this.sourceId = sourceId;
    this.serverId = serverId;
  }

  async lease(): Promise<{ status: number; json: any }> {
    const r = await call(this.center, 'POST', '/ingest/v2/lease', this.token, {
      source_id: this.sourceId,
      instance_id: this.instance,
      server_id: this.serverId,
      collector_version: '0.2.0',
    });
    if (r.status === 200) {
      this.epoch = r.json.lease_epoch;
      this.rev = r.json.snapshot_rev;
    }
    return r;
  }

  snapshotBody(agents: AgentObservation[], extra: Partial<SnapshotV2> = {}): SnapshotV2 {
    return {
      source_id: this.sourceId,
      instance_id: this.instance,
      lease_epoch: this.epoch,
      collector_version: '0.2.0',
      snapshot_rev: ++this.rev,
      daemon: { status: 'connected', error: null, server_id: this.serverId },
      complete: true,
      agents,
      ...extra,
    };
  }

  snapshot(agents: AgentObservation[], extra: Partial<SnapshotV2> = {}): Promise<{ status: number; json: any }> {
    return call(this.center, 'POST', '/ingest/v2/snapshot', this.token, this.snapshotBody(agents, extra));
  }

  batchBody(agentId: string, base: BatchV2['base'], next: BatchV2['next'], events: TimelineEvent[], extra: Partial<BatchV2> = {}): BatchV2 {
    return {
      source_id: this.sourceId,
      instance_id: this.instance,
      lease_epoch: this.epoch,
      batch_id: `batch-${Math.random().toString(36).slice(2, 12)}`,
      agent_id: agentId,
      base,
      next,
      reset: null,
      events,
      gaps: [],
      filtered: {},
      ...extra,
    };
  }

  batch(body: BatchV2): Promise<{ status: number; json: any }> {
    return call(this.center, 'POST', '/ingest/v2/batches', this.token, body);
  }

  checkpoint(agentId: string): Promise<{ status: number; json: any }> {
    return call(this.center, 'GET', `/ingest/v2/checkpoint?agent_id=${encodeURIComponent(agentId)}`, this.token);
  }
}

export function event(key: string, seq: number, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    key,
    stable_id: !key.startsWith('row:'),
    kind: 'assistant',
    item_type: 'assistant_message',
    epoch: 'epoch-1',
    seq_start: seq,
    seq_end: seq,
    ts: new Date(Date.parse('2026-11-06T09:00:00.000Z') + seq * 1000).toISOString(),
    backfill: false,
    text: `assistant says ${key} with enough words to be worth reading`,
    text_truncated: null,
    tool: null,
    ...extra,
  };
}

// ---- reads ---------------------------------------------------------------------------------------------------------

export function sessionRow(db: DatabaseSync, key: string): Record<string, any> | undefined {
  return db.prepare('SELECT * FROM sessions WHERE key = ?').get(key) as Record<string, any> | undefined;
}

export function count(db: DatabaseSync, sql: string, ...args: Array<string | number>): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}
