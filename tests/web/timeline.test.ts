import { expect, test } from 'vitest';
import { shortDate } from '../../web/src/format.ts';
import { MIN_BAR_PCT, layoutTimeline } from '../../web/src/timeline.ts';
import { contribution, tag } from './fixtures.ts';

const NOW = new Date('2026-10-30T12:00:00.000Z');
// Four days before `NOW`: the timeline's origin in most tests, so that every day is 25%.
const CREATED = '2026-10-26T12:00:00.000Z';

const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

test('exports the minimum bar width', () => {
  expect(MIN_BAR_PCT).toBe(1);
});

test('ongoing live session ends at now', () => {
  for (const status of ['working', 'blocked', 'idle']) {
    const { bars } = layoutTimeline(
      [contribution({ ts_start: ago(2), ts_end: null, session: tag({ effective_status: status }) })],
      CREATED,
      NOW,
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].leftPct).toBe(50);
    expect(bars[0].widthPct).toBe(50);
    expect(bars[0].leftPct + bars[0].widthPct).toBe(100);
    expect(bars[0].end).toBe(NOW.toISOString());
  }
});

test('ended session with null ts_end is a minimum-width bar at its start', () => {
  for (const status of ['ended', 'done', 'unknown', 'offline']) {
    const { bars } = layoutTimeline(
      [contribution({ ts_start: ago(2), ts_end: null, session: tag({ effective_status: status }) })],
      CREATED,
      NOW,
    );
    expect(bars[0].leftPct).toBe(50);
    expect(bars[0].widthPct).toBe(MIN_BAR_PCT);
    expect(bars[0].start).toBe(ago(2));
    expect(bars[0].end).toBe(ago(2));
  }
});

test('purged session (session null) gets the 已清除 label and status purged', () => {
  const { bars } = layoutTimeline([contribution({ session_key: 'claude:0123456789abcdef', session: null })], CREATED, NOW);
  expect(bars[0].status).toBe('purged');
  expect(bars[0].label).toBe('session 01234567（已清除）');
  expect(bars[0].session_key).toBe('claude:0123456789abcdef');
});

test('a purged session key without a colon is cut at 8 characters from its start', () => {
  const { bars } = layoutTimeline([contribution({ session_key: 'abcdefghijkl', session: null })], CREATED, NOW);
  expect(bars[0].label).toBe('session abcdefgh（已清除）');
});

test('zero-length range: every bar is the whole width', () => {
  const at = NOW.toISOString();
  const { bars } = layoutTimeline(
    [
      contribution({ session_key: 'claude:a', ts_start: at, ts_end: at, session: tag({ effective_status: 'ended' }) }),
      contribution({ session_key: 'claude:b', ts_start: null, ts_end: null, created_at: at, session: tag({ effective_status: 'working' }) }),
    ],
    at,
    NOW,
  );
  expect(bars.map((b) => [b.leftPct, b.widthPct])).toEqual([
    [0, 100],
    [0, 100],
  ]);
});

test('a project created now with no contributions has no bars and still five ticks', () => {
  const { bars, ticks } = layoutTimeline([], NOW.toISOString(), NOW);
  expect(bars).toEqual([]);
  expect(ticks).toHaveLength(5);
});

test('bar at the far right is shifted to keep width ≥ 1 and within 100', () => {
  const at = NOW.toISOString();
  const { bars } = layoutTimeline(
    [contribution({ ts_start: at, ts_end: at, session: tag({ effective_status: 'ended' }) })],
    CREATED,
    NOW,
  );
  expect(bars[0].widthPct).toBe(1);
  expect(bars[0].leftPct).toBe(99);
});

test('a start after now (clock skew) is still a bar inside the range', () => {
  const future = new Date(NOW.getTime() + 3_600_000).toISOString();
  const { bars } = layoutTimeline([contribution({ ts_start: future, ts_end: null, session: tag({ effective_status: 'working' }) })], CREATED, NOW);
  expect(bars[0].widthPct).toBeGreaterThanOrEqual(MIN_BAR_PCT);
  expect(bars[0].leftPct).toBeGreaterThanOrEqual(0);
  expect(bars[0].leftPct + bars[0].widthPct).toBeLessThanOrEqual(100);
});

test('percentages are kept to two decimals', () => {
  const { bars } = layoutTimeline(
    [contribution({ ts_start: ago(2), ts_end: ago(1), session: tag({ effective_status: 'ended' }) })],
    ago(3),
    NOW,
  );
  expect(bars[0].leftPct).toBe(33.33);
  expect(bars[0].widthPct).toBe(33.33);
});

test('the axis begins at the earliest of the project creation and every bar start', () => {
  const { bars, ticks } = layoutTimeline(
    [contribution({ ts_start: ago(8), ts_end: ago(6), session: tag({ effective_status: 'ended' }) })],
    ago(4),
    NOW,
  );
  expect(bars[0].leftPct).toBe(0);
  expect(bars[0].widthPct).toBe(25);
  expect(ticks[0].label).toBe(shortDate(ago(8)));
});

