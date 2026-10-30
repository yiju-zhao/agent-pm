# herdr-pm 计划 2：领域操作层 + HTTP API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 中心服务有了"项目账本"：项目、里程碑、todo、决策、阻塞、session 关联、问答箱、事件日志，全部通过同一个操作层修改；AI 和用户走同一套操作，信任边界（状态机、字段锁、否决、提议转问题）写在代码里；网页要用的 HTTP API 全部就位。

**Architecture:** 新增 `src/domain/`：`execute(db, deps, input)` 是对项目状态的唯一写入口，每个操作在一个事务里先改状态表、再追加一条 event（只记录改动列的前后值，供撤销）。AI 的操作先过策略检查：允许的直接执行，越界的自动转成确认题，违规的拒绝。`src/server/domain-routes.ts` 把 HTTP 请求翻译成操作，读接口走 `src/domain/read.ts`。这一期仍不调用 LLM；AI 的写入口（MCP）在计划 3 接上，本期用单元测试以 `ai:curator` 身份直接调用领域层。

**Tech Stack:** 沿用计划 1：Node 26（原生 .ts）、`node:sqlite`、Hono、zod 4、vitest。

**Spec:** `docs/superpowers/specs/2026-10-29-project-manager-design.md`（第 3、7、8、9、10、12 节）

**路线图（本计划是第 2 个）：**
1. 数据采集地基（已完成，已合并到 master）
2. **领域操作层 + HTTP API**（本计划）
3. 理解层：摘要员、整理员（Claude Agent SDK + OAuth token）、MCP 服务、`POST /sync`、`digests` / `llm_runs` 表、`pm_report`
4. 网页界面，以及 `WS /stream` 实时推送
5. herdr 查找工具和侧边栏短 ID

## Global Constraints

- 沿用计划 1：Node 26 直接运行 `.ts`；`erasableSyntaxOnly`、`verbatimModuleSyntax`；本地 import 写 `.ts` 后缀；不用 enum 和参数属性。
- 迁移只追加：在 `src/server/db.ts` 的 `MIGRATIONS` 末尾加新条目，不改已有条目。
- **对项目状态的唯一修改方式是 `execute()`**（spec 第 3 节）。HTTP、以后的 MCP、问题回答都只调用它；`src/domain/` 以外不写项目相关的表。
- 每个操作在**同一个事务**里先改状态表，再追加**一条** event。event 记录 `occurred_at`（对话里发生的时间，调用方可传，默认现在）和 `recorded_at`（写入时间，永远取 `deps.now()`）。
- 所有时间戳都是 `Date.prototype.toISOString()` 格式的 UTC 字符串，来自 `deps.now()`，不来自请求体（`occurred_at`、`decided_at`、`ts_start`、`ts_end` 这类"发生时间"字段除外）。
- 阶段标识：`idea`、`explore`、`build`、`verify`、`done`、`parked`、`abandoned`、`merged`，对应 spec 里的 idea / 探索 / 构建 / 验证 / 完成 / 搁置 / 放弃 / 合并。
- 优先级：`P0`、`P1`、`P2`、`P3`，或 `null`（未设置）。
- 操作者：`'user'`，或 `ai:<名字>`（例如 `ai:curator`）。
- **AI 的每个写操作都必须带非空 `reason` 和至少一条 `evidence`**，evidence 格式为 `^(digest|chunk|event|question):[A-Za-z0-9_]+(#\S+)?$`（例如 `chunk:123#L40`、`digest:4812`），否则拒绝。用户的操作不需要。
- 信任边界（spec 第 7 节，加上本计划的补充，补充项标 ★）：

| AI 直接执行 | AI 只能提议（自动转成确认题） | AI 被拒绝 |
|---|---|---|
| 新建项目（只能在 `idea` 阶段） | 完成、放弃、合并 | 新建项目时指定非 `idea` 阶段 |
| 关联 session | 修改用户锁定的字段 | 修改、恢复已被用户删除的条目（墓碑） |
| 沿 idea→explore→build→verify 前进一步 | 往后退阶段、跳级、从搁置恢复、重开已结束的项目 | 解锁字段、撤销事件（仅限用户） |
| 增删改 todo、里程碑、阻塞；记录决策 | ★ 搁置（spec 说搁置是"一个决定"） | 写入已合并的项目（返回合并目标） |
| 修改未锁定的项目字段（含优先级建议值） | ★ 不追踪 session（`ignore_session`） | |
| | ★ 删除用户创建或编辑过的条目、取消用户建立的关联 | |
| | 重新关联用户取消过的 session ↔ 项目 | |

- **用户的删除和撤销就是否决**（spec 第 7 节）：用户删除的条目留墓碑（`deleted_at` + `vetoed = 1`）；用户撤销 AI 的事件同样记为否决（`events.is_veto = 1`），被撤销的字段自动加锁，被撤销而消失的条目和关联留否决墓碑。
- 用户通过操作修改的项目、todo、里程碑字段自动加锁（spec 第 7 节）。
- 后端是 SQLite 唯一的读写者（spec 第 12 节）。
- **与 spec 的偏差（计划作者的决定）**：
  - 改变状态的 HTTP 接口要求 `Authorization: Bearer <userToken>`（中心配置新增 `userToken`）。原因：同一个 Tailscale 网络里的 coding agent 用 curl 就能以"用户"身份绕过信任边界。GET 接口保持开放。浏览器怎么拿到 token 由计划 4 决定。
  - `contributions` 每个 (session, 项目) 只有一行：再次关联时更新里程碑、摘要、置信度，并把时间范围扩大。按时间段细分的贡献由计划 3 的摘要提供。
  - spec 表里 `projects.last_activity_at` 不存储，读取时由 `max(项目创建时间, 未删除关联的 ts_end)` 算出，避免多处维护。

## Review Focus

1. **用户在 AI 的提议待回答时直接改了同一个字段** → 提议自动撤回；如果此时再点"确认"，返回 409，不能用旧提议覆盖用户的新值。（Task 3 `withdrawStale` + Task 8 端到端测试）
2. **撤销一条之后又被改过的事件** → 返回 409 `conflict`，指出是哪一列，绝不悄悄覆盖较新的值。（Task 7 测试）
3. **AI 从旧摘要里"复活"被用户否决的东西**：用旧 ID 改墓碑条目被拒绝，重新关联用户取消过的 session 变成确认题而不是直接关联。（Task 5、6 测试）
4. **无 ID 的 session（`pending:` 键）被关联到项目后才认出真实 ID** → 关联和问题跟着迁移到真实键，项目卡片上不丢 session。（Task 6 测试）
5. **请求里的 ID 不存在、已删除或属于别的项目**（例如把 todo 挂到另一个项目的里程碑上）→ 404 / 400，不会崩溃，也不会跨项目串数据。（Task 5 + Task 10 测试）

---

## 文件结构

```
src/server/db.ts                 追加 MIGRATIONS[1]：领域表
src/server/sessions-repo.ts      修改：insertChunks 跟随 merged_into；pending 合并时迁移关联和问题
src/collector/loop.ts            修改：每个进程首次推送一律从中心的最大 offset 续读
src/domain/types.ts              Stage / Priority / Actor / DomainDeps / OpResult / OpRejected
src/domain/ops.ts                OP_SCHEMAS（每个操作参数的 zod 定义）、OpInput、EVIDENCE_RE
src/domain/changes.ts            ChangeSet（记录改动列的前后值）、appendEvent、锁工具
src/domain/stage.ts              阶段状态机
src/domain/questions.ts          创建问题（去重、上限、冷却）、askUser、withdrawStale、expireQuestions
src/domain/execute.ts            execute / runOp：校验、策略、事务、写 event
src/domain/projects-ops.ts       create_project / update_project / transition_stage / unlock_field
src/domain/items-ops.ts          里程碑 / todo / 决策 / 阻塞
src/domain/links-ops.ts          link_session / unlink_session / ignore_session
src/domain/revert.ts             revert_event
src/domain/answers.ts            answerQuestion / dismissQuestion
src/domain/read.ts               listProjects / getProject / listQuestions
src/server/domain-routes.ts      mountDomainRoutes：HTTP → 操作
src/server/http.ts, config.ts    修改：挂载新路由、userToken、JSON 500
tests/domain/*.test.ts, tests/domain/helpers.ts, tests/server/domain-routes.test.ts
```

