# agent-pm 两项核心能力：审计与实施草案

日期：2026-11-12。状态：审计完成。2026-11-13 更新：用户已确认本地 Markdown tracker、按可独立验收目标聚类、部分合并/整项目合并语义与预览要求（见 spec.md），实现已进行，现状见 status.md；下文“建议”“待确认”“尚未发布”的表述保留为审计当时的记录。

## 用户目标

1. 全面收集 Paseo 和 Herdr session 的信息，能够核验是否收齐。
2. 专业地提取和聚类项目，生成好的标题和描述。项目合并必须回到原始数据重新理解；支持 session 粒度选择，并在生效前预览新项目。
3. 使用 Matt Pocock skills 规范和推进。

## 已读取的工作流

本机技能源：`/Users/eason/Developer/repos/onesent-workspace/.agents/skills/`。
已读取 ask-matt、setup-matt-pocock-skills、grill-with-docs、grilling、domain-modeling、to-spec、to-tickets、implement。

建议路线：setup → grill-with-docs（明确边界）→ to-spec → to-tickets → implement（TDD）→ code-review。
本文件是审阅草案，不是已批准的规格或已发布的实施任务。

## 审计发现

### 采集

| 发现 | 证据 | 用户影响 |
| --- | --- | --- |
| 中文批次按字符数算字节预算 | `src/paseo-collector/timeline.ts:92`；服务端上限 524288 bytes | 已复现：四条各 65536 中文字符的消息生成 787461-byte 请求，超过上限，重试同批仍失败 |
| Herdr 关窗后不再补读尾部 | `src/collector/loop.ts:295–318` 只遍历当前 snapshot；purgeCheck 仅检查旧 transcript 是否存在 | 轮询间产生最终结论并关闭 pane 时，最后内容不会入库 |
| Paseo 达到 2000 轮预算仍宣告 current | `src/paseo-collector/loop.ts:496–522` | 超长归档历史未读完也设置 finalRead，尾部可能不再读取 |
| 历史发现范围不等于所有 session | `src/paseo-collector/config.ts`、`src/collector/loop.ts` | Paseo 默认不导入已有归档；Herdr 从当前 pane 发现 session，初次观察前关闭的历史不在此范围 |
| closed/unloaded 仅有元数据是现有保护 | `src/paseo-collector/loop.ts` 的 canRead、README 的 Paseo 说明 | 当前 timeline fetch 可能恢复非归档 runtime；完整采集需安全历史读取渠道，不能直接移除此保护 |
| 已存正文不是完整原文 | `src/collector/normalize.ts`、`src/paseo-collector/normalize.ts` | Herdr 用户/助手文本截至 4000 字符、工具输入摘要 200 字符且丢弃工具结果；Paseo 也有截断和过滤。仅改提示词无法恢复缺失证据 |

前三项是具体故障或控制流遗漏；后三项包括已文档化的范围和保真度限制，不能混称新发现的实现 bug。

### 项目理解与合并

| 发现 | 证据 | 用户影响 |
| --- | --- | --- |
| 选择目标立即合并，无预览和 session 选择 | `web/src/components/stage-control.tsx:56`、`src/domain/ops.ts` | 无法审阅结果或只合并部分 session |
| 合并整理仅输入旧摘要和项目记录 | `src/understand/project-review.ts:84–123` | 摘要遗漏的事实无法参与重写，不符合从原始数据重新理解的目标 |
| 合并关联依赖模型自行调用工具 | `src/domain/projects-ops.ts:101`、project-review | 内存数据库复现：来源有 session，模型成功结束但不调用工具，review=done，目标 contributions=0 |
| 缺少明确的项目边界和写作标准 | `src/understand/curate.ts`、`src/understand/digest.ts` | “新话题”容易被当成新项目，标题描述缺少统一质量标准 |

## 已验证及尚未验证

已运行 6 个核心测试文件，118 tests 通过：Herdr loop、Paseo collector/pipeline、project review、项目领域操作、阶段控件。
这些测试验证现有行为，不覆盖上述新增验收要求。
审计使用代码、fixtures、内存数据库和只读复现；尚未逐台对账真实 daemon/session 清单，因此不声称真实部署已全量核验。
仓库原有未提交 UI 改动保持原样。未修改生产数据、采集配置或运行中的服务。

## 建议明确的领域边界

以下是建议，尚未作为用户决策生效：

- **项目**：围绕同一个可独立验收的目标组织工作。feature、bug、调研若服务该目标，作为里程碑或任务；独立交付目标另建项目。仓库、目录、工具、session 数量都不能单独决定项目边界。
- **标题**：说明要交付的对象或结果，避免会话式标题和实现过程堆砌。
- **描述**：说明为谁解决什么问题、范围与预期结果；完成标准单独表达可验证结果，未知信息不猜测。
- **部分合并**：将所选来源 session 的项目关联移动到目标，保留来源项目和未选关联，不影响 session 与其他项目的关系。原始会话和证据不删除。
- **整项目合并**：确定性迁移/合并关联并去重，将来源标记 merged；关联变化不交给模型自由决定。
- **原始证据**：明确区分原始 transcript、保存的事件、归一化 chunks、摘要。生成草稿说明其实际读取范围，截断、缺失或不可访问不能表述为“全文已读”。
- **完整性**：按来源分别展示发现覆盖、内容已确认位置、积压、排除、未加载、错误及不可恢复缺口；不能用心跳健康或 session 总数代替内容完整性。

