// Shared by the server and the browser bundle: no imports, so it can run anywhere.

export const STAGES = ['idea', 'explore', 'build', 'verify', 'done', 'parked', 'abandoned', 'merged'] as const;
export type Stage = (typeof STAGES)[number];

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

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
