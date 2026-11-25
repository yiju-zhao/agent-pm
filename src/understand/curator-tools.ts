import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { parseAddress, ContextAddressError } from '../context/address.ts';
import { resolveSession } from '../context/read.ts';
import { execute } from '../domain/execute.ts';
import { OP_SCHEMAS } from '../domain/ops.ts';
import type { OpName } from '../domain/ops.ts';
import { sessionProjectName, titleUsesName } from '../domain/project-names.ts';
import { ASK_COMMON_SHAPE, askUser, AskUserInput, ChoiceOption, ConfirmOption, shapeAiQuestion, TextOption } from '../domain/questions.ts';
import { getProject, listProjects } from '../domain/read.ts';
import type { DomainDeps, OpResult } from '../domain/types.ts';
import { sessionTools } from '../mcp/context-tools.ts';
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
type RunState = { inspected: Set<string>; ids: ReadonlySet<number>; batch: CuratorBatch };

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
    if (ref.startsWith('s:')) {
      try {
        const address = parseAddress(ref);
        if (address.kind !== 'turn') return { ok: false, message: '需要回合地址' };
        const { key } = resolveSession(db, address.session);
        const turn = db.prepare('SELECT ts_end FROM turns WHERE session_key=? AND n=?').get(key, address.turn);
        if (!turn) return { ok: false, message: `找不到回合 ${ref}` };
        chunkEnds.push(turn.ts_end as string | null);
      } catch (error) {
        if (error instanceof ContextAddressError) return { ok: false, message: error.message };
        throw error;
      }
      continue;
    }
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
    .describe('Prefer a source turn address s:<short>#<n>, a digest:<id> in this batch, or an existing chunk:<id>'),
  occurred_at: z
    .string()
    .optional()
    .describe('ISO-8601 UTC instant when it happened in the conversation; leave out to use the cited digests'),
};

