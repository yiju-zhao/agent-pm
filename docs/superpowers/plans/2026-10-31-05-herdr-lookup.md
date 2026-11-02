# herdr-pm 计划 5：herdr 里按短 ID 打开 session + 侧边栏短 ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在网页上复制短 ID（如 `0d67da1f`），在 herdr 里按 `prefix+g` 弹出输入框粘贴回车，或在任何终端运行 `herdr-pm open 0d67da1f`，就能切到那个 agent（本机）或在旁边分屏 attach 上去（远程）；另外每台机器的采集器把短 ID 和所属项目写到 herdr 侧边栏，扫一眼就能对上号。

**Architecture:** 查找工具是 `herdr-pm` CLI 的新命令 `open`，只依赖本机的 herdr 和 ssh：并行跑 `herdr agent list` 和每台已启用机器的 `herdr --machine <m> agent list`，用 `agent_session.value`（没有时用 `terminal_id`）前缀匹配；匹配不到时可选地问中心 `GET /sessions/by-short-id/:sid` 给出说明。本机的 agent 用 `herdr agent focus`，远程的在当前焦点 pane 右侧分屏执行 `ssh -t <target> … herdr agent attach <pane>`。快捷键用 herdr 自带的 `type = "popup"` 自定义命令（弹出模态终端），不需要写插件。侧边栏：中心在 `/ingest/snapshot` 的响应里带回每个 session 的短 ID 和项目名，采集器用 `herdr pane report-metadata --token pm_sid=… --token pm=…` 写到本机 herdr。

**Tech Stack:** 沿用前四期（Node 26 直接跑 `.ts`、zod 4、vitest 5）；不加新依赖。笔记本上用的是 `scripts/build-collector.sh` 打出来的单文件 `herdr-pm`（bun），它已经包含整个 CLI。

**Spec:** `docs/superpowers/specs/2026-10-29-project-manager-design.md`（第 13、13b 节；环境事实见第 4 节）

**路线图（本计划是第 5 个，也是最后一个）：**
1. 数据采集地基（已合并）
2. 领域操作层 + HTTP API（已合并）
3. 理解层 + MCP（已合并）
4. 网页界面 + `WS /stream`（已合并）
5. **herdr 查找工具和侧边栏短 ID**（本计划）

## Global Constraints

- 沿用前几期：Node 26 直接运行 `.ts`；`erasableSyntaxOnly`、`verbatimModuleSyntax`；本地 import 写 `.ts` 后缀；不用 enum 和参数属性。**不加数据库迁移，不加新依赖。**
- `open` 命令和采集器会被 bun 打进单文件二进制：这两条路径上**不能**静态 import 任何会拉进 `node:sqlite`、hono 或 Agent SDK 的模块（见 `src/cli.ts` 顶部注释）。查找工具只能 import `src/lookup/`、`src/shared/` 和 node 内置模块。
- 查找工具**不依赖中心服务**（spec 13："mac-mini 没开也能用"）：中心只用来在匹配不到时补一句说明，连不上就静默跳过。
- 用户看到的输出全部是中文。退出码：0 成功打开；1 没找到 / 有歧义 / 打开失败；2 用法错误（和现有 CLI 一致）。
- 拼进 shell 命令的值（pane id、ssh target）必须先用白名单正则校验，不合格就拒绝，不做转义拼接：pane id `^[A-Za-z0-9:_-]+$`，ssh target `^[A-Za-z0-9@._-]+$`。
- 远程机器上非交互 ssh 的 `PATH` 里**没有** herdr（2026-10-31 实测：三台机器都装在 `~/.local/bin/herdr`），远程命令必须自己找 herdr：`h=$(command -v herdr || echo "$HOME/.local/bin/herdr"); exec "$h" agent attach <pane>`。
- 侧边栏写入失败绝不能影响采集（不抛异常、不让采集循环退避）。
- **与 spec 的偏差（计划作者的决定）**：
  - spec 说"herdr 插件 + 快捷键"。herdr 0.9.3 的 `[[keys.command]]` 支持 `type = "popup"`（"opens a session-modal terminal"），直接弹出终端运行 `herdr-pm open`，效果相同，不用写和维护插件。
  - 中心兜底只用来**说明**（"这个 session 已结束""那台机器的采集器离线"），不用中心的数据去打开 pane：pending session 用本机 `terminal_id` 前缀匹配已经覆盖。
  - 远程打开默认分屏（spec 的原方案），另提供 `--remote inline`（直接在当前终端 / 弹窗里 attach），这就是 spec 写的退路。哪种在"TUI 正切到远程机器"时表现正确，由 Task 5 的手动检查决定，结论写进 README。
  - spec 第 4 节说"笔记本 ssh mac-mini 超时"，2026-10-31 实测三台机器都能直接 ssh（`BatchMode=yes` 成功），不再是问题。
  - 13b 的"有新的高优先级问题时 `herdr notification show`"不做：问题只在中心，而中心不会到笔记本上执行命令，要做就得在笔记本上再跑一个轮询进程，放到以后。

