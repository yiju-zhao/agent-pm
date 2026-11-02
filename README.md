# herdr-pm

在多台机器上同时跑十几个 coding agent（Claude Code、Codex）时，herdr 能告诉你"哪个 agent 在跑、哪个在等我"。herdr-pm 补上 project 层面的视图。它的第一步（计划 1：采集地基；项目领域操作和 HTTP API 是计划 2，见「项目 API」）是把所有机器上的 agent session 和对话汇总到一个中心：

- 每台机器上跑一个**采集器**，只读本机的 herdr 快照和 Claude / Codex 的对话文件，每 10 秒把变化推送到中心。
- 一台机器（mac-mini）上跑一个**中心服务**，用 SQLite 存所有机器的 session 和对话 chunk，对外提供 HTTP API。
- 中心**不会 ssh 到任何机器**；采集器的游标只有在中心确认收到后才前进，所以断网、休眠、重启都不会丢也不会重复。

设计见 `docs/superpowers/specs/2026-10-29-project-manager-design.md`，本阶段的实施计划见 `docs/superpowers/plans/2026-10-29-01-ingestion-foundation.md`。

## 两个进程

| 进程 | 命令 | 跑在哪 | 运行方式 |
|---|---|---|---|
| 中心服务 | `herdr-pm server --config <path>` | mac-mini（一台） | `node src/cli.ts`（需要 Node >= 26，用到 `node:sqlite`） |
| 采集器 | `herdr-pm collect --config <path>` | 每台机器各一个：笔记本、mac-mini、gx10-090e、gx10-c757 | bun 编译出的单文件二进制，目标机器不需要装 node / bun |

另有一个查询命令：`herdr-pm sessions [--server <url>] [--machine <m>]`，列出中心已知的 session。

中心监听 `config.port` 的所有网卡，目的是让其他机器通过 Tailscale 访问。所有 `GET`（`/sessions*`、`/projects*`、`/questions`）目前**没有鉴权**，只靠网络隔离，所以不要把这个端口暴露到公网；`/ingest/*` 要求每台机器自己的 bearer token；项目 API 的写操作要求 `userToken`（见下文「项目 API」）。

## 已确认的环境事实

- gx10-090e 和 gx10-c757：`uname -m` 都是 `aarch64`（Linux arm64，已验证），都**没有 bun**。只有 gx10-090e 的非交互 PATH 里有 node（v22.23.3）；gx10-c757 的非交互 PATH 里 node 和 bun 都没有。因此采集器在笔记本上用 bun 交叉编译成 `bun-linux-arm64` 二进制再拷过去，不在 gx10 上装任何运行时。
- 笔记本、mac-mini：macOS arm64，使用 `bun-darwin-arm64` 二进制。
- 从笔记本直接 ssh mac-mini 曾经超时过一次（当时 herdr 的 `--machine mac-mini` 能连上），之后没有再测过；"拷贝二进制"一步用任何能通的方式即可，例如 Tailscale 上的 scp。gx10-c757 的 ssh 用户是 `bz`（`bz@100.87.40.81`），下面命令里的 `gx10-090e` / `gx10-c757` 主机名按你的 ssh 配置（别名）替换，没有别名就写 `用户@Tailscale-IP`。

## 安装

### 前提：每台机器本地装好 herdr 的 claude / codex integration

采集器靠 herdr 快照里的 `agent_session.value` 拿到 agent 的原生 session ID，而这个值**只由 herdr integration 的 hook 上报**。哪台机器没装，那台机器上的 session 全是 `pending:` 临时键、只有屏幕快照（`fidelity: screen`）；codex 还能靠进程启动时间去匹配对话文件，claude 没有任何补救办法。目前只确认笔记本和 gx10-090e 装了；mac-mini 和 gx10-c757 先检查，没装就装上。

在**每台机器本地**执行（`integration` 是本地管理命令，`herdr --machine <label> integration ...` 不会转发到远程机器，所以要 ssh 上去或在那台机器的终端里跑）：

```bash
herdr integration install claude
herdr integration install codex
herdr integration status        # claude 和 codex 都应显示已安装
```

hook 在 agent 启动时加载，所以装之前就在跑的 agent 要重启一次才会上报 ID。

### 0. 在笔记本上准备

```bash
git clone <本仓库> ~/Developer/repos/herdr-pm && cd ~/Developer/repos/herdr-pm
npm ci                                  # 需要 Node >= 26
scripts/build-collector.sh              # 生成 dist/herdr-pm-bun-darwin-arm64 和 dist/herdr-pm-bun-linux-arm64
```

`scripts/build-collector.sh [bun-darwin-arm64|bun-linux-arm64]` 可以只构建一个目标（需要先装 bun：`brew install oven-sh/bun/bun`）。`dist/` 不进 git。脚本里有两个不能删的细节，原因写在脚本注释里：必须加 `--splitting`（否则 bun 会在启动时就加载 `node:sqlite` 然后崩溃），darwin 二进制构建后要重新做 ad-hoc 签名（否则 Apple silicon 直接把进程 kill 掉，退出码 137）。

给每台机器生成一个 token（随机串即可，每台机器各自独立）：