---

### Task 1: 采集遗留问题（计划 1 搁置项）

**Files:**
- Modify: `src/collector/loop.ts:141-154`, `src/server/sessions-repo.ts`（`insertChunks`）
- Test: `tests/collector/loop.test.ts`, `tests/server/sessions-repo.test.ts`

背景：计划 1 的 R9 在每个采集器进程首次推送某个 session 时，从 `min(本地游标, 中心最大 offset)` 续读。如果采集器在"中心已收下 chunk"和"本地保存游标"之间崩溃，本地游标会落后；从本地游标重读时，最后一个窗口会被重新分组，`offset_start` 相同但内容更多的 chunk 被当成重复丢掉，丢几行对话。另外，推给一个已经合并掉的 pending 键的 chunk 会滞留在旧键下。

**Interfaces:**
- Produces（行为变化，签名不变）：
  - 首次推送：`offset = serverMax ?? 0`，不论本地游标是多少（中心比本地新时用中心的；中心被恢复成旧备份时同样用中心的，等价于 R9 的那一半）。
  - `insertChunks`：`session_key` 对应的 session 行有 `merged_into` 时，chunk 存到合并目标下（沿 `merged_into` 最多跟 5 跳）。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/collector/loop.test.ts
test('first push per process resumes from server max when server is ahead of local cursor (crash window)', async () => {
  // 本地游标 = 第 2 行末尾，中心 getOffset 返回第 4 行末尾；文件有 6 行
  // 断言：推送的第一个 chunk 的内容从第 5 行开始，没有 offset_start 落在第 4 行末尾之前的 chunk
});
test('first push per process resumes from server max when server is behind (restored db)', async () => {
  // 本地 = 第 4 行末尾，中心 = 第 2 行末尾 → 从第 3 行开始推
});
// tests/server/sessions-repo.test.ts
test('chunks pushed to a merged pending key are stored under the native key', () => {
  // pending:m:t1 合并到 codex:abc 之后，insertChunks 推 session_key = pending:m:t1
  // 断言：chunks 里这条的 session_key = 'codex:abc'，maxOffset('codex:abc') 包含它
});
```

- [ ] **Step 2: 运行，确认失败** `npx vitest run tests/collector/loop.test.ts tests/server/sessions-repo.test.ts` → 新测试 FAIL

- [ ] **Step 3: 实现**（`loop.ts` 改掉 `Math.min`，同时更新那段注释；`insertChunks` 在事务里按 session 键缓存解析结果）

- [ ] **Step 4: 运行全部测试** `npx vitest run && npx tsc` → 全部 PASS，tsc 无输出

- [ ] **Step 5: Commit** `git commit -m "fix(ingest): resume from server offset on first push; route chunks of merged pending keys"`

---

### Task 2: 领域表、类型、操作定义与改动记录

**Files:**
- Modify: `src/server/db.ts`（追加 `MIGRATIONS[1]`）
- Create: `src/domain/types.ts`, `src/domain/ops.ts`, `src/domain/changes.ts`
- Test: `tests/server/db.test.ts`（新建）, `tests/domain/changes.test.ts`, `tests/domain/ops.test.ts`

**迁移 `MIGRATIONS[1]`**（列名照抄；所有 `*_at` 和 `ts_*` 是 ISO 文本；JSON 列存文本）：

| 表 | 列 |
|---|---|
| `projects` | `id` PK, `title`, `stage`, `stage_before_park`, `priority`, `summary`, `why`, `done_criteria`, `merged_into`, `locks` DEFAULT `'[]'`, `created_by`, `user_touched` INTEGER DEFAULT 0, `created_at`, `deleted_at`, `vetoed` INTEGER DEFAULT 0 |
| `milestones` | `id` PK, `project_id`, `title`, `status`, `position` INTEGER, `locks` DEFAULT `'[]'`, `created_by`, `created_at`, `deleted_at`, `vetoed` DEFAULT 0 |
| `todos` | `id` PK, `project_id`, `milestone_id`, `title`, `status`, `priority`, `locks` DEFAULT `'[]'`, `created_by`, `created_at`, `deleted_at`, `vetoed` DEFAULT 0 |
| `decisions` | `id` PK, `project_id`, `text`, `decided_at`, `evidence`, `created_by`, `created_at`, `deleted_at`, `vetoed` DEFAULT 0 |
| `blockers` | `id` PK, `project_id`, `text`, `kind`, `status`, `cleared_at`, `created_by`, `created_at`, `deleted_at`, `vetoed` DEFAULT 0 |
| `contributions` | `id` PK, `session_key`, `project_id`, `milestone_id`, `summary`, `ts_start`, `ts_end`, `confidence` REAL, `actor`, `created_at`, `deleted_at`, `vetoed` DEFAULT 0, UNIQUE(`session_key`, `project_id`) |
| `questions` | `id` PK, `kind`, `prompt`, `options`, `project_id`, `session_key`, `status`, `answer`, `evidence`, `guards`, `dedupe_key`, `rejected` INTEGER DEFAULT 0, `resolution_note`, `created_by`, `created_at`, `resolved_at` |
| `events` | `id` INTEGER PK, `occurred_at`, `recorded_at`, `actor`, `op`, `entity`, `project_id`, `args`, `before`, `after`, `reason`, `evidence`, `question_id`, `reverts` INTEGER, `reverted_by` INTEGER, `is_veto` INTEGER DEFAULT 0 |

索引：`events(project_id, id)`、`questions(status)`、`questions(dedupe_key)`、`contributions(project_id)`、`todos(project_id)`、`milestones(project_id)`。

**Interfaces:**
- Produces（`src/domain/types.ts`）：
  - `STAGES`、`type Stage`；`PRIORITIES`、`type Priority`；`STAGE_LABEL: Record<Stage, string>` = `{ idea: 'idea', explore: '探索', build: '构建', verify: '验证', done: '完成', parked: '搁置', abandoned: '放弃', merged: '合并' }`
  - `type Actor = 'user' | \`ai:${string}\``；`isAi(actor: Actor): boolean`
  - `type IdPrefix = 'p' | 'm' | 't' | 'd' | 'b' | 'c' | 'q'`
  - `type DomainDeps = { now: () => Date; newId: (prefix: IdPrefix) => string }`；`defaultDeps(): DomainDeps`（`newId` = `${prefix}_${randomBytes(6).toString('hex')}`）
  - `type RejectCode = 'invalid' | 'not_found' | 'vetoed' | 'merged' | 'not_allowed' | 'user_only' | 'missing_reason' | 'missing_evidence' | 'conflict' | 'already_reverted' | 'not_revertible' | 'not_pending' | 'stale' | 'question_limit' | 'recently_rejected'`
  - `class OpRejected extends Error { readonly code: RejectCode }`（构造参数 `(code, message)`，用普通字段赋值，不用参数属性）
  - `type OpResult = { status: 'applied'; event_id: number | null; id?: string; question_ids: string[]; warnings: string[] } | { status: 'proposed'; question_ids: string[] } | { status: 'rejected'; code: RejectCode; message: string }`
