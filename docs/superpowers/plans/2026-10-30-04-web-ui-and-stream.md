# herdr-pm 计划 4：网页界面 + `WS /stream` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在浏览器里打开中心服务的地址，就能看到以项目为主体的首页、项目详情（big picture、里程碑、todo、阻塞、决策、session 时间线、事件日志）、问答箱和待归属的 session，并能直接编辑、回答、撤销；页面通过 WebSocket 收到变化后局部刷新。

**Architecture:** 后端加三样东西：`ChangeFeed` 定时比较数据库的几个"水位"（最大 event id、问题签名、session 签名、调度器状态），有变化就通过 `WS /stream` 广播**失效信号**（只说"哪类数据变了"，不带内容）；页面收到后用已有的 HTTP 读接口重新取数。前端是 `web/` 下的 React 单页应用，Vite 构建到 `dist/web/`，由同一个 Hono 进程托管在 `/`，页面内用 hash 路由（`#/p/<id>`），因为 `/projects/:id` 这类路径已经是 JSON 接口。写操作全部走计划 2 的 HTTP 接口，带用户 token。

**Tech Stack:** 沿用前三期（Node 26、`node:sqlite`、Hono、zod 4、vitest 5）。新增运行时依赖 `ws@8.22.0`、`react@19.3.1`、`react-dom@19.3.1`；开发依赖 `vite@8.3.5`（vitest 已经装了这个版本）、`@vitejs/plugin-react@6.1.2`、`@types/react@19.3.0`、`@types/react-dom@19.3.0`、`@types/ws@8.18.2`、`jsdom@30.1.3`、`@testing-library/react@16.3.3`、`@testing-library/dom@10.4.2`。版本全部写死（不加 `^`）。

**Spec:** `docs/superpowers/specs/2026-10-29-project-manager-design.md`（第 7、8、9、10、13 节；视觉方向见 `docs/superpowers/mockups/02-home-project-centric.html`）

**路线图（本计划是第 4 个）：**
1. 数据采集地基（已合并）
2. 领域操作层 + HTTP API（已合并）
3. 理解层 + MCP（已合并）
4. **网页界面 + `WS /stream`**（本计划）
5. herdr 查找工具和侧边栏短 ID

## Global Constraints

- 沿用前几期：Node 26 直接运行 `.ts`；`erasableSyntaxOnly`、`verbatimModuleSyntax`；本地 import 写 `.ts` / `.tsx` 后缀；不用 enum 和参数属性。本计划**不加数据库迁移**。
- 页面上的所有文案用中文，阶段名用 `STAGE_LABEL`（idea / 探索 / 构建 / 验证 / 完成 / 搁置 / 放弃 / 合并），优先级 P0–P3。
- 前端**不知道业务规则**（spec 第 8 节"前端不需要知道每种按钮的业务含义"）：能不能做由操作层判断，前端只负责发请求、把拒绝原因用中文显示出来。不要在前端复制状态机或信任边界。
- 前端从不直接读写 SQLite，所有数据都经过 HTTP 接口（spec 第 12 节）。
- AI 写的文字（标题、summary、理由、对话片段）一律当纯文本渲染：**禁止 `dangerouslySetInnerHTML`**，不解析 Markdown。
- 写请求带 `Authorization: Bearer <userToken>`。token 由用户在页面上输入一次，存进 `localStorage` 的 `herdr-pm.userToken`；所有 `localStorage` 读写都包在 try/catch 里，读不到就当没有 token。
- 浏览器端的 import 不能拉进任何 `node:` 模块：前端只能 `import type` 后端类型，运行时值只能从 `src/shared/` 下没有 import 的文件取。
- 页面通过 Tailscale 以 `http://` 打开（不是安全上下文），所以不能依赖只在 HTTPS 下可用的浏览器 API（如 `navigator.clipboard`），必须有退路。
- 能在手机上用（spec 第 2 节非目标"网页能在手机上用即可"）：宽度 < 900px 时右栏排到主列表下面，页面不出现横向滚动。
- 测试里不起真浏览器：组件测试用 jsdom + Testing Library，`fetch` 和 `WebSocket` 用假实现。端到端只在 Task 8 用 gstack `/browse` 手动走一遍。
- **与 spec 的偏差（计划作者的决定）**：
  - spec 第 10 节没有"看证据"的接口，但 9.2 要求"每条决策都能点开看来源 session 和对话片段"：新增 `GET /evidence/:ref`。它返回原始对话文本，比其他读接口敏感，所以**要求用户 token**（其他 GET 仍然开放）。
  - `GET /sessions` 的每一项多一个 `linked_projects` 字段（只加在 HTTP 响应上，`SessionView` 和 MCP 的 `pm_list_sessions` 不变），供 session 页显示和取消关联。
  - `WS /stream` 只推失效信号，不推数据本身；页面收到后重新请求对应的 HTTP 接口。这样跨站页面即使连上 WS 也拿不到内容，另外再加 Origin 检查。
  - 变化检测用轮询数据库（默认 1 秒一次，只在有客户端连着时运行），不在每条写入路径里埋钩子：写入路径有 `execute`、`askUser`、回答问题、快照、调度器等很多条，轮询一处就能全部覆盖，包括"采集器掉线"这种没有任何写入的变化。
  - 页面挂在 `/`，页面内路由用 hash（`#/`、`#/p/<id>`、`#/sessions`），静态资源在 `/assets/`。
  - 首页不做搜索框和筛选（spec 第 9 节没有要求）。

## Review Focus

1. **通过 Tailscale 用 `http://mac-mini:8787/` 打开页面，点 session 标签复制短 ID**：`navigator.clipboard` 不可用，必须退回到隐藏 textarea + `document.execCommand('copy')`；两种都失败时用提示条把短 ID 显示出来让用户手动选中。不能静默失败。（Task 4 测试）
2. **某台机器的采集器停了（没有任何数据库写入）**：180 秒后它的 session 应该在页面上变成"离线"。`ChangeFeed` 的 session 签名必须把"按当前时间算出的离线机器"算进去，而不只是比较表里的行。（Task 2 测试）
3. **WebSocket 断开（服务重启、笔记本睡眠）**：页面显示"重连中"，按 1s、2s、4s、8s、10s（封顶）重连；连上后服务端先发 `hello`，页面把所有数据重新取一遍，补上断线期间错过的变化。（Task 3 测试）
4. **数据指向已删除的东西**：todo 所属的里程碑被删了、session 标签挂的里程碑被删了、贡献记录对应的 session 行已清除。页面要把它们放进"未分组 / 其他 / (已清除)"，不能丢掉，也不能报错。（Task 5、6、7 测试）
5. **没设 token、token 错了、问题已经过时**：写请求返回 401 时弹出 token 输入框；409 等拒绝显示成中文原因（例如"情况已变，这个问题已撤回"），不能静默失败。跨站页面带着别的 Origin 连 `/stream` 时被拒绝。（Task 2、3、4 测试）

---

## 文件结构

```
src/shared/vocab.ts              新增：STAGES / PRIORITIES / STAGE_LABEL（无 import，前后端共用）
src/shared/stream-protocol.ts    新增：StreamMessage 类型（无 import）
src/domain/types.ts              修改：从 vocab.ts 重新导出上面三个常量
src/domain/evidence.ts           新增：getEvidence（摘要 / chunk 证据）
src/domain/read.ts               修改：sessionLinks（session → 关联项目）
src/server/sessions-repo.ts      修改：getSession（按 key 取一个 SessionView）
src/server/change-feed.ts        新增：ChangeFeed（水位轮询 → StreamMessage）
src/server/stream.ts             新增：attachStream（ws upgrade、Origin 检查、心跳）
src/server/web.ts                新增：mountWeb（托管 dist/web）
src/server/http.ts               修改：/evidence、/sessions 加 linked_projects、mountWeb
src/cli.ts                       修改：server 命令接上 ChangeFeed、attachStream、webDir
web/index.html, web/tsconfig.json, vite.config.ts, vitest.config.ts, package.json, tsconfig.json
web/src/main.tsx                 入口
web/src/app.tsx                  外壳：顶栏、hash 路由、token 对话框、提示条
web/src/api.ts                   fetch 封装、ApiError、token 存取、errorText
web/src/stream.ts                StreamClient（重连）、topicsFor
web/src/use-api.ts               useApi（按 topic 自动重取）、StreamContext
web/src/route.ts                 parseHash
web/src/format.ts                时间、状态点、操作名、操作者的显示
web/src/copy.ts                  copyText（剪贴板 + 退路）
web/src/styles.css               样式（按 mockup 02）
web/src/components/              session-tag、question-card、evidence-drawer、toast、editable-text、confirm-button、
                                 project-card、kanban、stage-control、items、timeline、event-log
web/src/home-model.ts            首页分组的纯函数
web/src/timeline.ts              时间线布局的纯函数
web/src/pages/                   home.tsx、project.tsx、sessions.tsx
scripts/seed-demo.ts             新增：往一个空库里灌演示数据（QA 用）
tests/web/*.test.ts(x)           前端测试（jsdom）
README.md
```

