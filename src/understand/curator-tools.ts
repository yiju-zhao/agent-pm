import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { execute } from '../domain/execute.ts';
import { OP_SCHEMAS } from '../domain/ops.ts';
import type { OpName } from '../domain/ops.ts';
import { ASK_COMMON_SHAPE, askUser, ChoiceOption, ConfirmOption, TextOption } from '../domain/questions.ts';
import { getProject } from '../domain/read.ts';
import type { DomainDeps, OpResult } from '../domain/types.ts';
import { renderProjectMarkdown } from './render.ts';
import type { ToolDef, ToolOutput } from './tool-def.ts';

/** The actor every curator write is filed under; the trust rules of the operation layer apply to it in full. */
export const CURATOR_ACTOR = 'ai:curator';

/**
 * One curator run's state, shared with its tools. `digestIds` is what the run may cite as evidence: the digests it was
 * handed. The tools count in `landedWrites` every call that came back `applied` or `proposed` (questions included),
 * so a failed run can tell whether replaying the batch would repeat writes. Once `closed` is set (the run returned)
 * every tool refuses, in case the SDK keeps calling after an abort it ignored.
 */
export type CuratorBatch = { digestIds: number[]; landedWrites?: number; closed?: boolean };

/** What every handler gets: the citable ids as a set, and the batch whose counter and flag it reads and updates. */
type RunState = { ids: ReadonlySet<number>; batch: CuratorBatch };

const ENDED: ToolOutput = { text: 'this curate run has ended', isError: true };

/** Counts a call that changed state; a rejection did not. */
function landed(run: RunState, result: OpResult): OpResult {
  if (result.status !== 'rejected') run.batch.landedWrites = (run.batch.landedWrites ?? 0) + 1;
  return result;
}

// ---- results -----------------------------------------------------------------------------------------------------

/** An `OpResult` as the model sees it; a rejection is a failed tool call. */
function resultOutput(result: OpResult): ToolOutput {
  return { text: JSON.stringify(result), isError: result.status === 'rejected' };
}

/** A refusal in the same shape as an operation's own rejection, so the model reads one format. */
function rejected(code: 'invalid' | 'missing_evidence', message: string): ToolOutput {
  return resultOutput({ status: 'rejected', code, message });
}

// ---- evidence ----------------------------------------------------------------------------------------------------

