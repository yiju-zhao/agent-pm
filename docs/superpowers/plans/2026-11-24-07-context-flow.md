# 计划 7：context 构建流（回合索引、检索、分层读取、摘要和整理改造）

日期：2026-11-24。状态：待开发。

本计划把设计里不依赖 Paseo 插件迁移的部分落到现在的中心上。做完后，任何 agent 都能通过 `/mcp` 按"全局 → 项目 → session → 回合 → 原文"逐层读取，摘要和账本的证据指向具体回合。

设计的要点都写在本文件里，开发只需要读这一份。

## 一、范围

**阶段 A（本计划，现在做）**：ticket A1 到 A7，全部在本仓库。

**阶段 B（只列 ticket，不在本次开发范围内）**：依赖"中心搬进 Paseo 插件"先完成，见第六节。

明确不做的事：

- 不为 herdr 来源建回合索引。采集范围已定为只含 Paseo 连接的机器，herdr 来源的 session 没有回合，分层读取对它们只到 session 这一层。
- 不删除任何已入库的原文。原文的上限和清除属于阶段 B。
- 不从中心连接 Paseo 读原文。中心进程没有 Paseo 客户端，原文不在库里时返回指针，由读者自己用 Paseo 的工具去读。
- 不新增模型调用。摘要员和整理员的调用次数不变。
- 不部署。线上中心跑在另一个检出上，本计划只到代码合入分支为止。

## 二、基线、分支和推送

- 开发分支：`feat/context-flow`，已建好，基于 `fix/digest-gaps-source-reminders`（提交 `d6f45fb`）。
- 为什么不基于 `master`：线上跑的是 `fix/digest-gaps-source-reminders`，它加了第 15 版数据库迁移。迁移数组只能追加，本计划的迁移必须排在它后面，从第 16 版开始。
- 每个 ticket 一个提交，提交信息沿用仓库现有写法（`feat(scope): …`、`fix(scope): …`，英文）。
- 全部 ticket 完成、`npm run typecheck` 和 `npm test` 都通过后，推送 `feat/context-flow` 到 `origin`。只推这一个分支，不推 `master`，不强推。
- **GitHub 仓库是公开的。** 暂存文件时逐个写路径，不要用 `git add -A` 或 `git add .`。工作区里有三个不属于本计划提交范围的未跟踪文件，保持未跟踪：
  - `docs/superpowers/specs/2026-11-24-context-flow-design.md`
  - `docs/superpowers/specs/2026-11-24-paseo-plugin-design.md`
  - `docs/superpowers/plans/2026-11-24-06-paseo-plugin.md`
- 代码、测试和提交信息里不要出现真实的机器地址、serverId、用户名或本机路径。测试数据用 `tests/helpers/center.ts` 里已有的占位值。

## 三、代码质量规范

依据是 <https://github.com/zhaochenyang20/sglang-diffusion-routing/issues/32>（含全部评论）。那份规范按 Python 写，下面是对应到本仓库 TypeScript 的条目。评审会逐条对照。

**正确性**

- 只在系统边界校验输入：HTTP 处理函数、MCP 工具入参、配置解析。内部函数相信调用方。
- 不写防御性代码。不存在的失败情形不要 `try/catch`，也不要为它写测试。每个 `try/catch` 和防御性的 `if` 都要答得出"删掉它会坏什么"。
- `catch` 的保护范围要窄，不包大段代码，不吞错误。
- 用提前返回减少嵌套。一个 `if` 给变量赋值或返回值时必须有 `else`；提前返回的守卫不需要。
- 缓存和缓冲要有上限或淘汰规则，长驻进程里不能有只增不减的集合。

**简单**

- 少写文件、少写函数。只被调用一两次的小函数内联回调用点。一个从上到下 60 行的函数，好过三个各被调用一次的 20 行函数。
- 没有第二个实现之前，不引入接口、基类、注册表。
- 标准库和已有依赖能做的不要重写。
- 新文件超过约 400 行就拆模块；只装一个被调用一次的小函数的文件要合并回去。

**命名和类型**

- 名字表达真实含义，不用 `data`、`result`、`info`、`tmp`、`manager`、`handler` 这类泛称，公开接口里不缩写。
- 布尔值用 `is`、`has`、`should`、`can` 开头。成对的名字要对称（`start/stop`、`open/close`）。
- 不用 `any`，不用 `as unknown as` 绕过类型检查，不用动态属性访问。取值集合固定的用字面量联合类型。
- 导出函数写明返回类型。
- 不给模块级的名字加下划线前缀。