- Produces（`src/domain/ops.ts`）：
  - `OP_SCHEMAS`：每个操作一个 `z.object({...}).strict()`，字段如下（`?` = 可选；`Id` = 非空字符串；`Text` = 去掉首尾空白后非空、最长 4000）：
    - `create_project { title: Text(≤200), summary?, why?, done_criteria?: Text, priority?: Priority|null, stage?: Stage }`
    - `update_project { project: Id, fields: { title?, summary?, why?, done_criteria?: Text, priority?: Priority|null } }`（`fields` 至少一个键）
    - `transition_stage { project: Id, stage: Stage, merge_into?: Id }`
    - `unlock_field { table: 'projects'|'todos'|'milestones', id: Id, field: string }`
    - `upsert_milestone { project: Id, id?: Id, title?: Text, status?: 'todo'|'doing'|'done', position?: int≥0 }`
    - `upsert_todo { project: Id, id?: Id, title?: Text, status?: 'todo'|'doing'|'done', priority?: Priority|null, milestone_id?: Id|null }`
    - `record_decision { project: Id, text: Text, decided_at?: ISO }`
    - `set_blocker { project: Id, id?: Id, text?: Text, kind?: 'user'|'external'|'technical' }`
    - `delete_milestone`、`delete_todo`、`delete_decision`、`delete_blocker`、`clear_blocker`：`{ project: Id, id: Id }`
    - `link_session { session: Id, project: Id, milestone_id?: Id|null, summary?: Text, ts_start?: ISO, ts_end?: ISO, confidence?: number 0..1 }`
    - `unlink_session { session: Id, project: Id }`
    - `ignore_session { session: Id, ignored?: boolean }`（默认 `true`）
    - `revert_event { event_id: int>0 }`
  - `type OpName = keyof typeof OP_SCHEMAS`；`type OpArgs<N extends OpName> = z.infer<(typeof OP_SCHEMAS)[N]>`
  - `type OpInput = { op: OpName; args: unknown; actor: Actor; reason?: string; evidence?: string[]; occurred_at?: string; question_id?: string }`
  - `EVIDENCE_RE = /^(digest|chunk|event|question):[A-Za-z0-9_]+(#\S+)?$/`
- Produces（`src/domain/changes.ts`）：
  - `type DomainTable = 'projects' | 'milestones' | 'todos' | 'decisions' | 'blockers' | 'contributions' | 'sessions'`（`sessions` 的主键列是 `key`，其余是 `id`）
  - `type Change = { table: DomainTable; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> }`
  - `readRow(db, table, id): Record<string, unknown> | undefined`
  - `class ChangeSet`：`constructor(db)`；`insert(table, row)`（`before = null`，`after` = 插入的全部列）；`update(table, id, patch): boolean`（只记录值真的变了的列，没有变化返回 `false` 且不写库；同一行在一个 ChangeSet 里多次 update 合并成一个 Change，`before` 保留最早的值）；`changes: Change[]`
  - `appendEvent(db, e: { occurred_at, recorded_at, actor, op, project_id: string | null, args: unknown, changes: Change[], reason: string | null, evidence: string[], question_id: string | null, reverts?: number, is_veto?: boolean }): number`：`entity` = 第一个 Change 的 `${table}:${id}`；`before` / `after` 存成以 `${table}:${id}` 为键的 JSON 对象；返回新 event 的 id
  - `LOCKABLE = { projects: ['title', 'summary', 'why', 'done_criteria', 'priority'], todos: ['title', 'status', 'priority', 'milestone_id'], milestones: ['title', 'status', 'position'] }`
  - `readLocks(row): string[]`；`addLocks(row, fields: string[]): string`（返回新的 JSON 文本，只保留 LOCKABLE 内的字段，去重排序）

- [ ] **Step 1: 写失败的测试**

```ts
// tests/server/db.test.ts
test('a v1 database (ingestion only) upgrades to v2 and keeps its sessions', () => {
  // 只跑 MIGRATIONS[0]、插一行 session，再 openDb 同一文件
  // 断言：user_version = 2，session 还在，projects / events 表存在
});
// tests/domain/changes.test.ts
test('update records only columns whose value changed', () => {
  // insert projects { id:'p_1', title:'A', summary:'s' } 后 update('projects','p_1',{ title:'B', summary:'s' })
  expect(cs.changes.at(-1)).toEqual({ table: 'projects', id: 'p_1', before: { title: 'A' }, after: { title: 'B' } });
});
test('update with no actual change returns false and records nothing', () => {});
test('two updates of one row merge into one change keeping the earliest before', () => {
  // title A→B→C ⇒ before {title:'A'} after {title:'C'}
});
test('appendEvent stores before/after keyed by table:id and entity of the first change', () => {
  // 断言 events.entity = 'projects:p_1'，JSON.parse(before)['projects:p_1'] = null（insert）
});
test('sessions rows are addressed by key', () => { /* update('sessions','claude:x',{ignored:1}) */ });
test('addLocks keeps only lockable fields, dedupes and sorts', () => {
  expect(addLocks({ locks: '["title"]' }, ['priority', 'title', 'stage'])).toBe('["priority","title"]');
});
// tests/domain/ops.test.ts
test('schemas are strict and trim-check text', () => {
  expect(OP_SCHEMAS.create_project.safeParse({ title: '  ' }).success).toBe(false);
  expect(OP_SCHEMAS.create_project.safeParse({ title: 'x', bogus: 1 }).success).toBe(false);
  expect(OP_SCHEMAS.update_project.safeParse({ project: 'p_1', fields: {} }).success).toBe(false);
});
test('evidence format', () => {
  expect(['chunk:123#L40', 'digest:4812'].every((e) => EVIDENCE_RE.test(e))).toBe(true);
  expect(EVIDENCE_RE.test('see chat')).toBe(false);
});
```

- [ ] **Step 2: 运行，确认失败** `npx vitest run tests/server/db.test.ts tests/domain` → FAIL

- [ ] **Step 3: 实现** 迁移、`types.ts`、`ops.ts`、`changes.ts`。`ChangeSet` 用参数化 SQL；表名和列名只来自代码里的白名单，不来自请求。

- [ ] **Step 4: 运行全部测试** `npx vitest run && npx tsc` → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(domain): schema v2, op schemas, change recording"`

---

### Task 3: 问答箱核心（创建、去重、上限、冷却、自动撤回）

**Files:**
- Create: `src/domain/questions.ts`
- Test: `tests/domain/questions.test.ts`

**Interfaces:**
- Consumes: `OP_SCHEMAS`、`OpRejected`、`DomainDeps`、`Actor`、`DomainTable`、`readRow`
- Produces:
  - 常量：`MAX_PENDING_AI_QUESTIONS = 30`、`REJECT_COOLDOWN_DAYS = 7`、`QUESTION_TTL_DAYS = 30`
  - `type QuestionOption = { label: string; op: OpName | null; args?: Record<string, unknown>; text_arg?: string }`
  - `type Guard = { table: DomainTable; id: string; col: string; equals: unknown }`
  - `type QuestionDraft = { kind: 'choice' | 'text' | 'confirm'; prompt: string; options: QuestionOption[]; project_id: string | null; session_key: string | null; evidence: string[]; guards: Guard[]; dedupe_key: string; created_by: Actor }`
  - `createQuestion(db, deps, draft): { id: string; deduped: boolean }`（不开事务，由调用方包）
  - `confirmOptions(op: OpName, args: object): QuestionOption[]` → `[{ label: '确认', op, args }, { label: '拒绝', op: null }]`
  - `AskUserInput`（zod）：`{ kind: 'choice', prompt, options: 2..6 个 QuestionOption } | { kind: 'text', prompt, option: QuestionOption（必须有 text_arg） } | { kind: 'confirm', prompt, option: QuestionOption（op 非空） }`，外加共有的 `project_id?`、`session_key?`、`topic?`、`evidence: string[]`（至少 1 条，符合 `EVIDENCE_RE`）
  - `askUser(db, deps, input: unknown, actor: Actor): OpResult`（自己开事务；`confirm` 用 `confirmOptions` 补上"拒绝"；`dedupe_key = ask:${project_id ?? '-'}:${session_key ?? '-'}:${topic ?? kind}`；`guards = []`）
  - `withdrawStale(db, deps, touched: Array<{ table: DomainTable; id: string }>): string[]`：重新检查守卫涉及这些行的待回答问题，不再成立的改为 `withdrawn`、`resolution_note = 'stale'`，返回被撤回的 id
  - `guardsHold(db, guards: Guard[]): boolean`
  - `expireQuestions(db, deps): number`：创建超过 `QUESTION_TTL_DAYS` 的待回答问题改为 `expired`

