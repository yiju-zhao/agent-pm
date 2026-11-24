// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { SourceCoverage } from '../../src/server/coverage.ts';
import { CoveragePanel } from '../../web/src/components/coverage-panel.tsx';

const fetchMock = vi.fn<typeof fetch>();
const NOW = new Date('2026-11-13T10:00:00.000Z');

function source(over: Omit<Partial<SourceCoverage>, 'content'> & { content?: Partial<SourceCoverage['content']> } = {}): SourceCoverage {
  const { content, ...rest } = over;
  return {
    source_id: 'herdr:mac-mini', kind: 'herdr', machine: 'mac-mini', configured: true, state: 'ok',
    collector_heartbeat: '2026-11-13T09:59:00.000Z', collector_version: '0.1.0', daemon_status: null, last_snapshot_at: null,
    sessions: { total: 3, live: 2, ended: 1, purged: 0, untracked: 0, ignored: 0 },
    content: { with_content: 3, without_content: 0, screen_only: 0, catching_up: 0, unloaded: 0, paused: 0, error: 0, chunks: 10, truncated_chunks: 0, tool_cut_chunks: 0, excerpted_chunks: 0, refused_chunks: 0, undigested_chunks: 0, ...content },
    gaps: {}, backlog: null, last_error: null, limits: ['首次观察之前就已关闭的 session 不会被发现'],
    ...rest,
  };
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('nothing is read until the panel is opened; then each source shows what it found, what arrived and what is missing', async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify([
    source(),
    source({ source_id: 'herdr:gx10', machine: 'gx10', state: 'never_reported', collector_heartbeat: null, sessions: { total: 0, live: 0, ended: 0, purged: 0, untracked: 0, ignored: 0 }, content: { with_content: 0, chunks: 0 } }),
    source({ source_id: 'paseo-mini', kind: 'paseo', gaps: { history_unavailable: 2 }, backlog: { outbox_batches: 4, outbox_bytes: 1, lagging_agents: 1 }, content: { without_content: 1, unloaded: 5, catching_up: 1, truncated_chunks: 3 } }),
  ])));
  render(<CoveragePanel now={NOW} />);
  expect(fetchMock).not.toHaveBeenCalled();
  const panel = screen.getByText('采集覆盖核验').closest('details')!;
  panel.open = true;
  fireEvent(panel, new Event('toggle'));

  const healthy = await screen.findByRole('listitem', { name: 'herdr:mac-mini' });
  expect(String(fetchMock.mock.calls[0]![0])).toBe('/coverage');
  expect(healthy.textContent).toContain('在线');
  expect(healthy.textContent).toContain('session：活跃 2 · 已结束 1');
  expect(healthy.textContent).toContain('未发现已知缺口');
  expect(healthy.textContent).toContain('首次观察之前就已关闭的 session 不会被发现');
  expect(panel.querySelector('summary')!.textContent).toContain('3 个来源 · 2 个需要关注');
  expect(screen.getByRole('listitem', { name: 'herdr:gx10' }).textContent).toContain('已配置，但从未上报');
  const paseo = within(screen.getByRole('listitem', { name: 'paseo-mini' })).getByRole('list', { name: '缺口' }).textContent!;
  for (const part of ['1 个 session 没有任何正文', '5 个未加载（只有元数据）', '1 个仍在补采', '历史不可读 2 处', '3/10 段有消息在采集时被截断', '采集器还有 4 批未送达']) expect(paseo).toContain(part);
});
