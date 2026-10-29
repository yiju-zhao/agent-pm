# herdr-pm：AI-native 项目管理助手 · 设计文档

日期：2026-10-29
状态：已确认，待写实施计划

---

## 1. 为什么要做

用户用 herdr 在多台机器（mac-mini、gx10-090e、gx10-c757，以及本地笔记本）上同时开十几个 coding agent（Claude Code、Codex），推进十多个课题。herdr 已经能回答 **session 层面**的问题："哪个 agent 在跑、哪个在等我"。规模上来之后，缺的是 **project 层面**的视图：

1. **想法变成项目的过程没人记录。** 用户在某个 session 里反复讨论，想法逐渐成形并落成一个项目。这个过程散落在对话里：什么时候定的、定了什么、还有什么悬而未决，都没有被系统地记下来。
2. **多个 session 推进同一个项目，进度无法汇总。** 不同机器上的 agent 各自知道自己干了什么，但没有一个地方能说清"这个项目现在到哪了"。

传统项目管理工具要求人往框架里填数据。这个系统反过来：**AI 从 session 里自己读出进度、决策、阻塞，主动维护项目状态；用户只在需要判断的时候出场，回答选择题或填空。**

## 2. 目标、非目标、反目标

### 目标
- **AI 主动发现课题**：任何 session 里出现新课题都记下来，不需要用户确认。很多课题停在 idea 阶段，这没关系。
- **从 idea 到 end 的全生命周期追踪**：每个项目从诞生一直追到完成、放弃、搁置或合并，每一步都能回看，并且能追溯到来源 session。
- **项目页回答 5 个问题**：big picture（是什么、为什么、做完长什么样）、当前进度、todo、优先级、blocker。
- **实时性**：agent 一干完活就触发更新，另有定时兜底。
- **与数据源无关**：第一版依托 herdr，但核心设计不绑定 herdr。只要能提供上下文（其他 agent 的对话、git、笔记……），就能接进来。
- **对其他 agent 开放**：任何机器上的 agent 都能读取项目全貌，也能上报上下文。
- **计费走 Claude 订阅**（Claude Code / OAuth token），不用 API key。

### 非目标（v1 不做）
- 在 herdr 里做 UI。herdr 插件只能开终端界面，所以 UI 做成网页应用。
- 主动给 agent 派任务、替 agent 回答授权弹窗。v1 对 agent 完全只读。
- 从网页一键跳转到 agent（用户已确认不需要）。取而代之的是：网页复制短 ID，在 herdr 里用查找工具打开（第 13 节）。
- 多用户协作、权限体系。v1 只有一个用户。
- 移动端原生 app（网页能在手机上用即可）。

### 反目标（即使能跑也算失败）
- **需要用户手动录入**才能保持准确。
- **AI 悄悄覆盖用户的决定。**
- **状态被多个 agent 写乱**，自相矛盾。
- **问答箱太吵**：AI 动不动就问，用户最后懒得看。
- **成本失控**：每次都把整段对话重新喂给模型。
- **把 session 当成项目**：页面以 session 为主体，项目只是标签。

## 3. 核心概念

| 概念 | 本质 | 生命周期 |
|---|---|---|
| **Session** | 临时的"工人"。在某台机器上运行的一段 agent 对话。通常推进某个项目的一部分，极少数时候横跨多个项目 | 活跃（运行中 / 等待 / 空闲）→ 已结束 → 已清除。记录永远保留 |
| **Project** | 持久的"账本"。由 big picture、里程碑、todo、决策、阻塞组成 | idea → 探索 → 构建 → 验证 → 完成；任意阶段可转到搁置 / 放弃 / 合并到另一个项目 |
| **Contribution（贡献记录）** | Session 和 Project 之间的桥：某个 session 在某段时间、为某个项目（的某个里程碑）做了什么 | session 被删除后仍保留，项目时间线就靠它 |
| **Question（问题）** | AI 拿不准的地方。每个选项绑定一个具体操作，用户点了就执行 | 待回答 → 已回答 / 已过期 / 已撤回 |
| **Operation（操作）** | 对项目状态的唯一修改方式。带操作者、理由、证据 | 写入后变成一条 event，可撤销 |

