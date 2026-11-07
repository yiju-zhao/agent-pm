import { expect, test } from 'vitest';
import { assignShortIds, crossMachineKey, makeSessionKey, paseoPendingKey, parseSessionKey, pendingKey } from '../../src/shared/session-key.ts';

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
test('paseo pending keys have their own namespace and take the short id from the agent id', () => {
  const key = paseoPendingKey('srv_abc', '2757b19f-28e4-48d0-af8b-fa896a688471');
  expect(key).toBe('paseo-pending:srv_abc:2757b19f-28e4-48d0-af8b-fa896a688471');
  expect(parseSessionKey(key)).toEqual({ kind: 'source_pending', source: 'paseo', serverId: 'srv_abc', agentId: '2757b19f-28e4-48d0-af8b-fa896a688471' });
  expect(assignShortIds([key]).get(key)).toBe('2757b19f');
  expect(() => parseSessionKey('paseo-pending:srv_abc')).toThrow();
});
test('a cross-machine key stays apart from the plain native key, and short ids stay distinct', () => {
  const plain = makeSessionKey('claude', '0d67da1f-aaaa');
  const other = crossMachineKey('claude', '0d67da1f-aaaa', 'gx10-090e');
  expect(other).toBe('claude:0d67da1f-aaaa@gx10-090e');
  expect(parseSessionKey(other)).toEqual({ kind: 'native', agentKind: 'claude', nativeId: '0d67da1f-aaaa@gx10-090e' });
  const ids = assignShortIds([plain, other]);
  expect(ids.get(plain)).not.toBe(ids.get(other));
});