test('without ts_start the bar starts when the contribution was recorded', () => {
  const { bars } = layoutTimeline(
    [contribution({ ts_start: null, ts_end: ago(1), created_at: ago(2), session: tag({ effective_status: 'ended' }) })],
    CREATED,
    NOW,
  );
  expect(bars[0].start).toBe(ago(2));
  expect(bars[0].leftPct).toBe(50);
  expect(bars[0].widthPct).toBe(25);
});

test('a ts_end before the start does not make a negative bar', () => {
  const { bars } = layoutTimeline(
    [contribution({ ts_start: ago(2), ts_end: ago(3), session: tag({ effective_status: 'ended' }) })],
    CREATED,
    NOW,
  );
  expect(bars[0].widthPct).toBe(MIN_BAR_PCT);
  expect(bars[0].end).toBe(ago(2));
});

test('a time that cannot be read falls back instead of producing NaN', () => {
  const { bars, ticks } = layoutTimeline(
    [contribution({ ts_start: 'sometime', ts_end: 'later', created_at: ago(1), session: tag({ effective_status: 'working' }) })],
    CREATED,
    NOW,
  );
  expect(bars[0].start).toBe(ago(1));
  expect(Number.isFinite(bars[0].leftPct)).toBe(true);
  expect(Number.isFinite(bars[0].widthPct)).toBe(true);
  expect(ticks.every((t) => !t.label.includes('NaN'))).toBe(true);
});

test('bars sorted by start then key', () => {
  const { bars } = layoutTimeline(
    [
      contribution({ session_key: 'claude:z', ts_start: ago(1) }),
      contribution({ session_key: 'claude:b', ts_start: ago(2) }),
      contribution({ session_key: 'claude:a', ts_start: ago(2) }),
      contribution({ session_key: 'claude:m', ts_start: ago(3) }),
    ],
    CREATED,
    NOW,
  );
  expect(bars.map((b) => b.session_key)).toEqual(['claude:m', 'claude:a', 'claude:b', 'claude:z']);
});

test('ticks: five, at 0, 25, 50, 75 and 100, local MM/DD, the last one 今天', () => {
  const { ticks } = layoutTimeline([], CREATED, NOW);
  expect(ticks.map((t) => t.pct)).toEqual([0, 25, 50, 75, 100]);
  expect(ticks.map((t) => t.label)).toEqual([
    shortDate(ago(4)),
    shortDate(ago(3)),
    shortDate(ago(2)),
    shortDate(ago(1)),
    '今天',
  ]);
  for (const t of ticks.slice(0, 4)) expect(t.label).toMatch(/^\d\d\/\d\d$/);
});

test('label: <machine> · <agent_kind> · <summary ?? title>', () => {
  const s = tag({ machine: 'gx10-090e', agent_kind: 'claude', title: '接入 cannbench 数据' });
  const { bars } = layoutTimeline(
    [
      contribution({ session_key: 'claude:a', ts_start: ago(3), summary: '写完加载器', session: s }),
      contribution({ session_key: 'claude:b', ts_start: ago(2), summary: null, session: s }),
      contribution({ session_key: 'claude:c', ts_start: ago(1), summary: '', session: s }),
    ],
    CREATED,
    NOW,
  );
  expect(bars.map((b) => b.label)).toEqual([
    'gx10-090e · claude · 写完加载器',
    'gx10-090e · claude · 接入 cannbench 数据',
    'gx10-090e · claude · 接入 cannbench 数据',
  ]);
});

test('label: an ended session gets （已结束） and a purged one （已清除） exactly once', () => {
  const { bars } = layoutTimeline(
    [
      contribution({ session_key: 'claude:a', ts_start: ago(3), summary: '做了一半', session: tag({ effective_status: 'ended' }) }),
      contribution({ session_key: 'claude:b', ts_start: ago(2), summary: '做了一半', session: tag({ effective_status: 'purged' }) }),
      contribution({ session_key: 'claude:c', ts_start: ago(1), session: null }),
      contribution({ session_key: 'claude:d', ts_start: ago(0.5), summary: '还在做', session: tag({ effective_status: 'working' }) }),
    ],
    CREATED,
    NOW,
  );
  expect(bars.map((b) => b.label)).toEqual([
    'gx10-090e · claude · 做了一半（已结束）',
    'gx10-090e · claude · 做了一半（已清除）',
    'session c（已清除）',
    'gx10-090e · claude · 还在做',
  ]);
  expect(bars.map((b) => b.status)).toEqual(['ended', 'purged', 'purged', 'working']);
});

test('start and end are ISO strings', () => {
  const { bars } = layoutTimeline([contribution({ ts_start: ago(2), ts_end: ago(1) })], CREATED, NOW);
  expect(bars[0].start).toBe(ago(2));
  expect(bars[0].end).toBe(ago(1));
});