规则：
- 每个 option 的 `args` 在创建时就用 `OP_SCHEMAS[op]` 校验（`text` 类先把 `text_arg` 指向的位置填成 `'x'` 再校验），不合格 → `OpRejected('invalid')`。这样回答时不会因为参数形状失败。
- `text_arg` 是点号路径，可以指向嵌套字段，例如 `fields.done_criteria` 表示 `args.fields.done_criteria`。导出 `setArgPath(args, path, value): Record<string, unknown>`（返回新对象，不改原对象），Task 8 回答填空题时复用。
- **去重**：已有同 `dedupe_key` 的待回答问题时，不新建，把新的 evidence 追加到它上面（去重），返回 `{ id: 已有id, deduped: true }`。
- **上限**：`created_by` 是 AI 时，待回答的 AI 问题已达 `MAX_PENDING_AI_QUESTIONS` → `OpRejected('question_limit')`（去重命中不受上限影响）。
- **冷却**：最近 `REJECT_COOLDOWN_DAYS` 天内有同 `dedupe_key` 的问题被用户拒绝过（`rejected = 1`）→ `OpRejected('recently_rejected')`。
- 新问题 `status = 'pending'`，`id` 来自 `deps.newId('q')`。

- [ ] **Step 1: 写失败的测试**

```ts
test('same dedupe_key while pending appends evidence instead of creating a second question', () => {
  const a = createQuestion(db, deps, draft({ dedupe_key: 'k', evidence: ['chunk:1'] }));
  const b = createQuestion(db, deps, draft({ dedupe_key: 'k', evidence: ['chunk:2', 'chunk:1'] }));
  expect(b).toEqual({ id: a.id, deduped: true });
  expect(evidenceOf(a.id)).toEqual(['chunk:1', 'chunk:2']);
});
test('option args are validated against the op schema at creation', () => {
  expect(() => createQuestion(db, deps, draft({ options: [{ label: 'x', op: 'update_project', args: { project: 'p_1' } }] }))).toThrow(/invalid/);
});
test('ai questions are capped at MAX_PENDING_AI_QUESTIONS; user-created are not', () => {});
test('a question rejected within REJECT_COOLDOWN_DAYS blocks the same dedupe_key; after the cooldown it is allowed', () => {});
test('withdrawStale withdraws questions whose guard no longer holds and leaves others', () => {
  // guard { table:'projects', id:'p_1', col:'title', equals:'A' }，把 title 改成 'B' 后调用
  expect(withdrawStale(db, deps, [{ table: 'projects', id: 'p_1' }])).toEqual([q1]);
});
test('expireQuestions expires pending questions older than QUESTION_TTL_DAYS', () => {});
test('askUser confirm appends the 拒绝 option and text requires text_arg', () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL

- [ ] **Step 3: 实现**（测试里直接用 SQL 插 `projects` 行做守卫对象，不依赖后面的任务）

- [ ] **Step 4: 运行** `npx vitest run tests/domain && npx tsc` → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(domain): question box core with dedupe, cap, cooldown, stale withdrawal"`

---

### Task 4: 操作入口、阶段状态机、项目操作

**Files:**
- Create: `src/domain/execute.ts`, `src/domain/stage.ts`, `src/domain/projects-ops.ts`, `tests/domain/helpers.ts`
- Test: `tests/domain/stage.test.ts`, `tests/domain/projects-ops.test.ts`

**Interfaces:**
- Consumes: Task 2、3 的全部导出
- Produces（`stage.ts`）：
  - `FLOW = ['idea', 'explore', 'build', 'verify'] as const`；`CLOSED: Stage[] = ['done', 'abandoned', 'merged']`
  - `aiMayTransition(from: Stage, to: Stage): boolean`：仅当 `from` 是 idea / explore / build 且 `to` 是 `FLOW` 里的下一个
  - `checkTransition(from: Stage, to: Stage, mergeInto?: string): void`：`from === to` → `invalid`；`to === 'merged'` 必须带 `mergeInto`；`mergeInto` 只能和 `merged` 一起出现。用户可以做其余任意转换（包括重开已结束的项目）。
- Produces（`execute.ts`）：
  - `type OpContext = { db; deps; actor: Actor; ai: boolean; reason: string | null; evidence: string[]; occurredAt: string; questionId: string | null; changes: ChangeSet; projectId: string | null; questionIds: string[]; warnings: string[]; proposalErrors: OpRejected[]; isVeto: boolean; propose(draft: Omit<QuestionDraft, 'created_by' | 'evidence'>): void }`
    - `propose` 用 `createQuestion` 建确认题（`created_by` = actor，`evidence` = ctx.evidence），id 推入 `questionIds`。`createQuestion` 抛出的 `OpRejected`（`question_limit` / `recently_rejected`）由 `propose` 捕获，存进 `ctx.proposalErrors: OpRejected[]`，handler 继续执行
  - `type Handler = (ctx: OpContext, args: any) => { id?: string } | void`
  - `HANDLERS: Partial<Record<OpName, Handler>>`（本任务注册项目操作；Task 5–7 往里加）
  - `runOp(db, deps, input: OpInput): OpResult`：不开事务，出错抛 `OpRejected`
  - `execute(db, deps, input: OpInput): OpResult`：开事务调 `runOp`；捕获 `OpRejected` 时回滚并返回 `{ status: 'rejected', code, message }`
  - `runOp` 的顺序：
    1. `OP_SCHEMAS[op]` 解析参数，失败 → `invalid`（message 里带 zod 的问题路径）
    2. AI：`reason` 为空 → `missing_reason`；`evidence` 为空或有一条不合格式 → `missing_evidence`；操作是 `unlock_field` / `revert_event` → `user_only`
    3. 没注册 handler 的操作 → `invalid`
    4. 调 handler
    5. 有改动 → `appendEvent`（`project_id` = `ctx.projectId`，`is_veto` = `ctx.isVeto`），然后对所有改动行调 `withdrawStale`，返回 `applied`；`proposalErrors` 里的每一条转成一条 `warnings`（`${code}: ${message}`）
    6. 没有改动但有问题 → `proposed`
    7. 既没有改动也没有问题：`proposalErrors` 非空 → 抛出第一条；否则 `applied` 且 `event_id: null`
- Produces（`projects-ops.ts`）：
  - `loadProject(ctx, id: string): Row`：不存在或已删除 → `not_found`；AI 写入 `stage = 'merged'` 的项目 → `merged`（message 带 `merged_into`）。设置 `ctx.projectId`。Task 5、6 复用它。
  - handler：`create_project`、`update_project`、`transition_stage`、`unlock_field`
- Produces（`tests/domain/helpers.ts`）：`setup(): { db, deps, setNow(iso: string): void, user(op, args): OpResult, ai(op, args, extra?: { reason?, evidence? }): OpResult }`。`db = openDb(':memory:')`；时钟默认 `2026-10-29T12:00:00.000Z`；`newId` 是计数器（`p_1`、`p_2`……）；`ai()` 默认 `actor: 'ai:curator'`、`reason: 'r'`、`evidence: ['chunk:1']`。

各操作的规则：
- `create_project`：AI 只能建 `idea`（传了别的阶段 → `not_allowed`）；`created_by` = actor；默认 `stage = 'idea'`；用户创建时 `user_touched = 1`，并锁定传入的可锁字段。返回 `id`。
- `update_project`：用户 → 全部写入并锁定这些字段；字段里有 `priority` 时 `user_touched = 1`。AI → 未锁定的字段直接写入；锁定的字段合起来作为一个确认题（`dedupe_key = update:projects:<id>:<排序后的字段用逗号连接>`，守卫 = 每个锁定字段等于当前值，提示语见下）。
- `transition_stage`：先 `checkTransition`；`merge_into` 必须是存在、未删除、不是自身、不处于 `merged` 的项目，否则 `invalid`。AI 且 `aiMayTransition` → 执行；AI 其余情况 → 确认题（`dedupe_key = stage:<id>:<to>`，守卫 = `stage` 等于当前值）。执行时：转入 `parked` 记下 `stage_before_park = from`；从 `parked` 转出清空它；转入 `merged` 设 `merged_into`；从 `merged` 转出清空 `merged_into`；用户执行时 `user_touched = 1`。
- `unlock_field`：`field` 不在 `LOCKABLE[table]` → `invalid`；本来就没锁 → 没有改动。目标是 todo / 里程碑时，用它的 `project_id` 设 `ctx.projectId`。

