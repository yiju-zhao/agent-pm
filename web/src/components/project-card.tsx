import type { ProjectCard } from '../../../src/domain/read.ts';
import type { Priority } from '../../../src/shared/vocab.ts';
import { STAGE_LABEL } from '../../../src/shared/vocab.ts';
import { isDormant, sessionsByStep } from '../home-model.ts';
import { QuestionCard } from './question-card.tsx';
import { SessionTag } from './session-tag.tsx';

/** How many open todos a card lists; the rest are only counted. */
const MAX_TODOS = 3;

export const projectHref = (id: string) => `#/p/${encodeURIComponent(id)}`;

/** `P0`–`P3`, or `未定` while the project has no priority. */
export function PriorityTag({ priority }: { priority: Priority | null }) {
  return <span className={`tag ${priority === null ? 'pnone' : priority.toLowerCase()}`}>{priority ?? '未定'}</span>;
}

/** One cell per milestone: done (dark), doing (light), then todo (grey). */
function MilestoneBar({ done, doing, todo }: ProjectCard['milestones_progress']) {
  const cells = [...Array<string>(done).fill('d'), ...Array<string>(doing).fill('n'), ...Array<string>(todo).fill('')];
  return (
    <div className="ms" role="img" aria-label={`里程碑 ${done} 完成，${doing} 进行中，${todo} 未开始`}>
      {cells.map((kind, index) => (
        <span key={index} className={kind} />
      ))}
    </div>
  );
}

/**
 * A project on the home page (spec 9.1): where it stands, what its sessions are doing, what is next, what is in the
 * way, and the questions about it, which can be answered right here. `projectTitles` names the project of a question
 * that is about some other project. `onAnswered` runs once the server took an answer to one of them.
 */
export function ProjectCardView({
  card,
  projectTitles,
  onAnswered,
}: {
  card: ProjectCard;
  projectTitles: Map<string, string>;
  onAnswered?: () => void;
}) {
  const { done, doing, todo } = card.milestones_progress;
  const milestones = done + doing + todo;
  const dormant = isDormant(card);
  const { current, other } = sessionsByStep(card);
  const waitingForYou = card.active_sessions.some((s) => s.effective_status === 'blocked');
  const todos = card.open_todos.slice(0, MAX_TODOS);
  const moreTodos = card.open_todos.length - todos.length;

  return (
    <article className={dormant ? 'proj dormant' : 'proj'} data-project-id={card.id}>
      <div className="proj-head">
        <PriorityTag priority={card.priority} />
        <b>
          <a href={projectHref(card.id)}>{card.title}</a>
        </b>
        {waitingForYou ? <span className="alert-dot" role="img" aria-label="有 agent 在等你操作" title="有 agent 在等你操作" /> : null}
        <span className="dim">· {STAGE_LABEL[card.stage]}</span>
        {milestones > 0 ? (
          <span className="dim">
            · 里程碑 {done}/{milestones}
          </span>
        ) : null}
        {dormant ? <span className="dim">· 休眠 {card.dormant_days} 天</span> : null}
        {dormant && card.active_sessions.length === 0 ? <span className="dim">· 无活跃 session</span> : null}
      </div>
      {card.summary ? (
        <div className="dim summary" title={card.summary}>
          {card.summary}
        </div>
      ) : null}
      {milestones > 0 ? <MilestoneBar done={done} doing={doing} todo={todo} /> : null}
      {card.current_milestone !== null ? (
        <div className="todo">
          ▸ <b>当前里程碑：</b>
          {card.current_milestone.title}{' '}
          {current.map((s) => (
            <SessionTag key={s.key} session={s} />
          ))}
        </div>
      ) : null}
      {other.length > 0 ? (
        <div className="todo">
          ▸ <span>其他推进中的 session</span>{' '}
          {other.map((s) => (
            <SessionTag key={s.key} session={s} />
          ))}
        </div>
      ) : null}
      {todos.map((t, index) => (
        <div key={t.id} className="todo dim">
          {index === 0 ? `下一步：${t.title}` : t.title}
        </div>
      ))}
      {moreTodos > 0 ? <div className="todo dim">还有 {moreTodos} 条</div> : null}
      {card.open_blockers.map((b) => (
        <div key={b.id} className="blk">
          ⛔ {b.text}
        </div>
      ))}
      {card.pending_questions.map((q) => (
        <QuestionCard
          key={q.id}
          question={q}
          projectTitle={q.project_id !== null && q.project_id !== card.id ? projectTitles.get(q.project_id) : undefined}
          onDone={onAnswered}
        />
      ))}
    </article>
  );
}