## Review Focus

1. **某台机器关机或网络不通**：`herdr --machine gx10-c757 agent list` 卡住或报错时，查找仍在约 8 秒内给出结果，其他机器上的 agent 照样能找到，并提示"连不上：gx10-c757（原因）"。（Task 3 测试）
2. **粘贴的内容带空白、换行、大写，或者是完整的 key**（`  0D67DA1F\n`、`claude:0d67da1f-…`）：照样能匹配。（Task 3 测试）
3. **短 ID 匹配到多个**（同一个 session 在两个 pane 里 resume、或者输入太短）：列出候选让用户选，绝不随便打开一个。（Task 3、4 测试）
4. **session 已经结束或采集器离线**：本机 herdr 都找不到时，中心在线就说清楚"这个 session 已结束（gx10-090e · 标题）"，而不是只说"没找到"。（Task 3 测试）
5. **侧边栏写入失败**（herdr 版本旧、pane 刚关、中心是旧版本没返回标签）：采集器照常采集，同一个错误只记一次日志。（Task 2 测试）

---

## 文件结构

```
src/shared/protocol.ts       修改：SnapshotResponse（含 labels，旧中心不返回时默认 []）
src/server/sidebar.ts        新增：sidebarLabels（session key → 短 ID + 项目名）
src/server/http.ts           修改：/ingest/snapshot 返回 { ok, labels }
src/collector/herdr.ts       修改：reportPaneMetadata
src/collector/sidebar.ts     新增：SidebarReporter（只在变化或快过期时写）
src/collector/client.ts      修改：pushSnapshot 返回 labels
src/collector/config.ts      修改：sidebar 开关（默认 true）
src/collector/loop.ts        修改：推完快照后交给 SidebarReporter
src/lookup/agents.ts         新增：解析 agent / machine 列表、并行列出所有 agent、短 ID 匹配
src/lookup/center.ts         新增：centerHint（中心兜底说明）
src/lookup/open.ts           新增：planOpen + 执行（focus / 分屏 / inline）
src/lookup/command.ts        新增：runOpen（参数、交互、输出）
src/cli.ts                   修改：open 命令、USAGE
README.md                    新增一节
```

---

### Task 1: 中心在快照响应里返回侧边栏标签

**Files:**
- Create: `src/server/sidebar.ts`
- Modify: `src/shared/protocol.ts`, `src/server/http.ts`
- Test: `tests/server/sidebar.test.ts`, `tests/server/http.test.ts`

**Interfaces:**
- Consumes: `assignShortIds`（`src/shared/session-key.ts`，短 ID 要和网页显示的一致，所以和 `loadViews` 一样在**所有** session 行上算）；`sessionLinks(db)`（`src/domain/read.ts`，未删除的关联、按项目标题排序）。
- Produces:
  ```ts
  // src/shared/protocol.ts
  export const SidebarLabel = z.object({ key: z.string(), short_id: z.string(), project: z.string().nullable() });
  export type SidebarLabel = z.infer<typeof SidebarLabel>;
  export const SnapshotResponse = z.object({ ok: z.literal(true), labels: z.array(SidebarLabel).default([]) });
  // src/server/sidebar.ts
  export const SIDEBAR_PROJECT_MAX = 16;
  export function sidebarLabels(db: DatabaseSync, keys: string[]): SidebarLabel[];
  ```
  - 每个传入的 key 一项（顺序同输入）。key 在库里被合并过（`merged_into`）时，短 ID 和项目按合并目标算，但返回项的 `key` 仍是传入的那个（采集器按它找 pane）。
  - `project`：没有关联 → `null`；一个 → 项目标题；多个 → `<第一个标题> +<其余个数>`（顺序用 `sessionLinks` 的）。标题超过 `SIDEBAR_PROJECT_MAX` 个字符（按码点）时截成 15 个加 `…`，`+N` 加在截断之后。
  - `/ingest/snapshot` 成功时返回 `{ ok: true, labels: sidebarLabels(db, push.sessions.map(s => s.key)) }`（在 `applySnapshot` 之后算）。

