# 核心质量：实施状态

更新：2026-11-14。基线 `a419583`。

**提交**：分支 `feat/core-quality`，已快进到本地 `master`：`2d6f55e`（此前会话留下的界面改动，原样提交）、`7232614`（本任务）。**未推送到 GitHub**（推送被权限检查拦下，留给用户执行 `git push origin master`）。

**部署（2026-11-14 04:16Z，仅 mac-mini）**：
- 部署前用 `sqlite3 .backup` 备份生产库到 `~/.config/herdr-pm/backups/herdr-pm-before-core-quality-2026-11-14T04-15-34Z.db`（完整性检查 ok，schema v9）。
- 运行目录 `repos/herdr-pm` 从本地仓库快进到 `7232614`，`npm run build:web`，重启 `ai.agent-pm.server`：`/status` 200，数据库迁移到 v10，`/coverage` 返回 7 个来源，合并预览路由在线，网页为新构建。
- 重启 `ai.agent-pm.paseo-collector.paseo-mac-mini`：心跳正常、daemon connected、无错误。
- **没有部署**：mac-mini 的 herdr 采集器二进制（本机没有 bun，无法构建）；gx10-090e、gx10-c757 的 Paseo 采集器和 herdr 采集器；笔记本的 herdr 采集器。这些机器上关窗补读、长消息保留首尾、Paseo 字节预算和长归档续读仍是旧行为。新中心与旧采集器协议兼容。

## 已实现并验证的行为

### 采集

| 行为 | 位置 | 验证 |
| --- | --- | --- |
| Paseo 批次按 UTF-8 字节计预算 | `src/paseo-collector/timeline.ts` | `pipeline.test.ts`：中文+emoji 大消息经 HTTP 入库，游标到 4 |
| Herdr 关窗后补读尾部，不恢复 live | `src/collector/loop.ts` | `loop.test.ts`：失败重试、重启、幂等 |
| 已读完的关闭 session 每轮只做一次 stat，不问中心 | 同上 | `loop.test.ts`：重启后 3 轮 0 次 offset 请求；文件增长后再读（先红后绿） |
| Paseo 归档超过单步 2000 轮：保持 catching_up、释放执行槽、有进展才立即续读；读完才 current/finalRead | `src/paseo-collector/loop.ts` | `collector.test.ts`：2002 条 pageLimit=1，断言层红灯 2000≠2002 后转绿；入库恰 2002 条（无重复） |
| Herdr 长消息保留首尾共 16000 字符并标注省略量（原为只留前 4000） | `src/collector/normalize.ts` | `normalize.test.ts`：结尾结论保留、省略量准确、不拆代理对 |
| 按来源的覆盖核验 `GET /coverage` + Session 页面板 | `src/server/coverage.ts`、`content-cuts.ts`、`web/src/components/coverage-panel.tsx` | `coverage.test.ts`（真实 ingest 路由）、`pipeline.test.ts`（Paseo 全链路）、`coverage-panel.test.tsx` |

单事件上限复核（未改代码）：批次预算 300 KiB 只在已有事件时切分，所以一个请求最大是「一个超大事件」。消息上限 64 KiB 字符，中文 3 字节/字符约 197 KB；工具事件输入、输出、错误各 16 KiB 字符。只有整段都是需转义成 `\u00XX` 的控制字符（6 字节/字符，约 393 KB）才接近 512 KiB 上限，仍在限内。信封字段不计入预算，余量约 200 KiB。

### 项目理解与合并

| 行为 | 位置 | 验证 |
| --- | --- | --- |
| 合并范围解析、关联变化计划、输入签名、确定性应用（`apply_merge`，仅用户） | `src/domain/merge.ts`、`links-ops.ts`（`carrySessionLink`） | `tests/domain/merge.test.ts` 10 项 |
| 旧的 `/stage` 合并也在同一事件里确定性关联来源 session | `src/domain/projects-ops.ts` | 同上 |
| 依据已存正文（非摘要）生成带证据引用的结构化草稿；长历史分段提取再汇总；覆盖与缺口记录 | `src/understand/merge-preview.ts` | `tests/server/merge-routes.test.ts` 9 项 |
| 预览/查看/应用路由，异步生成，重启后未完成的预览标记失败 | `src/server/merge-routes.ts`、`http.ts`、`cli.ts` | 同上；`domain-routes.test.ts` 的写路由鉴权表 |
| 合并对话框：目标、整项目/选 session、预览、锁定字段逐项确认、过期/失败处理 | `web/src/components/merge-dialog.tsx`、`stage-control.tsx` | `merge-dialog.test.tsx` 5 项、`stage-control.test.tsx`、`project.test.tsx` |
| 统一的项目定义与写法进入摘要员、整理员、项目整理提示词 | `src/understand/project-guide.ts`、`digest.ts`、`curate.ts`、`project-review.ts` | 现有提示词/流程测试通过；质量见下 |

