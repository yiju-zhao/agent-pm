import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SnapshotPush, SnapshotSession } from '../shared/protocol.ts';
import { makeSessionKey } from '../shared/session-key.ts';
import { createPmClient, RetryableError } from './client.ts';
import type { PmClient } from './client.ts';
import type { CollectorConfig } from './config.ts';
import { CursorStore } from './cursor-store.ts';
import { parseHerdrSnapshot, readHerdrScreen, readHerdrSnapshot, readPaneProcess } from './herdr.ts';
import { locateTranscript } from './locate.ts';
import { buildChunks, MAX_CHUNK_CHARS, normalizeClaude, normalizeCodex } from './normalize.ts';
import { listRecentRollouts, matchRollout, processStartTime } from './pending.ts';
import type { RolloutCandidate } from './pending.ts';
import { readDelta } from './read-delta.ts';

export const COLLECTOR_VERSION = '0.1.0';

/** Largest transcript window read (and pushed) in one go. */
export const READ_MAX_BYTES = 4 * 1024 * 1024;
const PURGE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** An id-less codex pane whose rollout could not be matched is retried at most this often. */
const RESOLVE_RETRY_MS = 60 * 1000;
/** Retry cap after failed ticks; below the server's 3-minute offline threshold (Ruling R8). */
export const MAX_BACKOFF_MS = 120_000;
/** During a long tick (initial import) the snapshot is pushed again this often, as the machine's heartbeat. */
const HEARTBEAT_MS = 60 * 1000;

export type Deps = {
  readSnapshot(): Promise<unknown>;
  readScreen(paneId: string): Promise<string>;
  paneProcess(paneId: string): Promise<{ pid: number; cwd: string } | null>;
  processStartTime(pid: number): Promise<Date | null>;
  client: PmClient;
  now(): Date;
  startedAt: Date;
  /** One-line diagnostics for failures that do not abort the tick; defaults to stderr. */
  log?(line: string): void;
};

type Tick = {
  cfg: CollectorConfig;
  store: CursorStore;
  deps: Deps;
  now: Date;
  /** Rollouts of the last 7 days, listed at most once per tick and only if some pane needs them. */
  rollouts: () => Promise<RolloutCandidate[]>;
  /** Set when in-memory state changed that no cursor save will persist. */
  dirty: boolean;
  log(line: string): void;
  /** Re-pushes the tick's snapshot when the last push was HEARTBEAT_MS or more ago (by `deps.now()`). */
  heartbeat(): Promise<void>;
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}

/**
 * The rollout of an id-less codex pane: its foreground process's start time and cwd matched against
 * recent rollouts. Cached per pending key and pid, so a match is looked up once and a miss is retried
 * only every RESOLVE_RETRY_MS. When the process lookup fails (herdr hiccup), a cached match is kept
 * rather than flipping the session back to its pending key for one tick.
 */
async function resolveIdlessCodex(s: SnapshotSession, t: Tick): Promise<{ id: string; path: string } | null> {
  const proc = await t.deps.paneProcess(s.pane_id);
  const cached = t.store.getResolution(s.key);
  if (proc === null) return cached?.match ?? null;
  if (cached !== undefined && cached.pid === proc.pid) {
    if (cached.match !== null) return cached.match;
    if (t.now.getTime() - Date.parse(cached.checkedAt) < RESOLVE_RETRY_MS) return null;
  }
  const startedAt = await t.deps.processStartTime(proc.pid);
  const match =
    startedAt === null ? null : matchRollout(await t.rollouts(), { cwd: proc.cwd || s.cwd, startedAt });
  t.store.setResolution(s.key, { pid: proc.pid, match, checkedAt: t.now.toISOString() });
  t.dirty = true;
  return match;
}

/** Transcript file of a session: the cursor's path or `hint` while they still exist, else a fresh search. */
async function transcriptPath(key: string, agentKind: string, nativeId: string, hint: string | null, t: Tick) {
  for (const p of [t.store.get(key)?.path, hint]) {
    if (p && (await isFile(p))) return p;
  }
  return locateTranscript(agentKind, nativeId, { claudeDir: t.cfg.claudeDir, codexDir: t.cfg.codexDir });
}

/** Gives a session its native identity and transcript where possible; otherwise it stays at screen fidelity. */
async function resolveSession(s: SnapshotSession, t: Tick): Promise<SnapshotSession> {
  let nativeId = s.native_id;
  let hint: string | null = null;
  if (nativeId === null && s.agent_kind === 'codex') {
    const match = await resolveIdlessCodex(s, t);
    if (match !== null) {
      nativeId = match.id;
      hint = match.path;
    }
  }
  if (nativeId === null) return s;
  const key = makeSessionKey(s.agent_kind, nativeId);
  const path = await transcriptPath(key, s.agent_kind, nativeId, hint, t);
  const resolved = { ...s, key, native_id: nativeId };
  return path === null ? resolved : { ...resolved, fidelity: 'full', transcript_path: path };
}

