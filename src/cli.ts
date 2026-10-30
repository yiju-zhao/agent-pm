#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadCollectorConfig } from './collector/config.ts';
import { runCollector } from './collector/loop.ts';
import type { Scheduler } from './understand/scheduler.ts';

// Server modules (node:sqlite, hono) are loaded only inside the `server` command, with a dynamic
// import: the single-file collector binary is built with bun, which has no node:sqlite, so the
// `collect` and `sessions` paths must never evaluate them.

/** The process-facing side of the CLI, injectable so tests need no network, terminal or exit. */
export type Io = {
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Stops the `server` command (the process entry point relies on SIGINT/SIGTERM instead). */
  signal?: AbortSignal;
};

const DEFAULT_SERVER = 'http://localhost:7718';

const USAGE = `Usage:
  herdr-pm server --config <path>                      run the central server
  herdr-pm collect --config <path>                     run the collector on this machine
  herdr-pm sessions [--server <url>] [--machine <m>]   list sessions known to the central server
`;

class UsageError extends Error {}

/** Runs one CLI invocation and returns the process exit code: 0 ok, 1 runtime failure, 2 usage error. */
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'server':
        return await runServer(args, io);
      case 'collect':
        return await runCollect(args, io);
      case 'sessions':
        return await runSessions(args, io);
      case '-h':
      case '--help':
      case 'help':
        io.stdout(USAGE);
        return 0;
      case undefined:
        throw new UsageError('missing command');
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`herdr-pm: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`herdr-pm: ${describeError(err)}\n`);
    return 1;
  }
}

function parseOptions<const O extends Record<string, { type: 'string' }>>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function requireConfig(command: string, args: string[]): string {
  const { config } = parseOptions(args, { config: { type: 'string' } });
  if (!config) throw new UsageError(`${command} requires --config <path>`);
  return config;
}

async function runServer(args: string[], io: Io): Promise<number> {
  const configPath = requireConfig('server', args);
  if (process.versions.bun) {
    throw new Error('the server needs node:sqlite, which bun lacks: run it with node (node src/cli.ts server --config <path>)');
  }
  const { loadServerConfig, understandingSettings } = await import('./server/config.ts');
  const { openDb } = await import('./server/db.ts');
  const { createApp } = await import('./server/http.ts');
  const { serve } = await import('@hono/node-server');

  const config = loadServerConfig(configPath);
  const understanding = understandingSettings(config);
  // Read once, before anything is opened: a token file that is configured but unusable stops the server.
  const oauthToken =
    understanding.enabled && understanding.oauthTokenFile !== undefined ? readTokenFile(understanding.oauthTokenFile) : undefined;

  const db = openDb(config.dbPath);
  let scheduler: Scheduler | null = null;
  let removeListeners = () => {};
  try {
    if (understanding.enabled) {
      // The scheduler and the Agent SDK runner are server-only, like the modules above.
      const { Scheduler } = await import('./understand/scheduler.ts');
      const { agentSdkRunner } = await import('./understand/agent-sdk.ts');
      const { defaultDeps } = await import('./domain/types.ts');
      scheduler = new Scheduler(db, defaultDeps(), agentSdkRunner({ oauthToken }), {
        digest: understanding.digestModel,
        curate: understanding.curateModel,
      });
      if (oauthToken === undefined && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        io.stdout(
          'herdr-pm server: no understanding.oauthTokenFile and no CLAUDE_CODE_OAUTH_TOKEN; model calls use this machine\'s Claude Code login\n',
        );
      }
    }
    const app = createApp(db, config, undefined, undefined, { scheduler });
    await new Promise<void>((resolve, reject) => {
      // No hostname: listen on every interface, so collectors and the CLI can reach it over Tailscale.
      const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
        const collectors = Object.keys(config.collectors).length;
        io.stdout(`herdr-pm server: listening on :${info.port} (all interfaces), db ${config.dbPath}, ${collectors} collector(s)\n`);
        scheduler?.start();
      });
      server.once('error', reject);
      const stop = () => server.close((err) => (err ? reject(err) : resolve()));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      io.signal?.addEventListener('abort', stop, { once: true });
      removeListeners = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        io.signal?.removeEventListener('abort', stop);
      };
    });
    return 0;
  } finally {
    removeListeners();
    // A model call in flight finishes (and writes its result) before the database goes away.
    if (scheduler !== null) {
      if (scheduler.status().running !== null) io.stdout('herdr-pm server: waiting for the running model call to finish…\n');
      await scheduler.stop();
    }
    db.close();
  }
}

/** The trimmed content of the oauth token file; unreadable or empty is a startup error. */
function readTokenFile(path: string): string {
  let token: string;
  try {
    token = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new Error(`cannot read understanding.oauthTokenFile ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (token === '') throw new Error(`understanding.oauthTokenFile ${path} is empty`);
  return token;
}

async function runCollect(args: string[], io: Io): Promise<number> {
  const config = loadCollectorConfig(requireConfig('collect', args));
  io.stdout(`herdr-pm collect: machine ${config.machine} -> ${config.server}\n`);
  return runCollector(config);
}

const SessionList = z.array(
  z.object({
    short_id: z.string(),
    machine: z.string(),
    agent_kind: z.string(),
    effective_status: z.string(),
    title: z.string(),
  }),
);

async function runSessions(args: string[], io: Io): Promise<number> {
  const { server = DEFAULT_SERVER, machine } = parseOptions(args, { server: { type: 'string' }, machine: { type: 'string' } });
  let url: URL;
  try {
    url = new URL('sessions', server.endsWith('/') ? server : `${server}/`);
  } catch {
    throw new UsageError(`invalid --server url "${server}"`);
  }
  if (machine) url.searchParams.set('machine', machine);

  let response: Response;
  try {
    response = await io.fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`cannot reach ${server}: ${describeError(err)}`);
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const parsed = SessionList.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error(`unexpected response from ${url}: expected a JSON list of sessions`);

  if (parsed.data.length === 0) {
    io.stdout('没有 session\n');
    return 0;
  }
  const rows = [
    ['短ID', '机器', 'agent', '状态', '标题'],
    ...parsed.data.map((s) => [s.short_id, s.machine, s.agent_kind, s.effective_status, s.title.replace(/\s+/g, ' ').trim()]),
  ];
  const widths = [0, 1, 2, 3].map((col) => Math.max(...rows.map((row) => displayWidth(row[col]!))));
  io.stdout(rows.map((row) => [...row.slice(0, 4).map((cell, col) => pad(cell, widths[col]!)), row[4]!].join('  ') + '\n').join(''));
  return 0;
}

/** Terminal columns a string occupies: CJK and full-width characters take two. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return width;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(width - displayWidth(text));
}

/** Message of an error plus the innermost cause, e.g. `fetch failed: connect ECONNREFUSED 127.0.0.1:7718`. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause === undefined) return err.message;
  // happy-eyeballs failures arrive as an AggregateError with an empty message
  const inner = cause instanceof AggregateError && !cause.message ? cause.errors[0] : cause;
  const detail = inner instanceof Error ? inner.message || (inner as { code?: string }).code : String(inner);
  return detail && !err.message.includes(detail) ? `${err.message}: ${detail}` : err.message;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    fetch,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
