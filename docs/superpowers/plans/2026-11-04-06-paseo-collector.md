# Paseo 独立采集器实施计划

日期：2026-11-04。状态：已实施（2026-11-06）。未完成项：bun 单文件构建回归未在本机执行（无 bun），真实跨机 daemon 未验收；见第八节实施记录。

目标：在现有 herdr 采集器之外，新增一个基于 Paseo SDK 的独立采集器。两个进程独立配置、部署、重启和重试，向同一个 agent-pm 中心上报 session 状态和会话内容，由中心统一做项目关联、摘要与分析。

保留现有包名和 `herdr-pm collect` 命令。新增 `herdr-pm collect-paseo --config <path>`。本计划不包含产品改名、引入 claude-mem、Paseo agent 调度或自动执行任务。

## 一、部署和职责

```text
Paseo daemon ── SDK / WebSocket ── Paseo collector ─┐
                                                  ├─ HTTP ingest ─ 中心 SQLite ─ digest / curate / execute
herdr + 本地 Claude/Codex JSONL ── herdr collector ─┘
```

- 每个 Paseo collector 实例连接一个明确配置的 daemon；多个 daemon 启动多个实例。第一版不自动遍历 Paseo 的已注册远程 hosts。
- collector 可以和 daemon 同机，也可以通过显式配置的 `ws://` / `wss://` 地址访问远程 daemon。第一版不实现 SSH 建隧道、relay 配对和自动发现。
- 配置里的 `machine` 表示被观察 daemon 所在机器，不是 collector 进程所在机器。
- 两个采集器不互相调用，也不共享状态文件。Paseo collector 不依赖 herdr CLI 或原生 JSONL 路径。
- 采集器只读取 Paseo；使用 SDK 的连接、列表、状态与时间线接口，不创建、发送消息、停止或归档 agent。
- 中心持有持久证据、身份映射和项目状态。Paseo 不在线时，已采集的证据和项目仍可查看。
- 第一版部署 Paseo collector 使用 Node 26，增加独立 launchd / systemd 模板。现有 herdr 单文件二进制继续可用；Paseo 的 Bun 单文件交叉编译不作为本期上线前提。

## 二、已核对的接口与现有约束

### Paseo SDK

本次 npm 元数据及本机已安装包均为 `@getpaseo/client@0.15.0`。实施时将依赖精确固定到已验证版本，并提交 lockfile。当前公开类型有：

- `createPaseoClient({ url, password?, reconnect? })`。
- `client.agents.list(...)`：返回 `entries` 与 `pageInfo`，支持订阅。
- `client.agents.ref(id)`、`refresh()` 和 `runtimeInfo.sessionId`。
- `agent.timeline.refetch({ direction, cursor, limit, projection })`。
- `agent.timeline.subscribe(...)`，以及 `subscription_restored`、`replacement` 和错误通知。

官方事件文档说明：连接恢复不自动回放漏掉的事件；消费方必须主动补历史。时间线游标包含 epoch 和 seq，替换时间线后旧 epoch 失效。时间线是 provider 的投影，不能宣称它等于完整原始 transcript。

