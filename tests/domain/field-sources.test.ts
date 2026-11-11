import { afterEach, beforeEach, expect, test } from 'vitest';
import { getProject } from '../../src/domain/read.ts';
import { BOARD_RULES_VERSION } from '../../src/shared/vocab.ts';
import { NOW, setup } from './helpers.ts';
import type { Setup } from './helpers.ts';

let t: Setup;
beforeEach(() => {
  t = setup();
});
afterEach(() => t.db.close());

const sources = (id: string) => getProject(t.db, new Date(NOW), id)!.field_sources;

test('an AI-made project with an AI priority reads as pre-filled; the user changing either makes it theirs', () => {
  const id = t.ai('create_project', { title: '新课题', priority: 'P2' }).id as string;
  expect(sources(id)).toEqual({ stage: 'ai', priority: 'ai' });
  t.ai('transition_stage', { project: id, stage: 'explore' });
  expect(sources(id).stage).toBe('ai');
  t.user('transition_stage', { project: id, stage: 'build' });
  t.user('update_project', { project: id, fields: { priority: 'P0' } });
  expect(sources(id)).toEqual({ stage: 'user', priority: 'user' });
  // The AI can no longer change the user's priority directly: it only proposes.
  expect(t.ai('update_project', { project: id, fields: { priority: 'P3' } }).status).not.toBe('applied');
  expect(getProject(t.db, new Date(NOW), id)!.priority).toBe('P0');
});

test('no priority is no source; a new project starts under the current board rules', () => {
  const id = t.user('create_project', { title: '手建的' }).id as string;
  expect(sources(id)).toEqual({ stage: 'user', priority: null });
  expect((t.db.prepare('SELECT stage_rules_seen FROM projects WHERE id = ?').get(id) as { stage_rules_seen: number }).stage_rules_seen).toBe(BOARD_RULES_VERSION);
});
