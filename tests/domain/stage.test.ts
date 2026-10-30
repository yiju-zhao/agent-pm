import { expect, test } from 'vitest';
import { aiMayTransition, checkTransition, CLOSED, FLOW } from '../../src/domain/stage.ts';
import { OpRejected, STAGES } from '../../src/domain/types.ts';

function rejection(fn: () => void): OpRejected {
  try {
    fn();
  } catch (e) {
    if (e instanceof OpRejected) return e;
    throw e;
  }
  throw new Error('expected an OpRejected');
}

test('flow and closed stages', () => {
  expect(FLOW).toEqual(['idea', 'explore', 'build', 'verify']);
  expect(CLOSED).toEqual(['done', 'abandoned', 'merged']);
});

test('ai may only step forward along idea→explore→build→verify', () => {
  expect(aiMayTransition('idea', 'explore')).toBe(true);
  expect(aiMayTransition('explore', 'build')).toBe(true);
  expect(aiMayTransition('build', 'verify')).toBe(true);
  expect(aiMayTransition('idea', 'build')).toBe(false);
  expect(aiMayTransition('verify', 'done')).toBe(false);
  expect(aiMayTransition('build', 'explore')).toBe(false);
  expect(aiMayTransition('explore', 'parked')).toBe(false);
  expect(aiMayTransition('parked', 'explore')).toBe(false);
  expect(aiMayTransition('done', 'idea')).toBe(false);
  expect(aiMayTransition('idea', 'idea')).toBe(false);
});

test('ai may make exactly three transitions', () => {
  const allowed = STAGES.flatMap((from) => STAGES.filter((to) => aiMayTransition(from, to)).map((to) => `${from}→${to}`));
  expect(allowed).toEqual(['idea→explore', 'explore→build', 'build→verify']);
});

test('merged requires merge_into and merge_into requires merged', () => {
  expect(rejection(() => checkTransition('build', 'merged'))).toMatchObject({ code: 'invalid' });
  expect(rejection(() => checkTransition('build', 'done', 'p_2'))).toMatchObject({ code: 'invalid' });
  expect(() => checkTransition('build', 'merged', 'p_2')).not.toThrow();
});

test('a transition to the current stage is invalid', () => {
  for (const stage of STAGES) {
    expect(rejection(() => checkTransition(stage, stage, stage === 'merged' ? 'p_2' : undefined))).toMatchObject({ code: 'invalid' });
  }
});

test('any other transition passes the check, including reopening a closed project', () => {
  for (const from of STAGES) {
    for (const to of STAGES) {
      if (from === to) continue;
      expect(() => checkTransition(from, to, to === 'merged' ? 'p_2' : undefined)).not.toThrow();
    }
  }
});
