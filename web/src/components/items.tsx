import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { BlockerRow, ItemStatus, MilestoneRow, ProjectDetail, TodoRow } from '../../../src/domain/read.ts';
import { apiSend } from '../api.ts';
import { shortDate } from '../format.ts';
import { useWrite } from '../use-write.ts';
import type { Writer } from '../use-write.ts';
import { Fold, Section } from './blocks.tsx';
import { ConfirmButton } from './confirm-button.tsx';
import { EditableText } from './editable-text.tsx';
import { Icon } from './icon.tsx';
import { EvidenceLink } from './evidence-drawer.tsx';

type ListProps = { project: ProjectDetail; reload(): void };

// ---- shared pieces -----------------------------------------------------------------------------------------------

/** Milestones and todos change state in this order, round and round. */
const NEXT_STATUS: Record<ItemStatus, ItemStatus> = { todo: 'doing', doing: 'done', done: 'todo' };
const STATUS_ICON: Record<ItemStatus, string> = { done: '✓', doing: '◐', todo: '○' };
const STATUS_TEXT: Record<ItemStatus, string> = { todo: '未开始', doing: '进行中', done: '已完成' };

const projectPath = (project: ProjectDetail) => `/projects/${encodeURIComponent(project.id)}`;

/** The title of a milestone or todo, edited in place. */
function ItemTitle({ title, path, write }: { title: string; path: string; write: Writer['write'] }) {
  return <EditableText value={title} onSave={(value) => write(() => apiSend('PATCH', path, { title: value }))} />;
}

function DeleteButton({ path, fire }: { path: string; fire: Writer['fire'] }) {
  return <ConfirmButton label="删除" confirmLabel="确认删除" onConfirm={() => fire(() => apiSend('DELETE', path))} />;
}

/**
 * A text box with its button, for adding one more to a list. The text is cleared once the server took it and stays
 * (with the reason in a toast) when it did not. `extra` goes between the box and the button.
 */
