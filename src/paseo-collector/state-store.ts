import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';

// The collector's state directory: who it belongs to, a lock so only one process uses it, and (in ./outbox.ts) the
// batches not yet acknowledged. Positions are not kept here: the center's committed checkpoint is the only one a
// collector resumes from, so a lost or stale directory can delay but never skip content.

export type StateIdentity = { sourceId: string; serverId: string; server: string; instanceId: string };

/** Writes `data` to `path` atomically and durably: a temporary file, fsync, rename. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Directories this process holds: a second open in the same process is refused even though the pid matches. */
const heldHere = new Set<string>();

export class StateDir {
  readonly dir: string;
  readonly identity: StateIdentity;
  private locked = false;

  private constructor(dir: string, identity: StateIdentity) {
    this.dir = dir;
    this.identity = identity;
  }

  /**
   * Opens (creating) the directory for one source, takes its lock, and returns it. Refuses a directory another live
   * process holds, and a directory that belongs to another source or daemon (its outbox would be sent under the wrong
   * identity). The instance id is kept across restarts, so a restarted collector keeps its center lease.
   */
  static open(dir: string, want: Omit<StateIdentity, 'instanceId'>, pid = process.pid): StateDir {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (heldHere.has(dir)) throw new Error(`state directory ${dir} is in use by another Paseo collector in this process`);
    const lock = join(dir, 'collector.lock');
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(lock, 'wx', 0o600);
        writeFileSync(fd, String(pid));
        closeSync(fd);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) {
          throw new Error(`state directory ${dir} is in use by another Paseo collector (lock ${lock})`, { cause: err });
        }
        // A lock with our own pid is a leftover of an earlier process that had the same pid (pid 1 in a container).
        const holder = Number(readFileSync(lock, 'utf8').trim());
        if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
          throw new Error(`state directory ${dir} is in use by another Paseo collector (pid ${holder})`);
        }
        rmSync(lock, { force: true }); // stale: its process is gone
      }
    }
    const idPath = join(dir, 'identity.json');
    let identity: StateIdentity;
    try {
      const stored = JSON.parse(readFileSync(idPath, 'utf8')) as StateIdentity;
      if (stored.sourceId !== want.sourceId || stored.serverId !== want.serverId) {
        rmSync(lock, { force: true });
        throw new Error(
          `state directory ${dir} belongs to source ${stored.sourceId} / daemon ${stored.serverId}, not ${want.sourceId} / ${want.serverId}; use a separate stateDir per source`,
        );
      }
      identity = { ...stored, server: want.server };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (err instanceof SyntaxError) identity = { ...want, instanceId: `paseo-${randomUUID()}` };
        else throw err;
      } else identity = { ...want, instanceId: `paseo-${randomUUID()}` };
    }
    writeFileAtomic(idPath, `${JSON.stringify(identity, null, 2)}\n`);
    const state = new StateDir(dir, identity);
    state.locked = true;
    heldHere.add(dir);
    return state;
  }

  /** Releases the lock (on shutdown). */
  release(): void {
    if (!this.locked) return;
    rmSync(join(this.dir, 'collector.lock'), { force: true });
    heldHere.delete(this.dir);
    this.locked = false;
  }
}
