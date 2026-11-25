import type { DatabaseSync } from 'node:sqlite';

import { assignShortIds } from '../shared/session-key.ts';

export type SearchScope = 'all' | 'ledger' | 'digests' | 'messages';
export type SearchHit = {
  ref: string;
  kind: 'project' | 'milestone' | 'todo' | 'decision' | 'blocker' | 'digest' | 'message';
  project_id: string | null;
  session_key: string | null;
  ts: string | null;
  snippet: string;
};

const indexedTables = ['projects', 'milestones', 'todos', 'decisions', 'blockers', 'digests', 'turn_items'];
const columns = 'rowid, body, ref, kind, project_id, session_key, ts';

export function rebuildSearchIndex(db: DatabaseSync): void {
  db.exec('SAVEPOINT rebuild_search');
  try {
    db.exec('DELETE FROM search_index');
    for (const table of indexedTables)
      db.exec(`INSERT INTO search_index(${columns})
      SELECT docid, body, ref, kind, project_id, session_key, ts FROM search_${table}`);
    db.exec('RELEASE rebuild_search');
  } catch (error) {
    db.exec('ROLLBACK TO rebuild_search; RELEASE rebuild_search');
    throw error;
  }
}

export function searchContext(
  db: DatabaseSync,
  query: string,
  options: {
    scope: SearchScope;
    projectId?: string;
    sessionKey?: string;
    limit: number;
  },
): SearchHit[] {
  const term = query.trim();
  if (!term) return [];
  const short = Array.from(term).length < 3;
  const match = short ? "body LIKE ? ESCAPE '\\'" : 'search_index MATCH ?';
  const needle = short ? '%' + term.replace(/[\\%_]/g, '\\$&') + '%' : '"' + term.replaceAll('"', '""') + '"';
  const scopes = { all: '1', ledger: 'i.project_id IS NOT NULL', messages: "kind='message'", digests: "kind='digest'" };
  const rows = db
    .prepare(
      `SELECT i.ref, i.kind, i.session_key, i.ts, i.body,
    coalesce(i.project_id, (SELECT c.project_id FROM contributions c JOIN projects p ON p.id=c.project_id
      WHERE c.session_key=i.session_key AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND (? IS NULL OR c.project_id=?) ORDER BY c.project_id LIMIT 1)) AS linked_project
    FROM search_index i WHERE ${match} AND ${scopes[options.scope]}
    AND (i.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=i.project_id AND p.deleted_at IS NULL))
    AND (? IS NULL OR linked_project=?) AND (? IS NULL OR i.session_key=?) ORDER BY i.ts DESC, i.rowid LIMIT ?`,
    )
    .all(
      options.projectId ?? null,
      options.projectId ?? null,
      needle,
      options.projectId ?? null,
      options.projectId ?? null,
      options.sessionKey ?? null,
      options.sessionKey ?? null,
      options.limit,
    ) as Array<Omit<SearchHit, 'snippet' | 'project_id'> & { body: string; linked_project: string | null }>;
  // A later session can extend an earlier short ID. Resolve the display address against today's complete directory.
  const shortIds = assignShortIds(
    db
      .prepare('SELECT key FROM sessions')
      .all()
      .map((s) => String(s.key)),
  );
  return rows.map(({ body, linked_project, ...hit }) => {
    const start = Math.max(0, body.toLowerCase().indexOf(term.toLowerCase()) - 40);
    const snippet = (start ? '…' : '') + body.slice(start, start + Math.max(120, term.length + 40));
    const shortId = hit.session_key && shortIds.get(hit.session_key);
    let ref = hit.ref;
    if (shortId && hit.kind === 'message') ref = 's:' + shortId + hit.ref.slice(hit.ref.lastIndexOf('#'));
    else if (shortId && hit.kind === 'digest') ref = 's:' + shortId;
    return { ...hit, ref, project_id: linked_project, snippet };
  });
}
