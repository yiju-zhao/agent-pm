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

// Who set a value is not shown anywhere; it lives in the events (actor) and the locks, and decides what the AI may do.

test('a priority the AI pre-filled is the field itself; once the user changes it the AI can only propose', () => {
  const id = t.ai('create_project', { title: '新课题', priority: 'P2' }).id as string;
  expect(getProject(t.db, new Date(NOW), id)!.priority).toBe('P2');
  expect(t.ai('update_project', { project: id, fields: { priority: 'P1' } }).status).toBe('applied');
  t.user('update_project', { project: id, fields: { priority: 'P0' } });
  expect(t.ai('update_project', { project: id, fields: { priority: 'P3' } }).status).not.toBe('applied');
  expect(getProject(t.db, new Date(NOW), id)!.priority).toBe('P0');
  const actors = (t.db.prepare(`SELECT actor FROM events WHERE project_id = ? AND op IN ('create_project', 'update_project') ORDER BY id`).all(id) as Array<{ actor: string }>).map((r) => r.actor);
  expect(actors.slice(0, 3)).toEqual(['ai:curator', 'ai:curator', 'user']);
});

test('a new project starts under the current board rules', () => {
  const id = t.user('create_project', { title: '手建的' }).id as string;
  expect((t.db.prepare('SELECT stage_rules_seen FROM projects WHERE id = ?').get(id) as { stage_rules_seen: number }).stage_rules_seen).toBe(BOARD_RULES_VERSION);
});
