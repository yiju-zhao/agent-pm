import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectCard, QuestionView } from '../../../src/domain/read.ts';
import type { SessionListItem } from '../../../src/server/http.ts';
import { errorText } from '../api.ts';
import { Kanban } from '../components/kanban.tsx';
import { ProjectCardView } from '../components/project-card.tsx';
import { QuestionCard } from '../components/question-card.tsx';
import { SessionTag } from '../components/session-tag.tsx';
import { groupProjects, isDormant, splitQuestions } from '../home-model.ts';
import { useApi } from '../use-api.ts';

export const VIEW_KEY = 'herdr-pm.homeView';
type View = 'list' | 'kanban';

// localStorage can throw (blocked site data): then the page just starts on the list and forgets the choice.
function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'kanban' ? 'kanban' : 'list';
  } catch {
    return 'list';
  }
}

function writeView(view: View): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // The switch has already happened on the page; only the memory of it is lost.
  }
}

function ViewToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <div className="seg" role="group" aria-label="视图">
      <button type="button" aria-pressed={view === 'list'} onClick={() => onChange('list')}>
        列表
      </button>
      <button type="button" aria-pressed={view === 'kanban'} onClick={() => onChange('kanban')}>
        看板
      </button>
    </div>
  );
}

/** A shut-by-default group of cards. What is inside is not rendered until it is opened. */
function Fold({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="fold">
      <button type="button" className="fold-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">{open ? '▾ ' : '▸ '}</span>
        {label}
      </button>
      {open ? <div>{children}</div> : null}
    </section>
  );
}

function SideSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="side-section" aria-labelledby={id}>
      <h2 id={id} className="h">
        {title}
      </h2>
      {children}
    </section>
  );
}

type Read<T> = ReturnType<typeof useApi<T>>;
type Reads = { questions: Read<QuestionView[]>; sessions: Read<SessionListItem[]> };

function NeedYou({ questions, titles }: { questions: Reads['questions']; titles: Map<string, string> }) {
  const needYou = splitQuestions(questions.data ?? []).needYou;
  const ready = questions.data !== undefined;
  return (
    <SideSection title={ready ? `需要你 · ${needYou.length}` : '需要你'}>
      {!ready ? (
        <div className="dim">{questions.error ? errorText(questions.error) : '加载中…'}</div>
      ) : needYou.length === 0 ? (
        <div className="dim">没有需要你决定的事</div>
      ) : (
        needYou.map((q) => <QuestionCard key={q.id} question={q} projectTitle={q.project_id === null ? undefined : titles.get(q.project_id)} />)
      )}
    </SideSection>
  );
}

function Attribution({ questions, sessions }: Reads) {
  const attribution = splitQuestions(questions.data ?? []).attribution;
  const byKey = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.key, s])), [sessions.data]);
  // A session list that cannot be read is no reason to hide the questions: they show the key instead of the session.
  const ready = questions.data !== undefined && (sessions.data !== undefined || sessions.error !== null);
  return (
    <SideSection title={questions.data !== undefined ? `待归属的 session · ${attribution.length}` : '待归属的 session'}>
      <div className="tray">
        {!ready ? (
          <div className="dim">{questions.error ? errorText(questions.error) : '加载中…'}</div>
        ) : attribution.length === 0 ? (
          <div className="dim">没有待归属的 session</div>
        ) : (
          attribution.map((q) => {
            const session = byKey.get(q.session_key ?? '');
            return (
              <div key={q.id} className="todo attrib">
                {session ? <SessionTag session={session} /> : null}
                <div>{session ? session.title : q.session_key}</div>
                <QuestionCard question={q} />
              </div>
            );
          })
        )}
      </div>
    </SideSection>
  );
}

/** The home page (spec 9.1): projects as the subject, what needs the user on the right, sessions nobody has claimed below it. */
export function HomePage() {
  const projects = useApi<ProjectCard[]>('/projects', ['projects']);
  const questions = useApi<QuestionView[]>('/questions?status=pending', ['questions']);
  const sessions = useApi<SessionListItem[]>('/sessions', ['sessions']);
  const [view, setView] = useState<View>(readView);
  const choose = (next: View) => {
    setView(next);
    writeView(next);
  };

  const cards = projects.data;
  const groups = useMemo(() => groupProjects(cards ?? []), [cards]);
  const titles = useMemo(() => new Map((cards ?? []).map((c) => [c.id, c.title])), [cards]);
  const asleep = groups.main.filter(isDormant).length;
  const heading =
    cards === undefined ? '项目 · 按优先级' : `项目 · 按优先级 · ${groups.main.length - asleep} 个推进中 · ${asleep} 个休眠`;

  const list = (items: ProjectCard[]) => items.map((card) => <ProjectCardView key={card.id} card={card} projectTitles={titles} />);

  return (
    <main data-page="home">
      <div className="cols">
        <div className="main">
          <div className="head-row">
            <h2 className="h">{heading}</h2>
            <ViewToggle view={view} onChange={choose} />
          </div>
          {projects.error !== null ? (
            <div className="error-bar" role="alert">
              <span>{errorText(projects.error)}</span>
              <button type="button" onClick={projects.reload}>
                重试
              </button>
            </div>
          ) : null}
          {cards === undefined ? (
            projects.error === null ? (
              <div className="dim">加载中…</div>
            ) : null
          ) : view === 'kanban' ? (
            <Kanban cards={[...groups.main, ...groups.inbox, ...groups.closed]} />
          ) : (
            <>
              {cards.length === 0 ? <div className="dim">还没有项目</div> : null}
              {list(groups.main)}
              {groups.inbox.length > 0 ? <Fold label={`新 idea（${groups.inbox.length}）`}>{list(groups.inbox)}</Fold> : null}
              {groups.closed.length > 0 ? <Fold label={`已关闭（${groups.closed.length}）`}>{list(groups.closed)}</Fold> : null}
            </>
          )}
        </div>
        <aside className="side">
          <NeedYou questions={questions} titles={titles} />
          <Attribution questions={questions} sessions={sessions} />
        </aside>
      </div>
    </main>
  );
}
