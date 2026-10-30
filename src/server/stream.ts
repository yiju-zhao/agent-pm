import { STATUS_CODES } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { StreamMessage } from '../shared/stream-protocol.ts';
import type { ChangeFeed } from './change-feed.ts';

export const STREAM_PATH = '/stream';
export const STREAM_MAX_CLIENTS = 50;

/** A client that has this much unsent data is not keeping up (or is gone); it is dropped and reconnects to catch up. */
const MAX_BUFFERED_BYTES = 1_000_000;

/**
 * `WS /stream`: pushes the change feed's invalidation messages to every connected page, after a first `hello`. It
 * carries no data, only "re-read this", and still refuses a browser page from another site (an `Origin` whose host is not
 * the `Host` the request was sent to). Clients that stop answering pings, or fall a megabyte behind, are terminated.
 * Messages from clients are ignored. `close()` terminates every client and unsubscribes them from the feed; call it
 * before `server.close()`, which otherwise waits for the open WebSockets.
 */
export function attachStream(server: Server, feed: ChangeFeed, opts: { pingMs?: number } = {}): { close(): void } {
  // Clients have nothing to say, so a tiny payload limit keeps a hostile one from making us buffer much.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const clients = new Map<WebSocket, { alive: boolean; unsubscribe: () => void }>();
  let handshakes = 0;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== STREAM_PATH) return reject(socket, 404);
    const origin = req.headers.origin;
    if (origin !== undefined && !sameHost(origin, req.headers.host)) return reject(socket, 403);
    if (clients.size + handshakes >= STREAM_MAX_CLIENTS) return reject(socket, 503);

    // Handshakes in flight count against the limit too; one that fails closes its socket.
    handshakes++;
    let handshaking = true;
    const settled = () => {
      if (handshaking) handshakes--;
      handshaking = false;
    };
    socket.once('close', settled);
    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off('close', settled);
      settled();
      ws.on('error', () => ws.terminate());
      ws.send(JSON.stringify({ type: 'hello' } satisfies StreamMessage));
      const unsubscribe = feed.subscribe((msg) => {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.terminate();
        else ws.send(JSON.stringify(msg));
      });
      const client = { alive: true, unsubscribe };
      clients.set(ws, client);
      ws.on('pong', () => {
        client.alive = true;
      });
      ws.on('close', () => {
        unsubscribe();
        clients.delete(ws);
      });
    });
  };
  server.on('upgrade', onUpgrade);

  // A client that did not answer the previous ping is gone (a sleeping laptop, a dropped network): end it.
  const heartbeat = setInterval(() => {
    for (const [ws, client] of clients) {
      if (!client.alive) {
        ws.terminate();
        continue;
      }
      client.alive = false;
      ws.ping();
    }
  }, opts.pingMs ?? 30_000);
  heartbeat.unref();

  return {
    close() {
      server.off('upgrade', onUpgrade);
      clearInterval(heartbeat);
      for (const [ws, client] of clients) {
        client.unsubscribe();
        ws.terminate();
      }
      clients.clear();
      wss.close();
    },
  };
}

/** Whether the `Origin` header names the host (with port) the request was sent to. */
function sameHost(origin: string, host: string | undefined): boolean {
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false; // e.g. `Origin: null` from a sandboxed page or a file
  }
}

function reject(socket: Duplex, status: number): void {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