**常量和导入**

- 不写魔法数字，提成有名字的常量。只在一处用的常量就定义在那一处；不要为了被另一个文件导入一次而放到别处。
- 导入分三组：`node:` 内置、第三方、本仓库，组间空一行。

**注释**

- 只写"为什么"，不写"做了什么"。复述代码的注释删掉。
- 简短、自洽，用英文（仓库现有约定：代码注释英文，给用户看的文字中文）。
- 不写过程标记：没有 ticket 编号的 `TODO`、分隔横幅、`[FIX]` 之类。
- 那份规范要求注释带作者名。本仓库现有注释都不带，这里沿用仓库约定，不加。

**测试**

- 测契约（输入到输出），不测内部状态。
- 一个测试只验证一个概念，名字写成一句完整的话，沿用仓库现有风格。
- 确定性：时间用测试辅助里的时钟，不用真实时间和随机数。
- 精简有力，覆盖主路径和真实会发生的错误，不为防御分支凑数。

## 四、工作方式

每个 ticket 按这个顺序做：

1. 先写测试（第五节每个 ticket 列了用例），确认它们因为功能缺失而失败。
2. 写实现，直到这个 ticket 的测试通过。
3. 跑 `npm run typecheck` 和 `npm test`，全部通过。
4. 对照第三节自查一遍，再提交。

A2 和 A4 已有写好的测试文件（`tests/server/turns.test.ts`、`tests/context/address.test.ts`），它们就是这两个 ticket 的契约。如果测试的搭建部分和现有辅助函数对不上，可以修正搭建部分；断言不能放宽，确实要改的话在汇报里写明改了什么、为什么。

遇到本文件没有回答的设计问题：能从现有代码的做法类推的，直接类推并在汇报里说明；涉及数据删除、对外行为或范围变化的，停下来提问。

## 五、阶段 A 的 ticket

依赖顺序：A1 → A2 → A3 → A4 → A5 → A6 → A7。

---

### A1 采集回合 ID

**目的**：Paseo 的时间线条目带回合 ID，采集器现在没有记录。回合索引要靠它切分回合。

**改动**

- `src/shared/ingest-v2.ts`：`TimelineEvent` 加可选字段 `turn_id: z.string().max(200).nullable().optional()`。旧采集器不发这个字段，仍然被接受。
- `src/paseo-collector/normalize.ts`：把时间线条目的 `turnId` 带到事件上。`src/paseo-collector/sdk.ts` 的 `TimelineEntry` 类型相应加字段。
- `src/server/db.ts`：新迁移，`ALTER TABLE source_events ADD COLUMN turn_id TEXT`。
- `src/server/ingest-repo.ts`：入库时写入 `turn_id`。
- 回合 ID 不参与内容哈希：同一事件只因补上回合 ID 而重发时，不算新版本。

**测试**

| 文件 | 用例 | 预期 |
|---|---|---|
| `tests/paseo-collector/normalize.test.ts` | 时间线条目带 `turnId` | 归一后的事件 `turn_id` 等于它 |
| 同上 | 时间线条目没有 `turnId` | 事件 `turn_id` 为 `null` |
| `tests/server/ingest-v2.test.ts` | 批次里的事件带 `turn_id` | `source_events.turn_id` 存下了它 |
| 同上 | 批次里的事件没有 `turn_id` 字段 | 返回 200，`turn_id` 为空 |
| 同上 | 同一事件先不带、后带 `turn_id` 重发，正文相同 | 记为重复，不产生新版本和新 chunk |

---

### A2 回合索引

**目的**：把一个 session 的事件切成回合，每个回合一行元数据。这是无损的、不用模型的大纲，摘要失败或额度用完时仍然可读。

**表（新迁移）**

```sql
CREATE TABLE turns (
  session_key TEXT NOT NULL,
  n INTEGER NOT NULL,            -- 1-based within the session, in arrival order
  turn_id TEXT,                  -- Paseo turn id; null when the collector did not send one
  first_key TEXT NOT NULL,       -- event_key of the first event (stable across timeline epochs)
  last_key TEXT NOT NULL,
  ts_start TEXT,
  ts_end TEXT,
  tool_calls INTEGER NOT NULL,
  tool_failures INTEGER NOT NULL,
  PRIMARY KEY (session_key, n)
);
```