## 测试、构建、浏览器

- `npm test`：1612 通过，4 跳过（94 个文件中 1 个跳过，为需要真实模型的 live 测试）。
- `npm run typecheck`、`npm run build:web`：通过。
- 浏览器（agent-browser，`seed:demo` 生成的临时库 + `.scratch/core-quality/verify-server.ts` 脚本模型，端口 8799）：登录 → 项目页选「合并」→ 对话框选目标与单个 session → 生成中提示（期间目标项目未变）→ 预览显示草稿、锁定标题需勾选、关联变化、来源保留、证据范围 → 应用后目标文字与关联变化、锁定的标题保留、来源仍在；整项目合并经界面确认后来源为 merged；在事件日志里撤销后来源恢复 build、目标关联恢复。Session 页覆盖面板显示从未上报的来源与只有屏幕快照的缺口。
  - 过程中发现并修复：预览较长时「确认合并」在滚动区域之外，改为操作栏吸底。
  - 说明：部分合并那一次的「确认」是通过 API 触发的（自动化脚本的元素定位点到了对话框本身）；整项目合并的确认和撤销是在界面上点击完成的。

## 质量案例（真实模型）

`node .scratch/core-quality/quality-cases.ts`，模型 `claude-sonnet-5-5`，合成会话（非真实数据），4/4 通过：

1. 尾部决定推翻早先目标：草稿采用「只读对账、不自动补采」，并引用了含最终决定的 chunk。
2. 部分合并隔离：未选 session 的「登录页」内容没有出现在草稿里。
3. 同一目标跨 session、旧标题是会话式的：标题改为交付对象，不沿用旧标题。
4. 证据没说的不编造：没有声称真机验证通过，列出了未知事项。

这只证明这 4 个案例；没有对整理员日常建项目（`curate`）做真实模型评测，不能据此说聚类质量已达标。

## 真实来源只读对账（2026-11-13 21:03Z）

方法：只读打开生产库（`readOnly`，不跑迁移），用 `coverage.ts` 同一套统计；另用本机 Paseo 列表核对 6 个 agent。未输出任何凭证。

| 来源 | 状态 | 发现 | 有正文 | 备注 |
| --- | --- | --- | --- | --- |
| herdr:gx10-090e | **离线，最后心跳 2026-11-07** | 7 | 7 | 26 段中 10 段有消息被截断；1 个仅屏幕 |
| herdr:gx10-c757 | 在线 | 12 | 8（2 个无正文） | 315 段中 6 段消息被截断；4 个仅屏幕 |
| herdr:laptop | 在线 | 4 | 4 | 171 段中 24 段消息被截断 |
| herdr:mac-mini | 在线 | 15 | 12（1 个无正文） | 289 段中 24 段消息被截断；5 个仅屏幕 |
| paseo-gx10-090e | 在线 | 16 | 16 | 9 个已关闭未加载（只到关闭前读到的位置）；epoch_replaced 缺口 7 处 |
| paseo-gx10-c757 | 在线 | 2 | 2 | 2 个已关闭未加载 |
| paseo-mac-mini | 在线 | 14 | 14 | 2 个已关闭未加载；epoch_replaced 缺口 11 处 |

- 全库 63 个 session，3 个没有任何正文；2 个 session 处于上游拒绝隔离。
- 本机 Paseo 对账（仅 `agent-pm` 工作目录下 6 个 agent）：5 个在中心有记录和游标；**1 个不在中心**（`7a2b30cc`，2026-11-04 创建、11-11 归档，早于采集器首次观察且默认不导入已有归档）。这是「采集器没见过的历史不会被发现」的一个真实例子。
- 未核验：gx10-090e、gx10-c757、laptop 上 daemon / transcript 目录与中心的逐项对账（未登录这些机器）；本机 Paseo 其他工作目录的 agent；所有机器上 herdr 从未观察到的历史 session；游标位置与各 transcript 实际长度的逐一比对。
- 上表是部署前的统计；部署情况见文首。

## 历史证据能否恢复