const REMINDER = '必须同时给 reason（一句话原因）和 evidence（优先用 s:<短ID>#<回合>，也可用本批摘要 digest:<id> 或已有 chunk:<id>）。';

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
    description: '新增阻塞（text、kind: user/external/technical），或带 id 修改已有阻塞。阻塞只记真正卡住项目推进、且对话结束时仍未解决的事；进度说明、待验证事项、要修的 bug 记成 todo。kind=user 用于 session 在等用户回复、拍板或动手的事（会作为提醒显示给用户），text 写清等的是什么。先看项目已有的阻塞，不重复记录。',
  },
  {
    op: 'clear_blocker',
    description: '把一条阻塞标记为已解决（需要 project 和阻塞 id）。对话显示它已解决或已不成立时就使用，不要让过时的阻塞留着。',
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

/** `create_project` also takes the reason a title departs from the session's project name (see `namingRefusal`). */
const NAMING_ENVELOPE = {
  name_reason: z
    .string()
    .optional()
    .describe('只在标题不以 session 所在项目名开头、或该项目名下已有看板项目时填写：为什么这是一个独立的新目标、为什么要换名字'),
};

/**
 * Why a new project must not be created as asked, or null. A project is long-lived work named after the Paseo project
 * (or folder) its session works in: the title starts with that name, and a second board project under the same name
 * needs a stated reason (an independent goal in the same repository), since it is far more often the same work again.
 */
function namingRefusal(db: DatabaseSync, deps: DomainDeps, args: { title: string; from_session?: string }, nameReason: string | undefined): string | null {
  if (nameReason?.trim()) return null;
  const name = args.from_session ? sessionProjectName(db, args.from_session) : null;
  if (name === null) return null;
  if (!titleUsesName(args.title, name)) {
    return `项目标题应以 session 所在项目名「${name}」开头（例如「${name}」或「${name}：<独立目标>」）。如果对话内容确实与「${name}」无关，填写 name_reason 说明。`;
  }
  const same = listProjects(db, deps.now(), {}).filter((p) => !p.closed && titleUsesName(p.title, name));
  if (same.length > 0) {
    return `看板上已有以「${name}」命名的项目：${same.map((p) => `${p.id}「${p.title}」`).join('、')}。同一个项目的工作请用 link_session 关联过去；只有这是该仓库里一个可独立验收的新目标时，才填写 name_reason 说明后新建。`;
  }
  return null;
}

function writeTool(db: DatabaseSync, deps: DomainDeps, run: RunState, spec: { op: OpName; description: string }): ToolDef {
  const { op } = spec;
  // Every entry of OP_SCHEMAS used here is a plain z.object(...).strict(), so its fields can be reused as they are.
  const input: z.ZodRawShape = { ...OP_SCHEMAS[op].shape, ...WRITE_ENVELOPE, ...(op === 'create_project' ? NAMING_ENVELOPE : {}) };
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
      const { reason: given, evidence, occurred_at, name_reason, ...args } = parsed.data as {
        reason: string;
        evidence: string[];
        occurred_at?: string;
        name_reason?: string;
      } & Record<string, unknown>;

      const cited = checkEvidence(db, run.ids, evidence);
      if (!cited.ok) return rejected('missing_evidence', cited.message);
      if (op === 'mark_checked' && (!run.inspected.has(String(args.ref)) || !evidence.includes(String(args.ref)))) {
        return rejected('missing_evidence', '先用 get_turn 核实该回合，并在 evidence 中引用它');
      }
      if (op === 'create_project') {
        const refusal = namingRefusal(db, deps, args as { title: string; from_session?: string }, name_reason);
        if (refusal !== null) return rejected('invalid', refusal);
      }
      const reason = name_reason ? `${given}（命名：${name_reason}）` : given;
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
  '就看板本身的事向用户提一个必须由用户拍板的问题（why_user=user_authority），例如两个项目是否其实是同一个、项目阶段、用户锁定的内容。',
  'agent-pm 只读 agent 的工作，在这里的回答到不了 agent：session 里的工作问题（指示冲突、风险、缺少信息、等用户回复或动手）不要问，用 set_blocker kind=user 记下，它会作为提醒显示给用户，并随进展自动消失。',
  'session 属于哪个项目、要不要新建项目由你自己决定，不要问（这类问题会被拒绝）。',
  'context 用一两句说清发生了什么；prompt 只写问题本身，一句话。能问是/否就用 kind=confirm（给一个 option，系统自动加"拒绝"）；',
  '多选用 kind=choice，最多 4 个 options，每个写 detail 说明选它会怎样；只有缺事实时才用 kind=text（要 text_arg，用户的输入填进去）。',
  '给出 recommended（你建议的选项序号；confirm 里 0 是"是"、1 是"否"）和 recommend_reason。',
  '每个选项的 op 和 args 必须是一个合法操作；op 为 null 表示"什么都不做"。',
  '不能让用户移动项目到 done、abandoned、merged、parked，那类提议请直接调用 transition_stage。',
  '必须给 evidence（优先用 s:<短ID>#<回合>，也可用本批摘要 digest:<id> 或已有 chunk:<id>）；topic 相同的重复提问会合并。',
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
      const input = AskUserInput.safeParse(ask);
      if (!input.success) return rejected('invalid', `invalid arguments for ask_user: ${z.prettifyError(input.error)}`);
      const shaped = shapeAiQuestion(input.data);
      if (!shaped.ok) return rejected('invalid', shaped.message);
      return resultOutput(landed(run, askUser(db, deps, shaped.ask, CURATOR_ACTOR)));
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
export function curatorTools(db: DatabaseSync, deps: DomainDeps, batch: CuratorBatch, opts: { reconcile?: boolean } = {}): ToolDef[] {
  const run: RunState = { inspected: new Set(), ids: new Set(batch.digestIds), batch };
  const writes: Array<{ op: OpName; description: string }> = [
    ...WRITE_OPS,
    { op: 'mark_checked', description: '用 get_turn 核实条目后记录核对时间与回合依据。' },
  ];
  if (opts.reconcile) for (const op of ['delete_todo','delete_milestone','delete_decision','delete_blocker'] as const) {
    writes.push({ op, description: '项目重新整理时去掉重复或已失效的条目；用户创建或编辑过的条目仍须用户确认，不能用删除伪造完成。' });
  }
  const reads = sessionTools(db, deps, true, run.inspected).map(tool => ({
    ...tool,
    handler: async (args: Record<string, unknown>) => batch.closed ? ENDED : tool.handler(args),
  }));
  return [...writes.map((spec) => writeTool(db, deps, run, spec)), askTool(db, deps, run), getProjectTool(db, deps, run), ...reads];
}
