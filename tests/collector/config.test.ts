import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { expandHome, loadCollectorConfig } from '../../src/collector/config.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herdr-pm-ccfg-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function configFile(body: unknown): Promise<string> {
  const path = join(dir, 'collector.json');
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

test('fills defaults and expands ~ in paths', async () => {
  const path = await configFile({ server: 'http://100.64.0.1:7718', machine: 'laptop', token: 't' });
  expect(loadCollectorConfig(path)).toEqual({
    server: 'http://100.64.0.1:7718',
    machine: 'laptop',
    token: 't',
    herdrBin: 'herdr',
    claudeDir: join(homedir(), '.claude'),
    codexDir: join(homedir(), '.codex'),
    stateFile: join(homedir(), '.local/state/herdr-pm/collector.json'),
    pollMs: 10_000,
  });
});

test('keeps explicit settings', async () => {
  const path = await configFile({
    server: 'https://pm.example',
    machine: 'gx10-090e',
    token: 't',
    herdrBin: '/opt/herdr',
    claudeDir: '~/alt-claude',
    codexDir: '/data/codex',
    stateFile: '/var/lib/pm.json',
    pollMs: 5000,
  });
  expect(loadCollectorConfig(path)).toMatchObject({
    herdrBin: '/opt/herdr',
    claudeDir: join(homedir(), 'alt-claude'),
    codexDir: '/data/codex',
    stateFile: '/var/lib/pm.json',
    pollMs: 5000,
  });
});

test('rejects missing fields, bad urls and invalid JSON with the file path', async () => {
  expect(() => loadCollectorConfig(join(dir, 'missing.json'))).toThrow(/cannot read collector config/);
  const noToken = await configFile({ server: 'http://x', machine: 'm' });
  expect(() => loadCollectorConfig(noToken)).toThrow(/token/);
  const badUrl = await configFile({ server: 'pm.local:7718', machine: 'm', token: 't' });
  expect(() => loadCollectorConfig(badUrl)).toThrow(/server/);
  const garbage = await configFile('{nope');
  expect(() => loadCollectorConfig(garbage)).toThrow(/not valid JSON/);
});

test('rejects a machine label that cannot be part of a session key', async () => {
  for (const machine of ['mac mini', 'gx10:090e', 'laptop\t', '', 'a/b']) {
    const path = await configFile({ server: 'http://x', machine, token: 't' });
    expect(() => loadCollectorConfig(path), JSON.stringify(machine)).toThrow(/machine/);
  }
  const path = await configFile({ server: 'http://x', machine: 'mac mini', token: 't' });
  expect(() => loadCollectorConfig(path)).toThrow(/letters, digits/);
  for (const machine of ['laptop', 'gx10-090e', 'mac_mini.local', 'M1']) {
    const ok = await configFile({ server: 'http://x', machine, token: 't' });
    expect(loadCollectorConfig(ok).machine).toBe(machine);
  }
});

test('expandHome only rewrites a leading ~', () => {
  expect(expandHome('~', '/h')).toBe('/h');
  expect(expandHome('~/x/y', '/h')).toBe('/h/x/y');
  expect(expandHome('/a/~/b', '/h')).toBe('/a/~/b');
  expect(expandHome('~other/x', '/h')).toBe('~other/x');
});