- [ ] **Step 1: 写失败的测试**

`tests/server/sidebar.test.ts`（`openDb(':memory:')`，用 `applySnapshot` 造 session，用 `execute` 建项目和 `link_session`）
- `short id matches the web view`：两个 native id 前 8 位相同的 session → 两者的 `short_id` 都是 9 位，并且等于 `listSessions` 里同一 session 的 `short_id`。
- `project is null without links, the title with one, title +N with several`。
- `long title is cut to 15 chars plus …`：20 个汉字的标题 → `project` 是 15 个汉字加 `…`；再关联一个 → 末尾是 `… +1`。
- `merged pending key reports the target's short id and links under the original key`。
- `unknown key still gets an entry`（`short_id` 按 key 自身算，`project: null`）——采集器刚推上来的 key 一定在库里，但函数本身不能因此抛错。

`tests/server/http.test.ts` 追加：`POST /ingest/snapshot returns labels for the pushed sessions`。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/server/sidebar.test.ts tests/server/http.test.ts`
Expected: FAIL（模块不存在 / 响应里没有 labels）

- [ ] **Step 3: 实现**

`sidebarLabels` 一次读出所有 session 的 key 和 `merged_into`，`assignShortIds` 一次，`sessionLinks` 一次，再逐个 key 组装。

- [ ] **Step 4: 运行全部测试和类型检查**

Run: `npx vitest run && npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts src/server/sidebar.ts src/server/http.ts tests/server/
git commit -m "feat(server): snapshot response carries sidebar labels (short id, project)"
```

---

### Task 2: 采集器把短 ID 和项目写到 herdr 侧边栏

**Files:**
- Create: `src/collector/sidebar.ts`
- Modify: `src/collector/herdr.ts`, `src/collector/client.ts`, `src/collector/config.ts`, `src/collector/loop.ts`
- Test: `tests/collector/sidebar.test.ts`, `tests/collector/herdr.test.ts`, `tests/collector/client.test.ts`, `tests/collector/loop.test.ts`

**Interfaces:**
- Consumes: `SnapshotResponse` / `SidebarLabel`（Task 1）；`SnapshotSession.pane_id`。
- Produces:
  ```ts
  // src/collector/herdr.ts
  export type SidebarTokens = { pm_sid: string; pm: string | null };
  export function reportMetadataArgs(paneId: string, tokens: SidebarTokens, ttlMs: number): string[];
  //   ['pane','report-metadata',paneId,'--source','herdr-pm','--token',`pm_sid=${sid}`, ('--token',`pm=${pm}`) | ('--clear-token','pm'), '--ttl-ms',String(ttlMs)]
  export async function reportPaneMetadata(herdrBin: string, paneId: string, tokens: SidebarTokens, ttlMs: number): Promise<void>; // execFile，失败时 reject（带 stderr）
  // src/collector/sidebar.ts
  export const SIDEBAR_TTL_MS = 600_000;      // herdr 上的 token 10 分钟后自动消失（采集器停了就不会留下过期标签）
  export const SIDEBAR_REFRESH_MS = 300_000;  // 没变化时每 5 分钟续一次
  export class SidebarReporter {
    constructor(report: (paneId: string, tokens: SidebarTokens, ttlMs: number) => Promise<void>, log: (line: string) => void);
    update(sessions: SnapshotSession[], labels: SidebarLabel[], now: Date): Promise<void>; // 从不 reject
  }
  ```
  - `update`：按 `key` 把 label 对到 session 的 `pane_id`；某个 pane 的 tokens 和上次写的不同、或上次写入已过 `SIDEBAR_REFRESH_MS` 时才调用 `report`。没有 label 的 session 跳过。不再出现的 pane 从内部记录里删掉（不主动清除，靠 TTL 过期）。
  - `report` 失败：记一行日志 `herdr-pm collect: sidebar metadata for <pane> failed: <message>`；同一个 pane 连续的**相同**错误只记一次；失败的 pane 下一轮重试。
  - `PmClient.pushSnapshot(p)` 的返回值改为 `Promise<SidebarLabel[]>`：用 `SnapshotResponse` 解析，旧中心只回 `{ok:true}` 时得到 `[]`。
  - `CollectorConfig` 加 `sidebar: z.boolean().default(true)`。
  - 现有测试里把 `pushSnapshot` 换成假函数的地方要改成返回 `[]`（类型变了）。
  - `Deps` 加 `reportMetadata(paneId, tokens, ttlMs): Promise<void>`（`runCollector` 里接 `reportPaneMetadata(cfg.herdrBin, …)`）；`collectOnce` 多一个可选参数 `sidebar?: SidebarReporter`（`runCollector` 在 `cfg.sidebar` 为 true 时建一个，跨 tick 复用），在**第一次** `pushSnapshot` 之后 `await sidebar.update(sessions, labels, now)`。心跳重推不再调用它。

- [ ] **Step 1: 写失败的测试**

`tests/collector/herdr.test.ts` 追加：`reportMetadataArgs` 有项目时含 `--token pm=dLLM评测`，`pm: null` 时含 `--clear-token pm` 而不含 `pm=`，并且有 `--ttl-ms 600000`。

`tests/collector/sidebar.test.ts`（`report` 是 `vi.fn()`，时间手动给）
- `writes each pane once, then only on change`：同样的输入第二次 `update` → `report` 不再调用；项目名变了 → 再调用一次。
- `refreshes after SIDEBAR_REFRESH_MS`：同样输入、时间推进 300000ms → 再调用。
- `a failing report never rejects and logs the same error once`：`report` 一直 reject 同一个错误，连续 3 次 `update` → 每次都重试，`log` 只被调用 1 次；换一个错误信息 → 再记一次。
- `sessions without a label are skipped`。

`tests/collector/client.test.ts` 追加：`pushSnapshot returns labels`；`an old server answering {ok:true} gives []`。

`tests/collector/loop.test.ts` 追加：`collectOnce hands the pushed labels to the sidebar reporter`；`sidebar failures do not fail the tick`（`reportMetadata` reject → `collectOnce` 正常返回，chunks 照常推送）。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/collector`
Expected: 新测试 FAIL

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行全部测试和类型检查**