- Herdr：约 64 段正文里有消息被旧规则截到 4000 字符，中心没有被截掉的部分。原始 transcript 若仍在各机器上则理论上可回读，但**没有实现补采**：直接重读会与已存的 `(session_key, offset_start)` 冲突而被当作重复丢弃，需要单独设计（例如带版本的重采集批次）。目前只以「采集时被截断」计数呈现。
- Herdr 工具结果从未采集，工具调用只有 200 字符摘要：不可从中心恢复。
- Paseo：中心在 `source_events` 保留有上限的事件副本（消息 64 KiB，工具输入输出各 16 KiB），chunk 是其节选。合并草稿目前读的是 chunk（节选），没有读 `source_events` 的更完整副本，覆盖里以「节选段数」标出。
- Paseo 已关闭/未加载的 agent：关闭后的内容不读（避免唤醒 agent），采集器启动前已归档的不导入：均为明确的范围限制，不是可自动恢复的缺口。

## 剩余问题

- 历史截断内容的可追踪补采未实现（只有缺口状态）。
- 合并草稿对 Paseo session 读节选而非完整事件副本。
- 预览不生成里程碑/todo 计划：这部分仍由确认后的项目整体整理完成（预览里有文字说明）。
- 部分合并后来源项目的描述不在预览中重写，由确认后自动排队的来源项目整理处理；整理结束前来源的旧描述可能仍提到已迁出的工作。
- 预览的证据范围里，目标项目已有 session 显示为 session key 而不是标题。
- 没有新增「合并预览」专用的模型设置，沿用整理员模型，`llm_runs.role` 记为 `curate`。
- 根 `AGENTS.md`、`CONTEXT.md`、完整 Matt setup 配套文件未创建。
- 整理员日常聚类的真实模型质量评测未做。

## 双轴审查（Standards / Spec）

两个独立子代理只审本任务的增量。已处理：路由改用 `domain-routes` 的 `readBody` / `rejectStatus`；过期判定只保留 `currentSignature` 一处；提交按钮放入表单；预览失败/轮询失败/重新生成失败都有可见提示，轮询结果按预览 id 丢弃过期响应，生成中可关闭；同一时间只生成一份预览；完成标准单条上限 300 字符；签名加入关联的摘要与时间范围；草稿允许 `why`、完成标准留空且不覆盖原值；旧的 `/stage` 合并不再恢复用户取消过的关联，预览路径把这种恢复单独标出；全选 session 的部分合并给出提示；覆盖核验加入已忽略数和界面创建的 herdr 密钥对应的来源；归档续读测试增加中途状态与批次数断言。未处理的取舍记在 `issues/03-merge-preview.md`。

## 界面优化（2026-11-14）

合并对话框：顶部步骤指示（选择范围 / 预览并确认）、范围用可选卡片、session 列表带全选与已选计数、草稿按字段成卡片（改写 / 与现在相同 / 你锁定过 标签，旧内容以引用样式显示）、关联变化与证据范围用状态标签、生成中有进度提示、操作栏与标题吸附在滚动区域上下、目标项目已有的 session 显示标题而不是 key。采集覆盖面板：折叠标题显示来源数与需要关注数，展开为来源卡片（状态点、四个数字、缺口列表、采集不到的范围）。用临时库在浏览器里看过两处的实际效果。其他页面没有改。

## 采集器升级（2026-11-15 05:36–05:42Z）

- 本机装了 bun 1.4.4（Homebrew），用 `scripts/build-collector.sh` 从 `003eaba` 构建 macOS 与 Linux arm64 两个二进制（macOS 版已重新签名）。
- mac-mini：`~/.local/bin/herdr-pm` 换成新二进制（旧的在 `~/.config/herdr-pm/backups/herdr-pm-binary-before-core-quality-20261115`），重启 `ai.agent-pm.collector`，心跳正常。
- gx10-c757、gx10-090e：通过各自 daemon 的 Paseo 终端（mac-mini 到这两台的 SSH 仍被拒），从 mac-mini 的临时 Tailscale 文件服务下载并校验 SHA-256，Paseo 采集器切到 `releases/003eaba`，herdr 采集器二进制替换（旧版本、旧 `runtime.conf` 都保留），重启后两个服务 active、NRestarts=0。临时文件服务、远程终端、两边下载的文件都已清理。
- 升级后中心看到：3 个 Paseo 来源 connected、无错误；herdr mac-mini、gx10-c757、laptop 心跳正常。
- **gx10-090e 的 herdr 来源仍然没有心跳**：原因不是采集器，而是那台机器上没有运行 herdr 服务（日志反复报 `server_not_running`），采集器拿不到快照就不上报。没有替用户启动 herdr。
- **笔记本没有升级**：笔记本没有可达的 Paseo daemon（6767 端口拒绝连接），从 mac-mini 无法操作。它的 herdr 采集器仍是旧版本；要升级需在笔记本上把新二进制放到 `~/.local/bin/agent-pm`（或其采集器实际使用的路径）并重启采集器服务。
