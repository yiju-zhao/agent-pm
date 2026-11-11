import type { SidebarLabel, SnapshotSession } from '../shared/protocol.ts';
import type { SidebarTokens } from './herdr.ts';

/** The tokens on herdr disappear this long after the last write, so a stopped collector leaves no stale labels. */
export const SIDEBAR_TTL_MS = 600_000;
/** Unchanged labels are written again this often, well inside the TTL. */
export const SIDEBAR_REFRESH_MS = 300_000;

type Report = (paneId: string, tokens: SidebarTokens, ttlMs: number) => Promise<void>;

type PaneState = {
  /** The tokens last written successfully, and when. Unset until the first success. */
  written?: { tokens: string; at: number };
  /** Message of the last failed write, while the failures go on. */
  error?: string;
};

/**
 * Keeps the herdr sidebar's `pm_sid` / `pm` tokens in step with the labels the server sent back for a
 * snapshot. A pane is written when its tokens changed or SIDEBAR_REFRESH_MS passed; a failed write is
 * retried every round, but a repeating error is logged once. Panes that disappear are only forgotten
 * (their tokens expire by TTL). Sidebar trouble must never disturb collection, so `update` never rejects.
 */
export class SidebarReporter {
  private readonly report: Report;
  private readonly log: (line: string) => void;
  private readonly panes = new Map<string, PaneState>();

  constructor(report: Report, log: (line: string) => void) {
    this.report = report;
    this.log = log;
  }

  async update(sessions: SnapshotSession[], labels: SidebarLabel[], now: Date): Promise<void> {
    const labelOf = new Map(labels.map((l) => [l.key, l]));
    const wanted = new Map<string, SidebarTokens>();
    for (const s of sessions) {
      const label = labelOf.get(s.key);
      if (label !== undefined) wanted.set(s.pane_id, { pm_sid: label.short_id, pm: label.project });
    }
    for (const paneId of this.panes.keys()) if (!wanted.has(paneId)) this.panes.delete(paneId);

    // Concurrent, so one hung `herdr` call delays the tick by one timeout rather than one per pane.
    await Promise.all(
      [...wanted].map(async ([paneId, tokens]) => {
        const state = this.panes.get(paneId) ?? {};
        this.panes.set(paneId, state);
        const key = JSON.stringify(tokens);
        const { written } = state;
        if (written !== undefined && written.tokens === key && now.getTime() - written.at < SIDEBAR_REFRESH_MS) return;
        try {
          await this.report(paneId, tokens, SIDEBAR_TTL_MS);
          state.written = { tokens: key, at: now.getTime() };
          delete state.error;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (state.error !== message) {
            state.error = message;
            this.log(`agent-pm collect: sidebar metadata for ${paneId} failed: ${message}`);
          }
        }
      }),
    );
  }
}
