// Read-only contract probe against a real Paseo daemon. Never creates, sends, stops or archives anything.
// Prints shapes and counts only; text content is reduced to lengths so no conversation leaks to the terminal.
//   node scripts/paseo-probe.ts ws://HOST:PORT/ws [--timeline <agentId>] [--subscribe <agentId> <seconds>]
import { createPaseoClient } from '@getpaseo/client';

const url = process.argv[2];
if (!url) throw new Error('usage: node scripts/paseo-probe.ts <ws-url> [--timeline <agentId>]');
const args = process.argv.slice(3);
const password = process.env.PASEO_PASSWORD || undefined;

function shape(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return `<str ${v.length}>`;
  if (Array.isArray(v)) return depth > 4 ? `<arr ${v.length}>` : v.slice(0, 2).map((x) => shape(x, depth + 1)).concat(v.length > 2 ? [`…${v.length}`] : []);
  if (v && typeof v === 'object') {
    if (depth > 5) return '<obj>';
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ['type', 'status', 'provider', 'epoch', 'direction', 'projection'].includes(k) ? x : shape(x, depth + 1)]));
  }
  return v;
}

const client = createPaseoClient({ url, password, reconnect: { enabled: false } });
await client.connect();
const serverId = client.agents.ref('probe').address.serverId;
console.log('serverId', serverId);

const all: any[] = [];
let cursor: string | undefined;
let pages = 0;
for (;;) {
  const page = await client.agents.list({ includeBackground: true, page: { limit: 50, ...(cursor ? { cursor } : {}) } } as any);
  pages++;
  all.push(...page.entries);
  if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
  cursor = page.pageInfo.nextCursor;
}
const fg = await client.agents.list({ page: { limit: 200 } } as any);
console.log('pages', pages, 'entries(includeBackground)', all.length, 'entries(default)', fg.entries.length);
const tally = (f: (e: any) => string) => all.reduce((m: Record<string, number>, e) => ((m[f(e)] = (m[f(e)] ?? 0) + 1), m), {});
console.log('provider/status', tally((e) => `${e.agent.provider}/${e.agent.status}`));
console.log('archived', tally((e) => String(Boolean(e.agent.archivedAt))));
console.log('runtimeInfo.sessionId present', tally((e) => `${e.agent.provider}:${e.agent.runtimeInfo?.sessionId ? 'yes' : 'no'}`));
console.log('persistence.sessionId present', tally((e) => `${e.agent.provider}:${e.agent.persistence?.sessionId ? 'yes' : 'no'}`));
console.log('runtime==persistence', tally((e) => String(!e.agent.runtimeInfo?.sessionId || e.agent.runtimeInfo?.sessionId === e.agent.persistence?.sessionId)));
console.log('capabilities.supportsStreaming', tally((e) => `${e.agent.status}:${e.agent.capabilities?.supportsStreaming}`));
console.log('availableModes>0', tally((e) => `${e.agent.status}:${(e.agent.availableModes?.length ?? 0) > 0}`));
console.log('entry shape', JSON.stringify(shape(all[0]), null, 1));

const tIdx = args.indexOf('--timeline');
if (tIdx >= 0) {
  const id = args[tIdx + 1]!;
  const agent = client.agents.ref(id);
  let res = await agent.timeline.refetch({ direction: 'tail', limit: 20 });
  console.log('tail', JSON.stringify({ ...shape({ ...res, entries: undefined }) as object, entryCount: res.entries.length }));
  const types = (es: any[]) => es.map((e) => `${e.item.type}${e.item.status ? '/' + e.item.status : ''}[${e.seqStart}-${e.seqEnd}]${e.collapsed.length ? '{' + e.collapsed.join(',') + '}' : ''}${e.item.messageId ? 'm' : ''}${e.item.callId ? 'c' : ''}`);
  console.log(types(res.entries).join(' '));
  if (res.entries[0]) console.log('first entry shape', JSON.stringify(shape(res.entries[0])));
  const tool = res.entries.find((e: any) => e.item.type === 'tool_call');
  if (tool) console.log('tool shape', JSON.stringify(shape(tool.item)));
  // Page backwards from the start to see the whole history.
  let total = res.entries.length;
  let pagesBack = 0;
  while (res.hasOlder && res.startCursor && pagesBack < 200) {
    res = await agent.timeline.refetch({ direction: 'before', cursor: res.startCursor, limit: 100 });
    total += res.entries.length;
    pagesBack++;
  }
  console.log('history entries', total, 'pages back', pagesBack, 'oldest window', JSON.stringify(res.window), 'startCursor', JSON.stringify(res.startCursor));
  // Forward from seq 0 to see `after` semantics.
  const fwd = await agent.timeline.refetch({ direction: 'after', cursor: { epoch: res.epoch, seq: 0 }, limit: 5 });
  console.log('after seq0', JSON.stringify({ reset: fwd.reset, staleCursor: fwd.staleCursor, gap: fwd.gap, start: fwd.startCursor, end: fwd.endCursor, hasNewer: fwd.hasNewer, n: fwd.entries.length }), types(fwd.entries).join(' '));
  const stale = await agent.timeline.refetch({ direction: 'after', cursor: { epoch: 'bogus-epoch', seq: 3 }, limit: 5 });
  console.log('after stale epoch', JSON.stringify({ reset: stale.reset, staleCursor: stale.staleCursor, gap: stale.gap, epoch: stale.epoch === res.epoch, start: stale.startCursor, n: stale.entries.length }));
}
const sIdx = args.indexOf('--subscribe');
if (sIdx >= 0) {
  const id = args[sIdx + 1]!;
  const secs = Number(args[sIdx + 2] ?? 30);
  const sub: any = client.agents.ref(id).timeline.subscribe((ev: any) => {
    const e = ev.event;
    console.log('event', e.type, e.item ? `${e.item.type}${e.item.status ? '/' + e.item.status : ''}` : '', 'seq', ev.seq, 'epoch?', Boolean(ev.epoch), e.item?.messageId ? 'mid' : '', e.item?.callId ? 'cid' : '', e.item?.text !== undefined ? `len=${e.item.text.length}` : '');
  });
  await sub.ready;
  console.log('subscribed; listening', secs, 's');
  await new Promise((r) => setTimeout(r, secs * 1000));
  sub();
}
await client.close();
