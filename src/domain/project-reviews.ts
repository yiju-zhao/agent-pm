import type { DatabaseSync } from 'node:sqlite';
import type { Change } from './changes.ts';

/** Follow only current merge pointers. A deleted or cyclic destination cannot be reorganized. */
export function reviewTarget(db: DatabaseSync, id: string): string | null {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const row = db.prepare('SELECT stage,merged_into,deleted_at FROM projects WHERE id=?').get(id) as { stage: string; merged_into: string | null; deleted_at: string | null } | undefined;
    if (!row || row.deleted_at) return null;
    if (row.stage !== 'merged') return id;
    if (!row.merged_into) return null;
    id = row.merged_into;
  }
  return null;
}

/** Called in the user's operation transaction, after its event exists. AI writes never call this. */
export function enqueueProjectReviews(db: DatabaseSync, eventId: number, changes: Change[], at: string): number {
  const targets = new Set<string>();
  for (const c of changes) {
    if (c.table === 'contributions') {
      const row = db.prepare('SELECT project_id FROM contributions WHERE id=?').get(c.id) as { project_id: string } | undefined;
      if (row) targets.add(row.project_id);
    }
    if (c.table === 'projects') {
      if (c.after.stage === 'merged' && typeof c.after.merged_into === 'string') targets.add(c.after.merged_into);
      if (c.before?.stage === 'merged' && typeof c.before.merged_into === 'string') { targets.add(c.before.merged_into); targets.add(c.id); }
    }
  }
  const canonical = new Set([...targets].map((id) => reviewTarget(db,id)).filter((id): id is string => id !== null));
  const cutoff = (db.prepare('SELECT coalesce(max(id),0) n FROM chunks').get() as { n: number }).n;
  for (const project of canonical) {
    // A newer user edit supersedes unfinished work; its fresh pass sees the full current project family.
    db.prepare("UPDATE project_reviews SET status='cancelled',updated_at=? WHERE project_id=? AND status IN ('pending','failed')").run(at, project);
    db.prepare(`INSERT INTO project_reviews (project_id,event_id,status,chunk_cutoff,created_at,updated_at)
      VALUES (?,?,'pending',?,?,?)`).run(project,eventId,cutoff,at,at);
  }
  return canonical.size;
}
