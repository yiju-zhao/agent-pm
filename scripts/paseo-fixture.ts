// Captures redacted Paseo SDK responses as test fixtures. Read-only: it lists the agent directory and reads timeline
// pages of agents that are already loaded in the daemon (never an unloaded one: reading those resumes them).
//
//   node scripts/paseo-fixture.ts <ws-url> <out-dir> <agentId>...
//
// Every string that could carry conversation, paths, titles or ids is replaced: text by a placeholder of the same
// length (so truncation paths stay testable), ids by a stable hash, paths by /work/..., timestamps shifted to a fixed
// base. Structural values (type, status, provider, epoch shape, seq numbers, collapse markers) are kept.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPaseoClient } from '@getpaseo/client';

const [url, outDir, ...agentIds] = process.argv.slice(2);
if (!url || !outDir || agentIds.length === 0) throw new Error('usage: node scripts/paseo-fixture.ts <ws-url> <out-dir> <agentId>...');

const KEEP = new Set(['type', 'status', 'provider', 'attentionReason', 'currentModeId', 'model', 'runtimeModel', 'direction', 'projection', 'collapsed', 'level', 'trigger', 'subAgentType', 'toolName', 'mode']);
const ID_KEYS = new Set(['id', 'agentId', 'callId', 'messageId', 'clientMessageId', 'sessionId', 'nativeHandle', 'threadId', 'workspaceId', 'turnId', 'requestId', 'projectKey', 'tool_use_id', 'serverId']);
const TS_KEYS = /At$|^timestamp$|Timestamp$/;
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
let tsOrigin: number | null = null;
let counter = 0;

const hashId = (s: string) => `id-${createHash('sha256').update(s).digest('hex').slice(0, 12)}`;
const epochs = new Map<string, string>();
const epochOf = (s: string) => {
  if (!epochs.has(s)) epochs.set(s, `epoch-${epochs.size + 1}`);
  return epochs.get(s)!;
};
function shiftTs(s: string): string {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  tsOrigin ??= t;
  return new Date(BASE + (t - tsOrigin)).toISOString();
}
function placeholder(key: string, s: string): string {
  const head = `${key}#${++counter} `;
  return s.length <= head.length ? head.slice(0, Math.max(1, s.length)) : head + 'x'.repeat(s.length - head.length);
}

function redact(v: unknown, key = ''): unknown {
  if (typeof v === 'string') {
    if (KEEP.has(key)) return v;
    if (key === 'epoch') return epochOf(v);
    if (ID_KEYS.has(key)) return hashId(v);
    if (TS_KEYS.test(key)) return shiftTs(v);
    if (key === 'cwd' || key === 'worktreeRoot' || key === 'filePath' || key === 'path') return '/work/project';
    return placeholder(key, v);
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === 'object') {
    // Provider persistence metadata and feature/mode descriptors are not needed by the collector.
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, k === 'metadata' || k === 'availableModes' || k === 'features' ? (Array.isArray(x) ? [] : {}) : redact(x, k)]),
    );
  }
  return v;
}

const client = createPaseoClient({ url, reconnect: { enabled: false } });
await client.connect();
mkdirSync(outDir, { recursive: true });
const write = (name: string, data: unknown) => writeFileSync(join(outDir, name), `${JSON.stringify(redact(data), null, 1)}\n`);

const directory = await client.agents.list({ includeBackground: true, page: { limit: 200 } });
write('directory.json', { serverIdPresent: Boolean(client.agents.ref('x').address.serverId), entries: directory.entries, pageInfo: directory.pageInfo });

for (const id of agentIds) {
  const entry = directory.entries.find((e) => e.agent.id === id);
  if (!entry) throw new Error(`agent ${id} is not in the directory`);
  if ((entry.agent.availableModes?.length ?? 0) === 0) throw new Error(`agent ${id} is not loaded; reading it would resume it`);
  const agent = client.agents.ref(id);
  const provider = entry.agent.provider;
  const tail = await agent.timeline.refetch({ direction: 'tail', limit: 1 });
  const first = await agent.timeline.refetch({ direction: 'after', cursor: { epoch: tail.epoch, seq: 0 }, limit: 12 });
  const second = await agent.timeline.refetch({ direction: 'after', cursor: first.endCursor!, limit: 12 });
  const stale = await agent.timeline.refetch({ direction: 'after', cursor: { epoch: 'replaced-epoch', seq: 3 }, limit: 3 });
  const end = await agent.timeline.refetch({ direction: 'after', cursor: { epoch: tail.epoch, seq: tail.window.maxSeq }, limit: 3 });
  const strip = (r: typeof tail) => ({ ...r, agent: null });
  write(`timeline-${provider}-after-0.json`, strip(first));
  write(`timeline-${provider}-after-page2.json`, strip(second));
  write(`timeline-${provider}-stale-epoch.json`, strip(stale));
  write(`timeline-${provider}-at-end.json`, strip(end));
}
await client.close();
console.log(`wrote fixtures to ${outDir}`);
