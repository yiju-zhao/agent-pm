import { expect, test } from 'vitest';
import { defaultDeps, isAi, OpRejected, PRIORITIES, STAGE_LABEL, STAGES } from '../../src/domain/types.ts';

test('stage labels cover every stage', () => {
  expect(Object.keys(STAGE_LABEL).sort()).toEqual([...STAGES].sort());
  expect(STAGE_LABEL).toEqual({
    idea: 'idea',
    explore: '探索',
    build: '构建',
    verify: '验证',
    done: '完成',
    parked: '搁置',
    abandoned: '放弃',
    merged: '合并',
  });
  expect(PRIORITIES).toEqual(['P0', 'P1', 'P2', 'P3']);
});

test('isAi tells the user from an ai actor', () => {
  expect(isAi('user')).toBe(false);
  expect(isAi('ai:curator')).toBe(true);
});

test('defaultDeps generates prefixed random ids and real time', () => {
  const deps = defaultDeps();
  const a = deps.newId('p');
  const b = deps.newId('p');
  expect(a).toMatch(/^p_[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
  expect(deps.newId('q')).toMatch(/^q_[0-9a-f]{12}$/);
  expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(1000);
});

test('OpRejected is an Error carrying its code', () => {
  const err = new OpRejected('vetoed', 'the user deleted this');
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(OpRejected);
  expect(err.code).toBe('vetoed');
  expect(err.message).toBe('the user deleted this');
  expect(err.name).toBe('OpRejected');
});