```bash
openssl rand -hex 32   # 每台机器跑一次，记下来
```

### 1. 中心服务（mac-mini）

1. 装 Node >= 26，把仓库放到 mac-mini 上（`git clone` 后 `npm ci`；只需要运行时依赖，用 `npm ci --omit=dev` 也行）。
2. 写配置 `~/.config/herdr-pm/server.json`（从 `config/server.example.json` 复制）：

   ```json
   {
     "port": 7718,
     "dbPath": "./herdr-pm.db",
     "userToken": "<用户 token>",
     "mcpToken": "<MCP token>",
     "collectors": {
       "laptop": "<laptop 的 token>",
       "mac-mini": "<mac-mini 的 token>",
       "gx10-090e": "<gx10-090e 的 token>",
       "gx10-c757": "<gx10-c757 的 token>"
     }
   }
   ```

   - `collectors` 的 key 是机器 label，必须和该机器采集器配置里的 `machine` 完全一致，值是它的 token。
   - `dbPath` 是相对路径时，相对**配置文件所在目录**解析；不支持 `~`，要放别处就写绝对路径。
   - `userToken` 是项目 API 写操作用的 token（见下文），至少 16 个字符、不含空白、不能和任何采集器的 token 相同，否则中心启动时报错并指出原因。旧配置文件没有这一项，升级后要补上。
   - `mcpToken` 是各台机器上的 coding agent 连 `/mcp` 用的 token（见「理解层与 MCP」），规则和 `userToken` 一样，另外不能等于 `userToken`。计划 3 之前的配置文件没有这一项，升级后要补上（`openssl rand -hex 24`）。
   - `understanding` 是理解层（摘要、整理）的设置，整块可省略，见「理解层与 MCP」。示例配置里的 `oauthTokenFile` 指向配置目录下的 `claude-oauth-token`，这个文件不存在时中心启动报错；不想用 token 文件就删掉这一行。
3. 先前台跑一下确认能启动：`node src/cli.ts server --config ~/.config/herdr-pm/server.json`，看到 `listening on :7718` 后 Ctrl-C。第一次可能弹出"是否允许 node 接受传入连接"，选允许。
4. 用 launchd 常驻。plist 里的占位符要换成这台机器上的绝对路径（launchd 不展开 `~`）：

   | 占位符 | 含义 |
   |---|---|
   | `__NODE_BIN__` | node 的绝对路径，`command -v node` |
   | `__REPO_DIR__` | 仓库的绝对路径 |
   | `__CONFIG_PATH__` | 上面 `server.json` 的绝对路径 |
   | `__HOME__` | 你的家目录，`echo $HOME` |

   ```bash
   mkdir -p ~/Library/Logs/herdr-pm ~/Library/LaunchAgents
   sed -e "s|__NODE_BIN__|$(command -v node)|g" \
       -e "s|__REPO_DIR__|$HOME/Developer/repos/herdr-pm|g" \
       -e "s|__CONFIG_PATH__|$HOME/.config/herdr-pm/server.json|g" \
       -e "s|__HOME__|$HOME|g" \
       deploy/launchd/ai.herdr-pm.server.plist > ~/Library/LaunchAgents/ai.herdr-pm.server.plist
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ai.herdr-pm.server.plist
   ```

   日志在 `~/Library/Logs/herdr-pm/server.log` 和 `server.err.log`。`KeepAlive` 保证崩溃后自动拉起，`RunAtLoad` 保证登录后自动启动。停止：`launchctl bootout "gui/$(id -u)/ai.herdr-pm.server"`；改了配置后重启：`launchctl kickstart -k "gui/$(id -u)/ai.herdr-pm.server"`。

   `gui/<uid>` 域里的 LaunchAgent 只在该用户**已登录**时运行：mac-mini 重启后如果停在登录界面，中心服务和采集器都不会起来。所以在 mac-mini 上打开自动登录（系统设置 → 用户与群组 → 自动登录；开了 FileVault 时 macOS 不允许自动登录，要么关掉 FileVault，要么每次重启后手动登录一次）。另一种做法是把中心服务改成 `/Library/LaunchDaemons` 下带 `UserName` 键的 LaunchDaemon（系统域，开机即运行，不需要登录）；但采集器读的是本机 herdr，herdr 本身跑在用户会话里，所以采集器仍然需要用户登录。

### 2. 每台机器上的采集器

每台机器都要做：放二进制、写配置、常驻。

**采集器配置**（`~/.config/herdr-pm/collector.json`，从 `config/collector.example.json` 复制）：

```json
{
  "server": "http://100.111.225.68:7718",
  "machine": "laptop",
  "token": "<这台机器的 token>",
  "herdrBin": "herdr",
  "claudeDir": "~/.claude",
  "codexDir": "~/.codex",
  "stateFile": "~/.local/state/herdr-pm/collector.json",
  "pollMs": 10000
}
```

