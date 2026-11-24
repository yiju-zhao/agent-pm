# agent-pm

在多台机器上同时跑十几个 coding agent（Claude Code、Codex）时，herdr 能告诉你"哪个 agent 在跑、哪个在等我"。agent-pm 补上 project 层面的视图。它的第一步（计划 1：采集地基；项目领域操作和 HTTP API 是计划 2，见「项目 API」）是把所有机器上的 agent session 和对话汇总到一个中心：

- 每台机器上跑一个**采集器**，只读本机的 herdr 快照和 Claude / Codex 的对话文件，每 10 秒把变化推送到中心。
- 一台机器（mac-mini）上跑一个**中心服务**，用 SQLite 存所有机器的 session 和对话 chunk，对外提供 HTTP API。
- 中心**不会 ssh 到任何机器**；采集器的游标只有在中心确认收到后才前进，所以断网、休眠、重启都不会丢也不会重复。

设计见 `docs/superpowers/specs/2026-10-29-project-manager-design.md`，本阶段的实施计划见 `docs/superpowers/plans/2026-10-29-01-ingestion-foundation.md`。

## 名字

产品名是 **agent-pm**（原名 herdr-pm）：命令 `agent-pm`、MCP 服务名 `agent-pm`、skill `agent-pm`、launchd 标签 `ai.agent-pm.*`、日志目录 `~/Library/Logs/agent-pm`。为了不打断已部署的机器，这些保留旧名：

- 命令 `herdr-pm` 仍可用（`package.json` 的 bin 两个名字都有；各机器上已装的 `~/.local/bin/herdr-pm` 二进制照常运行）。
- 数据和配置路径：`~/.config/herdr-pm/`、`~/.local/state/herdr-pm/`、`herdr-pm.db`。
- 浏览器里保存 key 和视图用的存储名；herdr 侧边栏的 metadata source `herdr-pm`。
- 环境变量 `HERDR_PM_SERVER` 仍认（新名 `AGENT_PM_SERVER`）。
- 已经用 `herdr-pm` 这个名字注册的 MCP 服务照常能用（名字只是本机的标签）；重新注册时用 `agent-pm`。

## 两个进程

| 进程 | 命令 | 跑在哪 | 运行方式 |
|---|---|---|---|
| 中心服务 | `agent-pm server --config <path>` | mac-mini（一台） | `node src/cli.ts`（需要 Node >= 26，用到 `node:sqlite`） |
| 采集器 | `agent-pm collect --config <path>` | 每台机器各一个：笔记本、mac-mini、gx10-090e、gx10-c757 | bun 编译出的单文件二进制，目标机器不需要装 node / bun |
| Paseo 采集器 | `agent-pm collect-paseo --config <path>` | 每个 Paseo daemon 一个（可与 daemon 同机或远程连接） | `node src/cli.ts`（Node 26，从仓库运行），见「Paseo 采集器（计划 6）」 |

另有一个查询命令：`agent-pm sessions [--server <url>] [--machine <m>]`，列出中心已知的 session。

中心监听 `config.port` 的所有网卡，目的是让其他机器通过 Tailscale 访问。所有 `GET`（`/sessions*`、`/projects*`、`/questions`）目前**没有鉴权**，只靠网络隔离，所以不要把这个端口暴露到公网；`/ingest/*` 要求每台机器自己的 bearer token；项目 API 的写操作要求管理员浏览器会话或兼容客户端的 `userToken`（见下文「项目 API」）。

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
git clone <本仓库> ~/Developer/repos/agent-pm && cd ~/Developer/repos/agent-pm
npm ci                                  # 需要 Node >= 26
scripts/build-collector.sh              # 生成 dist/agent-pm-bun-darwin-arm64 和 dist/agent-pm-bun-linux-arm64
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
   mkdir -p ~/Library/Logs/agent-pm ~/Library/LaunchAgents
   sed -e "s|__NODE_BIN__|$(command -v node)|g" \
       -e "s|__REPO_DIR__|$HOME/Developer/repos/agent-pm|g" \
       -e "s|__CONFIG_PATH__|$HOME/.config/herdr-pm/server.json|g" \
       -e "s|__HOME__|$HOME|g" \
       deploy/launchd/ai.agent-pm.server.plist > ~/Library/LaunchAgents/ai.agent-pm.server.plist
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ai.agent-pm.server.plist
   ```

   日志在 `~/Library/Logs/agent-pm/server.log` 和 `server.err.log`。`KeepAlive` 保证崩溃后自动拉起，`RunAtLoad` 保证登录后自动启动。停止：`launchctl bootout "gui/$(id -u)/ai.agent-pm.server"`；改了配置后重启：`launchctl kickstart -k "gui/$(id -u)/ai.agent-pm.server"`。

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
mkdir -p ~/.local/bin ~/.config/herdr-pm ~/Library/Logs/agent-pm ~/Library/LaunchAgents
cp dist/agent-pm-bun-darwin-arm64 ~/.local/bin/agent-pm

# mac-mini：把同一个 dist/agent-pm-bun-darwin-arm64 拷过去放到 ~/.local/bin/agent-pm（scp / AirDrop / 共享目录均可）
# 如果文件是通过浏览器 / AirDrop 传来的，去掉隔离标记：xattr -d com.apple.quarantine ~/.local/bin/agent-pm

~/.local/bin/agent-pm sessions --server http://100.111.225.68:7718   # 先确认二进制能跑、中心能通
```

launchd 常驻（占位符：`__COLLECTOR_BIN__` = 二进制的绝对路径，`__CONFIG_PATH__` = `collector.json` 的绝对路径，`__HOME__` = 家目录）：

```bash
sed -e "s|__COLLECTOR_BIN__|$HOME/.local/bin/agent-pm|g" \
    -e "s|__CONFIG_PATH__|$HOME/.config/herdr-pm/collector.json|g" \
    -e "s|__HOME__|$HOME|g" \
    deploy/launchd/ai.agent-pm.collector.plist > ~/Library/LaunchAgents/ai.agent-pm.collector.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ai.agent-pm.collector.plist
```

launchd 起的进程 PATH 很短，plist 里已经把 `~/.local/bin`（herdr 装在这里）和 `/opt/homebrew/bin` 加进了 `PATH`；如果 herdr 在别处，把 `herdrBin` 写成绝对路径。日志在 `~/Library/Logs/agent-pm/collector.log`、`collector.err.log`。

部署后确认采集器在 launchd 的环境里能跑 `herdr api snapshot`，而且只看到**本机**的 pane。先用和 plist 一样的最小环境手动跑一次（`env -i` 清掉交互 shell 的环境变量；`herdrBin` 写了绝对路径就用那个路径）：

