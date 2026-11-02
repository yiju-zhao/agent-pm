// Optional explanation from the central server for a short id that no herdr lists. Everything here
// is best effort: the lookup works without the center, so any failure is silence (null), never an
// error. Only the few SessionView fields used are parsed, with a schema of their own, so this
// stays free of src/server (the single-file bun binary cannot load node:sqlite).
import { z } from 'zod';

export const CENTER_TIMEOUT_MS = 2000;

const Sessions = z.array(
  z.object({
    machine: z.string(),
    agent_kind: z.string(),
    effective_status: z.string(),
    title: z.string(),
  }),
);

type CenterSession = z.infer<typeof Sessions>[number];

function describe(s: CenterSession): string {
  switch (s.effective_status) {
    case 'ended':
    case 'purged':
      return `这个 session 已结束（${s.machine} · ${s.title}）`;
    case 'offline':
      return `${s.machine} 的采集器离线，这个 session 可能还在（${s.title}）`;
    default:
      return `中心记录：${s.machine} · ${s.agent_kind} · ${s.title}，但本机 herdr 没列出来`;
  }
}

/**
 * One line per session the center knows under `sid`, saying why herdr does not list it; `null`
 * when the center cannot be reached, answers badly, or knows nothing about `sid`.
 */
export async function centerHint(fetchImpl: typeof fetch, server: string, sid: string): Promise<string | null> {
  try {
    const url = new URL(`sessions/by-short-id/${encodeURIComponent(sid)}`, server.endsWith('/') ? server : `${server}/`);
    const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(CENTER_TIMEOUT_MS) });
    if (!response.ok) return null;
    const parsed = Sessions.safeParse(await response.json());
    if (!parsed.success || parsed.data.length === 0) return null;
    return parsed.data.map(describe).join('\n');
  } catch {
    return null;
  }
}
