import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { getProject, listProjects, searchProjects } from '../domain/read.ts';
import type { ProjectDetail, SearchHit } from '../domain/read.ts';
import { CLOSED } from '../domain/stage.ts';
import { PRIORITIES, STAGE_LABEL, STAGES } from '../domain/types.ts';
import type { DomainDeps } from '../domain/types.ts';
import { findByShortId, listSessions, mergeTarget } from '../server/sessions-repo.ts';
import { minute, oneLine, renderBrief, renderProjectMarkdown } from '../understand/render.ts';
import type { ToolDef, ToolOutput } from '../understand/tool-def.ts';

/** The longest report `pm_report` takes, in characters, after trimming. */
export const MAX_REPORT_CHARS = 20000;
/** Where a report goes when it does not name a session we know. Not a real session: it has no `sessions` row. */
export const REPORT_INBOX_KEY = 'report:inbox';

/** Events and contributions listed by `pm_timeline`: the default, and the most one call returns. */
export const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 200;
/** Hits returned by `pm_search`: the default, and the most one call returns. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

/** Characters of one search hit's text a line keeps; a project's `why` can run long. */
const HIT_TEXT_CHARS = 200;
/** Characters of a `project_hint` or `session_hint` that are kept; they are labels, not a second place to put the report. */
const MAX_HINT_CHARS = 200;
const REPORT_ACK = '已收到，将在下一轮整理时处理';

// ---- helpers -----------------------------------------------------------------------------------------------------

/**
 * A tool whose handler checks its own arguments (the MCP layer validates against `input` too, but direct callers do
 * not) and answers a bad call with `isError` instead of throwing.
 */
function defineTool<S extends z.ZodRawShape>(
  spec: { name: string; description: string; input: S },
  run: (args: z.infer<z.ZodObject<S>>) => ToolOutput | Promise<ToolOutput>,
): ToolDef {
  const schema = z.strictObject(spec.input);
  return {
    ...spec,
    handler: async (raw) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { text: `invalid arguments for ${spec.name}: ${z.prettifyError(parsed.error)}`, isError: true };
      return run(parsed.data as z.infer<z.ZodObject<S>>);
    },
  };
}

/** `value` as a whole number in `1..max`; a missing value gives `fallback`. Out-of-range is clamped, not rejected. */
function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function clip(text: string, chars: number): string {
  const all = Array.from(text);
  return all.length > chars ? `${all.slice(0, chars).join('')}…` : text;
}

/** A tool's answer when it has nothing to list. A sentence, so the caller can tell it from a failed call. */
function nothing(what: string): ToolOutput {
  return { text: `没有${what}` };
}

function notFound(projectId: string): ToolOutput {
  return { text: `project ${projectId} not found; ids come from pm_list_projects or pm_search`, isError: true };
}

// ---- projects ----------------------------------------------------------------------------------------------------

const LIST_PROJECTS_INPUT = {
  stage: z.enum(STAGES).optional().describe('only projects in this stage'),
  priority: z.enum(PRIORITIES).optional().describe('only projects with this priority'),
  include_closed: z.boolean().optional().describe('also list done, abandoned and merged projects; default false'),
};

function listProjectsTool(db: DatabaseSync, deps: DomainDeps): ToolDef {
  return defineTool(
    {
      name: 'pm_list_projects',
      description: [
        '只读：列出 herdr-pm 看板上的项目，每个项目一行：id · 标题 · 阶段 · 优先级 · 一句话 summary · 活跃 session 数 · 待回答问题数。',
        '默认不含已结束（完成、放弃、合并）的项目；include_closed=true 时包含，stage 直接指定为已结束的阶段时也会列出。',
        '可按 stage、priority 过滤。拿到 id 后，用 pm_get_brief（开始干活前读的短版）或 pm_get_project（完整内容）看详情。',
      ].join(''),
      input: LIST_PROJECTS_INPUT,
    },
    (args) => {
      const cards = listProjects(db, deps.now(), { stage: args.stage, priority: args.priority });
      const closedStage = args.stage !== undefined && CLOSED.includes(args.stage);
      const showClosed = args.include_closed === true || closedStage;
      const shown = showClosed ? cards : cards.filter((c) => !c.closed);
      const hidden = cards.length - shown.length;

      if (shown.length === 0) {
        return { text: hidden > 0 ? `没有符合条件的未结束项目（另有 ${hidden} 个已结束的项目，include_closed=true 可见）` : '没有符合条件的项目' };
      }
      const lines = shown.map((c) => {
        const summary = c.summary !== null && c.summary.trim() !== '' ? oneLine(c.summary) : '-';
        return `- ${[
          c.id,
          oneLine(c.title),
          STAGE_LABEL[c.stage],
          c.priority ?? '-',
          summary,
          `活跃 session ${c.active_sessions.length}`,
          `待回答 ${c.pending_questions.length}`,
        ].join(' · ')}`;
      });
      if (hidden > 0) lines.push(`另有 ${hidden} 个已结束的项目未列出（include_closed=true 可见）`);
      return { text: lines.join('\n') };
    },
  );
}