**设计原则：对项目的所有改动都是一个带出处的"操作"。** AI 和用户调用同一套操作。网页按钮、AI 的工具、MCP 只是同一层操作的不同入口。

## 4. 环境事实（2026-10-29 实测）

- herdr 0.9.3，协议版本 22。已保存的机器：`mac-mini`（100.111.225.68）、`gx10-090e`（100.90.216.102）、`gx10-c757`（bz@100.87.40.81），都通过 Tailscale 互通。
- `herdr --machine <label> agent list` / `pane process-info` / `api snapshot` 可以在没有 TUI 的情况下读取远程机器的状态。`integration status` 这类本地管理命令不会转发。
- 每个 agent 带 `agent_session: {source, agent, kind:"id", value}`，`value` 是 **agent 的原生 session ID**，由 herdr integration hook 上报：
  - Claude：hook 输入里的 `session_id`，就是对话文件名，即 `~/.claude/projects/<cwd 转写>/<id>.jsonl`（已验证）
  - Codex：codex 的 thread ID，即 `~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<id>.jsonl` 里的 UUID
  - hook 同时上报 `session_start_source`：`startup` / `resume` / `clear` / `compact`
- 本地笔记本和 gx10-090e 都已安装 claude 和 codex integration（v10 / v8）。gx10-090e 上有两个 codex pane（`w1:p9`、`wA:p17`）没有上报 ID。
- socket API 支持 `events.subscribe`，可订阅 `pane.agent_status_changed` 等事件。**尚未验证这个订阅能否通过 `--machine` 转发。**
- `pane.report_metadata` / `workspace.report_metadata` 可以给 herdr 侧边栏写短状态（token），`herdr notification show` 可以弹提醒。
- 从笔记本直接 `ssh 100.111.225.68` 超时，但 `herdr --machine mac-mini` 正常。gx10-090e 可以直接 ssh。
- Claude Code 2.1.312。
- 当前量级：约 13 个 agent，十多个课题。

## 5. 架构

```
数据源适配器        理解层（Claude）                 领域操作层          入口
┌──────────┐    ┌──────────────────────┐       ┌──────────────┐   ┌─────────┐
│ herdr     │──▶│ ② 摘要员（Haiku）      │──────▶│ 校验 + 写入   │◀──│ HTTP    │← 网页
│ (状态+对话)│   │   每个 session 增量    │       │ 状态机、字段锁 │   │ MCP     │← agents
│ pm_report │──▶│ ③ 整理员（Sonnet）     │──工具─▶│ 证据要求      │   │ CLI     │← 脚本/hook
│ 以后更多   │   │   每批摘要，调用写工具  │       │ SQLite        │   └─────────┘
└──────────┘    └──────────────────────┘       └──────────────┘
      ▲ ① 采集（不用 LLM）：每台机器上的采集器读本机 herdr 和对话文件，推送到中心
```

系统分两种进程（用户已确认）：
- **中心服务**：一个常驻进程，跑在 mac-mini 上（我推断 mac-mini 是常开的机器，用户在审阅架构时没有反对）。负责摘要、整理、存储、网页、MCP。
- **采集器**：每台机器上一个（笔记本、mac-mini、gx10-090e、gx10-c757），只读本机数据，通过 Tailscale 推给中心。中心**不需要 ssh 到任何机器**。