- `server` 是中心的地址，用 mac-mini 的 Tailscale IP（设计文档里记的是 `100.111.225.68`）或 MagicDNS 名；mac-mini 自己上的采集器也可以写 `http://localhost:7718`。
- `machine` 和 `token` 必须和中心 `collectors` 里这台机器的条目一致，否则中心返回 401 / 403。机器 label 会成为 `pending:<机器>:<terminal>` 键的一部分，只能用字母、数字、`.`、`_`、`-`（不能有 `:` 或空白），两边的配置在启动时都会检查。
- 只有 `server`、`machine`、`token` 是必填的，其余都有默认值（上面写出来的就是默认值）。`~` 会展开成运行采集器的用户的家目录。
- `stateFile` 是采集器的本地游标。丢了也没事：采集器会先向中心查每个 session 的最大 offset 再续读，不会产生重复 chunk。
- 中心的数据库从备份恢复（复制回旧的 `.db`）后，重启各机器的采集器即可：每个采集器进程对每个 session 的第一次推送都从"本地游标和中心最大 offset 中较小的那个"续读，备份之后丢掉的那段会重新补上，已有的不会重复。
- chunk 的 `backfill` 标记是相对**采集器进程启动时间**算的：`ts_end` 早于本次启动的 chunk 都标 `backfill: true`，所以采集器重启后补推的积压内容也会被标成 backfill。

**macOS（笔记本、mac-mini）**

```bash
# 笔记本本机
mkdir -p ~/.local/bin ~/.config/herdr-pm ~/Library/Logs/herdr-pm ~/Library/LaunchAgents
cp dist/herdr-pm-bun-darwin-arm64 ~/.local/bin/herdr-pm

# mac-mini：把同一个 dist/herdr-pm-bun-darwin-arm64 拷过去放到 ~/.local/bin/herdr-pm（scp / AirDrop / 共享目录均可）
# 如果文件是通过浏览器 / AirDrop 传来的，去掉隔离标记：xattr -d com.apple.quarantine ~/.local/bin/herdr-pm

~/.local/bin/herdr-pm sessions --server http://100.111.225.68:7718   # 先确认二进制能跑、中心能通
```

launchd 常驻（占位符：`__COLLECTOR_BIN__` = 二进制的绝对路径，`__CONFIG_PATH__` = `collector.json` 的绝对路径，`__HOME__` = 家目录）：

```bash
sed -e "s|__COLLECTOR_BIN__|$HOME/.local/bin/herdr-pm|g" \
    -e "s|__CONFIG_PATH__|$HOME/.config/herdr-pm/collector.json|g" \
    -e "s|__HOME__|$HOME|g" \
    deploy/launchd/ai.herdr-pm.collector.plist > ~/Library/LaunchAgents/ai.herdr-pm.collector.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ai.herdr-pm.collector.plist
```

launchd 起的进程 PATH 很短，plist 里已经把 `~/.local/bin`（herdr 装在这里）和 `/opt/homebrew/bin` 加进了 `PATH`；如果 herdr 在别处，把 `herdrBin` 写成绝对路径。日志在 `~/Library/Logs/herdr-pm/collector.log`、`collector.err.log`。

部署后确认采集器在 launchd 的环境里能跑 `herdr api snapshot`，而且只看到**本机**的 pane。先用和 plist 一样的最小环境手动跑一次（`env -i` 清掉交互 shell 的环境变量；`herdrBin` 写了绝对路径就用那个路径）：

```bash
env -i HOME="$HOME" USER="$USER" PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  herdr api snapshot | jq '[.result.snapshot.panes[] | {pane_id, agent, cwd}]'
```

列出的应该正好是这台机器上 herdr 里的 pane。再看 launchd 起的采集器本身：`~/Library/Logs/herdr-pm/collector.err.log` 里不应出现 `herdr api snapshot failed`，`herdr-pm sessions --server <中心> --machine <本机 label>` 列出的就是本机的 agent，没有别的机器的。

**Linux（gx10-090e、gx10-c757）**

```bash
# 在笔记本上
scp dist/herdr-pm-bun-linux-arm64 gx10-090e:~/herdr-pm                # 没有 ssh 别名就写 用户@Tailscale-IP
scp dist/herdr-pm-bun-linux-arm64 bz@100.87.40.81:~/herdr-pm          # gx10-c757
# 在 gx10 上
mkdir -p ~/.local/bin ~/.config/herdr-pm ~/.config/systemd/user
mv ~/herdr-pm ~/.local/bin/herdr-pm && chmod +x ~/.local/bin/herdr-pm
# 写 ~/.config/herdr-pm/collector.json（machine 分别是 gx10-090e / gx10-c757）
~/.local/bin/herdr-pm sessions --server http://100.111.225.68:7718   # 确认能通
```

systemd 用户服务常驻（`deploy/systemd/herdr-pm-collector.service` 里假定二进制在 `~/.local/bin/herdr-pm`、配置在 `~/.config/herdr-pm/collector.json`）：

```bash
cp deploy/systemd/herdr-pm-collector.service ~/.config/systemd/user/     # 或先 scp 到 gx10 再 cp
systemctl --user daemon-reload
systemctl --user enable --now herdr-pm-collector
loginctl enable-linger "$USER"        # 没有登录会话时也保持运行
journalctl --user -u herdr-pm-collector -f
```

