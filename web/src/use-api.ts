import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, apiGet } from './api.ts';
import type { StreamState, Topic } from './stream.ts';

/** Where the live connection's state can be read, for the connection dot in the header. */
export type ConnectionSource = { get(): StreamState; subscribe(fn: () => void): () => void };

export type StreamSource = {
  /** Calls `fn` with the topics of every change message from the server; returns the unsubscribe function. */
  subscribe(fn: (topics: Topic[]) => void): () => void;
  connection?: ConnectionSource;
};

export const StreamContext = createContext<StreamSource>({ subscribe: () => () => {} });

const NO_CONNECTION: ConnectionSource = { get: () => 'closed', subscribe: () => () => {} };

export function useConnectionState(): StreamState {
  const connection = useContext(StreamContext).connection ?? NO_CONNECTION;
  return useSyncExternalStore(connection.subscribe, connection.get);
}

type Loaded<T> = { path: string; data: T | undefined; error: ApiError | null; loading: boolean };

/**
 * Reads `path` and keeps it fresh: it is read again whenever the server announces a change on one of `topics` (or on
 * `'all'`, which also covers a reconnect). While it is read again the old data stays, and only the latest request's
 * answer is used. `path: null` does nothing; a new `path` starts from empty. `loading` is true while any request is on its way.
 */
export function useApi<T>(
  path: string | null,
  topics: Topic[],
  opts: { auth?: boolean } = {},
): { data: T | undefined; error: ApiError | null; loading: boolean; reload: () => void } {
  const stream = useContext(StreamContext);
  const auth = opts.auth ?? false;
  const [state, setState] = useState<Loaded<T> | null>(null);
  const latest = useRef(0);
  const topicsRef = useRef(topics);
  useEffect(() => {
    topicsRef.current = topics;
  });

  const reload = useCallback(() => {
    if (path === null) return;
    const mine = ++latest.current;
    // Data and error of this same path survive the reload; anything left over from another path does not.
    const same = (s: Loaded<T> | null) => (s !== null && s.path === path ? s : null);
    setState((s) => ({ path, data: same(s)?.data, error: same(s)?.error ?? null, loading: true }));
    apiGet<T>(path, { auth }).then(
      (data) => {
        if (mine === latest.current) setState({ path, data, error: null, loading: false });
      },
      (err: unknown) => {
        if (mine !== latest.current) return;
        const error = err instanceof ApiError ? err : new ApiError(0, 'network', '连不上服务器');
        setState((s) => ({ path, data: same(s)?.data, error, loading: false }));
      },
    );
  }, [path, auth]);

  // Load on mount and whenever the path changes; whatever is still on its way for the old path is dropped.
  useEffect(() => {
    if (path === null) {
      setState(null);
      return;
    }
    reload();
    return () => {
      latest.current++;
    };
  }, [path, reload]);

  useEffect(() => {
    if (path === null) return;
    return stream.subscribe((incoming) => {
      if (incoming.includes('all') || incoming.some((t) => topicsRef.current.includes(t))) reload();
    });
  }, [stream, path, reload]);

  // `state` may still describe the previous path for one render: that is hidden until the effect above has run.
  const current = path !== null && state !== null && state.path === path ? state : null;
  return {
    data: current?.data,
    error: current?.error ?? null,
    loading: path !== null && (current === null || current.loading),
    reload,
  };
}
