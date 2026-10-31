// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { Timeline } from '../../web/src/components/timeline.tsx';
import { shortTime } from '../../web/src/format.ts';
import { contribution, detail, tag } from './fixtures.ts';

const NOW = new Date('2026-10-30T12:00:00.000Z');

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(cleanup);

test('titled with how many sessions took part', () => {
  const project = detail({
    created_at: '2026-10-26T12:00:00.000Z',
    contributions: [contribution({ session_key: 'claude:a' }), contribution({ session_key: 'claude:b' })],
  });
  render(<Timeline project={project} now={NOW} />);
  expect(screen.getByRole('region', { name: '参与过的 session · 2' })).toBeTruthy();
});

test('with no contribution it says that no session took part', () => {
  render(<Timeline project={detail()} now={NOW} />);
  expect(screen.getByRole('region', { name: '参与过的 session · 0' })).toBeTruthy();
  expect(screen.getByText('还没有 session 参与这个项目')).toBeTruthy();
});

test('one bar per contribution with its label, placed by percentage', () => {
  const project = detail({
    created_at: '2026-10-26T12:00:00.000Z',
    contributions: [
      contribution({ session_key: 'claude:a', ts_start: '2026-10-28T12:00:00.000Z', ts_end: null, summary: '在跑评测', session: tag({ effective_status: 'working' }) }),
    ],
  });
  render(<Timeline project={project} now={NOW} />);
  const bar = screen.getByText('gx10-090e · claude · 在跑评测');
  expect(bar.style.left).toBe('50%');
  expect(bar.style.width).toBe('50%');
});

test('the tooltip is the full label and the time span', () => {
  const project = detail({
    created_at: '2026-10-26T12:00:00.000Z',
    contributions: [
      contribution({
        ts_start: '2026-10-28T12:00:00.000Z',
        ts_end: '2026-10-29T12:00:00.000Z',
        summary: '一段很长很长的 summary',
        session: tag({ effective_status: 'ended' }),
      }),
    ],
  });
  render(<Timeline project={project} now={NOW} />);
  const bar = screen.getByText('gx10-090e · claude · 一段很长很长的 summary（已结束）');
  expect(bar.getAttribute('title')).toBe(
    `gx10-090e · claude · 一段很长很长的 summary（已结束）\n${shortTime('2026-10-28T12:00:00.000Z')} – ${shortTime('2026-10-29T12:00:00.000Z')}`,
  );
});

test('bars are coloured by status: working green, idle and waiting light, ended and purged grey', () => {
  const project = detail({
    created_at: '2026-10-20T12:00:00.000Z',
    contributions: [
      contribution({ session_key: 'claude:a', ts_start: '2026-10-21T12:00:00.000Z', summary: 'a', session: tag({ effective_status: 'working' }) }),
      contribution({ session_key: 'claude:b', ts_start: '2026-10-22T12:00:00.000Z', summary: 'b', session: tag({ effective_status: 'blocked' }) }),
      contribution({ session_key: 'claude:c', ts_start: '2026-10-23T12:00:00.000Z', summary: 'c', session: tag({ effective_status: 'idle' }) }),
      contribution({ session_key: 'claude:d', ts_start: '2026-10-24T12:00:00.000Z', summary: 'd', session: tag({ effective_status: 'ended' }) }),
      contribution({ session_key: 'claude:e', ts_start: '2026-10-25T12:00:00.000Z', summary: 'e', session: null }),
    ],
  });
  render(<Timeline project={project} now={NOW} />);
  const classes = (text: string) => screen.getByText(text).className.split(' ');
  expect(classes('gx10-090e · claude · a')).toContain('dot-working');
  expect(classes('gx10-090e · claude · b')).toContain('dot-blocked');
  expect(classes('gx10-090e · claude · c')).toContain('dot-idle');
  expect(classes('gx10-090e · claude · d（已结束）')).toContain('st-ended');
  expect(classes('session e（已清除）')).toContain('st-purged');
});

test('a contribution whose session is purged is still a bar', () => {
  const project = detail({ created_at: '2026-10-26T12:00:00.000Z', contributions: [contribution({ session_key: 'claude:0123456789', session: null })] });
  render(<Timeline project={project} now={NOW} />);
  expect(screen.getByText('session 01234567（已清除）')).toBeTruthy();
});

test('the axis has five date marks, the last one 今天', () => {
  const project = detail({ created_at: '2026-10-26T12:00:00.000Z', contributions: [contribution()] });
  const { container } = render(<Timeline project={project} now={NOW} />);
  const marks = Array.from(container.querySelectorAll('.tl-tick')).map((el) => el.textContent);
  expect(marks).toHaveLength(5);
  expect(marks[4]).toBe('今天');
  const axis = container.querySelector('.tl-axis') as HTMLElement;
  expect(within(axis).getByText('今天')).toBeTruthy();
});
