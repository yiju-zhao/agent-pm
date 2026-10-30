import type { DatabaseSync } from 'node:sqlite';
import type { Row } from '../../src/domain/changes.ts';
import { execute } from '../../src/domain/execute.ts';
import type { OpName } from '../../src/domain/ops.ts';
import type { DomainDeps, IdPrefix, OpResult, RejectCode } from '../../src/domain/types.ts';
import { openDb } from '../../src/server/db.ts';

export const NOW = '2026-10-29T12:00:00.000Z';

/**
 * Every field any `OpResult` can carry, so tests can write `r.id` or `r.question_ids[0]` without narrowing.
 * Fields the actual status does not have are `undefined` at runtime; assert `status` first when it matters.
 */
export type Result = {
  status: OpResult['status'];
  event_id: number | null;
  id: string;
  question_ids: string[];
  warnings: string[];
  code: RejectCode;
  message: string;
};

export type AiExtra = { reason?: string; evidence?: string[] };

export type Setup = {
  db: DatabaseSync;
  deps: DomainDeps;
  setNow(iso: string): void;
  user(op: OpName, args: unknown): Result;
  ai(op: OpName, args: unknown, extra?: AiExtra): Result;
};

/** A fresh in-memory database, a pinned clock (`NOW`) and per-prefix counter ids (`p_1`, `p_2`, `q_1`, ...). */
export function setup(): Setup {
  const db = openDb(':memory:');
  let clock = new Date(NOW);
  const counters = new Map<IdPrefix, number>();
  const deps: DomainDeps = {
    now: () => clock,
    newId: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${n}`;
    },
  };
  return {
    db,
    deps,
    setNow(iso) {
      clock = new Date(iso);
    },
    user: (op, args) => execute(db, deps, { op, args, actor: 'user' }) as Result,
    ai: (op, args, extra = {}) =>
      execute(db, deps, {
        op,
        args,
        actor: 'ai:curator',
        reason: extra.reason ?? 'r',
        evidence: extra.evidence ?? ['chunk:1'],
      }) as Result,
  };
}

export type { Row };

export function row(db: DatabaseSync, table: string, id: string): Row {
  const found = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!found) throw new Error(`no ${table} row ${id}`);
  return { ...found };
}

export function rows(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r }));
}

export function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

export function eventsFor(db: DatabaseSync, projectId: string): Row[] {
  return db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id').all(projectId).map((r) => ({ ...r }));
}

export function lastEvent(db: DatabaseSync): Row {
  const found = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  if (!found) throw new Error('no events');
  return { ...found };
}
