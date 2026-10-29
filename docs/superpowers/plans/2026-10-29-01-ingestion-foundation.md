# herdr-pm 计划 1：数据采集地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每台机器上的采集器把 herdr 里的 session 状态和对话增量推送到 mac-mini 上的中心服务，中心用 SQLite 存下来，并能按机器、状态、短 ID 查询。

**Architecture:** 一个 TypeScript 代码库，两个入口：`herdr-pm server`（中心，Hono + `node:sqlite`）和 `herdr-pm collect`（采集器，读本机 `herdr api snapshot` 和 JSONL 对话文件，HTTP 推送）。两端共用 `src/shared/` 里的 zod 协议定义。这一期不调用 LLM。

**Tech Stack:** Node 26（原生运行 .ts，type stripping）、TypeScript、`node:sqlite`、Hono + `@hono/node-server`、zod、vitest；采集器可用 `bun build --compile` 打成单文件。

**Spec:** `docs/superpowers/specs/2026-10-29-project-manager-design.md`（第 4、5.1、5.1b、5.1c、6、12 节）

**路线图（本计划是第 1 个）：**
1. **数据采集地基**（本计划）：采集器 → 中心 → SQLite，session 身份、生命周期、对话增量
2. 领域操作层：项目、里程碑、todo、决策、阻塞、贡献记录、问题、events、字段锁、否决、状态机，加上对应的 HTTP API
3. 理解层：摘要员、整理员（Claude Agent SDK + OAuth token），以及 MCP 服务
4. 网页界面
5. herdr 查找工具（`herdr-pm open <短ID>` + 插件）和侧边栏 token

## Global Constraints

- Node 26，直接运行 `.ts`；tsconfig 开启 `erasableSyntaxOnly`、`verbatimModuleSyntax`、`allowImportingTsExtensions`、`noEmit`；本地 import 写 `.ts` 后缀；不用 enum 和参数属性。
- Session 主键 = `agent类型:原生session_id`，例如 `claude:5d27595b-908e-4fe5-9283-890acdbd075f`；没有原生 ID 时临时键为 `pending:<机器>:<terminal_id>`。
- pane_id、terminal_id、机器、cwd、标题只是属性，可以随时更新。
- 短 ID = 原生 ID 的前 8 位，和其他 session 冲突时逐位加长直到唯一。
- Session 生命周期：`live` → `ended` → `purged`。机器心跳中断时**不判为 ended**，只在读取时显示为 `offline`。
- 中心不 ssh 到任何机器；采集器只读本机数据，推送到中心。
- 中心按 `(session_key, offset_start)` 去重；采集器的游标只有在中心确认收到后才前进。
- 对话里保留用户和助手的文本、工具调用摘要；丢掉 thinking/reasoning 和工具输出。
- 首次运行：活跃 session 从头导入，`ts_end` 早于采集器启动时间的 chunk 标 `backfill: true`。
- 不导入已经被 herdr 关闭的历史对话。
- 每个采集器有自己的 token，中心配置里 `collectors: { <机器label>: <token> }`。
- **与 spec 的偏差（计划作者的决定）**：spec 5.1 写的是"订阅本机 herdr 事件 + 60 秒快照兜底"。本计划改为**每 10 秒取一次本机快照**：读本机 socket 成本很低，而摘要本来就有 2 分钟防抖，订阅换不来实际收益。事件订阅留作以后的优化。
- 短 ID 在**数据库里的全部 session** 中保证唯一（spec 写的是"活跃 session"），这样 session 结束后短 ID 也不会变。
- chunk 分两种：`transcript`（offset 是对话文件的字节位置）和 `screen`（offset 是毫秒时间戳）。续读位置只看 `transcript`。

## Review Focus

1. **对话文件正在被写入、最后一行只写了一半** → 只读完整的行，半行留到下次，游标停在半行之前。（Task 3 `readDelta` 测试）
2. **采集器状态文件丢失或重装** → 先向中心查已收到的最大 offset 再续读，不产生重复 chunk。（Task 6 去重测试 + Task 8 恢复测试）
3. **笔记本休眠、心跳中断** → 它的 session 显示 `offline`，不会被标成 `ended`；醒来后照常继续。（Task 6 测试）
4. **单行巨大（几 MB 的工具输出）或单条消息很长** → 截断，不崩溃，chunk 大小有上限。（Task 4 测试）
5. **JSONL 里有坏行或不认识的记录类型** → 跳过该行，游标照常前进，不卡死。（Task 4 测试）

---

## 文件结构

