# herdr-pm

在多台机器上同时跑十几个 coding agent（Claude Code、Codex）时，herdr 能告诉你"哪个 agent 在跑、哪个在等我"。herdr-pm 补上 project 层面的视图。它的第一步（本仓库目前实现的部分，计划 1：采集地基）是把所有机器上的 agent session 和对话汇总到一个中心：

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

中心监听 `config.port` 的所有网卡，目的是让其他机器通过 Tailscale 访问。`/sessions*` 目前**没有鉴权**，只靠网络隔离，所以不要把这个端口暴露到公网；`/ingest/*` 要求每台机器自己的 bearer token。

## 已确认的环境事实

- gx10-090e：`uname -m` = `aarch64`（Linux arm64），有 node v22.23.3，**没有 bun**。因此采集器在笔记本上用 bun 交叉编译成 `bun-linux-arm64` 二进制再拷过去，不在 gx10 上装任何运行时。
- 笔记本、mac-mini：macOS arm64，使用 `bun-darwin-arm64` 二进制。
- gx10-c757：部署前先跑一次 `uname -m`。如果也是 `aarch64`，和 gx10-090e 完全一样；如果是 `x86_64`，需要在 `scripts/build-collector.sh` 里加上 `bun-linux-x64` 目标。
- 笔记本直接 ssh 不到 mac-mini（只能经 herdr 访问）；下面的"拷贝二进制"一步用任何可行的方式即可，能 scp 就 scp（走 Tailscale）。

## 安装

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
- `machine` 和 `token` 必须和中心 `collectors` 里这台机器的条目一致，否则中心返回 401 / 403。
- 只有 `server`、`machine`、`token` 是必填的，其余都有默认值（上面写出来的就是默认值）。`~` 会展开成运行采集器的用户的家目录。
- `stateFile` 是采集器的本地游标。丢了也没事：采集器会先向中心查每个 session 的最大 offset 再续读，不会产生重复 chunk。

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

**Linux（gx10-090e、gx10-c757）**

```bash
# 在笔记本上
scp dist/herdr-pm-bun-linux-arm64 gx10-090e:~/herdr-pm            # gx10-c757 同理
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

### 升级

改了代码后：笔记本上重新 `scripts/build-collector.sh`，把新二进制覆盖到各机器的 `~/.local/bin/herdr-pm`，然后重启服务（macOS：`launchctl kickstart -k "gui/$(id -u)/ai.herdr-pm.collector"`；Linux：`systemctl --user restart herdr-pm-collector`）。中心服务 `git pull` 后同样 `kickstart -k`。

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

## 部署验收（计划 1 完成的标志）

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

`src/cli.ts` 只在 `server` 命令里动态 `import()` 服务端模块（`node:sqlite`、hono）：采集器二进制是 bun 编译的，bun 没有 `node:sqlite`，所以 `collect` 和 `sessions` 路径不能加载它们。