### 5.1 采集器（每台机器一个，确定性代码，不调用 LLM）
1. **读本机状态**：订阅本机 herdr socket 的 `pane.agent_status_changed` 事件（本机订阅，不需要 `--machine` 转发）；另外每 60 秒取一次 `herdr api snapshot` 兜底。把 session 列表连同心跳推给中心：`POST /ingest/snapshot {machine, sessions[]}`。
2. **增量读取对话**：在本机直接读 Claude / Codex 的 JSONL，只读游标之后的新增部分。按格式解析，抽出用户和助手的文本以及工具调用摘要，丢掉大块工具输出，推给中心：`POST /ingest/chunks {session_key, offset_start, offset_end, ts_start, ts_end, text}`。
3. **游标与幂等**：游标由采集器保存在本地状态文件里，只有中心确认收到后才前进。中心按 `(session_key, offset_start)` 去重，重复推送无害。采集器重装、状态文件丢失时，向中心查询该 session 已收到的最大 offset，从那里续读。
4. **离线补推**：笔记本休眠或断网时，推送失败就保留游标，恢复后自动补推。
5. **兜底**：拿不到对话文件的 session（低精度），用 `herdr agent read --source recent-unwrapped` 读屏幕输出。
6. **无原生 ID 的补救**（第 6 节）在采集器本地完成，因为只有它能看到本机进程和文件。
7. **鉴权**：每台机器一个采集器 token，在中心配置。
8. **分发**（留给构建者）：采集器和中心最好来自同一个代码库。gx10 是 Linux，是否预装 Node 未知，构建者可以选择打包成单文件可执行程序（例如 `bun build --compile`）。部署用 launchd（macOS）/ systemd user service（Linux）。

### 5.1b 中心侧的采集处理
1. **触发摘要**：某个 session 从 `working` 变成 `idle` / `done` / `blocked` 时，延迟 2 分钟（防抖）后把它的新 chunk 放进摘要队列。
2. **生命周期判定**：
   - 机器心跳正常、但 session 不在它的列表里 → `已结束`
   - 采集器报告对话文件不存在 → `已清除`
   - **机器心跳中断**（比如笔记本休眠）→ 该机器的 session 显示"机器离线"，**不判为已结束**
3. **定时**：每 30 分钟兜底跑一轮"摘要 + 整理"。网页上可以手动触发。

### 5.1c 首次启动：导入活跃 session 的全部历史（用户已确认）
- 首次运行时，采集器把当前 herdr 里所有活跃 session 的**完整对话**从头推上来（游标从 0 开始）。已经被 herdr 关闭的历史对话 v1 不导入。
- 目的：还原现有项目从 idea 走到今天的来龙去脉。
- **实时优先，历史在后台慢慢补**：新产生的内容照常立即处理；历史部分进低优先级队列，在后台低并发地跑完。
- 因为处理顺序和发生顺序不一致，所有 event 区分 `occurred_at`（对话里实际发生的时间）和 `recorded_at`（写入时间）。时间线、"诞生于哪天"一律按 `occurred_at` 展示。
- 历史部分可以用更粗的切片（更大的窗口）来省额度，具体粒度由构建者定。
- 页面上显示历史导入进度（例如"历史导入 7/13 个 session"）。

### 5.2 摘要员（Haiku）
- 输入：一个 session 的新增 chunk，加上这个 session 已经关联的项目的简报。
- 输出（结构化 JSON）：
  ```json
  {
    "topics": [{"label": "...", "summary": "...", "likely_project_ids": ["..."], "is_new_topic": true, "confidence": 0.0}],
    "decisions": [{"text": "...", "quote_ref": "chunk:123#L40"}],
    "progress": ["..."],
    "todos_added": ["..."], "todos_done": ["..."],
    "blockers": [{"text": "...", "kind": "user|external|technical"}],
    "open_questions": ["..."],
    "trivial": false
  }
  ```
- 新增内容太少时（具体阈值由构建者定）跳过，不调用模型。
- `trivial: true` 表示一次性问答，不值得追踪。

### 5.3 整理员（Sonnet）
- 一个使用 MCP 写工具的 Claude agent，由 Claude Agent SDK 驱动。
- 输入：一批新摘要、相关项目的当前状态、待回答的问题（避免重复提问）。
- 职责：发现新课题并建项目、把 session 关联到项目（和里程碑）、推进阶段、维护 todo / 里程碑 / 阻塞 / 决策、拿不准时调用 `ask_user`。
- 所有写操作都经过领域操作层校验（见第 7 节）。

