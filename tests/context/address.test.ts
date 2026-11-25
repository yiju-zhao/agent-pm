import { expect, test } from 'vitest';

import { formatAddress, parseAddress } from '../../src/context/address.ts';

test('a session address names the session', () => {
  expect(parseAddress('s:a3f9')).toEqual({ kind: 'session', session: 'a3f9' });
});

test('a turn address carries the turn number', () => {
  expect(parseAddress('s:a3f9#12')).toEqual({ kind: 'turn', session: 'a3f9', turn: 12 });
});

test('an item address carries the turn number and the item number', () => {
  expect(parseAddress('s:a3f9#12.3')).toEqual({ kind: 'item', session: 'a3f9', turn: 12, item: 3 });
});

test.each(['s:a3f9', 's:a3f9#12', 's:a3f9#12.3'])('formatting %s after parsing gives the same text', (text) => {
  expect(formatAddress(parseAddress(text))).toBe(text);
});

// Turn and item numbers start at 1, and a project id is not a session address.
test.each(['a3f9', 's:', 's:a3f9#', 's:a3f9#0', 's:a3f9#1.0', 's:a3f9#x', 's:a3f9#1.2.3', 'p_8f3a'])('%s is not an address', (text) => {
  expect(() => parseAddress(text)).toThrow();
});