回合行不存消息文本。文本从 `source_events` 读。

**规则**

- 只为有 `source_events` 的 session 建回合（Paseo 来源）。
- 每个 `event_key` 只算一次，取它的最新版本。时间线换代后重发的旧事件不产生新回合。
- 顺序是事件首次入库的顺序。
- 切分：事件带 `turn_id` 时，相邻且 `turn_id` 相同的事件属于同一回合。事件不带 `turn_id` 时，每条 `user` 事件开始一个新回合；第一条用户消息之前的事件和它并入第 1 回合。
- `tool_calls` 是这一回合里 `tool` 事件的个数；`tool_failures` 是其中状态为 `failed` 的个数。状态为 `running` 的工具调用算调用、不算失败。
- 回合是否还在进行不存在表里，读取时由 session 的当前状态判断。

**接口**（`src/server/turns.ts`）

```ts
export type Turn = {
  n: number;
  turn_id: string | null;
  first_key: string;
  last_key: string;
  ts_start: string | null;
  ts_end: string | null;
  tool_calls: number;
  tool_failures: number;
};

/** The turns of a session, in order. Empty for a session without source events. */
export function listTurns(db: DatabaseSync, sessionKey: string): Turn[];

/** Rebuilds a session's turns from its stored events. Same events always give the same rows. */
export function rebuildTurns(db: DatabaseSync, sessionKey: string): void;
```

- 入库事务里更新受影响 session 的回合。新增的事件只应让末尾的回合变化或追加新回合，不要每个批次都重算整个 session（长 session 有上千个事件，活跃时每两秒一个批次）。
- 命令行加子命令 `rebuild-index`：对所有 session 调用 `rebuildTurns`（A3 完成后同时重建检索）。上线时跑一次，给历史数据补建。

**测试**：`tests/server/turns.test.ts`（已写好）。另加：

| 文件 | 用例 | 预期 |
|---|---|---|
| `tests/server/turns.test.ts` | 时间线换代后，同一批事件在新代号下重发 | 回合数和各回合的首尾事件不变 |
| `tests/cli.test.ts` 或现有的命令行测试文件 | 清空 `turns` 后运行 `rebuild-index` | 回合恢复成清空之前的样子 |

---

### A3 全文检索

**目的**：能按内容找到 session、回合和账本条目。现有 `pm_search` 只搜项目字段的子串，搜不到对话和摘要。

**表（新迁移）**

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  body,
  ref UNINDEXED,          -- address the hit opens: project id, item id, s:<short>, s:<short>#<n>
  kind UNINDEXED,         -- project | milestone | todo | decision | blocker | digest | message
  project_id UNINDEXED,
  session_key UNINDEXED,
  ts UNINDEXED,
  tokenize = 'trigram'
);
```

Node 26 自带的 SQLite 已验证支持 `fts5` 的 `trigram` 分词，中文子串可搜。

**索引什么**

- 账本：项目的标题、一句话、为什么、完成标准；里程碑、todo、决策、阻塞的文字。已删除的条目不在索引里。
- 摘要：每份摘要的主题、进展、决定、阻塞。
- 对话：`source_events` 里 `user` 和 `assistant` 事件的正文，每个 `event_key` 一行，取最新版本，`ref` 指向它所在的回合。

**规则**

- 索引和它的来源在同一个事务里更新，不能出现来源改了、索引没改的状态。用触发器还是在写入路径上维护，由实现决定；选更不容易漏的那一种。
- 查询长度不足 3 个字符时 `trigram` 的 `MATCH` 不返回结果。中文词常常只有两个字，所以 1 到 2 个字符的查询改用 `LIKE` 扫描同一张表。
- 英文不分大小写。
- 结果按时间倒序，每条带一段包含命中处的片段。

**接口**（`src/server/search.ts`）

```ts
export type SearchScope = 'all' | 'ledger' | 'digests' | 'messages';

export type SearchHit = {
  ref: string;
  kind: 'project' | 'milestone' | 'todo' | 'decision' | 'blocker' | 'digest' | 'message';
  project_id: string | null;
  session_key: string | null;
  ts: string | null;
  snippet: string;
};

export function searchContext(
  db: DatabaseSync,
  query: string,
  options: { scope: SearchScope; projectId?: string; sessionKey?: string; limit: number },
): SearchHit[];