Run: `npx vitest run && npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/collector/ tests/collector/
git commit -m "feat(collector): write short id and project to the herdr sidebar"
```

---

### Task 3: 查找核心（列出所有机器的 agent、短 ID 匹配、中心兜底说明）

**Files:**
- Create: `src/lookup/agents.ts`, `src/lookup/center.ts`
- Test: `tests/lookup/agents.test.ts`, `tests/lookup/center.test.ts`

**Interfaces:**
- Consumes: 无（只用 node 内置模块和 zod）。真实输出格式（2026-10-31 实测）：
  - `herdr agent list` → `{ id, result: { type, agents: [{ pane_id, agent, agent_session: { kind: 'id', value } | null, agent_status, cwd, terminal_id, terminal_title_stripped, focused, … }] } }`
  - `herdr machine list --json` → `[{ id, label, target, session, enabled, selected }]`
  - `GET /sessions/by-short-id/:sid` → `SessionView[]`（字段见 `src/server/sessions-repo.ts`，只用 `machine`、`agent_kind`、`effective_status`、`title`）。
- Produces:
  ```ts
  // src/lookup/agents.ts
  export type LookupAgent = {
    machine: string | null;        // null = 本机
    target: string | null;         // 远程机器的 ssh target；本机为 null
    pane_id: string; agent_kind: string;
    native_id: string | null; terminal_id: string;
    title: string; cwd: string; status: string;
  };
  export type RunHerdr = (args: string[], timeoutMs: number) => Promise<string>;   // 返回 stdout；失败 reject
  export const MACHINE_TIMEOUT_MS = 8000;
  export function normalizeShortId(input: string): string | null;
  export function parseAgentList(json: unknown, machine: { label: string; target: string } | null): LookupAgent[];
  export function parseMachineList(json: unknown): Array<{ label: string; target: string }>;   // 只要 enabled
  export function listAllAgents(run: RunHerdr): Promise<{ agents: LookupAgent[]; unreachable: Array<{ machine: string; error: string }> }>;
  export function matchShortId(agents: LookupAgent[], sid: string): LookupAgent[];
  // src/lookup/center.ts
  export const CENTER_TIMEOUT_MS = 2000;
  export function centerHint(fetchImpl: typeof fetch, server: string, sid: string): Promise<string | null>;
  ```
  规则：
  - `normalizeShortId`：去掉首尾空白和成对的引号 / 反引号；如果含 `:`，取最后一个 `:` 之后的部分（兼容粘贴 `claude:0d67…` 或 `pending:gx10:term_…`）；转小写；结果必须匹配 `^[a-z0-9_-]{4,64}$`，否则 `null`。
  - `parseAgentList`：`agent_session.kind` 不是 `'id'` 或 `value` 为空时 `native_id = null`；`title` 取 `terminal_title_stripped`，没有就 `terminal_title`；缺 `pane_id` 或 `terminal_id` 的项跳过；结构不对时抛错（信息里带机器名）。
  - `listAllAgents`：先 `run(['machine','list','--json'])` 拿机器（失败就当没有远程机器，并记进 `unreachable`，machine 名写 `机器列表`）；然后本机 `['agent','list']` 和每台机器 `['--machine', label, 'agent','list']` **并行**，每个都用 `MACHINE_TIMEOUT_MS`。某台失败 → 记进 `unreachable`（`error` 取 reject 的 message 第一行），不影响其他机器。本机失败也一样记（machine 写 `本机`）。
  - `matchShortId`：`native_id` 非空时用它前缀匹配，否则用 `terminal_id` 前缀匹配；都转小写比较。同一台机器上 `pane_id` 相同的只留一个。
  - `centerHint`：请求 `<server>/sessions/by-short-id/<sid>`（`AbortSignal.timeout(CENTER_TIMEOUT_MS)`）；连不上、非 2xx、不是数组、空数组 → `null`。否则每个结果一行，按 `effective_status`：`ended` / `purged` → `这个 session 已结束（<machine> · <title>）`；`offline` → `<machine> 的采集器离线，这个 session 可能还在（<title>）`；其他 → `中心记录：<machine> · <agent_kind> · <title>，但本机 herdr 没列出来`。多行用 `\n` 连接。