```bash
env -i HOME="$HOME" USER="$USER" PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  herdr api snapshot | jq '[.result.snapshot.panes[] | {pane_id, agent, cwd}]'
```

列出的应该正好是这台机器上 herdr 里的 pane。再看 launchd 起的采集器本身：`~/Library/Logs/agent-pm/collector.err.log` 里不应出现 `herdr api snapshot failed`，`agent-pm sessions --server <中心> --machine <本机 label>` 列出的就是本机的 agent，没有别的机器的。

**Linux（gx10-090e、gx10-c757）**

```bash
# 在笔记本上
scp dist/agent-pm-bun-linux-arm64 gx10-090e:~/agent-pm                # 没有 ssh 别名就写 用户@Tailscale-IP
scp dist/agent-pm-bun-linux-arm64 bz@100.87.40.81:~/agent-pm          # gx10-c757
# 在 gx10 上
mkdir -p ~/.local/bin ~/.config/herdr-pm ~/.config/systemd/user
mv ~/agent-pm ~/.local/bin/agent-pm && chmod +x ~/.local/bin/agent-pm
# 写 ~/.config/herdr-pm/collector.json（machine 分别是 gx10-090e / gx10-c757）
~/.local/bin/agent-pm sessions --server http://100.111.225.68:7718   # 确认能通
```

systemd 用户服务常驻（`deploy/systemd/agent-pm-collector.service` 里假定二进制在 `~/.local/bin/agent-pm`、配置在 `~/.config/herdr-pm/collector.json`）：

```bash
cp deploy/systemd/agent-pm-collector.service ~/.config/systemd/user/     # 或先 scp 到 gx10 再 cp
systemctl --user daemon-reload
systemctl --user enable --now agent-pm-collector
loginctl enable-linger "$USER"        # 没有登录会话时也保持运行
journalctl --user -u agent-pm-collector -f
```

同样要确认 systemd 用户服务的环境里能跑 `herdr api snapshot`、只看到本机的 pane。`systemd-run --user` 在和采集器相同的用户服务管理器里起一个临时单元，`PATH` 和 `deploy/systemd/agent-pm-collector.service` 里的一致：

```bash
systemd-run --user --wait --pipe -p Environment=PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  herdr api snapshot | head -c 2000
journalctl --user -u agent-pm-collector -n 20     # 不应出现 "herdr api snapshot failed"
```

快照里应该只有这台机器的 pane；`agent-pm sessions --server <中心> --machine <本机 label>` 也应列出本机的 agent。

### 升级

改了代码后：笔记本上重新 `scripts/build-collector.sh`，把新二进制覆盖到各机器的 `~/.local/bin/agent-pm`，然后重启服务（macOS：`launchctl kickstart -k "gui/$(id -u)/ai.agent-pm.collector"`；Linux：`systemctl --user restart agent-pm-collector`）。中心服务 `git pull` 后同样 `kickstart -k`；网页有改动时先 `npm run build:web`（见「网页界面（计划 4）」）。

## 验证

```bash
agent-pm sessions --server http://100.111.225.68:7718
agent-pm sessions --server http://100.111.225.68:7718 --machine gx10-090e
```

不带 `--server` 时默认 `http://localhost:7718`。输出是一张纯文本表：

```
短ID      机器   agent   状态     标题
5d27595b  laptop claude  working  ...
```

- **短ID**：原生 session ID 的前 8 位，冲突时自动加长。pending（还没拿到原生 ID 的）session 用 terminal ID 的前几位。
- **状态**：中心算出来的 `effective_status`，取值 `idle` / `working` / `blocked` / `done` / `unknown`（agent 自己的状态），`ended`（所有来源都已结束它：herdr 里已关闭、Paseo 里已归档或关闭），`purged`（对话文件已删），以及 **`offline`**（看到它的来源都不新鲜：采集器超过 3 分钟没有心跳，或 Paseo daemon 断开；这只是读取时的显示，不会把 session 判成 ended）。多个来源同时看到时，取新鲜来源里最「活跃」的状态（working > blocked > done > idle > unknown）。
- 命令连不上中心时会打印原因并以非 0 退出码结束。

表里没有 `fidelity` 和 `chunk_count`；要看这两项直接读 API：

```bash
curl -s "http://100.111.225.68:7718/sessions?machine=laptop" | jq '.[] | {short_id, agent_kind, fidelity, chunk_count}'
```

Claude session 的 `fidelity` 应为 `full`（有对话文件，`chunk_count` 随对话增长）；拿不到对话文件的 session 是 `screen`（只有屏幕快照）。

## 项目 API（计划 2）

计划 2 在中心加了项目的领域层：项目、阶段、里程碑、todo、决策、阻塞、session 关联、问题，以及对任何改动的撤销。对项目状态的修改只有一个入口 `execute()`，HTTP 只是把请求翻译成操作，每个操作写一条 event（谁、什么时候、改了什么）。

**鉴权**：所有 `GET` 开放（和 `/sessions` 一样，靠 Tailscale 隔离）；其余请求需要管理员浏览器会话，或兼容客户端的 `Authorization: Bearer <userToken>`，没有或不对返回 401。采集器的 token 在这里无效，`userToken` 在 `/ingest/*` 也无效（配置里两者不能相同）。写入口不是给 coding agent 用的：同一个 Tailscale 里的 agent 一旦拿到 `userToken`，就能以"用户"身份绕过 AI 的信任边界（AI 的写入口是计划 3 的 MCP，那里的每个写操作都必须带理由和证据）。

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
| `POST /projects/:id/stage` | `{stage, merge_into?}` | 切换阶段（带 `merge_into` 时直接合并；网页走下面的合并预览） |
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

### 项目命名与需要你决定的事

**项目名**：项目是相对长期、完整的工作，标题以 session 所在的 Paseo 项目名（即仓库名）为准；只在 herdr 里看到的 session 用它的工作目录名（`repos`、`Developer` 这类容器目录不算）。整理员新建项目时，标题不以该名字开头、或看板上已有同名项目，会被拒绝，除非它说明这是一个可独立验收的新目标（理由记进事件）。合并预览默认沿用目标项目原标题，改名必须给出原因并显示在预览里。Paseo 采集器 0.3.0 起随观察上报项目名（旧采集器不报，中心照常工作）。

**提问**：整理员只在四类情况下问你——用户才能做的决定、你自己的指示互相矛盾、有风险或不可逆、对话里没有的事实。session 属于哪个项目、要不要新建项目由它自己决定，这类问题会被拒绝。每个问题写清发生了什么、问题本身、AI 的建议和理由；能问是/否就问是/否，多选最多 4 项且每项说明后果，填写文字只用于缺事实。Inbox 里按是/否、选择、文字的顺序排列。