function AddForm({ label, button, extra, onAdd }: { label: string; button: string; extra?: ReactNode; onAdd(text: string): Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const title = text.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (title === '' || busy) return;
    setBusy(true);
    try {
      await onAdd(title);
      setText('');
    } catch {
      // Already in the toast.
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-form" onSubmit={(e) => void submit(e)}>
      <input type="text" aria-label={label} placeholder={label} value={text} onChange={(e) => setText(e.target.value)} />
      {extra}
      <button type="submit" disabled={busy || title === ''}>
        {button}
      </button>
    </form>
  );
}

// ---- milestones --------------------------------------------------------------------------------------------------

function MilestoneItem({ milestone, base, writer }: { milestone: MilestoneRow; base: string; writer: Writer }) {
  const path = `${base}/milestones/${encodeURIComponent(milestone.id)}`;
  const { write, fire } = writer;
  const next = NEXT_STATUS[milestone.status];
  return (
    <li className={`item status-${milestone.status}`} data-milestone-id={milestone.id}>
      <button
        type="button"
        className="status-btn"
        title={`${STATUS_TEXT[milestone.status]}，点一下改成${STATUS_TEXT[next]}`}
        onClick={() => void fire(() => apiSend('PATCH', path, { status: next }))}
      >
        {STATUS_ICON[milestone.status]}
      </button>
      <ItemTitle title={milestone.title} path={path} write={write} />
      <DeleteButton path={path} fire={fire} />
    </li>
  );
}

export function MilestoneList({ project, reload }: ListProps) {
  const writer = useWrite(reload);
  const base = projectPath(project);
  return (
    <Section title="里程碑">
      {project.milestones.length === 0 ? (
        <div className="dim">还没有里程碑</div>
      ) : (
        <ul className="items">
          {project.milestones.map((m) => (
            <MilestoneItem key={m.id} milestone={m} base={base} writer={writer} />
          ))}
        </ul>
      )}
      <AddForm label="新里程碑" button="添加里程碑" onAdd={(title) => writer.write(() => apiSend('POST', `${base}/milestones`, { title }))} />
    </Section>
  );
}

// ---- todos -------------------------------------------------------------------------------------------------------

/**
 * The todos under their milestones, in the order of the milestones. A todo with no milestone, or whose milestone is
 * not in `milestones` any more, goes into the last group (`milestone: null`). A group without todos is left out.
 */
export function groupTodos(todos: TodoRow[], milestones: MilestoneRow[]): Array<{ milestone: MilestoneRow | null; todos: TodoRow[] }> {
  const ordered = [...milestones].sort((a, b) => a.position - b.position);
  const known = new Set(ordered.map((m) => m.id));
  const groups: Array<{ milestone: MilestoneRow | null; todos: TodoRow[] }> = ordered.map((milestone) => ({
    milestone,
    todos: todos.filter((t) => t.milestone_id === milestone.id),
  }));
  groups.push({ milestone: null, todos: todos.filter((t) => t.milestone_id === null || !known.has(t.milestone_id)) });
  return groups.filter((g) => g.todos.length > 0);
}

function TodoItem({ todo, base, writer }: { todo: TodoRow; base: string; writer: Writer }) {
  const path = `${base}/todos/${encodeURIComponent(todo.id)}`;
  const { write, fire } = writer;
  const box = useRef<HTMLInputElement>(null);
  const next = NEXT_STATUS[todo.status];

  // A checkbox has no half-checked attribute: that is a property of the element.
  useEffect(() => {
    if (box.current) box.current.indeterminate = todo.status === 'doing';
  });

  return (
    <li className={`item status-${todo.status}`} data-todo-id={todo.id}>
      <input
        ref={box}
        type="checkbox"
        aria-label={todo.title}
        title={`${STATUS_TEXT[todo.status]}，点一下改成${STATUS_TEXT[next]}`}
        checked={todo.status === 'done'}
        onChange={(e) => {
          // The click has already flipped the box; the page shows the real state again once the server has answered.
          e.currentTarget.indeterminate = todo.status === 'doing';
          void fire(() => apiSend('PATCH', path, { status: next }));
        }}
      />
      <ItemTitle title={todo.title} path={path} write={write} />
      <DeleteButton path={path} fire={fire} />
    </li>
  );
}

function TodoGroup({ group, base, writer }: { group: { milestone: MilestoneRow | null; todos: TodoRow[] }; base: string; writer: Writer }) {
  const id = useId();
  return (
    <div className="todo-group" role="group" aria-labelledby={id}>
      <div id={id} className="group-title">
        {group.milestone?.title ?? '未分组'}
      </div>
      <ul className="items">
        {group.todos.map((t) => (
          <TodoItem key={t.id} todo={t} base={base} writer={writer} />
        ))}
      </ul>
    </div>
  );
}

export function TodoList({ project, reload }: ListProps) {
  const writer = useWrite(reload);
  const base = projectPath(project);
  const groups = groupTodos(project.todos, project.milestones);
  const [picked, setPicked] = useState('');
  // A milestone that was picked and has been deleted since is no longer there to be picked.
  const milestone = project.milestones.some((m) => m.id === picked) ? picked : '';
  const choices = [...project.milestones].sort((a, b) => a.position - b.position);

  return (
    <Section title="Todo">
      {groups.length === 0 ? (
        <div className="dim">还没有 todo</div>
      ) : (
        groups.map((g) => <TodoGroup key={g.milestone?.id ?? ''} group={g} base={base} writer={writer} />)
      )}
      <AddForm
        label="新 todo"
        button="添加 todo"
        extra={
          <select aria-label="所属里程碑" value={milestone} onChange={(e) => setPicked(e.target.value)}>
            <option value="">未分组</option>
            {choices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        }
        onAdd={(title) => writer.write(() => apiSend('POST', `${base}/todos`, milestone === '' ? { title } : { title, milestone_id: milestone }))}
      />
    </Section>
  );
}

// ---- blockers ----------------------------------------------------------------------------------------------------

const KIND_LABEL: Record<BlockerRow['kind'], string> = { user: '等你', external: '外部', technical: '技术' };
const KINDS = ['user', 'external', 'technical'] as const;

function BlockerItem({ blocker, base, writer }: { blocker: BlockerRow; base: string; writer: Writer }) {
  const path = `${base}/blockers/${encodeURIComponent(blocker.id)}`;
  const open = blocker.status === 'open';
  return (
    <li className={open ? 'item blk' : 'item cleared'} data-blocker-id={blocker.id}>
      {open ? <Icon name="blocked" /> : null}
      <span className="blocker-text">{blocker.text}</span>
      <span className="tag">{KIND_LABEL[blocker.kind]}</span>
      {open ? (
        <button type="button" onClick={() => void writer.fire(() => apiSend('PATCH', path, { status: 'cleared' }))}>
          解除
        </button>
      ) : blocker.cleared_at !== null ? (
        <span className="dim">{`${shortDate(blocker.cleared_at)} 解除`}</span>
      ) : null}
      <DeleteButton path={path} fire={writer.fire} />
    </li>
  );
}

export function BlockerList({ project, reload }: ListProps) {
  const writer = useWrite(reload);
  const base = projectPath(project);
  const [kind, setKind] = useState<BlockerRow['kind']>('technical');
  const open = project.blockers.filter((b) => b.status === 'open');
  const cleared = project.blockers.filter((b) => b.status !== 'open');

  return (
    <Section title="阻塞">
      {open.length === 0 ? (
        <div className="dim">没有阻塞</div>
      ) : (
        <ul className="items">
          {open.map((b) => (
            <BlockerItem key={b.id} blocker={b} base={base} writer={writer} />
          ))}
        </ul>
      )}
      {cleared.length > 0 ? (
        <Fold label={`已解除（${cleared.length}）`}>
          <ul className="items">
            {cleared.map((b) => (
              <BlockerItem key={b.id} blocker={b} base={base} writer={writer} />
            ))}
          </ul>
        </Fold>
      ) : null}
      <AddForm
        label="新阻塞"
        button="添加阻塞"
        extra={
          <select aria-label="阻塞种类" value={kind} onChange={(e) => setKind(e.target.value as BlockerRow['kind'])}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        }
        onAdd={(text) => writer.write(() => apiSend('POST', `${base}/blockers`, { text, kind }))}
      />
    </Section>
  );
}

// ---- decisions ---------------------------------------------------------------------------------------------------

export function DecisionList({ project, reload }: ListProps) {
  const writer = useWrite(reload);
  const base = projectPath(project);
  return (
    <Section title="决策">
      {project.decisions.length === 0 ? (
        <div className="dim">还没有记录决策</div>
      ) : (
        <ul className="items">
          {project.decisions.map((d) => (
            <li key={d.id} className="item" data-decision-id={d.id}>
              <span className="dim">{shortDate(d.decided_at)}</span> <span className="blocker-text">{d.text}</span>
              {d.evidence.length > 0 ? (
                <span className="evidence">
                  {d.evidence.map((ref, index) => (
                    <EvidenceLink key={`${index}:${ref}`} evidence={ref} />
                  ))}
                </span>
              ) : null}
              <DeleteButton path={`${base}/decisions/${encodeURIComponent(d.id)}`} fire={writer.fire} />
            </li>
          ))}
        </ul>
      )}
      <AddForm label="新决策" button="记录决策" onAdd={(text) => writer.write(() => apiSend('POST', `${base}/decisions`, { text }))} />
    </Section>
  );
}
