import { readLocks } from './changes.ts';
import type { Row } from './changes.ts';
import type { OpContext } from './execute.ts';
import type { OpName } from './ops.ts';
import { confirmOptions } from './questions.ts';
import type { Guard } from './questions.ts';

const FIELD_NAME: Record<string, string> = { title: '标题', summary: '简介', why: '为什么', done_criteria: '完成标准', priority: '优先级', status: '状态', position: '顺序', milestone_id: '所属里程碑' };

const STATUS_NAME: Record<string, string> = { todo: '待做', doing: '进行中', done: '完成' };

function short(key: string, value: FieldValue): string {
  const text = value === null ? '（空）' : key === 'status' ? (STATUS_NAME[String(value)] ?? String(value)) : String(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** A column value an operation can set. */
export type FieldValue = string | number | null;

/** The entries of `values` that are set (not `undefined`), in sorted key order. `null` counts as set. */
export function definedFields(values: Record<string, FieldValue | undefined>): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {};
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

/**
 * An AI's edit of `fields` on a lockable row: the fields the user has not locked are written; the locked ones whose
 * value would change become one confirm question (filed under `ctx.projectId`) that, once confirmed, runs
 * `confirm.op` as the user with `confirm.args(theLockedFieldsAndTheirNewValues)`. A locked field already holding the
 * proposed value asks nothing.
 */
export function applyAiFieldEdits(
  ctx: OpContext,
  table: 'projects' | 'milestones' | 'todos',
  row: Row,
  fields: Record<string, FieldValue>,
  confirm: { op: OpName; args: (proposed: Record<string, FieldValue>) => object },
): void {
  const id = String(row.id);
  const locked = new Set(readLocks(row));
  const direct: Record<string, FieldValue> = {};
  const proposed: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!locked.has(key)) direct[key] = value;
    else if (row[key] !== value) proposed[key] = value;
  }
  ctx.changes.update(table, id, direct);

  const keys = Object.keys(proposed).sort();
  if (keys.length === 0) return;
  ctx.propose({
    kind: 'confirm',
    prompt: `用 AI 的新内容替换你锁定的${keys.map((k) => FIELD_NAME[k] ?? k).join('、')}？`,
    context: `AI 的理由：${ctx.reason}`,
    why_user: 'user_authority',
    options: confirmOptions(confirm.op, confirm.args(proposed), keys.map((k) => `${FIELD_NAME[k] ?? k} → ${short(k, proposed[k])}`).join('；')),
    project_id: ctx.projectId,
    session_key: null,
    guards: keys.map((col): Guard => ({ table, id, col, equals: row[col] })),
    dedupe_key: `update:${table}:${id}:${keys.join(',')}`,
  });
}