同样要确认 systemd 用户服务的环境里能跑 `herdr api snapshot`、只看到本机的 pane。`systemd-run --user` 在和采集器相同的用户服务管理器里起一个临时单元，`PATH` 和 `deploy/systemd/herdr-pm-collector.service` 里的一致：

```bash
systemd-run --user --wait --pipe -p Environment=PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  herdr api snapshot | head -c 2000
journalctl --user -u herdr-pm-collector -n 20     # 不应出现 "herdr api snapshot failed"
```

快照里应该只有这台机器的 pane；`herdr-pm sessions --server <中心> --machine <本机 label>` 也应列出本机的 agent。

### 升级

改了代码后：笔记本上重新 `scripts/build-collector.sh`，把新二进制覆盖到各机器的 `~/.local/bin/herdr-pm`，然后重启服务（macOS：`launchctl kickstart -k "gui/$(id -u)/ai.herdr-pm.collector"`；Linux：`systemctl --user restart herdr-pm-collector`）。中心服务 `git pull` 后同样 `kickstart -k`；网页有改动时先 `npm run build:web`（见「网页界面（计划 4）」）。

## 验证

```bash
herdr-pm sessions --server http://100.111.225.68:7718
herdr-pm sessions --server http://100.111.225.68:7718 --machine gx10-090e
```

不带 `--server` 时默认 `http://localhost:7718`。输出是一张纯文本表：

```
短ID      机器   agent   状态     标题
5d27595b  laptop claude  working  ...
```

- **短ID**：原生 session ID 的前 8 位，冲突时自动加长。pending（还没拿到原生 ID 的）session 用 terminal ID 的前几位。
- **状态**：中心算出来的 `effective_status`，取值 `idle` / `working` / `blocked` / `done` / `unknown`（agent 自己的状态），`ended`（herdr 里已关闭），`purged`（对话文件已删），以及 **`offline`**（该机器超过 3 分钟没有心跳；这只是读取时的显示，不会把 session 判成 ended）。
- 命令连不上中心时会打印原因并以非 0 退出码结束。

表里没有 `fidelity` 和 `chunk_count`；要看这两项直接读 API：

```bash
curl -s "http://100.111.225.68:7718/sessions?machine=laptop" | jq '.[] | {short_id, agent_kind, fidelity, chunk_count}'
```

Claude session 的 `fidelity` 应为 `full`（有对话文件，`chunk_count` 随对话增长）；拿不到对话文件的 session 是 `screen`（只有屏幕快照）。

## 项目 API（计划 2）

计划 2 在中心加了项目的领域层：项目、阶段、里程碑、todo、决策、阻塞、session 关联、问题，以及对任何改动的撤销。对项目状态的修改只有一个入口 `execute()`，HTTP 只是把请求翻译成操作，每个操作写一条 event（谁、什么时候、改了什么）。

**鉴权**：所有 `GET` 开放（和 `/sessions` 一样，靠 Tailscale 隔离）；其余请求必须带 `Authorization: Bearer <userToken>`，没有或不对返回 401。采集器的 token 在这里无效，`userToken` 在 `/ingest/*` 也无效（配置里两者不能相同）。写入口不是给 coding agent 用的：同一个 Tailscale 里的 agent 一旦拿到 `userToken`，就能以"用户"身份绕过 AI 的信任边界（AI 的写入口是计划 3 的 MCP，那里的每个写操作都必须带理由和证据）。

生成 token 并写进中心配置的 `userToken`，改完重启中心：

```bash
openssl rand -hex 24      # 48 个字符，直接用作 userToken
```

| 请求 | 请求体 | 作用 |
|---|---|---|
| `GET /projects?stage=&priority=` | | 首页卡片；`stage`、`priority` 写了就必须是合法值，否则 400 |
| `GET /projects/:id` | | 项目详情（里程碑、todo、决策、阻塞、关联、事件、`tombstones`） |
| `POST /projects` | `{title, summary?, why?, done_criteria?, priority?, stage?}` | 新建项目，201 |
| `PATCH /projects/:id` | `{title?, summary?, why?, done_criteria?, priority?}` | 改字段，改过的字段自动加锁 |
| `POST /projects/:id/stage` | `{stage, merge_into?}` | 切换阶段（合并时带 `merge_into`） |
| `DELETE /projects/:id/locks/:field` | | 解锁字段 |
| `POST /projects/:id/milestones`、`PATCH …/milestones/:mid`、`DELETE …/milestones/:mid`、`DELETE …/milestones/:mid/locks/:field` | `{title, status?, position?}` | 里程碑；`status` 取 `todo`/`doing`/`done` |
| `POST /projects/:id/todos`、`PATCH …/todos/:tid`、`DELETE …/todos/:tid`、`DELETE …/todos/:tid/locks/:field` | `{title, status?, priority?, milestone_id?}` | todo |
| `POST /projects/:id/decisions`、`DELETE …/decisions/:did` | `{text, decided_at?}` | 决策 |
| `POST /projects/:id/blockers`、`PATCH …/blockers/:bid`、`DELETE …/blockers/:bid` | `{text, kind?}`；PATCH 另可带 `status: "cleared"` | 阻塞；`kind` 取 `user`/`external`/`technical` |
| `POST /sessions/:key/links`、`DELETE /sessions/:key/links/:project_id` | `{project_id, milestone_id?}` | 关联 / 取消关联 session |
| `PUT /sessions/:key/ignored` | `{ignored: true｜false}` | 不再追踪 / 恢复追踪 session |
| `POST /events/:id/revert` | | 撤销一个事件 |
| `GET /questions?status=&project_id=` | | 问题列表（`status`：`pending`/`answered`/`withdrawn`/`expired`） |
| `POST /questions/:id/answer`、`POST /questions/:id/dismiss` | `{option_index}` 或 `{text}` | 回答 / 忽略问题 |

