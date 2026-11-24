import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { linuxCollectorProcess, StateDir } from '../../src/paseo-collector/state-store.ts';

const identity = { sourceId: 'test', serverId: 'test', server: 'test' };
const moduleUrl = new URL('../../src/paseo-collector/state-store.ts', import.meta.url).href;
let dir: string;
let lock: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'paseo-state-lock-'));
  lock = join(dir, 'collector.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Only the file lock is exercised. These children never connect to the center or a daemon.
async function withChild(body: string, args: string[], run: (pid: number, crash: () => Promise<void>) => void | Promise<void>) {
  const script = join(dir, 'cli.ts');
  writeFileSync(script, body + "\nprocess.send('ready'); process.stdin.resume();");
  const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  const crash = async () => { child.kill('SIGKILL'); await exited; };
  try {
    await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('child exited before acquiring lock'); })]);
    await run(child.pid!, crash);
  } finally {
    if (child.exitCode === null && child.signalCode === null) await crash();
  }
}

test('takes over a legacy PID lock belonging to a live unrelated process', async () => {
  await withChild('', [], pid => {
    writeFileSync(lock, String(pid));
    StateDir.open(dir, identity).release();
  });
});

test('the gx10 procfs record identifies PID 2957 as a thread of process 2945', () => {
  const entry = join(dir, '2957');
  mkdirSync(entry);
  // A Linux thread can even share the parent collector's command line; only its group leader owns a lock.
  writeFileSync(join(entry, 'cmdline'), 'node\0src/cli.ts\0collect-paseo\0');
  writeFileSync(join(entry, 'status'), 'Name:\trelay\nTgid:\t2945\nPid:\t2957\n');
  expect(linuxCollectorProcess(2957, dir)).toBe(false);
  writeFileSync(join(entry, 'status'), 'Tgid:\t2957\nPid:\t2957\n');
  expect(linuxCollectorProcess(2957, dir)).toBe(true);
});

test.skipIf(process.platform !== 'linux')('takes over a legacy PID lock naming a live non-leader Linux thread', () => {
  const tid = readdirSync('/proc/self/task').map(Number).find(id => id !== process.pid)!;
  expect(tid).toBeGreaterThan(0);
  process.kill(tid, 0);
  writeFileSync(lock, String(tid));
  StateDir.open(dir, identity).release();
});

test('leaves a running legacy collect-paseo owner and its lock intact', async () => {
  await withChild(`require('node:fs').writeFileSync(${JSON.stringify(lock)}, String(process.pid));`, ['collect-paseo', '--config', 'fixture.json'], pid => {
    expect(() => StateDir.open(dir, identity)).toThrow(/in use/);
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(pid));
  });
});

test('refuses another live holder and reopens the same identity after SIGKILL', async () => {
  await withChild(`import { StateDir } from ${JSON.stringify(moduleUrl)};\nglobalThis.state = StateDir.open(${JSON.stringify(dir)}, ${JSON.stringify(identity)});`, [], async (_pid, crash) => {
    expect(() => StateDir.open(dir, identity)).toThrow(/in use/);
    const original = readFileSync(join(dir, 'identity.json'), 'utf8');
    await crash();
    const state = StateDir.open(dir, identity);
    try {
      expect(state.identity).toEqual(JSON.parse(original));
      expect(Number(readFileSync(lock, 'utf8'))).toBe(process.pid); // older collectors can read the marker
    } finally {
      state.release();
    }
  });
});

test('a legacy PID reused by a younger collect-paseo process does not keep the old lock', async () => {
  await withChild('', ['collect-paseo', '--config', 'elsewhere.json'], pid => {
    writeFileSync(lock, String(pid));
    const beforeThisProcess = new Date(Date.now() - 60_000);
    utimesSync(lock, beforeThisProcess, beforeThisProcess);
    StateDir.open(dir, identity).release();
  });
});

test('a stale kernel-protected marker can be reclaimed even when its PID now runs another collector', async () => {
  await withChild('', ['collect-paseo', '--config', 'elsewhere.json'], pid => {
    writeFileSync(lock, '0x' + pid.toString(16));
    StateDir.open(dir, identity).release();
  });
});
