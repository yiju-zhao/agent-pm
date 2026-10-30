import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { main } from '../src/cli.ts';
import { loadCollectorConfig } from '../src/collector/config.ts';
import { loadServerConfig } from '../src/server/config.ts';

type Run = { code: number; stdout: string; stderr: string; urls: string[] };

const SESSIONS = [
  { short_id: '5d27595b', machine: 'laptop', agent_kind: 'claude', effective_status: 'working', title: 'fix the parser' },
  { short_id: 'a1b2c3d4', machine: 'gx10-090e', agent_kind: 'codex', effective_status: 'offline', title: '数据清洗' },
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-pm-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(respond: (url: URL) => Response | Promise<Response>, urls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    urls.push(url.toString());
    return respond(url);
  }) as typeof fetch;
}

async function run(argv: string[], respond: (url: URL) => Response | Promise<Response> = () => Response.json(SESSIONS)): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const code = await main(argv, {
    fetch: fakeFetch(respond, urls),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, stdout: out.join(''), stderr: err.join(''), urls };
}

/** Terminal columns a string occupies: CJK characters take two. */
function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return width;
}

test('sessions command formats table from /sessions response', async () => {
  const { code, stdout, stderr, urls } = await run(['sessions', '--server', 'http://pm.test:7718']);
  expect(code).toBe(0);
  expect(stderr).toBe('');
  expect(urls).toEqual(['http://pm.test:7718/sessions']);

  const [header, ...rows] = stdout.trimEnd().split('\n');
  expect(header!.split(/\s+/)).toEqual(['短ID', '机器', 'agent', '状态', '标题']);
  expect(rows).toHaveLength(2);
  for (const [i, s] of SESSIONS.entries()) {
    expect(rows[i]!.split(/\s+/)).toEqual([s.short_id, s.machine, s.agent_kind, s.effective_status, ...s.title.split(/\s+/)]);
  }
});

test('sessions table columns line up even with wide characters in the header', async () => {
  const { stdout } = await run(['sessions']);
  const [header, ...rows] = stdout.trimEnd().split('\n');
  const titleColumn = (line: string, title: string) => displayWidth(line.slice(0, line.indexOf(title)));
  expect(titleColumn(header!, '标题')).toBe(titleColumn(rows[0]!, 'fix the parser'));
  expect(titleColumn(rows[1]!, '数据清洗')).toBe(titleColumn(rows[0]!, 'fix the parser'));
});

test('sessions defaults to localhost:7718 and passes --machine as a query parameter', async () => {
  const { code, urls } = await run(['sessions', '--machine', 'gx10-090e']);
  expect(code).toBe(0);
  expect(urls).toEqual(['http://localhost:7718/sessions?machine=gx10-090e']);
});

test('sessions keeps a path prefix on the server url', async () => {
  const { urls } = await run(['sessions', '--server', 'http://pm.test/herdr/']);
  expect(urls).toEqual(['http://pm.test/herdr/sessions']);
});

test('sessions flattens multi-line titles and says so when there are none', async () => {
  const messy = [{ ...SESSIONS[0], title: 'line one\n\tline  two' }];
  const { stdout } = await run(['sessions'], () => Response.json(messy));
  expect(stdout.trimEnd().split('\n')).toHaveLength(2);
  expect(stdout).toContain('line one line two');

  const empty = await run(['sessions'], () => Response.json([]));
  expect(empty.code).toBe(0);
  expect(empty.stdout).toContain('没有 session');
});

