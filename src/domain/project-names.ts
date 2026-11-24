import type { DatabaseSync } from 'node:sqlite';

// What a session's project is called where the user works: the Paseo project (the repository's name, which the user
// already chose well), or for a session only herdr sees, the folder it runs in. Board projects are named after it.

/** Folders that hold many projects rather than being one. */
const CONTAINERS = new Set(['repos', 'developer', 'projects', 'project', 'workspace', 'workspaces', 'src', 'code', 'documents', 'desktop', 'downloads', 'tmp', 'temp', 'work', 'git', 'github']);

/** The last folder of `cwd`, unless that says nothing about the work (a home directory, a container of repositories, a Paseo-made worktree). */
export function folderName(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length <= 2) return null; // `/`, `/home/u`, `/Users/u`
  if (parts.includes('worktrees') && parts.includes('.paseo')) return null;
  const last = parts.at(-1) ?? null;
  return last !== null && CONTAINERS.has(last.toLowerCase()) ? null : last;
}

/** The project name of one session: Paseo's when any source reported one, else its working folder's; null when neither says. */
export function sessionProjectName(db: DatabaseSync, key: string): string | null {
  const paseo = db
    .prepare('SELECT project_name FROM session_sources WHERE session_key = ? AND project_name IS NOT NULL ORDER BY last_seen DESC LIMIT 1')
    .get(key) as { project_name: string } | undefined;
  if (paseo) return paseo.project_name;
  const row = db.prepare('SELECT cwd FROM sessions WHERE key = ?').get(key) as { cwd: string | null } | undefined;
  return folderName(row?.cwd ?? null);
}

/** Whether a project title is named after `name` (it is, or starts with it), compared without case. */
export function titleUsesName(title: string, name: string): boolean {
  const t = title.trim().toLowerCase();
  const n = name.trim().toLowerCase();
  return t === n || t.startsWith(`${n}：`) || t.startsWith(`${n}:`) || t.startsWith(`${n} `) || t.startsWith(`${n}（`) || t.startsWith(`${n}(`);
}
