import { useMemo, useState } from 'react';
import type { ProjectCard } from '../../../src/domain/read.ts';
import { PRIORITIES, PRIORITY_LABEL, STAGES, STAGE_LABEL } from '../../../src/shared/vocab.ts';
import { errorText } from '../api.ts';
import { Fold } from '../components/blocks.tsx';
import { Icon } from '../components/icon.tsx';
import { Kanban } from '../components/kanban.tsx';
import { ProjectCardView } from '../components/project-card.tsx';
import { groupProjects, isDormant } from '../home-model.ts';
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
        <Icon name="list" />列表
      </button>
      <button type="button" aria-pressed={view === 'kanban'} onClick={() => onChange('kanban')}>
        <Icon name="board" />看板
      </button>
    </div>
  );
}

/** The project workspace; pending decisions and session attribution live in Inbox. */
export function HomePage() {
  const projects = useApi<ProjectCard[]>('/projects', ['projects']);
  const [view, setView] = useState<View>(readView);
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('all');
  const [priority, setPriority] = useState('all');
  const filtering = query.trim() !== '' || stage !== 'all' || priority !== 'all';
  const clearFilters = () => { setQuery(''); setStage('all'); setPriority('all'); };
  const choose = (next: View) => {
    setView(next);
    writeView(next);
  };

  const cards = projects.data;
  const filteredCards = useMemo(() => (cards ?? []).filter((card) =>
    (stage === 'all' || card.stage === stage)
    && (priority === 'all' || (priority === 'none' ? card.priority === null : card.priority === priority))
    && `${card.title} ${card.summary ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())), [cards, stage, priority, query]);
  const groups = useMemo(() => groupProjects(cards ?? []), [cards]);
  const titles = useMemo(() => new Map((cards ?? []).map((c) => [c.id, c.title])), [cards]);
  const asleep = groups.main.filter(isDormant).length;
  const heading =
    cards === undefined ? '项目 · 按优先级' : `项目 · 按优先级 · ${groups.main.length - asleep} 个推进中 · ${asleep} 个休眠`;

  const answered = projects.reload;
  const list = (items: ProjectCard[]) =>
    items.map((card) => <ProjectCardView key={card.id} card={card} projectTitles={titles} onAnswered={answered} />);

  return (
    <main data-page="home">
      <div className="project-workspace">
      <div className="head-row">
        <h2 className="h workspace-title" aria-label={heading}>
          项目<span className="workspace-meta">按优先级{cards !== undefined ? ` / ${groups.main.length - asleep} 个推进中 / ${asleep} 个休眠` : ''}</span>
        </h2>
        <ViewToggle view={view} onChange={choose} />
      </div>
      <div className="project-filters" role="search" aria-label="项目筛选">
        <input type="search" aria-label="搜索项目" placeholder="搜索项目名称或摘要…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="筛选项目阶段" value={stage} onChange={(event) => setStage(event.target.value)}>
          <option value="all">所有阶段</option>
          {STAGES.map((value) => <option key={value} value={value}>{STAGE_LABEL[value]}</option>)}
        </select>
        <select aria-label="筛选项目优先级" value={priority} onChange={(event) => setPriority(event.target.value)}>
          <option value="all">所有优先级</option>
          {PRIORITIES.map((value) => <option key={value} value={value}>{value} · {PRIORITY_LABEL[value]}</option>)}
          <option value="none">未定优先级</option>
        </select>
        {filtering && <button type="button" onClick={clearFilters}>清除筛选</button>}
      </div>
      {cards !== undefined && filtering && <p className="project-filter-count dim" role="status">显示 {filteredCards.length} / {cards.length} 个项目</p>}
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
      ) : filtering && filteredCards.length === 0 ? (
        <div className="project-filter-empty"><h3>没有符合条件的项目</h3><p className="dim">试试其他关键词，或清除筛选查看全部项目。</p><button type="button" onClick={clearFilters}>查看全部项目</button></div>
      ) : view === 'kanban' ? (
        // The server's order is by priority; the kanban columns keep it (the list's groups are only for the list).
        <Kanban cards={filteredCards} includeMerged={filtering} />
      ) : filtering ? (
        <>{list(filteredCards)}</>
      ) : (
        <>
          {cards.length === 0 ? <div className="dim">还没有项目</div> : null}
          {list(groups.main)}
          {groups.inbox.length > 0 ? <Fold label={`新 idea（${groups.inbox.length}）`}>{list(groups.inbox)}</Fold> : null}
          {groups.closed.length > 0 ? <Fold label={`已关闭（${groups.closed.length}）`}>{list(groups.closed)}</Fold> : null}
        </>
      )}
      </div>
    </main>
  );
}
