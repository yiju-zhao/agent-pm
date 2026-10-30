import type { DatabaseSync } from 'node:sqlite';

export type DomainTable = 'projects' | 'milestones' | 'todos' | 'decisions' | 'blockers' | 'contributions' | 'sessions';

/** One row's net effect inside an operation. `before` is `null` for an insert; otherwise only the changed columns. */
export type Change = {
  table: DomainTable;
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
};

/** Column values this module can bind. `undefined` entries in a row or patch are skipped. */
type SqlValue = string | number | null;
type Values = Record<string, SqlValue | undefined>;

/** The only table names that may reach SQL, with each table's primary-key column. */
const PRIMARY_KEY: Record<DomainTable, string> = {
  projects: 'id',
  milestones: 'id',
  todos: 'id',
  decisions: 'id',
  blockers: 'id',
  contributions: 'id',
  sessions: 'key',
};

function primaryKeyOf(table: DomainTable): string {
  if (!Object.hasOwn(PRIMARY_KEY, table)) throw new Error(`unknown domain table: ${String(table)}`);
  return PRIMARY_KEY[table];
}

/** Column names come from code, never from requests; this guards against a slip turning into injection. */
const COLUMN_RE = /^[a-z][a-z0-9_]*$/;

function checkedColumns(values: Values): [string, SqlValue][] {
  const entries = Object.entries(values).filter((e): e is [string, SqlValue] => e[1] !== undefined);
  for (const [col] of entries) {
    if (!COLUMN_RE.test(col)) throw new Error(`invalid column name: ${col}`);
  }
  return entries;
}

export function readRow(db: DatabaseSync, table: DomainTable, id: string): Record<string, unknown> | undefined {
  const pk = primaryKeyOf(table);
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(id);
  return row === undefined ? undefined : { ...row };
}

/** Writes rows and remembers what changed, so the operation can log one event for all of it. */
export class ChangeSet {
  readonly changes: Change[] = [];
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Inserts a row; `after` is every column that was inserted. */
  insert(table: DomainTable, row: Values): void {
    const pk = primaryKeyOf(table);
    const entries = checkedColumns(row);
    const id = row[pk];
    if (typeof id !== 'string' || id === '') throw new Error(`insert into ${table} needs a primary key (${pk})`);
    const cols = entries.map(([col]) => col);
    this.db
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...entries.map(([, v]) => v));
    this.changes.push({ table, id, before: null, after: Object.fromEntries(entries) });
  }

  /**
   * Applies `patch` to an existing row. Only columns whose value really changes are written and recorded.
   * Returns false (and writes nothing) when nothing changed.
   */
  update(table: DomainTable, id: string, patch: Values): boolean {
    const pk = primaryKeyOf(table);
    const entries = checkedColumns(patch);
    if (entries.some(([col]) => col === pk)) throw new Error(`cannot change the primary key (${pk}) of ${table}`);
    const row = readRow(this.db, table, id);
    if (!row) throw new Error(`${table}:${id} does not exist`);
    for (const [col] of entries) {
      if (!Object.hasOwn(row, col)) throw new Error(`${table} has no column ${col}`);
    }
    const changed = entries.filter(([col, value]) => row[col] !== value);
    if (changed.length === 0) return false;

    this.db
      .prepare(`UPDATE ${table} SET ${changed.map(([col]) => `${col} = ?`).join(', ')} WHERE ${pk} = ?`)
      .run(...changed.map(([, v]) => v), id);

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [col, value] of changed) {
      before[col] = row[col];
      after[col] = value;
    }
    this.merge(table, id, before, after);
    return true;
  }

  /** Repeated updates of a row fold into its first update Change, whose `before` values win. An insert stays its own Change. */
  private merge(table: DomainTable, id: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
    const existing = this.changes.find((c) => c.table === table && c.id === id && c.before !== null);
    if (!existing?.before) {
      this.changes.push({ table, id, before, after });
      return;
    }
    for (const col of Object.keys(before)) {
      if (!Object.hasOwn(existing.before, col)) existing.before[col] = before[col];
    }
    Object.assign(existing.after, after);
  }
}

export type EventInput = {
  occurred_at: string;
  recorded_at: string;
  actor: string;
  op: string;
  project_id: string | null;
  args: unknown;
  changes: Change[];
  reason: string | null;
  evidence: string[];
  question_id: string | null;
  reverts?: number;
  is_veto?: boolean;
};

/**
 * Appends one event row; `before` / `after` are JSON objects keyed by `${table}:${id}`. Returns the event id.
 * Several Changes to one row (an insert, then updates) collapse into one entry: the earliest `before`
 * (null for an insert) and the latest `after` values.
 */
export function appendEvent(db: DatabaseSync, e: EventInput): number {
  const before: Record<string, Record<string, unknown> | null> = {};
  const after: Record<string, Record<string, unknown>> = {};
  for (const c of e.changes) {
    const key = `${c.table}:${c.id}`;
    if (!Object.hasOwn(after, key)) {
      before[key] = c.before && { ...c.before };
      after[key] = { ...c.after };
      continue;
    }
    const earliest = before[key];
    if (earliest && c.before) {
      for (const col of Object.keys(c.before)) {
        if (!Object.hasOwn(earliest, col)) earliest[col] = c.before[col];
      }
    }
    Object.assign(after[key], c.after);
  }
  const first = e.changes[0];
  const result = db
    .prepare(
      `INSERT INTO events (occurred_at, recorded_at, actor, op, entity, project_id, args, before, after,
                           reason, evidence, question_id, reverts, is_veto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.occurred_at,
      e.recorded_at,
      e.actor,
      e.op,
      first ? `${first.table}:${first.id}` : null,
      e.project_id,
      JSON.stringify(e.args ?? null),
      JSON.stringify(before),
      JSON.stringify(after),
      e.reason,
      JSON.stringify(e.evidence),
      e.question_id,
      e.reverts ?? null,
      e.is_veto ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}

/** Fields a user's edit locks against AI changes, per table. */
export const LOCKABLE = {
  projects: ['title', 'summary', 'why', 'done_criteria', 'priority'],
  todos: ['title', 'status', 'priority', 'milestone_id'],
  milestones: ['title', 'status', 'position'],
};

const LOCKABLE_FIELDS = new Set(Object.values(LOCKABLE).flat());

/** The lock list stored in a row's `locks` column; anything malformed counts as no locks. */
export function readLocks(row: Record<string, unknown>): string[] {
  if (typeof row.locks !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(row.locks);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/** New `locks` JSON text: existing locks plus `fields`, limited to lockable fields, deduped and sorted. */
export function addLocks(row: Record<string, unknown>, fields: string[]): string {
  const merged = new Set([...readLocks(row), ...fields].filter((f) => LOCKABLE_FIELDS.has(f)));
  return JSON.stringify([...merged].sort());
}
