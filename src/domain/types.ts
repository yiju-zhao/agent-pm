import { randomBytes } from 'node:crypto';

export const STAGES = ['idea', 'explore', 'build', 'verify', 'done', 'parked', 'abandoned', 'merged'] as const;
export type Stage = (typeof STAGES)[number];

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  idea: 'idea',
  explore: '探索',
  build: '构建',
  verify: '验证',
  done: '完成',
  parked: '搁置',
  abandoned: '放弃',
  merged: '合并',
};

/** `'user'`, or `ai:<name>` such as `ai:curator`. */
export type Actor = 'user' | `ai:${string}`;

export function isAi(actor: Actor): boolean {
  return actor !== 'user';
}

export type IdPrefix = 'p' | 'm' | 't' | 'd' | 'b' | 'c' | 'q';

/** Everything non-deterministic the domain layer needs, so tests can pin it. */
export type DomainDeps = {
  now: () => Date;
  newId: (prefix: IdPrefix) => string;
};

export function defaultDeps(): DomainDeps {
  return {
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`,
  };
}

export type RejectCode =
  | 'invalid'
  | 'not_found'
  | 'vetoed'
  | 'merged'
  | 'not_allowed'
  | 'user_only'
  | 'missing_reason'
  | 'missing_evidence'
  | 'conflict'
  | 'already_reverted'
  | 'not_revertible'
  | 'not_pending'
  | 'stale'
  | 'question_limit'
  | 'recently_rejected';

/** Thrown inside an operation to abort it; `execute()` turns it into a `rejected` result. */
export class OpRejected extends Error {
  readonly code: RejectCode;

  constructor(code: RejectCode, message: string) {
    super(message);
    this.name = 'OpRejected';
    this.code = code;
  }
}

export type OpResult =
  | { status: 'applied'; event_id: number | null; id?: string; question_ids: string[]; warnings: string[] }
  | { status: 'proposed'; question_ids: string[] }
  | { status: 'rejected'; code: RejectCode; message: string };