---

### Task 1: 后端补充读接口（共享词表、证据、session 关联）

**Files:**
- Create: `src/shared/vocab.ts`, `src/domain/evidence.ts`
- Modify: `src/domain/types.ts`, `src/domain/read.ts`, `src/server/sessions-repo.ts`, `src/server/http.ts`
- Test: `tests/shared/vocab.test.ts`, `tests/domain/evidence.test.ts`, `tests/domain/read.test.ts`, `tests/server/http.test.ts`

**Interfaces:**
- Consumes: `mergeTarget(db, key)`、`listSessions` / `SessionView`（sessions-repo）；`Digest`（`src/understand/digest.ts`，只用 `import type`）；`userAuth(config)`（domain-routes）。
- Produces:
  - `src/shared/vocab.ts`：`STAGES`、`type Stage`、`PRIORITIES`、`type Priority`、`STAGE_LABEL`。文件里**没有任何 import**。`src/domain/types.ts` 改为从这里重新导出，现有 import 全部不变。
  - `getSession(db: DatabaseSync, key: string, now: Date): SessionView | null`（sessions-repo）：先走 `mergeTarget`，再取那一行；没有就返回 `null`。
  - `sessionLinks(db: DatabaseSync): Map<string, Array<{ id: string; title: string }>>`（read.ts）：未删除的 contribution，且项目未删除，按 session_key 分组，每组按项目标题排序。
  - `EVIDENCE_MAX_CHUNKS = 20`、`EVIDENCE_CHUNK_CHARS = 4000`，以及：
    ```ts
    export type EvidenceChunk = { id: number; kind: string; ts_start: string | null; ts_end: string | null; text: string; truncated: boolean };
    export type EvidenceView = {
      ref: string; kind: 'digest' | 'chunk'; id: number;
      session_key: string; session: SessionView | null;
      ts_start: string | null; ts_end: string | null;
      digest: Digest | null;      // kind 为 chunk 时总是 null；摘要 JSON 解析失败时也是 null
      chunks: EvidenceChunk[];    // chunk：就是它自己；digest：chunk_ids 里按 id 升序的前 20 个
    };
    export function parseEvidenceRef(ref: string): { kind: 'digest' | 'chunk'; id: number } | null;  // 只认 digest:<正整数> / chunk:<正整数>
    export function getEvidence(db: DatabaseSync, now: Date, ref: string): EvidenceView | null;
    ```
  - HTTP：`GET /evidence/:ref`（要求用户 token；格式不对 400 `{error:'invalid'}`，不存在 404 `{error:'not_found'}`）；`GET /sessions` 的每一项变成 `SessionView & { linked_projects: Array<{id, title}> }`，导出类型 `SessionListItem`（放在 http.ts）。

- [ ] **Step 1: 写失败的测试**

`tests/shared/vocab.test.ts`
- `vocab.ts has no imports`：读文件文本，断言不匹配 `/^\s*import\s/m`。
- `types.ts re-exports the same objects`：`types.STAGES === vocab.STAGES`，`STAGE_LABEL` 和 `PRIORITIES` 也一样。

`tests/domain/evidence.test.ts`（用 `openDb(':memory:')` 直接插 sessions / chunks / digests 行）
- `parseEvidenceRef`：`'digest:3'` → `{kind:'digest', id:3}`；`'chunk:0'`、`'digest:-1'`、`'digest:1e3'`、`'digest:03'`、`'foo:1'`、`'digest:'` 全部 → `null`。
- `chunk evidence`：返回 `kind:'chunk'`，`chunks` 只有它自己，`digest: null`，`session.short_id` 有值。
- `digest evidence lists its chunks in id order, capped`：摘要的 `chunk_ids` 是 `[25 个 id，乱序]`，返回的 `chunks.length === 20`，并且 id 升序。
- `long chunk text is cut`：5000 字符的 chunk → `text.length === 4000`，`truncated === true`；短的为 `false`。
- `follows a merged session key`：chunk 挂在 pending key 上，pending 行 `merged_into` 指向真 key → `session.key` 是真 key，`session_key` 仍是 chunk 上记录的原 key。
- `malformed digest json gives digest null`；`unknown id` → `null`。

`tests/domain/read.test.ts` 追加：`sessionLinks skips deleted contributions and deleted projects`。