确认题提示语（固定文案，`${reason}` 是 AI 给的理由）：
- 锁定字段：`AI 想修改你锁定的字段（${字段用、连接}）：${reason}`
- 阶段：`AI 建议把「${title}」从${STAGE_LABEL[from]}转到${STAGE_LABEL[to]}：${reason}`；合并时 `转到${...}` 换成 `合并到「${目标 title}」`

- [ ] **Step 1: 写失败的测试**

```ts
// stage.test.ts
test('ai may only step forward along idea→explore→build→verify', () => {
  expect(aiMayTransition('idea', 'explore')).toBe(true);
  expect(aiMayTransition('idea', 'build')).toBe(false);
  expect(aiMayTransition('verify', 'done')).toBe(false);
  expect(aiMayTransition('build', 'explore')).toBe(false);
  expect(aiMayTransition('explore', 'parked')).toBe(false);
});
test('merged requires merge_into and merge_into requires merged', () => {});
// projects-ops.test.ts
test('every applied op writes exactly one event in the same transaction', () => {
  const r = t.user('create_project', { title: 'dLLM 评测' });
  expect(r).toMatchObject({ status: 'applied', id: 'p_1' });
  expect(eventsFor('p_1')).toHaveLength(1);
});
test('ai write without reason or evidence is rejected and writes nothing', () => {
  expect(t.ai('create_project', { title: 'x' }, { reason: '' })).toMatchObject({ status: 'rejected', code: 'missing_reason' });
  expect(t.ai('create_project', { title: 'x' }, { evidence: ['see chat'] })).toMatchObject({ code: 'missing_evidence' });
  expect(count('projects')).toBe(0);
});
test('ai can only create projects in idea', () => {
  expect(t.ai('create_project', { title: 'x', stage: 'build' })).toMatchObject({ code: 'not_allowed' });
});
test('user edit locks the field; ai update of a locked field becomes a confirm question, unlocked fields still apply', () => {
  t.user('update_project', { project: p, fields: { title: '用户标题' } });
  const r = t.ai('update_project', { project: p, fields: { title: 'AI 标题', summary: '新摘要' } });
  expect(r).toMatchObject({ status: 'applied', question_ids: [expect.any(String)] });
  expect(project(p)).toMatchObject({ title: '用户标题', summary: '新摘要' });
  expect(question(r.question_ids[0]).prompt).toBe('AI 想修改你锁定的字段（title）：r');
});
test('ai stepping forward applies; ai completing, abandoning, parking or going back is proposed', () => {
  expect(t.ai('transition_stage', { project: p, stage: 'explore' })).toMatchObject({ status: 'applied' });
  for (const stage of ['done', 'abandoned', 'parked', 'idea']) {
    expect(t.ai('transition_stage', { project: p, stage })).toMatchObject({ status: 'proposed' });
  }
  expect(project(p).stage).toBe('explore');
});
test('parking remembers the previous stage and unparking clears it', () => {});
test('merge sets merged_into; ai writes to a merged project are rejected with the target', () => {
  t.user('transition_stage', { project: a, stage: 'merged', merge_into: b });
  expect(t.ai('update_project', { project: a, fields: { summary: 'x' } })).toMatchObject({ code: 'merged', message: expect.stringContaining(b) });
});
test('merge into self, a deleted project or a merged project is invalid', () => {});
test('ai may not unlock fields', () => {
  expect(t.ai('unlock_field', { table: 'projects', id: p, field: 'title' })).toMatchObject({ code: 'user_only' });
});
test('user setting priority or stage marks the project user_touched', () => {});
test('occurred_at defaults to now and can be supplied; recorded_at is always now', () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行** `npx vitest run && npx tsc` → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(domain): execute pipeline, stage machine, project operations"`

---

### Task 5: 里程碑、todo、决策、阻塞

**Files:**
- Create: `src/domain/items-ops.ts`（在 `HANDLERS` 里注册）
- Test: `tests/domain/items-ops.test.ts`

**Interfaces:**
- Consumes: `loadProject`、`HANDLERS`、`OpContext`、`ChangeSet`、`addLocks`、`readLocks`
- Produces: handler `upsert_milestone`、`delete_milestone`、`upsert_todo`、`delete_todo`、`record_decision`、`delete_decision`、`set_blocker`、`clear_blocker`、`delete_blocker`；导出 `loadItem(ctx, table, projectId, id): Row`（不存在或不属于该项目 → `not_found`；已删除 → AI 得到 `vetoed`（若 `vetoed = 1`）或 `not_found`，用户得到 `not_found`）

规则：
- 所有操作先 `loadProject`。
- **新建**（没有 `id`）：`title` / `text` 必填，否则 `invalid`。里程碑 `status` 默认 `todo`，`position` 默认"该项目现有最大值 + 1"（没有则 0）。todo `status` 默认 `todo`。阻塞 `kind` 默认 `technical`、`status = 'open'`。决策的 `decided_at` 默认 `ctx.occurredAt`，`evidence` 列存 `ctx.evidence`。`created_by` = actor。用户新建的 todo / 里程碑锁定传入的可锁字段。返回 `id`。
- **修改**（有 `id`）：`loadItem`。用户 → 写入并锁定这些字段。AI → 未锁定的字段写入，锁定的字段转成确认题（`dedupe_key = update:<table>:<id>:<字段>`，守卫同 Task 4，提示语同 Task 4 的锁定字段文案）。
- todo 的 `milestone_id` 必须是**同一项目**里未删除的里程碑，否则 `invalid`。
- **删除**：用户 → `deleted_at = now`、`vetoed = 1`、`ctx.isVeto = true`。AI → 如果条目 `created_by = 'user'` 或 `locks` 非空，转成确认题（`dedupe_key = delete:<table>:<id>`，守卫 `deleted_at` 等于 `null`，提示语 `AI 想删除你编辑过的${里程碑|todo|决策|阻塞}「${title 或 text}」：${reason}`）；否则 `deleted_at = now`、`vetoed = 0`。
- 删除里程碑时，挂在它下面的 todo 的 `milestone_id` 设为 `null`（同一个 ChangeSet）。
- `clear_blocker`：`status = 'cleared'`、`cleared_at = now`；已经清除 → 没有改动。

- [ ] **Step 1: 写失败的测试**

```ts
test('creating a milestone appends it after the existing ones', () => {});
test('todo cannot point at a milestone of another project', () => {
  expect(t.user('upsert_todo', { project: a, title: 'x', milestone_id: milestoneOfB })).toMatchObject({ code: 'invalid' });
});
test('item id that belongs to another project is not_found', () => {
  expect(t.user('upsert_todo', { project: a, id: todoOfB, title: 'x' })).toMatchObject({ code: 'not_found' });
});
test('user delete leaves a vetoed tombstone; ai cannot touch it again', () => {
  t.user('delete_todo', { project: p, id: todo });
  expect(row('todos', todo)).toMatchObject({ vetoed: 1, deleted_at: expect.any(String) });
  expect(lastEvent().is_veto).toBe(1);
  expect(t.ai('upsert_todo', { project: p, id: todo, status: 'done' })).toMatchObject({ code: 'vetoed' });
});
test('ai deleting a user-created or user-edited item is proposed, an ai-created one is deleted without veto', () => {});
test('ai editing a locked todo field is proposed; unlocked fields apply', () => {});
test('deleting a milestone detaches its todos in the same event', () => {});
test('decision defaults decided_at to occurred_at and stores the evidence', () => {
  t.ai('record_decision', { project: p, text: '用 SQLite' }, { evidence: ['chunk:7#L3'] });
  expect(lastRow('decisions')).toMatchObject({ evidence: '["chunk:7#L3"]' });
});
test('clearing an already cleared blocker changes nothing and writes no event', () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行** `npx vitest run && npx tsc` → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(domain): milestones, todos, decisions, blockers"`