```
package.json, tsconfig.json, vitest.config.ts, .gitignore
src/shared/protocol.ts        zod 协议：SnapshotSession、SnapshotPush、ChunkPush、OffsetResponse
src/shared/session-key.ts     makeSessionKey / pendingKey / parseSessionKey / assignShortIds
src/server/db.ts              openDb + 迁移
src/server/sessions-repo.ts   applySnapshot / insertChunks / maxOffset / listSessions / findByShortId
src/server/http.ts            createApp(db, config)：Hono 路由 + token 鉴权
src/server/config.ts          读中心配置
src/collector/herdr.ts        parseHerdrSnapshot（纯函数）+ readHerdrSnapshot（调 CLI）
src/collector/read-delta.ts   readDelta：按字节偏移读完整行
src/collector/normalize.ts    normalizeClaude / normalizeCodex / buildChunks
src/collector/locate.ts       locateTranscript（按 ID 找文件）
src/collector/pending.ts      matchRollout（无 ID 的 codex 补救）
src/collector/cursor-store.ts 本地游标 JSON 文件
src/collector/client.ts       推送客户端（带重试）
src/collector/loop.ts         collectOnce：一轮完整采集
src/collector/config.ts       读采集器配置
src/cli.ts                    herdr-pm server | collect | sessions
deploy/launchd/*.plist, deploy/systemd/*.service, scripts/build-collector.sh
tests/...                     与 src 对应
```

---

### Task 1: 项目骨架与共享协议

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/shared/protocol.ts`, `src/shared/session-key.ts`
- Test: `tests/shared/session-key.test.ts`

**Interfaces:**
- Produces:
  - `type AgentKind = string`（`claude`、`codex` 等，取 herdr 的 `agent` 字段）
  - `type LiveStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'`
  - `SnapshotSession`（zod）：`{ key: string, agent_kind: string, native_id: string | null, pane_id: string, terminal_id: string, workspace_id: string, tab_id: string, cwd: string, title: string, live_status: LiveStatus, fidelity: 'full' | 'screen', transcript_path: string | null }`
  - `SnapshotPush`（zod）：`{ machine: string, collector_version: string, sessions: SnapshotSession[], purged: string[] }`
  - `ChunkPush`（zod）：`{ machine: string, chunks: Array<{ session_key: string, kind: 'transcript' | 'screen', offset_start: number, offset_end: number, ts_start: string, ts_end: string, text: string, backfill: boolean }> }`
  - `OffsetResponse`（zod）：`{ session_key: string, max_offset_end: number | null }`
  - `makeSessionKey(agentKind: string, nativeId: string): string`
  - `pendingKey(machine: string, terminalId: string): string`
  - `parseSessionKey(key: string): { kind: 'native', agentKind: string, nativeId: string } | { kind: 'pending', machine: string, terminalId: string }`
  - `assignShortIds(keys: string[]): Map<string, string>`

- [ ] **Step 1: 初始化项目**

`npm init -y`，`"type": "module"`，`"engines": { "node": ">=26" }`，scripts：`"test": "vitest run"`、`"typecheck": "tsc"`。安装 `hono @hono/node-server zod`，开发依赖 `typescript vitest @types/node`。tsconfig 按 Global Constraints 配置，`"module": "nodenext"`、`"strict": true`。`.gitignore`：`node_modules/`、`*.db`、`dist/`、`.superpowers/`。

- [ ] **Step 2: 写失败的测试**

```ts
// tests/shared/session-key.test.ts
test('native key', () => {
  expect(makeSessionKey('claude', '5d27595b-908e-4fe5-9283-890acdbd075f'))
    .toBe('claude:5d27595b-908e-4fe5-9283-890acdbd075f');
  expect(parseSessionKey('codex:01a1883e-7f9e')).toEqual({ kind: 'native', agentKind: 'codex', nativeId: '01a1883e-7f9e' });
});
test('pending key', () => {
  expect(pendingKey('gx10-090e', 'term_65e13dfbb5fca2')).toBe('pending:gx10-090e:term_65e13dfbb5fca2');
  expect(parseSessionKey('pending:gx10-090e:term_65e13dfbb5fca2'))
    .toEqual({ kind: 'pending', machine: 'gx10-090e', terminalId: 'term_65e13dfbb5fca2' });
});
test('short ids are 8 chars and grow on collision', () => {
  const m = assignShortIds(['claude:0d67da1f-aaaa', 'claude:0d67da1f-bbbb', 'codex:1f68fc9b-cccc']);
  expect(m.get('claude:0d67da1f-aaaa')).toBe('0d67da1f-a');
  expect(m.get('claude:0d67da1f-bbbb')).toBe('0d67da1f-b');
  expect(m.get('codex:1f68fc9b-cccc')).toBe('1f68fc9b');
});
test('pending sessions get short id from terminal id', () => {
  expect(assignShortIds(['pending:gx10-090e:term_65e13dfbb5fca2']).get('pending:gx10-090e:term_65e13dfbb5fca2')).toBe('term_65e');
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run tests/shared/session-key.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `src/shared/session-key.ts` 和 `src/shared/protocol.ts`**

`assignShortIds`：对每个 key 取原生 ID（pending 取 terminal_id），从长度 8 开始，只要和其他任一 ID 的同长度前缀相同就加 1。`parseSessionKey` 按第一个 `:` 拆分；前缀是 `pending` 时再拆出 machine 和 terminal_id。

- [ ] **Step 5: 运行测试和类型检查，确认通过**

Run: `npx vitest run && npx tsc`
Expected: PASS，tsc 无输出

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: project skeleton, shared protocol and session keys"
```