**自动决定**：缺事实类的问题（以及旧的、只涉及归属的问题）先交给决定器按所引用的证据判断，置信度 ≥ 0.8 且选项是 AI 可以直接执行的操作时就自动执行（操作者 `ai:decider`，事件可撤销），记录在 Inbox 的「AI 已自动决定」里；否则留给你。每个问题只判断一次。决定器默认用整理员的模型；在 `understanding.jevKeyFile` 指向一个 TypeSafe API key 文件时改用 TypeSafe 的 Jev（会把问题、选项和引用的证据发送给 TypeSafe），可用 `TYPESAFE_BASE_URL`、`TYPESAFE_DEFAULT_MODEL` 调整。

**同一个项目的建议**：Inbox 的「可能是同一个项目」按 session 主要所在的 Paseo 项目分组，每组一个是/否问题。选「是」先看会发生什么（新建或沿用以该名字命名的项目，把勾选的项目整体并入），确认后才执行；之后整理员按所有 session 的内容重写这个项目。

### 合并项目：先预览，确认后才生效

合并有两种范围，都只动「session 与项目的关联」，不动会话原文、证据、历史事件，也不动该 session 与其他项目的关联：

- **整个项目**：来源项目的全部 session 关联到目标项目（目标已有的不重复添加），来源项目标记为「合并」并保留原记录。
- **选中的 session**：这些 session 的关联移到目标项目；来源项目保留、阶段不变，未选中的 session 仍在来源项目。

| 接口 | 请求体 | 作用 |
| --- | --- | --- |
| `POST /projects/:id/merge-previews` | `{target, sessions?}` | 开始生成把 `:id`（或其中 `sessions`）并入 `target` 的预览，立即返回 `202` 和预览 id |
| `GET /merge-previews/:id` | | 预览：状态（`generating` / `ready` / `failed` / `applied`）、项目草稿、关联变化、证据范围、是否已过期 |
| `POST /merge-previews/:id/apply` | `{overwrite_locked?}` | 应用这份预览（不再调用模型） |

预览做什么、不做什么：

- 草稿（标题、简介、为什么、完成标准、未知事项）由整理员模型根据**目标项目已有 session 加上本次并入 session 的已存正文**重写，不是拼接两个项目的旧文字，也不经过摘要；旧项目记录只作参考，部分合并时来源项目的旧记录和未选 session 的内容不会交给模型。每个字段带所依据的 chunk id，引用了没给过的 chunk 的草稿直接作废。
- 内容多时按 10 万字符一段先逐段提取事实再汇总；超过 24 段时每个 session 保留开头和最近的若干段，跳过的部分在「证据范围」里写明。预览跳过被忽略的 session 和被模型拒绝的片段，并列出缺口；同一 session 的其余证据仍可读取。
- 这里的「正文」是中心保存的归一化内容，不是 agent 机器上的原始 transcript：采集时被截断的消息、Paseo 较长事件的节选都会按 session 计数显示。
- 生成预览不改任何项目、关联或阶段。确认时在一个事务里写入预览中的确切内容：关联的迁移和去重由代码按规则执行，不由模型决定；你锁定过的字段默认保留，逐个勾选才会被草稿替换；写入的字段随即锁定。
- 预览记录了生成时的输入（两个项目的文字、阶段、锁，双方全部关联，相关 session 的内容量、忽略和拒绝状态）。其中任何一项之后变了，预览即过期，确认会被拒绝（`409 stale`），需要重新生成。模型失败、输出不合格、生成期间输入变化都只留下一条失败的预览。
- 整个合并是一条事件（`apply_merge`），在事件日志里一次撤销即可恢复关联、来源阶段和目标文字。
- 仍可用 `POST /projects/:id/stage` 带 `merge_into` 直接合并（不重写文字）；这条路径现在也在同一事件里把来源的 session 关联到目标。

确认之后，目标项目（部分合并时还有来源项目）照常进入下面的整体整理，由整理员按新的 session 范围重整里程碑和 todo；它要改你锁定的字段时仍然先问你。

### 合并、关联后的项目整体整理

管理员合并项目或改变 session 关联后，领域操作会在同一个事务内写入持久的 `project_reviews` 队列；保存成功后唤醒整理器，无需再点同步。同一目标项目的连续修改合并为最新请求，AI 自己更新贡献记录不会再次触发队列。

整理分两步：先用原有摘要器补齐操作发生前已接收的会话内容，再按时间分批重读相关 session 的全部历史摘要（包括已经整理过的摘要），结合目标项目和所有合并来源的完整记录重整简介、里程碑、todo、决策、阻塞和贡献关联。长历史记录按游标接续，重启不会丢任务；来源记录保留。

整理员只能写目标项目，所有写入仍经过原有领域操作并记录事件。用户锁定或编辑的内容、删除记录和否决不能被绕过；删除用户编辑过的条目仍需确认。用户中途撤销或改变关联时，旧任务停止后续写入，新请求读取最新状态；已产生的 AI 事件保留，可逐条撤销。

上游拒绝的片段保留原文、拒绝原因和调用记录，继续显示为信息缺口。同一 session 后续窗口照常处理。项目复核使用其余有效摘要，跳过被忽略的 session 和被隔离的片段，任务完成时记录 `done_with_gaps`，不会谎称信息完整。无写入的临时失败退避重试，发生部分写入后的失败不自动重放；`GET /status` 暴露 `pending_project_reviews`、`reviewing_project`、`failed_project_reviews`，失败会保留为可检查的状态。

## 采集覆盖核验

Inbox 会提醒已配置的来源连续 1 小时没有上报心跳（短时间休眠的笔记本不会触发）。尚未上报的静态来源从本次中心启动算起，单独签发的 herdr 采集 key 从创建时算起。再次收到心跳后提醒自动消失。「明天再提醒」搁置 24 小时，「不再提醒」对同一次断联一直有效；恢复后再次断联会重新提醒。已移出配置且没有有效采集 key 的历史来源仅在覆盖页保留。

`GET /coverage`（管理员）和 `Session` 页顶部的「采集覆盖核验」按来源列出实际收到了什么，避免把「采集器在线」当成「内容收齐」：

- 状态：已配置但从未上报、采集器离线、daemon 未连接、在线。
- 发现的 session 数（活跃、已结束、原文已删、未跟踪）与其中**有正文**的数量；没有任何正文、只有屏幕快照、Paseo 未加载（只有元数据）、仍在补采、积压暂停、读取出错的数量。
- 时间线缺口（按原因）、采集器未送达的批次、最近错误。
- 已存正文的缩减情况，分三类：有 user / assistant 消息在采集时被截断的段数（被截掉的部分中心没有）；只截了工具内容的段数（按设计）；Paseo 较长事件的节选段数（中心在 `source_events` 里保留更完整的事件副本）。
- 每类来源采集不到的范围（文字说明）。

