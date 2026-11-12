# agent-pm 界面设计

使用 [Hallmark Coral](https://github.com/nutlope/hallmark/blob/main/skills/hallmark/references/themes/coral.md) 的 app screen 规范。暖灰底、纸白内容面、深色正文；珊瑚色用于选中状态、焦点与里程碑进度。业务错误和 session 状态沿用语义颜色。

## 共同规则

- 所有颜色、字体和间距引用 `web/src/tokens.css`，基础可访问性规则在 `base.css`，组件样式在 `styles.css`。
- 使用本地系统字体显示中文，不请求外部字体或图片；不把营销页的纹理、动画和插画搬进工作界面。
- 内容最大宽度 1440px。只保留三个顶栏目的地：首页、Session、API Keys。
- 桌面控件高 36px，手机主要操作高 44px。焦点立即可见，遵循 reduced motion 设置。
- 网页使用管理员账号与密码登录，API key 只出现在机器凭据管理页；账号页提供改密和退出。
- 编辑阶段、优先级后直接保存；API、权限、失败提示与撤销逻辑保留，界面不展示 AI 来源标记。

## 页面

- 首页：项目是主体，标题与阶段分栏，摘要、里程碑、下一步依次阅读；右侧是待决策和待归属队列。手机上右栏回到文档流下方。
- 看板：列内横向滚动，页面本身不横向滚动。保持原有阶段和项目排序。
- 详情：返回所有项目、标题与优先级、阶段；主栏承载概览与工作项，右栏承载阻塞和决策，下方保留 session 时间线及事件日志。
- Session、API Keys 与设置共享相同字体、控件、边框和间距；表格和表单在手机上重排。

## 验证

运行 `npm run typecheck`、`npm run build:web` 与 `npm test -- tests/web`。浏览器验证使用 `scripts/seed-demo.ts` 生成的独立数据库；不得为视觉检查修改真实项目。Hallmark 检查使用 `--scope app --render --kept`，包含首页、详情、Session、API Keys。