---

### Task 2: 解析 herdr 快照

**Files:**
- Create: `src/collector/herdr.ts`
- Test: `tests/collector/herdr.test.ts`, `tests/fixtures/herdr-snapshot.json`

**Interfaces:**
- Consumes: `SnapshotSession`, `makeSessionKey`, `pendingKey`（Task 1）
- Produces:
  - `parseHerdrSnapshot(json: unknown, machine: string): SnapshotSession[]`（`fidelity` 和 `transcript_path` 先填 `'screen'` / `null`，由 Task 8 根据找到的文件改写）
  - `readHerdrSnapshot(herdrBin: string): Promise<unknown>`：执行 `<herdrBin> api snapshot`，返回解析后的 JSON

- [ ] **Step 1: 写 fixture**

`tests/fixtures/herdr-snapshot.json`：按 2026-10-29 实测的结构（`{ result: { snapshot: { panes: [...] } } }`）手写 3 个 pane：
1. claude，带 `agent_session.value = "5d27595b-908e-4fe5-9283-890acdbd075f"`，`agent_status: "working"`
2. codex，没有 `agent_session`，`terminal_id: "term_65e13dfbb5fca2"`，`agent_status: "idle"`
3. 没有 `agent` 字段的普通 shell pane

- [ ] **Step 2: 写失败的测试**

```ts
test('maps agent panes to sessions, skips plain shells', () => {
  const s = parseHerdrSnapshot(fixture, 'gx10-090e');
  expect(s).toHaveLength(2);
  expect(s[0]).toMatchObject({ key: 'claude:5d27595b-908e-4fe5-9283-890acdbd075f', agent_kind: 'claude',
    native_id: '5d27595b-908e-4fe5-9283-890acdbd075f', live_status: 'working' });
  expect(s[1]).toMatchObject({ key: 'pending:gx10-090e:term_65e13dfbb5fca2', native_id: null, live_status: 'idle' });
});
test('title prefers terminal_title_stripped', () => { /* 断言 title 等于 fixture 里的 stripped 值 */ });
test('unknown status maps to unknown', () => { /* agent_status: "weird" → 'unknown' */ });
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/collector/herdr.test.ts` → FAIL

- [ ] **Step 4: 实现 `parseHerdrSnapshot` 和 `readHerdrSnapshot`**

读 `result.snapshot.panes`，只保留有 `agent` 的 pane。`readHerdrSnapshot` 用 `execFile`，超时 15 秒；非零退出时抛错，错误信息里带 stderr。

- [ ] **Step 5: 运行，确认通过** → PASS

- [ ] **Step 6: Commit** `git commit -m "feat(collector): parse herdr snapshot into sessions"`

---

### Task 3: 按字节偏移读取完整行

**Files:**
- Create: `src/collector/read-delta.ts`
- Test: `tests/collector/read-delta.test.ts`

**Interfaces:**
- Produces: `readDelta(path: string, offset: number, maxBytes: number): Promise<{ lines: string[], newOffset: number, reset: boolean, missing: boolean }>`
  - `reset: true`：文件比 offset 还短（被截断或替换），这次从 0 开始读
  - `missing: true`：文件不存在，`lines` 为空、`newOffset === offset`

- [ ] **Step 1: 写失败的测试**（每个测试在 `os.tmpdir()` 下新建临时文件）

