import { expect, test } from 'vitest';
import { groupProjects, isDormant, kanbanColumns, sessionsByStep, splitQuestions } from '../../web/src/home-model.ts';
import { card, question, tag } from './fixtures.ts';

const ids = (cards: Array<{ id: string }>) => cards.map((c) => c.id);

test('groupProjects: closed wins over inbox, inbox wins over main, and every group keeps the server order', () => {
  const groups = groupProjects([
    card({ id: 'a' }),
    card({ id: 'b', inbox: true }),
    card({ id: 'c', inbox: true, closed: true }),
    card({ id: 'd', closed: true }),
    card({ id: 'e' }),
    card({ id: 'f', inbox: true }),
  ]);
  expect(ids(groups.main)).toEqual(['a', 'e']);
  expect(ids(groups.inbox)).toEqual(['b', 'f']);
  expect(ids(groups.closed)).toEqual(['c', 'd']);
});

test('groupProjects: no projects, no groups', () => {
  expect(groupProjects([])).toEqual({ main: [], inbox: [], closed: [] });
});

test('splitQuestions: only pending ones are kept', () => {
  const { needYou, attribution } = splitQuestions([
    question({ id: 'q_1' }),
    question({ id: 'q_2', status: 'answered' }),
    question({ id: 'q_3', status: 'withdrawn', session_key: 'claude:x', project_id: null }),
    question({ id: 'q_4', status: 'expired' }),
  ]);
  expect(ids(needYou)).toEqual(['q_1']);
  expect(attribution).toEqual([]);
});

test('splitQuestions: a session question with no project is an attribution; with a project it is for you', () => {
  const { needYou, attribution } = splitQuestions([
    question({ id: 'q_1', session_key: 'claude:x', project_id: null }),
    question({ id: 'q_2', session_key: 'claude:x', project_id: 'p_1' }),
    question({ id: 'q_3', session_key: null, project_id: 'p_1' }),
    question({ id: 'q_4', session_key: null, project_id: null }),
  ]);
  expect(ids(attribution)).toEqual(['q_1']);
  expect(ids(needYou)).toEqual(['q_2', 'q_3', 'q_4']);
});

test('sessionsByStep: sessions of the current milestone go first, all others (incl. unset) after', () => {
  const current = tag({ key: 'claude:1', milestone_id: 'm_2' });
  const unset = tag({ key: 'claude:2', milestone_id: null });
  const elsewhere = tag({ key: 'claude:3', milestone_id: 'm_1' });
  const split = sessionsByStep(
    card({ current_milestone: { id: 'm_2', title: '接入负载', status: 'doing' }, active_sessions: [current, unset, elsewhere] }),
  );
  expect(split.current).toEqual([current]);
  expect(split.other).toEqual([unset, elsewhere]);
});

test('sessionsByStep: a tag pointing at a milestone that no longer exists lands in other, not nowhere', () => {
  const gone = tag({ key: 'claude:gone', milestone_id: 'm_deleted' });
  const split = sessionsByStep(
    card({ current_milestone: { id: 'm_2', title: '接入负载', status: 'doing' }, active_sessions: [gone] }),
  );
  expect(split).toEqual({ current: [], other: [gone] });
});

test('sessionsByStep: without a current milestone everything is other', () => {
  const a = tag({ key: 'claude:a', milestone_id: 'm_1' });
  const b = tag({ key: 'claude:b', milestone_id: null });
  expect(sessionsByStep(card({ current_milestone: null, active_sessions: [a, b] }))).toEqual({ current: [], other: [a, b] });
});

test('isDormant: only a live project with dormant days', () => {
  expect(isDormant(card({ dormant_days: 9 }))).toBe(true);
  expect(isDormant(card({ dormant_days: null }))).toBe(false);
  expect(isDormant(card({ dormant_days: 9, closed: true }))).toBe(false);
});

test('kanbanColumns: seven columns in a fixed order, empty ones kept, merged shown nowhere', () => {
  const columns = kanbanColumns([
    card({ id: 'a', stage: 'build' }),
    card({ id: 'b', stage: 'merged', closed: true }),
    card({ id: 'c', stage: 'idea' }),
    card({ id: 'd', stage: 'build' }),
    card({ id: 'e', stage: 'abandoned', closed: true }),
  ]);
  expect(columns.map((c) => c.stage)).toEqual(['idea', 'explore', 'build', 'verify', 'done', 'parked', 'abandoned']);
  expect(columns.map((c) => c.label)).toEqual(['idea', '探索', '构建', '验证', '完成', '搁置', '放弃']);
  expect(columns.map((c) => ids(c.cards))).toEqual([['c'], [], ['a', 'd'], [], [], [], ['e']]);
});
