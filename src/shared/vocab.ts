// Shared by the server and the browser bundle: no imports, so it can run anywhere.

export const STAGES = ['idea', 'explore', 'build', 'verify', 'done', 'parked', 'abandoned', 'merged'] as const;
export type Stage = (typeof STAGES)[number];

/** Highest first: P0 is the most urgent. Sorting by this array's order sorts by importance. */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Short names, as the board shows them next to the code. */
export const PRIORITY_LABEL: Record<Priority, string> = { P0: '最高', P1: '高', P2: '中', P3: '低' };

/**
 * What each priority means: the one definition the curator, the stage review, the web UI and the agent-pm skill
 * (skills/agent-pm/SKILL.md, which repeats it for agents) all use.
 */
export const PRIORITY_MEANING: Record<Priority, string> = {
  P0: '阻塞其他工作或有硬期限，现在就要做',
  P1: '当前主线，本周要推进',
  P2: '重要但不紧急，排进计划',
  P3: '可选，有空再做',
};

export const STAGE_LABEL: Record<Stage, string> = {
  idea: 'idea',
  explore: '探索',
  build: '构建',
  verify: '验证',
  done: '完成',
  parked: '搁置',
  abandoned: '放弃',
  merged: '合并',
};

/**
 * The version of the board rules (stage and priority definitions) a project was last judged under. Bump it when the
 * rules change in a way that could move projects: every working project is then reviewed once more. A new project is
 * stamped with the current version, since it is made under the current rules.
 */
// 2: priorities defined, and the review pre-fills a missing one. 3: the review is shown which priorities are missing
// (under 2 it was not, and filled none), so every working project is reviewed once more.
export const BOARD_RULES_VERSION = 3;
