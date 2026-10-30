import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * Where the collector is in one session: `offset` is the byte position in the transcript at `path`
 * up to which the server has confirmed every chunk; `screenHash` is the hash of the last screen pushed.
 */
export const Cursor = z.object({
  path: z.string().nullable(),
  offset: z.number().int().nonnegative(),
  screenHash: z.string().optional(),
  fidelity: z.enum(['full', 'screen']),
});
export type Cursor = z.infer<typeof Cursor>;

/**
 * Outcome of looking up the rollout of an id-less codex pane whose process is `pid`; `match` is
 * null when nothing matched at `checkedAt`.
 */
export const Resolution = z.object({
  pid: z.number().int(),
  match: z.object({ id: z.string(), path: z.string() }).nullable(),
  checkedAt: z.iso.datetime(),
});
export type Resolution = z.infer<typeof Resolution>;

const StateFile = z.object({
  cursors: z.record(z.string(), Cursor),
  lastPurgeCheck: z.iso.datetime().optional(),
  resolutions: z.record(z.string(), Resolution).optional(),
});
type StateFile = z.infer<typeof StateFile>;

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * The collector's local state, persisted as JSON. Losing it is safe (the collector asks the server
 * where to resume), so a missing or unreadable-as-state file loads as empty.
 */
export class CursorStore {
  readonly path: string;
  lastPurgeCheck: Date | undefined;
  /**
   * Sessions whose transcript cursor was checked against the server's resume position since this
   * store was loaded. Kept in memory only, so every collector process checks each session once
   * (the server database may have been restored from an older backup while it was down).
   */
  readonly serverChecked = new Set<string>();
  private readonly cursors: Map<string, Cursor>;
  private readonly resolutions: Map<string, Resolution>;

  private constructor(path: string, state: StateFile) {
    this.path = path;
    this.cursors = new Map(Object.entries(state.cursors));
    this.resolutions = new Map(Object.entries(state.resolutions ?? {}));
    this.lastPurgeCheck = state.lastPurgeCheck === undefined ? undefined : new Date(state.lastPurgeCheck);
  }

  static async load(path: string): Promise<CursorStore> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return new CursorStore(path, { cursors: {} });
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = StateFile.safeParse(json);
    return new CursorStore(path, parsed.success ? parsed.data : { cursors: {} });
  }

  get(key: string): Cursor | undefined {
    return this.cursors.get(key);
  }

  set(key: string, c: Cursor): void {
    this.cursors.set(key, c);
  }

  delete(key: string): void {
    this.cursors.delete(key);
  }

  keys(): string[] {
    return [...this.cursors.keys()];
  }

  /** Cached rollout lookup for an id-less codex session, keyed by its pending session key. */
  getResolution(pendingKey: string): Resolution | undefined {
    return this.resolutions.get(pendingKey);
  }

  setResolution(pendingKey: string, r: Resolution): void {
    this.resolutions.set(pendingKey, r);
  }

  /** Drops cached resolutions for pending sessions not in `live`. */
  retainResolutions(live: Set<string>): void {
    for (const key of this.resolutions.keys()) if (!live.has(key)) this.resolutions.delete(key);
  }

  /** Writes the state atomically (temp file + rename), creating the parent directory if needed. */
  async save(): Promise<void> {
    const state: StateFile = { cursors: Object.fromEntries(this.cursors) };
    if (this.lastPurgeCheck !== undefined) state.lastPurgeCheck = this.lastPurgeCheck.toISOString();
    if (this.resolutions.size > 0) state.resolutions = Object.fromEntries(this.resolutions);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, this.path);
  }
}