---

### Task 6: Session 关联、不追踪、pending 合并时迁移

**Files:**
- Create: `src/domain/links-ops.ts`（注册 handler）
- Modify: `src/domain/ops.ts`（`create_project` 加 `from_session?: Id`）、`src/domain/projects-ops.ts`（`create_project` 处理 `from_session`）、`src/server/sessions-repo.ts`（`applySnapshot` 第 5 步）
- Test: `tests/domain/links-ops.test.ts`, `tests/server/sessions-repo.test.ts`

**Interfaces:**
- Consumes: `loadProject`、`HANDLERS`、`sessions` 表
- Produces: handler `link_session`、`unlink_session`、`ignore_session`；`resolveSessionKey(db, key): string | null`（沿 `merged_into` 最多 5 跳得到最终键；session 不存在返回 `null`）；`linkSession(ctx, args)`（供 `create_project` 复用）

规则：
- `link_session`：session 不存在 → `not_found`；用解析后的最终键。里程碑必须属于该项目。按 (最终键, 项目) 找 `contributions` 行：
  - 没有 → 新建（`actor` = 操作者，`confidence`、`summary`、`ts_start`、`ts_end` 照传入）
  - 有且未删除 → 更新 `milestone_id`、`summary`、`confidence`（传了才改），`ts_start = min`、`ts_end = max`
  - 是**否决墓碑**（`vetoed = 1`）→ 用户：复活（`deleted_at = null`、`vetoed = 0`）并更新；AI：确认题（`dedupe_key = link:<键>:<项目>`，守卫 `deleted_at` 等于当前值，提示语 `AI 想把 session ${键} 重新关联到「${title}」（你之前取消过）：${reason}`）
  - 是非否决墓碑（AI 自己取消的）→ 任何人都可以复活
- `unlink_session`：没有未删除的行 → `not_found`。用户 → 墓碑 `vetoed = 1`、`ctx.isVeto = true`。AI → 行的 `actor = 'user'` 时转确认题（`dedupe_key = unlink:<键>:<项目>`，守卫 `deleted_at` 等于 `null`，提示语 `AI 想取消你建立的关联：session ${键} ↔「${title}」：${reason}`）；否则墓碑 `vetoed = 0`。
- `ignore_session`：session 不存在 → `not_found`。用户 → 设置 `sessions.ignored`（1 或 0）。AI → 确认题（`dedupe_key = ignore:<键>`，守卫 `ignored` 等于当前值，提示语 `AI 建议不再追踪 session ${键}：${reason}`）。`ctx.projectId` 为 `null`。
- `create_project` 带 `from_session`：建完项目后用同一个 actor 调 `linkSession`（同一个事件）。
- `applySnapshot` 第 5 步合并 pending 时，在移动 chunk 之后：`UPDATE OR IGNORE contributions SET session_key = <真实键> WHERE session_key = <pending 键>`，再删除仍留在 pending 键下的 contributions（两边都关联了同一项目时保留真实键那行）；`UPDATE questions SET session_key = <真实键> WHERE session_key = <pending 键>`。

- [ ] **Step 1: 写失败的测试**

```ts
test('linking twice widens the time range and keeps one row', () => {
  t.ai('link_session', { session: s, project: p, ts_start: '2026-10-29T10:00:00Z', ts_end: '2026-10-29T11:00:00Z' });
  t.ai('link_session', { session: s, project: p, ts_start: '2026-10-29T09:00:00Z', ts_end: '2026-10-29T10:30:00Z' });
  expect(rows('contributions')).toEqual([expect.objectContaining({ ts_start: '2026-10-29T09:00:00Z', ts_end: '2026-10-29T11:00:00Z' })]);
});
test('after the user unlinks, an ai relink becomes a confirm question instead of a link', () => {
  t.user('link_session', { session: s, project: p });
  t.user('unlink_session', { session: s, project: p });
  expect(t.ai('link_session', { session: s, project: p })).toMatchObject({ status: 'proposed' });
  expect(row('contributions', c)).toMatchObject({ vetoed: 1 });
});
test('the user can relink a vetoed pair directly', () => {});
test('linking a merged pending key links its native session', () => {});
test('ai ignore_session is proposed; user ignore_session sets the flag', () => {});
test('create_project with from_session links it in the same event', () => {});
// sessions-repo.test.ts
test('pending merge moves contributions and questions to the native key', () => {
  // pending:m:t1 关联到 p_1、有一个待归属问题 → 下一份快照里出现同终端的 codex:abc
  // 断言：contributions.session_key = 'codex:abc'，questions.session_key = 'codex:abc'
});
```

- [ ] **Step 2: 运行，确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行** `npx vitest run && npx tsc` → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(domain): session links, ignore, pending-merge migration"`

---

### Task 7: 撤销与否决

**Files:**
- Create: `src/domain/revert.ts`（注册 `revert_event`）
- Test: `tests/domain/revert.test.ts`

**Interfaces:**
- Consumes: `events` 表的 `before` / `after`、`ChangeSet`、`addLocks`、`LOCKABLE`
- Produces: handler `revert_event`（只有用户能调，Task 4 的入口已拦住 AI）

规则：
- event 不存在 → `not_found`；它本身是 `revert_event` → `not_revertible`；`reverted_by` 已有值 → `already_reverted`。
- 对 event 里的每个 Change：
  - **冲突检查**：当前行在 `after` 的每一列（`locks` 除外）上必须等于 `after` 的值，否则 `conflict`，message 写明 `${table}:${id}.${col}`。全部检查通过才开始写。
  - `before` 为 `null`（这一行是这次操作建的）→ `deleted_at = now`；原操作者是 AI 时 `vetoed = 1`。
  - 否则把 `before` 里的各列写回。
- **原操作者是 AI** 时：`ctx.isVeto = true`；`projects` / `todos` / `milestones` 中被写回的可锁字段加锁；写回后处于删除状态（`deleted_at` 非空）的行设 `vetoed = 1`。
- 原操作者是用户时：不加锁，也不算否决。
- 新事件 `op = 'revert_event'`、`reverts` = 原 event id、`project_id` = 原 event 的 `project_id`；原 event 的 `reverted_by` 设为新 event id（同一事务）。

- [ ] **Step 1: 写失败的测试**

```ts
test('reverting an ai field change restores the old value, locks the field and counts as a veto', () => {
  const p = t.ai('create_project', { title: 'x', summary: '原来的' }).id; // AI 建的，字段没锁，AI 的修改才会直接生效
  const e = t.ai('update_project', { project: p, fields: { summary: 'AI 写的' } }).event_id;
  t.user('revert_event', { event_id: e });
  expect(project(p)).toMatchObject({ summary: '原来的' });
  expect(JSON.parse(project(p).locks)).toContain('summary');
  expect(lastEvent()).toMatchObject({ op: 'revert_event', reverts: e, is_veto: 1 });
  expect(t.ai('update_project', { project: p, fields: { summary: '又改' } })).toMatchObject({ status: 'proposed' });
});
test('reverting an ai link leaves a vetoed tombstone, so the ai cannot relink directly', () => {});
test('reverting an ai-created todo tombstones it with veto', () => {});
test('reverting a user delete restores the item and clears the veto', () => {});
test('reverting a stage transition restores stage, stage_before_park and merged_into', () => {});
test('revert after a later change to the same column is a conflict naming the column', () => {
  const e = t.ai('update_project', { project: p, fields: { summary: 'A' } }).event_id;
  t.user('update_project', { project: p, fields: { summary: 'B' } });
  expect(t.user('revert_event', { event_id: e })).toMatchObject({ code: 'conflict', message: expect.stringContaining(`projects:${p}.summary`) });
  expect(project(p).summary).toBe('B');
});
test('a later change to another column does not block the revert', () => {});
test('reverting twice, or reverting a revert, is rejected', () => {});
test('reverting ignore_session restores the flag', () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行** `npx vitest run && npx tsc` → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(domain): revert with conflict detection and veto"`