### 5.4 计费
- 通过 Claude Agent SDK 调用，鉴权用 `claude setup-token` 生成的 OAuth token（`CLAUDE_CODE_OAUTH_TOKEN`），走用户的 Claude 订阅额度。
- 每次调用的 token 用量记录到 `llm_runs` 表，便于观察成本。
- 用户最初的要求是"模型计费可以走 claude code 或者 claude authtoken"，所以 OAuth token 方案是用户提出的。
- **不设额度上限**（用户已确认）。PM 和用户的十几个 coding agent 共用同一个订阅，所以：
  - 遇到限流时指数退避，并在页面上显示"整理已暂停"。
  - 整理员一次处理一批摘要，不按单个摘要触发。

## 6. Session 的身份与记录

- **主键 = `agent类型:原生session_id`**，例如 `claude:5d27595b-908e-4fe5-9283-890acdbd075f`、`codex:01a1883e-7f9e-7211-b38b-73574fe766dd`。（用户已确认）
- **pane_id、terminal_id、机器、工作目录、标题都只作为属性记录**，可以随时更新。pane_id 在移动后会变，不能当主键。
- **一个 pane 不等于一个 session**：在同一个 pane 里 `/clear` 或开新对话会产生新 ID。herdr 上报 `session_start_source = clear` 时，记录一条"前一个 session → 后一个 session"的接续关系。`compact` 保持同一个 ID。
- **没有原生 ID 的 session**：
  1. 先用临时键 `pending:<机器>:<terminal_id>` 登记，标记为低精度。
  2. 尝试补救：通过 `pane process-info` 拿到 agent 进程的工作目录和启动时间，匹配对应机器上 rollout / transcript 文件（Codex rollout 第一行的 session_meta 记录了 ID、工作目录和时间）。
  3. 匹配成功就把临时记录合并到真实主键，相关的 chunk、贡献记录一起迁移。
  4. 一直匹配不上的，只用屏幕输出。
- **游标**：每个 session 记录对话文件的字节偏移，以及最后处理的消息 ID。文件被截断或替换时，从头重读并去重。

## 7. 项目生命周期与 AI 的信任边界（用户已确认）

**阶段状态机：**
```
idea → 探索 → 构建 → 验证 → 完成
任意阶段 → 搁置（可恢复到之前的阶段）
任意阶段 → 放弃
任意阶段 → 合并到项目 X
```

**规则写在领域操作层的代码里，不靠 prompt 约束：**

| AI 可以直接做 | AI 只能提议（自动转成问题，等用户确认） |
|---|---|
| 新建项目（只能从 idea 阶段开始） | 完成、放弃、合并 |
| 把 session 关联到项目或里程碑 | 修改用户锁定过的字段 |
| 沿状态机往前推进一步 | 往后退阶段 |
| 增删改 todo、里程碑、阻塞 | 从搁置恢复 |
| 记录决策 | |
| 修改未锁定的字段（big picture、优先级建议等） | |

- **每个 AI 写操作都必须带 `reason`（理由）和 `evidence`（指向 digest 或 chunk）**，缺少的会被拒绝。
- **字段锁**：用户通过网页修改过的字段自动锁定。AI 想改时，领域层会把这个写操作转成一个确认题。用户可以手动解锁。
- **休眠 ≠ 搁置**：休眠是根据最近一次贡献时间算出来的显示状态（具体天数由构建者定）；搁置是一个阶段，是一个决定。
- **优先级**：P0 / P1 / P2 / P3。AI 可以给出建议值；用户一旦设过就锁定。
- **用户的删除和撤销就是否决**（我的决定）：字段锁只覆盖项目字段，但 todo、里程碑、阻塞、决策、session 关联同样可能被 AI 从旧摘要里"复活"。规则如下：
  - 用户删除的实体留下墓碑（软删除，标记 `vetoed_by_user`），AI 不能恢复同一个 ID。
  - 用户撤销的 AI 操作（`POST /events/:id/revert`）同样记为否决。例如撤销 `link_session(s, p)` 之后，AI 不能再次把 s 关联到 p；要关联只能走确认题。
  - 用户编辑过的 todo / 里程碑也会被锁定，规则和项目字段相同。
  - 整理员的上下文里会附上该项目最近的墓碑和否决列表，避免它重新提出相似的条目。用相似度判断"是不是同一个东西"由模型负责，领域层只按 ID 和 (session, project) 这样的键硬拦截。

