import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { transaction } from '../server/db.ts';
import { readRow } from './changes.ts';
import type { DomainTable } from './changes.ts';
import { EVIDENCE_RE, OP_SCHEMAS } from './ops.ts';
import type { OpName } from './ops.ts';
import { isAi, OpRejected } from './types.ts';
import type { Actor, DomainDeps, OpResult } from './types.ts';

export const MAX_PENDING_AI_QUESTIONS = 30;
export const REJECT_COOLDOWN_DAYS = 7;
export const QUESTION_TTL_DAYS = 30;

const DAY_MS = 86_400_000;

/** One answer a question offers. `op: null` means "do nothing" (e.g. 拒绝). */
export type QuestionOption = {
  label: string;
  op: OpName | null;
  args?: Record<string, unknown>;
  /** Dot path inside `args` that the user's free text fills in, e.g. `fields.done_criteria`. */
  text_arg?: string;
};

/** The question only makes sense while `table:id`'s `col` still equals `equals`. */
export type Guard = { table: DomainTable; id: string; col: string; equals: unknown };

export type QuestionDraft = {
  kind: 'choice' | 'text' | 'confirm';
  prompt: string;
  options: QuestionOption[];
  project_id: string | null;
  session_key: string | null;
  evidence: string[];
  guards: Guard[];
  dedupe_key: string;
  created_by: Actor;
};

/** ISO instant `days` before now; stored timestamps are ISO strings, so they compare as text. */
function daysBeforeNow(deps: DomainDeps, days: number): string {
  return new Date(deps.now().getTime() - days * DAY_MS).toISOString();
}