- [ ] **Step 1: 写失败的测试**

`tests/lookup/agents.test.ts`（`run` 是按参数返回固定 JSON 的假函数）
- `normalizeShortId`：`'  0D67DA1F\n'` → `'0d67da1f'`；`'claude:0d67da1f-aaaa'` → `'0d67da1f-aaaa'`；`'"0d67da1f"'` → `'0d67da1f'`；`'abc'`、`''`、`'0d67 da1f'`、`'$(rm)'` → `null`。
- `parseAgentList`：用上面实测格式的样例，`agent_session: null` 的项 `native_id` 为 `null`；远程机器的 `machine` / `target` 正确填入。
- `parseMachineList` 跳过 `enabled: false`。
- `listAllAgents queries every enabled machine in parallel`：三台机器，各自返回 agent → 合并结果含四个来源；调用参数含 `['--machine','gx10-090e','agent','list']`。
- `an unreachable machine is reported, the others still answer`（Review Focus 1）：`gx10-c757` 的 `run` reject `new Error('ssh: connect to host … timed out\n…')` → `unreachable` 是 `[{ machine: 'gx10-c757', error: 'ssh: connect to host … timed out' }]`，其他机器的 agent 都在。
- `machines are queried with the timeout`：每次 `run` 收到的 `timeoutMs` 都是 `MACHINE_TIMEOUT_MS`。
- `matchShortId`：native id 前缀匹配；`native_id: null` 的用 terminal id 匹配（`term_65e`）；大小写不敏感；两个 pane 都 resume 了同一个 session → 返回两个（Review Focus 3）。