`tests/server/http.test.ts` 追加：
- `GET /evidence/:ref needs the user token`：不带 → 401；带 collector token → 401；带用户 token → 200。
- `GET /evidence/chunk:abc` → 400；`GET /evidence/chunk:999` → 404。
- `GET /sessions items carry linked_projects`：关联过一个项目的 session → `linked_projects` 为 `[{id, title}]`，没关联的是 `[]`。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/shared/vocab.test.ts tests/domain/evidence.test.ts tests/domain/read.test.ts tests/server/http.test.ts`
Expected: FAIL（模块不存在 / 路由 404）

- [ ] **Step 3: 实现**

`vocab.ts` 直接搬 types.ts 里的三个常量和两个类型；types.ts 写 `export { STAGES, PRIORITIES, STAGE_LABEL } from '../shared/vocab.ts'` 和 `export type { Stage, Priority } from '../shared/vocab.ts'`。`getEvidence` 用两条 SELECT（digest 一条，chunk 一条 `WHERE id IN (...)`）。`/sessions` 路由里先 `sessionLinks(db)` 一次，再 map。`/evidence/:ref` 挂 `userAuth(config)`。

- [ ] **Step 4: 运行全部测试和类型检查**

Run: `npx vitest run && npx tsc`
Expected: 全部 PASS，tsc 无输出

- [ ] **Step 5: Commit**

```bash
git add src/shared/vocab.ts src/domain/types.ts src/domain/evidence.ts src/domain/read.ts src/server/sessions-repo.ts src/server/http.ts tests/
git commit -m "feat(server): evidence endpoint, session links, shared vocab for the web UI"
```

---

### Task 2: 变化检测与 `WS /stream`，托管静态页面

**Files:**
- Create: `src/shared/stream-protocol.ts`, `src/server/change-feed.ts`, `src/server/stream.ts`, `src/server/web.ts`
- Modify: `src/server/http.ts`（`AppOptions.webDir`、调用 `mountWeb`）、`src/cli.ts`（server 命令）、`package.json`（加 `ws`、`@types/ws`）
- Test: `tests/server/change-feed.test.ts`, `tests/server/stream.test.ts`, `tests/server/web.test.ts`

**Interfaces:**
- Consumes: `OFFLINE_AFTER_MS`（sessions-repo）；`SchedulerStatus`、`disabledStatus()`（understand/status.ts）；`createApp(..., opts)`。
- Produces:
  - `src/shared/stream-protocol.ts`（无 import）：
    ```ts
    export type StreamEvent = { id: number; project_id: string | null; op: string; actor: string };
    export type StreamMessage =
      | { type: 'hello' }                                        // 每次连上后的第一条
      | { type: 'events'; events: StreamEvent[]; more: boolean } // 每条最多 STREAM_MAX_EVENTS 个，more=true 表示还有没列出的
      | { type: 'questions' } | { type: 'sessions' } | { type: 'status' };
    export const STREAM_MAX_EVENTS = 200;
    ```
  - `src/server/change-feed.ts`：
    ```ts
    export type FeedState = { eventId: number; questions: string; sessions: string; status: string };
    export function readFeedState(db: DatabaseSync, now: Date, status: SchedulerStatus): FeedState;
    export function diffFeed(db: DatabaseSync, prev: FeedState, next: FeedState): StreamMessage[];
    export class ChangeFeed {
      constructor(db: DatabaseSync, opts: { now?: () => Date; status: () => SchedulerStatus; intervalMs?: number /* 默认 1000 */ });
      subscribe(listener: (msg: StreamMessage) => void): () => void; // 第一个订阅者启动定时器（并先读一次当前状态作基线），最后一个退订时停止
      poll(): void;   // 读一次状态、算差异、通知所有订阅者；测试直接调用
      stop(): void;   // 停定时器、清空订阅者
    }
    ```
    签名的内容：
    - `eventId`：`MAX(events.id)`，空表为 0。`diffFeed` 查 `id > prev.eventId` 的前 `STREAM_MAX_EVENTS + 1` 行来决定 `more`。
    - `questions`：`COUNT(*)`、pending 的数量、`MAX(rowid)`、`MAX(resolved_at)` 拼成的字符串。
    - `sessions`：所有 session 行的 `key, live_status, lifecycle, ignored, merged_into, title, machine`（按 key 排序），加上**按 `now` 算出的离线机器集合**（`last_heartbeat` 为空或早于 `now - OFFLINE_AFTER_MS`），一起 `JSON.stringify`。
    - `status`：`JSON.stringify(status())`。
    - 消息顺序固定：events、questions、sessions、status。
    - 某个订阅者抛异常不影响其他订阅者；`poll` 内部出错只打一行 stderr，不让定时器停掉。
  - `src/server/stream.ts`：
    ```ts
    export const STREAM_PATH = '/stream';
    export const STREAM_MAX_CLIENTS = 50;
    export function attachStream(server: import('node:http').Server, feed: ChangeFeed, opts?: { pingMs?: number /* 默认 30000 */ }): { close(): void };
    ```
    在 `server.on('upgrade')` 上处理：路径不是 `/stream` → 回 `404` 并断开；有 `Origin` 头且它的 host 和请求的 `Host` 头不同 → `403`；已连满 50 个 → `503`。连上后先发 `{type:'hello'}`，再把 feed 的消息原样 `JSON.stringify` 发出去。用 `ws` 的 `WebSocketServer({ noServer: true })`；心跳用 ping/pong，上一轮没回 pong 的客户端 `terminate()`；客户端 `bufferedAmount > 1_000_000` 时也 `terminate()`。`close()` 终止所有客户端、退订 feed。客户端发来的消息一律忽略。
  - `src/server/web.ts`：`mountWeb(app: Hono, webDir: string | null): void`。`GET /` 返回 `index.html`，带 `Cache-Control: no-cache`；`GET /assets/*` 返回 `webDir/assets` 下的文件，带 `Cache-Control: public, max-age=31536000, immutable`，类型按扩展名设置（`.js` → `text/javascript`，`.css` → `text/css`，`.svg` → `image/svg+xml`，其他 → `application/octet-stream`）；解析后不在 `webDir/assets` 里的路径（`..`、编码过的 `%2e%2e`）→ 404。`webDir` 为 `null` 或里面没有 `index.html` 时，`GET /` 回 503 纯文本 `网页界面还没构建：在仓库里运行 npm run build:web`。
  - `AppOptions` 加 `webDir?: string | null`（不给就是 `null`）。
  - cli 的 server 命令：`webDir = fileURLToPath(new URL('../dist/web', import.meta.url))`；`serve()` 之后 `attachStream(server as http.Server, feed)`；停止时先 `stream.close()`、`feed.stop()`，再 `server.close()`（不然连着的 WebSocket 会让 `close` 一直等）。

- [ ] **Step 1: 装依赖**

Run: `npm install --save-exact ws@8.22.0 && npm install --save-exact -D @types/ws@8.18.2`
Expected: package.json 里出现两个精确版本

- [ ] **Step 2: 写失败的测试**

`tests/server/change-feed.test.ts`（`openDb(':memory:')`，时钟用可调的变量）
- `no change, no message`：连续两次 `readFeedState` 相同，`diffFeed` 返回 `[]`。
- `new event`：`execute()` 建一个项目后 → `[{type:'events', events:[{id, project_id, op:'create_project', actor:'user'}], more:false}]`，同时因为没建问题，不出现 `questions`。
- `more than 200 events`：插 201 条 event → `events.length === 200`、`more === true`。
- `question created and answered each emit questions`。
- `session status change emits sessions`：`applySnapshot` 把 live_status 从 idle 改成 working。
- `machine going offline emits sessions without any write`：同一个库，`now` 从心跳后 60 秒推到 181 秒 → `readFeedState` 的 `sessions` 不同，`diffFeed` 含 `{type:'sessions'}`。
- `status change emits status`。
- `subscribe starts polling and the last unsubscribe stops it`：用 `vi.useFakeTimers()`，订阅后推进 1000ms，写一条 event → 收到 events 消息；退订后再写、再推进 → 不再收到。
- `a throwing listener does not starve the others`。

`tests/server/stream.test.ts`（`serve({fetch: createApp(...).fetch, port: 0})` 起真服务，用 Node 自带的 `WebSocket` 连）
- `first message is hello`。
- `pushes feed messages`：连上后 `execute()` 一个操作，再手动 `feed.poll()` → 收到 `type:'events'`，event id 对得上。
- `rejects a foreign Origin`：`new WebSocket(url, { headers: { Origin: 'http://evil.example' } })` → 触发 `error`/`close`，从未收到消息。同 host 的 Origin 能连上。
- `rejects other paths`：连 `/nope` → 失败。
- `close() ends clients and server.close completes`。

`tests/server/web.test.ts`（临时目录写一个 `index.html` 和 `assets/app-abc.js`）
- `/` 返回 index，`Cache-Control: no-cache`。
- `/assets/app-abc.js` 返回 `text/javascript` 和 immutable 缓存头。
- `/assets/..%2f..%2fsecret` 和 `/assets/../index.html` → 404。
- `webDir` 为 null → `/` 回 503，正文含 `npm run build:web`。
- 现有 JSON 接口不受影响：`GET /projects` 仍返回 JSON。

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/server/change-feed.test.ts tests/server/stream.test.ts tests/server/web.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现上面 Interfaces 里的四个文件，并修改 http.ts 和 cli.ts**

`mountWeb` 自己用 `node:fs/promises` 读文件，并用 `path.resolve` 后检查前缀来防路径穿越（不依赖 `@hono/node-server/serve-static` 的 root 语义）。

- [ ] **Step 5: 运行全部测试和类型检查**

Run: `npx vitest run && npx tsc`
Expected: 全部 PASS

- [ ] **Step 6: 手动验证 server 命令**

Run: 用一份临时配置 `node src/cli.ts server --config <tmp>`，另开终端 `curl -s localhost:<port>/`（应回 503 和构建提示），`node -e "const w=new WebSocket('ws://127.0.0.1:<port>/stream');w.onmessage=e=>{console.log(e.data);process.exit(0)}"`（应打印 `{"type":"hello"}`），然后 Ctrl+C，确认进程在 2 秒内退出。
Expected: 三项都符合

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/shared/stream-protocol.ts src/server/change-feed.ts src/server/stream.ts src/server/web.ts src/server/http.ts src/cli.ts tests/server/
git commit -m "feat(server): change feed, WS /stream and static hosting for the web UI"
```

---

### Task 3: 前端骨架（构建、API 客户端、实时连接、外壳）

**Files:**
- Create: `web/index.html`, `web/tsconfig.json`, `vite.config.ts`, `web/src/main.tsx`, `web/src/app.tsx`, `web/src/api.ts`, `web/src/stream.ts`, `web/src/use-api.ts`, `web/src/route.ts`, `web/src/styles.css`, `web/src/components/toast.tsx`
- Modify: `package.json`（依赖和脚本）、`tsconfig.json`（排除 `tests/web`）、`vitest.config.ts`
- Test: `tests/web/api.test.ts`, `tests/web/stream.test.ts`, `tests/web/use-api.test.tsx`, `tests/web/app.test.tsx`

**Interfaces:**
- Consumes: `StreamMessage`（Task 2，`import type`）；`SchedulerStatus`（`import type`）；HTTP 接口：`GET /status`、`POST /sync`。
- Produces:
  - 构建：`package.json` 脚本 `"build:web": "vite build"`、`"dev:web": "vite"`、`"typecheck": "tsc && tsc -p web"`。`vite.config.ts`：`root: 'web'`、`build.outDir: '../dist/web'`、`emptyOutDir: true`、`plugins: [react()]`、`server.fs.allow: ['..']`、开发代理：`/projects /questions /sessions /events /evidence /status /sync` 转到 `http://127.0.0.1:8787`，`/stream` 转到 `ws://127.0.0.1:8787`（`ws: true`）。
  - `web/tsconfig.json`：`jsx: "react-jsx"`、`module: "esnext"`、`moduleResolution: "bundler"`、`lib: ["esnext","dom","dom.iterable"]`、`types: ["node"]`（因为 `import type` 了 read.ts，它引用 `node:sqlite` 的类型）、其余严格选项和根配置一致；`include: ["src", "../tests/web"]`。根 `tsconfig.json` 的 `exclude` 加 `tests/web`。
  - `vitest.config.ts`：`include` 加 `tests/**/*.test.tsx`，`plugins: [react()]`。前端测试文件第一行写 `// @vitest-environment jsdom`。
  - `web/src/api.ts`：
    ```ts
    export const TOKEN_KEY = 'herdr-pm.userToken';
    export const AUTH_EVENT = 'herdr-pm:auth';   // 401 或缺 token 时在 window 上派发
    export class ApiError extends Error { readonly status: number; readonly code: string; }  // 不用参数属性
    export function getToken(): string | null;
    export function setToken(token: string | null): void;
    export function apiGet<T>(path: string, opts?: { auth?: boolean }): Promise<T>;
    export function apiSend<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T>;
    export function sessionPath(key: string): string;   // encodeURIComponent，session key 里有冒号
    export function errorText(err: unknown): string;    // 见下表
    ```
    `apiSend` 总是带 token，没有 token 时**不发请求**，派发 `AUTH_EVENT` 并抛 `ApiError(401, 'no_token')`。响应 401 也派发 `AUTH_EVENT`。错误正文 `{error, message}` → `ApiError(status, error, message)`；正文不是 JSON → `code = 'http_<status>'`；`fetch` 本身失败 → `ApiError(0, 'network')`。
    `errorText` 的映射（其余用服务器给的 message）：

    | code | 文案 |
    |---|---|
    | `no_token` / 401 | 需要先设置 token |
    | `network` | 连不上服务器 |
    | `not_pending` | 这个问题已经处理过了 |
    | `stale` | 情况已变，这个问题已撤回 |
    | `conflict` | 和后来的改动冲突，没法撤销 |
    | `already_reverted` | 已经撤销过了 |
    | `not_revertible` | 这条记录不能撤销 |
    | `understanding_disabled` | 理解层没有开启 |
    | `too_large` | 内容太长 |

  - `web/src/stream.ts`：
    ```ts
    export type Topic = 'all' | 'projects' | `project:${string}` | 'questions' | 'sessions' | 'status';
    export type StreamState = 'connecting' | 'open' | 'closed';
    export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];  // 之后一直 10000
    export function topicsFor(msg: StreamMessage): Topic[];
    export class StreamClient {
      constructor(url: string, opts?: { WebSocketImpl?: typeof WebSocket });
      start(): void; stop(): void;
      onTopics(fn: (topics: Topic[]) => void): () => void;
      onState(fn: (state: StreamState) => void): () => void;
    }
    export function streamUrl(loc: Location): string;  // http→ws、https→wss，加 /stream
    ```
    `topicsFor`：`hello` → `['all']`；`events` → `['projects', 'questions', ...每个非空 project_id 的 'project:<id>']`，`more` 为 true 时直接 `['all']`；`questions` → `['questions','projects']`；`sessions` → `['sessions','projects']`；`status` → `['status']`。收到无法解析的消息就忽略。连上后重置重连计数。
  - `web/src/use-api.ts`：
    ```ts
    export const StreamContext: React.Context<{ subscribe(fn: (topics: Topic[]) => void): () => void }>;
    export function useApi<T>(path: string | null, topics: Topic[], opts?: { auth?: boolean }):
      { data: T | undefined; error: ApiError | null; loading: boolean; reload: () => void };
    ```
    收到的 topic 和 `topics` 有交集，或者收到 `'all'`，就重新取。重取期间保留旧数据（不闪）；只采用最后一次请求的结果（序号计数），旧响应晚到就丢掉；`path` 为 `null` 时什么都不做；`path` 变了先清空 data。
  - `web/src/route.ts`：`type Route = { page: 'home' } | { page: 'project'; id: string } | { page: 'sessions' }`；`parseHash(hash: string): Route`（`#/p/<id>` 里的 id 要 `decodeURIComponent`；不认识的都回首页）。
  - `web/src/components/toast.tsx`：`ToastProvider`、`useToast(): (text: string) => void`，4 秒后消失，文字可以选中复制。
  - `web/src/app.tsx`：`App` 组件。顶栏：标题 `herdr-pm`、导航（首页 / Session）、理解层状态、"立即同步"按钮、连接状态点、"设置 token"按钮。理解层状态的文案（来自 `GET /status` 的 `understanding`）：
    - `enabled === false` → `理解层未开启`
    - `paused_until !== null` → `整理已暂停（<pause_reason>，<HH:mm> 恢复）`（spec 5.4 的原话"整理已暂停"）
    - `running === 'digest'` → `摘要中…`；`'curate'` → `整理中…`
    - 否则 `空闲`，后面跟 `· 待摘要 <waiting_sessions> 个 session · 待整理 <uncurated_digests> 条`（数字为 0 时省略对应部分）
    - `last_error` 非空时在状态旁边显示一个 `⚠`，title 是错误内容。
    "立即同步"：`POST /sync`，202 → 提示 `已开始同步`；错误 → 提示 `errorText`。连接状态点：open 绿色 `已连接`，connecting 黄色 `重连中`，closed 红色 `已断开`。token 对话框：页面内的模态框（不用 `window.prompt`），输入框 + 保存 + 清除；收到 `AUTH_EVENT` 自动打开。页面主体按 `parseHash(location.hash)` 渲染，监听 `hashchange`。本任务里三个页面先放占位组件（`<main data-page="home">` 等），Task 5–8 替换。