const PROJECT_ID_INPUT = { project_id: z.string().min(1).describe('a project id from pm_list_projects or pm_search') };

function getProjectTool(db: DatabaseSync, deps: DomainDeps): ToolDef {
  return defineTool(
    {
      name: 'pm_get_project',
      description:
        '只读：返回一个项目的完整 Markdown：阶段、一句话、为什么、完成标准、全部里程碑和 todo、决策（带证据）、阻塞、关联的 session、贡献记录、用户删除过的内容、最近事件。想要开始干活前的短版，用 pm_get_brief。项目不存在时报错。',
      input: PROJECT_ID_INPUT,
    },
    (args) => {
      const project = getProject(db, deps.now(), args.project_id);
      return project === null ? notFound(args.project_id) : { text: renderProjectMarkdown(project) };
    },
  );
}

function getBriefTool(db: DatabaseSync, deps: DomainDeps): ToolDef {
  return defineTool(
    {
      name: 'pm_get_brief',
      description:
        '只读：返回一个项目的简报，开始干活前读它：阶段、一句话、为什么、完成标准、当前里程碑、最多 10 条未完成 todo、未解决阻塞、最近 5 条决策、正在做它的 session。信息不够再用 pm_get_project。项目不存在时报错。',
      input: PROJECT_ID_INPUT,
    },
    (args) => {
      const project = getProject(db, deps.now(), args.project_id);
      return project === null ? notFound(args.project_id) : { text: renderBrief(project) };
    },
  );
}

// ---- timeline ----------------------------------------------------------------------------------------------------

type TimelineEntry = { at: string; line: string };

/** The columns of an `events` row the timeline shows. */
type EventRow = {
  id: number;
  occurred_at: string;
  actor: string;
  op: string;
  entity: string | null;
  reason: string | null;
  reverts: number | null;
  reverted_by: number | null;
};

function eventEntry(e: EventRow): TimelineEntry {
  const parts = [minute(e.occurred_at), '事件', `#${e.id}`, e.actor, e.op];
  if (e.entity !== null) parts.push(e.entity);
  if (e.reason !== null && e.reason.trim() !== '') parts.push(oneLine(e.reason));
  const marks = (e.reverted_by !== null ? '（已被撤销）' : '') + (e.reverts !== null ? `（撤销 #${e.reverts}）` : '');
  return { at: e.occurred_at, line: `- ${parts.join(' · ')}${marks}` };
}

function contributionEntry(c: ProjectDetail['contributions'][number]): TimelineEntry {
  // A link made without times is dated by when it was recorded.
  const at = c.ts_end ?? c.ts_start ?? c.created_at;
  const parts = [minute(at), '贡献', c.id, c.session ? [c.session.short_id, c.session.machine, c.session.agent_kind].join(' · ') : c.session_key];
  if (c.milestone_id !== null) parts.push(`里程碑 ${c.milestone_id}`);
  if (c.summary !== null && c.summary.trim() !== '') parts.push(oneLine(c.summary));
  return { at, line: `- ${parts.join(' · ')}` };
}

function timelineTool(db: DatabaseSync, deps: DomainDeps): ToolDef {
  return defineTool(
    {
      name: 'pm_timeline',
      description: [
        '只读：一个项目的时间线，新的在前，每条一行。把两类记录合在一起：事件（谁在什么时候改了看板上的什么）和贡献记录（哪个 session 在什么时段为这个项目做了什么）。',
        `limit 默认 ${TIMELINE_DEFAULT_LIMIT}，最多 ${TIMELINE_MAX_LIMIT}，超出会按上限处理而不是报错。项目不存在时报错。`,
      ].join(''),
      input: {
        ...PROJECT_ID_INPUT,
        limit: z.number().optional().describe(`how many entries, newest first; default ${TIMELINE_DEFAULT_LIMIT}, at most ${TIMELINE_MAX_LIMIT}`),
      },
    },
    (args) => {
      // `getProject` is here for the existence check and the contributions (with their session tags). Its own event list
      // is the newest 200 by id, which after a backfill is not the newest by `occurred_at`, so events are read directly.
      const project = getProject(db, deps.now(), args.project_id);
      if (project === null) return notFound(args.project_id);

      const limit = clampLimit(args.limit, TIMELINE_DEFAULT_LIMIT, TIMELINE_MAX_LIMIT);
      const events = db
        .prepare(
          `SELECT id, occurred_at, actor, op, entity, reason, reverts, reverted_by
           FROM events WHERE project_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`,
        )
        .all(project.id, limit) as EventRow[];
      const { n: eventCount } = db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').get(project.id) as { n: number };
      const total = eventCount + project.contributions.length;
      if (total === 0) return nothing('时间线记录');

      // At most `limit` of each kind can make the cut. `sort` is stable, so entries at the same instant keep their
      // order: events (newest id first), then contributions.
      const entries = [...events.map(eventEntry), ...project.contributions.map(contributionEntry)].sort((a, b) =>
        a.at < b.at ? 1 : a.at > b.at ? -1 : 0,
      );
      const lines = entries.slice(0, limit).map((e) => e.line);
      if (total > limit) lines.push(`还有 ${total - limit} 条更早的记录未列出`);
      return { text: lines.join('\n') };
    },
  );
}