它只统计到达中心的内容。采集器从未见过的 session 无法计数：herdr 只发现采集器运行期间出现过的 pane；Paseo 默认不导入采集器启动前已归档的 agent，已关闭或未加载的 agent 只有元数据。要核对这部分，只能在那台机器上对照 daemon / transcript 目录。

herdr 采集器对 user / assistant 消息保留首尾共 16000 字符并标注中间省略了多少（旧版本只保留前 4000 字符，结尾会丢）；工具调用只保留 200 字符的摘要，工具结果不采集。改规则不会回补已经越过游标的旧内容：那些段落以「采集时被截断」计数呈现，目前没有自动补采。

## 理解层与 MCP（计划 3）

计划 3 让中心自己读对话：**摘要员**把每个 session 新增的对话片段（chunk）压成结构化摘要，**整理员**再根据摘要建项目、更新里程碑和 todo、提问题。整理员以 `ai:curator` 身份走和网页一样的操作层（`execute()` / `askUser()`），每个写操作都带理由（reason）和证据（evidence，引用的摘要和 chunk），事件日志里能看到；标完成、合并这类操作会变成待你确认的问题。外部 agent 通过 `/mcp` 只能读项目和上报进展，不能直接写。

**阶段**：8 个阶段的定义写在 `src/understand/stage-guide.ts`，整理员每次更新项目都对照它核对阶段。往前推进（idea→探索→构建→验证）直接生效，一次一步，可以连续推几步；回退、完成、搁置、放弃、合并只会变成待你确认的问题。整理员只在有新摘要时才会看一个项目，所以调度器空闲时还会做**阶段复核**：把还没按当前规则判过的项目（idea 到验证），连同关联 session 最近的摘要，一批最多 8 个交给整理员判断一次。改了阶段定义就把 `STAGE_RULES_VERSION` 加一，所有项目会重新复核一遍。

### 模型和费用

- 摘要用 `claude-haiku-5-5`，整理用 `claude-sonnet-5-5`（复核默认跟整理一样）。配置里的 `understanding.digestModel` / `understanding.curateModel` 是默认值；网页 **设置 → 模型** 可以按角色（摘要员、整理员、复核）改，从下一次调用开始生效，不用重启。
- 调用走 Claude Agent SDK，默认用 **Claude 订阅**的额度（环境里继承来的 `ANTHROPIC_API_KEY` 等一律忽略），没有设额度上限。网页 **设置 → 模型服务** 可以改成 Claude OAuth token（订阅）或 Anthropic API key（按 token 计费到 API 账户，只有在这里明确选了才会用）。同一时刻最多一个模型调用；实时 session 先处理，历史导入（采集器第一次看到的旧对话）只在空闲时做。
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

也可以不改配置，在网页 **设置 → 模型服务** 里粘贴 OAuth token 或 API key：它们写在配置文件旁的 `secrets/` 目录（权限 600），不进数据库，网页上之后只显示末四位。网页里选了凭据就用它；没选时用 `oauthTokenFile`；都没有时用本机登录。

token 只放在这个文件里，**不要写进 launchd plist 或配置 JSON**。没有 `oauthTokenFile` 时，中心用这台机器上 Claude Code 自己的登录（环境变量 `CLAUDE_CODE_OAUTH_TOKEN` 也行），启动时会打印一行提示。整个理解层可以用 `"understanding": { "enabled": false }` 关掉，关掉后 `/status` 显示 `enabled: false`，`/sync` 返回 409。

v15 起，模型拒绝摘要时只隔离该窗口实际提交的 chunk。手动同步、重启和历史回填都跳过这些片段，保留原文及拒绝记录，顶栏显示有拒摘缺口的会话数。迁移旧记录按已保存的 chunk ID 匹配，无法完整匹配的记录标为待核对。若连 ID 列表都不可辨认，迁移时暂存该次拒绝前可能涉入的未摘要片段，等待人工核对。其余积压会自动进入现有摘要和整理队列，启用理解层前应核对本次积压量和模型凭据。

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
| `last_error` | 最近一次失败的说明；之后同一个 session 摘要成功（摘要失败）或整理成功（整理失败）就清空，跳过了 chunk、放弃了整理批次的那种会一直留着 |
| `waiting_sessions` | 有未摘要 chunk 的 session 数 |
| `uncurated_digests` | 还没整理的摘要数 |
| `backfill.sessions_done` / `backfill.sessions_total` | 历史导入进度（按 session 算） |
| `last_digest_at`、`last_curate_at` | 最近一次摘要 / 整理完成的时间 |

调度器平时自己跑：session 停下来（不再是 `working`）2 分钟后摘要它的新内容，一直在跑的 session 最晚 30 分钟摘要一次；`pm_report` 的上报再短也会交给模型，收到 2 分钟后摘要；摘要攒够 8 条或最早一条等满 5 分钟就整理一次。某个 session 的摘要连续失败 3 次会冷却 1 小时；同一段内容冷却两轮后每轮把窗口减半，缩到一段也还失败就跳过那一段（`last_error` 里写着 session 和 chunk id）。整理中途失败但已经写进了改动的那一批不会重跑（避免重复建项目、加 todo），错误同样记在 `last_error`。想马上处理已收到的内容：

```bash
curl -s -XPOST http://<mac-mini>:7718/sync -H "Authorization: Bearer <userToken>"   # 202 {"accepted":true}
```

`/sync` 只立即跑摘要和整理，不会让采集器马上采集（中心没有到采集器的命令通道），所以最新的几秒对话要等采集器下一轮推上来。

### API key：一种凭据，按权限范围区分

机器端调用方使用 Bearer API key；网页使用管理员用户名、密码与浏览器会话。机器端凭据能做什么由它的**权限范围**决定，一个 key 只有一个范围：

| 范围 | 给谁 | 能做什么 |
|---|---|---|
| 管理员（`admin`） | 兼容旧客户端的管理脚本 | 项目修改、查看对话原文、立即同步、管理 key 和设置 |
| Agent（`mcp`） | 各机器上的 coding agent | 只在 `/mcp` 上：读看板、`pm_report` 上报 |
| herdr 采集器（`ingest:herdr:<机器>`） | 那台机器的 herdr 采集器 | 只能上报那台机器的数据 |
| Paseo 采集器（`ingest:paseo:<来源>`） | 那个 Paseo 采集器 | 只能写那个来源（来源的机器和 daemon 身份仍在配置里） |