test('sessions reports an unreachable server and exits 1', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(['sessions', '--server', 'http://127.0.0.1:1'], {
    fetch: (() => Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') }))) as typeof fetch,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  expect(code).toBe(1);
  expect(out.join('')).toBe('');
  expect(err.join('')).toContain('http://127.0.0.1:1');
  expect(err.join('')).toContain('ECONNREFUSED');
});

test('sessions reports a non-200 or malformed response and exits 1', async () => {
  const failing = await run(['sessions'], () => new Response('boom', { status: 500 }));
  expect(failing.code).toBe(1);
  expect(failing.stderr).toContain('500');

  const malformed = await run(['sessions'], () => Response.json({ not: 'a list' }));
  expect(malformed.code).toBe(1);
  expect(malformed.stderr).toContain('unexpected response');
});

test('sessions rejects an invalid --server url with usage exit code 2', async () => {
  const { code, stderr, urls } = await run(['sessions', '--server', 'not a url']);
  expect(code).toBe(2);
  expect(stderr).toContain('not a url');
  expect(urls).toEqual([]);
});

test('unknown command prints usage and exits 2', async () => {
  const { code, stdout, stderr } = await run(['frobnicate']);
  expect(code).toBe(2);
  expect(stdout).toBe('');
  expect(stderr).toContain('frobnicate');
  for (const command of ['herdr-pm server', 'herdr-pm collect', 'herdr-pm sessions']) expect(stderr).toContain(command);
});

test('no command and unknown options print usage and exit 2; --help prints usage and exits 0', async () => {
  expect((await run([])).code).toBe(2);
  const badOption = await run(['sessions', '--bogus']);
  expect(badOption.code).toBe(2);
  expect(badOption.stderr).toContain('--bogus');
  expect(badOption.stderr).toContain('herdr-pm sessions');

  const help = await run(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('herdr-pm collect');
  expect(help.stderr).toBe('');
});

test('server and collect require --config', async () => {
  for (const command of ['server', 'collect']) {
    const { code, stderr } = await run([command]);
    expect(code, command).toBe(2);
    expect(stderr, command).toContain('--config');
  }
});

test('collect exits 1 with the reason when the config cannot be loaded', async () => {
  const missing = await run(['collect', '--config', join(dir, 'nope.json')]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('cannot read collector config');
  expect(missing.stderr.match(/ENOENT/g)).toHaveLength(1);

  const server = await run(['server', '--config', join(dir, 'nope.json')]);
  expect(server.code).toBe(1);
  expect(server.stderr).toContain('cannot read server config');
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function writeServerConfig(port: number): string {
  const path = join(dir, 'server.json');
  writeFileSync(path, JSON.stringify({ port, dbPath: 'pm.db', collectors: { laptop: 'tok-laptop' } }));
  return path;
}

test('server serves the api on the configured port until it is aborted', async () => {
  const port = await freePort();
  const abort = new AbortController();
  const out: string[] = [];
  const err: string[] = [];
  const done = main(['server', '--config', writeServerConfig(port)], {
    fetch,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    signal: abort.signal,
  });
  try {
    let body: unknown;
    for (let attempt = 0; body === undefined && attempt < 100; attempt++) {
      try {
        body = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(body).toEqual([]);
    expect(out.join('')).toContain(`:${port}`);
  } finally {
    abort.abort();
  }
  expect(await done).toBe(0);
  expect(err.join('')).toBe('');
  await expect(fetch(`http://127.0.0.1:${port}/sessions`)).rejects.toThrow();
});

test('server exits 1 when the port is already taken', async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, resolve));
  const port = (blocker.address() as { port: number }).port;
  try {
    const err: string[] = [];
    const code = await main(['server', '--config', writeServerConfig(port)], {
      fetch,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join('')).toContain('EADDRINUSE');
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('cli.ts imports server modules only dynamically, so the collect path never loads node:sqlite or hono', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const staticImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]!);
  expect(staticImports.filter((spec) => /server|sqlite|hono/.test(spec))).toEqual([]);
  for (const spec of ['./server/config.ts', './server/db.ts', './server/http.ts', '@hono/node-server']) {
    expect(source).toContain(`await import('${spec}')`);
  }
});

test('the example configs load with the real config loaders', () => {
  const root = new URL('../config/', import.meta.url);
  expect(loadServerConfig(new URL('server.example.json', root).pathname).port).toBe(7718);
  const collector = loadCollectorConfig(new URL('collector.example.json', root).pathname);
  expect(collector.server).toMatch(/^http:\/\/.+:7718\/?$/);
});
