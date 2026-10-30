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

const USER_TOKEN = 'user-token-0123456789';

async function configFile(content: unknown): Promise<string> {
  const path = join(dir, 'server.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

test('loads a valid config', async () => {
  const path = await configFile({
    port: 8787,
    dbPath: '/var/lib/herdr-pm/pm.db',
    userToken: USER_TOKEN,
    collectors: { 'gx10-090e': 'tok-1', laptop: 'tok-2' },
  });
  expect(loadServerConfig(path)).toEqual({
    port: 8787,
    dbPath: '/var/lib/herdr-pm/pm.db',
    userToken: USER_TOKEN,
    collectors: { 'gx10-090e': 'tok-1', laptop: 'tok-2' },
  });
});

test('resolves a relative dbPath against the config file directory, not the cwd', async () => {
  const path = await configFile({ port: 8787, dbPath: 'data/pm.db', userToken: USER_TOKEN, collectors: {} });
  expect(loadServerConfig(path).dbPath).toBe(join(dir, 'data', 'pm.db'));
});

test('keeps the in-memory database name as is', async () => {
  const path = await configFile({ port: 8787, dbPath: ':memory:', userToken: USER_TOKEN, collectors: {} });
  expect(loadServerConfig(path).dbPath).toBe(':memory:');
});

test('throws a clear error naming the file and the invalid fields', async () => {
  const path = await configFile({ port: 'http', dbPath: 5, userToken: USER_TOKEN, collectors: { laptop: '' } });
  expect(() => loadServerConfig(path)).toThrow(path);
  expect(() => loadServerConfig(path)).toThrow(/port/);
  expect(() => loadServerConfig(path)).toThrow(/dbPath/);
  expect(() => loadServerConfig(path)).toThrow(/collectors\.laptop/);
});

test('rejects collector machine labels that cannot be part of a session key', async () => {
  for (const label of ['mac mini', 'gx10:090e', ' laptop', 'a/b', '']) {
    const path = await configFile({ port: 8787, dbPath: 'x', userToken: USER_TOKEN, collectors: { laptop: 't', [label]: 't2' } });
    expect(() => loadServerConfig(path), JSON.stringify(label)).toThrow(/collectors/);
    expect(() => loadServerConfig(path), JSON.stringify(label)).toThrow(/letters, digits/);
  }
});

test('rejects a missing file', () => {
  expect(() => loadServerConfig(join(dir, 'missing.json'))).toThrow(/missing\.json/);
});

test('rejects missing fields, out-of-range ports and non-object configs', async () => {
  const ok = { port: 8787, dbPath: 'x', userToken: USER_TOKEN, collectors: {} };
  const bad: unknown[] = [
    {},
    { ...ok, port: undefined },
    { ...ok, dbPath: undefined },
    { ...ok, collectors: undefined },
    { ...ok, port: 0 },
    { ...ok, port: 70000 },
    { ...ok, port: 80.5 },
    { ...ok, dbPath: '' },
    { ...ok, collectors: [] },
    [],
    null,
  ];
  for (const config of bad) {
    const path = await configFile(config);
    expect(() => loadServerConfig(path), JSON.stringify(config)).toThrow(path);
  }
});

test('userToken must be ≥16 chars, without whitespace, and differ from every collector token', async () => {
  const base = { port: 8787, dbPath: 'x', collectors: { laptop: 'collector-token-laptop', 'mac-mini': 'collector-token-mini' } };

  // 16 characters is the minimum.
  expect(loadServerConfig(await configFile({ ...base, userToken: 'x'.repeat(16) })).userToken).toBe('x'.repeat(16));

  const bad: Array<[unknown, RegExp]> = [
    [undefined, /userToken/],
    [12345678901234567890, /userToken/],
    ['', /userToken.*16/],
    ['x'.repeat(15), /userToken.*16/],
    ['user token with spaces', /userToken.*whitespace/],
    [' ' + 'x'.repeat(20), /userToken.*whitespace/],
    ['x'.repeat(20) + '\n', /userToken.*whitespace/],
    ['x'.repeat(10) + '\t' + 'x'.repeat(10), /userToken.*whitespace/],
    ['collector-token-mini', /userToken.*differ.*"mac-mini"/],
  ];
  for (const [userToken, reason] of bad) {
    const path = await configFile({ ...base, userToken });
    expect(() => loadServerConfig(path), JSON.stringify(userToken)).toThrow(path);
    expect(() => loadServerConfig(path), JSON.stringify(userToken)).toThrow(reason);
  }
});

test('the error for a userToken that equals a collector token does not print the token', async () => {
  const path = await configFile({ port: 8787, dbPath: 'x', userToken: 'shared-secret-0123456', collectors: { laptop: 'shared-secret-0123456' } });
  let message = '';
  try {
    loadServerConfig(path);
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toMatch(/userToken/);
  expect(message).not.toContain('shared-secret-0123456');
});

test('rejects a file that is not JSON', async () => {
  const path = await configFile('{not json');
  expect(() => loadServerConfig(path)).toThrow(/not valid JSON/);
});
