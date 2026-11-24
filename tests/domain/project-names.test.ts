import { expect, test } from 'vitest';
import { folderName, titleUsesName } from '../../src/domain/project-names.ts';

test('a folder names a project unless it is a home directory or a Paseo-made worktree', () => {
  expect(folderName('/home/yubaifeng/e84381970/projects/d-llm/diffusion-model')).toBe('diffusion-model');
  expect(folderName('/Users/eason/Developer/repos/agent-pm/')).toBe('agent-pm');
  expect(folderName('/Users/eason')).toBeNull();
  expect(folderName('/home/bz/.paseo/worktrees/1c9hkvaw/regal-rat')).toBeNull();
  expect(folderName('')).toBeNull();
  expect(folderName('/Users/eason/Developer')).toBeNull();
  expect(folderName('/Users/eason/Developer/repos')).toBeNull();
});

test('a title uses a name when it is the name or starts with it and a separator', () => {
  expect(titleUsesName('open-evo', 'open-evo')).toBe(true);
  expect(titleUsesName('Open-Evo：RSI 流水线', 'open-evo')).toBe(true);
  expect(titleUsesName('open-evo-plugin', 'open-evo')).toBe(false);
  expect(titleUsesName('演进平台', 'open-evo')).toBe(false);
});