**什么时候建项目、什么时候问**（来自用户的要求："AI 自己观察，只要发现是新的课题都记下"）：
- 摘要里出现非一次性的新课题（`is_new_topic` 且 `trivial: false`），且不像任何已有项目时，AI **直接建一个 idea 阶段的项目**，不提问。
- 只有在"像某个已有项目、但又拿不准"时，session 才进"待归属"栏。
- 为了不让首页被 idea 淹没：AI 建的、用户还没碰过的 idea 项目默认收在首页一个折叠的"新 idea"区，不进主列表。用户给它设了优先级或者推进了阶段，才进入主列表。
- 合并重复项目仍然需要用户确认（信任边界不变），但它是一个一键确认题。

## 8. 问题 = 等用户点头的操作

问答箱是这个系统最核心的交互。AI 提问时，每个选项都绑定一个具体的操作：

```json
{
  "id": "q_123",
  "kind": "choice",
  "prompt": "Rea 逆向这个 session 属于哪里？",
  "project_id": null,
  "session_key": "claude:801a15a3-...",
  "options": [
    {"label": "新建项目", "op": "create_project", "args": {"title": "Rea 逆向", "from_session": "claude:801a15a3-..."}},
    {"label": "归入 openlingo", "op": "link_session", "args": {"session": "claude:801a15a3-...", "project": "p_openlingo"}},
    {"label": "不追踪", "op": "ignore_session", "args": {"session": "claude:801a15a3-..."}}
  ],
  "evidence": ["digest:4812"],
  "created_by": "ai:curator"
}
```

- `kind`：`choice`（选择）、`text`（填空，用户输入的文字作为某个参数传入，例如 `update_project{done_criteria}`）、`confirm`（确认 / 拒绝 AI 的提议）。
- 用户回答后，后端以 **用户身份** 执行绑定的操作。前端不需要知道每种按钮的业务含义，只负责渲染选项、回传选择。
- **防噪音**：同一个对象上已有未回答的同类问题时，不重复提问。相关的新证据作为补充挂到已有问题上。问题过时（比如对象已被别的操作改掉）时自动撤回。具体的数量上限由构建者调。
- 用户在网页上也可以不回答问题，直接编辑字段。

## 9. 网页界面

视觉方向参考头脑风暴阶段的 mockup，放在 `docs/superpowers/mockups/`：
- `02-home-project-centric.html`：**定稿方向**，首页以项目为主体，加上项目详情的 session 时间线
- `01-home-options.html`：早期的三个方案（A 卡片墙 / B 注意力优先 / C 看板），用户选了 B，后来按"session 临时、project 持久"修订成 02
- `03-backend-design.html`：本文档后端部分的图解版

### 9.1 首页
- **主区域：项目列表**，按优先级排序。每个项目一张卡片：
  - 优先级、标题、阶段、里程碑进度条（已完成 / 进行中 / 未开始）
  - big picture 一句话
  - **当前里程碑或 todo，旁边挂着正在推进它的活跃 session 标签**（机器 · agent 类型 · 实时状态点 · 短 ID）。点标签复制短 ID
  - 下一步、阻塞（红色）、需要用户决定的问题（可以直接在卡片里回答）
  - 没有活跃 session 的项目显示"休眠 N 天"并变淡；完成、放弃的项目默认收起