/** Rebuilds the whole index from the tables it covers. */
export function rebuildSearchIndex(db: DatabaseSync): void;
```

**测试**：`tests/server/search.test.ts`

| 用例 | 预期 |
|---|---|
| 决策文字里有"采集改为订阅驱动"，搜"订阅驱动" | 命中这条决策，`ref` 是它的 ID |
| 搜两个字的中文词"阻塞" | 命中含这个词的条目 |
| 英文关键词大小写与原文不同 | 仍然命中 |
| 用户消息里出现的词，搜它 | 命中，`kind` 为 `message`，`ref` 是这条消息所在回合的地址 |
| 摘要里出现的词，`scope: 'digests'` | 只返回摘要的命中 |
| 同一个词在两个项目里都有，带 `projectId` | 只返回那个项目的命中 |
| 改写一条 todo 的文字后搜旧文字 | 不再命中 |
| 删除一条决策后搜它的文字 | 不再命中 |
| 命中多于 `limit` | 返回 `limit` 条，最新的在前 |
| 清空索引后调用 `rebuildSearchIndex` | 之前能搜到的仍然能搜到 |

---

### A4 地址和分层读取函数

**目的**：一套读取函数，给 MCP 工具、后台模型任务和以后的面板共用。每层返回的内容有上限，每一行带着能交给下一层的地址。

**地址**（`src/context/address.ts`）

| 对象 | 写法 | 例子 |
|---|---|---|
| session | `s:<短 ID>` | `s:a3f9` |
| 回合 | `s:<短 ID>#<序号>` | `s:a3f9#12` |
| 回合里的一条 | `s:<短 ID>#<序号>.<条目号>` | `s:a3f9#12.3` |

短 ID 用现有的 session 短 ID（`src/server/sessions-repo.ts`）。条目号是这一条在回合里的次序，从 1 开始。项目和账本条目继续用它们现有的 ID。

```ts
export type Address =
  | { kind: 'session'; session: string }
  | { kind: 'turn'; session: string; turn: number }
  | { kind: 'item'; session: string; turn: number; item: number };

/** Throws on text that is not an address: addresses arrive from tool input. */
export function parseAddress(text: string): Address;
export function formatAddress(address: Address): string;
```

测试：`tests/context/address.test.ts`（已写好）。

**读取函数**（`src/context/read.ts`，返回结构化数据；渲染成文本放在工具那一层）

| 层 | 函数 | 返回 |
|---|---|---|
| 0 全局 | `readOverview(db, now, reader)` | 盲区、待处理、正在运行的 session、自上次以来各项目的变化 |
| 2 session | `readSession(db, now, shortId, { before?, limit })` | session 的基本信息和状态、卡片（A5 之后才有）、回合大纲 |
| 3 回合 | `readTurn(db, shortId, turn)` | 这一回合的每一条：消息的全文，工具调用的一行概要 |
| 4 原文 | `readItem(db, shortId, turn, item, { offset })` | 一条的原文，分页 |

第 1 层是现有的 `getProject`、`renderBrief` 和时间线，不改。

**第 0 层的内容**

- **盲区**：每个来源的连接状态和最后同步时间；有未摘要内容的 session 数；被拒绝而搁置的窗口数。数据来自现有的 `coverage` 和 `digest_blocks`。
- **待处理**：现有的提醒（`src/domain/reminders.ts`）加待你确认的问题，合成一个列表，按等待时间从长到短排。
- **正在运行**：状态为运行中的 session，每个带短 ID、机器、所属项目、当前回合序号、这一回合开始了多久、发起这一回合的用户消息的前 80 个字符。
- **自上次以来**：读者上次读到的变更记录位置之后，每个有变更的项目一行，按类型计数（阶段变化、新决策、完成的 todo、新阻塞、解除的阻塞）。
- 读者游标：新表 `reader_cursors (reader TEXT PRIMARY KEY, last_event_id INTEGER NOT NULL, last_seen_at TEXT NOT NULL)`。`readOverview` 只读不写游标；单独提供 `markOverviewRead(db, reader, now)`，由工具在返回之后调用。读者第一次读时没有游标，"自上次以来"取最近 24 小时。

**第 2 层的回合大纲**

- 每个回合一行：序号、起止时间、发起这一回合的用户消息的前 80 个字符、最后一条助手消息的前 120 个字符、工具调用数和失败数、地址。
- 默认返回最近 30 个回合；`before` 取某个序号之前的。返回里写明更早还有多少回合。
- 这个 session 没有回合（herdr 来源）时，返回它的摘要列表，并写明"没有回合索引"。