在网页 **接入密钥（API Keys）** 页（或 设置 → 开发者 → 接入密钥）新建、吊销 key：新 key 只在创建时显示一次，中心只存它的哈希，列表里显示前缀和最近使用时间。配置文件里的 `userToken`、`mcpToken`、`collectors`、`paseoCollectors` 照常有效，就是对应范围的 key，在列表里显示为只读（改它们要改配置文件）。所以已经部署的采集器和 agent 不用改；给新机器发 key 时，建议每台机器单独建一个，丢了只吊销那一个。

接入密钥页默认显示有效的页面管理密钥，可按名称、用途、状态筛选；配置文件中的旧 token 单独折叠，只读展示。点击“创建密钥”后选择用途与绑定范围，完整密钥仅在创建成功时显示一次，确认安全保存后关闭。管理员脚本权限位于高级选项中；网页登录仍使用账号密码，模型服务凭据另在设置中管理。吊销前会说明影响；更换密钥时，先为连接配置新密钥，再吊销旧密钥。

### 各台机器上的 agent 接入 MCP

中心在 `http://<mac-mini>:7718/mcp` 提供 MCP（Streamable HTTP，无状态）。工具：`pm_list_projects`、`pm_get_project`、`pm_get_brief`、`pm_timeline`、`pm_search`、`pm_list_sessions`（只读）和 `pm_report`（上报进展：内容存成一段对话片段，下一轮整理时由整理员处理，不会直接改项目）。没有写工具。

每个请求必须带 Agent 范围的 key（`mcpToken`，或在 API Keys 页新建的 Agent key；新建时页面会给出下面这条 `claude mcp add` 命令）：`Authorization: Bearer <key>`，否则 401；请求体最大 64 KB，超过返回 413；`userToken` 和采集器的 token 在这里无效，`mcpToken` 在别处也无效。`mcpToken` 会放在每台跑 agent 的机器上，泄露后的影响只是能读项目和上报。

**Claude Code**（每台机器跑一次；默认只对当前目录的项目生效，加 `--scope user` 对这台机器上的所有项目生效）：

```bash
claude mcp add --transport http agent-pm http://<mac-mini>:7718/mcp --header "Authorization: Bearer <mcpToken>"
claude mcp list        # agent-pm 应显示 connected
```

**Codex**（`~/.codex/config.toml`）：把 key 直接写成请求头。这样不依赖 shell 环境变量，Paseo（daemon 由 launchd 启动，读不到 `~/.zshrc`）起的 Codex 也能连上；配置文件保持 `chmod 600`：

```toml
[mcp_servers.agent-pm]
url = "http://<mac-mini>:7718/mcp"
http_headers = { Authorization = "Bearer <Agent key>" }
```

`codex mcp add` 只能用环境变量传 token（`--bearer-token-env-var`），那样只对从 shell 启动的 Codex 有效。

**Skill**：仓库的 `skills/agent-pm/SKILL.md` 告诉 agent 什么时候查看板、什么时候用 `pm_report` 上报（开工前读项目简报；做出决定、达到完成标准、被阻塞、发现新课题时上报）。每台机器装一次（Claude Code 和 Codex 共用一份，指向仓库里的文件，更新随仓库走）：

```bash
mkdir -p ~/.agents/skills ~/.claude/skills ~/.codex/skills
ln -sfn <仓库>/skills/agent-pm ~/.agents/skills/agent-pm
ln -sfn ~/.agents/skills/agent-pm ~/.claude/skills/agent-pm
ln -sfn ~/.agents/skills/agent-pm ~/.codex/skills/agent-pm
```

手工检查端点（不用任何 agent）：

```bash
curl -s http://<mac-mini>:7718/mcp -H "Authorization: Bearer <mcpToken>" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 优先级与阶段：AI 预填，你在同一个字段上改

项目的阶段和优先级都只能取固定选项。优先级 **P0 最高、P3 最低**：P0 阻塞其他工作或有硬期限，现在就要做；P1 当前主线，本周要推进；P2 重要但不紧急，排进计划；P3 可选，有空再做（定义在 `src/shared/vocab.ts`，整理员、复核、网页和 skill 共用）。

整理员新建项目时按定义预填优先级，往前推进阶段；还没有优先级的老项目由一次性复核补上（规则版本 `BOARD_RULES_VERSION` 变了时，所有进行中的项目各复核一次）。网页上它们就是那个字段本身：页面不标明一个值是 AI 填的还是你改的，你直接在同一个下拉框里改，选了就生效，没有确认步骤（选「合并」例外：它打开合并对话框，选目标和范围、看过预览并确认后才生效，见「合并项目：先预览，确认后才生效」）。改错了在事件日志里撤销。谁改的仍然记在数据库里（每次改动一条事件，带操作者）：你改过的字段 AI 之后不能直接改，只能向你提一个确认题；AI 提出的阶段回退、完成、搁置、放弃、合并始终要你确认。

## 网页界面（计划 4）

中心服务在 `/` 托管一个网页：首页用完整宽度按优先级列出项目（卡片上有进度条、在跑的 session、阻塞和待你回答的问题）；右上角 Inbox 显示待处理数量，独立 `#/inbox` 页面集中处理“需要你”和“待归属的 session”，可按类别筛选，回答或忽略后数量立即更新；点项目进详情页（改字段、里程碑、todo、阻塞、决策、时间线、事件日志；你改过的字段 AI 之后只能提议，页面上不显示锁，解锁只有 API）；`Session` 页按机器列出全部 session，可以关联到项目、取消关联、不追踪。页面里 AI 写的文字一律按纯文本显示。