`tests/lookup/center.test.ts`（假 `fetch`）
- `ended session gives 已结束 with machine and title`（Review Focus 4）。
- `offline gives the 采集器离线 line`。
- `unreachable center or empty list gives null`；`fetch` 收到的 `signal` 存在。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/lookup`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现上面两个文件**

- [ ] **Step 4: 运行测试和类型检查**

Run: `npx vitest run && npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/lookup/ tests/lookup/
git commit -m "feat(lookup): list agents on every machine and match a short id"
```

---

### Task 4: `herdr-pm open` 命令（交互、本机 focus、远程分屏 / inline attach）

**Files:**
- Create: `src/lookup/open.ts`, `src/lookup/command.ts`
- Modify: `src/cli.ts`（`open` 分支、USAGE）、`README.md`
- Test: `tests/lookup/open.test.ts`, `tests/lookup/command.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: Task 3 的全部导出。
- Produces:
  ```ts
  // src/lookup/open.ts
  export type RemoteMode = 'split' | 'inline';
  export type OpenPlan =
    | { kind: 'focus'; pane_id: string }                                   // herdr agent focus <pane>
    | { kind: 'split'; target_pane: string; command: string }              // herdr pane split <target> --direction right --focus，再 pane run <新 pane> "<command>; exit"
    | { kind: 'inline'; argv: string[] };                                  // 在当前终端直接运行 ssh（stdio 继承）
  export function remoteAttachArgv(target: string, paneId: string): string[];
  //   ['ssh', '-t', target, `h=$(command -v herdr || echo "$HOME/.local/bin/herdr"); exec "$h" agent attach ${paneId}`]
  export function planOpen(agent: LookupAgent, ctx: { mode: RemoteMode; focusedPane: string | null }): OpenPlan;
  export function findFocusedPane(paneListJson: unknown): string | null;   // `herdr pane list` 里 focused: true 的第一个 pane_id
  export type OpenDeps = {
    run: RunHerdr;
    spawnInteractive(argv: string[]): Promise<number>;   // 继承 stdio，返回退出码
    fetch: typeof fetch;
    prompt(question: string): Promise<string | null>;   // 交互输入；EOF / Ctrl-D → null
    interactive: boolean;                                // stdin 和 stdout 都是 TTY
    env: Record<string, string | undefined>;
  };
  export function executePlan(plan: OpenPlan, deps: OpenDeps): Promise<void>;   // 失败 reject，信息是中文
  // src/lookup/command.ts
  export function defaultOpenDeps(herdrBin: string): OpenDeps;   // execFile / spawn / node:readline/promises
  export function runOpen(args: string[], io: { stdout(t: string): void; stderr(t: string): void }, makeDeps: (herdrBin: string) => OpenDeps): Promise<number>;
  //   先解析参数，再用 --herdr 的值调用 makeDeps
  ```
  规则：
  - `planOpen`：本机 agent → `focus`。远程 agent：`pane_id` 不匹配 `^[A-Za-z0-9:_-]+$` 或 `target` 不匹配 `^[A-Za-z0-9@._-]+$` → 抛错 `pane 或机器地址里有意外字符，拒绝执行`。`mode === 'split'` 且 `focusedPane` 非空 → `split`，`command` 是 `remoteAttachArgv` 的 shell 形式（target 和命令各自用单引号包起来，命令里本身没有单引号）；否则 → `inline`。
  - `executePlan('split')`：`pane split` 的返回里取 `.result.pane.pane_id`，取不到就抛错 `herdr 没有返回新分屏的 pane ID`。
  - 参数：`herdr-pm open [<短ID>] [--remote split|inline] [--server <url>] [--herdr <path>] [--dry-run]`。`--remote` 默认 `split`；`HERDR_ENV !== '1'`（不在 herdr 里）时强制 `inline`。`--server` 默认读 `HERDR_PM_SERVER` 环境变量，再默认 `http://localhost:7718`。`--herdr` 默认 `herdr`（`run` 用它当可执行文件）。`--dry-run` 只打印计划（`将执行：…`），不执行，用于排查和 QA。
  - 流程：取短 ID（参数，或者交互模式下 `prompt('短 ID：')`；非交互又没给参数 → 用法错误）→ `normalizeShortId`（`null` → 输出 `短 ID 格式不对：<原文>`，退出 2）→ 输出 `正在查找 <sid>…` → `listAllAgents` → 有 `unreachable` 时输出 `连不上：<机器>（<原因>）`（每台一行）→ `matchShortId`：
    - 0 个：`centerHint` 非空就输出它，否则 `没有找到短 ID 为 <sid> 的 agent`；退出 1。
    - 1 个：输出 `找到：<机器 或 本机> · <agent_kind> · <状态> · <title>`，然后执行计划；本机 → `已切换到 <pane>`；分屏 → `已在右侧分屏打开（ctrl+b q 退出 attach）`；inline → 直接 attach，退出码用 ssh 的。
    - 多个：每个一行 `[n] <机器> · <agent_kind> · <状态> · <title> · <pane>`；交互模式 `prompt('选择编号（回车取消）：')` 选一个继续；非交互 → 输出 `匹配到多个，请用更长的短 ID`，退出 1。
  - 交互模式下，结束前如果是失败结果（没找到 / 取消 / 出错），先 `prompt('按回车关闭')`，免得弹窗一闪就没。
  - 状态文字：working 运行中、blocked 等你操作、idle 空闲、done 已完成，其他原样。
  - `cli.ts`：`case 'open'` 用 `runOpen(args, io, defaultOpenDeps)`；USAGE 加一行 `herdr-pm open [<短ID>] [--remote split|inline] [--dry-run]   open an agent by short id in herdr`。
  - README 新增一节 `在 herdr 里按短 ID 打开（计划 5）`：
    - 命令行用法和退出码；
    - 快捷键配置（写进 `~/.config/herdr/config.toml`，然后 `herdr server reload-config`）：
      ```toml
      [[keys.command]]
      key = "prefix+g"
      type = "popup"
      command = "/Users/<你>/.local/bin/herdr-pm open"
      width = "80%"
      height = "60%"
      description = "herdr-pm: 按短 ID 打开 agent"
      ```
    - 侧边栏显示：在 `[ui.sidebar.agents]` 里把 `$pm_sid`、`$pm` 加进 `rows`，例如 `rows = [["state_icon", "machine", "workspace", "tab"], ["agent", "$pm_sid", "$pm"]]`；采集器配置 `"sidebar": false` 可以关掉。
    - 远程打开的两种方式（`split` / `inline`）和 Task 5 的手动检查结论（Task 5 填写）。