**第 3、4 层**

- 工具调用的一行概要：工具名、输入的前 200 个字符、状态、退出码。
- 第 4 层每页 4000 个字符，返回里带总长度和下一页的 `offset`。
- 采集时被截断的内容，在返回里写明原始长度和保留长度（`source_events.meta` 里已有）。
- 事件的正文为空时（以后原文被清除会出现这种情况），返回"原文不在库里"和指针：来源的 serverId、Paseo 的 agent ID、事件的稳定标识。现在不会发生，但契约先定下来，用一条直接把正文置空的测试覆盖。

**测试**：`tests/context/read.test.ts`

| 用例 | 预期 |
|---|---|
| 一个 session 正在运行，`readOverview` | "正在运行"里有它，带当前回合序号和发起消息的开头 |
| 一个来源心跳超时 | "盲区"里列出这个来源 |
| 有一条等用户的提醒和一条待确认的问题 | "待处理"里两条都在，等得久的在前 |
| 读者上次读过之后新增了一条决策 | "自上次以来"里这个项目的新决策数是 1 |
| 调用 `markOverviewRead` 之后再读 | "自上次以来"为空 |
| 读者第一次读 | "自上次以来"只含最近 24 小时的变更 |
| session 有 35 个回合，默认读取 | 返回最近 30 个，并写明更早还有 5 个 |
| 同一个 session，`before: 6` | 返回第 1 到 5 回合 |
| 回合大纲的一行 | 带发起消息的开头、最终回答的开头、工具调用数、地址 |
| herdr 来源的 session | 返回摘要列表，标明没有回合索引 |
| `readTurn` | 消息是全文；工具调用是一行概要，带状态和退出码 |
| `readItem` 读一条 9000 字符的工具输出 | 第一页 4000 字符，带总长度和下一页的 `offset` |
| `readItem` 带上一页给的 `offset` | 返回紧接着的内容，没有重复和遗漏 |
| 采集时被截断的事件 | 返回里有原始长度和保留长度 |
| 事件的正文被置空 | 返回"原文不在库里"和指针三项 |
| 短 ID 不存在，或回合序号超出范围 | 抛出错误，信息里说明是哪一个不存在 |

---

### A5 MCP 工具

**目的**：把 A3、A4 接到现有的 `/mcp` 上。

**改动**（`src/mcp/read-tools.ts`；文件超过约 400 行的部分拆到新文件）

| 工具 | 入参 | 说明 |
|---|---|---|
| `pm_overview` | 无 | 第 0 层，渲染成约 1500 字以内的文本。返回后推进这把 API key 对应的读者游标 |
| `pm_get_session` | `session`（地址或短 ID）、`before?`、`limit?` | 第 2 层 |
| `pm_get_turn` | `turn`（回合地址） | 第 3 层 |
| `pm_read_raw` | `item`（条目地址）、`offset?` | 第 4 层 |
| `pm_search` | 现有的 `query`、`limit`，加 `scope?`、`project_id?`、`session?` | 改为调用 `searchContext`。不带新参数时搜全部范围 |

渲染规则：

- 每一行以地址结尾，地址可以原样作为下一个工具的入参。
- 省略了内容时写明省略了多少、怎么取。
- 工具描述用中文，沿用现有工具的写法，说明这一层返回什么、下一步该用哪个工具。
- 读者身份用 API key 的 ID。同一把 key 的两次 `pm_overview` 之间的变更，才算"自上次以来"。

**测试**：`tests/mcp/read-tools.test.ts`

| 用例 | 预期 |
|---|---|
| `pm_overview` 的输出 | 含四个部分的标题；"正在运行"那一行以 session 地址结尾 |
| 同一把 key 连续两次 `pm_overview`，中间没有变更 | 第二次的"自上次以来"为空 |
| 两把不同的 key 各调用一次 | 互不影响对方的"自上次以来" |
| `pm_get_session` 输出里某一回合的地址，原样传给 `pm_get_turn` | 返回那一回合 |
| `pm_get_turn` 输出里某一条的地址，原样传给 `pm_read_raw` | 返回那一条的原文 |
| `pm_get_session` 既接受 `s:a3f9` 也接受 `a3f9` | 两种写法返回相同内容 |
| `pm_search` 不带新参数，搜一个只出现在对话里的词 | 命中，并带回合地址 |
| `pm_search` 带 `scope: 'ledger'` 搜同一个词 | 不命中 |
| 入参不是合法地址 | 返回工具错误，不抛到服务器外 |

