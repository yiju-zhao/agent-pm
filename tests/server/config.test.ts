import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadServerConfig, understandingSettings } from '../../src/server/config.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herdr-pm-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const USER_TOKEN = 'user-token-0123456789';
const MCP_TOKEN = 'mcp-token-0123456789';

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
    mcpToken: MCP_TOKEN,
    collectors: { 'gx10-090e': 'tok-1', laptop: 'tok-2' },
  });
  expect(loadServerConfig(path)).toEqual({
    port: 8787,
    dbPath: '/var/lib/herdr-pm/pm.db',
    userToken: USER_TOKEN,
    mcpToken: MCP_TOKEN,
    collectors: { 'gx10-090e': 'tok-1', laptop: 'tok-2' },
  });
});

test('resolves a relative dbPath against the config file directory, not the cwd', async () => {
  const path = await configFile({ port: 8787, dbPath: 'data/pm.db', userToken: USER_TOKEN, mcpToken: MCP_TOKEN, collectors: {} });
  expect(loadServerConfig(path).dbPath).toBe(join(dir, 'data', 'pm.db'));
});

test('keeps the in-memory database name as is', async () => {
  const path = await configFile({ port: 8787, dbPath: ':memory:', userToken: USER_TOKEN, mcpToken: MCP_TOKEN, collectors: {} });
  expect(loadServerConfig(path).dbPath).toBe(':memory:');
});

test('throws a clear error naming the file and the invalid fields', async () => {
  const path = await configFile({ port: 'http', dbPath: 5, userToken: USER_TOKEN, mcpToken: MCP_TOKEN, collectors: { laptop: '' } });
  expect(() => loadServerConfig(path)).toThrow(path);
  expect(() => loadServerConfig(path)).toThrow(/port/);
  expect(() => loadServerConfig(path)).toThrow(/dbPath/);
  expect(() => loadServerConfig(path)).toThrow(/collectors\.laptop/);
});

test('rejects collector machine labels that cannot be part of a session key', async () => {
  for (const label of ['mac mini', 'gx10:090e', ' laptop', 'a/b', '']) {
    const path = await configFile({ port: 8787, dbPath: 'x', userToken: USER_TOKEN, mcpToken: MCP_TOKEN, collectors: { laptop: 't', [label]: 't2' } });
    expect(() => loadServerConfig(path), JSON.stringify(label)).toThrow(/collectors/);
    expect(() => loadServerConfig(path), JSON.stringify(label)).toThrow(/letters, digits/);
  }
});

test('rejects a missing file', () => {
  expect(() => loadServerConfig(join(dir, 'missing.json'))).toThrow(/missing\.json/);
});

