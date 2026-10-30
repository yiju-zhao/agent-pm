import type { StreamMessage } from '../../src/shared/stream-protocol.ts';

// The live connection to `WS /stream`. The server only says *what* changed (see src/shared/stream-protocol.ts); the
// client turns that into topics, and whoever shows that data (`useApi`) reads the HTTP endpoint again.

export type Topic = 'all' | 'projects' | `project:${string}` | 'questions' | 'sessions' | 'status';
/**
 * `connecting` covers the first attempt and every retry after a drop (the page shows "重连中" the whole time it is
 * trying again); `closed` is only before `start()` and after `stop()`.
 */
export type StreamState = 'connecting' | 'open' | 'closed';

/** Wait before the n-th retry in a row; after the last entry it stays at the last one. Reset by a successful open. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];

/** The topics a message invalidates. `hello` (sent on every connect) and an overflowing event batch mean "everything". */
export function topicsFor(msg: StreamMessage): Topic[] {
  switch (msg.type) {
    case 'hello':
      return ['all'];
    case 'events': {
      if (msg.more) return ['all'];
      const projects = new Set<string>();
      for (const event of msg.events) if (event.project_id) projects.add(event.project_id);
      return ['projects', 'questions', ...[...projects].map((id): Topic => `project:${id}`)];
    }
    case 'questions':
      return ['questions', 'projects'];
    case 'sessions':
      return ['sessions', 'projects'];
    case 'status':
      return ['status'];
  }
}

/** The message in a frame, or null when it is not one we know how to read (those are ignored). */
function parseMessage(data: unknown): StreamMessage | null {
  if (typeof data !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const msg = value as { type?: unknown; events?: unknown; more?: unknown };
  switch (msg.type) {
    case 'hello':
    case 'questions':
    case 'sessions':
    case 'status':
      return { type: msg.type };
    case 'events': {
      if (!Array.isArray(msg.events) || typeof msg.more !== 'boolean') return null;
      const events: Extract<StreamMessage, { type: 'events' }>['events'] = [];
      for (const event of msg.events) {
        if (typeof event !== 'object' || event === null) return null;
        const { id, project_id, op, actor } = event as Record<string, unknown>;
        if (typeof id !== 'number' || (project_id !== null && typeof project_id !== 'string')) return null;
        events.push({ id, project_id, op: String(op), actor: String(actor) });
      }
      return { type: 'events', events, more: msg.more };
    }
    default:
      return null;
  }
}

/** `ws://host/stream` for an `http:` page, `wss://` for an `https:` one. */
export function streamUrl(loc: Pick<Location, 'protocol' | 'host'>): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/stream`;
}

export class StreamClient {
  readonly #url: string;
  readonly #WebSocketImpl: typeof WebSocket;
  readonly #topicListeners = new Set<(topics: Topic[]) => void>();
  readonly #stateListeners = new Set<(state: StreamState) => void>();
  #socket: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #failures = 0;
  #state: StreamState = 'closed';

  constructor(url: string, opts: { WebSocketImpl?: typeof WebSocket } = {}) {
    this.#url = url;
    this.#WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
  }

  get state(): StreamState {
    return this.#state;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#failures = 0;
    this.#connect();
  }

  /** Closes the socket and cancels a pending retry. Nothing reconnects afterwards, until `start()` is called again. */
  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    this.#setState('closed');
  }

  onTopics(fn: (topics: Topic[]) => void): () => void {
    this.#topicListeners.add(fn);
    return () => {
      this.#topicListeners.delete(fn);
    };
  }

  onState(fn: (state: StreamState) => void): () => void {
    this.#stateListeners.add(fn);
    return () => {
      this.#stateListeners.delete(fn);
    };
  }

  #connect(): void {
    this.#timer = null;
    this.#setState('connecting');
    let socket: WebSocket;
    try {
      socket = new this.#WebSocketImpl(this.#url);
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      this.#failures = 0;
      this.#setState('open');
    };
    socket.onmessage = (ev) => {
      const msg = parseMessage(ev.data);
      if (msg !== null) this.#emit(this.#topicListeners, topicsFor(msg));
    };
    // A browser always follows `error` with `close`, so only `close` schedules the retry.
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#scheduleRetry();
    };
  }

  #scheduleRetry(): void {
    if (!this.#running) return;
    this.#setState('connecting');
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#failures, RECONNECT_DELAYS_MS.length - 1)];
    this.#failures++;
    this.#timer = setTimeout(() => this.#connect(), delay);
  }

  #setState(state: StreamState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#emit(this.#stateListeners, state);
  }

  /** One failing listener must not keep the others from hearing about the change. */
  #emit<A>(listeners: Set<(arg: A) => void>, arg: A): void {
    for (const fn of [...listeners]) {
      try {
        fn(arg);
      } catch (err) {
        console.error('stream listener failed', err);
      }
    }
  }
}
