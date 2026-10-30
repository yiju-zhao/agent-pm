import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { CursorStore } from '../../src/collector/cursor-store.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herdr-pm-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a missing state file loads empty', async () => {
  const store = await CursorStore.load(join(dir, 'nope.json'));
  expect(store.keys()).toEqual([]);
  expect(store.lastPurgeCheck).toBeUndefined();
});

test('save creates the parent directory and round-trips cursors, lastPurgeCheck and resolutions', async () => {
  const path = join(dir, 'a', 'b', 'collector.json');
  const store = await CursorStore.load(path);
  store.set('claude:x', { path: '/t/x.jsonl', offset: 42, fidelity: 'full' });
  store.set('pending:laptop:t1', { path: null, offset: 0, fidelity: 'screen', screenHash: 'abc' });
  store.lastPurgeCheck = new Date('2026-10-29T10:00:00.000Z');
  store.setResolution('pending:laptop:t2', { pid: 7, match: { id: 'c1', path: '/r.jsonl' }, checkedAt: '2026-10-29T10:00:00.000Z' });
  await store.save();

  expect(await readdir(join(dir, 'a', 'b'))).toEqual(['collector.json']); // no temp file left behind
  const loaded = await CursorStore.load(path);
  expect(loaded.get('claude:x')).toEqual({ path: '/t/x.jsonl', offset: 42, fidelity: 'full' });
  expect(loaded.get('pending:laptop:t1')).toEqual({ path: null, offset: 0, fidelity: 'screen', screenHash: 'abc' });
  expect(loaded.lastPurgeCheck).toEqual(new Date('2026-10-29T10:00:00.000Z'));
  expect(loaded.getResolution('pending:laptop:t2')).toEqual({ pid: 7, match: { id: 'c1', path: '/r.jsonl' }, checkedAt: '2026-10-29T10:00:00.000Z' });
  expect(JSON.parse(await readFile(path, 'utf8')).lastPurgeCheck).toBe('2026-10-29T10:00:00.000Z');
});

test('a corrupt state file loads empty (the server knows where to resume)', async () => {
  const path = join(dir, 'collector.json');
  await writeFile(path, '{"cursors": {"claude:x": {"offset": "oops"');
  expect((await CursorStore.load(path)).keys()).toEqual([]);
  await writeFile(path, JSON.stringify({ cursors: { 'claude:x': { offset: -1 } } }));
  expect((await CursorStore.load(path)).keys()).toEqual([]);
});

test('retainResolutions forgets pending sessions that are gone', async () => {
  const store = await CursorStore.load(join(dir, 's.json'));
  const r = { pid: 1, match: null, checkedAt: '2026-10-29T10:00:00.000Z' };
  store.setResolution('pending:m:a', r);
  store.setResolution('pending:m:b', r);
  store.retainResolutions(new Set(['pending:m:b']));
  expect(store.getResolution('pending:m:a')).toBeUndefined();
  expect(store.getResolution('pending:m:b')).toEqual(r);
});
