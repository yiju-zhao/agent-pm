import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

/** A decimal legacy PID on Linux can now name a thread instead of a process. */
export function linuxCollectorProcess(pid: number, procDir = '/proc'): boolean {
  try {
    const status = readFileSync(join(procDir, String(pid), 'status'), 'utf8');
    const tgid = /^Tgid:\s*(\d+)$/m.exec(status);
    if (!tgid) throw new Error(`cannot identify legacy collector pid ${pid}`);
    if (Number(tgid[1]) !== pid) return false;
    const args = readFileSync(join(procDir, String(pid), 'cmdline'), 'utf8').split('\0');
    return args.includes('collect-paseo');
  } catch (err) {
    if (['ENOENT', 'ESRCH'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}

// Versions before the kernel lock wrote a decimal PID and closed the file. Inspect those locks once on upgrade.
function legacyCollectorAlive(pid: number, writtenAt: number): boolean {
  if (pid === process.pid) return false; // this process has just acquired the exclusive lock
  if (process.platform === 'linux' && !linuxCollectorProcess(pid)) return false;
  const ps = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  if (ps.error) throw ps.error;
  if (ps.status === 1 && !ps.stdout.trim() && !ps.stderr.trim()) return false; // exited
  const info = /^(\w{3} \w{3} +\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/.exec(ps.stdout.trim());
  const startedAt = info ? Date.parse(info[1] + ' UTC') : NaN;
  if (ps.status !== 0 || !info || !Number.isFinite(startedAt)) {
    throw new Error(`cannot verify the owner of legacy collector lock (pid ${pid})`);
  }
  return startedAt <= writtenAt && /(?:^|\s)collect-paseo(?:\s|$)/.test(info[2]);
}

/** Keep a PID readable by old collectors. Hex identifies a marker whose owner also holds the SQLite lock. */
function publishMarker(lock: string): void {
  const pending = lock + '.pending';
  writeFileAtomic(pending, '0x' + process.pid.toString(16));
  try {
    // Publish the complete PID with exclusive creation so an older binary never sees an empty marker from us.
    try {
      linkSync(pending, lock);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const existing = statSync(lock);
    const marker = readFileSync(lock, 'utf8').trim();
    if (/^\d+$/.test(marker) && legacyCollectorAlive(Number(marker), existing.mtimeMs)) {
      throw new Error(`state directory is in use by another Paseo collector (pid ${marker}, lock ${lock})`);
    }
    // A legacy writer may still be publishing its PID. Leave a fresh incomplete marker alone for this attempt.
    if (!/^0x[0-9a-f]+$/i.test(marker) && !/^\d+$/.test(marker) && Date.now() - existing.mtimeMs < 5000) {
      throw new Error(`state directory is in use or its collector lock is incomplete: ${lock}`);
    }
    const current = statSync(lock);
    if (existing.ino !== current.ino || existing.mtimeMs !== current.mtimeMs) throw new Error(`collector lock changed: ${lock}`);
    renameSync(pending, lock);
  } finally {
    rmSync(pending, { force: true });
  }
}

export class StateDir {
  readonly dir: string;
  readonly identity: StateIdentity;
  private guard: DatabaseSync | null;

  private constructor(dir: string, identity: StateIdentity, guard: DatabaseSync) {
    this.dir = dir;
    this.guard = guard;
    this.identity = identity;
  }

  /**
   * Opens (creating) the directory for one source, takes its lock, and returns it. Refuses a directory another live
   * process holds, and a directory that belongs to another source or daemon (its outbox would be sent under the wrong
   * identity). The instance id is kept across restarts, so a restarted collector keeps its center lease.
   */
  static open(dir: string, want: Omit<StateIdentity, 'instanceId'>): StateDir {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // This file stays in place. SQLite serializes local owners on macOS and Linux, including stale-marker takeover.
    // An exclusive transaction writes no data. Closing the handle, process death, or reboot releases the OS lock.
    const guard = new DatabaseSync(join(dir, 'collector-lock.sqlite'));
    const lock = join(dir, 'collector.lock');
    let published = false;
    try {
      try {
        guard.exec('BEGIN EXCLUSIVE');
      } catch (err) {
        if ((err as { errcode?: number }).errcode === 5) throw new Error(`state directory ${dir} is in use by another Paseo collector`, { cause: err });
        throw err;
      }
      publishMarker(lock);
      published = true;
      const idPath = join(dir, 'identity.json');
      let identity: StateIdentity;
      try {
        const stored = JSON.parse(readFileSync(idPath, 'utf8')) as StateIdentity;
        if (stored.sourceId !== want.sourceId || stored.serverId !== want.serverId) {
          throw new Error(`state directory ${dir} belongs to source ${stored.sourceId} / daemon ${stored.serverId}, not ${want.sourceId} / ${want.serverId}; use a separate stateDir per source`);
        }
        identity = { ...stored, server: want.server };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
        identity = { ...want, instanceId: `paseo-${randomUUID()}` };
      }
      writeFileAtomic(idPath, `${JSON.stringify(identity, null, 2)}\n`);
      return new StateDir(dir, identity, guard);
    } catch (err) {
      try {
        if (published) rmSync(lock, { force: true });
      } finally {
        guard.close();
      }
      throw err;
    }
  }

  release(): void {
    if (!this.guard) return;
    try {
      rmSync(join(this.dir, 'collector.lock'), { force: true });
    } finally {
      this.guard.close();
      this.guard = null;
    }
  }
}
