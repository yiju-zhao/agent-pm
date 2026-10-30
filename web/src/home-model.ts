import type { ProjectCard, QuestionView, SessionTag } from '../../src/domain/read.ts';
import { STAGES, STAGE_LABEL } from '../../src/shared/vocab.ts';
import type { Stage } from '../../src/shared/vocab.ts';

// What the home page decides from the read models. No React in here, so it is easy to test.

/** closed first, then the new-idea inbox, everything else is the main list. The server already sorted each group. */
export function groupProjects(cards: ProjectCard[]): { main: ProjectCard[]; inbox: ProjectCard[]; closed: ProjectCard[] } {
  const groups = { main: [] as ProjectCard[], inbox: [] as ProjectCard[], closed: [] as ProjectCard[] };
  for (const card of cards) {
    if (card.closed) groups.closed.push(card);
    else if (card.inbox) groups.inbox.push(card);
    else groups.main.push(card);
  }
  return groups;
}

/**
 * Pending questions only. A question about a session that belongs to no project yet is the tray's business (which
 * project is this session for?); every other one is a decision for the user.
 */
export function splitQuestions(questions: QuestionView[]): { needYou: QuestionView[]; attribution: QuestionView[] } {
  const needYou: QuestionView[] = [];
  const attribution: QuestionView[] = [];
  for (const question of questions) {
    if (question.status !== 'pending') continue;
    if (question.session_key !== null && question.project_id === null) attribution.push(question);
    else needYou.push(question);
  }
  return { needYou, attribution };
}

/**
 * The sessions on the project's current milestone, and all the others. A tag whose milestone is not the current one
 * (none, another one, or one that has been deleted) is "other": it is never dropped.
 */
export function sessionsByStep(card: ProjectCard): { current: SessionTag[]; other: SessionTag[] } {
  const currentId = card.current_milestone?.id ?? null;
  const current: SessionTag[] = [];
  const other: SessionTag[] = [];
  for (const session of card.active_sessions) {
    if (currentId !== null && session.milestone_id === currentId) current.push(session);
    else other.push(session);
  }
  return { current, other };
}

/** Quiet for a while, and still open: a closed project is finished, not asleep. */
export function isDormant(card: ProjectCard): boolean {
  return !card.closed && card.dormant_days !== null;
}

/** One column per stage, in lifecycle order; empty columns stay. A merged project has no column: it lives on in another. */
export function kanbanColumns(cards: ProjectCard[]): Array<{ stage: Stage; label: string; cards: ProjectCard[] }> {
  return STAGES.filter((stage) => stage !== 'merged').map((stage) => ({
    stage,
    label: STAGE_LABEL[stage],
    cards: cards.filter((card) => card.stage === stage),
  }));
}
