import type { AgentObservation } from '../shared/ingest-v2.ts';
import type { PaseoCollectorConfig } from './config.ts';
import { isLoaded, nativeSessionId } from './sdk.ts';
import type { AgentSnapshot, DirectoryEntry, PaseoSdk } from './sdk.ts';

// The agent directory of one daemon: a full paginated scan (a page failing fails the scan: a partial list is never a
// complete one), exact-id checks of tracked agents the scan no longer lists, and the mapping of what Paseo says about an
// agent to what the center records.

const DIRECTORY_PAGE = 100;

/** Every agent of the daemon, all pages; throws if any page fails or the pages do not end. */
export async function scanDirectory(sdk: PaseoSdk, opts: { includeBackground: boolean; includeArchived: boolean }): Promise<Map<string, DirectoryEntry>> {
  const all = new Map<string, DirectoryEntry>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page > 10_000) throw new Error('agent directory pagination did not end');
    const res = await sdk.listAgents({ cursor, limit: DIRECTORY_PAGE, includeArchived: opts.includeArchived, includeBackground: opts.includeBackground });
    for (const e of res.entries) all.set(e.agent.id, e);
    if (!res.hasMore) break;
    if (res.nextCursor === null || res.nextCursor === cursor) throw new Error('agent directory says it has more pages but gives no new cursor');
    cursor = res.nextCursor;
  }
  return all;
}

export type MissingResolution = { agentId: string; lifecycle: 'archived' | 'closed' | 'deleted' | 'live'; agent: AgentSnapshot | null } | { agentId: string; failed: string };

/**
 * Tracked agents a scan did not list, checked by exact id (which never loads them): gone, archived, closed, or still
 * there (listed elsewhere, e.g. moved to a filtered workspace). A failed lookup is reported as such; the caller must
 * then not treat the scan as complete.
 */
export async function resolveMissing(sdk: PaseoSdk, ids: string[]): Promise<MissingResolution[]> {
  const out: MissingResolution[] = [];
  for (const agentId of ids) {
    try {
      const agent = await sdk.fetchAgent(agentId);
      if (agent === null) out.push({ agentId, lifecycle: 'deleted', agent: null });
      else if (agent.archivedAt) out.push({ agentId, lifecycle: 'archived', agent });
      else if (agent.status === 'closed') out.push({ agentId, lifecycle: 'closed', agent });
      else out.push({ agentId, lifecycle: 'live', agent });
    } catch (err) {
      out.push({ agentId, failed: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Whether deployment filters exclude an agent from tracking. */
export function isExcluded(entry: DirectoryEntry, exclude: PaseoCollectorConfig['exclude']): boolean {
  const projectKey = entry.project?.projectKey;
  if (projectKey !== undefined && exclude.projectKeys.includes(projectKey)) return true;
  return Object.entries(exclude.labels).some(([k, v]) => entry.agent.labels?.[k] === v);
}

/**
 * Paseo state → PM status (pending permission and error are `blocked`, the raw status is kept alongside; running is
 * working; idle is idle; initializing and anything unknown is unknown) and lifecycle (archived, closed, deleted, or
 * excluded; otherwise live). `content` is the collector's own reading state.
 */
export function toObservation(
  agent: AgentSnapshot,
  lifecycle: AgentObservation['lifecycle'],
  content: AgentObservation['content'],
): AgentObservation {
  const native = nativeSessionId(agent);
  const permissions = agent.pendingPermissions?.length ?? 0;
  let status: AgentObservation['status'];
  let attention: string | null = null;
  if (permissions > 0) {
    status = 'blocked';
    attention = `permission:${permissions}`;
  } else if (agent.status === 'error') {
    status = 'blocked';
    attention = `error:${(agent.lastError ?? '').slice(0, 150)}`;
  } else if (agent.status === 'running') status = 'working';
  else if (agent.status === 'idle') status = 'idle';
  else status = 'unknown';
  return {
    agent_id: agent.id,
    provider: agent.provider,
    native_id: native?.id ?? null,
    native_id_origin: native?.origin ?? null,
    cwd: agent.cwd ?? '',
    title: (agent.title ?? '').slice(0, 2000),
    workspace_id: agent.workspaceId ?? null,
    raw_status: String(agent.status).slice(0, 50),
    status,
    attention,
    lifecycle,
    content,
  };
}

/** The lifecycle a listed agent is in. */
export function listedLifecycle(agent: AgentSnapshot): AgentObservation['lifecycle'] {
  if (agent.archivedAt) return 'archived';
  if (agent.status === 'closed') return 'closed';
  return 'live';
}

export { isLoaded };