---

### A6 摘要引用回合，产出 session 卡片

**目的**：摘要里的每条结论都能指到具体回合；每个 session 有一张持续更新的卡片。

**改动**（`src/understand/digest.ts`、`src/server/db.ts`）

- 交给摘要员的窗口文本里，每个回合的开头标出回合序号。窗口覆盖的回合范围写入 `digests.turn_start`、`digests.turn_end`（新列）。
- `DigestSchema` 的 `decisions`、`blockers` 各加 `turns: number[]`；`progress`、`todos_added`、`todos_done` 从字符串数组改为 `{ text: string; turns: number[] }` 的数组。模型给出的回合序号落在窗口范围之外的，丢弃那个序号，条目保留。
- `DigestSchema` 加 `session_state: { goal: string; state: string; waiting_on: string | null; next: string | null; note: string | null }`。`note` 是自由文本，给不属于固定栏目但值得留下的内容。
- `sessions` 加两列：`card`（`session_state` 的 JSON）、`card_as_of_turn`（这份摘要覆盖到的最后一个回合）。摘要写入的同一个事务里更新。
- 库里已有的旧格式摘要照常能读。读取摘要的代码（`context.ts` 的 `earlierWork`、整理员的批次渲染、A3 的检索）同时接受两种格式。
- 没有回合的 session（herdr 来源）：`turn_start`、`turn_end`、`card_as_of_turn` 为空，`turns` 为空数组，其余照常。
- 摘要员的提示词相应修改：说明回合标记的含义，要求每条结论标出来源回合，要求填写 `session_state`。不要规定"只记某一类内容"，让模型自己判断什么重要。

**测试**：`tests/understand/digest.test.ts`（沿用里面的假模型）

| 用例 | 预期 |
|---|---|
| 窗口覆盖第 3 到 5 回合 | 发给模型的文本里有这三个回合的标记；`digests.turn_start` 为 3，`turn_end` 为 5 |
| 模型返回的决定标了回合 4 | 存下的摘要里这条决定的 `turns` 是 `[4]` |
| 模型返回的回合序号是 9，窗口只到 5 | 这条条目保留，`turns` 为空 |
| 模型返回 `session_state` | `sessions.card` 等于它，`card_as_of_turn` 为 5 |
| 同一个 session 的下一份摘要 | 卡片被新的覆盖，`card_as_of_turn` 前进 |
| 摘要被拒绝 | 卡片和 `card_as_of_turn` 不变 |
| 库里有一份旧格式的摘要（`progress` 是字符串数组） | `earlierWork` 仍然输出它的进展 |
| herdr 来源的 session | 摘要成功，回合相关的列为空 |

A4 的 `readSession` 在这个 ticket 里补上卡片：返回卡片和"截至第几回合"，卡片落后于最新回合时写明落后几个回合。相应加一条测试。

---

### A7 证据指向回合，整理员可下钻，条目记录核对

**目的**：账本条目的证据从"某份摘要"细到"某几个回合"；整理员写账本之前能读回合核实；核实过的条目留下记录。

**改动**

- `src/domain/evidence.ts`：证据引用接受回合地址（`s:<短 ID>#<n>`）。证据视图对回合地址返回这一回合的消息文本和工具概要。现有的摘要引用和 chunk 引用照常工作。
- `src/understand/curator-tools.ts`：整理员的工具里加上 `get_session` 和 `get_turn`，直接复用 A4 的读取函数和 A5 的渲染。整理员的提示词里说明：摘要条目带回合序号；拿不准时先读回合再写账本；写操作的证据优先用回合地址。
- 新迁移：`decisions`、`blockers`、`todos`、`milestones` 各加 `checked_at TEXT`、`checked_ref TEXT`。
- 新操作 `mark_checked`（走现有的操作层，记入变更记录）：入参是条目类型、条目 ID、回合地址。把 `checked_at` 设为当前时间，`checked_ref` 设为那个地址。整理员和阻塞复核在对照回合确认过一条结论后调用它。
- 条目的文字被修改后，`checked_at` 和 `checked_ref` 清空。
- `getProject` 和它的渲染带上核对状态：已核对的显示依据的地址，未核对的不显示。

