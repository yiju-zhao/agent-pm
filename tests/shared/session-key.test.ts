import { expect, test } from 'vitest';
import { assignShortIds, makeSessionKey, parseSessionKey, pendingKey } from '../../src/shared/session-key.ts';

test('native key', () => {
  expect(makeSessionKey('claude', '5d27595b-908e-4fe5-9283-890acdbd075f'))
    .toBe('claude:5d27595b-908e-4fe5-9283-890acdbd075f');
  expect(parseSessionKey('codex:01a1883e-7f9e')).toEqual({ kind: 'native', agentKind: 'codex', nativeId: '01a1883e-7f9e' });
});
test('pending key', () => {
  expect(pendingKey('gx10-090e', 'term_65e13dfbb5fca2')).toBe('pending:gx10-090e:term_65e13dfbb5fca2');
  expect(parseSessionKey('pending:gx10-090e:term_65e13dfbb5fca2'))
    .toEqual({ kind: 'pending', machine: 'gx10-090e', terminalId: 'term_65e13dfbb5fca2' });
});
test('short ids are 8 chars and grow on collision', () => {
  const m = assignShortIds(['claude:0d67da1f-aaaa', 'claude:0d67da1f-bbbb', 'codex:1f68fc9b-cccc']);
  expect(m.get('claude:0d67da1f-aaaa')).toBe('0d67da1f-a');
  expect(m.get('claude:0d67da1f-bbbb')).toBe('0d67da1f-b');
  expect(m.get('codex:1f68fc9b-cccc')).toBe('1f68fc9b');
});
test('pending sessions get short id from terminal id', () => {
  expect(assignShortIds(['pending:gx10-090e:term_65e13dfbb5fca2']).get('pending:gx10-090e:term_65e13dfbb5fca2')).toBe('term_65e');
});
