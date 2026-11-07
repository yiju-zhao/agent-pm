// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { SourceView } from '../../src/server/sources-repo.ts';
import { evidenceSourceLine, SourceBadges, sourceNote } from '../../web/src/components/source-badges.tsx';

afterEach(cleanup);

function source(over: Partial<SourceView> = {}): SourceView {
  return {
    source_id: 'herdr:mac-mini',
    kind: 'herdr',
    machine: 'mac-mini',
    external_id: 'claude:abc',
    provider: 'claude',
    native_id: 'abc',
    native_id_origin: 'herdr',
    live_status: 'working',
    raw_status: 'working',
    attention: null,
    lifecycle: 'live',
    end_reason: null,
    last_seen: '2026-11-06T10:00:00.000Z',
    fresh: true,
    collector_alive: true,
    daemon_status: null,
    content_role: 'owner',
    content_state: null,
    identity_note: null,
    checkpoint: null,
    gaps: 0,
    ...over,
  };
}

test('one badge per source, with its content role and anything that lags', () => {
  render(
    <SourceBadges
      sources={[
        source(),
        source({ source_id: 'paseo-mac-mini', kind: 'paseo', external_id: 'agent-1', content_role: 'standby', daemon_status: 'disconnected', fresh: false, gaps: 2 }),
      ]}
    />,
  );
  expect(screen.getByText('herdr · 主内容')).toBeTruthy();
  expect(screen.getByText('Paseo · 备用（daemon 断开，2 处缺口）')).toBeTruthy();
});

test('notes say why a source is not current', () => {
  expect(sourceNote(source())).toBeNull();
  expect(sourceNote(source({ collector_alive: false, fresh: false }))).toBe('采集器离线');
  expect(sourceNote(source({ kind: 'paseo', daemon_status: 'connected', content_state: 'unloaded' }))).toBe('未加载，暂不读取');
  expect(sourceNote(source({ lifecycle: 'ended', end_reason: 'archived' }))).toBe('已归档');
  expect(sourceNote(source({ identity_note: 'cross_machine: …' }))).toBe('身份待核对');
});

test('the provenance line of a chunk names the agent, the seq range and any upstream cut', () => {
  expect(evidenceSourceLine(null)).toBeNull();
  expect(evidenceSourceLine({ source_id: 'herdr:m', kind: 'herdr', agent_id: null, epoch: null, seq_start: null, seq_end: null, events: 0, truncated_upstream: false, ts_unknown: false })).toBe('来源 herdr:m');
  expect(
    evidenceSourceLine({ source_id: 'paseo-m', kind: 'paseo', agent_id: 'a1', epoch: 'e', seq_start: 3, seq_end: 9, events: 4, truncated_upstream: true, ts_unknown: false }),
  ).toBe('来源 paseo-m · agent a1 · seq 3–9 · 4 条 · 采集时已截断');
});
