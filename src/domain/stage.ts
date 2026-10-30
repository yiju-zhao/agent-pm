import { OpRejected } from './types.ts';
import type { Stage } from './types.ts';

/** The working stages, in order. The AI may move a project one step forward along them. */
export const FLOW = ['idea', 'explore', 'build', 'verify'] as const;

/** Stages that end a project; only the user may reopen one. */
export const CLOSED: Stage[] = ['done', 'abandoned', 'merged'];

/** True only for one step forward: idea→explore, explore→build, build→verify. */
export function aiMayTransition(from: Stage, to: Stage): boolean {
  const i = (FLOW as readonly Stage[]).indexOf(from);
  return i >= 0 && i < FLOW.length - 1 && FLOW[i + 1] === to;
}

/**
 * Rejects (`invalid`) a transition that can never be valid: to the current stage, to `merged` without a target, or
 * a target without `merged`. Any other transition is allowed for the user, including reopening a closed project.
 */
export function checkTransition(from: Stage, to: Stage, mergeInto?: string): void {
  if (from === to) throw new OpRejected('invalid', `the project is already in stage ${to}`);
  if (to === 'merged' && !mergeInto) throw new OpRejected('invalid', 'merging needs merge_into');
  if (mergeInto && to !== 'merged') throw new OpRejected('invalid', 'merge_into is only allowed with stage merged');
}