/** `digest:12`, `chunk:345#L40`; the id part is captured. Other kinds (event:, question:) are not checked here. */
const CHECKED_REF_RE = /^(digest|chunk):([^#]+)(?:#.*)?$/;
const ROW_ID_RE = /^[1-9]\d*$/;

type EvidenceCheck = { ok: true; occurredAt: string | undefined } | { ok: false; message: string };

/** The latest of the ISO-ish timestamps as an ISO instant; values that are null or not a time are skipped. */
function latestInstant(values: Array<string | null | undefined>): string | undefined {
  let best: number | undefined;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const ms = Date.parse(value);
    if (!Number.isNaN(ms) && (best === undefined || ms > best)) best = ms;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

/**
 * Checks that every `digest:<id>` is a digest of this batch and every `chunk:<id>` an existing chunk (event: and
 * question: references pass; `execute` validates their format). On success also gives the default `occurred_at`:
 * the latest `ts_end` of the cited digests, else of the cited chunks, else `undefined`.
 */
function checkEvidence(db: DatabaseSync, batch: ReadonlySet<number>, evidence: string[]): EvidenceCheck {
  const digestEnds: Array<string | null> = [];
  const chunkEnds: Array<string | null> = [];
  const problems: string[] = [];
  const digestEnd = db.prepare('SELECT ts_end FROM digests WHERE id = ?');
  const chunkEnd = db.prepare('SELECT ts_end FROM chunks WHERE id = ?');

  for (const ref of evidence) {
    const match = CHECKED_REF_RE.exec(ref);
    if (!match) continue;
    const [, kind, idText] = match;
    if (!ROW_ID_RE.test(idText)) {
      problems.push(`${ref} (${kind} ids are whole numbers)`);
      continue;
    }
    const id = Number(idText);
    if (kind === 'digest') {
      if (!batch.has(id)) {
        problems.push(`${ref} (not a digest of this batch)`);
        continue;
      }
      const found = digestEnd.get(id) as { ts_end: string | null } | undefined;
      if (found) digestEnds.push(found.ts_end);
    } else {
      const found = chunkEnd.get(id) as { ts_end: string | null } | undefined;
      if (!found) {
        problems.push(`${ref} (no such chunk)`);
        continue;
      }
      chunkEnds.push(found.ts_end);
    }
  }

  if (problems.length > 0) {
    const ids = [...batch].join(', ');
    return {
      ok: false,
      message: `evidence not usable: ${problems.join('; ')}. Cite only digests of this batch (ids ${ids || 'none'}) or existing chunks.`,
    };
  }
  return { ok: true, occurredAt: latestInstant(digestEnds) ?? latestInstant(chunkEnds) };
}

// ---- write tools -------------------------------------------------------------------------------------------------

/** What every write tool asks for on top of its operation's own fields. */
const WRITE_ENVELOPE = {
  reason: z.string().describe('one sentence: why you are doing this'),
  evidence: z
    .array(z.string())
    .min(1)
    .describe('digest:<id> of a digest in this batch, or chunk:<id> (optionally chunk:<id>#L<line>) of an existing chunk'),
  occurred_at: z
    .string()
    .optional()
    .describe('ISO-8601 UTC instant when it happened in the conversation; leave out to use the cited digests'),
};

const REMINDER = '必须同时给 reason（一句话原因）和 evidence（本批摘要 digest:<id> 或已有 chunk:<id>）。';

const WRITE_OPS = [
  {
    op: 'create_project',
    description: '新建项目（AI 只能建在 idea 阶段）。按优先级定义填好 priority。先看项目索引确认没有重复，用户删除过的项目不要重建。可用 from_session 同时关联 session。',
  },
  {
    op: 'update_project',
    description: '修改项目的 title、summary、why、done_criteria、priority（写在 fields 里，至少一项）。用户锁定的字段不会被直接改，而是变成给用户的确认题。',
  },
  {
    op: 'transition_stage',
    description: '推进项目阶段。移到 done、abandoned、merged、parked 时不会直接生效，而是变成给用户的确认题（返回 proposed）。merged 需要 merge_into。',
  },
  {
    op: 'upsert_milestone',
    description: '新增里程碑，或带 id 修改已有里程碑的 title、status（todo/doing/done）、position。',
  },
  {
    op: 'upsert_todo',
    description: '新增 todo，或带 id 修改已有 todo 的 title、status（todo/doing/done）、priority、milestone_id。只记对话里明确出现的事。',
  },
  {
    op: 'record_decision',
    description: '记录一条已经做出的决策（text）。只记对话里明确拍板的，不记讨论中的想法；decided_at 可选。',
  },
  {
    op: 'set_blocker',
    description: '新增阻塞（text、kind: user/external/technical），或带 id 修改已有阻塞。',
  },
  {
    op: 'clear_blocker',
    description: '把一条阻塞标记为已解决（需要 project 和阻塞 id）。只在对话里确认解决后使用。',
  },
  {
    op: 'link_session',
    description: '把一个 session 关联到项目（可带 milestone_id、summary、ts_start、ts_end、confidence）。用户取消过的关联不会被恢复。',
  },
  {
    op: 'ignore_session',
    description: '建议不再追踪某个 session（ignored: false 为恢复追踪）。这只是向用户提议，由用户确认后才生效。',
  },
] as const satisfies ReadonlyArray<{ op: OpName; description: string }>;

function writeTool(db: DatabaseSync, deps: DomainDeps, run: RunState, spec: (typeof WRITE_OPS)[number]): ToolDef {
  const { op } = spec;
  // Every entry of OP_SCHEMAS used here is a plain z.object(...).strict(), so its fields can be reused as they are.
  const input: z.ZodRawShape = { ...OP_SCHEMAS[op].shape, ...WRITE_ENVELOPE };
  // The SDK validates before calling the handler; tests and other callers do not, so the handler checks too.
  const schema = z.strictObject(input);
  return {
    name: op,
    description: `${spec.description}${REMINDER}`,
    input,
    handler: async (raw) => {
      if (run.batch.closed) return ENDED;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return rejected('invalid', `invalid arguments for ${op}: ${z.prettifyError(parsed.error)}`);
      const { reason, evidence, occurred_at, ...args } = parsed.data as {
        reason: string;
        evidence: string[];
        occurred_at?: string;
      } & Record<string, unknown>;

      const cited = checkEvidence(db, run.ids, evidence);
      if (!cited.ok) return rejected('missing_evidence', cited.message);
      return resultOutput(
        landed(
          run,
          execute(db, deps, { op, args, actor: CURATOR_ACTOR, reason, evidence, occurred_at: occurred_at ?? cited.occurredAt }),
        ),
      );
    },
  };
}

// ---- ask_user ----------------------------------------------------------------------------------------------------

/**
 * `AskUserInput` is a union over `kind`, but a tool's input has to be one flat shape, so every field of every kind sits
 * side by side here. `askUser` does the real validation, including which fields fit which kind.
 */
const ASK_INPUT = {
  kind: z.enum(['choice', 'text', 'confirm']),
  ...ASK_COMMON_SHAPE,
  options: z.array(ChoiceOption).optional().describe('kind=choice only: 2 to 6 options'),
  option: z.union([TextOption, ConfirmOption]).optional().describe('kind=text (needs text_arg) or kind=confirm only: the single option'),
  reason: z.string().optional().describe('why you are asking; not stored'),
};

const ASK_DESCRIPTION = [
  '向用户提一个问题，由用户在网页上回答；用于你拿不准、又不该自己决定的事（这个 session 属于哪个项目、是否新建项目等）。',
  'kind=choice 给 2 到 6 个 options；kind=text 或 confirm 给一个 option（text 要 text_arg，用户的输入填进去）。',
  '每个选项的 op 和 args 必须是一个合法操作；op 为 null 表示"什么都不做"。',
  '不能让用户移动项目到 done、abandoned、merged、parked，那类提议请直接调用 transition_stage。',
  '必须给 evidence（本批摘要 digest:<id> 或已有 chunk:<id>）；topic 相同的重复提问会合并。',
].join('');

function askTool(db: DatabaseSync, deps: DomainDeps, run: RunState): ToolDef {
  const schema = z.strictObject(ASK_INPUT);
  return {
    name: 'ask_user',
    description: ASK_DESCRIPTION,
    input: ASK_INPUT,
    handler: async (raw) => {
      if (run.batch.closed) return ENDED;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return rejected('invalid', `invalid arguments for ask_user: ${z.prettifyError(parsed.error)}`);
      const { reason: _reason, ...ask } = parsed.data;

      const cited = checkEvidence(db, run.ids, ask.evidence);
      if (!cited.ok) return rejected('missing_evidence', cited.message);
      return resultOutput(landed(run, askUser(db, deps, ask, CURATOR_ACTOR)));
    },
  };
}

// ---- get_project -------------------------------------------------------------------------------------------------

function getProjectTool(db: DatabaseSync, deps: DomainDeps, run: RunState): ToolDef {
  const input = { project_id: z.string().min(1) };
  const schema = z.strictObject(input);
  return {
    name: 'get_project',
    description:
      '只读：取一个项目的完整 Markdown（阶段、里程碑、todo、决策、阻塞、关联 session、用户删除过的内容、最近事件）。动手改一个项目前先看一眼，避免重复添加。',
    input,
    handler: async (raw) => {
      if (run.batch.closed) return ENDED;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { text: `invalid arguments for get_project: ${z.prettifyError(parsed.error)}`, isError: true };
      const project = getProject(db, deps.now(), parsed.data.project_id);
      if (project === null) return { text: `project ${parsed.data.project_id} not found`, isError: true };
      return { text: renderProjectMarkdown(project) };
    },
  };
}

// ---- the set -----------------------------------------------------------------------------------------------------

/**
 * The tools one curator run gets: the write tools of spec section 11 (each a thin wrapper over `execute` as
 * `ai:curator`), `ask_user` and a read-only `get_project`. There is deliberately no `unlock_field`, `revert_event`,
 * `delete_*` or `unlink_session`. Evidence may only cite digests in `batch` and chunks that exist. The tools update
 * `batch.landedWrites` and stop working once `batch.closed` is set (see `CuratorBatch`).
 */
export function curatorTools(db: DatabaseSync, deps: DomainDeps, batch: CuratorBatch): ToolDef[] {
  const run: RunState = { ids: new Set(batch.digestIds), batch };
  return [...WRITE_OPS.map((spec) => writeTool(db, deps, run, spec)), askTool(db, deps, run), getProjectTool(db, deps, run)];
}
