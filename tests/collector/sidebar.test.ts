import { expect, test, vi } from 'vitest';
import { SIDEBAR_REFRESH_MS, SIDEBAR_TTL_MS, SidebarReporter } from '../../src/collector/sidebar.ts';
import type { SidebarLabel, SnapshotSession } from '../../src/shared/protocol.ts';

const T0 = new Date('2026-10-31T10:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

function session(key: string, paneId: string): SnapshotSession {
  return {
    key,
    agent_kind: 'claude',
    native_id: key.split(':')[1] ?? null,
    pane_id: paneId,
    terminal_id: `term_${paneId}`,
    workspace_id: 'w1',
    tab_id: 'w1:t1',
    cwd: '/home/demo',
    title: 'Task',
    live_status: 'idle',
    fidelity: 'screen',
    transcript_path: null,
  };
}

const label = (key: string, short_id: string, project: string | null): SidebarLabel => ({ key, short_id, project });

function setup() {
  const report = vi.fn<(paneId: string, tokens: { pm_sid: string; pm: string | null }, ttlMs: number) => Promise<void>>(
    async () => {},
  );
  const log = vi.fn<(line: string) => void>();
  return { report, log, reporter: new SidebarReporter(report, log) };
}

test('the ttl outlives the refresh interval, so a live label never expires between refreshes', () => {
  expect(SIDEBAR_TTL_MS).toBe(600_000);
  expect(SIDEBAR_REFRESH_MS).toBe(300_000);
});

test('writes each pane once, then only on change', async () => {
  const { report, reporter } = setup();
  const sessions = [session('claude:a', 'w1:p1'), session('claude:b', 'w1:p2')];
  const labels = [label('claude:a', '0d67da1f', 'dLLM评测'), label('claude:b', '5d27595b', null)];

  await reporter.update(sessions, labels, T0);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledWith('w1:p1', { pm_sid: '0d67da1f', pm: 'dLLM评测' }, SIDEBAR_TTL_MS);
  expect(report).toHaveBeenCalledWith('w1:p2', { pm_sid: '5d27595b', pm: null }, SIDEBAR_TTL_MS);

  report.mockClear();
  await reporter.update(sessions, labels, later(10_000));
  expect(report).not.toHaveBeenCalled();

  await reporter.update(sessions, [label('claude:a', '0d67da1f', 'other project'), labels[1]!], later(20_000));
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith('w1:p1', { pm_sid: '0d67da1f', pm: 'other project' }, SIDEBAR_TTL_MS);
});

test('a project that goes away is written again (the pm token is cleared)', async () => {
  const { report, reporter } = setup();
  const sessions = [session('claude:a', 'w1:p1')];
  await reporter.update(sessions, [label('claude:a', '0d67da1f', 'dLLM评测')], T0);
  report.mockClear();
  await reporter.update(sessions, [label('claude:a', '0d67da1f', null)], later(10_000));
  expect(report).toHaveBeenCalledExactlyOnceWith('w1:p1', { pm_sid: '0d67da1f', pm: null }, SIDEBAR_TTL_MS);
});

test('the same session moving to another pane is written to the new pane', async () => {
  const { report, reporter } = setup();
  const labels = [label('claude:a', '0d67da1f', null)];
  await reporter.update([session('claude:a', 'w1:p1')], labels, T0);
  report.mockClear();
  await reporter.update([session('claude:a', 'w1:p7')], labels, later(10_000));
  expect(report).toHaveBeenCalledExactlyOnceWith('w1:p7', { pm_sid: '0d67da1f', pm: null }, SIDEBAR_TTL_MS);
});

test('refreshes after SIDEBAR_REFRESH_MS', async () => {
  const { report, reporter } = setup();
  const sessions = [session('claude:a', 'w1:p1')];
  const labels = [label('claude:a', '0d67da1f', null)];
  await reporter.update(sessions, labels, T0);
  report.mockClear();

  await reporter.update(sessions, labels, later(SIDEBAR_REFRESH_MS - 1));
  expect(report).not.toHaveBeenCalled();
  await reporter.update(sessions, labels, later(SIDEBAR_REFRESH_MS));
  expect(report).toHaveBeenCalledTimes(1);
  // The refresh restarts the interval.
  await reporter.update(sessions, labels, later(SIDEBAR_REFRESH_MS + 1000));
  expect(report).toHaveBeenCalledTimes(1);
});

test('sessions without a label are skipped', async () => {
  const { report, reporter } = setup();
  await reporter.update(
    [session('claude:a', 'w1:p1'), session('claude:b', 'w1:p2')],
    [label('claude:b', '5d27595b', null), label('claude:gone', 'deadbeef', null)],
    T0,
  );
  expect(report).toHaveBeenCalledExactlyOnceWith('w1:p2', { pm_sid: '5d27595b', pm: null }, SIDEBAR_TTL_MS);
  await reporter.update([session('claude:a', 'w1:p1')], [], later(1000));
  expect(report).toHaveBeenCalledTimes(1);
});

test('a pane that disappears is forgotten, so it is written again when it comes back', async () => {
  const { report, reporter } = setup();
  const sessions = [session('claude:a', 'w1:p1')];
  const labels = [label('claude:a', '0d67da1f', null)];
  await reporter.update(sessions, labels, T0);
  await reporter.update([], [], later(1000));
  report.mockClear();
  await reporter.update(sessions, labels, later(2000));
  expect(report).toHaveBeenCalledTimes(1);
});

test('a failing report never rejects and logs the same error once', async () => {
  const { report, log, reporter } = setup();
  report.mockRejectedValue(new Error('pane not found'));
  const sessions = [session('claude:a', 'w1:p1')];
  const labels = [label('claude:a', '0d67da1f', null)];

  for (let i = 0; i < 3; i += 1) await expect(reporter.update(sessions, labels, later(i * 1000))).resolves.toBeUndefined();
  // A failed pane is retried every round.
  expect(report).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledExactlyOnceWith('agent-pm collect: sidebar metadata for w1:p1 failed: pane not found');

  report.mockRejectedValue(new Error('unknown flag --source'));
  await reporter.update(sessions, labels, later(4000));
  expect(log).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenLastCalledWith('agent-pm collect: sidebar metadata for w1:p1 failed: unknown flag --source');
});

test('a pane that recovers is written, and a later failure is logged again', async () => {
  const { report, log, reporter } = setup();
  const sessions = [session('claude:a', 'w1:p1')];
  const labels = [label('claude:a', '0d67da1f', null)];
  report.mockRejectedValueOnce(new Error('pane not found'));
  await reporter.update(sessions, labels, T0);
  await reporter.update(sessions, labels, later(1000)); // succeeds
  expect(report).toHaveBeenCalledTimes(2);
  await reporter.update(sessions, labels, later(2000)); // nothing to do
  expect(report).toHaveBeenCalledTimes(2);

  report.mockRejectedValueOnce(new Error('pane not found'));
  await reporter.update(sessions, [label('claude:a', '0d67da1f', 'p')], later(3000));
  expect(log).toHaveBeenCalledTimes(2);
});

test('one failing pane does not stop the others', async () => {
  const { report, log, reporter } = setup();
  report.mockImplementation(async (paneId) => {
    if (paneId === 'w1:p1') throw 'not an Error';
  });
  await reporter.update(
    [session('claude:a', 'w1:p1'), session('claude:b', 'w1:p2')],
    [label('claude:a', '0d67da1f', null), label('claude:b', '5d27595b', null)],
    T0,
  );
  expect(report).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledExactlyOnceWith('agent-pm collect: sidebar metadata for w1:p1 failed: not an Error');
});
