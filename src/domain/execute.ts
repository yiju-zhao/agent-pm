import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { transaction } from '../server/db.ts';
import { appendEvent, ChangeSet, netChanges } from './changes.ts';
import { ITEM_HANDLERS } from './items-ops.ts';
import { EVIDENCE_RE, OP_SCHEMAS } from './ops.ts';
import type { OpInput, OpName } from './ops.ts';
import { PROJECT_HANDLERS } from './projects-ops.ts';
import { createQuestion, USER_ONLY_OPS, withdrawStale } from './questions.ts';
import type { QuestionDraft } from './questions.ts';
import { isAi, OpRejected } from './types.ts';
import type { Actor, DomainDeps, OpResult } from './types.ts';

/** What a handler sees and fills in while one operation runs. */
export type OpContext = {
  db: DatabaseSync;
  deps: DomainDeps;
  actor: Actor;
  ai: boolean;
  reason: string | null;
  evidence: string[];
  occurredAt: string;
  questionId: string | null;
  /** All writes to domain tables go through this, so the operation can log them as one event. */
  changes: ChangeSet;
  /** The project the event is filed under. */
  projectId: string | null;
  questionIds: string[];
  warnings: string[];
  /** Proposals that could not be stored (`question_limit`, `recently_rejected`); the handler carries on. */
  proposalErrors: OpRejected[];
  isVeto: boolean;
  /** Asks the user to confirm something the actor may not do directly. */
  propose(draft: Omit<QuestionDraft, 'created_by' | 'evidence'>): void;
};

export type Handler = (ctx: OpContext, args: any) => { id?: string } | void;

export const HANDLERS: Partial<Record<OpName, Handler>> = { ...PROJECT_HANDLERS, ...ITEM_HANDLERS };

const Occurred = z.iso.datetime();

const USER_ONLY: readonly OpName[] = USER_ONLY_OPS;

/** Proposal failures the handler may carry on from; anything else is a bug and aborts the operation. */
const SOFT_PROPOSAL_ERRORS = new Set(['question_limit', 'recently_rejected']);

/**
 * Runs one operation: validates it, applies the trust rules, calls its handler and appends one event for whatever
 * changed. Does not open a transaction (callers wrap it); throws `OpRejected` to abort.
 */
export function runOp(db: DatabaseSync, deps: DomainDeps, input: OpInput): OpResult {
  const { op, actor } = input;
  if (!Object.hasOwn(OP_SCHEMAS, op)) throw new OpRejected('invalid', `unknown op ${JSON.stringify(op)}`);
  const parsed = OP_SCHEMAS[op].safeParse(input.args);
  if (!parsed.success) throw new OpRejected('invalid', `invalid args for ${op}: ${z.prettifyError(parsed.error)}`);
  const args = parsed.data;

  let occurredAt = deps.now().toISOString();
  if (input.occurred_at !== undefined) {
    const at = Occurred.safeParse(input.occurred_at);
    if (!at.success) throw new OpRejected('invalid', 'occurred_at must be an ISO-8601 UTC instant');
    occurredAt = new Date(at.data).toISOString();
  }

  const ai = isAi(actor);
  const reason = input.reason?.trim() || null;
  const evidence = input.evidence ?? [];
  if (ai) {
    if (reason === null) throw new OpRejected('missing_reason', 'an AI operation needs a reason');
    if (evidence.length === 0 || evidence.some((e) => typeof e !== 'string' || !EVIDENCE_RE.test(e))) {
      throw new OpRejected('missing_evidence', `an AI operation needs evidence like chunk:123#L40 (got ${JSON.stringify(evidence)})`);
    }
    if (USER_ONLY.includes(op)) throw new OpRejected('user_only', `only the user may ${op}`);
  }

  const handler = Object.hasOwn(HANDLERS, op) ? HANDLERS[op] : undefined;
  if (!handler) throw new OpRejected('invalid', `${op} is not supported yet`);

  const ctx: OpContext = {
    db,
    deps,
    actor,
    ai,
    reason,
    evidence,
    occurredAt,
    questionId: input.question_id ?? null,
    changes: new ChangeSet(db),
    projectId: null,
    questionIds: [],
    warnings: [],
    proposalErrors: [],
    isVeto: false,
    propose(draft) {
      try {
        const { id } = createQuestion(db, deps, { ...draft, created_by: actor, evidence });
        if (!ctx.questionIds.includes(id)) ctx.questionIds.push(id);
      } catch (e) {
        if (e instanceof OpRejected && SOFT_PROPOSAL_ERRORS.has(e.code)) ctx.proposalErrors.push(e);
        else throw e;
      }
    },
  };

  const out = handler(ctx, args) ?? {};
  const changes = netChanges(ctx.changes.changes);

  if (changes.length > 0) {
    const eventId = appendEvent(db, {
      occurred_at: occurredAt,
      recorded_at: deps.now().toISOString(),
      actor,
      op,
      project_id: ctx.projectId,
      args,
      changes,
      reason,
      evidence,
      question_id: ctx.questionId,
      is_veto: ctx.isVeto,
    });
    withdrawStale(db, deps, changes);
    return applied(ctx, eventId, out.id);
  }
  if (ctx.questionIds.length > 0) return { status: 'proposed', question_ids: ctx.questionIds };
  if (ctx.proposalErrors.length > 0) throw ctx.proposalErrors[0];
  return applied(ctx, null, out.id);
}

function applied(ctx: OpContext, eventId: number | null, id: string | undefined): OpResult {
  const warnings = [...ctx.warnings, ...ctx.proposalErrors.map((e) => `${e.code}: ${e.message}`)];
  return { status: 'applied', event_id: eventId, ...(id === undefined ? {} : { id }), question_ids: ctx.questionIds, warnings };
}

/** Runs `runOp` in its own transaction; a rejection rolls everything back and comes back as a `rejected` result. */
export function execute(db: DatabaseSync, deps: DomainDeps, input: OpInput): OpResult {
  try {
    return transaction(db, () => runOp(db, deps, input));
  } catch (e) {
    if (e instanceof OpRejected) return { status: 'rejected', code: e.code, message: e.message };
    throw e;
  }
}
