import { z } from 'zod';
import { PRIORITIES, STAGES } from './types.ts';
import type { Actor } from './types.ts';

const Id = z.string().min(1);

/** Non-empty after trimming, at most `max` characters; the parsed value is the trimmed text. */
const text = (max = 4000) => z.string().trim().min(1).max(max);

/** ISO-8601 UTC instant, normalised to `Date#toISOString()` form so stored values sort as text. */
const Iso = z.iso.datetime().transform((s) => new Date(s).toISOString());

const Priority = z.enum(PRIORITIES);
const Stage = z.enum(STAGES);
const ItemStatus = z.enum(['todo', 'doing', 'done']);

const ProjectItem = z.object({ project: Id, id: Id }).strict();

export const OP_SCHEMAS = {
  create_project: z
    .object({
      title: text(200),
      summary: text().optional(),
      why: text().optional(),
      done_criteria: text().optional(),
      priority: Priority.nullable().optional(),
      stage: Stage.optional(),
      /** A session to link to the new project in the same event. */
      from_session: Id.optional(),
    })
    .strict(),
  update_project: z
    .object({
      project: Id,
      fields: z
        .object({
          title: text(200).optional(),
          summary: text().optional(),
          why: text().optional(),
          done_criteria: text().optional(),
          priority: Priority.nullable().optional(),
        })
        .strict()
        .refine((f) => Object.values(f).some((v) => v !== undefined), { message: 'fields must contain at least one key' }),
    })
    .strict(),
  transition_stage: z.object({ project: Id, stage: Stage, merge_into: Id.optional() }).strict(),
  unlock_field: z
    .object({ table: z.enum(['projects', 'todos', 'milestones']), id: Id, field: Id })
    .strict(),
  upsert_milestone: z
    .object({
      project: Id,
      id: Id.optional(),
      title: text().optional(),
      status: ItemStatus.optional(),
      position: z.int().min(0).optional(),
    })
    .strict(),
  upsert_todo: z
    .object({
      project: Id,
      id: Id.optional(),
      title: text().optional(),
      status: ItemStatus.optional(),
      priority: Priority.nullable().optional(),
      milestone_id: Id.nullable().optional(),
    })
    .strict(),
  record_decision: z.object({ project: Id, text: text(), decided_at: Iso.optional() }).strict(),
  set_blocker: z
    .object({
      project: Id,
      id: Id.optional(),
      text: text().optional(),
      kind: z.enum(['user', 'external', 'technical']).optional(),
    })
    .strict(),
  delete_milestone: ProjectItem,
  delete_todo: ProjectItem,
  delete_decision: ProjectItem,
  delete_blocker: ProjectItem,
  clear_blocker: ProjectItem,
  link_session: z
    .object({
      session: Id,
      project: Id,
      milestone_id: Id.nullable().optional(),
      summary: text().optional(),
      ts_start: Iso.optional(),
      ts_end: Iso.optional(),
      confidence: z.number().min(0).max(1).optional(),
    })
    .strict(),
  unlink_session: z.object({ session: Id, project: Id }).strict(),
  ignore_session: z.object({ session: Id, ignored: z.boolean().default(true) }).strict(),
  revert_event: z.object({ event_id: z.int().min(1) }).strict(),
};

export type OpName = keyof typeof OP_SCHEMAS;
export type OpArgs<N extends OpName> = z.infer<(typeof OP_SCHEMAS)[N]>;

export type OpInput = {
  op: OpName;
  args: unknown;
  actor: Actor;
  reason?: string;
  evidence?: string[];
  /** When the thing happened in the conversation; defaults to now. */
  occurred_at?: string;
  question_id?: string;
};

/** `chunk:123#L40`, `digest:4812`, `event:7`, `question:q_ab12`. */
export const EVIDENCE_RE = /^(digest|chunk|event|question):[A-Za-z0-9_]+(#\S+)?$/;