```ts
test('reads only complete lines; partial tail stays for next read', async () => {
  await writeFile(p, '{"a":1}\n{"b":2}\n{"c":');
  const r = await readDelta(p, 0, 1 << 20);
  expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
  expect(r.newOffset).toBe(16);
  await appendFile(p, '3}\n');
  expect((await readDelta(p, 16, 1 << 20)).lines).toEqual(['{"c":3}']);
});
test('truncated file resets to 0', async () => { /* 写 5 字节，offset=100 → reset true，从头读 */ });
test('missing file', async () => { /* 不存在 → missing true, newOffset === offset */ });
test('respects maxBytes but never splits a line', async () => { /* maxBytes 小于第二行结尾 → 只返回第一行 */ });
test('single line longer than maxBytes is still returned whole', async () => { /* 一行 3MB，maxBytes 1MB → 返回这一行，防止卡死 */ });
test('utf-8 multibyte chars are not split', async () => { /* 中文内容，offset 按字节计算 */ });
```

- [ ] **Step 2: 运行，确认失败** → FAIL

- [ ] **Step 3: 实现 `readDelta`**

用 `fs.promises.open` + `read` 按字节读 Buffer，在 Buffer 里找最后一个 `0x0a`，只解码到那里为止（所以多字节字符不会被切开）。如果 `maxBytes` 内一个换行都没有，就继续往后读，直到遇到换行或文件结尾。

- [ ] **Step 4: 运行，确认通过** → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(collector): read complete jsonl lines from byte offset"`

---

### Task 4: 把 Claude / Codex 对话规范化成 chunk

**Files:**
- Create: `src/collector/normalize.ts`
- Test: `tests/collector/normalize.test.ts`

**Interfaces:**
- Produces:
  - `type Entry = { ts: string, role: 'user' | 'assistant' | 'tool', text: string }`
  - `normalizeClaude(lines: string[]): Entry[]`
  - `normalizeCodex(lines: string[]): Entry[]`
  - `buildChunks(entries: Entry[], offsetStart: number, offsetEnd: number, opts: { maxChunkChars: number }): Array<{ offset_start, offset_end, ts_start, ts_end, text }>`
  - 常量：`MAX_ENTRY_CHARS = 4000`、`MAX_TOOL_SUMMARY_CHARS = 200`、`MAX_CHUNK_CHARS = 48000`

规则（来自 2026-10-29 对真实文件的检查）：

| 来源 | 保留 | 丢弃 |
|---|---|---|
| Claude | `type:"user"` 且 `message.content` 是字符串或 `text` 块 → `user`；`type:"assistant"` 的 `text` 块 → `assistant`；`tool_use` 块 → `tool`，文本为 `<name>: <JSON.stringify(input) 截断到 200>` | `thinking`、`tool_result`、`attachment`、`api-request*`、`mode`、`ai-title` 等其他所有类型 |
| Codex | `response_item` + `payload.type:"message"`：`role:"user"` 的 `input_text`（以 `<environment_context>` 开头的跳过）→ `user`；`role:"assistant"` 的 `output_text` → `assistant`；`function_call` / `custom_tool_call` → `tool`，文本为 `<name>: <arguments 截断到 200>` | `role:"developer"`、`reasoning`、`*_output`、`event_msg`、`token_count`、`turn_context` 等 |

时间戳取每行顶层的 `timestamp`。

- [ ] **Step 1: 写失败的测试**（在测试里手写合成的 JSONL 行，不用真实用户数据）

```ts
test('claude: keeps user text, assistant text, tool_use summary; drops thinking and tool_result', () => {
  const e = normalizeClaude([userStr('帮我整理目录'), asstThinking('...'), asstToolUse('Bash', { command: 'ls' }), userToolResult('x'.repeat(10000)), asstText('好的')]);
  expect(e.map(x => [x.role, x.text])).toEqual([['user', '帮我整理目录'], ['tool', 'Bash: {"command":"ls"}'], ['assistant', '好的']]);
});
test('codex: skips developer and environment_context, keeps output_text and function_call', () => { /* ... */ });
test('bad json lines and unknown record types are skipped', () => {
  expect(normalizeClaude(['not json', '{"type":"brand-new-type"}', userStr('hi')])).toHaveLength(1);
});
test('long entry is truncated to MAX_ENTRY_CHARS with marker', () => {
  const [e] = normalizeClaude([asstText('x'.repeat(50000))]);
  expect(e.text.length).toBeLessThanOrEqual(4000 + 20);
  expect(e.text.endsWith('…[已截断]')).toBe(true);
});
test('buildChunks formats lines and splits at MAX_CHUNK_CHARS without splitting an entry', () => {
  const chunks = buildChunks(manyEntries(/* 总长约 120k */), 0, 999, { maxChunkChars: 48000 });
  expect(chunks.length).toBeGreaterThanOrEqual(3);
  expect(chunks.every(c => c.text.length <= 48000)).toBe(true);
  expect(chunks[0].text.split('\n')[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\] (user|assistant|tool): /);
});
test('split chunks share the byte range: only the last chunk carries the real offset_end', () => {
  // 第 i 个 chunk 的 offset_start = offsetStart * 1000 + i（子序号），保证 (session_key, offset_start) 唯一
});
test('empty entries produce no chunks', () => { expect(buildChunks([], 0, 10, { maxChunkChars: 48000 })).toEqual([]); });
```

