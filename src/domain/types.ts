import { randomBytes } from 'node:crypto';

// The vocabulary lives in `src/shared/vocab.ts` (no imports) so the web page can use it at runtime.
export { PRIORITIES, STAGE_LABEL, STAGES } from '../shared/vocab.ts';
export type { Priority, Stage } from '../shared/vocab.ts';

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