- [ ] **Step 1: 装依赖**

Run: `npm install --save-exact react@19.3.1 react-dom@19.3.1 && npm install --save-exact -D vite@8.3.5 @vitejs/plugin-react@6.1.2 @types/react@19.3.0 @types/react-dom@19.3.0 jsdom@30.1.3 @testing-library/react@16.3.3 @testing-library/dom@10.4.2`
Expected: 安装成功，没有 peer 依赖报错

- [ ] **Step 2: 写失败的测试**

`tests/web/api.test.ts`
- `apiSend without a token does not fetch`：`fetch` 是 `vi.fn()`，断言没被调用，抛出 `code === 'no_token'`，`window` 上收到 `AUTH_EVENT`。
- `apiSend sends the bearer token and JSON body`。
- `401 dispatches AUTH_EVENT`；`409 {error:'stale'}` → `ApiError` 的 `status 409`、`code 'stale'`，`errorText` 为 `情况已变，这个问题已撤回`。
- `non-JSON error body` → `code 'http_502'`；`fetch rejects` → `code 'network'`，文案 `连不上服务器`。
- `getToken survives a throwing localStorage`：`vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error() })` → `null`。
- `sessionPath('claude:abc')` → `'claude%3Aabc'`。

`tests/web/stream.test.ts`（假 `WebSocket` 类，记录实例，测试里手动触发 open / message / close；`vi.useFakeTimers()`）
- `reconnects with backoff 1s 2s 4s 8s 10s 10s`：每次 close 之后检查下一次新建实例的延迟。
- `an open resets the backoff`：失败两次后连上，再断，下一次延迟回到 1000。
- `topicsFor`：五种消息各一条断言，包括 `more: true` → `['all']`，`project_id: null` 不产生 `project:` topic。
- `garbage messages are ignored`（不抛异常、不通知）。
- `streamUrl` 对 http / https 的结果。

`tests/web/use-api.test.tsx`
- `refetches when a matching topic arrives` / `ignores unrelated topics` / `'all' always refetches`。
- `keeps old data while reloading`：第二次请求挂起时 `data` 还是旧值。
- `drops a stale response`：先发的请求后返回 → 不覆盖新结果。

`tests/web/app.test.tsx`
- `shows 整理已暂停 with reason and time when paused`。
- `shows 理解层未开启 when disabled`。
- `AUTH_EVENT opens the token dialog and saving stores the token`。
- `hash routing renders the project placeholder for #/p/p_1`。

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/web`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现上面列出的文件**

`main.tsx` 创建一个 `StreamClient(streamUrl(location))`，用 `StreamContext.Provider` 把它的 `onTopics` 提供给 `useApi`，再渲染 `<ToastProvider><App/></ToastProvider>`。`index.html` 的 `<title>` 是 `herdr-pm`，favicon 用内联 SVG data URI，`<html lang="zh-CN">`，加 viewport meta。`styles.css` 用 mockup 02 的配色（背景 `#fafafa`、卡片白底 `#e3e3e3` 边框、P0 `#fde2e1/#a11`、P1 `#fff1d6/#8a5a00`、P2 `#e7eef7/#34557a`、阻塞 `#b42318`、问题框 `#fffaf0/#f0d58a`、运行中 `#2da44e`、等待 `#e5534b`、空闲 `#bbb`、强调 `#4c8bf5`），字体 `-apple-system, "PingFang SC", sans-serif`，并写好 900px 以下右栏下移的媒体查询。