- [ ] **Step 2: 运行，确认失败** → FAIL

- [ ] **Step 3: 实现**

每条 entry 格式化为 `[YYYY-MM-DDTHH:MMZ] role: text`。chunk 拆分规则（测试里也写了）：一次读取被拆成 n 个 chunk 时，第 i 个的 `offset_start = offsetStart * 1000 + i`，最后一个的 `offset_end = offsetEnd`，其余的 `offset_end = offsetStart`。这样中心可以继续用 `(session_key, offset_start)` 去重，用 `max(offset_end)` 计算续读位置。

- [ ] **Step 4: 运行，确认通过** → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(collector): normalize claude/codex transcripts into chunks"`

---

### Task 5: 定位对话文件 + 无 ID codex 的补救匹配

**Files:**
- Create: `src/collector/locate.ts`, `src/collector/pending.ts`
- Test: `tests/collector/locate.test.ts`, `tests/collector/pending.test.ts`

**Interfaces:**
- Produces:
  - `locateTranscript(agentKind: string, nativeId: string, dirs: { claudeDir: string, codexDir: string }): Promise<string | null>`
    - claude：在 `<claudeDir>/projects/*/` 下找 `<nativeId>.jsonl`
    - codex：在 `<codexDir>/sessions/**/` 下找 `rollout-*-<nativeId>.jsonl`
    - 其他类型返回 `null`
  - `readRolloutMeta(path: string): Promise<{ id: string, cwd: string, timestamp: string } | null>`：读第一行 `session_meta.payload`
  - `matchRollout(candidates: Array<{ id: string, cwd: string, timestamp: string, path: string }>, target: { cwd: string, startedAt: Date }, toleranceMs?: number): { id: string, path: string } | null`（默认容差 120000 毫秒）
  - `processStartTime(pid: number): Promise<Date | null>`：`ps -o lstart= -p <pid>`（macOS 和 Linux 都可用）

- [ ] **Step 1: 写失败的测试**

```ts
test('locates claude transcript by id regardless of project slug', async () => { /* 临时目录 projects/-Users-x-y/<id>.jsonl */ });
test('locates codex rollout by id in nested date dirs', async () => { /* sessions/2026/10/29/rollout-2026-10-29T11-19-19-<id>.jsonl */ });
test('returns null when absent', async () => {});
test('matchRollout picks same cwd closest in time within tolerance', () => {
  const c = [
    { id: 'a', cwd: '/w', timestamp: '2026-10-29T11:00:00Z', path: 'pa' },
    { id: 'b', cwd: '/w', timestamp: '2026-10-29T11:19:19Z', path: 'pb' },
    { id: 'c', cwd: '/other', timestamp: '2026-10-29T11:19:20Z', path: 'pc' },
  ];
  expect(matchRollout(c, { cwd: '/w', startedAt: new Date('2026-10-29T11:19:00Z') })).toEqual({ id: 'b', path: 'pb' });
});
test('matchRollout returns null when nothing within tolerance', () => {});
test('matchRollout returns null when two candidates tie (ambiguous)', () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL

- [ ] **Step 3: 实现**

目录遍历用 `fs.promises.readdir({ recursive: true })` 后按文件名过滤。codex 补救只扫最近 7 天的日期目录。

- [ ] **Step 4: 运行，确认通过** → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(collector): locate transcripts and match id-less codex rollouts"`

---

### Task 6: 中心数据库与 session 仓库

**Files:**
- Create: `src/server/db.ts`, `src/server/sessions-repo.ts`
- Test: `tests/server/sessions-repo.test.ts`

