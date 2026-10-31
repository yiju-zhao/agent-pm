import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ServerConfig } from '../../src/server/config.ts';
import { openDb } from '../../src/server/db.ts';
import { createApp } from '../../src/server/http.ts';

const config: ServerConfig = {
  port: 8787,
  dbPath: ':memory:',
  userToken: 'user-secret-token-0123456789',
  mcpToken: 'mcp-secret-token-0123456789',
  collectors: {},
};

let db: DatabaseSync;
let root: string;
let webDir: string;

beforeEach(() => {
  db = openDb(':memory:');
  // root/secret sits next to the web dir, root/web/index.html next to assets: neither may leak through /assets/.
  root = mkdtempSync(join(tmpdir(), 'herdr-pm-web-'));
  webDir = join(root, 'web');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>herdr-pm</title>');
  writeFileSync(join(webDir, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(webDir, 'assets', 'app-abc.css'), 'body{}');
  writeFileSync(join(webDir, 'assets', 'logo.svg'), '<svg/>');
  writeFileSync(join(webDir, 'assets', 'font.woff2'), 'x');
  writeFileSync(join(root, 'secret'), 'secret');
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const app = (dir: string | null = webDir) => createApp(db, config, undefined, undefined, { webDir: dir });

test('/ returns index.html without caching', async () => {
  const res = await app().request('/');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/html/);
  expect(res.headers.get('cache-control')).toBe('no-cache');
  expect(await res.text()).toContain('<title>herdr-pm</title>');
});

test('/assets/* returns the file with its type and an immutable cache header', async () => {
  const res = await app().request('/assets/app-abc.js');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
  expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(await res.text()).toBe('console.log(1)');

  const types = async (name: string) => (await app().request(`/assets/${name}`)).headers.get('content-type');
  expect(await types('app-abc.css')).toMatch(/^text\/css/);
  expect(await types('logo.svg')).toBe('image/svg+xml');
  expect(await types('font.woff2')).toBe('application/octet-stream');
});

test('missing assets and paths outside webDir/assets are 404', async () => {
  for (const path of ['/assets/nope.js', '/assets/..%2f..%2fsecret', '/assets/../index.html', '/assets/%2e%2e/index.html', '/assets/%2e%2e%2f%2e%2e%2fsecret', '/assets/', '/assets']) {
    const res = await app().request(path);
    expect(res.status, path).toBe(404);
    expect(await res.text(), path).not.toContain('secret');
  }
});

test('an asset path the file system cannot read (a NUL byte, a name too long) is 404, not a 500 with a stack trace', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const path of ['/assets/%00', '/assets/app-abc.js%00.png', `/assets/${'a'.repeat(5000)}.js`]) {
    const res = await app().request(path);
    expect(res.status, path).toBe(404);
  }
  expect(logged).not.toHaveBeenCalled();
});

test('without a built web dir / is 503 with the build hint', async () => {
  for (const dir of [null, join(root, 'missing')]) {
    const res = await app(dir).request('/');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toContain('npm run build:web');
  }
});

test('the JSON API is unaffected', async () => {
  const res = await app().request('/projects');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  expect(await res.json()).toEqual([]);
});