- session 键里有冒号，放进路径前要 `encodeURIComponent`（`claude:5d27595b-…` → `claude%3A5d27595b-…`）。
- 请求体最大 64 KB，超过返回 413。请求体不是合法 JSON、有多余字段（包括 `reason`、`evidence`）、类型不对，或者违反业务规则（标题为空、枚举值不对……），返回 400。
- 成功返回操作结果 `{"status":"applied","event_id":…,"id":…,"question_ids":[],"warnings":[]}`（建东西的 `POST` 是 201，其余 200）。`event_id` 用于撤销；没有产生改动时为 `null`。失败返回 `{"error":"<code>","message":"…"}`：`invalid` 400、`not_found` 404（含"这个 todo 不属于该项目"）、其余业务冲突 409（例如 `conflict`：撤销时那个字段已被后来的改动改过，`message` 里写着是哪一列；`not_pending`：问题已经回答过）。未预料的异常返回 500 `{"error":"internal"}`，细节只写在中心的 stderr。
- `PATCH …/blockers/:bid` 同时带 `text`/`kind` 和 `status: "cleared"` 时，先改再关闭，是两个操作、两条事件。

```bash
S=http://100.111.225.68:7718
T=<userToken>
H=(-H "Authorization: Bearer $T" -H 'content-type: application/json')

# 建项目（用户建的项目不进"新点子"收件箱）
curl -s -XPOST $S/projects "${H[@]}" -d '{"title":"冒烟项目","priority":"P1"}'
# {"status":"applied","event_id":1,"id":"p_8f3a…","question_ids":[],"warnings":[]}

# 改字段（改过的字段被锁定，AI 之后只能"提议"改它）
curl -s -XPATCH $S/projects/p_8f3a… "${H[@]}" -d '{"summary":"先跑通采集，再做项目视图"}'

# 回答 AI 提的问题（0 是第一个选项，通常是"确认"）
curl -s "$S/questions?status=pending"
curl -s -XPOST $S/questions/q_1c9e…/answer "${H[@]}" -d '{"option_index":0}'

# 撤销一个事件（上面 PATCH 返回的 event_id）
curl -s -XPOST $S/events/2/revert -H "Authorization: Bearer $T"
```

## 理解层与 MCP（计划 3）

计划 3 让中心自己读对话：**摘要员**把每个 session 新增的对话片段（chunk）压成结构化摘要，**整理员**再根据摘要建项目、更新里程碑和 todo、提问题。整理员以 `ai:curator` 身份走和网页一样的操作层（`execute()` / `askUser()`），每个写操作都带理由（reason）和证据（evidence，引用的摘要和 chunk），事件日志里能看到；标完成、合并这类操作会变成待你确认的问题。外部 agent 通过 `/mcp` 只能读项目和上报进展，不能直接写。

### 模型和费用

- 摘要用 `claude-haiku-5-5`，整理用 `claude-sonnet-5-5`，可以在 `understanding.digestModel` / `understanding.curateModel` 里换。
- 调用走 Claude Agent SDK，用的是 **Claude 订阅**的额度，不是 API key（环境里的 `ANTHROPIC_API_KEY` 会被忽略），没有设额度上限。同一时刻最多一个模型调用；实时 session 先处理，历史导入（采集器第一次看到的旧对话）只在空闲时做。
- 遇到限流或额度用完，调度器暂停并指数退避，`GET /status` 里能看到暂停原因和恢复时间；没处理完的 chunk 和摘要保持"未处理"，恢复后接着做。
- 每次模型调用（成功或失败）在 `llm_runs` 表里写一行：角色（`digest` / `curate`）、模型、token 数、耗时、是否成功、错误类型。按天汇总用量：

  ```bash
  sqlite3 ~/.config/herdr-pm/herdr-pm.db "
    SELECT substr(ts, 1, 10) AS day, role, model, count(*) AS calls, sum(ok = 0) AS failed,
           sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cache_read_tokens) AS cache_read
    FROM llm_runs GROUP BY day, role, model ORDER BY day DESC, role;"
  ```

  `ts` 是 UTC 时间。`cost_usd` 是 SDK 报的按 API 价格折算的金额，走订阅时只作参考。

### 鉴权：用哪个 Claude 账号

在 mac-mini 上生成一个长期 token，写进只有自己可读的文件，配置 `understanding.oauthTokenFile` 指向它（相对路径相对配置文件所在目录）：