**Interfaces:**
- Consumes: `SnapshotPush`、`ChunkPush`、`assignShortIds`、`parseSessionKey`（Task 1）
- Produces:
  - `openDb(path: string): DatabaseSync`：打开数据库，开启 WAL，按 `PRAGMA user_version` 依次执行迁移数组 `MIGRATIONS: string[]`
  - 表（第 1 个迁移）：
    - `machines(label TEXT PRIMARY KEY, last_heartbeat TEXT, collector_version TEXT)`
    - `sessions(key TEXT PRIMARY KEY, agent_kind TEXT, native_id TEXT, machine TEXT, pane_id TEXT, terminal_id TEXT, workspace_id TEXT, tab_id TEXT, cwd TEXT, title TEXT, live_status TEXT, lifecycle TEXT, fidelity TEXT, transcript_path TEXT, predecessor_key TEXT, merged_into TEXT, ignored INTEGER DEFAULT 0, first_seen TEXT, last_seen TEXT)`
    - `chunks(id INTEGER PRIMARY KEY, session_key TEXT, kind TEXT, offset_start INTEGER, offset_end INTEGER, ts_start TEXT, ts_end TEXT, text TEXT, backfill INTEGER, digested INTEGER DEFAULT 0, received_at TEXT, UNIQUE(session_key, offset_start))`
  - `applySnapshot(db, push: SnapshotPush, now: Date): void`
  - `insertChunks(db, push: ChunkPush, now: Date): { inserted: number, duplicates: number }`（一次推送在一个事务里，全部成功或全部失败）
  - `maxOffset(db, sessionKey: string): number | null`：只统计 `kind = 'transcript'` 的 `max(offset_end)`
  - `type SessionView = 行字段 + { short_id: string, effective_status: LiveStatus | 'ended' | 'purged' | 'offline', chunk_count: number }`
  - `listSessions(db, filter: { machine?: string, lifecycle?: string }, now: Date): SessionView[]`
  - `findByShortId(db, shortId: string, now: Date): SessionView[]`（可能多个，由调用方处理）
  - 常量 `OFFLINE_AFTER_MS = 180000`

`applySnapshot` 规则（全部在一个事务里）：
1. upsert `machines`（心跳 = now）。
2. upsert 快照里的每个 session：`lifecycle = 'live'`，更新所有属性和 `last_seen`；`first_seen` 只在插入时写。
3. 该机器上 `lifecycle = 'live'`、但不在本次快照里的 session → `ended`。
4. **接续关系**：如果一个新出现的 session 和第 3 步刚结束的某个 session 有相同的 `terminal_id`，就把新 session 的 `predecessor_key` 设为旧的 key。
5. **pending 合并**：如果快照里有原生 key 的 session，并且它的 `terminal_id` 对应一个同机器的 `pending:` session，就把 pending session 的 chunks 改挂到原生 key 上，pending 行写 `merged_into = 原生key`、`lifecycle = 'ended'`。
6. `push.purged` 里的 key → `purged`。

- [ ] **Step 1: 写失败的测试**（用 `openDb(':memory:')`）

```ts
test('snapshot upserts live sessions and heartbeat', () => {});
test('session missing from its machine snapshot becomes ended', () => {});
test('sessions of a machine that stopped reporting show offline, not ended', () => {
  applySnapshot(db, push('laptop', [s1]), t0);
  const v = listSessions(db, {}, new Date(t0.getTime() + 181000));
  expect(v[0]).toMatchObject({ lifecycle: 'live', effective_status: 'offline' });
});
test('other machines are unaffected by one machine snapshot', () => {});
test('new session on same terminal after old one ended gets predecessor_key', () => {});
test('pending session merges into native key and moves chunks', () => {});
test('purged keys are marked purged', () => {});
test('insertChunks dedupes on (session_key, offset_start)', () => {
  expect(insertChunks(db, cp, now)).toEqual({ inserted: 2, duplicates: 0 });
  expect(insertChunks(db, cp, now)).toEqual({ inserted: 0, duplicates: 2 });
});
test('maxOffset returns max offset_end or null', () => {});
test('maxOffset ignores screen chunks (e.g. moved in by a pending merge)', () => {});
test('findByShortId resolves 8-char prefix', () => {});
test('migrations are idempotent when opening the same file twice', () => { /* 临时文件 */ });
```

- [ ] **Step 2: 运行，确认失败** → FAIL

- [ ] **Step 3: 实现** `db.ts` 和 `sessions-repo.ts`（`node:sqlite` 的 `DatabaseSync`，事务用 `BEGIN`/`COMMIT`，出错 `ROLLBACK`）

- [ ] **Step 4: 运行，确认通过** → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(server): sqlite schema and session repository"`

---

### Task 7: 中心 HTTP 服务

