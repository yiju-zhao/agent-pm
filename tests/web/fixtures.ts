import type { BlockerRow, ProjectCard, QuestionView, SessionTag, TodoRow } from '../../src/domain/read.ts';

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