test('rejects missing fields, out-of-range ports and non-object configs', async () => {
  const ok = { port: 8787, dbPath: 'x', userToken: USER_TOKEN, mcpToken: MCP_TOKEN, collectors: {} };
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
  const base = { port: 8787, dbPath: 'x', mcpToken: MCP_TOKEN, collectors: { laptop: 'collector-token-laptop', 'mac-mini': 'collector-token-mini' } };

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

test('mcpToken must be ≥16 chars, no whitespace, and differ from userToken and collector tokens', async () => {
  const base = {
    port: 8787,
    dbPath: 'x',
    userToken: USER_TOKEN,
    collectors: { laptop: 'collector-token-laptop', 'mac-mini': 'collector-token-mini' },
  };

  // 16 characters is the minimum.
  expect(loadServerConfig(await configFile({ ...base, mcpToken: 'm'.repeat(16) })).mcpToken).toBe('m'.repeat(16));

  const bad: Array<[unknown, RegExp]> = [
    [undefined, /mcpToken/],
    [12345678901234567890, /mcpToken/],
    ['', /mcpToken.*16/],
    ['m'.repeat(15), /mcpToken.*16/],
    ['mcp token with spaces', /mcpToken.*whitespace/],
    ['m'.repeat(20) + '\n', /mcpToken.*whitespace/],
    ['m'.repeat(10) + '\t' + 'm'.repeat(10), /mcpToken.*whitespace/],
    ['collector-token-mini', /mcpToken.*differ.*"mac-mini"/],
    [USER_TOKEN, /mcpToken.*differ.*userToken/],
  ];
  for (const [mcpToken, reason] of bad) {
    const path = await configFile({ ...base, mcpToken });
    expect(() => loadServerConfig(path), JSON.stringify(mcpToken)).toThrow(path);
    expect(() => loadServerConfig(path), JSON.stringify(mcpToken)).toThrow(reason);
  }

  // The error never prints the token it is complaining about.
  let message = '';
  try {
    loadServerConfig(await configFile({ ...base, mcpToken: USER_TOKEN }));
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).not.toContain(USER_TOKEN);
});

test('the error for a userToken that equals a collector token does not print the token', async () => {
  const path = await configFile({ port: 8787, dbPath: 'x', userToken: 'shared-secret-0123456', mcpToken: MCP_TOKEN, collectors: { laptop: 'shared-secret-0123456' } });
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

test('understanding settings are optional and oauthTokenFile resolves relative to the config file', async () => {
  const base = { port: 8787, dbPath: 'x', userToken: USER_TOKEN, mcpToken: MCP_TOKEN, collectors: {} };
  const plain = loadServerConfig(await configFile(base));
  expect(plain.understanding).toBeUndefined();
  expect(understandingSettings(plain)).toEqual({
    enabled: true,
    digestModel: 'claude-haiku-5-5',
    curateModel: 'claude-sonnet-5-5',
    oauthTokenFile: undefined,
  });

  const custom = loadServerConfig(
    await configFile({
      ...base,
      understanding: { enabled: false, digestModel: 'm-digest', curateModel: 'm-curate', oauthTokenFile: 'secrets/token' },
    }),
  );
  expect(custom.understanding).toEqual({
    enabled: false,
    digestModel: 'm-digest',
    curateModel: 'm-curate',
    oauthTokenFile: join(dir, 'secrets', 'token'),
  });
  expect(understandingSettings(custom)).toEqual(custom.understanding);

  const absolute = loadServerConfig(await configFile({ ...base, understanding: { oauthTokenFile: '/etc/herdr-pm/token' } }));
  expect(absolute.understanding).toEqual({ oauthTokenFile: '/etc/herdr-pm/token' });

  const bad = await configFile({ ...base, understanding: { enabled: 'yes', digestModel: '' } });
  expect(() => loadServerConfig(bad)).toThrow(/understanding\.enabled/);
  expect(() => loadServerConfig(bad)).toThrow(/understanding\.digestModel/);
});

test('paseoCollectors: optional; each token must differ from every other token, and errors never print it', async () => {
  const base = { port: 8787, dbPath: 'x.db', userToken: USER_TOKEN, mcpToken: MCP_TOKEN, collectors: { laptop: 'laptop-collector-token' } };
  expect(loadServerConfig(await configFile(base)).paseoCollectors).toBeUndefined();
  const ok = loadServerConfig(
    await configFile({ ...base, paseoCollectors: { 'paseo-mac-mini': { token: 'paseo-token-0123456789', machine: 'mac-mini', serverId: 'srv_x' } } }),
  );
  expect(ok.paseoCollectors).toEqual({ 'paseo-mac-mini': { token: 'paseo-token-0123456789', machine: 'mac-mini', serverId: 'srv_x' } });
  for (const [token, clash] of [
    ['laptop-collector-token', 'a herdr collector token'],
    [USER_TOKEN, 'userToken'],
    [MCP_TOKEN, 'mcpToken'],
  ]) {
    const path = await configFile({ ...base, paseoCollectors: { p: { token, machine: 'm', serverId: 's' } } });
    expect(() => loadServerConfig(path)).toThrow(`paseoCollectors.p.token: must differ from ${clash}`);
    try {
      loadServerConfig(path);
    } catch (err) {
      expect((err as Error).message).not.toContain(token);
    }
  }
  const twice = await configFile({
    ...base,
    paseoCollectors: { a: { token: 'same-paseo-token-0123', machine: 'm', serverId: 's1' }, b: { token: 'same-paseo-token-0123', machine: 'm', serverId: 's2' } },
  });
  expect(() => loadServerConfig(twice)).toThrow('must differ from another Paseo collector token');
  const colon = await configFile({ ...base, paseoCollectors: { 'herdr:m': { token: 'paseo-token-0123456789', machine: 'm', serverId: 's' } } });
  expect(() => loadServerConfig(colon)).toThrow(/source id must contain only/);
});
