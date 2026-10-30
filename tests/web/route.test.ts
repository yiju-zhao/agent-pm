import { expect, test } from 'vitest';
import { parseHash } from '../../web/src/route.ts';

test('the empty hash and #/ are the home page', () => {
  expect(parseHash('')).toEqual({ page: 'home' });
  expect(parseHash('#')).toEqual({ page: 'home' });
  expect(parseHash('#/')).toEqual({ page: 'home' });
});

test('#/sessions is the sessions page', () => {
  expect(parseHash('#/sessions')).toEqual({ page: 'sessions' });
});

test('#/p/<id> is a project page, with the id decoded', () => {
  expect(parseHash('#/p/p_1')).toEqual({ page: 'project', id: 'p_1' });
  expect(parseHash('#/p/p_1/')).toEqual({ page: 'project', id: 'p_1' });
  expect(parseHash('#/p/a%2Fb%20c')).toEqual({ page: 'project', id: 'a/b c' });
  expect(parseHash('#/p/%E9%A1%B9%E7%9B%AE')).toEqual({ page: 'project', id: '项目' });
});

test('anything unrecognised is the home page', () => {
  for (const hash of ['#/p', '#/p/', '#/p/a/b', '#/nowhere', '#/sessions/x', '#p/p_1', '#/p/%E0%A4%A', 'garbage']) {
    expect(parseHash(hash)).toEqual({ page: 'home' });
  }
});
