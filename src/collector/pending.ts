import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RolloutMeta = { id: string; cwd: string; timestamp: string };
export type RolloutCandidate = RolloutMeta & { path: string };

// The session_meta line of a real codex rollout is ~25 KB; never read more than this to find it.
const META_PREFIX_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads the `session_meta` payload from the first line of a codex rollout file.
 * Returns null when the file is missing/unreadable, the first line is not valid JSON, is not a
 * `session_meta` record, lacks string id/cwd/timestamp, or does not fit in the first 64 KiB.
 */
export async function readRolloutMeta(path: string): Promise<RolloutMeta | null> {
  let line: string;
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(META_PREFIX_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const nl = buf.subarray(0, bytesRead).indexOf(NEWLINE);
      // No newline in a full prefix: the first line is too long to be a session_meta we can use.
      if (nl < 0 && bytesRead === buf.length) return null;
      line = buf.subarray(0, nl < 0 ? bytesRead : nl).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== 'session_meta' || !isRecord(parsed.payload)) return null;
  const { id, cwd, timestamp } = parsed.payload;
  if (typeof id !== 'string' || typeof cwd !== 'string' || typeof timestamp !== 'string') return null;
  return { id, cwd, timestamp };
}

/**
 * Recovers the rollout of a codex pane that herdr reported without a session id: among candidates
 * with exactly the same cwd and a start within `toleranceMs` of `target.startedAt`, returns the
 * closest one. Two or more equally close candidates are ambiguous -> null.
 */
export function matchRollout(
  candidates: RolloutCandidate[],
  target: { cwd: string; startedAt: Date },
  toleranceMs = 120_000,
): { id: string; path: string } | null {
  const startedMs = target.startedAt.getTime();
  if (Number.isNaN(startedMs)) return null;

  let best: RolloutCandidate | null = null;
  let bestDelta = Infinity;
  let tied = false;
  for (const c of candidates) {
    if (c.cwd !== target.cwd) continue;
    const ts = Date.parse(c.timestamp);
    if (Number.isNaN(ts)) continue;
    const delta = Math.abs(ts - startedMs);
    if (delta > toleranceMs) continue;
    if (delta < bestDelta) {
      best = c;
      bestDelta = delta;
      tied = false;
    } else if (delta === bestDelta) {
      tied = true;
    }
  }
  return best === null || tied ? null : { id: best.id, path: best.path };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

/** Parses `ps -o lstart=` output under LC_ALL=C (`Wed Oct 29 11:19:00 2026`, local time). */
export function parseLstart(s: string): Date | null {
  const m = LSTART.exec(s.trim());
  if (m === null) return null;
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) return null;
  const [day, hour, minute, second, year] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const d = new Date(year, month, day, hour, minute, second);
  // Date rolls out-of-range fields over (Feb 30 -> Mar 2, hour 25 -> next day); reject those.
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month ||
    d.getDate() !== day ||
    d.getHours() !== hour ||
    d.getMinutes() !== minute ||
    d.getSeconds() !== second
  ) {
    return null;
  }
  return d;
}

/** Start time of a local process (macOS and Linux); null if it is gone or `ps` output is unusable. */
export async function processStartTime(pid: number): Promise<Date | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 5_000,
    });
    return parseLstart(stdout);
  } catch {
    return null;
  }
}

/**
 * Metadata of the codex rollouts started on the last `days` local calendar dates up to and
 * including `now` (codex files them under sessions/YYYY/MM/DD by local date). Missing date
 * directories and rollouts without a readable session_meta are skipped.
 */
export async function listRecentRollouts(
  codexDir: string,
  now: Date,
  days = 7,
): Promise<RolloutCandidate[]> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const perDay = await Promise.all(
    Array.from({ length: Math.max(0, days) }, async (_, i) => {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dir = join(codexDir, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const metas = await Promise.all(
        names
          .filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
          .sort()
          .map(async (n) => {
            const path = join(dir, n);
            const meta = await readRolloutMeta(path);
            return meta === null ? null : { ...meta, path };
          }),
      );
      return metas.filter((m) => m !== null);
    }),
  );
  return perDay.flat();
}
