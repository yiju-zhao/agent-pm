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

`src/cli.ts` 只在 `server` 命令里动态 `import()` 服务端模块（`node:sqlite`、hono）：采集器二进制是 bun 编译的，bun 没有 `node:sqlite`，所以 `collect` 和 `sessions` 路径不能加载它们。
