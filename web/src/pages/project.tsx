import { useMemo } from 'react';
import type { ProjectCard, ProjectDetail, QuestionView } from '../../../src/domain/read.ts';
import { PRIORITIES } from '../../../src/shared/vocab.ts';
import { apiSend, errorText } from '../api.ts';
import type { ApiError } from '../api.ts';
import { Fold, Section } from '../components/blocks.tsx';
import { EditableText, LockMark } from '../components/editable-text.tsx';
import { BlockerList, DecisionList, MilestoneList, TodoList } from '../components/items.tsx';
import { projectHref } from '../components/project-card.tsx';
import { QuestionCard } from '../components/question-card.tsx';
import { StageControl } from '../components/stage-control.tsx';
import { relTime, shortDate } from '../format.ts';
import { useApi } from '../use-api.ts';
import { useWrite } from '../use-write.ts';

type ProjectField = 'summary' | 'why' | 'done_criteria';

/** The big picture (spec 9.2), in the order it is read. */
const BIG_PICTURE: Array<{ field: ProjectField; label: string }> = [
  { field: 'summary', label: '是什么' },
  { field: 'why', label: '为什么' },
  { field: 'done_criteria', label: '做完的标准' },
];

type PageProps = { project: ProjectDetail; reload(): void };

const projectPath = (project: ProjectDetail) => `/projects/${encodeURIComponent(project.id)}`;

function ErrorBar({ error, onRetry }: { error: ApiError; onRetry(): void }) {
  return (
    <div className="error-bar" role="alert">
      <span>{errorText(error)}</span>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function Missing({ id }: { id: string }) {
  return (
    <main data-page="project" data-project-id={id}>
      <p>项目不存在或已删除</p>
      <a href="#/">回首页</a>
    </main>
  );
}

function MergedBanner({ into, titles }: { into: string; titles: Map<string, string> }) {
  return (
    <div className="banner" role="status">
      已合并到 <a href={projectHref(into)}>{titles.get(into) ?? into}</a>
    </div>
  );
}

function PriorityControl({ project, reload }: PageProps) {
  const { fire } = useWrite(reload);
  const path = projectPath(project);
  return (
    <span className="priority-control">
      <select
        aria-label="优先级"
        className={project.priority === null ? 'prio pnone' : `prio ${project.priority.toLowerCase()}`}
        value={project.priority ?? ''}
        onChange={(e) => void fire(() => apiSend('PATCH', path, { priority: e.target.value === '' ? null : e.target.value }))}
      >
        <option value="">未定</option>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      {project.locks.includes('priority') ? (
        <LockMark field="优先级" onUnlock={() => fire(() => apiSend('DELETE', `${path}/locks/priority`))} />
      ) : null}
    </span>
  );
}

function Overview({ project, reload, mergeTargets }: PageProps & { mergeTargets: Array<{ id: string; title: string }> }) {
  const { write } = useWrite(reload);
  const path = projectPath(project);
  return (
    <section className="overview" aria-label="项目概览">
      <div className="title-row">
        <PriorityControl project={project} reload={reload} />
        <h2 className="proj-title">
          <EditableText
            value={project.title}
            locked={project.locks.includes('title')}
            onSave={(title) => write(() => apiSend('PATCH', path, { title }))}
            onUnlock={() => write(() => apiSend('DELETE', `${path}/locks/title`))}
          />
        </h2>
      </div>
      <StageControl project={project} mergeTargets={mergeTargets} reload={reload} />
      <div className="dim">{`创建于 ${shortDate(project.created_at)} · 最近活动 ${relTime(project.last_activity_at, new Date())}`}</div>
    </section>
  );
}

function BigPicture({ project, reload }: PageProps) {
  const { write } = useWrite(reload);
  const path = projectPath(project);
  return (
    <>
      {BIG_PICTURE.map(({ field, label }) => (
        <Section key={field} title={label}>
          <EditableText
            multiline
            value={project[field]}
            locked={project.locks.includes(field)}
            placeholder="（还没有）"
            onSave={(value) => write(() => apiSend('PATCH', path, { [field]: value }))}
            onUnlock={() => write(() => apiSend('DELETE', `${path}/locks/${field}`))}
          />
        </Section>
      ))}
    </>
  );
}

/** What the user deleted: the AI is told not to propose it again, so it is shown rather than lost. */
function Tombstones({ tombstones }: { tombstones: ProjectDetail['tombstones'] }) {
  if (tombstones.length === 0) return null;
  return (
    <Fold label={`已删除的条目（${tombstones.length}）`}>
      <p className="dim">这些是你删掉的，AI 不会再把它们加回来</p>
      <ul className="items">
        {tombstones.map((t) => (
          <li key={`${t.table}:${t.id}`} className="item dim">{`${t.label} · ${shortDate(t.deleted_at)}`}</li>
        ))}
      </ul>
    </Fold>
  );
}

/** The project page (spec 9.2): the big picture, the stage, and the milestones, todos, blockers and decisions, all editable. */
export function ProjectPage({ id }: { id: string }) {
  const encoded = encodeURIComponent(id);
  const project = useApi<ProjectDetail>(`/projects/${encoded}`, [`project:${id}`]);
  const questions = useApi<QuestionView[]>(`/questions?status=pending&project_id=${encoded}`, ['questions']);
  const projects = useApi<ProjectCard[]>('/projects', ['projects']);

  const titles = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.title])), [projects.data]);
  const mergeTargets = useMemo(() => (projects.data ?? []).map((p) => ({ id: p.id, title: p.title })), [projects.data]);

  const { data, error, reload } = project;
  if (error?.status === 404) return <Missing id={id} />;

  if (data === undefined) {
    return (
      <main data-page="project" data-project-id={id}>
        {error !== null ? <ErrorBar error={error} onRetry={reload} /> : <div className="dim">加载中…</div>}
      </main>
    );
  }

  const pending = questions.data ?? [];
  const answered = () => {
    questions.reload();
    reload();
  };

  return (
    <main data-page="project" data-project-id={id}>
      {data.merged_into !== null ? <MergedBanner into={data.merged_into} titles={titles} /> : null}
      {error !== null ? <ErrorBar error={error} onRetry={reload} /> : null}
      <Overview project={data} reload={reload} mergeTargets={mergeTargets} />
      <div className="cols">
        <div className="main">
          {pending.length > 0 ? (
            <Section title={`待你回答 · ${pending.length}`}>
              {pending.map((q) => (
                <QuestionCard key={q.id} question={q} onDone={answered} />
              ))}
            </Section>
          ) : null}
          <BigPicture project={data} reload={reload} />
          <MilestoneList project={data} reload={reload} />
          <TodoList project={data} reload={reload} />
        </div>
        <aside className="side">
          <BlockerList project={data} reload={reload} />
          <DecisionList project={data} reload={reload} />
          <Tombstones tombstones={data.tombstones} />
        </aside>
      </div>
      <section data-slot="timeline" />
      <section data-slot="events" />
    </main>
  );
}
