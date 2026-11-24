import type { ActivityItem, ActivityView, ProjectActivity } from '../../src/domain/activity.ts';
import type { SourceCoverage } from '../../src/server/coverage.ts';

// Period data for the console pages: three days, nothing in them unless a test says so.

export const DAYS = ['2026-11-13', '2026-11-14', '2026-11-15'];

export function projectActivity(over: Partial<ProjectActivity> = {}): ProjectActivity {
  return {
    id: 'p_1',
    title: 'dLLM 评测框架',
    stage: 'build',
    priority: 'P0',
    closed: false,
    daily: [0, 0, 0],
    marks: [{}, {}, {}],
    totals: { chunks: 0, sessions: 0, decisions: 0, done: 0, stage_changes: 0, blockers_opened: 0, blockers_cleared: 0 },
    ...over,
  };
}

export function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return { event_id: 1, at: '2026-11-15T08:00:00.000Z', day: 2, kind: 'decision', project_id: 'p_1', text: '评测集先用公开 v2', actor: 'ai:curator', ...over };
}

export function activity(over: Partial<ActivityView> = {}): ActivityView {
  return {
    days: DAYS,
    from: '2026-11-13T00:00:00.000Z',
    to: '2026-11-16T00:00:00.000Z',
    total_daily: [0, 0, 0],
    unlinked_daily: [0, 0, 0],
    projects: [],
    machines: [],
    items: [],
    ...over,
  };
}

export function source(over: Partial<SourceCoverage> = {}): SourceCoverage {
  return {
    source_id: 'herdr:mac-mini', kind: 'herdr', machine: 'mac-mini', configured: true, state: 'ok',
    collector_heartbeat: '2026-11-15T07:59:00.000Z', collector_version: '0.1.0', daemon_status: null, last_snapshot_at: null,
    sessions: { total: 1, live: 1, ended: 0, purged: 0, untracked: 0, ignored: 0 },
    content: { with_content: 1, without_content: 0, screen_only: 0, catching_up: 0, unloaded: 0, paused: 0, error: 0, chunks: 1, truncated_chunks: 0, tool_cut_chunks: 0, excerpted_chunks: 0, refused_chunks: 0, undigested_chunks: 0 },
    gaps: {}, backlog: null, last_error: null, limits: [],
    ...over,
  };
}
