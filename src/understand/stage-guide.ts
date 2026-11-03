// What each stage means, as the curator and the stage review read it. One text for both, so they judge alike.

/**
 * Bump when `STAGE_GUIDE` changes in a way that could move projects: every working project is then reviewed again
 * (see `restage.ts`). Projects made after a bump start at the new version, since the curator judged them under it.
 */
export const STAGE_RULES_VERSION = 1;

export const STAGE_GUIDE = [
  '阶段定义（按已经发生的事实判断，不按计划；拿不准时停在较早的阶段）：',
  '- idea：只提出了想法或问题，还没为它做过实际工作。',
  '- explore（探索）：已经开始实际工作（调研、读资料、读代码、做原型或小实验、比较方案），但方向或方案还没定。',
  '- build（构建）：方向已定（有选定的方案、设计或计划，或已经开始正式产出），主要在写代码、写文档、做产物、跑正式实验。',
  '- verify（验证）：主体已经做完，正在检验结果：跑测试或基准、等 PR 审查、实机验证、模拟盘观察、已投递等回复。',
  '- done（完成）：完成标准已满足，或用户明确说做完了。',
  '- parked（搁置）：用户明确决定暂停或以后再做。只是一段时间没动静不算搁置。',
  '- abandoned（放弃）：用户明确决定不做了，或方向被否定且不会再做。',
  '- merged（合并）：和另一个项目其实是同一件事，应该并进那个项目（带 merge_into）。',
  '不是写代码的项目（求职、投资、调研）同样适用：例如简历已投递、在等回复是 verify；方案已定、正在执行调仓是 build。',
  '',
  '怎么改阶段：',
  '- 往前推进（idea→explore→build→verify）直接生效，一次只能走一步；事实表明已经走到更后面时，连续调用 transition_stage，每次前进一步。',
  '- 回退、done、parked、abandoned、merged 不会直接生效，会变成给用户的确认题；只有摘要里有明确事实时才提。',
  '- 当前阶段已经符合事实就不要动。',
].join('\n');
