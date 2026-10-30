import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as types from '../../src/domain/types.ts';
import * as vocab from '../../src/shared/vocab.ts';

test('vocab.ts has no imports', () => {
  const text = readFileSync(new URL('../../src/shared/vocab.ts', import.meta.url), 'utf8');
  expect(text).not.toMatch(/^\s*import\s/m);
});

test('types.ts re-exports the same objects', () => {
  expect(types.STAGES).toBe(vocab.STAGES);
  expect(types.STAGE_LABEL).toBe(vocab.STAGE_LABEL);
  expect(types.PRIORITIES).toBe(vocab.PRIORITIES);
});
