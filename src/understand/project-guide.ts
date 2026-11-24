/**
 * What a project is on this board and how its text is written. Shared by every prompt that creates, describes or
 * regroups projects, so the digester, the curator, the project review and the merge draft apply one standard.
 */
export const PROJECT_GUIDE = [
  '项目的定义与写法：',
  '- 一个项目 = 一个可以独立验收的目标：能说清"交付什么、给谁用、做到什么算完成"。仓库、目录、工具、session 数量、对话里的话题都不决定项目边界。',
  '- 同一个目标跨多个 session、多台机器、多个 agent，仍是一个项目；一个 session 做了两个互不依赖的目标，就分别贡献给两个项目。',
  '- 同一个仓库里可以有多个项目，只要它们各自能独立验收。',
  '- 为某个已有目标服务的 feature、bug 修复、调研、重构、测试、部署，是那个项目的里程碑或 todo，不是新项目。只有既有项目都不以它为目标、且它自己能独立验收时才是新项目。',
  '- 项目是相对系统、长期的工作，不是一次对话的话题。标题以 session 所在的项目名为准（Paseo 的项目名，即仓库名，用户已经起好了），原样使用，不另起名字、不翻译。',
  '- 同一仓库里确实有两个可独立验收的目标时，写成「项目名：目标」区分，目标部分写交付对象或结果（名词短语），不写过程、不写"讨论/修复/调研某某"式的会话标题。',
  '- 只有对话内容与所在项目名明显无关（例如在 home 目录里做的另一件事）时，才另起名字。',
  '- 简介（summary）：为谁解决什么问题、范围到哪里、预期结果是什么。',
  '- 为什么（why）：这件事的价值或动因；对话里没有依据就不写。',
  '- 完成标准（done_criteria）：逐条可验证的结果（能被测试、演示或核对），不写"做好""优化"这类无法验证的话。',
  '- 只写证据支持的内容。证据没有说明的事实明确标为未知，不编造进度、结论或完成状态。',
].join('\n');