**Files:**
- Create: `src/server/http.ts`, `src/server/config.ts`
- Test: `tests/server/http.test.ts`

**Interfaces:**
- Consumes: Task 6 的仓库函数、Task 1 的 zod 协议
- Produces:
  - `type ServerConfig = { port: number, dbPath: string, collectors: Record<string, string> }`（label → token）
  - `loadServerConfig(path: string): ServerConfig`
  - `createApp(db: DatabaseSync, config: ServerConfig, clock?: () => Date): Hono`
  - 路由：
    - `POST /ingest/snapshot`（body: `SnapshotPush`）→ `{ ok: true }`
    - `POST /ingest/chunks`（body: `ChunkPush`）→ `{ inserted, duplicates }`
    - `GET /ingest/offset?session_key=` → `OffsetResponse`
    - `GET /sessions?machine=&lifecycle=` → `SessionView[]`
    - `GET /sessions/by-short-id/:sid` → `SessionView[]`
  - 鉴权：`/ingest/*` 要求 `Authorization: Bearer <token>`，并且 token 必须属于 body（或 query `machine`）里声明的那台机器。`/sessions*` 这一期不鉴权（只在 Tailscale 内网访问，计划 4 再加）。

- [ ] **Step 1: 写失败的测试**（用 `app.request()`，不起真实端口）

```ts
test('rejects ingest without token (401)', async () => {});
test('rejects token of another machine (403)', async () => {
  // gx10-090e 的 token 推 machine: 'laptop' 的快照 → 403
});
test('rejects malformed body (400) with zod issues', async () => {});
test('snapshot then GET /sessions returns the session with short_id', async () => {});
test('chunks are deduped across repeated pushes', async () => {});
test('offset endpoint returns null for unknown session', async () => {});
test('by-short-id returns matches', async () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL

- [ ] **Step 3: 实现**（`@hono/node-server` 的 `serve` 只在 CLI 里调用，`createApp` 本身不监听端口）

- [ ] **Step 4: 运行，确认通过** → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(server): ingest and session query http api"`

---

### Task 8: 采集循环

**Files:**
- Create: `src/collector/cursor-store.ts`, `src/collector/client.ts`, `src/collector/loop.ts`, `src/collector/config.ts`
- Test: `tests/collector/loop.test.ts`

**Interfaces:**
- Consumes: Task 2–5 的全部函数；Task 7 的 HTTP 接口
- Produces:
  - `type CollectorConfig = { server: string, machine: string, token: string, herdrBin: string, claudeDir: string, codexDir: string, stateFile: string, pollMs: number }`（`pollMs` 默认 10000）
  - `CursorStore`：`load(path): Promise<CursorStore>`、`get(key): Cursor | undefined`、`set(key, c: Cursor)`、`save(): Promise<void>`；`type Cursor = { path: string | null, offset: number, screenHash?: string, fidelity: 'full' | 'screen' }`
  - `PmClient`：`pushSnapshot(p: SnapshotPush)`、`pushChunks(p: ChunkPush)`、`getOffset(key): Promise<number | null>`；网络错误和 5xx 抛出 `RetryableError`
  - `type Deps = { readSnapshot(): Promise<unknown>, readScreen(paneId: string): Promise<string>, paneProcess(paneId: string): Promise<{ pid: number, cwd: string } | null>, client: PmClient, now(): Date, startedAt: Date }`
  - `collectOnce(cfg: CollectorConfig, store: CursorStore, deps: Deps): Promise<{ sessions: number, chunksPushed: number }>`
  - `runCollector(cfg: CollectorConfig): Promise<never>`：每 `pollMs` 调一次 `collectOnce`；出错记日志、指数退避（上限 5 分钟），永不退出

`collectOnce` 流程：
1. `parseHerdrSnapshot(await deps.readSnapshot(), cfg.machine)`。
2. 对每个 session：
   - 有 native_id：`locateTranscript`；找到就把 `fidelity` 设为 `'full'`，写入 `transcript_path`。
   - 没有 native_id 且是 codex：`paneProcess` → `processStartTime` → 扫最近 7 天的 rollout → `matchRollout`；匹配上就当作有 native_id 处理（key 改为原生 key）。
   - 都不行：`fidelity: 'screen'`。