- **右栏："需要你"**：只放项目层面的决定（选择题、填空、确认）。session 层面的等待（授权弹窗）由 herdr 负责提醒，这里只在项目卡片上显示一个红点。
- **右栏："待归属的 session"**：AI 无法高置信度判断归属的 session，每个都带 AI 的猜测和按钮（新建项目 / 归入 X / 不追踪）。
- 可切换的第二视图：**生命周期看板**，按阶段分列。

### 9.2 项目详情页
- big picture：是什么、为什么、做完的标准
- 里程碑与 todo，支持直接编辑
- **Session 时间线**：横轴是时间，每个参与过的 session 是一条横条，标出它做了哪一段，包括已结束和已清除的 session
- 关键决策列表，每条都能点开看来源 session 和对话片段
- 事件日志：谁（AI / 用户）在什么时候改了什么、理由是什么，每条都能撤销

### 9.3 实时性
通过 WebSocket 推送事件，页面局部刷新，不用手动重载。

## 10. HTTP API

| 页面操作 | API | 执行的操作 |
|---|---|---|
| 首页 | `GET /projects?stage=&priority=` | 项目列表（含活跃 session、待回答问题） |
| 点开项目 | `GET /projects/:id` | 状态 + 里程碑 + todo + 决策 + 贡献记录 + 事件 |
| 回答问题 | `POST /questions/:id/answer {option_index \| text}` | 执行选项绑定的操作 |
| 待归属栏的按钮 | 同上（这些本身就是问题） | create_project / link_session / ignore_session |
| 直接编辑字段 | `PATCH /projects/:id {field: value}` | update_project，并锁定该字段 |
| 编辑 todo / 里程碑 | `POST/PATCH /projects/:id/todos`、`/milestones` | upsert_todo / upsert_milestone |
| 手动关联 session | `POST /sessions/:key/links {project_id, milestone_id?}` | link_session |
| 撤销 | `POST /events/:id/revert` | 反向操作 |
| 解锁字段 | `DELETE /projects/:id/locks/:field` | unlock_field |
| 点 session 标签 | 无（纯前端） | 复制短 ID 到剪贴板 |
| 按短 ID 查 session | `GET /sessions/by-short-id/:sid` | 返回机器、pane、所属项目（供查找工具在中心在线时使用，非必需） |
| 手动刷新 | `POST /sync` | 立即跑一轮采集、摘要、整理 |
| 实时推送 | `WS /stream` | 新事件、session 状态变化 |
| session 列表 | `GET /sessions?state=` | 调试和管理用 |

## 11. MCP 服务（要做）

与 HTTP 共用同一个领域操作层，通过 streamable HTTP 暴露，其他机器经 Tailscale 连接。

| 类别 | 工具 | 谁能调用 |
|---|---|---|
| 读 | `pm_list_projects`、`pm_get_project`、`pm_get_brief`（给 agent 开工时用的精简项目简报）、`pm_timeline`、`pm_search`、`pm_list_sessions` | 任何 agent |
| 上报 | `pm_report {text, project_hint?}`：作为一个上下文片段进入流水线，**不直接修改项目** | 任何 agent |
| 写 | `create_project`、`update_project`、`transition_stage`、`upsert_milestone`、`upsert_todo`、`record_decision`、`set_blocker`、`clear_blocker`、`link_session`、`ignore_session`、`ask_user` | 只有整理员（以及网页上的用户） |

- **只让整理员直接写**（我的决定）：十几个 agent 同时直接改项目，状态会被写乱。只留一个"大脑"直接写，其他 agent 只读和上报。
- 写工具和读工具通过不同的 token 或端点区分权限（具体方式由构建者定）。
- `pm_report` 是"只要有 context 就能用"的通用入口：没有被 herdr 管理的 agent，或者其他工具，都能通过它推上下文进来。

## 12. 存储（单个 SQLite 文件）

网页不直接读写文件。**后端服务是唯一读写 SQLite 的进程**，网页、整理员、MCP 客户端都经过它。

