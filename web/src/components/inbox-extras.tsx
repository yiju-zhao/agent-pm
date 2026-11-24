import { useMemo, useState } from 'react';
import type { ProjectCard, QuestionView } from '../../../src/domain/read.ts';
import { apiSend, errorText } from '../api.ts';
import { relTime } from '../format.ts';
import { useApi } from '../use-api.ts';
import { useNow } from '../use-now.ts';
import { useWrite } from '../use-write.ts';
import { Dialog } from './dialog.tsx';
import { projectHref } from './project-card.tsx';

// Two things the user only checks, never has to answer: what the AI decided on its own (each can be taken back), and
// projects that look like one piece of work (one yes/no per Paseo project: combine them, or say they are separate).

const AUTO_SHOWN = 20;

/** Questions an automatic decider answered, newest first, with what it chose, how sure it was, and an undo. */
export function AutoDecisions() {
  const answered = useApi<QuestionView[]>('/questions?status=answered', ['questions']);
  const now = useNow();
  const [undone, setUndone] = useState<Set<number>>(new Set());
  const { fire } = useWrite(answered.reload);
  const auto = (answered.data ?? []).filter((q) => q.auto !== null).slice(0, AUTO_SHOWN);
  if (auto.length === 0) return null;
  const undo = (eventId: number) => fire(async () => {
    await apiSend('POST', `/events/${eventId}/revert`);
    setUndone((s) => new Set(s).add(eventId));
  });
  return (
    <section className="inbox-section auto-decisions" aria-label="AI 已自动决定">
      <h3>{`AI 已自动决定 · ${auto.length}`}</h3>
      <p className="dim">这些问题的答案在证据里已经很明确，没有打扰你。不同意可以撤销。</p>
      <ul className="auto-list">
        {auto.map((q) => {
          const a = q.auto!;
          const chosen = q.kind === 'confirm' ? (a.option_index === 0 ? '是' : '否') : q.options[a.option_index]?.label ?? `选项 ${a.option_index + 1}`;
          return (
            <li key={q.id}>
              <span className="auto-q">{q.prompt}</span>
              <span className="auto-line">
                <span className="auto-a">{`→ ${chosen}`}</span>
                <span className="auto-meta">{`${a.decider} · 置信度 ${Math.round(a.confidence * 100)}% · ${relTime(q.created_at, now)}`}</span>
              </span>
              <span className="auto-reason dim">{a.reason}</span>
              {a.event_id !== null ? (
                undone.has(a.event_id) ? <span className="auto-undo dim">已撤销</span> : <button type="button" className="auto-undo" onClick={() => void undo(a.event_id!)}>撤销</button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const DISMISSED_KEY = 'agent-pm.notSameProject';

function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** The name a project is filed under: its title up to the first separator, so `open-evo：RSI 流水线` is `open-evo`. */
export function projectAnchor(title: string): string {
  return title.split(/[：:（(]/)[0]!.trim().toLowerCase();
}

/** The project a card belongs to in Paseo: its title's name when that is one of its sessions' projects, else the most used. */
function primaryName(c: ProjectCard): string {
  const anchor = projectAnchor(c.title);
  const names = c.project_names.map((n) => n.toLowerCase());
  if (names.includes(anchor)) return anchor;
  return names[0] ?? anchor;
}

export type SameNameGroup = {
  /** The Paseo project (or name) they share, as written. */
  name: string;
  /** The open project already named exactly that, which the others join; null: a new one is created. */
  target: ProjectCard | null;
  /** The projects that would be merged into it. */
  members: ProjectCard[];
};

/**
 * Open projects that belong to the same Paseo project: a project is long-lived work, so several board projects under
 * one Paseo project are usually tasks of one. Each group joins the project named exactly that name, or a new one.
 */
export function sameNameGroups(cards: ProjectCard[]): SameNameGroup[] {
  const groups = new Map<string, ProjectCard[]>();
  for (const c of cards.filter((c) => !c.closed)) {
    const key = primaryName(c);
    if (key !== '') groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: SameNameGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const written = list.flatMap((c) => c.project_names).find((n) => n.toLowerCase() === key) ?? key;
    const target = list.find((c) => c.title.trim().toLowerCase() === key) ?? null;
    out.push({ name: written, target, members: list.filter((c) => c !== target) });
  }
  return out.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
}

/** Confirms, then does, a group merge: the target is created if needed, then each chosen project moves into it whole. */
function GroupMerge({ group, onClose, reload }: { group: SameNameGroup; onClose(): void; reload(): void }) {
  const [chosen, setChosen] = useState<string[]>(group.members.map((m) => m.id));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const target = group.target?.id ?? (await apiSend<{ id: string }>('POST', '/projects', { title: group.name, stage: 'build' })).id;
      for (const id of chosen) {
        await apiSend('POST', `/projects/${encodeURIComponent(id)}/stage`, { stage: 'merged', merge_into: target });
        setDone((d) => [...d, id]);
      }
      reload();
      onClose();
    } catch (err) {
      setError(`合并到一半停下了：${errorText(err)}。已完成的部分可在事件记录里逐条撤销。`);
      reload();
    }
    setBusy(false);
  };
  return (
    <Dialog title="合并为一个项目" className="merge-dialog" onClose={onClose} locked={busy}>
      <header className="merge-head"><h2>{`合并为「${group.name}」`}</h2></header>
      <p className="merge-summary">{group.target ? `并入已有项目「${group.target.title}」` : `新建项目「${group.name}」（构建阶段），把下面勾选的项目并进去`}</p>
      <ul className="merge-sessions">
        {group.members.map((m) => (
          <li key={m.id}>
            <label className={chosen.includes(m.id) ? 'merge-session on' : 'merge-session'}>
              <input type="checkbox" checked={chosen.includes(m.id)} disabled={busy} onChange={() => setChosen((c) => (c.includes(m.id) ? c.filter((x) => x !== m.id) : [...c, m.id]))} />
              <span>
                <span className="merge-session-name">{m.title}{done.includes(m.id) ? ' ✓' : ''}</span>
                <span className="dim">{`${m.stage} · ${m.active_sessions.length} 个活跃 session · ${m.open_todos.length} 个 todo`}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <ul className="merge-effects">
        <li>每个勾选的项目整体并入：它的全部 session 关联过去，原项目标记为「已合并」，里程碑、todo、决策留在原处可查看。</li>
        <li>会话原文、证据、历史事件不变；每个合并是一条事件，可在事件记录里撤销。</li>
        <li>完成后整理员会根据所有 session 的内容重写「{group.name}」的简介、里程碑和 todo；改你锁定的内容前仍会先问你。</li>
      </ul>
      {error ? <p role="alert" className="merge-callout is-bad">{error}</p> : null}
      <form className="modal-actions" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <button type="submit" disabled={busy || chosen.length === 0}>{`确认合并 ${chosen.length} 个项目`}</button>
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
      </form>
    </Dialog>
  );
}

/** One yes/no per Paseo project that has several board projects. */
export function SameNameProjects({ cards, reload }: { cards: ProjectCard[]; reload(): void }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [merging, setMerging] = useState<SameNameGroup | null>(null);
  const groups = useMemo(() => sameNameGroups(cards).filter((g) => !dismissed.has(g.name.toLowerCase())), [cards, dismissed]);
  if (groups.length === 0 && merging === null) return null;
  const dismiss = (name: string) => {
    const next = new Set(dismissed).add(name.toLowerCase());
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
    } catch {
      // Only remembering it is lost.
    }
  };
  return (
    <section className="inbox-section same-name" aria-label="可能是同一个项目">
      <h3>{`可能是同一个项目 · ${groups.length}`}</h3>
      <p className="dim">这些项目的 session 主要在同一个 Paseo 项目里工作。项目应是长期、完整的工作，它们往往是同一个项目的几个任务。</p>
      <ul className="same-list">
        {groups.map((g) => (
          <li key={g.name} className="same-group" aria-label={g.name}>
            <div className="q-head"><span className="q-kind">是 / 否</span><span className="q-why">{`同在 Paseo 项目 ${g.name}`}</span></div>
            <div className="q-prompt">{g.target ? `把这 ${g.members.length} 个项目并入「${g.target.title}」？` : `把这 ${g.members.length} 个项目合并成一个长期项目「${g.name}」？`}</div>
            <ul className="same-members">
              {g.members.map((m) => <li key={m.id}><a href={projectHref(m.id)}>{m.title}</a></li>)}
            </ul>
            <div className="q-options q-yesno">
              <button type="button" className="q-yes" onClick={() => setMerging(g)}>是，看看会怎么合并</button>
              <button type="button" className="q-no" onClick={() => dismiss(g.name)}>否，它们各自独立</button>
            </div>
          </li>
        ))}
      </ul>
      {merging ? <GroupMerge group={merging} reload={reload} onClose={() => setMerging(null)} /> : null}
    </section>
  );
}