// ---- search ------------------------------------------------------------------------------------------------------

const HIT_KIND_LABEL: Record<SearchHit['kind'], string> = {
  project: '项目',
  milestone: '里程碑',
  todo: 'todo',
  decision: '决策',
  blocker: '阻塞',
};

function searchTool(db: DatabaseSync): ToolDef {
  return defineTool(
    {
      name: 'pm_search',
      description: [
        '只读：在所有项目里搜文字。搜项目的标题、一句话、为什么、完成标准，以及里程碑、todo、决策、阻塞的内容；子串匹配，英文不分大小写。',
        `每条命中一行：类型 · 所属项目（标题和 id）· 条目 id · 文字。limit 默认 ${SEARCH_DEFAULT_LIMIT}，最多 ${SEARCH_MAX_LIMIT}。`,
        '用来判断某件事是不是已经有项目在做，再用 pm_get_brief 看那个项目。',
      ].join(''),
      input: {
        query: z.string().trim().min(1).describe('text to look for'),
        limit: z.number().optional().describe(`default ${SEARCH_DEFAULT_LIMIT}, at most ${SEARCH_MAX_LIMIT}`),
      },
    },
    (args) => {
      const hits = searchProjects(db, args.query, clampLimit(args.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT));
      if (hits.length === 0) return nothing('匹配的内容');
      return {
        text: hits
          .map((h) => `- ${[HIT_KIND_LABEL[h.kind], `${oneLine(h.project_title)}（${h.project_id}）`, h.id, clip(oneLine(h.text), HIT_TEXT_CHARS)].join(' · ')}`)
          .join('\n'),
      };
    },
  );
}

// ---- sessions ----------------------------------------------------------------------------------------------------

