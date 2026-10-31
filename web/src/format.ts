import type { QuestionOptionView } from '../../src/domain/read.ts';

// How the page words things the server reports as codes: session status, operation names, who did it, how long ago.

export const STATUS_LABEL: Record<string, string> = {
  working: '运行中',
  blocked: '等你操作',
  idle: '空闲',
  done: '已完成',
  unknown: '未知',
  offline: '离线',
  ended: '已结束',
  purged: '已清除',
};

/** The CSS class of a status dot: working, blocked and offline (hollow) have their own, everything else is idle grey. */
export function statusClass(status: string): string {
  switch (status) {
    case 'working':
      return 'dot-working';
    case 'blocked':
      return 'dot-blocked';
    case 'offline':
      return 'dot-offline';
    default:
      return 'dot-idle';
  }
}

// One entry per key of OP_SCHEMAS (src/domain/ops.ts); tests/web/format.test.ts fails when an operation is missing.
export const OP_LABEL: Record<string, string> = {
  create_project: '新建项目',
  update_project: '修改项目',
  transition_stage: '改阶段',
  unlock_field: '解锁字段',
  upsert_milestone: '编辑里程碑',
  upsert_todo: '编辑 todo',
  record_decision: '记录决策',
  set_blocker: '设置阻塞',
  delete_milestone: '删除里程碑',
  delete_todo: '删除 todo',
  delete_decision: '删除决策',
  delete_blocker: '删除阻塞',
  clear_blocker: '解除阻塞',
  link_session: '关联 session',
  unlink_session: '取消关联',
  ignore_session: '不追踪 session',
  revert_event: '撤销',
};

/** The Chinese name of an operation; one we have no name for is shown as the server wrote it. */
export function opLabel(op: string): string {
  return Object.hasOwn(OP_LABEL, op) ? OP_LABEL[op] : op;
}

export function actorLabel(actor: string): string {
  if (actor === 'user') return '你';
  if (actor === 'ai:curator') return 'AI 整理员';
  if (actor.startsWith('ai:')) {
    const name = actor.slice(3);
    return name === '' ? 'AI' : `AI（${name}）`;
  }
  return actor;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `刚刚`, `N 分钟前`, `N 小时前`, `N 天前`, and from 30 days on the date `MM/DD`. Text that is not a time is returned as it is. */
export function relTime(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
}

/** `MM/DD HH:mm` in the browser's time zone. Text that is not a time is returned as it is. */
export function shortTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** `MM/DD` in the browser's time zone. Text that is not a time is returned as it is. */
export function shortDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
}

const MAX_ARG_CHARS = 40;

function argText(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  // Counted in characters, so an emoji is not cut in half.
  const chars = Array.from(text);
  return chars.length > MAX_ARG_CHARS ? `${chars.slice(0, MAX_ARG_CHARS).join('')}…` : text;
}

/** What answering with this option would do, in words: the operation and its arguments, or that it does nothing. */
export function describeOption(o: QuestionOptionView): string {
  if (!o.has_op || o.op === null) return '不做任何操作';
  const args = Object.entries(o.args ?? {}).map(([key, value]) => `${key}=${argText(value)}`);
  const text = [opLabel(o.op), ...args].join(' ');
  return o.text_arg === undefined ? text : `${text}（填入 ${o.text_arg}）`;
}

/**
 * `text` cut to at most `max` characters by leaving out the middle (`/Users/eas…/herdr-pm-web`): the start says where
 * it is and the end says what it is, and a path needs both. Counted in characters, so nothing is cut in half.
 */
export function middleEllipsis(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const room = Math.max(max - 1, 0);
  const head = Math.ceil(room * 0.4);
  const tail = room - head;
  return `${chars.slice(0, head).join('')}…${tail === 0 ? '' : chars.slice(-tail).join('')}`;
}
