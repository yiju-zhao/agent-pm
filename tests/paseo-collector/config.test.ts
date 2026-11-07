import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { main } from '../../src/cli.ts';
import { loadPaseoCollectorConfig } from '../../src/paseo-collector/config.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'paseo-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SECRET = 'paseo-collector-secret-token-xyz';

async function files(over: Record<string, unknown> = {}, token = SECRET): Promise<string> {
  await writeFile(join(dir, 'token'), `${token}\n`);
  const path = join(dir, 'paseo.json');
  await writeFile(
    path,
    JSON.stringify({
      server: 'http://127.0.0.1:7718',
      sourceId: 'paseo-mac-mini',
      machine: 'mac-mini',
      tokenFile: join(dir, 'token'),
      paseo: { url: 'ws://127.0.0.1:6767/ws', serverId: 'srv_x' },
      stateDir: '~/.local/state/herdr-pm/paseo-mac-mini',
      ...over,
    }),
  );
  return path;
}

test('defaults, home expansion and secrets read from files', async () => {
  const { config, token, password } = loadPaseoCollectorConfig(await files());
  expect(token).toBe(SECRET);
  expect(password).toBeUndefined();
  expect(config).toMatchObject({ heartbeatMs: 10000, reconcileMs: 60000, maxConcurrentAgents: 4, includeArchivedHistory: false, includeBackground: true, readArchivedTracked: true });
  expect(config.stateDir).toBe(join(homedir(), '.local/state/herdr-pm/paseo-mac-mini'));
});

test('an empty or missing secret file is an error naming the file, never a secret', async () => {
  expect(() => loadPaseoCollectorConfig(files as never)).toThrow();
  const empty = await files({}, '   ');
  expect(() => loadPaseoCollectorConfig(empty)).toThrow(/tokenFile .*token is empty/);
  const noPassword = await files({ paseo: { url: 'ws://h:1/ws', serverId: 's', passwordFile: join(dir, 'nope') } });
  expect(() => loadPaseoCollectorConfig(noPassword)).toThrow(/cannot read paseo.passwordFile/);
  const bad = await files({ paseo: { url: 'http://h/ws', serverId: 's' }, sourceId: 'a:b' });
  try {
    loadPaseoCollectorConfig(bad);
    throw new Error('should have failed');
  } catch (err) {
    expect((err as Error).message).toMatch(/paseo.url: .*ws:\/\//);
    expect((err as Error).message).toMatch(/sourceId/);
    expect((err as Error).message).not.toContain(SECRET);
  }
});

test('collect-paseo: usage without --config, a clear error for a bad config', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { fetch, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
  expect(await main(['collect-paseo'], io)).toBe(2);
  expect(err.join('')).toMatch(/collect-paseo requires --config/);
  err.length = 0;
  expect(await main(['collect-paseo', '--config', join(dir, 'missing.json')], io)).toBe(1);
  expect(err.join('')).toMatch(/cannot read Paseo collector config/);
  expect(await main(['--help'], io)).toBe(0);
  expect(out.join('')).toMatch(/collect-paseo --config <path>/);
});
