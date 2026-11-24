import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectCard, QuestionView } from '../../../src/domain/read.ts';
import type { SessionListItem } from '../../../src/server/http.ts';
import { errorText } from '../api.ts';
import { Icon } from '../components/icon.tsx';
import { projectHref } from '../components/project-card.tsx';
import { QuestionCard } from '../components/question-card.tsx';
import { SessionTag } from '../components/session-tag.tsx';
import { splitQuestions } from '../home-model.ts';
import { useInbox } from '../inbox.tsx';
import { AutoDecisions, SameNameProjects } from '../components/inbox-extras.tsx';
import { Reminders } from '../components/reminders.tsx';
import { useApi } from '../use-api.ts';

type Filter = 'all' | 'decisions' | 'sessions';
function InboxSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const id = useId();
  return <section className="inbox-section" aria-labelledby={id}><h3 id={id}>{title} · {count}</h3><div className="inbox-items">{children}</div></section>;
}

export function InboxPage() {
  const questions = useInbox();
  const projects = useApi<ProjectCard[]>('/projects', ['projects']);
  const sessions = useApi<SessionListItem[]>('/sessions', ['sessions']);
  const [filter, setFilter] = useState<Filter>('all');
  const titles = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.title])), [projects.data]);
  const byKey = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.key, s])), [sessions.data]);
  if (questions === null) throw new Error('InboxPage requires InboxProvider');
  const { needYou, attribution } = splitQuestions(questions.data ?? []);
  const count = needYou.length + attribution.length;
  const shown = filter === 'decisions' ? needYou.length : filter === 'sessions' ? attribution.length : count;
  const context = (question: QuestionView) => question.project_id ? <a className="inbox-context" href={projectHref(question.project_id)}><Icon name="projects" />{titles.get(question.project_id) ?? question.project_id}<span aria-hidden="true">↗</span></a> : <span className="inbox-context dim">项目决策</span>;
  return <main data-page="inbox" className="inbox-page">
    <header className="inbox-page-head"><div><p className="eyebrow">你的工作收件箱</p><h2>Inbox <span className="heading-en">待处理事项</span></h2><p className="dim">上面是需要你在 agent-pm 里决定的事，下面是随进展自动更新的提醒。</p></div>{questions.data !== undefined && !questions.error && <span className="inbox-total">{count} <span>项待处理</span></span>}</header>
    <div className="inbox-filters" role="group" aria-label="Inbox 分类">
      {([{ id: 'all', label: '全部', count }, { id: 'decisions', label: '需要你', count: needYou.length }, { id: 'sessions', label: '会话归属', count: attribution.length }] as const).map((item) => <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span className="count-badge">{item.count}</span></button>)}
    </div>
    {questions.error && <div className="error-bar" role="alert"><span>{errorText(questions.error)}</span><button type="button" onClick={questions.reload}>重新加载</button></div>}
    {questions.data === undefined ? !questions.error && <p role="status" className="dim">正在加载待处理事项…</p> : questions.error && count === 0 ? null : shown === 0 ? <div className="inbox-empty"><span className="inbox-empty-icon"><Icon name="inbox" /></span><h3>{count === 0 ? '暂时没有待处理事项' : '这个分类暂时没有事项'}</h3><p className="dim">{count === 0 ? '新的项目决策和会话归属问题会出现在这里。' : '切换到其他分类，继续处理剩余事项。'}</p>{count === 0 ? <a className="button" href="#/">返回项目</a> : <button type="button" onClick={() => setFilter('all')}>查看全部事项</button>}</div> : <>
      {filter !== 'sessions' && needYou.length > 0 && <InboxSection title="需要你" count={needYou.length}>{needYou.map((question) => <article className="inbox-item" key={question.id}>{context(question)}<QuestionCard question={question} onDone={projects.reload} /></article>)}</InboxSection>}
      {filter !== 'decisions' && attribution.length > 0 && <InboxSection title="待归属的 session" count={attribution.length}>
        {sessions.error && <p className="dim inbox-session-error">会话信息暂时不可用，仍可按会话标识处理归属。</p>}
        {attribution.map((question) => {
          const session = byKey.get(question.session_key ?? '');
          return <article className="inbox-item" key={question.id}><div className="inbox-session-context">{session && <SessionTag session={session} />}<span>{session?.title ?? question.session_key}</span></div><QuestionCard question={question} onDone={projects.reload} /></article>;
        })}
      </InboxSection>}
    </>}
    {filter !== 'sessions' && projects.data ? <SameNameProjects cards={projects.data} reload={projects.reload} /> : null}
    <section className="inbox-section reminders-section" aria-label="提醒">
      <h3>提醒</h3>
      <p className="dim">这些不是要你在这里回答的问题：agent-pm 只读 agent 的工作。去对应的 session 处理；进展反映到 session、项目或仓库后，提醒会自动更新或消失。</p>
      <Reminders groupBy="project" />
    </section>
    <AutoDecisions />
  </main>;
}
