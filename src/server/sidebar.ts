import type { DatabaseSync } from 'node:sqlite';
import { sessionLinks } from '../domain/read.ts';
import type { SidebarLabel } from '../shared/protocol.ts';
import { assignShortIds } from '../shared/session-key.ts';
import { mergeTarget } from './sessions-repo.ts';

/** The most code points of a project title the herdr sidebar shows; a longer one is cut to one less plus `…`. */
export const SIDEBAR_PROJECT_MAX = 16;

function cutTitle(title: string): string {
  const points = [...title];
  return points.length > SIDEBAR_PROJECT_MAX ? `${points.slice(0, SIDEBAR_PROJECT_MAX - 1).join('')}…` : title;
}

/** `null` without projects, else the first title (cut) with ` +N` for the N others. */
function projectLabel(titles: string[]): string | null {
  const [first, ...others] = titles;
  if (first === undefined) return null;
  return others.length === 0 ? cutTitle(first) : `${cutTitle(first)} +${others.length}`;
}

/**
 * The sidebar label of each key, in input order: its short id and a one-line project summary. Short ids are computed
 * over every session row, so they equal what the web UI shows. A key that was merged into another (a pending key whose
 * session got its native id) is labelled with the target's short id and links but keeps the key it was asked for; a key
 * that is not in the database gets a short id from itself and no project.
 */
export function sidebarLabels(db: DatabaseSync, keys: string[]): SidebarLabel[] {
  const rows = db.prepare('SELECT key, merged_into FROM sessions').all() as Array<{ key: string; merged_into: string | null }>;
  const shortIds = assignShortIds(rows.map((r) => r.key));
  const merged = new Set(rows.filter((r) => r.merged_into !== null).map((r) => r.key));
  const links = sessionLinks(db);

  return keys.map((key) => {
    const target = merged.has(key) ? mergeTarget(db, key) : key;
    const shortId = shortIds.get(target) ?? assignShortIds([target]).get(target)!;
    const projects = links.get(target) ?? [];
    return { key, short_id: shortId, project: projectLabel(projects.map((p) => p.title)) };
  });
}
