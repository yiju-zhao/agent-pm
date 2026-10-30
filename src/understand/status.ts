// The shape of `GET /status`'s `understanding` field. Kept apart from the scheduler so the HTTP layer can answer with the
// disabled status without loading the scheduler, digester and curator.

export type SchedulerStatus = {
  enabled: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  last_error: string | null;
  running: 'digest' | 'curate' | null;
  waiting_sessions: number;
  uncurated_digests: number;
  backfill: { sessions_total: number; sessions_done: number };
  last_digest_at: string | null;
  last_curate_at: string | null;
};

/** What `GET /status` reports when the understanding layer is switched off. */
export function disabledStatus(): SchedulerStatus {
  return {
    enabled: false,
    paused_until: null,
    pause_reason: null,
    last_error: null,
    running: null,
    waiting_sessions: 0,
    uncurated_digests: 0,
    backfill: { sessions_total: 0, sessions_done: 0 },
    last_digest_at: null,
    last_curate_at: null,
  };
}