- [ ] **Step 5: 运行测试、类型检查和构建**

Run: `npx vitest run && npm run typecheck && npm run build:web && ls dist/web/index.html dist/web/assets`
Expected: 全部 PASS；`dist/web/index.html` 和 `assets/` 下的 js、css 存在

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts vite.config.ts web/ tests/web/
git commit -m "feat(web): React shell, API client, live stream with reconnect"
```

---

### Task 4: 共用组件（session 标签、问题卡、证据抽屉、显示格式）

**Files:**
- Create: `web/src/format.ts`, `web/src/copy.ts`, `web/src/components/session-tag.tsx`, `web/src/components/question-card.tsx`, `web/src/components/evidence-drawer.tsx`
- Test: `tests/web/format.test.ts`, `tests/web/copy.test.ts`, `tests/web/session-tag.test.tsx`, `tests/web/question-card.test.tsx`, `tests/web/evidence-drawer.test.tsx`

**Interfaces:**
- Consumes: `apiGet` / `apiSend` / `errorText` / `useToast`（Task 3）；`import type { SessionTag, QuestionView, QuestionOptionView } from '../../src/domain/read.ts'`、`SessionView`、`EvidenceView`（Task 1）。
- Produces:
  - `web/src/format.ts`：
    - `STATUS_LABEL: Record<string, string>`：working 运行中、blocked 等你操作、idle 空闲、done 已完成、unknown 未知、offline 离线、ended 已结束、purged 已清除。
    - `statusClass(status: string): string`：working → `dot-working`，blocked → `dot-blocked`，offline → `dot-offline`（空心），其余 → `dot-idle`。
    - `OP_LABEL: Record<string, string>`：覆盖 `src/domain/ops.ts` 里的所有操作名（实现时以 `OP_SCHEMAS` 的键为准），例如 create_project 新建项目、update_project 修改项目、transition_stage 改阶段、upsert_milestone 编辑里程碑、upsert_todo 编辑 todo、record_decision 记录决策、set_blocker 设置阻塞、clear_blocker 解除阻塞、link_session 关联 session、unlink_session 取消关联、ignore_session 不追踪 session、unlock_field 解锁字段、revert_event 撤销；`opLabel(op)` 查不到时原样返回。
    - `actorLabel(actor: string): string`：`user` → `你`，`ai:curator` → `AI 整理员`，其他 `ai:x` → `AI（x）`。
    - `relTime(iso: string, now: Date): string`：<1 分钟 `刚刚`，<1 小时 `N 分钟前`，<1 天 `N 小时前`，<30 天 `N 天前`，否则 `MM/DD`。`shortTime(iso)`：本地时间 `MM/DD HH:mm`。
    - `describeOption(o: QuestionOptionView): string`：`has_op` 为 false → `不做任何操作`；否则 `opLabel(op)` 加上参数的 `key=value` 列表（值超过 40 字截断加 `…`）；有 `text_arg` 时加 `（填入 <text_arg>）`。
  - `web/src/copy.ts`：`copyText(text: string): Promise<boolean>`。安全上下文里有 `navigator.clipboard` 就用它；否则或它失败时，用隐藏 textarea + `document.execCommand('copy')`；都失败返回 `false`。
  - `SessionTag` 组件：props `{ session: Pick<SessionView, 'short_id' | 'machine' | 'agent_kind' | 'effective_status' | 'title'> }`。显示 `<machine> · <agent_kind> · ●<STATUS_LABEL> · <short_id>`，`title` 属性是 session 标题。点击 → `copyText(short_id)`；成功提示 `已复制 <short_id>`，失败提示 `复制失败，短 ID：<short_id>`。渲染成 `<button>`，键盘可用。
  - `QuestionCard` 组件：props `{ question: QuestionView; projectTitle?: string; onDone?: () => void }`。
    - choice / confirm：每个选项一个按钮，`title` 属性是 `describeOption(option)`；点击 → `POST /questions/:id/answer {option_index}`。
    - text：输入框 + `提交`；内容去掉空白后为空时按钮禁用；提交 → `{text}`。
    - 每张卡都有一个 `忽略` 链接 → `POST /questions/:id/dismiss`。
    - 有证据时显示证据小标签（`EvidenceLink`）。
    - 请求进行中所有按钮禁用；失败时在卡片里显示 `errorText`；成功后调用 `onDone`。
  - `EvidenceDrawer` / `EvidenceLink`：`EvidenceLink` props `{ evidence: string }`，渲染一个小标签按钮（`digest:3` 显示为 `摘要 #3`，`chunk:9` 显示为 `片段 #9`），点击打开 `EvidenceDrawer`（页面右侧的抽屉，`Esc` 或关闭按钮收起）。抽屉 `apiGet('/evidence/' + encodeURIComponent(ref), { auth: true })`：显示 session 标签（`session` 为 null 时显示 `session <session_key>（已清除）`）、时间范围；digest 显示摘要里的 topics / decisions / progress / blockers 列表；然后逐段显示 chunks 原文（`<pre>`，保留换行），`truncated` 的段落末尾加 `…（已截断）`。401 时显示 `需要先设置 token` 和一个打开 token 对话框的按钮（派发 `AUTH_EVENT`）。`apiGet` 在 `auth: true` 时要带 token（Task 3 的 `apiGet` 已有该选项）。

- [ ] **Step 1: 写失败的测试**

- `format.test.ts`：`relTime` 的五个区间（含边界 59 秒、60 秒）；`actorLabel` 三种；`describeOption` 的 null op、长参数截断、text_arg；`OP_LABEL` 覆盖 `OP_SCHEMAS` 的每个键（从 `src/domain/ops.ts` 导入 `OP_SCHEMAS`，这是测试，可以导入后端）。
- `copy.test.ts`：非安全上下文时走 `execCommand`（mock 返回 true）→ `true`；`execCommand` 返回 false 且没有 clipboard → `false`；安全上下文且 `writeText` 成功 → 不调用 `execCommand`。
- `session-tag.test.tsx`：显示 `gx10-090e · claude · ●运行中 · 0d67da1f`；点击后（mock `execCommand` 成功）提示 `已复制 0d67da1f`；复制失败时提示 `复制失败，短 ID：0d67da1f`；`offline` 状态用 `dot-offline` 类。
- `question-card.test.tsx`：点第二个按钮 → body `{option_index: 1}`；按钮 `title` 含操作名；text 题空白时提交按钮禁用，输入后提交 → `{text}`；`忽略` → dismiss 路径；服务器回 409 `stale` → 卡片里出现 `情况已变，这个问题已撤回`，`onDone` 没被调用；成功 → `onDone` 被调用一次。
- `evidence-drawer.test.tsx`：点 `摘要 #3` → 请求 `/evidence/digest%3A3` 且带 `Authorization`；显示 chunk 原文和 `…（已截断）`；`session: null` 时显示 `（已清除）`；401 时显示 `需要先设置 token`。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/web`
Expected: 新测试 FAIL

- [ ] **Step 3: 实现上面五个文件**

- [ ] **Step 4: 运行测试和类型检查**

Run: `npx vitest run && npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add web/src tests/web
git commit -m "feat(web): session tag with copy fallback, question card, evidence drawer"
```

---

### Task 5: 首页（项目卡片、需要你、待归属、看板）

**Files:**
- Create: `web/src/home-model.ts`, `web/src/components/project-card.tsx`, `web/src/components/kanban.tsx`, `web/src/pages/home.tsx`
- Modify: `web/src/app.tsx`（用 `HomePage` 替换占位）
- Test: `tests/web/home-model.test.ts`, `tests/web/project-card.test.tsx`, `tests/web/home.test.tsx`

**Interfaces:**
- Consumes: `useApi`、`SessionTag`、`QuestionCard`、`format.ts`；`import type { ProjectCard, QuestionView } from '../../src/domain/read.ts'`；`STAGES`、`STAGE_LABEL`（`src/shared/vocab.ts`）；`SessionListItem`（Task 1）。数据：`GET /projects`（topics `['projects']`）、`GET /questions?status=pending`（`['questions']`）、`GET /sessions`（`['sessions']`）。
- Produces（`web/src/home-model.ts`，纯函数）：
  ```ts
  export function groupProjects(cards: ProjectCard[]): { main: ProjectCard[]; inbox: ProjectCard[]; closed: ProjectCard[] };
  // closed 为 true → closed；否则 inbox 为 true → inbox；其余 → main。各组保持服务端顺序（已按优先级排好）。
  export function splitQuestions(questions: QuestionView[]): { needYou: QuestionView[]; attribution: QuestionView[] };
  // 只看 pending。session_key 非空且 project_id 为空 → attribution（待归属）；其余 → needYou。
  export function sessionsByStep(card: ProjectCard): { current: SessionTag[]; other: SessionTag[] };
  // milestone_id 等于 current_milestone.id 的进 current；其余（包括为 null、指向已删除或非当前里程碑的）进 other。
  export function isDormant(card: ProjectCard): boolean;   // !closed && dormant_days !== null
  export function kanbanColumns(cards: ProjectCard[]): Array<{ stage: Stage; label: string; cards: ProjectCard[] }>;
  // 列：idea、explore、build、verify、done、parked、abandoned（merged 不显示）；空列也保留。
  ```
- 组件：`ProjectCardView` props `{ card: ProjectCard; projectTitles: Map<string, string> }`；`Kanban` props `{ cards: ProjectCard[] }`；`HomePage` 无 props。

**卡片内容**（spec 9.1，按 mockup 02）：
- 第一行：优先级标签（`P0`–`P3`，null 显示 `未定`，样式 `.p0`–`.p3`）、标题（链接 `#/p/<id>`）、`· <STAGE_LABEL[stage]>`；里程碑有内容时加 `· 里程碑 <done>/<总数>`；有 active session 的 `effective_status === 'blocked'` 时标题旁加一个红点（title `有 agent 在等你操作`）。
- 一句话 summary（单行，超出省略）。
- 分段进度条：每个里程碑一格，依次是 done（深蓝）、doing（浅蓝）、todo（灰）。
- `▸ 当前里程碑：<title>`，后面跟 `current` 里的 session 标签；`other` 非空时另起一行 `▸ 其他推进中的 session`。
- 最多 3 条 open todo，第一条前缀 `下一步：`；多出的显示 `还有 N 条`。
- 每个 open blocker 一行红字 `⛔ <text>`。
- 每个 pending question 一张 `QuestionCard`（可以直接在卡片里回答）。
- `isDormant` 时显示 `休眠 <N> 天`，并加 `.dormant` 类（透明度 0.6）；没有 active session 时加 `· 无活跃 session`。