**样式**：界面按 [Hallmark](https://github.com/nutlope/hallmark) 的规范重构（主题 Coral，app 界面）：所有颜色、间距、字号都走 `web/src/tokens.css` 里的 token，`base.css` 是它的基础规则，`styles.css` 开头的 `Hallmark ·` 注释是这次设计的记录（主题、检查、保留的交互）。字体用系统字体，不请求外部字体。改样式时用 token，不写颜色字面量。

**构建**：网页是 `web/` 下的 React + Vite 项目，要先构建，服务才有页面可托管（没构建时 `/` 会提示怎么构建）：

```bash
npm ci
npm run build:web      # 写到 dist/web，已在 .gitignore 里
```

部署到 mac-mini 之后、重启服务之前都要跑一次 `npm run build:web`（`git pull` 带来了网页的改动，`dist/web` 才会更新；只重启不构建，用户看到的还是旧页面）。构建完再 `launchctl kickstart -k "gui/$(id -u)/ai.agent-pm.server"`。

**使用**：

- 浏览器打开 `http://<中心机器>:<port>/`（`<port>` 是配置里的 `port`，通过 Tailscale 访问就是 `http://<mac-mini 的 Tailscale 名或 IP>:<port>/`）。浏览器打开后先登录管理员账号（底层项目只读 API 仍依赖 Tailscale 网络隔离）。
- 网页使用**管理员用户名和密码登录**，不再要求填写 API key。中心机器先运行 `npm run setup:admin -- --config ~/.config/herdr-pm/server.json`（可加 `--username <用户名>`，默认 `admin`）。命令生成随机初始密码，保存在配置文件旁的 `admin-initial-password`（权限 600），不会输出密码、覆盖现有账号或重置密码。首次登录需将初始密码改为自己的密码（至少12个字符）。
- 浏览器通过 HttpOnly、SameSite=Strict cookie 保持7天登录；HTTPS 下同时使用 Secure。密码采用带随机盐的 scrypt 哈希，会话只保存 SHA-256 哈希。设置 → 账号与安全可改密或退出；改密会撤销其他浏览器的登录。修改请求同时校验本站 Origin 和自定义请求头，登录有失败限流。
- `userToken` 和现有 API key 仍供受信任的旧客户端使用；Agent（MCP）和采集器仍使用各自范围的 API key，浏览器登录不会赋予它们管理员权限。
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

`agent-pm sessions`、网页和 herdr 侧边栏里看到的都是 8 位短 ID。`agent-pm open <短ID>` 把它变成一个动作：本机的 agent 直接切过去；其他机器上的 agent 通过 ssh attach 上去：在 herdr 里默认在当前 pane 右边分屏打开，不在 herdr 里（或加 `--remote inline`）就直接在当前终端里 attach。

查找**不依赖中心服务**（mac-mini 没开也能用）：它向本机 herdr 和 `herdr machine list` 里每台已启用的机器各问一次 `agent list`，所有机器同时问，每台最多等 8 秒，所以某台机器关机或网络不通只会多等 8 秒，并提示 `连不上：<机器>（<原因>）`，其他机器上的 agent 照样找得到。中心只在**一个都没找到**时用来补一句说明（"这个 session 已结束""那台机器的采集器离线"），连不上中心就直接说没找到。一个例外：herdr 有时不给 codex pane 报 session ID，而采集器会从 rollout 里读出来，所以网页上的短 ID 在 herdr 里查不到；这时如果中心知道这个 session 还在、并且记着它的 terminal，就用 terminal 在 herdr 自己的列表里找到那个 pane（打开的仍是 herdr 列出的 pane，不是中心的数据）。

**命令行**：

```bash
agent-pm open 0d67da1f                  # 找到并打开
agent-pm open                           # 在终端里不带参数：会问"短 ID："
agent-pm open 0d67da1f --dry-run        # 只打印"将执行：…"，什么都不动，用来排查
agent-pm open 0d67da1f --remote inline  # 远程 agent 就在当前终端里 attach，不分屏
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `<短ID>` | 交互时询问 | 粘贴也行：前后的空白、换行、引号会去掉，大写会转成小写，整串 key（`claude:0d67da1f-…`）会取冒号后面的部分 |
| `--remote split\|inline` | `split` | 远程 agent 的打开方式，见下。不在 herdr 里运行（环境变量 `HERDR_ENV` 不是 `1`）时一律 `inline` |
| `--server <url>` | `$AGENT_PM_SERVER`（旧名 `$HERDR_PM_SERVER` 也认），再默认 `http://localhost:7718` | 只用于一个都没找到时向中心要说明（或找 herdr 没报 session ID 的 pane） |
| `--herdr <path>` | `herdr` | herdr 可执行文件 |
| `--dry-run` | | 只打印计划，不执行 |

短 ID 匹配到多个 pane（同一个 session 在两处 resume，或者粘贴得太短）时，列出候选 `[1] 机器 · agent · 状态 · 标题 · pane`：在终端里输入编号选一个，回车取消；非交互（比如管道里）只列出来并退出 1，绝不随便打开一个。在终端里运行时，失败的结果（没找到 / 取消 / 出错）会先等你按回车再退出，免得弹窗一闪就没。

退出码：`0` 已打开（`inline` 时是 ssh 的退出码）；`1` 没找到、有歧义、取消或打开失败；`2` 用法错误（短 ID 格式不对、选项不对、非交互又没给短 ID）。输出都是中文。

**安装**：`open` 是同一个 `agent-pm` 二进制里的一个命令（`scripts/build-collector.sh` 打出来的那个，见「2. 每台机器上的采集器」），只需要放在你**按快捷键的那台机器**上（一般是笔记本）。升级到带 `open` 的版本后，重新构建并覆盖 `~/.local/bin/agent-pm`；被 attach 的远程机器上不用装它，只要有 herdr。

**快捷键**：herdr 的 `[[keys.command]]` 支持 `type = "popup"`（弹出一个会话内的终端），所以直接弹出终端运行 `agent-pm open`，不用写插件。写进 `~/.config/herdr/config.toml`，然后 `herdr server reload-config`：

```toml
[[keys.command]]
key = "prefix+g"
type = "popup"
command = "/Users/<你>/.local/bin/agent-pm open --server http://<mac-mini 地址>:7718"
width = "80%"
height = "60%"
description = "agent-pm: 按短 ID 打开 agent"
```

命令里要把中心服务显式带上：不带 `--server`（或环境变量 `AGENT_PM_SERVER`）时默认连 `http://localhost:7718`，笔记本上没有中心服务，"已结束 / 采集器离线"这类说明就不会出现。

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

拼进 shell 命令的 pane ID 和 ssh 地址先用白名单校验（pane ID `[A-Za-z0-9:_-]`，ssh 地址 `[A-Za-z0-9@._-]`，都不能以 `-` 开头，免得 ssh 把它当成选项），不合格直接拒绝，不做转义。

**手动检查结论（Task 5 填写）**：

> TODO（Task 5，真实环境手动检查后由使用者填写）：弹窗里 `HERDR_ENV` 是否为 `1`；本机 agent 的 focus 在弹窗关闭后是否停在目标 pane；herdr 正切到远程机器（TUI 在看远程）时 `split` 的表现；`split` 和 `inline` 各自适合的场景，以及最终推荐的默认值。

## Paseo 采集器（计划 6）

主要工作在 Paseo 里时，用一个**独立进程**把 Paseo daemon 上的 agent 状态和对话送到同一个中心，和 herdr 采集器同时运行、互不依赖：各有自己的配置、token、状态目录、重试和常驻服务，停掉任何一个，另一个照常工作。设计和实施记录见 `docs/superpowers/plans/2026-11-04-06-paseo-collector.md`。

- 一个实例只连**一个**明确配置的 daemon（`ws://` / `wss://`），通过 `@getpaseo/client` SDK（固定 0.15.0，已对 daemon 0.15.0 验证）只读：列目录、按 ID 查 agent、读时间线、订阅变化。**不**创建、发消息、停止、归档或重载 agent；停掉采集器不改变任何 agent。
- 中心按「来源」分别记录：herdr 机器是来源 `herdr:<machine>`，每个 Paseo 采集器是配置里的一个 `sourceId`。一个来源的快照只结束它自己的观察；一个来源的心跳也掩盖不了另一个来源的离线。同一个原生会话（同机、同 provider、同原生 session ID）被 herdr 和 Paseo 同时看到时，是一个逻辑会话、两个来源。
- 内容只由一个来源送进摘要（`content_owner`，先送到内容的来源；已有 herdr 内容的旧会话保持 herdr）。另一个来源的内容照样持久保存为 standby 证据，不重复分析；herdr 是 standby 时它的字节游标照样前进，不会反复补传。
- **不读未加载的 agent**：daemon 0.15.0 读一个未加载（`closed`）agent 的时间线会把它从持久化里恢复成一个运行时。采集器对这样的 agent 只上报状态（来源显示「未加载，暂不读取」），等你在 Paseo 里打开它（daemon 加载它）后再从中心确认的位置补读。已跟踪的 agent 被归档后，会再读一次它的最后内容（daemon 用只读的历史会话提供归档 agent 的历史，不运行任何东西）；不想要就在配置里设 `"readArchivedTracked": false`。
- 断线重连不会自动回放漏掉的事件，采集器总是从**中心已确认的位置**补读；批次先写本地 outbox 再提交，中心在一个事务里写证据、回执和位置，确认丢失后重发同一批次不会产生重复证据。时间线被替换（epoch 变化）时，有 provider 消息 ID 的行按 ID 去重，无法核对的行标为「待核对的重叠」并记录缺口，不会把整段历史重新交给模型。

### 中心配置

在 `server.json` 里加 `paseoCollectors`（键是 sourceId，只能用字母、数字、`.`、`_`、`-`）：

```json
"paseoCollectors": {
  "paseo-mac-mini": { "token": "<openssl rand -hex 32>", "machine": "mac-mini", "serverId": "<daemon 的 server id>" }
}
```

- `machine` 是**被观察的 daemon 所在机器**，不是采集器进程所在机器；用和 herdr 采集器相同的机器 label，同机的同一个会话才能关联。
- `serverId` 和 daemon 实际地址在 daemon 那台机器上查：`paseo status --json` 里的 `serverId` 和 `listen`。连到别的 daemon（server id 不同）的采集器会被拒绝，它也不会读那个 daemon。
- 这个 token 只能写这一个来源，和 `collectors`、`userToken`、`mcpToken` 及其他 Paseo token 都必须不同（配置校验会拒绝）；旧的 herdr token 不能写 Paseo 来源，反之亦然。

### 采集器配置

复制 `config/paseo-collector.example.json`（例如到 `~/.config/herdr-pm/paseo-mac-mini.json`），改：

- `server`：中心地址；`sourceId`、`machine`：和中心配置一致。
- `paseo.url`：daemon 的 WebSocket 地址，`ws://<listen>/ws`。示例里的 `127.0.0.1:6767` 只是占位：daemon 监听在 Tailscale 地址上时要写那个地址。
- `paseo.serverId`：同上。daemon 启用了密码时加 `"passwordFile"`。
- `tokenFile`：只含 token 的文件（`chmod 600`）。token 和 daemon 密码都只从文件读，不进配置、日志或服务模板。
- `stateDir`：每个来源一个，**不能共用**（目录锁保证同一时间只有一个进程用它；它记着这个来源和 daemon 的身份，换来源会拒绝启动）。请保留其中的身份和未确认批次（outbox）。确认位置由中心保存。
- 状态目录应放在本机文件系统上。采集器打开 `collector-lock.sqlite` 持有 SQLite 独占锁；正常退出、强制终止或机器重启都会释放内核锁。`collector.lock` 保留旧版本能读取的 PID。升级时自动检查旧十进制 PID：无关进程、Linux 非主线程、晚于锁文件才启动的进程均可接管；仍在运行的旧采集器继续持锁。升级时先停旧实例，保留原状态目录，无需手动删锁。
- 可选：`includeArchivedHistory`（首次导入已归档的 agent，默认关）、`includeBackground`（默认开，后台 workspace 的 agent 也列出）、`exclude`（`{"projectKeys": [...], "labels": {...}}`，被排除的标为不再跟踪，不算结束）、`maxConcurrentAgents`、`maxOutboxBytes`（outbox 到上限时暂停读内容，心跳照常，不丢批次）。

手动跑一次（前台，Ctrl-C 停止）：

```bash
cd <仓库> && npm ci
node src/cli.ts collect-paseo --config ~/.config/herdr-pm/paseo-mac-mini.json
```

日志一行一事件，只写来源、agent ID、错误和积压，不写对话内容。bun 单文件二进制里**没有** Paseo SDK（构建时 `--external`），从二进制运行 `collect-paseo` 会提示改用 node。

### 常驻

macOS（每个来源一个 job，和 herdr 采集器的 job 分开）：

```bash
mkdir -p ~/Library/Logs/agent-pm
sed -e "s#__SOURCE_ID__#paseo-mac-mini#g" -e "s#__NODE_BIN__#$(command -v node)#g" -e "s#__REPO__#$PWD#g" \
    -e "s#__CONFIG_PATH__#$HOME/.config/herdr-pm/paseo-mac-mini.json#g" -e "s#__HOME__#$HOME#g" \
    deploy/launchd/ai.agent-pm.paseo-collector.plist > ~/Library/LaunchAgents/ai.agent-pm.paseo-collector.paseo-mac-mini.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ai.agent-pm.paseo-collector.paseo-mac-mini.plist
# 停用：launchctl bootout "gui/$(id -u)/ai.agent-pm.paseo-collector.paseo-mac-mini"
```

Linux（systemd 用户服务模板，实例名就是 sourceId，配置在 `~/.config/herdr-pm/<sourceId>.json`，仓库默认在 `~/agent-pm`，别处用 `systemctl --user edit` 设 `AGENT_PM_REPO`）：

```bash
cp deploy/systemd/agent-pm-paseo-collector@.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now agent-pm-paseo-collector@paseo-gx10
# 停用：systemctl --user disable --now agent-pm-paseo-collector@paseo-gx10
```

### GX10 实机部署（2026-11-11）

090e 和 c757 已通过各自的 Paseo 专用临时终端部署并启用独立的 systemd 用户服务，没有修改 SSH 授权，也没有重启 Paseo daemon 或改动 herdr 采集器。

| 机器 / 用户 | 来源 | daemon serverId | 服务 |
|---|---|---|---|
| gx10-090e / yubaifeng | `paseo-gx10-090e` | `srv_Z45uIMACHAjG` | `agent-pm-paseo-collector@paseo-gx10-090e.service` |
| gx10-c757 / bz | `paseo-gx10-c757` | `srv_SyyfHCkc1tYm` | `agent-pm-paseo-collector@paseo-gx10-c757.service` |

两台 daemon 均为 0.16.0-beta.1，采集器沿用锁定的 SDK 0.15.0，目录读取、心跳、快照和内容上报已实测通过。首次验收中心分别收到 10 / 2 个会话，其中未加载的 5 / 1 个只上报状态。

- 运行代码及 SDK 的纯 JavaScript 运行依赖最初来自提交 `76d7164`；2026-11-15 升级到 `003eaba`，位于 `~/.local/share/agent-pm-paseo/releases/003eaba`（依赖未变，`node_modules` 从旧版本目录复制），旧目录保留可回退。没有拷贝 Mac 原生模块，也没有安装中心服务的模型依赖。
- 升级方式：在对应机器的 Paseo 终端里下载新版本源码，解到新的 `releases/<提交>`，把 `agent-pm-paseo-collector@<sourceId>.service.d/runtime.conf` 里的 `AGENT_PM_REPO` 指过去（原文件另存为 `runtime.conf.before-<提交>`），`daemon-reload` 后重启服务。回退就把 `runtime.conf` 换回去再重启。同次升级还把 herdr 采集器二进制 `~/.local/bin/herdr-pm` 换成 `003eaba` 构建的版本，旧二进制保留为 `herdr-pm.before-003eaba`。
- 专用 Node 位于 `~/.local/opt/node-v26.13.0-linux-arm64/bin/node`，官方包的 SHA-256 已校验。各服务的 `runtime.conf` 单独设置 `AGENT_PM_REPO` 和 `PATH`，不替换系统或 Paseo 使用的 Node。
- 配置为 `~/.config/herdr-pm/<sourceId>.json`，独立 token 为同目录 `<sourceId>.token`，权限均为 600；状态目录为 `~/.local/state/herdr-pm/<sourceId>`。
- 两个用户的 `Linger=yes`，服务均已 `enable`；herdr 的 `herdr-pm-collector.service` 继续独立运行。
- 维护时在对应机器执行 `systemctl --user status agent-pm-paseo-collector@<sourceId>`，日志用 `journalctl --user -u agent-pm-paseo-collector@<sourceId> -n 30`。回退只需 `systemctl --user disable --now agent-pm-paseo-collector@<sourceId>`，无需停 herdr 或 Paseo。

### 上线顺序与回退

1. **备份中心数据库**（中心停着时复制 `herdr-pm.db*`，或 `sqlite3 herdr-pm.db ".backup herdr-pm.pre-v5.db"`）。
2. 升级中心代码并重启。启动时自动做 v5 迁移（只追加表和列：已有 session、chunk、digest 的 ID 和项目引用不变；每台机器成为 `herdr:<machine>` 来源，已有 session 回填为它的观察，字节游标从已有 chunk 初始化）。旧 herdr 采集器**不用改配置、不用重装**，`/ingest/snapshot`、`/ingest/chunks`、`/ingest/offset` 照旧。
3. 确认 herdr 数据照常更新（`agent-pm sessions`、网页）。
4. 在中心配置里加 `paseoCollectors` 并重启中心，再启动 Paseo 采集器。网页的会话行会出现来源标签（herdr / Paseo、主内容 / 备用、离线或滞后原因）。
5. 回退：停用 Paseo 采集器即可回到只采 herdr。中心要继续用支持 v5 的版本；**不要**用迁移前的旧中心程序打开迁移后的数据库（要回到旧程序，就连同第 1 步的备份一起回退）。

### 已知限制

- 第一版不自动发现 Paseo 的远程 hosts、不建 SSH 隧道、不配 relay；多个 daemon 就起多个实例。090e 和 c757 的独立实例已通过实机验收，见上面的部署记录。
- 不读未加载的 agent（见上）；Claude / Codex 以外的 provider 只保证状态，未知的时间线行只计数，不当作正文。
- 同一原生 ID 出现在两台机器上时保守地保留为两个会话（键带 `@<machine>`，并标「身份待核对」）；身份迟到、两边都已有内容时，后到一边的内容只作证据保存，不自动拼接。
- 时间线是 provider 的投影，不等于原始 transcript；daemon 自身丢失的历史（`gap`、窗口外的历史）记为缺口。
- `agent-pm open` 对只由 Paseo 看到的会话只提示「请在 Paseo 中打开」，不伪造 herdr pane。

## 部署验收（计划 1 完成的标志）

- [ ] 四台机器上本地执行 `herdr integration status`，claude 和 codex integration 都已安装。
- [ ] mac-mini 上用 launchd 跑中心服务；笔记本、mac-mini、gx10-090e、gx10-c757 各跑一个采集器。
- [ ] `agent-pm sessions --server http://<mac-mini 的 Tailscale IP>:7718` 列出四台机器上的全部活跃 session。
- [ ] 让笔记本休眠超过 3 分钟：它的 session 显示 `offline`；唤醒后恢复 `live` 状态（`working` / `idle` 等），chunk 继续增长，没有重复。
- [ ] 在 herdr 里关掉一个 agent：下一轮（约 10 秒）它的状态变成 `ended`。

## 开发

```bash
npm ci
npx vitest run     # 测试
npx tsc            # 类型检查（不产出文件）
```

Node 26 直接运行 `.ts`：`node src/cli.ts <command> ...`；`npm link` 之后 `agent-pm` 命令可直接用（`package.json` 的 `bin` 指向 `src/cli.ts`）。本地配置写成 `config/*.local.json`（已在 `.gitignore` 里）。

`src/cli.ts` 只在 `server` 命令里动态 `import()` 服务端模块（`node:sqlite`、hono）：采集器二进制是 bun 编译的，bun 没有 `node:sqlite`，所以 `collect`、`sessions` 和 `open` 路径不能加载它们（`open` 的代码在 `src/lookup/`，只能 import node 内置模块、`src/shared/` 和 zod）。Paseo 采集器（`src/paseo-collector/`）同理只由 `collect-paseo` 动态加载，SDK 只在 `sdk.ts` 里动态 `import()`；`tests/cli.test.ts` 守着这些边界。Paseo 的故障路径测试用 `tests/helpers/fake-paseo.ts`（可控的假 daemon）和 `tests/helpers/center.ts`（临时数据库上的真实中心）；对真实 daemon 的只读契约测试：`PASEO_CONTRACT_URL=ws://<listen>/ws npx vitest run tests/paseo-collector/sdk.test.ts`。