- [ ] **Step 1: 写失败的测试**

`tests/lookup/open.test.ts`
- `local agent is focused`：`{ kind: 'focus', pane_id: 'w8:p1T' }`。
- `remote agent splits beside the focused pane`：`command` 含 `ssh -t '100.90.216.102'` 和 `agent attach w1:pJ`，以及 `$HOME/.local/bin/herdr`。
- `no focused pane falls back to inline`；`mode inline gives argv`，argv 等于 `remoteAttachArgv` 的结果。
- `unsafe pane id or target is refused`：`pane_id: "w1:p1; rm -rf ~"` → 抛错。
- `findFocusedPane` 取 `focused: true` 的那个；都没有 → `null`。
- `executePlan split runs the attach in the new pane`：假 `run` 先返回 `{result:{pane:{pane_id:'w8:p9'}}}`，断言第二次调用是 `['pane','run','w8:p9', <command> + '; exit']`；返回里没有 pane id → reject `herdr 没有返回新分屏的 pane ID`。

`tests/lookup/command.test.ts`（`makeDeps` 返回假 `OpenDeps`）
- `found locally: focuses and prints 已切换到`，退出 0。
- `ambiguous, non-interactive: lists candidates and exits 1, nothing executed`（Review Focus 3）。
- `ambiguous, interactive: picking 2 opens the second`。
- `not found with a center hint prints the hint`（Review Focus 4），退出 1。
- `unreachable machines are listed`（Review Focus 1）。
- `bad short id exits 2 with 短 ID 格式不对`。
- `outside herdr the remote mode is inline`：`env.HERDR_ENV` 未设、`--remote split` → 调用 `spawnInteractive`，不调用 `pane split`。
- `--dry-run prints the plan and executes nothing`。
- `interactive failure waits for 按回车关闭`。

