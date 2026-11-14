import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SourceCoverage } from '../../src/server/coverage.ts';
import { OFFLINE_AFTER_MS } from '../../src/server/sessions-repo.ts';
import { call, config, HERDR_TOKEN, herdrChunks, herdrSession, herdrSnapshot, MACHINE, OTHER_SOURCE, PASEO_SOURCE, startCenter } from '../helpers/center.ts';
import type { Center } from '../helpers/center.ts';

// The coverage report as an administrator reads it, after collectors pushed over the real ingest routes.

let center: Center;
beforeEach(() => {
  center = startCenter();
});
afterEach(() => center.close());

async function coverage(): Promise<Record<string, SourceCoverage>> {
  const res = await call(center, 'GET', '/coverage', config.userToken);
  expect(res.status).toBe(200);
  return Object.fromEntries((res.json as SourceCoverage[]).map((s) => [s.source_id, s]));
}

test('configured sources that never reported are listed as such, apart from ones that reported and went quiet', async () => {
  await call(center, 'POST', '/ingest/snapshot', HERDR_TOKEN, herdrSnapshot([herdrSession('claude:aaa')]));
  let report = await coverage();
  expect(Object.keys(report).sort()).toEqual([`herdr:gx10-090e`, `herdr:${MACHINE}`, OTHER_SOURCE, PASEO_SOURCE].sort());
  expect(report['herdr:gx10-090e']).toMatchObject({ configured: true, state: 'never_reported', collector_heartbeat: null, sessions: { total: 0 } });
  expect(report[PASEO_SOURCE]).toMatchObject({ kind: 'paseo', state: 'never_reported' });
  expect(report[`herdr:${MACHINE}`]).toMatchObject({ state: 'ok', sessions: { total: 1, live: 1 } });
  expect(report[PASEO_SOURCE]!.limits.join()).toContain('includeArchivedHistory');

  center.advance(OFFLINE_AFTER_MS + 1000);
  report = await coverage();
  expect(report[`herdr:${MACHINE}`]!.state).toBe('offline');
  expect(report['herdr:gx10-090e']!.state).toBe('never_reported');
});

test('found sessions are told apart from sessions whose content arrived, and cut text is counted', async () => {
  const sessions = [herdrSession('claude:with-text'), herdrSession('claude:silent', { terminal_id: 't2', pane_id: 'w1:1:2' }), herdrSession('pending:mac-mini:t3', { terminal_id: 't3', pane_id: 'w1:1:3' })];
  await call(center, 'POST', '/ingest/snapshot', HERDR_TOKEN, herdrSnapshot(sessions));
  await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, herdrChunks('claude:with-text', 0, 10, '[2026-11-06T09:59Z] user: 开头\n…[中间省略 9000 字符]…\n结尾\n[2026-11-06T09:59Z] tool: Bash: {"command":"ls…[已截断]'));
  await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, herdrChunks('claude:with-text', 10, 20, '[2026-11-06T09:59Z] assistant: 完整的一段\n[2026-11-06T09:59Z] tool: Read: {"file":"x…[已截断]'));
  const report = (await coverage())[`herdr:${MACHINE}`]!;
  expect(report.sessions).toMatchObject({ total: 3, live: 3 });
  expect(report.content).toMatchObject({ with_content: 1, without_content: 2, screen_only: 1, chunks: 2, truncated_chunks: 1, tool_cut_chunks: 1, excerpted_chunks: 0, undigested_chunks: 2 });
  expect(report.limits.length).toBeGreaterThan(0);
});

test('the report needs the administrator', async () => {
  expect((await call(center, 'GET', '/coverage', HERDR_TOKEN)).status).toBe(401);
});