/**
 * Cursors of sessions herdr no longer reports: a transcript that no longer exists is reported as
 * purged; a screen-only cursor has nothing to purge and is simply dropped.
 */
async function purgeCheck(sessions: SnapshotSession[], store: CursorStore) {
  const reported = new Set(sessions.map((s) => s.key));
  const purged: string[] = [];
  const dropped: string[] = [];
  for (const key of store.keys()) {
    if (reported.has(key)) continue;
    const path = store.get(key)!.path;
    if (path === null) dropped.push(key);
    else if (!(await isFile(path))) purged.push(key);
  }
  return { purged, dropped };
}

/**
 * Pushes everything appended to a session's transcript since the confirmed cursor, one read window
 * per push; the cursor moves only after the server accepted the window's chunks.
 */
async function pushTranscript(s: SnapshotSession, t: Tick): Promise<number> {
  const { store, deps } = t;
  const path = s.transcript_path!;
  const cur = store.get(s.key);
  const local = cur !== undefined && cur.path === path ? cur.offset : null;
  let offset: number;
  if (local !== null && store.serverChecked.has(s.key)) {
    offset = local;
  } else {
    // First push of this session in this process (Ruling R9), or no local cursor for this file (first
    // sight, state file lost): never resume past the server, whose database may have been restored
    // from an older backup. Re-reading [server max, local cursor) cannot duplicate: every chunk the
    // server holds has offset_start < its max offset_end * 1000, every re-read chunk starts at or
    // above it, and a range the local cursor passed without the server advancing yields no chunks.
    const serverMax = (await deps.client.getOffset(s.key)) ?? 0;
    offset = local === null ? serverMax : Math.min(local, serverMax);
    store.serverChecked.add(s.key);
    store.set(s.key, { path, offset, fidelity: 'full' });
    await store.save();
  }

  const normalize = s.agent_kind === 'codex' ? normalizeCodex : normalizeClaude;
  const startedAt = deps.startedAt.getTime();
  let pushed = 0;
  for (;;) {
    const r = await readDelta(path, offset, READ_MAX_BYTES);
    // A transcript that vanished mid-tick is retried next tick with the cursor untouched.
    if (r.missing || r.newOffset === offset) break;
    if (r.reset) {
      // Chunks re-read from 0 whose offset_start collides with the old file's are dropped as duplicates.
      t.log(
        `${t.now.toISOString()} herdr-pm collector: session ${s.key}: transcript ${path} was truncated or replaced ` +
          `(shorter than cursor ${offset}); re-reading from 0`,
      );
    }
    const readStart = r.reset ? 0 : offset;
    const chunks = buildChunks(normalize(r.lines), readStart, r.newOffset, { maxChunkChars: MAX_CHUNK_CHARS });
    if (chunks.length > 0) {
      await deps.client.pushChunks({
        machine: t.cfg.machine,
        chunks: chunks.map((c) => ({
          session_key: s.key,
          kind: 'transcript',
          ...c,
          backfill: Date.parse(c.ts_end) < startedAt,
        })),
      });
      pushed += chunks.length;
    }
    offset = r.newOffset;
    store.set(s.key, { path, offset, fidelity: 'full' });
    await store.save();
    await t.heartbeat();
  }
  return pushed;
}

/** The last `max` UTF-16 units of `s`, never starting with half a surrogate pair. */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  let start = s.length - max;
  const first = s.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return s.slice(start);
}

/** Pushes the pane's screen as one `screen` chunk when the agent is not working and the screen changed. */
async function pushScreen(s: SnapshotSession, t: Tick): Promise<number> {
  if (s.live_status === 'working') return 0;
  let text: string;
  try {
    text = tail(await t.deps.readScreen(s.pane_id), MAX_CHUNK_CHARS);
  } catch {
    return 0; // the pane closed after the snapshot; it will be gone from the next one
  }
  if (text.trim() === '') return 0;
  const hash = createHash('sha256').update(text).digest('hex');
  const cur = t.store.get(s.key);
  if (cur?.screenHash === hash) return 0;

  const ms = t.now.getTime();
  const iso = t.now.toISOString();
  await t.deps.client.pushChunks({
    machine: t.cfg.machine,
    chunks: [
      { session_key: s.key, kind: 'screen', offset_start: ms, offset_end: ms, ts_start: iso, ts_end: iso, text, backfill: false },
    ],
  });
  t.store.set(s.key, { ...(cur ?? { path: null, offset: 0 }), fidelity: 'screen', screenHash: hash });
  await t.store.save();
  return 1;
}