| 表 | 用途 | 主要字段 |
|---|---|---|
| `sessions` | session 身份与状态 | `key`(PK)、`agent_kind`、`native_id`、`machine`、`pane_id`、`terminal_id`、`cwd`、`title`、`live_status`、`lifecycle`(live/ended/purged)、`fidelity`(full/screen)、`transcript_path`、`max_offset_received`、`predecessor_key`、`ignored`、`first_seen`、`last_seen` |
| `chunks` | 对话片段 | `id`、`session_key`、`source`(herdr/report/…)、`ts_start`、`ts_end`、`text`、`digested` |
| `digests` | 摘要员输出 | `id`、`session_key`、`chunk_ids`、`json`、`model`、`created_at`、`curated` |
| `projects` | 项目当前状态 | `id`、`title`、`stage`、`stage_before_park`、`priority`、`summary`、`why`、`done_criteria`、`merged_into`、`locks`(JSON)、`created_at`、`last_activity_at` |
| `milestones` | 里程碑 | `id`、`project_id`、`title`、`status`(todo/doing/done)、`order` |
| `todos` | 待办 | `id`、`project_id`、`milestone_id?`、`title`、`status`、`priority` |
| `decisions` | 决策 | `id`、`project_id`、`text`、`decided_at`、`evidence` |
| `blockers` | 阻塞 | `id`、`project_id`、`text`、`kind`(user/external/technical)、`status` |
| `contributions` | session ↔ project | `session_key`、`project_id`、`milestone_id?`、`summary`、`ts_start`、`ts_end`、`confidence`、`actor` |
| `questions` | 问答箱 | `id`、`kind`、`prompt`、`options`(JSON)、`project_id?`、`session_key?`、`status`、`answer`、`evidence`、`created_by`、`created_at` |
| `events` | 操作日志 | `id`、`occurred_at`、`recorded_at`、`actor`(ai:curator/user/system)、`op`、`entity`、`args`、`before`、`after`、`reason`、`evidence`、`reverted_by`、`is_veto` |
| `machines` | 采集器 | `label`(PK)、`token_hash`、`last_heartbeat`、`collector_version`、`backfill_progress` |
| `llm_runs` | 模型调用记录 | `id`、`role`(digest/curate)、`model`、`input_tokens`、`output_tokens`、`ts` |

- **每个操作在同一个事务里先改状态表、再追加一条 event**（记录修改前后的值，以便撤销）。没有做完整的事件溯源，避免过度设计。
- 需要给 LLM 当上下文或者导出时，把项目渲染成 Markdown。文件只是视图，不是数据本体。
- 备份就是复制 `.db` 文件。

## 13. 在 herdr 里按短 ID 查看 session（用户已确认）

网页不负责跳转。用户在网页上复制短 ID，在 herdr 里自己打开。

**短 ID**：原生 session ID 的前 8 位（例如 `0d67da1f`）。和其他活跃 session 冲突时自动加长，直到唯一。

**查找工具**：一个脚本，两种入口：
- **herdr 插件**：快捷键（例如 `prefix+g`，和用户现有的 `prefix+d/f/m` 一致）→ 弹窗输入框 → 粘贴短 ID → 回车
- **命令行**：`herdr-pm open <短ID>`，任何终端里都能用

**解析流程**（只依赖用户笔记本上的 herdr 和 ssh，**不依赖中心服务**，mac-mini 没开也能用）：
1. 对本机和 `herdr machine list` 里每台启用的机器执行 `herdr [--machine m] agent list`，用 `agent_session.value` 前缀匹配短 ID。
2. 匹配不到时，如果中心在线，可以调用 `GET /sessions/by-short-id/:sid` 兜底（覆盖 pending 状态的低精度 session）。
3. 找到之后：
   - **本机的 agent**：`herdr agent focus <pane>`，直接切过去
   - **远程的 agent**：在当前位置旁边开一个分屏，执行 `ssh -t <机器> herdr agent attach <pane>`，可以直接看和操作。`ctrl+b q` 退出后分屏关闭
4. 找不到或者找到多个时，在弹窗里列出候选，或者给出明确提示（例如"这个 session 已结束"）。

