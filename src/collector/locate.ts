import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type TranscriptDirs = { claudeDir: string; codexDir: string };

// Native ids become part of a file name, so they must not be able to point anywhere else.
const SAFE_ID = /^[\w.-]+$/;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

// <claudeDir>/projects/<slug>/<id>.jsonl; the slug is the cwd with "/" -> "-" and is unknown here.
async function locateClaude(nativeId: string, claudeDir: string): Promise<string | null> {
  const projects = join(claudeDir, 'projects');
  const slugs = (await listDir(projects)).sort();
  const candidates = slugs.map((slug) => join(projects, slug, `${nativeId}.jsonl`));
  const found = await Promise.all(candidates.map(isFile));
  const hit = found.indexOf(true);
  return hit >= 0 ? candidates[hit]! : null;
}

// <codexDir>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl; ids contain "-" themselves,
// so match the "-<id>.jsonl" file name suffix rather than splitting the name.
async function locateCodex(nativeId: string, codexDir: string): Promise<string | null> {
  const sessions = join(codexDir, 'sessions');
  let entries: string[];
  try {
    entries = await readdir(sessions, { recursive: true });
  } catch {
    return null;
  }
  const suffix = `-${nativeId}.jsonl`;
  const hit = entries.sort().find((rel) => {
    const name = basename(rel);
    return name.startsWith('rollout-') && name.endsWith(suffix);
  });
  return hit === undefined ? null : join(sessions, hit);
}

/** Finds the JSONL transcript of a session on local disk from its native session id. */
export async function locateTranscript(
  agentKind: string,
  nativeId: string,
  dirs: TranscriptDirs,
): Promise<string | null> {
  if (!SAFE_ID.test(nativeId)) return null;
  if (agentKind === 'claude') return locateClaude(nativeId, dirs.claudeDir);
  if (agentKind === 'codex') return locateCodex(nativeId, dirs.codexDir);
  return null;
}
