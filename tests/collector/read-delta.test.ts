import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { readDelta } from '../../src/collector/read-delta.ts';

let dir: string;
let p: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herdr-pm-read-delta-'));
  p = join(dir, 'transcript.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('reads only complete lines; partial tail stays for next read', async () => {
  await writeFile(p, '{"a":1}\n{"b":2}\n{"c":');
  const r = await readDelta(p, 0, 1 << 20);
  expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
  expect(r.newOffset).toBe(16);
  expect(r.reset).toBe(false);
  expect(r.missing).toBe(false);
  await appendFile(p, '3}\n');
  const r2 = await readDelta(p, 16, 1 << 20);
  expect(r2.lines).toEqual(['{"c":3}']);
  expect(r2.newOffset).toBe(16 + '{"c":3}\n'.length);
});

test('no complete new line leaves the offset where it was', async () => {
  await writeFile(p, '{"a":1}\n{"b":');
  const r = await readDelta(p, 8, 1 << 20);
  expect(r.lines).toEqual([]);
  expect(r.newOffset).toBe(8);
  expect(r.reset).toBe(false);

  const atEof = await readDelta(p, 8 + '{"b":'.length, 1 << 20);
  expect(atEof.lines).toEqual([]);
  expect(atEof.newOffset).toBe(8 + '{"b":'.length);
});

test('truncated file resets to 0', async () => {
  await writeFile(p, 'x\ny\n');
  const r = await readDelta(p, 100, 1 << 20);
  expect(r.reset).toBe(true);
  expect(r.missing).toBe(false);
  expect(r.lines).toEqual(['x', 'y']);
  expect(r.newOffset).toBe(4);
});

test('truncated file with no complete line resets to offset 0', async () => {
  await writeFile(p, 'abcde');
  const r = await readDelta(p, 100, 1 << 20);
  expect(r.reset).toBe(true);
  expect(r.lines).toEqual([]);
  expect(r.newOffset).toBe(0);
});

test('missing file', async () => {
  const r = await readDelta(join(dir, 'nope.jsonl'), 42, 1 << 20);
  expect(r).toEqual({ lines: [], newOffset: 42, reset: false, missing: true });
});

test('respects maxBytes but never splits a line', async () => {
  await writeFile(p, '{"a":1}\n{"b":2}\n{"c":3}\n');
  // 8 bytes per line; 12 ends in the middle of the second line
  const r = await readDelta(p, 0, 12);
  expect(r.lines).toEqual(['{"a":1}']);
  expect(r.newOffset).toBe(8);
  const r2 = await readDelta(p, r.newOffset, 12);
  expect(r2.lines).toEqual(['{"b":2}']);
  expect(r2.newOffset).toBe(16);
});

test('single line longer than maxBytes is still returned whole', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  await writeFile(p, `${big}\nnext\n`);
  const r = await readDelta(p, 0, 1 << 20);
  expect(r.lines).toEqual([big]);
  expect(r.newOffset).toBe(big.length + 1);
  const r2 = await readDelta(p, r.newOffset, 1 << 20);
  expect(r2.lines).toEqual(['next']);
});

test('oversized line without a newline yet is not returned', async () => {
  await writeFile(p, 'x'.repeat(200_000));
  const r = await readDelta(p, 0, 1024);
  expect(r.lines).toEqual([]);
  expect(r.newOffset).toBe(0);
});

test('utf-8 multibyte chars are not split', async () => {
  const l1 = '{"t":"你好"}';
  const l2 = '{"t":"世界🙂"}';
  await writeFile(p, `${l1}\n${l2}\n`);
  const l1Bytes = Buffer.byteLength(`${l1}\n`);
  const l2Bytes = Buffer.byteLength(`${l2}\n`);

  // maxBytes cuts through a multibyte character of the second line
  const cut = await readDelta(p, 0, l1Bytes + 8);
  expect(cut.lines).toEqual([l1]);
  expect(cut.newOffset).toBe(l1Bytes);

  // offsets are bytes, not characters
  const rest = await readDelta(p, cut.newOffset, 1 << 20);
  expect(rest.lines).toEqual([l2]);
  expect(rest.newOffset).toBe(l1Bytes + l2Bytes);
});

test('strips CRLF, drops blank lines but still advances past them', async () => {
  const content = 'a\r\n\nb\n\r\n\nc\r\n';
  await writeFile(p, content);
  const r = await readDelta(p, 0, 1 << 20);
  expect(r.lines).toEqual(['a', 'b', 'c']);
  expect(r.newOffset).toBe(Buffer.byteLength(content));
});
