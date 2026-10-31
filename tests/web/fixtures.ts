import type {
  BlockerRow,
  DecisionRow,
  EventView,
  MilestoneRow,
  ProjectCard,
  ProjectDetail,
  QuestionView,
  SessionTag,
  TodoRow,
} from '../../src/domain/read.ts';
import type { SessionListItem } from '../../src/server/http.ts';

// Read-model values for the page tests: a quiet, live, mid-build project unless a test says otherwise.

export function tag(over: Partial<SessionTag> = {}): SessionTag {
  return {
    key: 'claude:abc',
    short_id: '0d67da1f',
    machine: 'gx10-090e',
    agent_kind: 'claude',
    effective_status: 'working',
    title: '接入 cannbench 数据',
    milestone_id: null,
    ...over,
  };
}

export function milestone(over: Partial<MilestoneRow> = {}): MilestoneRow {
  return {
    id: 'm_1',
    project_id: 'p_1',
    title: '接入 cannbench 数据',
    status: 'todo',
    position: 0,
    locks: [],
    created_by: 'user',
    created_at: '2026-10-20T08:00:00.000Z',
    ...over,
  };
}

export function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: 'd_1',
    project_id: 'p_1',
    text: '评测集先用公开 v2',
    decided_at: '2026-10-21T12:00:00.000Z',
    evidence: [],
    created_by: 'user',
    created_at: '2026-10-21T12:00:00.000Z',
    ...over,
  };
}

export function todo(over: Partial<TodoRow> = {}): TodoRow {
  return {
    id: 't_1',
    project_id: 'p_1',
    milestone_id: null,
    title: '评测报告模板',
    status: 'todo',
    priority: null,
    locks: [],
    created_by: 'user',
    created_at: '2026-10-20T08:00:00.000Z',
    ...over,
  };
}

export function blocker(over: Partial<BlockerRow> = {}): BlockerRow {
  return {
    id: 'b_1',
    project_id: 'p_1',
    text: '显存不够跑对照组',
    kind: 'technical',
    status: 'open',
    cleared_at: null,
    created_by: 'user',
    created_at: '2026-10-20T08:00:00.000Z',
    ...over,
  };
}

export function question(over: Partial<QuestionView> = {}): QuestionView {
  return {
    id: 'q_1',
    kind: 'choice',
    prompt: '评测集用哪个？',
    options: [
      { label: '公开 v2', has_op: false, op: null, args: null },
      { label: '自建', has_op: false, op: null, args: null },
    ],
    project_id: 'p_1',
    session_key: null,
    status: 'pending',
    evidence: [],
    created_by: 'ai:curator',
    created_at: '2026-10-30T10:00:00.000Z',
    resolution_note: null,
    ...over,
  };
}

export function card(over: Partial<ProjectCard> = {}): ProjectCard {
  return {
    id: 'p_1',
    title: 'dLLM 评测框架',
    stage: 'build',
    priority: 'P0',
    summary: '给 Diffusion LLM 做统一评测和负载分析',
    why: null,
    done_criteria: null,
    merged_into: null,
    stage_before_park: null,
    locks: [],
    created_by: 'user',
    created_at: '2026-10-02T08:00:00.000Z',
    inbox: false,
    closed: false,
    last_activity_at: '2026-10-29T08:00:00.000Z',
    dormant_days: null,
    milestones_progress: { done: 0, doing: 0, todo: 0 },
    current_milestone: null,
    open_todos: [],
    open_blockers: [],
    active_sessions: [],
    pending_questions: [],
    ...over,
  };
}

/** A project as the detail page reads it: the card plus nothing in any list unless a test fills it. */
export function detail(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return { ...card(), milestones: [], todos: [], decisions: [], blockers: [], contributions: [], events: [], tombstones: [], ...over };
}

/** A session's contribution to the project as the detail carries it: the session is `tag()` unless a test says `null` (purged). */
export function contribution(over: Partial<ProjectDetail['contributions'][number]> = {}): ProjectDetail['contributions'][number] {
  return {
    id: 'c_1',
    session_key: 'claude:abc',
    project_id: 'p_1',
    milestone_id: null,
    summary: null,
    ts_start: '2026-10-28T12:00:00.000Z',
    ts_end: '2026-10-29T12:00:00.000Z',
    confidence: null,
    actor: 'ai:curator',
    created_at: '2026-10-29T12:30:00.000Z',
    session: tag(),
    ...over,
  };
}

/** One entry of the event log: a plain edit by the user that nothing has reverted. */
export function eventView(over: Partial<EventView> = {}): EventView {
  return {
    id: 1,
    occurred_at: '2026-10-29T08:00:00.000Z',
    recorded_at: '2026-10-29T08:00:00.000Z',
    actor: 'user',
    op: 'update_project',
    entity: 'project:p_1',
    args: {},
    before: null,
    after: null,
    reason: null,
    evidence: [],
    question_id: null,
    reverts: null,
    reverted_by: null,
    is_veto: false,
    ...over,
  };
}

/** One entry of `GET /sessions`: a live, full-fidelity Claude session on gx10-090e that no project claims. */
export function sessionItem(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    key: 'claude:abc',
    agent_kind: 'claude',
    native_id: 'abc',
    machine: 'gx10-090e',
    pane_id: 'p1',
    terminal_id: 't1',
    workspace_id: 'w1',
    tab_id: 'tab1',
    cwd: '/home/eason/projects/herdr-pm',
    title: '接入 cannbench 数据',
    live_status: 'working',
    lifecycle: 'live',
    fidelity: 'full',
    transcript_path: null,
    predecessor_key: null,
    merged_into: null,
    ignored: 0,
    first_seen: '2026-10-28T08:00:00.000Z',
    last_seen: '2026-10-30T11:58:00.000Z',
    status_changed_at: null,
    short_id: '0d67da1f',
    effective_status: 'working',
    chunk_count: 2,
    linked_projects: [],
    ...over,
  };
}
