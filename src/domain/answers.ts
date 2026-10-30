import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { transaction } from '../server/db.ts';
import { runOp } from './execute.ts';
import { OP_SCHEMAS } from './ops.ts';
import { expireQuestions, guardsHold, setArgPath } from './questions.ts';
import type { Guard, QuestionOption } from './questions.ts';
import { OpRejected } from './types.ts';
import type { DomainDeps, OpResult, RejectCode } from './types.ts';

type QuestionRow = { kind: 'choice' | 'text' | 'confirm'; options: string; status: string; guards: string };

function rejected(code: RejectCode, message: string): OpResult {
  return { status: 'rejected', code, message };
}

/** The user's decision took effect but changed no project state (so there is no event). */
function done(): OpResult {
  return { status: 'applied', event_id: null, question_ids: [], warnings: [] };
}

/**
 * Expires old questions, then loads `id`. Returns the row if it is pending, otherwise the rejection to hand back.
 */
function loadPending(db: DatabaseSync, deps: DomainDeps, id: string): QuestionRow | OpResult {
  expireQuestions(db, deps);
  const found = db.prepare('SELECT kind, options, status, guards FROM questions WHERE id = ?').get(id) as QuestionRow | undefined;
  if (!found) return rejected('not_found', `question ${id} not found`);
  if (found.status !== 'pending') return rejected('not_pending', `question ${id} is ${found.status}, not pending`);
  return found;
}

/** Single statements are atomic on their own, so these need no transaction. */
function resolve(
  db: DatabaseSync,
  deps: DomainDeps,
  id: string,
  set: { status: 'answered' | 'withdrawn'; answer?: unknown; rejected?: boolean; note?: string },
): void {
  db.prepare(
    `UPDATE questions SET status = ?, answer = ?, rejected = ?, resolution_note = ?, resolved_at = ? WHERE id = ?`,
  ).run(
    set.status,
    set.answer === undefined ? null : JSON.stringify(set.answer),
    set.rejected ? 1 : 0,
    set.note ?? null,
    deps.now().toISOString(),
    id,
  );
}

/** Which option the answer picks, and the text to fill in, or why the answer does not fit the question. */
function pick(question: QuestionRow, options: QuestionOption[], answer: unknown): { index: number; text: string | null } | string {
  const given = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {};
  if (question.kind === 'text') {
    if (typeof given.text !== 'string' || given.text.trim() === '') return 'a text question needs a non-empty text';
    if (options.length === 0) return 'the question has no option to fill';
    return { index: 0, text: given.text };
  }
  const index = given.option_index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= options.length) {
    return `option_index must be an integer from 0 to ${options.length - 1}`;
  }
  return { index, text: null };
}

/**
 * Answers a pending question. The chosen option's operation runs as the user and its event is linked to the question
 * (`question_id`); an option without an operation (拒绝) is recorded as a rejection, which starts the re-ask cooldown.
 *
 * Returns `applied` (`event_id` is null when nothing ran), or a `rejected` result: `not_found`, `not_pending`,
 * `stale` (a guard no longer holds; the question is withdrawn), `invalid` (the answer does not fit the question, or
 * the typed text does not fit the op's args; it stays pending), or the code of any other rejection from the bound
 * operation (the question is withdrawn with it as the note).
 * Never throws `OpRejected`.
 */
export function answerQuestion(
  db: DatabaseSync,
  deps: DomainDeps,
  id: string,
  answer: { option_index: number } | { text: string },
): OpResult {
  const question = loadPending(db, deps, id);
  if (!('kind' in question)) return question;

  if (!guardsHold(db, JSON.parse(question.guards) as Guard[])) {
    resolve(db, deps, id, { status: 'withdrawn', note: 'stale' });
    return rejected('stale', 'the situation this question was about has changed');
  }

  const options = JSON.parse(question.options) as QuestionOption[];
  const picked = pick(question, options, answer);
  if (typeof picked === 'string') return rejected('invalid', picked);
  const option = options[picked.index];
  const stored = picked.text === null ? { option_index: picked.index } : { option_index: picked.index, text: picked.text };

  const op = option.op;
  if (op === null) {
    resolve(db, deps, id, { status: 'answered', answer: stored, rejected: true });
    return done();
  }

  try {
    const base = option.args ?? {};
    const args = picked.text !== null && option.text_arg !== undefined ? setArgPath(base, option.text_arg, picked.text) : base;
    if (picked.text !== null) {
      // The op's own schema can still refuse what the user typed (e.g. too long). That is the user's to fix, so the
      // question stays pending instead of being withdrawn.
      const parsed = OP_SCHEMAS[op].safeParse(args);
      if (!parsed.success) return rejected('invalid', `invalid args for ${op}: ${z.prettifyError(parsed.error)}`);
    }
    return transaction(db, () => {
      const result = runOp(db, deps, { op, args, actor: 'user', question_id: id });
      // The op may have withdrawn this very question as stale (it moved the column the question guards); answered wins.
      resolve(db, deps, id, { status: 'answered', answer: stored });
      return result;
    });
  } catch (e) {
    if (!(e instanceof OpRejected)) throw e;
    // The op's transaction is rolled back; the withdrawal is its own write.
    resolve(db, deps, id, { status: 'withdrawn', note: e.code });
    return rejected(e.code, e.message);
  }
}

/** Dismisses a pending question without answering it: withdrawn and counted as a rejection (starts the cooldown). */
export function dismissQuestion(db: DatabaseSync, deps: DomainDeps, id: string): OpResult {
  const question = loadPending(db, deps, id);
  if (!('kind' in question)) return question;
  resolve(db, deps, id, { status: 'withdrawn', rejected: true, note: 'dismissed' });
  return done();
}