**页面布局**：
- 左栏标题 `项目 · 按优先级 · <main 里不休眠的个数> 个推进中 · <main 里休眠的个数> 个休眠`，右侧是 `列表 / 看板` 切换（选择存进 `localStorage` 的 `herdr-pm.homeView`，读写包 try/catch）。
- 列表视图：`main` 的卡片；然后是折叠区 `新 idea（<n>）`（默认收起，spec 第 7 节）和 `已关闭（<n>）`（默认收起，spec 9.1）。数量为 0 的折叠区不显示。
- 看板视图：`kanbanColumns(main + inbox + closed)`，每张卡只显示优先级、标题和休眠天数，可横向滚动的只有看板容器本身。
- 右栏 `需要你 · <n>`：`needYou` 里每个问题一张 `QuestionCard`，`projectTitle` 从卡片列表里查。
- 右栏 `待归属的 session · <n>`：`attribution` 里每个问题，先用 `GET /sessions` 的结果按 `session_key` 找到 session，显示 `SessionTag` 和 session 标题（找不到就显示 key），下面是 `QuestionCard`。
- 两个列表都为空时分别显示 `没有需要你决定的事` / `没有待归属的 session`。
- 首次加载中显示 `加载中…`；`/projects` 出错显示 `errorText` 和 `重试` 按钮（调用 `reload`）。

- [ ] **Step 1: 写失败的测试**

- `home-model.test.ts`：
  - `groupProjects`：closed 的 inbox 卡片进 closed 而不是 inbox；保持顺序。
  - `splitQuestions`：answered 的被丢掉；`{session_key:'claude:x', project_id:null}` 进 attribution；`{session_key:'claude:x', project_id:'p_1'}` 进 needYou。
  - `sessionsByStep`：标签的 milestone_id 指向一个不在 current 的 id（已删除的里程碑）→ 进 other；`current_milestone` 为 null 时全部进 other。
  - `isDormant`：closed 且 dormant_days = 9 → false。
  - `kanbanColumns`：7 列，顺序固定，merged 卡片不出现在任何列。
- `project-card.test.tsx`：
  - 休眠卡片显示 `休眠 9 天` 并有 `.dormant`；closed 的同数据卡片没有。
  - 有 blocked session 时出现红点；blocker 文字以 `⛔` 开头。
  - 4 条 open todo → 显示 3 条、`下一步：` 和 `还有 1 条`。
  - 标题链接是 `#/p/p_1`。
- `home.test.tsx`（mock `fetch` 按 URL 返回）：
  - inbox 有 2 个时显示 `新 idea（2）`，默认看不到它们的标题，点开后能看到。
  - needYou / attribution 分到正确的右栏标题下，attribution 显示对应 session 的短 ID。
  - 切到看板后 `localStorage` 的 `herdr-pm.homeView` 是 `kanban`；`localStorage.setItem` 抛异常时切换照样生效。
  - 收到 `questions` topic（通过测试里的 `StreamContext` 假实现触发）后，`/questions` 被重新请求。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/web`
Expected: 新测试 FAIL

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行测试、类型检查、构建**

Run: `npx vitest run && npm run typecheck && npm run build:web`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add web/src tests/web
git commit -m "feat(web): project-centric home with need-you, attribution tray and kanban"
```

---

### Task 6: 项目详情页（big picture、阶段、里程碑、todo、阻塞、决策）

**Files:**
- Create: `web/src/pages/project.tsx`, `web/src/components/editable-text.tsx`, `web/src/components/stage-control.tsx`, `web/src/components/confirm-button.tsx`, `web/src/components/items.tsx`
- Modify: `web/src/app.tsx`（用 `ProjectPage` 替换占位）
- Test: `tests/web/editable-text.test.tsx`, `tests/web/stage-control.test.tsx`, `tests/web/items.test.tsx`, `tests/web/project.test.tsx`

**Interfaces:**
- Consumes: Task 3–4 的一切；`import type { ProjectDetail, MilestoneRow, TodoRow, BlockerRow, DecisionRow } from '../../src/domain/read.ts'`。数据：`GET /projects/:id`（topics `['project:<id>']`）、`GET /questions?status=pending&project_id=<id>`（`['questions']`）、合并目标的下拉框用 `GET /projects`（`['projects']`）。写接口全部是计划 2 已有的（见 spec 第 10 节和 `src/server/domain-routes.ts`）。
- Produces:
  - `EditableText` props `{ value: string | null; locked: boolean; multiline?: boolean; placeholder?: string; onSave(value: string): Promise<void>; onUnlock?(): Promise<void> }`。点文字进入编辑；单行时 Enter 保存，多行时 Cmd/Ctrl+Enter 保存；Esc 取消；值没变就不发请求。`locked` 时文字旁显示 `🔒`（title `你改过这个字段，AI 不会再改它`）和 `解锁` 按钮（title `解锁后 AI 可以修改这个字段`）。保存失败时保持编辑状态并显示 `errorText`。
  - `StageControl` props `{ project: ProjectDetail; mergeTargets: Array<{ id: string; title: string }> }`。一个下拉框列出除当前阶段外的所有阶段（`STAGE_LABEL`）和 `确定` 按钮；选 `合并` 时出现目标项目下拉框（`mergeTargets`，排除自己），没选目标时 `确定` 禁用；提交 `POST /projects/:id/stage {stage, merge_into?}`。项目是 parked 时额外显示 `恢复到 <STAGE_LABEL[stage_before_park]>` 按钮。
  - `ConfirmButton`（`confirm-button.tsx`）props `{ label: string; confirmLabel: string; onConfirm(): Promise<void> }`：第一次点击变成 `confirmLabel`，3 秒内再点才执行（删除都用它，不用浏览器的 confirm 弹窗）。
  - `items.tsx` 导出 `MilestoneList`、`TodoList`、`BlockerList`、`DecisionList`，props 都是 `{ project: ProjectDetail; reload(): void }`。
  - `groupTodos(todos: TodoRow[], milestones: MilestoneRow[]): Array<{ milestone: MilestoneRow | null; todos: TodoRow[] }>`（导出，纯函数）：按里程碑顺序分组；`milestone_id` 为 null 或找不到对应里程碑的进最后的 `null` 组（显示为 `未分组`）；空组不返回。