**需要实测**：用户在 herdr 里正切到某台远程机器时，插件开出的分屏落在哪台机器上，文档没有写清楚。实施时先做小实验；如果有问题，退回到"直接在弹窗里 attach"。

## 13b. 写回 herdr（可选的增强）
- 用 `pane report-metadata` 在 herdr 侧边栏给每个 agent 标上**短 ID** 和所属项目，例如 `pm_sid=0d67da1f`、`pm=dLLM评测`。这样不用查找工具，在侧边栏扫一眼也能对上号。只影响显示。需要用户在 herdr 配置里把 `$pm_sid` 加进 Agent 行的显示格式。
- 有新的高优先级问题时，用 `herdr notification show` 提醒。
- 两者都不影响核心功能，可以放到第一版的最后。

## 14. 技术栈（我的选择）
- 一个 TypeScript（Node 26）进程：HTTP 服务、WebSocket、SQLite、调度器、采集器、MCP 服务。
- Claude Agent SDK（TypeScript）负责摘要员和整理员。
- 前端：React 单页应用，由同一个进程托管静态文件。
- 部署：中心服务在 mac-mini 上用 launchd 常驻；每台机器各跑一个采集器（launchd / systemd user service）。网页、MCP、采集器推送都走 Tailscale。

## 15. 用户已确定的决定
- 首页以项目为主体，活跃 session 挂在它推进的那一步下面（方案 B 的修订版）。
- Session 是临时的，Project 是持久的，两者通过贡献记录连接，多对多。
- 主键用原生 session ID，pane_id 只作属性记录。
- AI 可以自动往前推进阶段，完成、放弃、合并必须由用户确认。
- UI 做成网页应用，不放在 herdr 里。
- 存储用 SQLite，不用文件。
- 要做 MCP。
- 不做网页跳转。网页复制短 ID，在 herdr 里用查找工具（插件 + 命令行）打开。
- 计费走 Claude 订阅（OAuth token）。
- 每台机器跑采集器推送数据，中心不 ssh 到任何机器。
- 首次启动导入活跃 session 的全部历史，实时优先，历史在后台补。
- 不设 token 额度上限。

## 16. 我替用户做的决定（用户可以推翻）
- 只有整理员能直接写项目，其他 agent 只读和上报。
- 短 ID 取前 8 位，冲突时加长。
- 查找工具的快捷键暂定 `prefix+g`。
- 摘要用 Haiku，整理用 Sonnet。
- 采集器本机订阅事件 + 每 60 秒快照兜底，每 30 分钟兜底整理，状态变化后 2 分钟防抖。
- 用户的删除和撤销就是否决，AI 不能复活（第 7 节）。
- AI 建的、用户没碰过的 idea 项目先收在折叠区。
- 技术栈：TypeScript 单进程 + React。
- 优先级用 P0–P3 四档。

## 17. 留给构建者决定
- 摘要跳过的阈值、"休眠"的天数、问答箱的数量上限。
- 两个 prompt 的具体写法，以及摘要员输出 schema 的细节。
- 读写 MCP 权限的区分方式。
- JSONL 解析时保留哪些内容（工具调用的摘要粒度）。
- 前端组件库和视觉细节（参考 mockup）。
- 数据库迁移方式、日志、测试策略。

## 18. 风险与待验证
- gx10 两台 Linux 机器上采集器的运行环境（Node 是否可用，或者打包成单文件）。
- 所有机器到 mac-mini 的 Tailscale 连通性（从笔记本 ssh mac-mini 曾超时，需要确认是 ssh 配置问题还是网络问题）。
- 首次历史导入的实际额度消耗，可能需要调粗切片粒度。
- Claude / Codex 的 JSONL 格式会随版本变化，解析器要能容忍未知字段。
- Codex 没有原生 ID 时的匹配补救可能不准，需要能人工纠正（"待归属"栏可以兜底）。
- 订阅额度的消耗速度需要上线后观察，`llm_runs` 表就是为此准备的。
