import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  listRecentRollouts,
  matchRollout,
  parseLstart,
  processStartTime,
  readRolloutMeta,
} from '../../src/collector/pending.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herdr-pm-pending-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function meta(id: string, cwd: string, timestamp: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp, type: 'session_meta', payload: { id, cwd, timestamp, ...extra } });
}

test('readRolloutMeta reads session_meta from the first line only', async () => {
  const p = join(dir, 'r.jsonl');
  await writeFile(p, `${meta('abc', '/w', '2026-10-29T11:19:19.000Z', { originator: 'codex-tui' })}\n{"type":"event_msg"}\n`);
  expect(await readRolloutMeta(p)).toEqual({ id: 'abc', cwd: '/w', timestamp: '2026-10-29T11:19:19.000Z' });
});

test('readRolloutMeta works when the first line has no trailing newline', async () => {
  const p = join(dir, 'r.jsonl');
  await writeFile(p, meta('abc', '/w', '2026-10-29T11:19:19Z'));
  expect(await readRolloutMeta(p)).toEqual({ id: 'abc', cwd: '/w', timestamp: '2026-10-29T11:19:19Z' });
});

test('readRolloutMeta handles a large first line without loading the whole file', async () => {
  const p = join(dir, 'r.jsonl');
  const big = 'x'.repeat(30_000);
  const rest = `${'{"type":"event_msg"}\n'.repeat(1000)}`;
  await writeFile(p, `${meta('abc', '/w', '2026-10-29T11:19:19Z', { instructions: big })}\n${rest}`);
  expect(await readRolloutMeta(p)).toEqual({ id: 'abc', cwd: '/w', timestamp: '2026-10-29T11:19:19Z' });
});

test('readRolloutMeta returns null for missing file, bad json, wrong type, missing fields', async () => {
  expect(await readRolloutMeta(join(dir, 'nope.jsonl'))).toBeNull();

  const bad = join(dir, 'bad.jsonl');
  await writeFile(bad, '{not json\n');
  expect(await readRolloutMeta(bad)).toBeNull();

  const empty = join(dir, 'empty.jsonl');
  await writeFile(empty, '');
  expect(await readRolloutMeta(empty)).toBeNull();

  const wrongType = join(dir, 'type.jsonl');
  await writeFile(wrongType, `${JSON.stringify({ type: 'event_msg', payload: { id: 'a', cwd: '/w', timestamp: 't' } })}\n`);
  expect(await readRolloutMeta(wrongType)).toBeNull();

  for (const [name, payload] of [
    ['noid', { cwd: '/w', timestamp: 't' }],
    ['nocwd', { id: 'a', timestamp: 't' }],
    ['nots', { id: 'a', cwd: '/w' }],
    ['numid', { id: 1, cwd: '/w', timestamp: 't' }],
    ['nopayload', undefined],
  ] as const) {
    const p = join(dir, `${name}.jsonl`);
    await writeFile(p, `${JSON.stringify({ type: 'session_meta', payload })}\n`);
    expect(await readRolloutMeta(p), name).toBeNull();
  }
});

test('matchRollout picks same cwd closest in time within tolerance', () => {
  const c = [
    { id: 'a', cwd: '/w', timestamp: '2026-10-29T11:00:00Z', path: 'pa' },
    { id: 'b', cwd: '/w', timestamp: '2026-10-29T11:19:19Z', path: 'pb' },
    { id: 'c', cwd: '/other', timestamp: '2026-10-29T11:19:20Z', path: 'pc' },
  ];
  expect(matchRollout(c, { cwd: '/w', startedAt: new Date('2026-10-29T11:19:00Z') })).toEqual({ id: 'b', path: 'pb' });
});

test('matchRollout returns null when nothing within tolerance', () => {
  const c = [{ id: 'a', cwd: '/w', timestamp: '2026-10-29T11:00:00Z', path: 'pa' }];
  expect(matchRollout(c, { cwd: '/w', startedAt: new Date('2026-10-29T11:19:00Z') })).toBeNull();
  expect(matchRollout([], { cwd: '/w', startedAt: new Date('2026-10-29T11:19:00Z') })).toBeNull();
});

