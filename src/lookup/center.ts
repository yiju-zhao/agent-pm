// What the central server knows about a short id that no herdr lists. Everything here is best
// effort: the lookup works without the center, so any failure is silence (null), never an error.
// Only the few SessionView fields used are parsed, with a schema of their own, so this stays free
// of src/server (the single-file bun binary cannot load node:sqlite).
import { z } from 'zod';

export const CENTER_TIMEOUT_MS = 2000;

const Sessions = z.array(
  z.object({
    machine: z.string(),
    agent_kind: z.string(),
    effective_status: z.string(),
    title: z.string(),
    // The herdr terminal the session runs in; a center that does not send it is read as "unknown".
    terminal_id: z.string().nullable().default(null),
    // Which collectors observe it; a center that predates sources sends none.
    sources: z
      .array(z.object({ kind: z.string(), lifecycle: z.string(), external_id: z.string(), machine: z.string().nullable() }))
      .default([]),
  }),
);

export type CenterSession = z.infer<typeof Sessions>[number];

function describe(s: CenterSession): string {
  // Seen only through Paseo: there is no herdr pane to open, and none is made up.
  const herdr = s.sources.filter((o) => o.kind === 'herdr' && o.lifecycle === 'live');
  const paseo = s.sources.filter((o) => o.kind === 'paseo' && o.lifecycle === 'live');
  if (herdr.length === 0 && paseo.length > 0 && s.effective_status !== 'ended' && s.effective_status !== 'purged') {
    const agent = paseo[0]!;
    return `这个 session 只由 Paseo 采集（${agent.machine ?? s.machine} · agent ${agent.external_id} · ${s.title}），不在 herdr 里，请在 Paseo 中打开`;
  }
  switch (s.effective_status) {
    case 'ended':
    case 'purged':
      return `这个 session 已结束（${s.machine} · ${s.title}）`;
    case 'offline':
      return `${s.machine} 的采集器离线，这个 session 可能还在（${s.title}）`;
    default:
      return `中心记录：${s.machine} · ${s.agent_kind} · ${s.title}，但 herdr 里没找到`;
  }
}

/**
 * The sessions the center knows under `sid`; `null` when the center cannot be reached, answers
 * badly, or knows nothing about `sid`.
 */
export async function centerSessions(fetchImpl: typeof fetch, server: string, sid: string): Promise<CenterSession[] | null> {
  try {
    const url = new URL(`sessions/by-short-id/${encodeURIComponent(sid)}`, server.endsWith('/') ? server : `${server}/`);
    const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(CENTER_TIMEOUT_MS) });
    if (!response.ok) return null;
    const parsed = Sessions.safeParse(await response.json());
    if (!parsed.success || parsed.data.length === 0) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** One line per session, saying why herdr does not list it; `null` for no sessions. */
export function formatCenterHint(sessions: CenterSession[]): string | null {
  return sessions.length === 0 ? null : sessions.map(describe).join('\n');
}