**测试**

| 文件 | 用例 | 预期 |
|---|---|---|
| `tests/domain/evidence.test.ts` | 证据引用是回合地址 | 证据视图返回这一回合的消息文本 |
| 同上 | 证据引用是现有的摘要引用 | 行为和改动前相同 |
| 同上 | 回合地址指向不存在的回合 | 证据视图标明"找不到"，不抛错（旧数据里会有失效的引用） |
| `tests/understand/curator-tools.test.ts` | 整理员的工具列表 | 含 `get_session` 和 `get_turn` |
| 同上 | 调用 `get_turn` | 返回内容和 `pm_get_turn` 相同 |
| `tests/domain/` 下对应的操作测试 | `mark_checked` 一条决策 | `checked_at` 是当前时间，`checked_ref` 是传入的地址，变更记录里多一条 |
| 同上 | 撤销这次 `mark_checked` | 两个字段恢复为空 |
| 同上 | 已核对的决策被改了文字 | 两个字段清空 |
| 同上 | `mark_checked` 的地址不是回合地址 | 操作被拒绝 |
| `tests/understand/render.test.ts` | 已核对的决策渲染成 Markdown | 这一行带核对依据的地址 |

---

### 阶段 A 的完成标准

- A1 到 A7 的测试全部通过，`npm run typecheck` 和 `npm test` 全部通过，原有测试没有被删除或放宽。
- 在一个由测试辅助建起来的库上，用 MCP 工具从 `pm_overview` 走到 `pm_read_raw`，每一步只用上一步输出里的地址。把这段脚本和它的输出贴在汇报里。
- `rebuild-index` 在同一个库上连续运行两次，`turns` 和 `search_index` 的内容相同。
- 分支已推送。

**汇报内容**：每个 ticket 的提交号；改动了哪些既有行为；对测试或接口契约做过的任何偏离及原因；没做完或拿不准的地方。

## 六、阶段 B 的 ticket（不在本次开发范围内）

依赖"中心搬进 Paseo 插件"先完成。这里只记下范围，开发前再细化。

| ticket | 内容 | 主要测试 |
|---|---|---|
| B1 经指针读原文 | 读取层在正文为空时经 Paseo 读回合和条目；每个 session 记录指针是否可达和不可达的原因 | 假的 Paseo 读取器：库里有就不调用它；库里没有就调用并返回；它失败时返回原因 |
| B2 原文上限和清除 | 设置项"原文存储上限"；超过后从最旧的已摘要内容开始把正文置空，行保留；调小上限前先显示会清除多少并要求确认 | 超过上限后最旧的被置空；未摘要的不动；清除后回合大纲和检索的行为；重发的旧事件不被重新入库 |
| B3 数据库位置和首次启动 | 默认路径按 daemon 的 serverId 分目录；首次启动自动建库；建过库之后文件不见了就报错，不悄悄新建 | 首次启动建库；记录里有库而文件缺失时拒绝启动；卸载重装后打开原库 |
| B4 接入其他机器 | 设置页列出已登记的机器；app 里连着但没登记的机器可一键接入；手填连接地址 | 已登记的自动出现；新登记的默认不采集；一键接入读到的地址被登记；监听本机地址时按钮不可用 |
| B5 面板 | 主屏四个页签、项目页、session 页、回合页、工作区面板 | 每个页面用 A4 的读取函数取数；窄屏布局；主题颜色 |
| B6 总管入口 | 从面板创建带标签的 agent，打开时注入角色说明、入口页和读取工具；创建时禁掉执行命令和写文件 | 只有带标签的 agent 拿到工具；注入的入口页是当时的；创建参数里带禁用项 |
| B7 以项目为单位的整理 | 把整理员、阻塞复核、项目复核、阶段复核合成一次"读、核对、纠正、控制篇幅、入账" | 用现有 fixtures 重放，账本结果不变差；模型调用次数不增加 |
| B8 换代重发的去重 | 时间线换代后内容相同的重发事件不再存成新版本 | 相同内容在新代号下重发，`source_events` 行数不变 |

## 七、未决事项

- **对话文本要不要参与清除**（影响 B2）：当前设计是和工具详情一样到上限就清；另一种是对话文本永久保留。等用户决定。阶段 A 不受影响。
- **入库内容是否脱敏**：未定，阶段 A 不处理。