**页面内容**（spec 9.2）：
- 项目不存在（404）→ `项目不存在或已删除` + `回首页` 链接。`merged_into` 非空 → 顶部横幅 `已合并到 <目标标题链接>`。
- 头部：优先级下拉框（P0–P3 和 `未定` → `PATCH {priority: null}`）、标题（`EditableText`）、阶段（`StageControl`），旁边是 `创建于 <MM/DD> · 最近活动 <relTime>`。优先级、标题锁定时同样显示 `🔒` / `解锁`。
- 本项目的 pending 问题（`QuestionCard`）。
- Big picture：`是什么`（summary）、`为什么`（why）、`做完的标准`（done_criteria），每个都是多行 `EditableText`；空值占位 `（还没有）`。保存 → `PATCH /projects/:id {<field>: value}`；解锁 → `DELETE /projects/:id/locks/<field>`。
- 里程碑：状态图标 `✓`（done）`◐`（doing）`○`（todo），点击按 todo → doing → done → todo 循环（`PATCH .../milestones/:mid {status}`）；标题 `EditableText`；item 的锁（`locks` 数组）显示 `🔒` 和解锁（`DELETE .../milestones/:mid/locks/<field>`）；`ConfirmButton` 删除；底部输入框 + `添加里程碑`。
- Todo：`groupTodos` 分组显示；勾选框按同样的循环改状态；标题可编辑；删除；添加时可以选里程碑（下拉框，默认 `未分组`）。
- 阻塞：open 的红字，带 `解除`（`PATCH .../blockers/:bid {status:'cleared'}`）和删除；种类显示 `等你` / `外部` / `技术`（user / external / technical）；已解除的收进 `已解除（n）` 折叠区；添加时选种类。
- 决策：`MM/DD 文本`，每条后面是 `EvidenceLink`（spec 9.2"每条都能点开看来源 session 和对话片段"），可删除；添加决策输入框。
- 已删除 / 已否决（`tombstones`）：底部折叠区 `已删除的条目（n）`，每条 `<label> · <MM/DD>`，说明文字 `这些是你删掉的，AI 不会再把它们加回来`。
- 时间线和事件日志的位置先放占位 `<section data-slot="timeline">` / `<section data-slot="events">`，Task 7 填上。
- 每次写入成功后调用 `reload()`（WS 也会触发，但自己写的要立刻看到）；失败用 `useToast` 提示 `errorText`。

- [ ] **Step 1: 写失败的测试**

- `editable-text.test.tsx`：点击 → 输入 → Cmd+Enter → `onSave` 收到新值；值没变 → `onSave` 不调用；Esc 恢复原值；`locked` 时出现 `🔒` 和 `解锁`，点 `解锁` 调用 `onUnlock`；`onSave` reject 时仍在编辑并显示错误。
- `stage-control.test.tsx`：选 `合并` 且没选目标 → `确定` 禁用；选了目标 → body `{stage:'merged', merge_into:'p_2'}`；parked 项目出现 `恢复到 构建`，点击 → `{stage:'build'}`；当前阶段不出现在选项里。
- `items.test.tsx`：
  - `groupTodos`：milestone_id 指向不存在的里程碑的 todo 进 `null` 组；分组顺序跟里程碑 position 一致。
  - 渲染：`未分组` 标题下能看到那条 todo（Review Focus 4）。
  - 里程碑 `○` 点击 → `PATCH /projects/p_1/milestones/m_1 {status:'doing'}`。
  - 删除：第一次点击不发请求、按钮文字变成确认文案，第二次点击 → `DELETE /projects/p_1/todos/t_1`。
  - 解除阻塞 → `PATCH .../blockers/b_1 {status:'cleared'}`。
  - 决策行里有 `摘要 #3` 证据标签。
- `project.test.tsx`：404 → `项目不存在或已删除`；merged → 横幅链接到目标项目；summary 锁定时 `是什么` 旁有 `🔒`；保存 why → `PATCH /projects/p_1 {why:'...'}`；服务端回 409 → toast 显示服务器 message。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/web`
Expected: 新测试 FAIL

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行测试、类型检查、构建**

Run: `npx vitest run && npm run typecheck && npm run build:web`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add web/src tests/web
git commit -m "feat(web): project detail with editable big picture, stage, milestones, todos, blockers, decisions"
```

---

### Task 7: Session 时间线与事件日志（含撤销）

**Files:**
- Create: `web/src/timeline.ts`, `web/src/components/timeline.tsx`, `web/src/components/event-log.tsx`
- Modify: `web/src/pages/project.tsx`（填上两个占位）
- Test: `tests/web/timeline.test.ts`, `tests/web/event-log.test.tsx`

**Interfaces:**
- Consumes: `ProjectDetail['contributions']`（每项是 `ContributionRow & { session: SessionTag | null }`）、`EventView`；`format.ts`；`EvidenceLink`；`ConfirmButton`。
- Produces:
  ```ts
  export type TimelineBar = {
    session_key: string; label: string; status: string;  // status：session 的 effective_status，session 为 null 时是 'purged'
    leftPct: number; widthPct: number;                    // 0–100，保留两位小数
    start: string; end: string;                           // ISO
  };
  export const MIN_BAR_PCT = 1;
  export function layoutTimeline(
    contributions: ProjectDetail['contributions'], createdAt: string, now: Date,
  ): { bars: TimelineBar[]; ticks: Array<{ pct: number; label: string }> };
  ```
  规则：
  - 每条贡献一条横条（同一个 session 对同一个项目只有一条贡献）。
  - 横条起点 = `ts_start ?? created_at`（贡献的 created_at）；终点 = `ts_end`，若为 null：session 的 `effective_status` 是 working / blocked / idle 时取 `now`，否则取起点。
  - 时间轴范围：起点 = 项目 `createdAt` 和所有横条起点中最早的；终点 = `now`。范围长度为 0 时每条 `leftPct 0`、`widthPct 100`。
  - `widthPct` 至少 `MIN_BAR_PCT`，且 `leftPct + widthPct ≤ 100`（太靠右时把 left 往左挪）。
  - 按起点升序，起点相同按 session_key。
  - `label`：有 session → `<machine> · <agent_kind> · <summary ?? title>`；session 为 null → `session <session_key 冒号后前 8 位>（已清除）`；`effective_status` 为 ended 时末尾加 `（已结束）`，purged 时加 `（已清除）`（不重复加）。
  - `ticks`：5 个，均匀分布在 0、25、50、75、100；label 是本地 `MM/DD`，最后一个是 `今天`。
- `Timeline` 组件 props `{ project: ProjectDetail; now: Date }`：标题 `参与过的 session · <n>`，每条横条一行，按 `statusClass` 上色（运行中绿色、空闲 / 等待浅色、已结束 / 已清除灰色），横条上显示 label（溢出省略），`title` 属性是完整 label 加 `MM/DD HH:mm – MM/DD HH:mm`；没有贡献时显示 `还没有 session 参与这个项目`。
- `EventLog` 组件 props `{ events: EventView[]; reload(): void }`：
  - 标题 `事件日志`，提示 `只显示最近 200 条`（`EVENTS_IN_DETAIL`）。默认显示 30 条，`显示更多` 每次再加 30 条。
  - 每条：`shortTime(occurred_at)`、`actorLabel(actor)`、`opLabel(op)`、entity、理由（`reason` 非空时）、证据（`EvidenceLink`）、`is_veto` 时加 `否决` 标签。
  - 撤销链（计划 2 留下的要求"页面要顺着 `reverted_by` 走"）：`reverted_by` 非空 → 显示 `已被 #<reverted_by> 撤销`，整行变淡，**没有**撤销按钮；`reverts` 非空 → 显示 `撤销了 #<reverts>`。`reverted_by` 为 null 的每条都有 `撤销` 按钮（`ConfirmButton`，确认文案 `确定撤销？`）→ `POST /events/:id/revert`。能不能撤销由服务端决定，拒绝时用 toast 显示 `errorText`（例如 `已经撤销过了`、`和后来的改动冲突，没法撤销`）。
  - `详情` 展开后用 `<pre>` 显示 `before` → `after` 的 JSON（2 空格缩进）。
  - 事件编号 `#<id>` 显示在行首，行元素 `id="event-<id>"`。`已被 #N 撤销` / `撤销了 #N` 做成按钮而不是链接（hash 已被路由占用）：点击后先把显示数量扩到包含 #N，再 `document.getElementById('event-N')?.scrollIntoView()`。

- [ ] **Step 1: 写失败的测试**