/** Parses a JSON array column; anything malformed counts as empty. */
function readJsonArray<T>(text: unknown): T[] {
  if (typeof text !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// ---- option args -------------------------------------------------------------------------------------------------

const ARG_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of `args` with `value` at the dot path (`fields.done_criteria` is `args.fields.done_criteria`).
 * Missing parents are created; a parent that is not an object is replaced. `args` itself is never changed.
 */
export function setArgPath(args: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  if (!ARG_PATH_RE.test(path)) throw new OpRejected('invalid', `invalid text_arg path: ${JSON.stringify(path)}`);
  const [key, ...rest] = path.split('.');
  if (rest.length === 0) return { ...args, [key]: value };
  const current = Object.hasOwn(args, key) ? args[key] : undefined;
  const child = isPlainObject(current) ? current : {};
  return { ...args, [key]: setArgPath(child, rest.join('.'), value) };
}

/**
 * Operations only the user may perform. Answering a question runs the chosen option as the user, so an AI must not
 * be able to bind one of these to an option.
 */
export const USER_ONLY_OPS = ['unlock_field', 'revert_event'] as const satisfies readonly OpName[];

function isUserOnlyOp(op: OpName): boolean {
  return (USER_ONLY_OPS as readonly OpName[]).includes(op);
}

/** Checks that answering `option` can never fail on the shape of its args, and that `creator` may offer it. */
function checkOption(option: QuestionOption, creator: Actor): void {
  const where = `invalid option ${JSON.stringify(option.label)}`;
  if (option.op === null) {
    if (option.text_arg !== undefined) throw new OpRejected('invalid', `${where}: text_arg needs an op`);
    return;
  }
  if (isAi(creator) && isUserOnlyOp(option.op)) {
    throw new OpRejected('invalid', `${where}: ${option.op} is user-only and cannot be offered by an AI`);
  }
  if (!Object.hasOwn(OP_SCHEMAS, option.op)) throw new OpRejected('invalid', `${where}: unknown op ${JSON.stringify(option.op)}`);
  const args = option.args ?? {};
  const probe = option.text_arg === undefined ? args : setArgPath(args, option.text_arg, 'x');
  const parsed = OP_SCHEMAS[option.op].safeParse(probe);
  if (!parsed.success) {
    throw new OpRejected('invalid', `${where}: args do not fit ${option.op}: ${z.prettifyError(parsed.error)}`);
  }
}

/** The usual pair for proposing one operation: do it, or decline. */
export function confirmOptions(op: OpName, args: object): QuestionOption[] {
  return [
    { label: '确认', op, args: { ...args } },
    { label: '拒绝', op: null },
  ];
}

// ---- creating ----------------------------------------------------------------------------------------------------

/**
 * Stores a pending question. Questions past their time limit are expired first. If a pending question with the same
 * `dedupe_key` exists, adds the new evidence to it instead. Throws `OpRejected`: `invalid` (an option's args don't
 * fit its op, or an AI offers a `USER_ONLY_OPS` op), `recently_rejected` (the user rejected this `dedupe_key` within
 * `REJECT_COOLDOWN_DAYS` of the rejection), `question_limit` (an AI already has `MAX_PENDING_AI_QUESTIONS` pending,
 * not counting those about a deleted project). Does not open a transaction; callers wrap it.
 */
export function createQuestion(db: DatabaseSync, deps: DomainDeps, draft: QuestionDraft): { id: string; deduped: boolean } {
  for (const option of draft.options) checkOption(option, draft.created_by);
  const evidence = [...new Set(draft.evidence)];
  expireQuestions(db, deps);

  const existing = db
    .prepare("SELECT id, evidence FROM questions WHERE status = 'pending' AND dedupe_key = ? ORDER BY rowid LIMIT 1")
    .get(draft.dedupe_key) as { id: string; evidence: string } | undefined;
  if (existing) {
    const merged = [...new Set([...readJsonArray<string>(existing.evidence), ...evidence])];
    db.prepare('UPDATE questions SET evidence = ? WHERE id = ?').run(JSON.stringify(merged), existing.id);
    return { id: existing.id, deduped: true };
  }

  const rejected = db
    .prepare('SELECT 1 FROM questions WHERE dedupe_key = ? AND rejected = 1 AND resolved_at > ? LIMIT 1')
    .get(draft.dedupe_key, daysBeforeNow(deps, REJECT_COOLDOWN_DAYS));
  if (rejected) {
    throw new OpRejected('recently_rejected', `the user rejected this question within the last ${REJECT_COOLDOWN_DAYS} days`);
  }

  if (isAi(draft.created_by)) {
    const { n } = db
      .prepare(
        // Questions about a deleted project are never listed, so the user cannot answer them to free a slot.
        `SELECT COUNT(*) AS n FROM questions WHERE status = 'pending' AND created_by <> 'user'
           AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL))`,
      )
      .get() as { n: number };
    if (n >= MAX_PENDING_AI_QUESTIONS) {
      throw new OpRejected('question_limit', `${MAX_PENDING_AI_QUESTIONS} AI questions are already waiting for an answer`);
    }
  }

  const id = deps.newId('q');
  db.prepare(
    `INSERT INTO questions (id, kind, prompt, options, project_id, session_key, status, answer, evidence, guards,
                            dedupe_key, rejected, resolution_note, created_by, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, 0, NULL, ?, ?, NULL)`,
  ).run(
    id,
    draft.kind,
    draft.prompt,
    JSON.stringify(draft.options),
    draft.project_id,
    draft.session_key,
    JSON.stringify(evidence),
    JSON.stringify(draft.guards),
    draft.dedupe_key,
    draft.created_by,
    deps.now().toISOString(),
  );
  return { id, deduped: false };
}

// ---- guards, withdrawal, expiry ----------------------------------------------------------------------------------

/** True when every guard's row exists and its column still has exactly the expected value. */
export function guardsHold(db: DatabaseSync, guards: Guard[]): boolean {
  return guards.every((g) => {
    const row = readRow(db, g.table, g.id);
    return row !== undefined && Object.hasOwn(row, g.col) && row[g.col] === g.equals;
  });
}

/**
 * Withdraws (`resolution_note = 'stale'`) the pending questions that guard one of the `touched` rows and whose guards
 * no longer all hold. Returns their ids, oldest first. Does not open a transaction; callers wrap it.
 */
export function withdrawStale(
  db: DatabaseSync,
  deps: DomainDeps,
  touched: Array<{ table: DomainTable; id: string }>,
): string[] {
  if (touched.length === 0) return [];
  const touchedKeys = new Set(touched.map((t) => `${t.table}:${t.id}`));
  const candidates = db
    .prepare("SELECT id, guards FROM questions WHERE status = 'pending' AND guards <> '[]' ORDER BY rowid")
    .all() as Array<{ id: string; guards: string }>;
  const withdraw = db.prepare("UPDATE questions SET status = 'withdrawn', resolution_note = 'stale', resolved_at = ? WHERE id = ?");
  const resolvedAt = deps.now().toISOString();

  const withdrawn: string[] = [];
  for (const { id, guards: text } of candidates) {
    const guards = readJsonArray<Guard>(text);
    if (!guards.some((g) => touchedKeys.has(`${g.table}:${g.id}`))) continue;
    if (guardsHold(db, guards)) continue;
    withdraw.run(resolvedAt, id);
    withdrawn.push(id);
  }
  return withdrawn;
}

/** Marks pending questions created more than `QUESTION_TTL_DAYS` ago as expired; returns how many. */
export function expireQuestions(db: DatabaseSync, deps: DomainDeps): number {
  const result = db
    .prepare("UPDATE questions SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND created_at < ?")
    .run(deps.now().toISOString(), daysBeforeNow(deps, QUESTION_TTL_DAYS));
  return Number(result.changes);
}

// ---- askUser -----------------------------------------------------------------------------------------------------

const OP_NAMES = Object.keys(OP_SCHEMAS) as [OpName, ...OpName[]];

const label = z.string().trim().min(1).max(200);
const args = z.record(z.string(), z.unknown()).optional();

/** An option that may do nothing (`op: null`). */
export const ChoiceOption = z.object({ label, op: z.enum(OP_NAMES).nullable(), args }).strict();
/** The user's free text fills `text_arg`, so both an op and the path are required. */
export const TextOption = z.object({ label, op: z.enum(OP_NAMES), args, text_arg: z.string().min(1) }).strict();
/** The single thing the user is asked to approve; `askUser` adds the 拒绝 option. */
export const ConfirmOption = z.object({ label, op: z.enum(OP_NAMES), args }).strict();

/** The fields every kind of `AskUserInput` shares; exported so a tool can offer them as a flat input shape. */
export const ASK_COMMON_SHAPE = {
  prompt: z.string().trim().min(1).max(2000),
  project_id: z.string().min(1).nullish(),
  session_key: z.string().min(1).nullish(),
  /** Questions about the same topic share a dedupe key; defaults to the kind. */
  topic: z.string().trim().min(1).max(200).optional(),
  evidence: z.array(z.string().regex(EVIDENCE_RE)).min(1),
};

export const AskUserInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), ...ASK_COMMON_SHAPE, options: z.array(ChoiceOption).min(2).max(6) }).strict(),
  z.object({ kind: z.literal('text'), ...ASK_COMMON_SHAPE, option: TextOption }).strict(),
  z.object({ kind: z.literal('confirm'), ...ASK_COMMON_SHAPE, option: ConfirmOption }).strict(),
]);
export type AskUserInput = z.infer<typeof AskUserInput>;