/**
 * One collection tick: reads the herdr snapshot, resolves every agent's transcript, pushes the
 * snapshot (with purged sessions, checked hourly), then pushes new transcript chunks and changed
 * screens. While that takes long (initial import), the same snapshot is re-pushed whenever
 * HEARTBEAT_MS passed since the last push (checked between sessions and read windows), so the
 * machine does not look offline mid-tick.
 * Throws on any failure that should make the caller back off (herdr, snapshot push, server
 * unavailable). Any other failure in one session's push is logged, counted in `errors` and skipped,
 * so one bad transcript cannot stop the machine's heartbeat or the other sessions.
 */
export async function collectOnce(
  cfg: CollectorConfig,
  store: CursorStore,
  deps: Deps,
): Promise<{ sessions: number; chunksPushed: number; errors: number }> {
  const now = deps.now();
  const parsed = parseHerdrSnapshot(await deps.readSnapshot(), cfg.machine);
  const log = deps.log ?? ((line: string) => console.error(line));
  let snapshot: SnapshotPush | undefined;
  let snapshotPushedAt = 0;
  const pushSnapshot = async (p: SnapshotPush) => {
    await deps.client.pushSnapshot(p);
    snapshotPushedAt = deps.now().getTime();
  };
  const t: Tick = {
    cfg,
    store,
    deps,
    now,
    rollouts: once(() => listRecentRollouts(cfg.codexDir, now)),
    dirty: false,
    log,
    heartbeat: async () => {
      if (snapshot !== undefined && deps.now().getTime() - snapshotPushedAt >= HEARTBEAT_MS) await pushSnapshot(snapshot);
    },
  };

  store.retainResolutions(new Set(parsed.filter((s) => s.native_id === null).map((s) => s.key)));
  const resolved: SnapshotSession[] = [];
  for (const s of parsed) resolved.push(await resolveSession(s, t));
  // One session resumed in two panes is reported twice; the last occurrence wins.
  const sessions = [...new Map(resolved.map((s) => [s.key, s])).values()];

  const last = store.lastPurgeCheck;
  const purgeDue = last === undefined || now.getTime() - last.getTime() >= PURGE_CHECK_INTERVAL_MS;
  const { purged, dropped } = purgeDue ? await purgeCheck(sessions, store) : { purged: [], dropped: [] };

  snapshot = { machine: cfg.machine, collector_version: COLLECTOR_VERSION, sessions, purged };
  await pushSnapshot(snapshot);
  if (purgeDue) {
    for (const key of [...purged, ...dropped]) store.delete(key);
    store.lastPurgeCheck = now;
    t.dirty = true;
  }
  if (t.dirty) await store.save();

  let chunksPushed = 0;
  let errors = 0;
  for (const s of sessions) {
    await t.heartbeat();
    try {
      chunksPushed += s.fidelity === 'full' ? await pushTranscript(s, t) : await pushScreen(s, t);
    } catch (err) {
      if (err instanceof RetryableError) throw err;
      errors += 1;
      log(`${now.toISOString()} herdr-pm collector: session ${s.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { sessions: sessions.length, chunksPushed, errors };
}

/** Wait before the next tick after `failures` consecutive failed ticks: pollMs doubling per failure, capped. */
export function backoffDelay(pollMs: number, failures: number): number {
  return failures === 0 ? pollMs : Math.min(pollMs * 2 ** failures, Math.max(pollMs, MAX_BACKOFF_MS));
}

/** Runs `collectOnce` every `pollMs` forever, logging failures to stderr and backing off exponentially. */
export async function runCollector(cfg: CollectorConfig): Promise<never> {
  const store = await CursorStore.load(cfg.stateFile);
  const deps: Deps = {
    readSnapshot: () => readHerdrSnapshot(cfg.herdrBin),
    readScreen: (paneId) => readHerdrScreen(cfg.herdrBin, paneId),
    paneProcess: (paneId) => readPaneProcess(cfg.herdrBin, paneId),
    processStartTime,
    client: createPmClient(cfg),
    now: () => new Date(),
    startedAt: new Date(),
  };
  let failures = 0;
  for (;;) {
    let error: unknown = null;
    try {
      const { errors } = await collectOnce(cfg, store, deps);
      if (errors > 0) console.error(`${new Date().toISOString()} herdr-pm collector: tick finished with ${errors} failed session(s)`);
      failures = 0;
    } catch (err) {
      failures += 1;
      error = err;
    }
    const delay = backoffDelay(cfg.pollMs, failures);
    if (failures > 0) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${new Date().toISOString()} herdr-pm collector: ${message} (retrying in ${Math.round(delay / 1000)}s)`);
    }
    await sleep(delay);
  }
}
