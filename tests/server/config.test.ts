import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadServerConfig } from '../../src/server/config.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herdr-pm-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function configFile(content: unknown): Promise<string> {
  const path = join(dir, 'server.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

test('loads a valid config', async () => {
  const path = await configFile({ port: 8787, dbPath: '/var/lib/herdr-pm/pm.db', collectors: { 'gx10-090e': 'tok-1', laptop: 'tok-2' } });
  expect(loadServerConfig(path)).toEqual({
    port: 8787,
    dbPath: '/var/lib/herdr-pm/pm.db',
    collectors: { 'gx10-090e': 'tok-1', laptop: 'tok-2' },
  });
});

test('resolves a relative dbPath against the config file directory, not the cwd', async () => {
  const path = await configFile({ port: 8787, dbPath: 'data/pm.db', collectors: {} });
  expect(loadServerConfig(path).dbPath).toBe(join(dir, 'data', 'pm.db'));
});

test('keeps the in-memory database name as is', async () => {
  const path = await configFile({ port: 8787, dbPath: ':memory:', collectors: {} });
  expect(loadServerConfig(path).dbPath).toBe(':memory:');
});

test('throws a clear error naming the file and the invalid fields', async () => {
  const path = await configFile({ port: 'http', dbPath: 5, collectors: { laptop: '' } });
  expect(() => loadServerConfig(path)).toThrow(path);
  expect(() => loadServerConfig(path)).toThrow(/port/);
  expect(() => loadServerConfig(path)).toThrow(/dbPath/);
  expect(() => loadServerConfig(path)).toThrow(/collectors\.laptop/);
});

test('rejects collector machine labels that cannot be part of a session key', async () => {
  for (const label of ['mac mini', 'gx10:090e', ' laptop', 'a/b', '']) {
    const path = await configFile({ port: 8787, dbPath: 'x', collectors: { laptop: 't', [label]: 't2' } });
    expect(() => loadServerConfig(path), JSON.stringify(label)).toThrow(/collectors/);
    expect(() => loadServerConfig(path), JSON.stringify(label)).toThrow(/letters, digits/);
  }
});

test('rejects a missing file', () => {
  expect(() => loadServerConfig(join(dir, 'missing.json'))).toThrow(/missing\.json/);
});

test('rejects missing fields, out-of-range ports and non-object configs', async () => {
  const bad: unknown[] = [
    {},
    { port: 8787, dbPath: 'x' },
    { port: 8787, collectors: {} },
    { dbPath: 'x', collectors: {} },
    { port: 0, dbPath: 'x', collectors: {} },
    { port: 70000, dbPath: 'x', collectors: {} },
    { port: 80.5, dbPath: 'x', collectors: {} },
    { port: 80, dbPath: '', collectors: {} },
    { port: 80, dbPath: 'x', collectors: [] },
    [],
    null,
  ];
  for (const config of bad) {
    const path = await configFile(config);
    expect(() => loadServerConfig(path), JSON.stringify(config)).toThrow(path);
  }
});

test('rejects a file that is not JSON', async () => {
  const path = await configFile('{not json');
  expect(() => loadServerConfig(path)).toThrow(/not valid JSON/);
});