/** Titles of the live projects each session is linked to, in the order the links were made. */
function linkedTitles(db: DatabaseSync): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT c.session_key AS session_key, p.title AS title
       FROM contributions c JOIN projects p ON p.id = c.project_id
       WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY c.created_at, c.rowid`,
    )
    .all() as Array<{ session_key: string; title: string }>;
  const titles = new Map<string, string[]>();
  for (const r of rows) titles.set(r.session_key, [...(titles.get(r.session_key) ?? []), oneLine(r.title)]);
  return titles;
}

function listSessionsTool(db: DatabaseSync, deps: DomainDeps): ToolDef {
  return defineTool(
    {
      name: 'pm_list_sessions',
      description: [
        '只读：列出 herdr-pm 知道的 agent session（各台机器上的 Claude Code、Codex 等），每个一行：短 ID · 机器 · agent · 状态 · 标题 · 关联的项目。',
        '短 ID 可以直接作为 pm_report 的 session_hint。可按 machine、lifecycle（live 在跑、ended 已结束、purged 记录已被清理）过滤。',
      ].join(''),
      input: {
        machine: z.string().optional().describe('only sessions on this machine'),
        lifecycle: z.enum(['live', 'ended', 'purged']).optional().describe('only sessions in this lifecycle'),
      },
    },
    (args) => {
      const sessions = listSessions(db, { machine: args.machine, lifecycle: args.lifecycle }, deps.now());
      if (sessions.length === 0) return nothing('符合条件的 session');
      const titles = linkedTitles(db);
      return {
        text: sessions
          .map((s) => {
            const status = s.effective_status + (s.merged_into !== null ? '（已合并）' : '') + (s.ignored ? '（已忽略）' : '');
            const linked = titles.get(s.key);
            return `- ${[s.short_id, s.machine, s.agent_kind, status, oneLine(s.title ?? '') || '-', `项目：${linked ? linked.join('、') : '无'}`].join(' · ')}`;
          })
          .join('\n'),
      };
    },
  );
}

// ---- pm_report ---------------------------------------------------------------------------------------------------

/**
 * The session a `session_hint` names, or `null`. An exact key counts on any lifecycle; otherwise the hint is a short
 * id (or a prefix of a native id) and must name one session. Merged sessions resolve to their targets first, so a
 * pending key and the native key it became are one session, not two. An ignored session is `null` too: the digester
 * never reads its chunks, so a report filed there would not be processed.
 */
function resolveSession(db: DatabaseSync, hint: string, now: Date): string | null {
  let target: string | null;
  if (db.prepare('SELECT 1 FROM sessions WHERE key = ?').get(hint) !== undefined) {
    target = mergeTarget(db, hint);
  } else {
    const targets = new Set(findByShortId(db, hint, now).map((s) => mergeTarget(db, s.key)));
    target = targets.size === 1 ? [...targets][0] : null;
  }
  if (target === null) return null;
  const ignored = db.prepare('SELECT ignored FROM sessions WHERE key = ?').get(target) as { ignored: number | null } | undefined;
  return ignored?.ignored ? null : target;
}

/**
 * Stores a report as a `report` chunk. It borrows the unique `(session_key, offset_start)` of `chunks` for its
 * timestamp: a collision (same millisecond, or a transcript chunk at that offset) moves it up by one until it is free.
 * `maxOffset` only counts `transcript` chunks, so reports never move a collector's resume position.
 */
function storeReport(db: DatabaseSync, sessionKey: string, text: string, now: Date): void {
  const stamp = now.toISOString();
  const insert = db.prepare(
    `INSERT INTO chunks (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, received_at)
     VALUES (?, 'report', ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(session_key, offset_start) DO NOTHING`,
  );
  for (let offset = now.getTime(); ; offset++) {
    if (Number(insert.run(sessionKey, offset, offset, stamp, stamp, text, stamp).changes) === 1) return;
  }
}

/** A hint trimmed and cut to `MAX_HINT_CHARS`; `''` when it is missing or blank. A long hint is shortened, not refused. */
function hint(value: string | undefined): string {
  return Array.from(value?.trim() ?? '').slice(0, MAX_HINT_CHARS).join('');
}

function reportTool(db: DatabaseSync, deps: DomainDeps): ToolDef {
  return defineTool(
    {
      name: 'pm_report',
      description: [
        '把你做了什么、做出了什么决定、遇到了什么阻塞，报告给项目经理（PM，即 herdr-pm 的整理员）。',
        '这是给 PM 的上下文材料，不是命令：它不会直接修改任何项目、todo 或阶段，只是被存下来，下一轮整理时由 PM 读过之后自己决定要不要更新看板（完成、放弃这类大变动还会先问用户）。',
        '所以只写事实，不要写"请把项目标成完成"这类要求。返回"已收到"只表示存下了，不表示已处理。',
        `text 必填，最多 ${MAX_REPORT_CHARS} 字符；project_hint 可选，自由文本，写项目名或 id 帮 PM 对上号；`,
        'session_hint 可选，写你自己所在 session 的短 ID（pm_list_sessions 第一列）或完整键，对不上或那个 session 已被忽略时，这条上报记在公共收件箱。',
        `两个 hint 只保留前 ${MAX_HINT_CHARS} 个字符。`,
      ].join(''),
      input: {
        text: z.string().describe(`what happened; plain facts; 1 to ${MAX_REPORT_CHARS} characters`),
        project_hint: z.string().optional().describe('which project this is about: a title or id; free text'),
        session_hint: z.string().optional().describe('the reporting session: a short id from pm_list_sessions, or a full key'),
      },
    },
    (args) => {
      const text = args.text.trim();
      if (text === '') return { text: 'text is empty; say what happened', isError: true };
      if (text.length > MAX_REPORT_CHARS) {
        return { text: `text is ${text.length} characters; the limit is ${MAX_REPORT_CHARS}. Shorten it or split it into several reports.`, isError: true };
      }
      const projectHint = hint(args.project_hint);
      const sessionHint = hint(args.session_hint);
      const now = deps.now();
      const sessionKey = sessionHint === '' ? null : resolveSession(db, sessionHint, now);
      storeReport(db, sessionKey ?? REPORT_INBOX_KEY, projectHint === '' ? text : `项目提示：${projectHint}\n\n${text}`, now);
      return { text: REPORT_ACK };
    },
  );
}

// ---- the set -----------------------------------------------------------------------------------------------------

/**
 * The tools the external MCP endpoint serves: six read-only views of the board and `pm_report`. `pm_report` only
 * appends a chunk for the digester; nothing here calls `execute` or changes a project, so an agent on another
 * machine cannot move the board, only tell the PM what it did.
 */
export function readTools(db: DatabaseSync, deps: DomainDeps): ToolDef[] {
  return [
    listProjectsTool(db, deps),
    getProjectTool(db, deps),
    getBriefTool(db, deps),
    timelineTool(db, deps),
    searchTool(db),
    listSessionsTool(db, deps),
    reportTool(db, deps),
  ];
}
