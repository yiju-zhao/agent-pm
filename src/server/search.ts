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

const ledger = [
  [
    'projects',
    'project',
    "trim(coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(why,'')||' '||coalesce(done_criteria,''))",
    'id',
    'created_at',
  ],
  ['milestones', 'milestone', 'title', 'project_id', 'created_at'],
  ['todos', 'todo', 'title', 'project_id', 'created_at'],
  ['decisions', 'decision', 'text', 'project_id', 'coalesce(decided_at,created_at)'],
  ['blockers', 'blocker', 'text', 'project_id', 'created_at'],
] as const;
const indexedTables = [...ledger.map(([table]) => table), 'digests', 'turn_items'];
const columns = 'rowid,body,ref,kind,project_id,session_key,ts';
// Disjoint rowids let every trigger replace exactly one document even when several messages share an address.
const stride = 8;
const digestText = ['topics', 'progress', 'decisions', 'blockers']
  .map(
    (field) =>
      `coalesce((SELECT group_concat(CASE WHEN j.type='object' THEN trim(coalesce(json_extract(j.value,'$.label'),'')||' '||coalesce(json_extract(j.value,'$.summary'),json_extract(j.value,'$.text'),'')) ELSE j.value END, ' ')
   FROM json_each(d.json,'$.${field}') j),'')`,
  )
  .join("||' '||");

export const SEARCH_SCHEMA = `
  CREATE VIRTUAL TABLE search_index USING fts5(body,ref UNINDEXED,kind UNINDEXED,project_id UNINDEXED,session_key UNINDEXED,ts UNINDEXED,tokenize='trigram');
  ${ledger
    .map(
      ([table, kind, body, project, time], i) => `CREATE VIEW search_${table} AS SELECT rowid AS identity,
    rowid*${stride}+${i} AS docid,${body} AS body,id AS ref,'${kind}' AS kind,${project} AS project_id,
    NULL AS session_key,${time} AS ts FROM ${table} WHERE deleted_at IS NULL;`,
    )
    .join('\n')}
  CREATE VIEW search_digests AS SELECT id AS identity,id*${stride}+5 AS docid,${digestText} AS body,
    'digest:'||id AS ref,'digest' AS kind,NULL AS project_id,session_key,coalesce(ts_end,created_at) AS ts
    FROM digests d WHERE json_valid(json) AND skipped=0;
  CREATE VIEW search_turn_items AS SELECT i.latest_event AS identity,i.latest_event*${stride}+6 AS docid,e.text AS body,
    's:'||substr(coalesce(s.native_id,s.terminal_id,substr(i.session_key,instr(i.session_key,':')+1)),1,8)||'#'||i.n AS ref,
    'message' AS kind,NULL AS project_id,i.session_key,e.ts
    FROM turn_items i JOIN source_events e ON e.id=i.latest_event LEFT JOIN sessions s ON s.key=i.session_key
    WHERE e.kind IN ('user','assistant') AND e.text IS NOT NULL;
  ${indexedTables
    .map((table, i) => {
      const pk = table === 'turn_items' ? 'latest_event' : 'rowid';
      const insert = `INSERT INTO search_index(${columns}) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_${table} WHERE identity=NEW.${pk};`;
      const remove = `DELETE FROM search_index WHERE rowid=OLD.${pk}*${stride}+${i};`;
      return `CREATE TRIGGER index_${table}_insert AFTER INSERT ON ${table} BEGIN ${insert} END;
      CREATE TRIGGER index_${table}_update AFTER UPDATE ON ${table} BEGIN ${remove} ${insert} END;
      CREATE TRIGGER index_${table}_delete AFTER DELETE ON ${table} BEGIN ${remove} END;`;
    })
    .join('\n')}
  CREATE TRIGGER index_message_text AFTER UPDATE OF text ON source_events WHEN OLD.kind IN ('user','assistant') BEGIN
    DELETE FROM search_index WHERE rowid=OLD.id*${stride}+6;
    INSERT INTO search_index(${columns}) SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_turn_items WHERE identity=NEW.id;
  END;
`;

export function rebuildSearchIndex(db: DatabaseSync): void {
  db.exec('SAVEPOINT rebuild_search');
  try {
    db.exec('DELETE FROM search_index');
    for (const table of indexedTables)
      db.exec(`INSERT INTO search_index(${columns})
      SELECT docid,body,ref,kind,project_id,session_key,ts FROM search_${table}`);
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
      `SELECT i.ref,i.kind,i.session_key,i.ts,i.body,
    coalesce(i.project_id,(SELECT c.project_id FROM contributions c JOIN projects p ON p.id=c.project_id
      WHERE c.session_key=i.session_key AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND (? IS NULL OR c.project_id=?) ORDER BY c.project_id LIMIT 1)) AS linked_project
    FROM search_index i WHERE ${match} AND ${scopes[options.scope]}
    AND (i.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=i.project_id AND p.deleted_at IS NULL))
    AND (? IS NULL OR linked_project=?) AND (? IS NULL OR i.session_key=?) ORDER BY i.ts DESC,i.rowid LIMIT ?`,
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
