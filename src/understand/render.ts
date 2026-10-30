import type {
  BlockerRow,
  DecisionRow,
  EventView,
  ItemStatus,
  ProjectCard,
  ProjectDetail,
  SessionTag,
  TodoRow,
} from '../domain/read.ts';
import { STAGE_LABEL } from '../domain/types.ts';

/** Open todos the brief lists; the rest are counted. */
export const BRIEF_TODOS = 10;
/** Decisions the brief lists, newest first. */
export const BRIEF_DECISIONS = 5;
/** Events the full view lists, newest first. */
export const MARKDOWN_EVENTS = 20;
/** Characters of a summary the index line keeps. */
export const INDEX_SUMMARY_CHARS = 80;

const ITEM_STATUS_LABEL: Record<ItemStatus, string> = { todo: '待做', doing: '进行中', done: '已完成' };
const BLOCKER_KIND_LABEL: Record<BlockerRow['kind'], string> = {
  user: '等用户',
  external: '外部依赖',
  technical: '技术问题',
};

// ---- small helpers -----------------------------------------------------------------------------------------------

/** Whitespace runs, line breaks included, become one space, so a list item stays on its line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function present(text: string | null): text is string {
  return text !== null && text.trim() !== '';
}

/** `2026-10-29T12:00:00.000Z` as `2026-10-29`. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/** `2026-10-29T12:00:00.000Z` as `2026-10-29 12:00` (UTC). */
function minute(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/** A `## title` block preceded by a blank line, or nothing when it has no lines. */
function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ['', `## ${title}`, ...lines];
}

// ---- lines -------------------------------------------------------------------------------------------------------

function todoLine(todo: TodoRow): string {
  const parts = [todo.id, oneLine(todo.title), ITEM_STATUS_LABEL[todo.status]];
  if (todo.priority !== null) parts.push(todo.priority);
  return `- ${parts.join(' · ')}`;
}

function blockerLine(blocker: BlockerRow): string {
  return `- ${[blocker.id, oneLine(blocker.text), BLOCKER_KIND_LABEL[blocker.kind]].join(' · ')}`;
}

function decisionLines(decision: DecisionRow, withEvidence: boolean): string[] {
  const line = `- ${[decision.id, day(decision.decided_at), oneLine(decision.text)].join(' · ')}`;
  return withEvidence && decision.evidence.length > 0 ? [line, `  证据：${decision.evidence.join(', ')}`] : [line];
}

function sessionText(session: SessionTag): string {
  return [session.short_id, session.machine, session.agent_kind].join(' · ');
}

function contributionLine(c: ProjectDetail['contributions'][number]): string {
  const parts = [c.id, c.session ? sessionText(c.session) : c.session_key];
  if (c.milestone_id !== null) parts.push(`里程碑 ${c.milestone_id}`);
  if (c.ts_start !== null || c.ts_end !== null) {
    parts.push(`${c.ts_start === null ? '' : minute(c.ts_start)} ~ ${c.ts_end === null ? '' : minute(c.ts_end)}`.trim());
  }
  if (present(c.summary)) parts.push(oneLine(c.summary));
  return `- ${parts.join(' · ')}`;
}

function eventLine(e: EventView): string {
  const parts = [`#${e.id}`, minute(e.occurred_at), e.actor, e.op];
  if (e.entity !== null) parts.push(e.entity);
  if (present(e.reason)) parts.push(oneLine(e.reason));
  const marks = (e.reverted_by !== null ? '（已被撤销）' : '') + (e.reverts !== null ? `（撤销 #${e.reverts}）` : '');
  return `- ${parts.join(' · ')}${marks}`;
}

/** The project's own fields, then its current milestone. Empty fields are left out. */
function headLines(p: ProjectDetail): string[] {
  const stage = [`阶段：${STAGE_LABEL[p.stage]}`];
  if (p.priority !== null) stage.push(`优先级：${p.priority}`);
  if (p.merged_into !== null) stage.push(`已合并到：${p.merged_into}`);

  const lines = [`# ${oneLine(p.title)}`, `ID：${p.id}`, stage.join(' · ')];
  if (present(p.summary)) lines.push(`一句话：${p.summary}`);
  if (present(p.why)) lines.push(`为什么：${p.why}`);
  if (present(p.done_criteria)) lines.push(`完成标准：${p.done_criteria}`);
  if (p.current_milestone !== null) {
    const m = p.current_milestone;
    lines.push(`当前里程碑：${m.id} · ${oneLine(m.title)}（${ITEM_STATUS_LABEL[m.status]}）`);
  }
  return lines;
}

// ---- renderers ---------------------------------------------------------------------------------------------------

/**
 * What an agent needs to start work on a project: its fields, the current milestone, up to 10 open todos, unresolved
 * blockers, the 5 latest decisions and the sessions working on it. A part with nothing in it is left out.
 */
export function renderBrief(p: ProjectDetail): string {
  const todos = p.open_todos.slice(0, BRIEF_TODOS).map(todoLine);
  if (p.open_todos.length > BRIEF_TODOS) todos.push(`- …另有 ${p.open_todos.length - BRIEF_TODOS} 条未列出`);

  return [
    ...headLines(p),
    ...section('未完成 todo', todos),
    ...section('未解决阻塞', p.open_blockers.map(blockerLine)),
    ...section('最近决策', p.decisions.slice(0, BRIEF_DECISIONS).flatMap((d) => decisionLines(d, false))),
    ...section('活跃 session', p.active_sessions.map((s) => `- ${sessionText(s)}`)),
  ].join('\n');
}

/**
 * The whole project as Markdown: what the brief says, with every milestone, todo (done ones too) and decision (with its
 * evidence) in place of the brief's short lists, then the links to sessions, what the user deleted, and the 20 latest events.
 */
export function renderProjectMarkdown(p: ProjectDetail): string {
  return [
    ...headLines(p),
    ...section(
      '里程碑',
      p.milestones.map((m) => `- ${[m.id, oneLine(m.title), ITEM_STATUS_LABEL[m.status]].join(' · ')}`),
    ),
    ...section('todo', p.todos.map(todoLine)),
    ...section('未解决阻塞', p.open_blockers.map(blockerLine)),
    ...section('决策', p.decisions.flatMap((d) => decisionLines(d, true))),
    ...section('活跃 session', p.active_sessions.map((s) => `- ${sessionText(s)}`)),
    ...section('贡献记录', p.contributions.map(contributionLine)),
    ...section(
      '用户删除过（不要重建）',
      p.tombstones.map((x) => `- ${x.table}:${x.id} · ${oneLine(x.label)} · ${day(x.deleted_at)}`),
    ),
    ...section('最近事件', p.events.slice(0, MARKDOWN_EVENTS).map(eventLine)),
  ].join('\n');
}

/**
 * One line per card, for the digester to guess which project a conversation belongs to and the curator to avoid
 * duplicates. The caller decides which cards to pass; the first field is the id.
 */
export function renderProjectIndex(cards: ProjectCard[]): string {
  return cards
    .map((c) => {
      const summary = present(c.summary) ? oneLine(c.summary) : '-';
      const chars = Array.from(summary);
      const cut = chars.length > INDEX_SUMMARY_CHARS ? `${chars.slice(0, INDEX_SUMMARY_CHARS).join('')}…` : summary;
      return `- ${[c.id, oneLine(c.title), STAGE_LABEL[c.stage], c.priority ?? '-', cut].join(' · ')}`;
    })
    .join('\n');
}
