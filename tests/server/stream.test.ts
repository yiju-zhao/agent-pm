import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { execute } from '../../src/domain/execute.ts';
import type { DomainDeps } from '../../src/domain/types.ts';
import { ChangeFeed } from '../../src/server/change-feed.ts';
import type { ServerConfig } from '../../src/server/config.ts';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';
import { attachStream, STREAM_MAX_CLIENTS } from '../../src/server/stream.ts';
import type { StreamMessage } from '../../src/shared/stream-protocol.ts';
import { disabledStatus } from '../../src/understand/status.ts';

const config: ServerConfig = {
  port: 0,
  dbPath: ':memory:',
  userToken: 'user-secret-token-0123456789',
  mcpToken: 'mcp-secret-token-0123456789',
  collectors: {},
};

let db: DatabaseSync;
let deps: DomainDeps;
let feed: ChangeFeed;
let server: Server;
let stream: { close(): void };
let port: number;
let closed = false;
const clients: WebSocket[] = [];

beforeEach(async () => {
  db = openDb(':memory:');
  let n = 0;
  deps = { now: () => new Date('2026-10-30T10:00:00.000Z'), newId: (prefix) => `${prefix}_${++n}` };
  feed = new ChangeFeed(db, { now: deps.now, status: disabledStatus });
  closed = false;
  server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: createApp(db, config, deps.now).fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s as Server));
  });
  port = (server.address() as AddressInfo).port;
  stream = attachStream(server, feed);
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  if (!closed) {
    stream.close();
    feed.stop();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
  db.close();
});

// The `ws` client rather than Node's global WebSocket: it can send an `Origin` header of our choosing, as a browser on
// another site would. `ended` settles on `close` (a failed handshake fires `error` first, then `close`).
type Conn = { ws: WebSocket; messages: StreamMessage[]; next(): Promise<StreamMessage>; ended: Promise<void> };

function connect(path = '/stream', headers?: Record<string, string>, autoPong = true): Conn {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, autoPong });
  clients.push(ws);
  ws.on('error', () => {});
  const messages: StreamMessage[] = [];
  const waiters: Array<(m: StreamMessage) => void> = [];
  let read = 0;
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)) as StreamMessage);
    waiters.shift()?.(messages[read++]!);
  });
  const ended = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  return {
    ws,
    messages,
    next: () => (read < messages.length ? Promise.resolve(messages[read++]!) : new Promise((resolve) => waiters.push(resolve))),
    ended,
  };
}

test('first message is hello', async () => {
  const c = connect();
  expect(await c.next()).toEqual({ type: 'hello' });
});

test('pushes feed messages', async () => {
  const c = connect();
  expect(await c.next()).toEqual({ type: 'hello' });
  const r = execute(db, deps, { op: 'create_project', args: { title: '项目' }, actor: 'user' }) as unknown as { id: string; event_id: number };
  feed.poll();
  expect(await c.next()).toEqual({
    type: 'events',
    events: [{ id: r.event_id, project_id: r.id, op: 'create_project', actor: 'user' }],
    more: false,
  });
});

test('rejects a foreign Origin', async () => {
  const evil = connect('/stream', { Origin: 'http://evil.example' });
  await evil.ended;
  expect(evil.messages).toEqual([]);

  const same = connect('/stream', { Origin: `http://127.0.0.1:${port}` });
  expect(await same.next()).toEqual({ type: 'hello' });
});

test('rejects other paths', async () => {
  const c = connect('/nope');
  await c.ended;
  expect(c.messages).toEqual([]);
});

test('close() ends clients and server.close completes', async () => {
  const c = connect();
  expect(await c.next()).toEqual({ type: 'hello' });
  stream.close();
  feed.stop();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closed = true;
  await c.ended;
  expect(c.ws.readyState).toBe(WebSocket.CLOSED);
});

/** The HTTP status a raw upgrade request gets: 101 when accepted, else the rejection. */
function upgradeStatus(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('rejections answer 404, 403 and 503', async () => {
  expect(await upgradeStatus('/nope')).toBe(404);
  expect(await upgradeStatus('/stream', { Origin: 'http://evil.example' })).toBe(403);
  expect(await upgradeStatus('/stream', { Origin: 'null' })).toBe(403);
  expect(await upgradeStatus('/stream', { Origin: `http://127.0.0.1:${port}` })).toBe(101);
  expect(await upgradeStatus('/stream?x=1')).toBe(101);

  const conns = Array.from({ length: STREAM_MAX_CLIENTS }, () => connect());
  await Promise.all(conns.map((c) => c.next()));
  expect(await upgradeStatus('/stream')).toBe(503);
  conns[0]!.ws.close();
  await conns[0]!.ended;
  // The server sees the close a moment after the client does.
  let status = 0;
  for (let i = 0; i < 50 && status !== 101; i++) {
    status = await upgradeStatus('/stream');
    if (status !== 101) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(status).toBe(101);
});

test('a client that stops answering pings is terminated; one that answers stays', async () => {
  stream.close();
  stream = attachStream(server, feed, { pingMs: 20 });
  const silent = connect('/stream', undefined, false);
  const healthy = connect();
  expect(await silent.next()).toEqual({ type: 'hello' });
  expect(await healthy.next()).toEqual({ type: 'hello' });
  await silent.ended;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
});