参考：[SDK 事件契约](https://paseo.sh/docs/sdk/events.md)、[Agent SDK](https://paseo.sh/docs/sdk/agents.md)、[npm 包元数据](https://registry.npmjs.org/@getpaseo%2fclient/0.15.0)。

### 仓库中必须处理的兼容点

| 现有实现 | 双采集器接入后的问题 | 本期处理 |
|---|---|---|
| `applySnapshot()` 按 machine 结束快照中缺失的 session | 两个采集器会互相结束对方的会话 | 按来源划定快照所有权 |
| `machines.last_heartbeat` 驱动离线判断 | herdr 的心跳会掩盖 Paseo 断线，反之亦然 | 来源级心跳和连接健康度 |
| `sessions` 只有一组 pane、workspace、machine 字段 | 同一会话的来源互相覆盖 | 增加 `session_sources`，旧字段保留为兼容投影 |
| `UNIQUE(session_key, offset_start)` 和 `max(offset_end)` | Paseo 序号与文件字节偏移不能混用 | 新增 Paseo ingestion 契约及独立游标 |
| scheduler 与 change-feed 直接连接 machines | 仅修改 `/sessions` 不足以修正分析触发和网页状态 | 共享来源聚合后的状态读取 |
| 当前 normalizer 丢弃工具返回结果 | 无法充分判断测试、构建是否成功 | Paseo 新链路保留有界工具结果并标明截断 |

相关文件：`src/server/sessions-repo.ts`、`src/server/http.ts`、`src/server/config.ts`、`src/understand/scheduler.ts`、`src/server/change-feed.ts`、`src/collector/normalize.ts`。

## 三、中心数据和协议

### 3.1 来源身份与兼容迁移

新增概念如下，最终列名可随实现调整，但职责不能合并：

| 对象 | 职责与关键字段 |
|---|---|
| `ingest_sources` | `source_id`、kind、machine、expected server ID、collector 心跳、daemon 健康度、最后成功快照时间 |
| `session_sources` | 来源下的外部会话身份 → 中心 `session_key`；保存 provider、native ID、workspace、运行状态、生命周期、最后观察时间 |
| `ingest_streams` | 每个 Paseo agent 的已确认 epoch / cursor、连续采集范围、缺口和恢复状态 |
| `ingest_batches` / `source_events` | 不可变上报批次、事件身份及修订，负责重试去重和证据来源 |
| `chunk_sources` | source event 到现有 `chunks.id` 的映射，标记哪些证据已经进入理解层 |

保留 `sessions` 作为逻辑会话实体，保留已有主键、chunk ID、digest ID 和项目引用。新增迁移追加到 `MIGRATIONS`，不得改写已发布迁移。

旧配置 `collectors: { machine: token }` 自动代表该机器的 herdr 来源，例如 `herdr:mac-mini`。旧 `/ingest/snapshot`、`/ingest/chunks`、`/ingest/offset` 的请求和响应继续可用；中心内部将其归入这个来源。已有 session/chunk 的来源按现有 machine 回填，无法回填的 report 等数据保持原有语义。

新增 `paseoCollectors` 配置，以独立 `source_id` 绑定 `{ token, machine, serverId }`。新 token 与旧 collector、user、MCP token 分离；Paseo token 只能写自己配置的来源，不能通过请求体伪造其他机器或 server ID。旧 token 不获得新来源写入权限。

Paseo 来源同一时间只允许一个有效写入实例。新接口提供来源写入租约与有序快照修订；并行启动第二个实例、过期实例重试、旧快照迟到均不能覆盖较新的状态。租约只管理中心写入，不控制 Paseo agent。旧 herdr 协议不新增租约必填字段，继续遵守每台机器一个 herdr collector 的部署约束。

### 3.2 会话关联

- Paseo 外部身份使用 `{serverId, agentId}`；provider 的 native session ID 是关联线索，不能拿 `agentId` 冒充原生 ID。
- 同一配置机器、同一 provider、同一 native session ID 的来源默认关联同一个逻辑会话。记录 `cwd` 等辅助信息；遇到明显冲突时保留来源并标记待核对。
- 不按标题、cwd 或相同文本自动合并。跨机器相同 native ID 第一版保守保留为不同候选，避免把复制或分叉的会话合并。
- Paseo 未取得 native ID 时使用来源命名空间下的临时身份。后续映射变化必须在事务中迁移来源与相关引用，保留短 ID 查询兼容；与旧 herdr pending 身份不共用命名空间。
- Claude / Codex 是第一批真实验收 provider。其他 provider 的 session 状态仍可接收，未知事件记录类型与诊断，不把未知结构解释成已成功解析的正文。
- 增加集中身份解析函数，覆盖新临时键、跨机器冲突键及短 ID 冲突；不要在采集器中各自拼接中心主键。

### 3.3 快照与状态

- 完整快照只对所属 `source_id` 生效。必须拉完目录分页后才可提交；请求失败、部分分页和过滤条件变化不能当作空快照。
- 来源断线只改变健康度，不推送“全部结束”。collector 存活和 daemon 可用分别记录。
- 发现列表中少了已跟踪 agent，先按确切 ID 刷新，区分归档、删除、过滤和临时失败。已跟踪 agent 归档后仍尝试抓取最后一段历史。
- 初次导入当前未归档的 agent，包括 idle 会话；后台 workspace/agent 不因 SDK 默认列表过滤而遗漏。部署配置可显式排除项目或标签，被排除标为不再跟踪，不代表运行结束。
- 尚未跟踪的已归档历史默认不全量导入；提供显式配置开启。恢复时复查已跟踪 ID，覆盖 collector 离线期间发生的归档。

Paseo 状态映射：

| Paseo 观察 | PM 状态 |
|---|---|
| pending permission | `blocked`，同时保留原始运行状态 |
| running | `working` |
| idle | `idle` |
| initializing / 无法解释的状态 | `unknown` |
| error | `blocked`，原因是执行错误 |
| closed / 明确归档 | 对应来源 `ended` |
| daemon 断线 / 快照过期 | 来源 `offline`，不结束会话 |

逻辑会话聚合只使用新鲜的来源观察：有 `working` 来源则显示 working，否则依次考虑 blocked、idle、unknown；保留各来源详情，展示权限和状态冲突，不能让旧观察覆盖新观察。没有新鲜活动观察但仍有未确认结束的来源时显示 offline；只有所有来源均明确结束时才结束会话。文件被删、Paseo 归档都不能删除中心已存证据。

用户界面、scheduler 和 change-feed 使用同一聚合函数。轮次完成是触发抓取和防抖摘要的信号，不自动变成项目完成。

### 3.4 Paseo ingestion API

新增版本化路由，避免让 Paseo 伪造 pane ID 或把 seq 塞进 byte offset：

| 路由 | 用途 |
|---|---|
| `POST /ingest/v2/lease` | 获取/续期来源写入租约，确定当前写入实例 |
| `POST /ingest/v2/snapshot` | 来源健康度、完整 session 快照与快照修订 |
| `GET /ingest/v2/checkpoint?agent_id=...` | 查询当前 token 对应来源的已提交时间线游标、恢复状态和映射 |
| `POST /ingest/v2/batches` | 提交不可变时间线批次，返回中心已提交 checkpoint |

批次包含 source/server/agent 身份、batch ID、前置 checkpoint、下一 checkpoint、事件数据及其身份、历史时间/接收时间、是否 backfill、截断/缺口信息。中心校验前置 checkpoint，事务中同时写入证据、receipt 和 checkpoint；重复 batch 返回同一个确认，内容不一致的重复 ID 报冲突。

不能用“最大见到的 seq”代替连续确认的位置。整页过滤为空时也要提交检查点与过滤统计，避免重复扫描。分页边界按 SDK 返回的 cursor 续读，不假设序号连续或每条 projected row 只包含一个 seq。

Paseo 内容进入现有 `chunks` 时不占用 herdr 的数值 offset 空间：Paseo chunk 的 legacy offset 列为 NULL，来源唯一性由新表约束；旧 `maxOffset()` 只读 herdr 来源的字节检查点。现有 `chunk:<id>` / `digest:<id>` 证据引用继续有效。

### 3.5 去重与内容主来源

分别处理三种重复：

1. 网络重试：用不可变批次 ID、receipt 和事务保证幂等。
2. Paseo 实时流与历史分页重叠：按事件身份、epoch、seq 范围及修订处理。projected 内容可能增长，不能把相同起始 seq 的新内容简单丢弃。
3. Paseo/herdr 观察同一原生会话：中心为逻辑会话确定 `content_owner`，其他来源照常上报状态与保存来源证据，不重复进入摘要队列。

默认保留已有会话的内容主来源；新会话选首个成功确认的内容来源，一旦产生分析就保持稳定，不因下一次心跳或短暂离线自动切换。这样现有 herdr session 不会在接 Paseo 后重复导入。两个来源都保存接收进度，主来源之外的数据标为 standby。

身份稍后才确认、且两边都已有内容时，需要对已处理范围进行重叠核对；未能可靠对齐的部分进入待核对状态，不能重放整段历史给 LLM。主动切换主来源也需先确认边界。第一版不承诺跨任意格式的自动无损拼接，也不把全文 hash 当成消息身份：用户可能真的重复说同一句话。

此策略的取舍：主来源暂时不可用时可继续显示另一来源的状态，但自动项目分析可能延迟；状态中显示内容采集滞后，不默默丢弃 standby 证据。

旧 herdr `/ingest/chunks` 也必须先按来源持久接收，再决定是否进入分析。即便 herdr 是 standby，其字节 checkpoint 仍在持久接收成功后推进，旧 `/ingest/offset` 返回该来源的已确认位置，不能依靠已物化的 chunks 推算，否则会反复补传。历史迁移先从旧 chunks 初始化这个 checkpoint；旧客户端看到的 offset 数值语义保持不变。

## 四、Paseo collector 的处理流程

1. 读取独立配置，建立 SDK 连接，核对 daemon 身份，获取来源写入租约；不匹配时停止该来源上报。
2. 建立目录订阅并完整分页扫描。订阅事件主要用于及时发现变化，定期全量核对作为补偿。
3. 为 agent 建立串行任务队列。不同 agent 有界并发，单个 agent 的读取、批次提交和 checkpoint 推进严格有序。
4. 从中心读取已确认 checkpoint。本地缓存不能使 collector 跳过中心尚未确认的内容；中心恢复旧备份时按中心位置重新补采。
5. 首次按 SDK 分页取回可用历史；先订阅并等待 ready，再补历史，缓冲/标脏并重新核对竞态区间。以实际返回的历史时间判定 backfill，缺少历史时间时明确标记未知，不能把恢复读取时间伪装成原始发生时间。
6. 实时事件触发防抖拉取。第一版以分页历史结果作为有序采集依据，不把 text delta 和 projected 历史直接混在一个正文流中。长轮次定期刷新，轮次结束再做最终抓取。
7. projected row 可能更新：以稳定 message/tool ID 和 seq 范围识别修订。尚未完成的消息保留在暂存层；同 epoch 的可确认新增后缀可以增量输出，已输出部分不重复摘要。无稳定身份或正文被改写时保留修订并标记待核对，不能覆盖已经引用的证据。
8. 批次先写本地磁盘 outbox，再提交中心。中心确认后推进缓存 checkpoint 并清理 outbox。中断后重发完全相同的批次，中心去重。
9. 收到 `subscription_restored` 后从中心确认游标补历史；收到 `replacement` / stale cursor / gap 时重新枚举可用历史并核对已存事件。能凭稳定 provider ID 认出的旧事件不重复物化；无法核对的区间保留待核对状态及缺口，不静默回到最新页并宣称完整。
10. SIGTERM/SIGINT 停止新读取，原子保存待提交数据，释放订阅并关闭 SDK 连接。无需等待 LLM，也不改变 agent 状态。

collector 的持久目录包含身份配置摘要、待提交批次及暂存消息修订；不保存密码明文。outbox 设置磁盘上限；达到上限暂停内容读取并持续报告状态/积压，不删除未确认批次。若上游在停采期间丢失历史，恢复时显式记录缺口。

重试：网络失败、408、429、5xx 使用有上限的指数退避和抖动；鉴权错误、来源身份不匹配、无效配置明确报错。租约/checkpoint 冲突先向中心核对，不能无限盲重试。日志记录 source/agent、积压、最后成功抓取及缺口，不输出口令或对话正文。

## 五、内容规范与配置

新 normalizer 保留用户文本、助手文本、工具名称/参数/结果、工具是否失败以及可用的退出码；不采集 reasoning/thinking、二进制附件正文或无法解释的 provider 内部事件。

保留上游 ID、角色、时间和来源定位。工具正文初始上限 16 KiB，用户/助手正文上限 64 KiB，超长正文保留首尾并标记原始长度与截断；不得把截断后的内容宣称完整。HTTP 批次控制在 512 KiB 内；单条上游数据已经被截断时也传递该事实。不得用文本切片切断 Unicode 字符。按现有摘要窗口分批，不能让工具输出占满整个分析窗口。

示例配置：

```json
{
  "server": "http://127.0.0.1:7718",
  "sourceId": "paseo-mac-mini",
  "machine": "mac-mini",
  "tokenFile": "~/.config/herdr-pm/paseo-collector-token",
  "paseo": {
    "url": "ws://127.0.0.1:6767/ws",
    "serverId": "<实际 daemon server ID>",
    "passwordFile": "~/.config/herdr-pm/paseo-daemon-password"
  },
  "stateDir": "~/.local/state/herdr-pm/paseo-mac-mini",
  "heartbeatMs": 10000,
  "reconcileMs": 60000,
  "maxConcurrentAgents": 4,
  "includeArchivedHistory": false,
  "includeBackground": true
}
```

没有启用 daemon 密码时省略 `passwordFile`。示例地址不是对用户实际端口的假设。真实部署使用目标 daemon 的监听地址和身份；服务模板允许为每个来源配置独立实例名。过滤规则如加入配置，必须进入来源覆盖范围定义，变更时不能误结束会话。

## 六、实施任务

### Task 1：固定 SDK 版本与只读契约验证

文件：`package.json`、lockfile、`src/paseo-collector/sdk.ts`、`tests/paseo-collector/sdk.test.ts`、`tests/fixtures/paseo/`。

- [x] 固定 `@getpaseo/client@0.15.0`，检查与仓库 TypeScript / Node 26 的兼容性。
- [x] 定义可注入的薄 SDK 封装，业务层不引用 SDK internal 路径。
- [x] 用实际 daemon 做只读探测，记录 daemon 版本、身份读取方式、完整目录分页、后台过滤、runtime session ID、timeline 返回形状。
- [x] 核实 streaming 与 projected row 的稳定 ID、修订、seq 范围、缺口信号和归档后历史可读性；将脱敏数据制作成 fixture。（归档后历史可读性按 daemon 源码确认，未在真实 agent 上归档验证：不改变用户 agent。）
- [x] 确认公开 SDK 可以实现这些读取；若缺少能力，明确最低 daemon 要求或准确的兼容降级，不改用 CLI 抓人类输出。

验收：Claude / Codex 的状态、用户消息、助手消息和工具事件可从 SDK 读取；取得本机验证证据。此任务的结果确定后，再开始时间线存储实现，避免按文档猜事件形状。

### Task 2：中心来源隔离与迁移

文件：`src/server/db.ts`、`src/server/config.ts`、新增 `src/server/sources-repo.ts`、`src/server/session-identity.ts`、修改 `src/server/sessions-repo.ts`、`src/shared/session-key.ts`。

- [x] 新增来源、来源会话和身份映射迁移，保留既有主键与证据 ID。
- [x] 为旧配置和旧数据库建立 herdr 来源；旧快照只结束该 herdr 来源的观察。
- [x] 实现来源级心跳、健康度、聚合状态、待识别会话和内容主来源规则。
- [x] pending → native 迁移覆盖 chunks、digests 的 session 引用、contributions、questions、ignored、predecessor 以及新来源表；不能遗留挂在旧身份上的分析记录。
- [x] 测试同机双来源、同 session 双来源、跨机器 ID 冲突、旧数据库升级及已有短 ID/证据引用稳定性。

验收：两个来源交替上报，互不结束会话、互不覆盖位置；单个来源离线不会被另一个心跳掩盖。

### Task 3：新 ingestion 契约与原子确认

文件：新增 `src/shared/ingest-v2.ts`、`src/server/ingest-v2.ts`、`src/server/ingest-repo.ts`；修改 `src/server/http.ts`；新增对应 server/shared 测试。

- [x] 实现来源授权、租约、快照修订、checkpoint 和不可变批次。
- [x] 同事务写入 source events、receipt、checkpoint 以及可物化的 chunks 来源关系。
- [x] 加入大小限制、事件身份校验、错误响应和恢复信息。
- [x] 为旧 chunks/offset 路径补来源约束；Paseo 数据不能污染字节续读位置。
- [x] 验证重复批次、提交成功但响应丢失、旧 writer、乱序批次、空有效内容页、无权限来源及 DB 回滚均安全。

验收：同一批次重放只产生一次有效证据和一次分析输入；失败事务不推进 checkpoint。

### Task 4：独立 Paseo 采集循环

文件：新增 `src/paseo-collector/config.ts`、`client.ts`、`discovery.ts`、`timeline.ts`、`state-store.ts`、`outbox.ts`、`loop.ts` 及对应测试。

- [x] 独立配置和密钥文件读取；按配置 daemon 身份连接。
- [x] 完整发现、订阅、定期核对、已跟踪归档会话补采及有界并发。
- [x] 首次历史导入、中心 checkpoint 恢复、outbox 原子写入与重发。
- [x] 重连补采、epoch replacement、不可恢复 gap、版本能力不足时的诊断。
- [x] 心跳与内容队列解耦；单个 agent 大历史或失败不阻塞其他 agent 和来源健康度。
- [x] 实现退出清理和同 stateDir 的单进程保护。

验收：使用 fake SDK + 真实临时中心 DB 的集成测试，覆盖崩溃在本地保存前后、中心提交前后、确认丢失，以及本地状态丢失和中心恢复旧备份。

### Task 5：内容归一化与理解层衔接

文件：新增 `src/paseo-collector/normalize.ts`、中心证据物化模块；修改 `src/domain/evidence.ts`、`src/understand/scheduler.ts`、必要的 digest/render 类型。

- [x] 将 Task 1 fixtures 转换为有来源定位、有界、可追溯的会话证据。
- [x] 处理助手分片、工具更新、历史重叠、截断及不可识别事件。
- [x] 保持已被 digest 引用的 chunk 不可变；仅新增已确认的内容或明确修订，不覆写原文。
- [x] standby 来源不重复排入摘要；身份迟到和 epoch 替换不能导致旧历史整段重复分析。
- [x] scheduler 使用统一聚合状态，沿用现有摘要/整理防抖和 backfill 逻辑。
- [x] 证据接口返回 source、外部 agent ID、时间线定位、完整性和截断信息。

验收：fixture 能贯穿 SDK → HTTP → DB → digest 输入 → 项目证据；工具失败不会被归一化成成功，idle/closed 不触发项目完成操作。自动化验证使用可注入 LLM，不依赖付费真实模型。

### Task 6：入口、展示与部署

文件：`src/cli.ts`、新增 `src/paseo-collector/cli.ts`、`config/paseo-collector.example.json`；更新 `config/server.example.json`、`README.md`；新增独立 launchd/systemd 模板。

- [x] 增加 `collect-paseo`，采用按命令动态加载 SDK，保留 `collect` 原语义。
- [x] 独立入口可直接通过 Node 26 运行，服务可与 herdr collector 同时启动。
- [ ] 回归现有 herdr Bun 构建；必要时为其使用专用入口，防止新增 SDK 依赖破坏旧单文件产物。（构建脚本已加 `--external @getpaseo/client`，静态 import 守卫测试通过；本机无 bun，实际构建未执行。）
- [x] `/sessions` 增加兼容的 `sources[]` / 采集完整性信息，旧字段保留；machine 过滤按来源机器匹配。
- [x] 更新 `src/server/change-feed.ts`、Web API 类型、session 标签/列表和证据抽屉，显示 Paseo/herdr 来源与采集滞后。
- [x] `herdr-pm open` 对 Paseo-only 会话给出准确提示，不伪造 herdr pane；Paseo 一键打开不在本期范围。
- [x] 写清中心先升级、旧 collector 继续运行、再启用 Paseo collector 的上线顺序及停用方法。

验收：旧配置不需要修改即可运行；新进程可独立停止，herdr 数据继续更新，反之亦然。

### Task 7：联合验收

- [x] 同机同时运行两个 collector，分别产生新会话，中心列表和项目视图持续更新。（真实运行覆盖已有会话的持续增量；“新建会话”只在 fake daemon 测试中覆盖，未在真实 Paseo 创建 agent。）
- [x] 同一个原生会话在两边出现：一个逻辑会话、两个来源；内容主来源明确，摘要输入不重复。
- [x] 用可控 fake daemon 验证断连、重连、替换时间线、目录分页缺失、归档与终止竞态；不为测试重启用户正在使用的 daemon。
- [x] 用两个真实 provider 的现有会话进行只读冒烟，记录实际 daemon/SDK 版本和观察结果。远程 daemon 有配置时再验证跨机；没有真实跨机结果不能宣称跨机已验收。（本机 Claude + Codex 已冒烟；跨机未验收。）
- [x] 检查敏感配置不进日志、服务模板不含真实 token、停 collector 不影响 agent。
- [ ] 运行 `npm run typecheck`、相关测试及一次完整 `npm test`；UI 改动后运行 `npm run build:web`，旧采集器构建做回归。（typecheck、npm test、build:web 已通过；bun 构建未执行。）

## 七、完成标准与上线边界

以下条件全部满足才算本期完成：

1. 两个独立进程同时汇聚到同一个中心，各自拥有配置、状态目录、token 和运行服务。
2. 旧 herdr 命令、配置、历史证据、项目链接和侧边栏行为保持兼容。
3. Paseo 当前会话历史与增量可以进入既有理解层，来源和不完整信息可追溯。
4. 采集来源的故障、空列表和分页失败不会错误结束其他来源会话。
5. 对可回放的历史，重启/重连/确认丢失不会产生漏采或重复分析；上游确实不可回放的区间明确标记缺口。
6. 同一会话的多来源身份、主内容来源和不确定重叠有明确结果，不依赖 LLM 猜测去重。
7. SDK 契约测试、中心集成测试、herdr 回归及真实只读冒烟通过。

数据库采用向前兼容迁移，上线前备份 SQLite。可以通过停用 Paseo collector 回退到只采集 herdr；中心需继续使用支持新 schema 的版本。不要把未经兼容验证的旧中心程序直接用于迁移后的数据库。

实施次序：SDK 契约验证 → 来源隔离 → ingestion 确认协议 → 独立采集器 → 理解层衔接 → 部署展示 → 联合验收。当前只提交计划，不启动实施或修改运行中的服务。（以上为计划提交时的历史状态；2026-11-06 已按本计划实施，记录见下节。）

## 八、实施记录（2026-11-06）

### 8.1 版本与只读验证证据

- 本机 daemon：`paseo status --json` → daemonVersion 0.15.0、serverId `srv_8DdaQVwMHfa7`、监听 Tailscale 地址（不是 127.0.0.1），无 daemon 密码。CLI 自带 `@getpaseo/client@0.15.0`；npm 最新为 0.15.3。依赖精确固定为 **0.15.0**（与 daemon 同版本、已逐项验证），lockfile 已更新。
- 只读探测工具：`scripts/paseo-probe.ts`（只打印形状和计数）、`scripts/paseo-fixture.ts`（生成脱敏 fixture：正文替换为同长度占位、ID 哈希、路径与时间平移；已逐值审计只剩枚举与占位）。fixture 在 `tests/fixtures/paseo/`。
- 真实 daemon 契约测试：`PASEO_CONTRACT_URL=ws://<listen>/ws npx vitest run tests/paseo-collector/sdk.test.ts`（limit 2 多页目录、按 ID 查询、未知 ID 返回 null、时间线翻页、过期 epoch），9/9 通过。

### 8.2 与计划不同、由证据决定的调整

1. **不读未加载的 agent。** daemon 0.15.0 的 `fetch_agent_timeline_request` 调 `ensureAgentLoaded`：未加载的非归档 agent 会以 interactive 方式从持久化恢复（甚至无 handle 时新建会话），属于改变 agent 生命周期。未加载的 agent 在目录里以存储记录投影出现（`status` 为持久化的 lastStatus，固定的默认 capabilities、无 modes），据此判定（`src/paseo-collector/sdk.ts` 的 `isLoaded`，不确定时按未加载处理）。这类 agent 只上报状态，`content_state = unloaded`；用户在 Paseo 打开后再从中心 checkpoint 补读。已跟踪的 agent 归档后按计划读最后一次（daemon 以 `purpose: "history"` 打开，源码注明不运行任何东西），可用 `readArchivedTracked: false` 关闭。真实冒烟确认 `closed` agent 未被读取、状态未变。
2. **daemon 只返回 projected。** 请求 `canonical` 也返回 projected。`after {seq: X}` 返回所有含 seq > X 的行，跨页边界的行会重复出现；`endCursor` 是已消费的最大 canonical seq，可能落在最后一行的范围内；读到末尾时为 maxSeq；空页 `endCursor = null`。过期 epoch 返回 `staleCursor/reset` 和**新 epoch 的最新行**（不能当作续读），采集器检测后从新 epoch 起点重读。实时事件是 canonical 增量（每段 reasoning、工具 running→completed 各一行），只用作触发。
3. **未定稿行的“暂存层”放在 daemon 侧。** 运行中的工具调用、活跃轮次的最后一行不交付，checkpoint 停在它之前（`seqStart - 1`），下次重读；不在本地另存修订。中心对同一行的后续版本：工具 running→结束、文本前缀增长 → 只物化新增部分；其他改写 → `revision_review` 保留、不覆写已引用 chunk。
4. **provider 消息 ID 不保证一行一个。** 真实 Codex agent 中两段 projected 助手行（seq 309–318、321–322）共用一个 `messageId`（中间隔一个工具调用）。中心身份改为：同 epoch 且 seq 范围重叠才算同一行的修订；同 epoch 其他位置的同 ID 行是另一行（`<id>~<seqStart>`）；内容哈希去重跨所有变体与 epoch。
5. **内容主来源的有界交接。** 真实数据里有一个 Claude 会话先在 herdr 里、后在 Paseo 里继续（同一原生 ID）。“一旦产生分析就保持稳定”会让它此后的 Paseo 工作永远是 standby。调整为：主来源的观察**已结束**（herdr 关 pane、Paseo 归档或关闭；短暂离线或心跳缺失不算），且另一来源仍 live 并有内容时，交接给后者；边界是已分析内容的最后时间，边界前保持 standby，边界后的内容（含此前已收到的 standby 证据）进入分析；记录在 `content_handovers`。真实冒烟：herdr 已分析到 2026-11-03 21:00，之后的 171 条 Paseo 事件进入分析，之前的 321 条保持 standby。
6. **批次身份不含写入者字段。** 中心对批次的内容哈希不含 `instance_id/lease_epoch`，换租约后重发同一批次仍被识别为重试；租约响应带上已接受的快照修订号，同一实例重启后接着编号。
7. **herdr pending 合并也迁移 digests**（计划要求）：`migrateSessionIdentity` 被 herdr 和 Paseo 共用，额外迁移 digests、来源表、source events、字节 checkpoint，并改写以旧键为 predecessor 的会话。
8. **身份格式。** Paseo 临时键 `paseo-pending:<serverId>:<agentId>`（短 ID 取 agentId）；跨机冲突键 `<provider>:<nativeId>@<machine>`；native ID 优先 `runtimeInfo.sessionId`，没有时用 `persistence.sessionId`（真实运行中的 Claude agent 出现过前者为 null）。`agentId` 不作为原生 ID。
9. 被排除（`exclude`）的 agent 记为 `untracked`：不结束会话，显示为 offline。

### 8.3 验证结果

- `npm test`：80 个文件、1516 通过、4 跳过（3 个原有跳过 + 未设 `PASEO_CONTRACT_URL` 时的真实 daemon 测试）；`npm run typecheck`、`npm run build:web` 通过。基线 1430 通过。
- 故障路径（fake daemon + 真实临时 SQLite 中心）：`tests/paseo-collector/collector.test.ts`、`pipeline.test.ts`，`tests/server/sources.test.ts`、`ingest-v2.test.ts`。
- 真实只读冒烟（三轮，均在临时中心上：生产库经只读连接 `VACUUM INTO` 复制，临时端口，理解层关闭；结束后删除）：
  - 迁移：生产库 v4（38 会话、801 chunk、136 digest、27 关联）→ v5，chunk/digest 的 ID 与内容签名不变，801 个 chunk 全部归到 herdr 来源，27 个字节 checkpoint 初始化。
  - Paseo 采集器与第二个 herdr 采集器（关闭 sidebar 写入）同时运行：7 个 agent（Claude 3、Codex 4）全部上报；6 个已加载 agent 历史导入，checkpoint 到达 daemon 末尾；`running`→working、`closed`→ended/unloaded；当前运行的会话持续增量（seq 2459→2473）；无行被物化两次、无缺口、无悬空的 chunk 来源。
  - SIGTERM 立即退出，outbox 清空，锁释放；日志中无 token、无对话正文；所有 agent 状态与冒烟前一致；生产中心与生产 herdr 采集器未被触碰（PID 不变）。
- 未验收：bun 单文件构建（本机无 bun）；真实跨机 daemon；真实 Paseo 中新建会话（不为测试创建 agent）；真实 epoch 替换与 daemon 断线（不重启用户 daemon，仅 fake 覆盖）；真实归档后的最后一次读取（不归档用户 agent，仅 fake 与源码核对）。