`tests/web/timeline.test.ts`
- `ongoing live session ends at now`：working session、`ts_end: null` → 横条右端是 100。
- `ended session with null ts_end is a minimum-width bar at its start`。
- `purged session (session null) gets the 已清除 label and status purged`。
- `zero-length range`：createdAt = now，没有贡献起点更早 → `leftPct 0`、`widthPct 100`。
- `bar at the far right is shifted to keep width ≥ 1 and within 100`。
- `bars sorted by start then key`；`ticks` 有 5 个，最后一个 label 是 `今天`。

`tests/web/event-log.test.tsx`
- 被撤销的事件显示 `已被 #12 撤销` 且这一行没有 `撤销` 按钮；撤销事件本身显示 `撤销了 #7`，有 `撤销` 按钮。
- 点 `撤销` 两次 → `POST /events/7/revert`，然后调用 `reload`；服务端回 409 `already_reverted` → toast `已经撤销过了`。
- 45 条事件默认显示 30 条，点 `显示更多` 显示 45 条。
- `详情` 展开后能看到 before 和 after 的 JSON 文本。
- 点 `已被 #3 撤销`（#3 在第 40 条之后）→ 显示数量扩大到包含 #3，且调用了 `scrollIntoView`（在 jsdom 里 mock 它）。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/web/timeline.test.ts tests/web/event-log.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现，并在 `project.tsx` 里接上（`now` 每 60 秒刷新一次，让进行中的横条往右长）**

- [ ] **Step 4: 运行测试、类型检查、构建**

Run: `npx vitest run && npm run typecheck && npm run build:web`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add web/src tests/web
git commit -m "feat(web): session timeline and event log with revert"
```

---

### Task 8: Session 页、演示数据、文档和端到端检查

**Files:**
- Create: `web/src/pages/sessions.tsx`, `scripts/seed-demo.ts`
- Modify: `web/src/app.tsx`（用 `SessionsPage` 替换占位）、`README.md`、`package.json`（脚本 `seed:demo`）
- Test: `tests/web/sessions.test.tsx`, `tests/server/seed-demo.test.ts`

**Interfaces:**
- Consumes: `SessionListItem`（Task 1）；`SessionTag` 组件；`apiSend`；`execute()`、`askUser()`、`applySnapshot()`、`insertChunks()`、`openDb()`（seed 脚本用）。
- Produces:
  - `SessionsPage`：顶部筛选 `全部 / 活跃 / 已结束`（对应 `GET /sessions`、`?lifecycle=live`、`?lifecycle=ended`，topics `['sessions']`）。每个 session 一行：`SessionTag`、标题、cwd（中间省略，title 属性是全路径）、`fidelity === 'screen'` 时加 `仅屏幕` 标签、已关联的项目（每个是链接 `#/p/<id>` 加一个 `×`，点 `×` 用 `ConfirmButton` 确认后 `DELETE /sessions/:key/links/:project_id`）、`关联到…` 下拉框（项目来自 `GET /projects`，选中即 `POST /sessions/:key/links {project_id}`）、`不追踪` / `恢复追踪` 按钮（`PUT /sessions/:key/ignored {ignored}`）、`last_seen` 的 `relTime`。`ignored` 的行变淡。按 machine 分组，组标题是机器名和该机器的 session 数。session key 在路径里一律用 `sessionPath()` 编码。
  - `scripts/seed-demo.ts <dbPath>`：`<dbPath>` 已存在时报错退出（不覆盖已有数据）。用 `applySnapshot` 造 2 台机器、6 个 session（working / idle / blocked / ended 各至少一个，1 个 `fidelity: 'screen'`），每个 session 插 2 个 chunk；用 `execute()` 以 `ai:curator` 和 `user` 身份造 5 个项目，覆盖：P0 构建中、带 3 个里程碑和 todo 和一个阻塞和一条决策（证据 `chunk:<id>`）；一个 AI 建的 idea（进折叠区）；一个休眠项目（用 `now` 为 10 天前的 deps 建它和它的全部内容，之后不再碰它）；一个 done；一个 parked。再用 `askUser()` 造一个 choice 题、一个 text 题和一个待归属题（session_key 非空、project_id 为空），并撤销一条 AI 事件，让事件日志里出现撤销链。时钟用固定的 `now`（脚本运行时刻），依赖注入用 `defaultDeps()` 的 `newId`，`now` 按上面说的固定或回拨。`askUser(db, deps, input, actor)` 和 `execute(db, deps, {op, args, actor, ...})` 的签名见 `src/domain/questions.ts` 与 `src/domain/execute.ts`。`package.json` 加 `"seed:demo": "node scripts/seed-demo.ts"`。
  - README 新增一节 `网页界面（计划 4）`：构建（`npm run build:web`，部署到 mac-mini 之后、重启服务之前都要跑一次）；打开 `http://<中心机器>:<port>/`；第一次写操作时输入配置里的 `userToken`（存在浏览器里）；`npm run dev:web` 开发模式（先在 8787 起服务）；`npm run seed:demo /tmp/demo.db` 生成演示库；页面通过 `WS /stream` 自动刷新，顶栏的点表示连接状态。

- [ ] **Step 1: 写失败的测试**

- `tests/web/sessions.test.tsx`：
  - 筛选 `活跃` → 请求 `/sessions?lifecycle=live`。
  - 关联下拉框选 `p_2` → `POST /sessions/claude%3Aabc/links {project_id:'p_2'}`。
  - 已关联项目的 `×` 点两次 → `DELETE /sessions/claude%3Aabc/links/p_1`。
  - ignored 的行有 `恢复追踪` 按钮，点击 → `PUT .../ignored {ignored:false}`。
  - `fidelity: 'screen'` 的行有 `仅屏幕`。
- `tests/server/seed-demo.test.ts`：在临时目录里跑 `node scripts/seed-demo.ts <tmp>/demo.db`（`child_process.execFileSync`）→ 退出码 0；用 `openDb` 打开后 `listProjects` 有 5 个，其中 1 个 `inbox`、1 个 `closed`、1 个 `dormant_days !== null`；pending 问题至少 3 个，其中至少 1 个 `session_key` 非空且 `project_id` 为空；至少一条 event 的 `reverted_by` 非空。再跑一次 → 非 0 退出，库里的数据不变。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/web/sessions.test.tsx tests/server/seed-demo.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 SessionsPage、seed 脚本、README**

- [ ] **Step 4: 运行全部测试、类型检查、构建**

Run: `npx vitest run && npm run typecheck && npm run build:web`
Expected: 全部 PASS

- [ ] **Step 5: 端到端检查（用 gstack `/browse`，不用 claude-in-chrome）**

1. `npm run seed:demo <scratch>/demo.db`，写一份临时配置（`dbPath` 指向它、`understanding.enabled: false`、随机端口），`node src/cli.ts server --config <tmp>` 在后台跑。
2. `/browse` 打开 `http://127.0.0.1:<port>/`，截图首页：项目按优先级排列，P0 卡片有进度条、session 标签、阻塞红字和内嵌问题；`新 idea（1）` 和 `已关闭（1）` 收起；右栏两块都有内容；顶栏显示 `理解层未开启` 和绿色 `已连接`。
3. 点一个 session 标签 → 出现 `已复制 …` 或 `复制失败，短 ID：…` 的提示（不能没有反应）。
4. 设置 token，在右栏回答 choice 题 → 问题消失；另开终端用 `curl` 调一个写接口（例如 `PATCH /projects/<id> {"summary":"…"}`，带 token）→ 页面在 2 秒内自动更新，不用手动刷新。
5. 进入 P0 项目详情：编辑 summary 后出现 `🔒`，点 `解锁` 后消失；时间线有横条；事件日志里能看到撤销链；点决策的证据标签，抽屉里显示对话原文。
6. 把浏览器宽度调到 390px 截图：右栏排到下面，没有横向滚动条。
7. 停掉服务 → 顶栏变成 `重连中`；重新启动 → 自动回到 `已连接`，数据刷新。
把截图路径和每一项的结果写进实施报告。任何一项不符合都要先修好再提交。

- [ ] **Step 6: Commit**

```bash
git add web/src scripts/seed-demo.ts README.md package.json tests/
git commit -m "feat(web): sessions page, demo seed script, README for the web UI"
```

---

## 计划之外、留给以后

- herdr 查找工具和侧边栏短 ID（计划 5）。
- 前几期留下、本计划不处理的领域层问题（合并项目会丢掉否决和关联、用户改过的阻塞没有锁、AI 推进自己建的 idea 后它离开折叠区、`SearchHit` 没有状态等），继续记在执行台账里。
- 首页搜索和筛选、通知（`herdr notification show`）、PWA / 离线。
