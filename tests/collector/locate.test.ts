import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { locateTranscript } from '../../src/collector/locate.ts';

let root: string;
let claudeDir: string;
let codexDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'herdr-pm-locate-'));
  claudeDir = join(root, 'claude');
  codexDir = join(root, 'codex');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CLAUDE_ID = '5d27595b-908e-4fe5-9283-890acdbd075f';
const CODEX_ID = '019faf79-1484-79b3-b6c0-f15856766dc1';

test('locates claude transcript by id regardless of project slug', async () => {
  await mkdir(join(claudeDir, 'projects', '-Users-x-other'), { recursive: true });
  await mkdir(join(claudeDir, 'projects', '-Users-x-y'), { recursive: true });
  await writeFile(join(claudeDir, 'projects', '-Users-x-other', 'zzz.jsonl'), '');
  const expected = join(claudeDir, 'projects', '-Users-x-y', `${CLAUDE_ID}.jsonl`);
  await writeFile(expected, '{}\n');
  expect(await locateTranscript('claude', CLAUDE_ID, { claudeDir, codexDir })).toBe(expected);
});

test('locates codex rollout by id in nested date dirs', async () => {
  const dayDir = join(codexDir, 'sessions', '2026', '10', '29');
  await mkdir(dayDir, { recursive: true });
  await writeFile(join(dayDir, `rollout-2026-10-29T11-00-00-${CODEX_ID.replace('1484', '0000')}.jsonl`), '');
  const expected = join(dayDir, `rollout-2026-10-29T11-19-19-${CODEX_ID}.jsonl`);
  await writeFile(expected, '{}\n');
  expect(await locateTranscript('codex', CODEX_ID, { claudeDir, codexDir })).toBe(expected);
});

test('codex id must match the whole filename suffix, not just its tail', async () => {
  const dayDir = join(codexDir, 'sessions', '2026', '10', '29');
  await mkdir(dayDir, { recursive: true });
  await writeFile(join(dayDir, `rollout-2026-10-29T11-19-19-${CODEX_ID}.jsonl`), '');
  // A shorter id that is a suffix of a real id must not match inside it ("-" boundary required).
  expect(await locateTranscript('codex', CODEX_ID.slice(1), { claudeDir, codexDir })).toBeNull();
});

test('returns null when absent', async () => {
  await mkdir(join(claudeDir, 'projects', '-Users-x-y'), { recursive: true });
  await mkdir(join(codexDir, 'sessions', '2026', '10', '29'), { recursive: true });
  expect(await locateTranscript('claude', CLAUDE_ID, { claudeDir, codexDir })).toBeNull();
  expect(await locateTranscript('codex', CODEX_ID, { claudeDir, codexDir })).toBeNull();
});

test('returns null (never throws) when the agent dirs do not exist', async () => {
  const dirs = { claudeDir: join(root, 'no-claude'), codexDir: join(root, 'no-codex') };
  expect(await locateTranscript('claude', CLAUDE_ID, dirs)).toBeNull();
  expect(await locateTranscript('codex', CODEX_ID, dirs)).toBeNull();
});

test('returns null for other agent kinds', async () => {
  await mkdir(join(claudeDir, 'projects', '-Users-x-y'), { recursive: true });
  await writeFile(join(claudeDir, 'projects', '-Users-x-y', `${CLAUDE_ID}.jsonl`), '');
  expect(await locateTranscript('gemini', CLAUDE_ID, { claudeDir, codexDir })).toBeNull();
});

test('rejects ids that would escape the transcript directories', async () => {
  await mkdir(join(claudeDir, 'projects', 'p'), { recursive: true });
  // reachable as projects/p/../secret.jsonl if the id were joined into the path unchecked
  await writeFile(join(claudeDir, 'projects', 'secret.jsonl'), '');
  expect(await locateTranscript('claude', '../secret', { claudeDir, codexDir })).toBeNull();
  expect(await locateTranscript('claude', '', { claudeDir, codexDir })).toBeNull();
});