3. 每小时一次：检查 store 里那些已经不在快照中的 session，文件不存在的放进 `purged`。
4. `pushSnapshot`。
5. 对每个 `full` session：store 里没有游标时先 `getOffset`（中心有记录就从那里续读，否则从 0 开始）；然后循环 `readDelta(path, offset, 4 MiB)` → normalize → `buildChunks` → `pushChunks` → **推送成功后**才更新游标并 `save()`，直到读完。`ts_end < deps.startedAt` 的 chunk 标 `backfill: true`。
6. 对每个 `screen` session：只在 `live_status` 不是 `working` 时，`readScreen(pane)`（`herdr agent read <pane> --source recent-unwrapped --lines 200`）；内容 hash 和上次相同就跳过；否则推送一个 `kind: 'screen'` 的 chunk，`offset_start = offset_end = now 的毫秒数`。对话来源的 chunk 一律 `kind: 'transcript'`。

- [ ] **Step 1: 写失败的测试**（Deps 全部用假的；`client` 用内存实现，或者直接用 Task 7 的 `createApp` + `app.request` 包一层）

```ts
test('first run reads transcript from 0 and marks old chunks as backfill', async () => {});
test('second run pushes only the new tail', async () => {});
test('cursor does not advance when push fails; next run re-sends same range', async () => {});
test('lost state file: resumes from server max offset, no duplicates', async () => {
  // 第一次跑完 → 删掉 state 文件、换一个新的 CursorStore → 再跑 → 中心 duplicates === 0 且 inserted === 0
});
test('id-less codex resolved via matchRollout becomes native key with full fidelity', async () => {});
test('unresolvable session falls back to screen and dedupes identical screens', async () => {});
test('herdr snapshot failure throws so runCollector can back off', async () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行，确认通过** → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(collector): collection loop with cursors, backfill and fallbacks"`

---

### Task 9: CLI、打包与部署

**Files:**
- Create: `src/cli.ts`, `scripts/build-collector.sh`, `deploy/launchd/ai.herdr-pm.server.plist`, `deploy/launchd/ai.herdr-pm.collector.plist`, `deploy/systemd/herdr-pm-collector.service`, `config/server.example.json`, `config/collector.example.json`, `README.md`
- Modify: `package.json`（`"bin": { "herdr-pm": "src/cli.ts" }`）
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `loadServerConfig`、`createApp`、`openDb`、`runCollector`、`CollectorConfig`
- Produces: 命令
  - `herdr-pm server --config <path>`
  - `herdr-pm collect --config <path>`
  - `herdr-pm sessions [--server <url>] [--machine <m>]`：表格输出 `短ID  机器  agent  状态  标题`

- [ ] **Step 1: 写失败的测试**

```ts
test('sessions command formats table from /sessions response', async () => {
  // 注入一个假的 fetch，断言输出里每行包含 short_id、machine、effective_status、title
});
test('unknown command prints usage and exits 2', async () => {});
```

- [ ] **Step 2: 运行，确认失败** → FAIL

- [ ] **Step 3: 实现 `src/cli.ts`**（参数解析用 `node:util` 的 `parseArgs`）

- [ ] **Step 4: 运行，确认通过** → PASS

- [ ] **Step 5: 写部署文件**
  - `scripts/build-collector.sh`：`bun build src/cli.ts --compile --target=<bun-linux-arm64|bun-darwin-arm64> --outfile dist/herdr-pm-<target>`（gx10 是 ARM Linux：先在 gx10 上跑 `uname -m` 确认，结果写进 README）
  - launchd plist：`KeepAlive`、`RunAtLoad`，日志写到 `~/Library/Logs/herdr-pm/`
  - systemd user service：`Restart=always`
  - README：中心和每台机器的安装步骤

- [ ] **Step 6: 端到端冒烟（手动，在笔记本上）**

```bash
herdr-pm server --config config/server.local.json &      # 端口 7718，dbPath ./dev.db
herdr-pm collect --config config/collector.local.json &  # machine: laptop
sleep 30 && herdr-pm sessions --server http://localhost:7718
```
Expected：列出笔记本上 herdr 里的所有活跃 agent，Claude session 的 `fidelity` 为 `full`，`chunk_count > 0`。

- [ ] **Step 7: Commit** `git commit -m "feat: cli, collector packaging and deploy units"`

---

## 部署验收（计划完成的标志）

1. mac-mini 上用 launchd 跑中心服务；笔记本、mac-mini、gx10-090e、gx10-c757 各跑一个采集器。
2. `herdr-pm sessions --server http://<mac-mini 的 Tailscale IP>:7718` 列出四台机器上的全部活跃 session。
3. 让笔记本休眠超过 3 分钟：它的 session 显示 `offline`；唤醒后恢复 `live`，chunk 继续增长，没有重复。
4. 在 herdr 里关掉一个 agent：下一轮它变成 `ended`。