```bash
claude setup-token                      # 按提示登录，最后打印一个 token
install -m 600 /dev/null ~/.config/herdr-pm/claude-oauth-token
pbpaste > ~/.config/herdr-pm/claude-oauth-token   # 先复制 token；或者用编辑器粘进去
ls -l ~/.config/herdr-pm/claude-oauth-token         # 应为 -rw-------
```

```json
"understanding": { "oauthTokenFile": "claude-oauth-token" }
```

token 只放在这个文件里，**不要写进 launchd plist 或配置 JSON**。没有 `oauthTokenFile` 时，中心用这台机器上 Claude Code 自己的登录（环境变量 `CLAUDE_CODE_OAUTH_TOKEN` 也行），启动时会打印一行提示。整个理解层可以用 `"understanding": { "enabled": false }` 关掉，关掉后 `/status` 显示 `enabled: false`，`/sync` 返回 409。

### 看进度：`GET /status`、手动刷新：`POST /sync`

```bash
curl -s http://<mac-mini>:7718/status
```

`understanding` 字段：

| 字段 | 含义 |
|---|---|
| `enabled` | 理解层是否开启 |
| `running` | 正在跑的调用：`digest`、`curate` 或 `null`（空闲） |
| `paused_until`、`pause_reason` | 限流 / 额度用完时暂停到什么时候、为什么；没暂停时是 `null` |
| `last_error` | 最近一次失败的说明 |
| `waiting_sessions` | 有未摘要 chunk 的 session 数 |
| `uncurated_digests` | 还没整理的摘要数 |
| `backfill.sessions_done` / `backfill.sessions_total` | 历史导入进度（按 session 算） |
| `last_digest_at`、`last_curate_at` | 最近一次摘要 / 整理完成的时间 |

调度器平时自己跑：session 停下来（不再是 `working`）2 分钟后摘要它的新内容，一直在跑的 session 最晚 30 分钟摘要一次；`pm_report` 的上报再短也会交给模型，收到 2 分钟后摘要；摘要攒够 8 条或最早一条等满 5 分钟就整理一次。某个 session 的摘要连续失败 3 次会冷却 1 小时；同一段内容冷却两轮后每轮把窗口减半，缩到一段也还失败就跳过那一段（`last_error` 里写着 session 和 chunk id）。整理中途失败但已经写进了改动的那一批不会重跑（避免重复建项目、加 todo），错误同样记在 `last_error`。想马上处理已收到的内容：

```bash
curl -s -XPOST http://<mac-mini>:7718/sync -H "Authorization: Bearer <userToken>"   # 202 {"accepted":true}
```

`/sync` 只立即跑摘要和整理，不会让采集器马上采集（中心没有到采集器的命令通道），所以最新的几秒对话要等采集器下一轮推上来。

### 各台机器上的 agent 接入 MCP

中心在 `http://<mac-mini>:7718/mcp` 提供 MCP（Streamable HTTP，无状态）。工具：`pm_list_projects`、`pm_get_project`、`pm_get_brief`、`pm_timeline`、`pm_search`、`pm_list_sessions`（只读）和 `pm_report`（上报进展：内容存成一段对话片段，下一轮整理时由整理员处理，不会直接改项目）。没有写工具。

每个请求必须带 `Authorization: Bearer <mcpToken>`，否则 401；请求体最大 64 KB，超过返回 413；`userToken` 和采集器的 token 在这里无效，`mcpToken` 在别处也无效。`mcpToken` 会放在每台跑 agent 的机器上，泄露后的影响只是能读项目和上报。

**Claude Code**（每台机器跑一次；默认只对当前目录的项目生效，加 `--scope user` 对这台机器上的所有项目生效）：

```bash
claude mcp add --transport http herdr-pm http://<mac-mini>:7718/mcp --header "Authorization: Bearer <mcpToken>"
claude mcp list        # herdr-pm 应显示 connected
```

**Codex**（`~/.codex/config.toml`，按 Codex 的 MCP 文档；Codex 从环境变量读 bearer token，`codex mcp add` 没有传 token 的参数）：

```toml
[mcp_servers.herdr-pm]
url = "http://<mac-mini>:7718/mcp"
bearer_token_env_var = "HERDR_PM_MCP_TOKEN"
```

再在启动 Codex 的 shell 里 `export HERDR_PM_MCP_TOKEN=<mcpToken>`（例如写进 `~/.zshrc` / `~/.bashrc`）。

手工检查端点（不用任何 agent）：