`tests/cli.test.ts` 追加：`open without a short id outside a terminal is a usage error`（退出 2）；`help lists open`。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/lookup tests/cli.test.ts`
Expected: 新测试 FAIL

- [ ] **Step 3: 实现，写 README 小节**

- [ ] **Step 4: 运行全部测试、类型检查，并确认单文件构建能跑**

Run: `npx vitest run && npm run typecheck && scripts/build-collector.sh bun-darwin-arm64 && ./dist/herdr-pm-bun-darwin-arm64 open --dry-run 0000zzzz; echo "exit=$?"`
Expected: 测试和类型检查 PASS；构建成功；最后一条输出 `正在查找 0000zzzz…`，然后是没找到的提示（或者中心兜底说明），`exit=1`（证明 bun 二进制里 `open` 没拉进 `node:sqlite`）。

- [ ] **Step 5: 用真实 herdr 只读验证（不 focus、不 attach）**

Run: 从 `node src/cli.ts sessions --server http://100.111.225.68:7718` 或 `herdr --machine gx10-090e agent list` 里挑一个远程 agent 的短 ID 和一个本机 agent 的短 ID，分别运行 `node src/cli.ts open --dry-run <sid>`。
Expected: 远程的输出 `找到：gx10-090e · …` 和 `将执行：` 后面的分屏或 ssh 命令；本机的输出 `将执行：herdr agent focus <pane>`。把两条输出贴进实施报告。**不要**去掉 `--dry-run` 运行（会切走用户正在看的 pane）。

- [ ] **Step 6: Commit**

```bash
git add src/lookup/ src/cli.ts README.md tests/
git commit -m "feat(lookup): herdr-pm open — focus local agents, attach remote ones beside you"
```

---

### Task 5: 用户手动检查（需要 herdr TUI，由用户执行）

这一步不能由 subagent 完成：要在真实的 herdr 界面里按快捷键、看弹窗和分屏。controller 在所有任务完成后把下面的清单交给用户，根据用户反馈修 README（必要时改 `--remote` 的默认值，这算一处很小的代码改动，走正常的修复和审查）。

- [ ] 1. 构建并安装笔记本上的二进制（`scripts/build-collector.sh bun-darwin-arm64`，拷到 `~/.local/bin/herdr-pm`），按 README 配好 `prefix+g`，`herdr server reload-config`。
- [ ] 2. 在网页上复制一个**本机** agent 的短 ID，`prefix+g` 粘贴回车 → 切到那个 agent，弹窗关闭。
- [ ] 3. 复制一个**远程**（gx10-090e）agent 的短 ID，`prefix+g` → 当前 pane 右侧出现分屏，里面是那个 agent 的界面，能打字；`ctrl+b q` 退出后分屏关闭。
- [ ] 4. 在 herdr 里切到远程机器（TUI 显示 gx10-090e）后重复第 3 步：分屏出现在哪里？如果看不到或位置不对，改用 `command = "… herdr-pm open --remote inline"` 再试（弹窗里直接 attach）。把结论告诉 controller，写进 README，必要时改默认值。
- [ ] 5. 输入一个乱写的短 ID → 弹窗里显示没找到，按回车才关闭。
- [ ] 6. 采集器升级到新二进制、配置 `[ui.sidebar.agents] rows` 后，侧边栏每个 agent 旁边显示短 ID 和项目名（远程机器的 agent 需要那台机器的采集器也升级）。

---

## 计划之外、留给以后

- `herdr notification show` 提醒新的高优先级问题（见上面的偏差说明）。
- 网页上的短 ID 旁边加"在 herdr 里打开"的说明文字或快捷键提示。
- 前几期留在台账里、没有处理的领域层问题（合并项目会丢掉否决和关联、用户改过的阻塞没有锁、AI 推进自己建的 idea 后它离开折叠区等）。
