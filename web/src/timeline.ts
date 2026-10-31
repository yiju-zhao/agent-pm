import type { ProjectDetail } from '../../src/domain/read.ts';
import { shortDate } from './format.ts';

// Where the sessions that took part in a project sit on a time axis. Pure, so the page can lay it out again on every tick of its clock.

export type TimelineBar = {
  session_key: string;
  label: string;
  /** The session's `effective_status`; `purged` when the session row is gone. */
  status: string;
  /** 0–100, two decimals. */
  leftPct: number;
  widthPct: number;
  /** ISO. */
  start: string;
  end: string;
};

/** A bar is never thinner than this, so a session that left no end time is still there to see. */
export const MIN_BAR_PCT = 1;

/** A session in one of these states is still going on, so a contribution without an end reaches up to now. */
const ONGOING = new Set(['working', 'blocked', 'idle']);

const TICK_COUNT = 5;
const HUNDREDTHS = 100;
const FULL = 100 * HUNDREDTHS;

/** Milliseconds, or NaN when there is no time or it cannot be read. */
function ms(iso: string | null): number {
  return iso === null ? Number.NaN : new Date(iso).getTime();
}

function firstTime(...times: number[]): number {
  return times.find((t) => !Number.isNaN(t)) ?? Number.NaN;
}

/** The 8 characters after the colon of a session key (`claude:0123456789ab` → `01234567`). */
function keyTail(key: string): string {
  return key.slice(key.indexOf(':') + 1).slice(0, 8);
}

function barLabel(c: ProjectDetail['contributions'][number]): string {
  const { session } = c;
  if (session === null) return `session ${keyTail(c.session_key)}（已清除）`;
  const summary = c.summary !== null && c.summary.trim() !== '' ? c.summary : session.title;
  const label = `${session.machine} · ${session.agent_kind} · ${summary}`;
  if (session.effective_status === 'ended') return `${label}（已结束）`;
  if (session.effective_status === 'purged') return `${label}（已清除）`;
  return label;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type Placed = { bar: Omit<TimelineBar, 'leftPct' | 'widthPct'>; startMs: number; endMs: number };

/**
 * One bar per contribution. A bar runs from `ts_start` (else when the contribution was recorded) to `ts_end`; without an
 * end it reaches `now` while the session is still going on, and is a thin mark at its start otherwise. The axis runs
 * from the earliest of the project's creation and every bar's start up to `now`; with nothing to span, every bar is
 * the whole width. Bars are ordered by start, then session key.
 */
export function layoutTimeline(
  contributions: ProjectDetail['contributions'],
  createdAt: string,
  now: Date,
): { bars: TimelineBar[]; ticks: Array<{ pct: number; label: string }> } {
  const nowMs = now.getTime();
  const createdMs = ms(createdAt);

  const placed: Placed[] = contributions.map((c) => {
    const status = c.session?.effective_status ?? 'purged';
    const startMs = firstTime(ms(c.ts_start), ms(c.created_at), createdMs, nowMs);
    const tsEnd = ms(c.ts_end);
    const endMs = Math.max(startMs, Number.isNaN(tsEnd) ? (ONGOING.has(status) ? nowMs : startMs) : tsEnd);
    return {
      bar: {
        session_key: c.session_key,
        label: barLabel(c),
        status,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      },
      startMs,
      endMs,
    };
  });

  // A project created "in the future" (clock skew) still has an axis that ends at now.
  const originMs = Math.min(nowMs, ...placed.map((p) => p.startMs), ...(Number.isNaN(createdMs) ? [] : [createdMs]));
  const span = nowMs - originMs;

  // Position on the axis in hundredths of a percent, kept inside the axis.
  const at = (t: number) => Math.min(FULL, Math.max(0, (t - originMs) / span) * FULL);

  const bars: TimelineBar[] = placed
    .sort((a, b) => a.startMs - b.startMs || compareKeys(a.bar.session_key, b.bar.session_key))
    .map(({ bar, startMs, endMs }) => {
      if (span <= 0) return { ...bar, leftPct: 0, widthPct: 100 };
      const width = Math.min(FULL, Math.max(MIN_BAR_PCT * HUNDREDTHS, Math.round(at(endMs) - at(startMs))));
      // A bar that reaches the right edge, or starts so far right that it would be too thin, moves left: it never passes 100.
      const left = endMs >= nowMs ? FULL - width : Math.min(Math.round(at(startMs)), FULL - width);
      return { ...bar, leftPct: left / HUNDREDTHS, widthPct: width / HUNDREDTHS };
    });

  const ticks = Array.from({ length: TICK_COUNT }, (_, i) => {
    const pct = (i * 100) / (TICK_COUNT - 1);
    const at = new Date(originMs + (Math.max(span, 0) * pct) / 100);
    return { pct, label: i === TICK_COUNT - 1 ? '今天' : shortDate(at.toISOString()) };
  });

  return { bars, ticks };
}