test('matchRollout tolerance is inclusive and configurable', () => {
  const c = [{ id: 'a', cwd: '/w', timestamp: '2026-10-29T11:20:00Z', path: 'pa' }];
  const target = { cwd: '/w', startedAt: new Date('2026-10-29T11:19:00Z') };
  expect(matchRollout(c, target, 60_000)).toEqual({ id: 'a', path: 'pa' });
  expect(matchRollout(c, target, 59_999)).toBeNull();
  // default tolerance is 120000 ms
  expect(matchRollout([{ ...c[0]!, timestamp: '2026-10-29T11:21:00Z' }], target)).toEqual({ id: 'a', path: 'pa' });
  expect(matchRollout([{ ...c[0]!, timestamp: '2026-10-29T11:21:01Z' }], target)).toBeNull();
});

test('matchRollout considers rollouts created before the process start too', () => {
  const c = [{ id: 'a', cwd: '/w', timestamp: '2026-10-29T11:18:30Z', path: 'pa' }];
  expect(matchRollout(c, { cwd: '/w', startedAt: new Date('2026-10-29T11:19:00Z') })).toEqual({ id: 'a', path: 'pa' });
});

test('matchRollout returns null when two candidates tie (ambiguous)', () => {
  const c = [
    { id: 'a', cwd: '/w', timestamp: '2026-10-29T11:19:10Z', path: 'pa' },
    { id: 'b', cwd: '/w', timestamp: '2026-10-29T11:18:50Z', path: 'pb' },
  ];
  expect(matchRollout(c, { cwd: '/w', startedAt: new Date('2026-10-29T11:19:00Z') })).toBeNull();
});

test('matchRollout: a tie among farther candidates does not make a closer one ambiguous', () => {
  const c = [
    { id: 'near', cwd: '/w', timestamp: '2026-10-29T11:19:01Z', path: 'pn' },
    { id: 'f1', cwd: '/w', timestamp: '2026-10-29T11:19:30Z', path: 'p1' },
    { id: 'f2', cwd: '/w', timestamp: '2026-10-29T11:18:30Z', path: 'p2' },
  ];
  expect(matchRollout(c, { cwd: '/w', startedAt: new Date('2026-10-29T11:19:00Z') })).toEqual({ id: 'near', path: 'pn' });
});

test('matchRollout ignores unparsable candidate timestamps and requires exact cwd', () => {
  const c = [
    { id: 'bad', cwd: '/w', timestamp: 'not a date', path: 'pbad' },
    { id: 'sub', cwd: '/w/sub', timestamp: '2026-10-29T11:19:00Z', path: 'psub' },
    { id: 'ok', cwd: '/w', timestamp: '2026-10-29T11:19:30Z', path: 'pok' },
  ];
  expect(matchRollout(c, { cwd: '/w', startedAt: new Date('2026-10-29T11:19:00Z') })).toEqual({ id: 'ok', path: 'pok' });
});

test('listRecentRollouts scans the last N calendar dates, tolerating missing dirs', async () => {
  const codexDir = join(dir, 'codex');
  const put = async (y: string, m: string, d: string, name: string, content: string) => {
    const dd = join(codexDir, 'sessions', y, m, d);
    await mkdir(dd, { recursive: true });
    const p = join(dd, name);
    await writeFile(p, content);
    return p;
  };
  // now = 2026-10-29 (local); days=7 -> 10-23 .. 10-29 inclusive; crosses no month boundary
  const today = await put('2026', '10', '29', 'rollout-2026-10-29T11-19-19-id-today.jsonl', `${meta('id-today', '/w', '2026-10-29T11:19:19Z')}\n`);
  const edge = await put('2026', '10', '23', 'rollout-2026-10-23T00-00-01-id-edge.jsonl', `${meta('id-edge', '/e', '2026-10-23T00:00:01Z')}\n`);
  await put('2026', '10', '22', 'rollout-2026-10-22T23-59-59-id-old.jsonl', `${meta('id-old', '/o', '2026-10-22T23:59:59Z')}\n`);
  await put('2026', '10', '30', 'rollout-2026-10-30T00-00-00-id-future.jsonl', `${meta('id-future', '/f', '2026-10-30T00:00:00Z')}\n`);
  await put('2026', '10', '28', 'rollout-2026-10-28T10-00-00-id-broken.jsonl', 'not json\n');
  await put('2026', '10', '28', 'notes.txt', 'ignored');

  const now = new Date(2026, 9, 29, 15, 0, 0); // local time, Oct 29 2026
  const got = await listRecentRollouts(codexDir, now);
  expect(got.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: 'id-edge', cwd: '/e', timestamp: '2026-10-23T00:00:01Z', path: edge },
    { id: 'id-today', cwd: '/w', timestamp: '2026-10-29T11:19:19Z', path: today },
  ]);

  expect((await listRecentRollouts(codexDir, now, 1)).map((r) => r.id)).toEqual(['id-today']);
});

