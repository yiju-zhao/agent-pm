import { open } from 'node:fs/promises';

export type ReadDeltaResult = {
  lines: string[];
  newOffset: number;
  reset: boolean;
  missing: boolean;
};

const NEWLINE = 0x0a;
// Once a single line outgrows maxBytes we keep reading in chunks of at least this size.
const MIN_CONTINUE_CHUNK = 64 * 1024;

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * Reads the complete lines that were appended after byte `offset`.
 *
 * - Reads at most `maxBytes` and cuts at the last newline in that window, so a line is never split.
 * - If the window holds no newline at all, keeps reading until the first newline (a single line
 *   longer than `maxBytes` is returned whole); with no newline before EOF nothing is returned.
 * - `newOffset` is the byte position just past the last returned newline (blank lines included).
 * - A file shorter than `offset` was truncated/replaced: read from 0 and report `reset`.
 */
export async function readDelta(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<ReadDeltaResult> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    if (isNotFound(err)) return { lines: [], newOffset: offset, reset: false, missing: true };
    throw err;
  }

  try {
    const { size } = await fh.stat();
    const reset = size < offset;
    const start = reset ? 0 : offset;

    const parts: Buffer[] = [];
    let consumed = 0;
    let chunkSize = Math.max(1, maxBytes);
    let complete = false;

    while (!complete && start + consumed < size) {
      const buf = Buffer.allocUnsafe(Math.min(chunkSize, size - start - consumed));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start + consumed);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      // First window: take as many whole lines as fit. After that we are finishing one
      // oversized line, so stop at its first newline.
      const nl = consumed === 0 ? chunk.lastIndexOf(NEWLINE) : chunk.indexOf(NEWLINE);
      if (nl >= 0) {
        parts.push(chunk.subarray(0, nl + 1));
        consumed += nl + 1;
        complete = true;
      } else {
        parts.push(chunk);
        consumed += bytesRead;
        chunkSize = Math.max(chunkSize, MIN_CONTINUE_CHUNK);
      }
    }

    if (!complete) return { lines: [], newOffset: start, reset, missing: false };

    const lines: string[] = [];
    for (const raw of Buffer.concat(parts).toString('utf8').split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line !== '') lines.push(line);
    }
    return { lines, newOffset: start + consumed, reset, missing: false };
  } finally {
    await fh.close();
  }
}
