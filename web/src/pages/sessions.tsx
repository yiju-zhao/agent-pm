import { useId, useMemo, useState } from 'react';
import type { ProjectCard } from '../../../src/domain/read.ts';
import type { SessionListItem } from '../../../src/server/http.ts';
import { apiSend, errorText, sessionPath } from '../api.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { projectHref } from '../components/project-card.tsx';
import { SessionTag } from '../components/session-tag.tsx';
import { SourceBadges } from '../components/source-badges.tsx';
import { middleEllipsis, relTime } from '../format.ts';
import { useApi } from '../use-api.ts';
import { useNow } from '../use-now.ts';
import { useWrite } from '../use-write.ts';

type Filter = 'all' | 'live' | 'ended';

/** The filter is the server's: the page asks for the sessions it wants to see. */
const FILTERS: Array<{ id: Filter; label: string; path: string }> = [
  { id: 'all', label: '全部', path: '/sessions' },
  { id: 'live', label: '活跃', path: '/sessions?lifecycle=live' },
  { id: 'ended', label: '已结束', path: '/sessions?lifecycle=ended' },
];

/** How many characters of a working directory a row shows; the full path is in the hover text. */
const CWD_CHARS = 40;

function FilterToggle({ filter, onChange }: { filter: Filter; onChange: (filter: Filter) => void }) {
  return (
    <div className="seg" role="group" aria-label="筛选">
      {FILTERS.map((f) => (
        <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => onChange(f.id)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

type RowProps = { session: SessionListItem; projects: ProjectCard[]; now: Date; reload(): void };

function SessionRow({ session, projects, now, reload }: RowProps) {
  const { fire } = useWrite(reload);
  const path = `/sessions/${sessionPath(session.key)}`;
  const ignored = Boolean(session.ignored);
  const linked = new Set(session.linked_projects.map((p) => p.id));
  // Whether a project can take the session is the server's call; the list only leaves out what makes no sense to pick.
  const choices = projects.filter((p) => p.stage !== 'merged' && !linked.has(p.id));

  return (
    <li className={ignored ? 'sess-row ignored' : 'sess-row'}>
      <div className="sess-main">
        <SessionTag session={session} />
        <span className="sess-title">{session.title}</span>
        {session.fidelity === 'screen' ? <span className="tag">仅屏幕</span> : null}
        <SourceBadges sources={session.sources ?? []} />
      </div>
      <div className="sess-meta dim">
        {session.cwd === '' ? null : (
          <span className="cwd" title={session.cwd}>
            {middleEllipsis(session.cwd, CWD_CHARS)}
          </span>
        )}
        <span>{relTime(session.last_seen, now)}</span>
      </div>
      <div className="sess-links">
        {session.linked_projects.map((p) => (
          <span key={p.id} className="tag linked">
            <a href={projectHref(p.id)}>{p.title}</a>
            <ConfirmButton
              label="×"
              confirmLabel="确认取消关联"
              title={`取消与「${p.title}」的关联`}
              onConfirm={() => fire(() => apiSend('DELETE', `${path}/links/${encodeURIComponent(p.id)}`))}
            />
          </span>
        ))}
        <select
          aria-label="关联到…"
          value=""
          disabled={choices.length === 0}
          onChange={(e) => {
            const projectId = e.target.value;
            if (projectId !== '') void fire(() => apiSend('POST', `${path}/links`, { project_id: projectId }));
          }}
        >
          <option value="">关联到…</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void fire(() => apiSend('PUT', `${path}/ignored`, { ignored: !ignored }))}>
          {ignored ? '恢复追踪' : '不追踪'}
        </button>
      </div>
    </li>
  );
}

function MachineGroup({ machine, sessions, ...rest }: { machine: string; sessions: SessionListItem[] } & Omit<RowProps, 'session'>) {
  const id = useId();
  return (
    <section className="machine-group" aria-labelledby={id}>
      <h3 id={id} className="h">{`${machine} · ${sessions.length} 个 session`}</h3>
      <ul className="sess-list">
        {sessions.map((s) => (
          <SessionRow key={s.key} session={s} {...rest} />
        ))}
      </ul>
    </section>
  );
}

/** By machine, in the order of the machine names, so the groups stay where they are as sessions come and go; each group keeps the server's order. */
function groupByMachine(sessions: SessionListItem[]): Array<{ machine: string; sessions: SessionListItem[] }> {
  const groups = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const group = groups.get(s.machine);
    if (group === undefined) groups.set(s.machine, [s]);
    else group.push(s);
  }
  return [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([machine, items]) => ({ machine, sessions: items }));
}

/** The session page (spec 10, the `GET /sessions` list "调试和管理用"; plan 4 Task 8): every session the collectors know, by machine, with who it belongs to and a way to change that. */
export function SessionsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const path = FILTERS.find((f) => f.id === filter)!.path;
  // A link made elsewhere shows up as an event on a project ('projects'), not as a change of the session itself.
  const sessions = useApi<SessionListItem[]>(path, ['sessions', 'projects']);
  const projects = useApi<ProjectCard[]>('/projects', ['projects']);
  const now = useNow();

  const { data, error, reload } = sessions;
  const groups = useMemo(() => groupByMachine(data ?? []), [data]);

  return (
    <main data-page="sessions">
      <div className="head-row">
        <h2 className="h">{data === undefined ? 'Session' : `Session · ${data.length} 个`}</h2>
        <FilterToggle filter={filter} onChange={setFilter} />
      </div>
      {error !== null ? (
        <div className="error-bar" role="alert">
          <span>{errorText(error)}</span>
          <button type="button" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}
      {data === undefined ? (
        error === null ? (
          <div className="dim">加载中…</div>
        ) : null
      ) : (
        <>
          {projects.data === undefined && projects.error !== null ? <div className="dim">没读到项目列表，暂时不能关联</div> : null}
          {data.length === 0 ? <div className="dim">没有 session</div> : null}
          {groups.map((g) => (
            <MachineGroup key={g.machine} machine={g.machine} sessions={g.sessions} projects={projects.data ?? []} now={now} reload={reload} />
          ))}
        </>
      )}
    </main>
  );
}