```bash
curl -s http://<mac-mini>:7718/mcp -H "Authorization: Bearer <mcpToken>" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 网页界面（计划 4）

中心服务在 `/` 托管一个网页：首页按优先级列出项目（卡片上有进度条、在跑的 session、阻塞和待你回答的问题），右栏是"需要你"和"待归属的 session"；点项目进详情页（改字段、里程碑、todo、阻塞、决策、时间线、事件日志，改过的字段会被锁定，AI 之后只能提议）；`Session` 页按机器列出全部 session，可以关联到项目、取消关联、不追踪。页面里 AI 写的文字一律按纯文本显示。

**构建**：网页是 `web/` 下的 React + Vite 项目，要先构建，服务才有页面可托管（没构建时 `/` 会提示怎么构建）：

```bash
npm ci
npm run build:web      # 写到 dist/web，已在 .gitignore 里
```

部署到 mac-mini 之后、重启服务之前都要跑一次 `npm run build:web`（`git pull` 带来了网页的改动，`dist/web` 才会更新；只重启不构建，用户看到的还是旧页面）。构建完再 `launchctl kickstart -k "gui/$(id -u)/ai.herdr-pm.server"`。

**使用**：

- 浏览器打开 `http://<中心机器>:<port>/`（`<port>` 是配置里的 `port`，通过 Tailscale 访问就是 `http://<mac-mini 的 Tailscale 名或 IP>:<port>/`）。读页面不需要 token。
- 第一次做写操作（改字段、回答问题、关联 session……）时页面会弹出输入框，填配置里的 `userToken`；它存在这个浏览器的 `localStorage` 里（`herdr-pm.userToken`），不会发给别的地方。也可以随时点顶栏的"设置 token"换掉或清除。token 填错了（服务返回 401），页面会再弹出输入框。
- 页面通过 `WS /stream` 自动刷新：服务只推"哪里变了"的信号，页面收到后重新读对应的接口，所以别的地方（curator、`curl`、另一个浏览器）做的改动几秒内就会出现在页面上，不用手动刷新。顶栏的点表示这条连接的状态：绿色 `已连接`，黄色 `重连中`（服务重启或网络断了，会按 1、2、4、8、10 秒的间隔自动重连，连上后把所有数据重新读一遍）。
- 页面是用 `http://` 打开的（Tailscale 下没有 HTTPS），浏览器不开放剪贴板接口时，点 session 标签复制短 ID 会退回到旧的复制方式；两种都不行时，提示条里会直接显示短 ID，手动选中复制。
- 宽度小于 900px（手机）时右栏排到主列表下面，页面不会出现横向滚动。

**开发**：

```bash
node src/cli.ts server --config config/server.local.json   # 先起一个监听 8787 的服务（配置里 "port": 8787）
npm run dev:web                                            # Vite 开发服务器，热更新；API 和 /stream 转发到 127.0.0.1:8787
```

**演示数据**：想不接任何采集器和模型就看看页面，用 `seed:demo` 生成一个演示库（`<dbPath>` 已存在时报错退出，不会覆盖已有数据）：

```bash
npm run seed:demo /tmp/demo.db
# 再写一份配置：{"port": 8787, "dbPath": "/tmp/demo.db", "userToken": "<至少 16 个字符>", "mcpToken": "<另一个至少 16 个字符>",
#                "collectors": {}, "understanding": {"enabled": false}}
node src/cli.ts server --config /tmp/demo-server.json
```

演示库里有 5 个项目（P0 构建中、AI 建的新 idea、休眠中、已完成、已搁置）、6 个 session（2 台机器，运行中 / 空闲 / 等你操作 / 已结束都有，其中 1 个只有屏幕）、3 个待回答的问题，以及一条被你撤销的 AI 改动。其中的 session 是静态数据，没有采集器在跟，3 分钟后会显示为离线。

## 在 herdr 里按短 ID 打开（计划 5）

`herdr-pm sessions`、网页和 herdr 侧边栏里看到的都是 8 位短 ID。`herdr-pm open <短ID>` 把它变成一个动作：本机的 agent 直接切过去，其他机器上的 agent 在当前终端里 attach 上去。

查找**不依赖中心服务**（mac-mini 没开也能用）：它向本机 herdr 和 `herdr machine list` 里每台已启用的机器各问一次 `agent list`，所有机器同时问，每台最多等 8 秒，所以某台机器关机或网络不通只会多等 8 秒，并提示 `连不上：<机器>（<原因>）`，其他机器上的 agent 照样找得到。中心只在**一个都没找到**时用来补一句说明（"这个 session 已结束""那台机器的采集器离线"），连不上中心就直接说没找到。

**命令行**：

```bash
herdr-pm open 0d67da1f                  # 找到并打开
herdr-pm open                           # 在终端里不带参数：会问"短 ID："
herdr-pm open 0d67da1f --dry-run        # 只打印"将执行：…"，什么都不动，用来排查
herdr-pm open 0d67da1f --remote inline  # 远程 agent 就在当前终端里 attach，不分屏
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `<短ID>` | 交互时询问 | 粘贴也行：前后的空白、换行、引号会去掉，大写会转成小写，整串 key（`claude:0d67da1f-…`）会取冒号后面的部分 |
| `--remote split\|inline` | `split` | 远程 agent 的打开方式，见下。不在 herdr 里运行（环境变量 `HERDR_ENV` 不是 `1`）时一律 `inline` |
| `--server <url>` | `$HERDR_PM_SERVER`，再默认 `http://localhost:7718` | 只用于一个都没找到时向中心要说明 |
| `--herdr <path>` | `herdr` | herdr 可执行文件 |
| `--dry-run` | | 只打印计划，不执行 |