/**
 * Stages an AI may not offer through `askUser`, where it writes the prompt and labels itself: a label like "add a todo"
 * could hide closing the project. These come only from the domain's own proposals, whose prompt says what happens.
 */
const PROPOSAL_ONLY_STAGES: readonly string[] = ['done', 'abandoned', 'merged', 'parked'];

function checkAiOption(option: QuestionOption): void {
  if (option.op === 'transition_stage' && option.text_arg === 'stage') {
    // Answering would ask the user to type the stage by hand ("done"), and an AI must not steer them into that.
    throw new OpRejected(
      'invalid',
      `invalid option ${JSON.stringify(option.label)}: an AI cannot make the user type a stage (text_arg 'stage' on transition_stage); offer fixed options instead`,
    );
  }
  const stage = option.args?.stage;
  if (option.op === 'transition_stage' && typeof stage === 'string' && PROPOSAL_ONLY_STAGES.includes(stage)) {
    throw new OpRejected(
      'invalid',
      `invalid option ${JSON.stringify(option.label)}: an AI cannot ask to move a project to ${stage}; call transition_stage, which asks the user itself`,
    );
  }
}

/**
 * Lets an actor put a question to the user. Returns `proposed` with the question's id (the existing one when the
 * question was a duplicate) or `rejected` (`invalid`, `question_limit`, `recently_rejected`). An AI may not bind
 * `transition_stage` to done, abandoned, merged or parked here, nor to free text for the stage (`invalid`).
 * Runs in its own transaction.
 */
export function askUser(db: DatabaseSync, deps: DomainDeps, input: unknown, actor: Actor): OpResult {
  const parsed = AskUserInput.safeParse(input);
  if (!parsed.success) return { status: 'rejected', code: 'invalid', message: z.prettifyError(parsed.error) };
  const ask = parsed.data;

  const options: QuestionOption[] =
    ask.kind === 'choice'
      ? ask.options
      : ask.kind === 'text'
        ? [ask.option]
        : [ask.option, ...confirmOptions(ask.option.op, ask.option.args ?? {}).slice(1)];
  const projectId = ask.project_id ?? null;
  const sessionKey = ask.session_key ?? null;

  try {
    if (isAi(actor)) for (const option of options) checkAiOption(option);
    const { id } = transaction(db, () =>
      createQuestion(db, deps, {
        kind: ask.kind,
        prompt: ask.prompt,
        options,
        project_id: projectId,
        session_key: sessionKey,
        evidence: ask.evidence,
        guards: [],
        dedupe_key: `ask:${projectId ?? '-'}:${sessionKey ?? '-'}:${ask.topic ?? ask.kind}`,
        created_by: actor,
      }),
    );
    return { status: 'proposed', question_ids: [id] };
  } catch (e) {
    if (e instanceof OpRejected) return { status: 'rejected', code: e.code, message: e.message };
    throw e;
  }
}