## 拟议实施切片（尚未发布）

1. **采集可靠性与覆盖核验**：修复字节预算、关窗尾部、历史预算退出；提供按来源的发现/内容对账，标出已有归档和未加载历史的覆盖边界。无前置依赖。
2. **可追溯原文与项目提取**：建立原文保留/安全回读及可见缺口，定义目标级聚类和标题、描述、完成标准；用同目标跨 session、同仓不同目标、摘要漏掉决定性事实等案例评价。依赖 1 的可靠传输与覆盖信息。
3. **session 选择与合并预览**：选择整项目或 session 子集；用目标现有证据及所选来源证据生成结构化草稿，预览正式项目零写入，展示证据范围与缺口。依赖 2。
4. **确认应用、冲突检查与撤销**：确认时事务应用预览中的确切结果和确定性关联变化；过期则拒绝并重算，失败不留下半次合并，可撤销。依赖 3。

验收通过采集器→中心入库、预览/确认 HTTP→项目查询、用户界面这几个现有行为边界验证。模型质量另用固定案例和证据覆盖评价，不以提示词字符串测试代替质量验证。

## 关键验收场景

- 中文和 emoji 大消息的完整请求在上限内，提交后游标连续推进。
- Herdr 已观察 session 在轮询间关闭，最终结论仍补入；失败重试、重启和重复 tick 不漏不重，不恢复 live 状态。
- 超过每轮预算的 Paseo 归档仍持续补读，真正读完才完成。
- 能按来源列出 session 发现集合与入库差异；无法访问的机器和历史明确列为未验证。
- 长会话决定性内容位于原截断点之后时，不会被默默丢掉；旧历史无法恢复则显示缺口。
- 一个目标跨多个 session 不重复建项目；一个 session 包含两个独立目标时不强制混为一项。
- 预览不更改正式项目和关联；未选 session 内容不能混入新草稿。
- 新项目标题、问题描述、范围、完成标准来自所选证据，旧标题和旧摘要不被当成事实锚点。
- 模型无工具调用或输出不完整时不得把合并当成成功；结构化结果需验证。
- 部分迁移保留来源，整体合并确定性建立目标关联，同 session 去重。
- 确认应用与预览一致；期间项目、关联、证据变化触发过期检查。
- 原有字段锁、删除/否决及上游拒绝隔离继续有效；预览明确列出拟变更的锁定字段，不绕过用户确认。
- 失败无半次写入，撤销可恢复项目与关联。

## 工作流配置草案（待确认后写入正式位置）

推荐本地 Markdown tracker。仓库有 GitHub remote，但没有 root AGENTS.md / CLAUDE.md，也没有 Matt 工作流配置。建议新建 AGENTS.md，使用默认 triage 标签和 single-context 文档布局。

拟写入 `AGENTS.md`：

```markdown
## Agent skills

### Issue tracker
规格和任务使用本地 Markdown，存于 .scratch/<feature>/。见 docs/agents/issue-tracker.md。

### Triage labels
使用默认五种 triage 标签。见 docs/agents/triage-labels.md。

### Domain docs
使用 single-context：根 CONTEXT.md 与 docs/adr/。见 docs/agents/domain.md。
```

拟写入 `docs/agents/issue-tracker.md`：

```markdown
# Issue tracker: Local Markdown

每项功能一个 .scratch/<feature>/ 目录，规格为 spec.md。
每张任务单独存放于 issues/<NN>-<slug>.md，按依赖顺序编号。
任务含 Status、验收标准与 Blocked by；评论追加到 Comments。
发布到 tracker 即写本地文件，不创建远程 Issue。
```

拟写入 `docs/agents/triage-labels.md`：

```markdown
# Triage labels

默认标签：needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix。
沿用 Matt 技能中的同名含义，不另造别名。
```

拟写入 `docs/agents/domain.md`：

```markdown
# Domain docs

探索前读取存在的 CONTEXT.md 和相关 docs/adr/；缺失时继续，不创建空文档。
CONTEXT.md 只写领域词汇，不混入实现细节或规格。
仅在术语确定时更新词汇；仅为难以逆转且有真实权衡的决定建立 ADR。
输出沿用领域词汇；与既有 ADR 冲突时明确指出。
```

setup 技能要求先展示配置草稿并让用户修改；grilling 要求在双方确认理解一致后进入实施。当前等待 tracker 选择以及项目粒度、部分合并语义确认。此草案不代表功能已经打磨完成。