短 ID 匹配到多个 pane（同一个 session 在两处 resume，或者粘贴得太短）时，列出候选 `[1] 机器 · agent · 状态 · 标题 · pane`：在终端里输入编号选一个，回车取消；非交互（比如管道里）只列出来并退出 1，绝不随便打开一个。在终端里运行时，失败的结果（没找到 / 取消 / 出错）会先等你按回车再退出，免得弹窗一闪就没。

退出码：`0` 已打开（`inline` 时是 ssh 的退出码）；`1` 没找到、有歧义、取消或打开失败；`2` 用法错误（短 ID 格式不对、选项不对、非交互又没给短 ID）。输出都是中文。

**安装**：`open` 是同一个 `herdr-pm` 二进制里的一个命令（`scripts/build-collector.sh` 打出来的那个，见「2. 每台机器上的采集器」），只需要放在你**按快捷键的那台机器**上（一般是笔记本）。升级到带 `open` 的版本后，重新构建并覆盖 `~/.local/bin/herdr-pm`；被 attach 的远程机器上不用装它，只要有 herdr。

**快捷键**：herdr 的 `[[keys.command]]` 支持 `type = "popup"`（弹出一个会话内的终端），所以直接弹出终端运行 `herdr-pm open`，不用写插件。写进 `~/.config/herdr/config.toml`，然后 `herdr server reload-config`：

```toml
[[keys.command]]
key = "prefix+g"
type = "popup"
command = "/Users/<你>/.local/bin/herdr-pm open"
width = "80%"
height = "60%"
description = "herdr-pm: 按短 ID 打开 agent"
```

按 `prefix+g`，弹窗里输入（或粘贴）短 ID，回车。

**侧边栏显示**：采集器把每个 session 的短 ID 和所属项目写到本机 herdr 的 pane 元数据里（`$pm_sid`、`$pm`；内容有变化时写，每 5 分钟刷新一次）。在 `~/.config/herdr/config.toml` 的 `[ui.sidebar.agents]` 里把它们加进 `rows` 才会显示，例如：

```toml
[ui.sidebar.agents]
rows = [["state_icon", "machine", "workspace", "tab"], ["agent", "$pm_sid", "$pm"]]
```

不想写侧边栏就在采集器配置里加 `"sidebar": false`。写入失败（herdr 版本旧、pane 刚关、中心是旧版本）不影响采集，同一个错误只记一次日志。

**远程 agent 的两种打开方式**：

- `split`（默认，在 herdr 里时）：在当前获得焦点的 pane 右边分出一个新 pane（`herdr pane split <焦点 pane> --direction right --focus`），在里面运行 `ssh -t <机器> …attach`，attach 结束新 pane 自动关闭。远程机器上非交互 ssh 的 `PATH` 里没有 herdr，所以远程命令自己找：`h=$(command -v herdr || echo "$HOME/.local/bin/herdr"); exec "$h" agent attach <pane>`。退出 attach 按 `ctrl+b q`。
- `inline`：就在当前终端（或弹窗）里运行同一条 ssh，退出码用 ssh 的。不在 herdr 里、或者找不到有焦点的 pane 时自动用它。

拼进 shell 命令的 pane ID 和 ssh 地址先用白名单校验（pane ID `[A-Za-z0-9:_-]`，ssh 地址 `[A-Za-z0-9@._-]`），不合格直接拒绝，不做转义。

**手动检查结论（Task 5 填写）**：

> TODO（Task 5，真实环境手动检查后由使用者填写）：弹窗里 `HERDR_ENV` 是否为 `1`；本机 agent 的 focus 在弹窗关闭后是否停在目标 pane；herdr 正切到远程机器（TUI 在看远程）时 `split` 的表现；`split` 和 `inline` 各自适合的场景，以及最终推荐的默认值。

## 部署验收（计划 1 完成的标志）

- [ ] 四台机器上本地执行 `herdr integration status`，claude 和 codex integration 都已安装。
- [ ] mac-mini 上用 launchd 跑中心服务；笔记本、mac-mini、gx10-090e、gx10-c757 各跑一个采集器。
- [ ] `herdr-pm sessions --server http://<mac-mini 的 Tailscale IP>:7718` 列出四台机器上的全部活跃 session。
- [ ] 让笔记本休眠超过 3 分钟：它的 session 显示 `offline`；唤醒后恢复 `live` 状态（`working` / `idle` 等），chunk 继续增长，没有重复。
- [ ] 在 herdr 里关掉一个 agent：下一轮（约 10 秒）它的状态变成 `ended`。

## 开发

```bash
npm ci
npx vitest run     # 测试
npx tsc            # 类型检查（不产出文件）
```

Node 26 直接运行 `.ts`：`node src/cli.ts <command> ...`；`npm link` 之后 `herdr-pm` 命令可直接用（`package.json` 的 `bin` 指向 `src/cli.ts`）。本地配置写成 `config/*.local.json`（已在 `.gitignore` 里）。

`src/cli.ts` 只在 `server` 命令里动态 `import()` 服务端模块（`node:sqlite`、hono）：采集器二进制是 bun 编译的，bun 没有 `node:sqlite`，所以 `collect`、`sessions` 和 `open` 路径不能加载它们（`open` 的代码在 `src/lookup/`，只能 import node 内置模块、`src/shared/` 和 zod）。