test('listRecentRollouts crosses month and year boundaries', async () => {
  const codexDir = join(dir, 'codex');
  const dd = join(codexDir, 'sessions', '2025', '12', '31');
  await mkdir(dd, { recursive: true });
  const p = join(dd, 'rollout-2025-12-31T23-00-00-id-nye.jsonl');
  await writeFile(p, `${meta('id-nye', '/w', '2025-12-31T23:00:00Z')}\n`);
  const got = await listRecentRollouts(codexDir, new Date(2026, 0, 2, 9, 0, 0));
  expect(got).toEqual([{ id: 'id-nye', cwd: '/w', timestamp: '2025-12-31T23:00:00Z', path: p }]);
});

test('listRecentRollouts returns [] when the codex dir does not exist', async () => {
  expect(await listRecentRollouts(join(dir, 'missing'), new Date())).toEqual([]);
});

test('parseLstart parses the LC_ALL=C ps lstart format as local time', () => {
  expect(parseLstart('Wed Oct 29 11:19:00 2026')?.getTime()).toBe(new Date(2026, 9, 29, 11, 19, 0).getTime());
  // single-digit day is space padded by ps
  expect(parseLstart('Fri Oct  9 03:04:05 2026')?.getTime()).toBe(new Date(2026, 9, 9, 3, 4, 5).getTime());
  expect(parseLstart('  Thu Jan  1 00:00:00 2026\n')?.getTime()).toBe(new Date(2026, 0, 1, 0, 0, 0).getTime());
  expect(parseLstart('Mon Dec 31 23:59:59 2029')?.getTime()).toBe(new Date(2029, 11, 31, 23, 59, 59).getTime());
});

test('parseLstart returns null for anything unparsable', () => {
  for (const s of [
    '',
    '   ',
    'garbage',
    'Wed Oct 29 11:19:00',
    'Wed Foo 29 11:19:00 2026',
    'Wed Oct 32 11:19:00 2026',
    'Wed Oct 29 25:19:00 2026',
    'Wed Oct 29 11:61:00 2026',
    'Wed Oct 29 11:19:00 2026 extra',
    'Wed 29 Oct 11:19:00 2026',
    'Feb 30 is invalid: Wed Feb 30 11:19:00 2026',
    'Wed Feb 30 11:19:00 2026',
  ]) {
    expect(parseLstart(s), s).toBeNull();
  }
});

test('processStartTime reads the start time of a live process', async () => {
  const t = await processStartTime(process.pid);
  expect(t).not.toBeNull();
  const ageMs = Date.now() - t!.getTime();
  // lstart has 1s resolution; the test process started within the last few minutes
  expect(ageMs).toBeGreaterThanOrEqual(-2_000);
  expect(ageMs).toBeLessThan(5 * 60_000);
});

test('processStartTime returns null for a pid that does not exist', async () => {
  expect(await processStartTime(2 ** 22 + 12345)).toBeNull();
  expect(await processStartTime(-1)).toBeNull();
  expect(await processStartTime(Number.NaN)).toBeNull();
});