---

### Task 8: 回答和忽略问题

**Files:**
- Create: `src/domain/answers.ts`
- Test: `tests/domain/answers.test.ts`

**Interfaces:**
- Consumes: `runOp`、`transaction`、`guardsHold`、`expireQuestions`
- Produces:
  - `answerQuestion(db, deps, id: string, answer: { option_index: number } | { text: string }): OpResult`
  - `dismissQuestion(db, deps, id: string): OpResult`

规则（`answerQuestion`）：
1. 先 `expireQuestions`。问题不存在 → `not_found`；不是 `pending` → `not_pending`。
2. 守卫不成立 → 把问题改为 `withdrawn`（`resolution_note = 'stale'`），返回 `stale`。
3. `choice` / `confirm` 需要 `option_index` 且在范围内；`text` 需要非空 `text`，填进 `args[text_arg]`。不符合 → `invalid`。
4. 选中的 option `op` 为 `null`（例如"拒绝"）→ 问题 `answered`、`rejected = 1`，返回 `applied` 且 `event_id: null`。
5. 否则在一个事务里以 `actor: 'user'`、`question_id: id` 调 `runOp`，然后把问题改为 `answered`（`answer` 存 JSON、`resolved_at`）。`runOp` 抛 `OpRejected` 时回滚，再在一个新事务里把问题改为 `withdrawn`（`resolution_note` = 拒绝码），返回该拒绝。

`dismissQuestion`：`pending` → `withdrawn`、`rejected = 1`、`resolution_note = 'dismissed'`；否则 `not_pending`。

- [ ] **Step 1: 写失败的测试**

```ts
test('confirming an ai proposal executes it as the user and links the event to the question', () => {
  const q = t.ai('transition_stage', { project: p, stage: 'done' }).question_ids[0];
  expect(answerQuestion(t.db, t.deps, q, { option_index: 0 })).toMatchObject({ status: 'applied' });
  expect(project(p).stage).toBe('done');
  expect(lastEvent()).toMatchObject({ actor: 'user', question_id: q });
});
test('choosing 拒绝 records a rejection that starts the cooldown', () => {
  answerQuestion(t.db, t.deps, q, { option_index: 1 });
  expect(t.ai('transition_stage', { project: p, stage: 'done' })).toMatchObject({ code: 'recently_rejected' });
});
test('a user edit while a proposal is pending withdraws it; answering it later returns not_pending and keeps the user value', () => {
  t.user('update_project', { project: p, fields: { title: '用户标题' } });
  const q = t.ai('update_project', { project: p, fields: { title: 'AI 标题' } }).question_ids[0];
  t.user('update_project', { project: p, fields: { title: '用户又改了' } });
  expect(question(q)).toMatchObject({ status: 'withdrawn', resolution_note: 'stale' });
  expect(answerQuestion(t.db, t.deps, q, { option_index: 0 })).toMatchObject({ code: 'not_pending' });
  expect(project(p).title).toBe('用户又改了');
});
test('a text question passes the typed text into its op', () => {
  // askUser kind:'text' option { op:'update_project', args:{ project:p, fields:{} }, text_arg:'fields.done_criteria' }
});
test('when the bound op is rejected the question is withdrawn with that code', () => {});
test('dismiss withdraws with rejected=1', () => {});
```

填空题用 Task 3 的 `setArgPath` 把用户输入写到 `text_arg` 指向的位置。

- [ ] **Step 2: 运行，确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行** `npx vitest run && npx tsc` → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(domain): answer and dismiss questions"`

---

### Task 9: 读模型（首页卡片、项目详情、问题列表）

**Files:**
- Create: `src/domain/read.ts`
- Test: `tests/domain/read.test.ts`

**Interfaces:**
- Consumes: `listSessions`（`sessions-repo.ts`，用于 `short_id` 和 `effective_status`）、领域表
- Produces:
  - 常量 `DORMANT_AFTER_DAYS = 7`、`EVENTS_IN_DETAIL = 200`
  - `type SessionTag = { key: string; short_id: string; machine: string; agent_kind: string; effective_status: string; title: string; milestone_id: string | null }`
  - `type QuestionView = { id; kind; prompt; options: Array<{ label: string; has_op: boolean; text_arg?: string }>; project_id: string | null; session_key: string | null; status; evidence: string[]; created_by: string; created_at: string; resolution_note: string | null }`
  - `type ProjectCard = { id; title; stage; priority; summary; why; done_criteria; merged_into; locks: string[]; created_by; created_at; inbox: boolean; closed: boolean; last_activity_at: string; dormant_days: number | null; milestones_progress: { done: number; doing: number; todo: number }; current_milestone: { id; title; status } | null; open_todos: TodoRow[]; open_blockers: BlockerRow[]; active_sessions: SessionTag[]; pending_questions: QuestionView[] }`
  - `type EventView = { id; occurred_at; recorded_at; actor; op; entity; args: unknown; before: unknown; after: unknown; reason: string | null; evidence: string[]; question_id: string | null; reverts: number | null; reverted_by: number | null; is_veto: boolean }`
  - `type ProjectDetail = ProjectCard & { milestones: MilestoneRow[]; todos: TodoRow[]; decisions: DecisionRow[]; blockers: BlockerRow[]; contributions: Array<ContributionRow & { session: SessionTag | null }>; events: EventView[]; tombstones: Array<{ table: string; id: string; label: string; deleted_at: string }> }`（行类型里 `locks`、`evidence` 已解析成数组）
  - `listProjects(db, now: Date, filter: { stage?: Stage; priority?: Priority }): ProjectCard[]`
  - `getProject(db, now: Date, id: string): ProjectDetail | null`
  - `listQuestions(db, deps, filter: { status?: 'pending' | 'answered' | 'withdrawn' | 'expired'; project_id?: string }): QuestionView[]`（先 `expireQuestions`；按 `created_at` 新的在前）

规则：
- 已删除的项目、条目、关联不出现（`tombstones` 除外：列出该项目 `vetoed = 1` 的条目和关联，供计划 3 的整理员避免重提）。
- `inbox` = `created_by` 是 AI 且 `stage = 'idea'` 且 `user_touched = 0`（spec 7 节"新 idea"折叠区）。
- `closed` = 阶段属于 `CLOSED`。
- `active_sessions`：未删除关联里，session 未被忽略且 `effective_status` 不是 `ended` / `purged` 的（`offline` 保留，显示状态由前端决定）。
- `last_activity_at` = `max(created_at, 未删除关联的 ts_end)`；`dormant_days` = 没有活跃 session 且距 `last_activity_at` 满 `DORMANT_AFTER_DAYS` 天时取整天数，否则 `null`。
- `current_milestone`：按 `position` 第一个 `doing`，没有则第一个 `todo`。
- `open_todos`：`status ≠ done`，`doing` 在前，再按优先级（P0 在前，`null` 最后）、`created_at`。
- 排序：`closed` 的在最后；然后优先级 P0→P3→`null`；然后 `last_activity_at` 新的在前。
- 项目详情的 `events`：`project_id` 等于该项目的事件，新的在前，最多 `EVENTS_IN_DETAIL` 条。
- `QuestionView.options` 不暴露绑定的 `op` / `args`（前端只渲染、回传序号，spec 第 8 节）。

- [ ] **Step 1: 写失败的测试**

```ts
test('cards sort by priority with closed projects last', () => {});
test('an ai-created idea stays in the inbox until the user sets priority or moves the stage', () => {
  const p = t.ai('create_project', { title: '新想法' }).id;
  expect(card(p).inbox).toBe(true);
  t.user('update_project', { project: p, fields: { priority: 'P1' } });
  expect(card(p).inbox).toBe(false);
});
test('active_sessions shows live and offline linked sessions with short ids, not ended or ignored ones', () => {});
test('dormant_days appears after 7 days without activity and no active session', () => {});
test('detail lists events newest first, tombstones, and contributions with their session', () => {});
test('question views hide the bound ops', () => {
  expect(listQuestions(t.db, t.deps, {})[0].options[0]).toEqual({ label: '确认', has_op: true });
});
test('deleted projects are absent from the list and getProject returns null', () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL
- [ ] **Step 3: 实现**（数据量是几十个项目，读模型可以逐个项目查询，不用为性能写复杂 SQL）
- [ ] **Step 4: 运行** `npx vitest run && npx tsc` → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(domain): read models for home, project detail, questions"`

---

### Task 10: HTTP 路由、用户 token、文档

**Files:**
- Create: `src/server/domain-routes.ts`
- Modify: `src/server/http.ts`（调用 `mountDomainRoutes`；`app.onError` 返回 JSON 500 `{ error: 'internal' }` 并把错误写到 stderr）、`src/server/config.ts`（`userToken`）、`config/server.example.json`、`README.md`
- Test: `tests/server/domain-routes.test.ts`, `tests/server/config.test.ts`

**Interfaces:**
- Consumes: `execute`、`answerQuestion`、`dismissQuestion`、`listProjects`、`getProject`、`listQuestions`、`defaultDeps`
- Produces:
  - `createApp(db, config, clock?, newId?)`：新增可选第 4 个参数 `newId`，与 `clock` 组成 `DomainDeps`（已有测试的三参数调用不变）
  - `mountDomainRoutes(app: Hono, db, config: ServerConfig, deps: DomainDeps): void`
  - `ServerConfig.userToken: string`：至少 16 个字符、不含空白、不能等于任何采集器 token（否则 `loadServerConfig` 报错并指出原因）

**路由**（除 GET 外都要求 `Authorization: Bearer <userToken>`，用常量时间比较；采集器 token 在这里无效，用户 token 在 `/ingest/*` 也无效；请求体上限 64 KB，用 Hono 的 `bodyLimit`）：

| 方法 路径 | 请求体 | 操作 / 函数 |
|---|---|---|
| `GET /projects?stage=&priority=` | | `listProjects`（非法枚举值 → 400） |
| `GET /projects/:id` | | `getProject`（`null` → 404） |
| `POST /projects` | `{ title, summary?, why?, done_criteria?, priority?, stage? }` | `create_project` |
| `PATCH /projects/:id` | `{ title?, summary?, why?, done_criteria?, priority? }` | `update_project` |
| `POST /projects/:id/stage` | `{ stage, merge_into? }` | `transition_stage` |
| `DELETE /projects/:id/locks/:field` | | `unlock_field { table: 'projects' }` |
| `POST /projects/:id/milestones` | `{ title, status?, position? }` | `upsert_milestone` |
| `PATCH /projects/:id/milestones/:mid` | `{ title?, status?, position? }` | `upsert_milestone { id: mid }` |
| `DELETE /projects/:id/milestones/:mid` | | `delete_milestone` |
| `DELETE /projects/:id/milestones/:mid/locks/:field` | | `unlock_field { table: 'milestones' }`（先确认属于该项目，否则 404） |
| `POST /projects/:id/todos`、`PATCH …/todos/:tid`、`DELETE …/todos/:tid`、`DELETE …/todos/:tid/locks/:field` | 同里程碑，字段为 `title, status, priority, milestone_id` | `upsert_todo` / `delete_todo` / `unlock_field` |
| `POST /projects/:id/decisions` | `{ text, decided_at? }` | `record_decision` |
| `DELETE /projects/:id/decisions/:did` | | `delete_decision` |
| `POST /projects/:id/blockers` | `{ text, kind? }` | `set_blocker` |
| `PATCH /projects/:id/blockers/:bid` | `{ text?, kind?, status?: 'cleared' }` | `set_blocker`，带 `status: 'cleared'` 时再 `clear_blocker`（两个操作在同一请求里先后执行，各自一个事件） |
| `DELETE /projects/:id/blockers/:bid` | | `delete_blocker` |
| `POST /sessions/:key/links` | `{ project_id, milestone_id? }` | `link_session` |
| `DELETE /sessions/:key/links/:project_id` | | `unlink_session` |
| `PUT /sessions/:key/ignored` | `{ ignored: boolean }` | `ignore_session` |
| `POST /events/:id/revert` | | `revert_event`（`:id` 不是正整数 → 400） |
| `GET /questions?status=&project_id=` | | `listQuestions` |
| `POST /questions/:id/answer` | `{ option_index }` 或 `{ text }` | `answerQuestion` |
| `POST /questions/:id/dismiss` | | `dismissQuestion` |

- session 键含冒号，路径里用 `encodeURIComponent`；Hono 的 `c.req.param` 会解码。
- 请求体的 JSON 解析失败或字段不合格 → 400 `{ error: 'invalid', message }`，路由层只检查形状，业务规则全部交给操作层。
- 结果映射：`applied` → 200（`POST /projects` 及其他新建 → 201），响应体就是 `OpResult`；`proposed` 只会出现在 AI 调用里，用户路由不会遇到；`rejected` → `invalid` 400、`not_found` 404、`user_only` 403、其余 409，响应体 `{ error: code, message }`。
- 所有操作的 `actor` 都是 `'user'`。

- [ ] **Step 1: 写失败的测试**

```ts
test('mutations require the user token; collector tokens are refused', async () => {
  expect((await req('POST', '/projects', { title: 'x' })).status).toBe(401);
  expect((await req('POST', '/projects', { title: 'x' }, collectorToken)).status).toBe(401);
  expect((await req('POST', '/projects', { title: 'x' }, userToken)).status).toBe(201);
});
test('the user token cannot push ingest data', async () => {});
test('GET /projects is open and returns cards', async () => {});
test('PATCH then GET shows the field locked; DELETE lock unlocks it', async () => {});
test('session keys with colons work in paths', async () => {
  const r = await req('POST', `/sessions/${encodeURIComponent('claude:5d27595b')}/links`, { project_id: p }, userToken);
  expect(r.status).toBe(200);
});
test('a todo id from another project returns 404', async () => {});
test('answering a question executes its op; answering again is 409', async () => {});
test('revert conflict maps to 409 with the column in the message', async () => {});
test('malformed JSON is 400 and an oversized body is 413', async () => {});
test('an unexpected exception returns JSON 500', async () => {});
// config.test.ts
test('userToken must be ≥16 chars, without whitespace, and differ from every collector token', () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL
- [ ] **Step 3: 实现** 路由、配置、示例配置（`"userToken": "REPLACE-WITH-RANDOM-USER-TOKEN-AT-LEAST-16"`）
- [ ] **Step 4: 运行** `npx vitest run && npx tsc` → PASS
- [ ] **Step 5: README 加一节「项目 API（计划 2）」**：用 `openssl rand -hex 24` 生成 `userToken`；三四条 curl 示例（建项目、改字段、回答问题、撤销事件）；说明 GET 开放、写操作要 token，AI 的写入口在计划 3 的 MCP。
- [ ] **Step 6: 冒烟（手动，笔记本）**

```bash
node src/cli.ts server --config config/server.local.json &   # 配置里加上 userToken
T=<userToken>; S=http://localhost:7718
curl -s -XPOST $S/projects -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"title":"冒烟项目"}'
curl -s $S/projects | head -c 400
```
Expected：第一条返回 `{"status":"applied","event_id":1,"id":"p_…",…}`；第二条的列表里有"冒烟项目"，`stage` 为 `idea`，`inbox` 为 `false`（用户建的）。

- [ ] **Step 7: Commit** `git commit -m "feat(server): project API routes, user token, JSON errors"`

---

## 完成标志

1. `npx vitest run` 全部通过，`npx tsc` 无输出。
2. 在笔记本上起中心服务，用 curl 走一遍：建项目 → 加里程碑和 todo → 改字段（之后 GET 显示已锁定）→ 删除 todo（详情里出现在 `tombstones`）→ 撤销那次删除（todo 回来）。
3. 已在跑的采集器不受影响：`herdr-pm sessions` 输出和以前一样；pending session 被认出真实 ID 后，它的关联跟着迁移。
