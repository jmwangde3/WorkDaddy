# WorkDaddy rehome 模式（基于选型报告 §11 的改造）

> 目标：3 个 WorkBuddy 账号切换后，**自动回到同一会话、同一工作区进度、同一套配置**，全程零手动迁移。
> 依据：`H:\AI工作区\wb账号同步\WorkBuddy三账号状态共享_现成项目调研与选型推荐.md` §11。
> 底子：`jmwangde3/WorkDaddy`（与上游 `babygoton/WorkDaddy` main 一致）。WorkDaddy 原有功能全部保留。

## 1. 原理

本机实测把问题压缩到两个字段级断点，其余状态本来就全局：

| 层 | 状态 | 处理 |
|---|---|---|
| 全局层 | skill / mcp / 插件 / 规则 / 设置 / 工作区文件 / 消息 JSONL / 产物 / `workspaces` 表 / `workspace_trust_decisions` | **不动**，无账号维度，切号天然还在 |
| 断点一 | `sessions.user_id` | **本改造**：切号后原地改归属 |
| 断点二 | `<uuid>/startup-route.json` | `setup-rehome.ps1` 一次性硬链接 |
| 工作记忆 | `user-<uuid>-personal/MEMORY.md` | `setup-rehome.ps1` 一次性硬链接 |
| 人设 / 专家团 / 账号级 memory | 实测三份内容全同 / 全为空壳 / 全局 | 不动 |

**rehome = 一条 `UPDATE sessions SET user_id = ?`**，单事务完成。会话 ID 不变、始终只有一份、零复制、零分叉。与 WorkDaddy 自带的「复制会话」（生成新 ID + 复制 JSONL/产物 + 插一行）互斥，本模式优先。

切号时序（`/api/switch`）：

```
switchAccountForProfile(uid)   # 写登录文件
        ↓
rehomeRunner.run(uid)          # 备份 → 单事务改 sessions.user_id
        ↓
alignStartupRoutes(sourceUid)  # 把 A 最后打开的会话写成全部账号的启动落点
        ↓
reloadWorkBuddyPage()          # CDP 刷新；客户端此时读到的会话已属于新账号
        ↓
autoCopyJob / automationSync   # WorkDaddy 原有流程照常
```

## 2. 改动清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `scripts/rehome-sessions.js` | 新增 | 接管逻辑：复用 `session-db.js`（node:sqlite → sqlite3 CLI 兜底），配置持久化、`VACUUM INTO` 一致性备份、单事务写入、并发保护、干跑；另含 `alignStartupRoutes()` 启动落点自动对齐 |
| `scripts/rehome_sessions.py` | 新增 | 独立 CLI 版（Python 标准库），可单独运行 / 挂自动化任务 /  troubleshooting |
| `scripts/daemon.js` | 改 | ① 顶部引入 + 懒初始化 `getRehomeRunner()` ② `/api/switch` 切号成功后、CDP 刷新前调用 rehome ③ 同步调用 `alignStartupRoutes(DATA_DIR, sourceUid)` 对齐启动落点 ④ 返回值加 `rehome`（含 `routeAlign`） ⑤ 新增 `/api/rehome/status`、`/api/rehome/config`、`/api/rehome/run` ⑥ `/api/sessions` 返回加 `rehomeEnabled` |
| `scripts/inject.js` | 改 | 「会话」Tab 新增「接管会话归属」开关（`wbs-sess-rehome`），状态/事件/批量模式联动 |
| `scripts/setup-rehome.ps1` | 新增 | 一次性硬链接 `startup-route.json` 与 `MEMORY.md`，支持 `-DryRun`、自动发现账号目录、自动备份、幂等 |
| `test/rehome-sessions.test.js` | 新增 | 临时库回归测试：干跑不写、排除口径、备份、幂等、开关、空 uid |

## 3. 安装与启用

### 3.1 一次性准备（务必完全退出 WorkBuddy / WorkDaddy，含托盘与后台进程）

```powershell
cd H:\AI工作区\wb账号同步\WorkDaddy

# 先看会改什么（只读）
powershell -ExecutionPolicy Bypass -File scripts\setup-rehome.ps1 -DryRun

# 确认后执行：三个 startup-route.json + 三个 MEMORY.md 建硬链接
powershell -ExecutionPolicy Bypass -File scripts\setup-rehome.ps1
```

验证硬链接：

```powershell
fsutil hardlink list "$env:USERPROFILE\.workbuddy\a2099672-38bd-4b08-9d02-5f5e88475992\startup-route.json"
fsutil hardlink list "$env:USERPROFILE\.workbuddy\user-a2099672-38bd-4b08-9d02-5f5e88475992-personal\MEMORY.md"
```

两条都应列出 3 个路径。国际版加 `-DataRoot "$env:USERPROFILE\.workbuddy-ai"`。

**实测状态（12:04）**：`MEMORY.md` 三份已连成同一 inode（`links=3`），稳定。`startup-route.json` 中 B / C 连成同一 inode（`links=2`），A 因当前 WorkBuddy 会话活跃、被客户端原子替换写断成独立 inode（`links=1`）—— 这是预期内行为，已由 `alignStartupRoutes()` 每次切号原地写自动对齐内容（三份现均指向当前会话 `26964c04-…`），功能不受影响，也无需反复重跑本脚本。`setup-rehome.ps1` 对 `startup-route.json` 只作首次建立 / 手工重建；`MEMORY.md` 的硬链接是长期共享的那一层。

### 3.2 Windows 从源码启动（国内版 profile = `workbuddy-cn`）

`install.sh` / `relaunch-with-cdp.sh` 是 **macOS 专用**（写 `~/Library/Application Support/`、找 `.app/Contents/MacOS/Electron`）。在 PowerShell 里执行 `bash scripts/install.sh` 会报 `无法将"bash"项识别为 cmdlet`，即使用 Git Bash 跑也会建错目录。Windows 用原生入口：

**方式一 · 安装到用户目录并启动（推荐）** —— 在 PowerShell 里：

```powershell
cd 'H:\AI工作区\wb账号同步\WorkDaddy'
powershell -ExecutionPolicy Bypass -File 'scripts\install-win.ps1'
```

或双击 `scripts\install-win.cmd`。它把改造过的 `scripts/` 复制到 `%LOCALAPPDATA%\Programs\WorkDaddy\scripts`、初始化 `%APPDATA%\WorkDaddy`、启动 `launcher.cmd`。

**方式二 · 源码目录直接启动（不复制）** —— 在 cmd 里：

```cmd
cd /d "H:\AI工作区\wb账号同步\WorkDaddy\scripts"
launcher.cmd
```

`launcher.cmd` → `win-launcher.js --experimental-sqlite`，负责定位 `WorkBuddy.exe`、带 `--remote-debugging-port=9222` 重启客户端、起 daemon（本地 API `127.0.0.1:47832`）、注入面板。首次会让 WorkBuddy 重启一次以启用 CDP，属正常。

> 源码 clone 里没有 `WorkDaddyLauncher.exe`（打包产物），所以 `Start-WorkDaddy.cmd` 在源码目录不可用；需要它请下载发布版 ZIP / Setup.exe，再把改造后的 `scripts/` 覆盖进安装目录。
> Node 由 `launcher.cmd` 自动定位：安装目录 `runtime\node\node.exe` → `%USERPROFILE%\.workbuddy\binaries\node\versions\*\node.exe` → PATH 的 `node`。本机 Node v22.14.0 已验证。

### 3.3 开启开关

- 「会话」Tab → 勾选「接管会话归属」（默认已开启）。
- 或环境变量 `WORKDADDY_REHOME_SESSIONS=0` 关闭首次默认。
- 配置落在 `<DATA_DIR>/rehome-sessions.json`，形如 `{ "enabled": true }`。

## 4. 本地 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/rehome/status` | `{enabled, dbPath, backend, configPath, backupDir, lastRun}` |
| POST | `/api/rehome/config` | body `{"enabled": true|false}` |
| POST | `/api/rehome/run` | body `{"uid":"...", "dryRun": true}`；`uid` 缺省取当前账号 |
| GET | `/api/sessions` | 响应新增 `rehomeEnabled` |
| POST | `/api/switch` | 响应新增 `rehome: {ok, affected, backup, ...}` |

所有接口沿用 WorkDaddy 原有的本机 API token 鉴权，未新增对外端口。

## 5. 独立 CLI（不依赖 Node / WorkDaddy）

```bash
python scripts/rehome_sessions.py             # 干跑，只读
python scripts/rehome_sessions.py --apply     # 备份 + 单事务写入
python scripts/rehome_sessions.py --uid UID --db PATH --auth PATH --backup-dir PATH
```

默认路径：
- DB：`%USERPROFILE%\.workbuddy\workbuddy.db`
- 登录文件：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（`account.uid` 为明文）
- 备份目录：`%USERPROFILE%\.workbuddy\rehome-backups\`

可用环境变量 `WORKBUDDY_DB` / `WORKBUDDY_AUTH` / `WORKBUDDY_BACKUP_DIR` 覆盖。

## 6. 验证

```bash
node --check scripts/rehome-sessions.js
node --check scripts/daemon.js
node --check scripts/inject.js
node test/rehome-sessions.test.js
python scripts/rehome_sessions.py
```

已实测通过（本机 Node v22.14.0 / node:sqlite）：

```
PASS rehome-sessions.test.js — backend=node:sqlite dry=2 applied=2 backup=workbuddy-20261110-115506-270.db
ALL JS OK
python 干跑：会话总数 179，接管范围 A=28 / C=26 / B=20，当前 A 将改归属 46 条
```

**端到端验收**：

1. 账号 A 在会话 S 发 5 条消息、留草稿 D、编辑工作区文件 F 不保存、装 Skill K、配 MCP M。
2. 用 WorkDaddy 切到账号 B（不导出、不导入、不选择）。
3. 检查：自动落在 S；5 条历史与 D 在；F 与未保存内容在；K 可调用、M 可用。
4. B 继续输入 → 切到 C → 切回 A：会话 ID 不变、无重复会话、进度连续。

## 7. 回滚与风险

- **备份**：每次写入前 `VACUUM INTO` 生成一致性快照到 `<DATA_DIR>/rehome-backups/`（Node 版）或 `%USERPROFILE%\.workbuddy\rehome-backups\`（Python 版）。恢复时用备份库覆盖 `workbuddy.db`（先完全退出 WorkBuddy）。
- **失败隔离**：接管失败只记 `[rehome]` 日志，不阻断切号。
- **硬链接断开（已自动兜底）**：`startup-route.json` 由客户端活跃时持续写入；若官方用「临时文件 + 原子替换」，硬链接会断。每次切号后 `alignStartupRoutes()` 都会用 `fs.writeFileSync` 原地写把三个账号的落点重新对齐（原地写保持 inode，硬链接不断），因此断开也会被自动修复；`setup-rehome.ps1` 只作为首次建立/手工重建手段。判定：`fsutil hardlink list` 只剩 1 条时，切一次号即恢复一致。
- **排除项**：已归档（`status='archived'`）、已删除（`deleted_at` 非空）、后台自动化任务（`is_background_automation=1`）不接管；`automations.owner_user_id` 不跟随。
- **服务端上下文**：本地归属/记录齐全后，云端是否接受跨账号继续全部上下文由 WorkBuddy 决定，按第 6 节端到端验收实测。
- **`working` 态**：会话仍在运行就切号，先让它落盘/结束。

## 8. 故障：「点了没反应」/ CDP 未连接

### 8.1 现象与真相

双击 `launcher.cmd` 一闪而过、WorkBuddy 右下角没有机器人按钮，并不代表 daemon 没起来。实测判定：

```powershell
# 1) daemon 是否在跑
Invoke-RestMethod http://127.0.0.1:47832/api/status

# 2) 改造版是否已加载
$t = (Get-Content "$env:APPDATA\WorkDaddy\.api-token" -Raw).Trim()
Invoke-RestMethod http://127.0.0.1:47832/api/rehome/status -Headers @{'x-workdaddy-token'=$t}

# 3) CDP 端口
Test-NetConnection 127.0.0.1 -Port 9222
```

实测结果（12:11）：`47832` LISTENING、daemon PID 2336、watchdog PID 3704、`/api/rehome/status` 返回 `enabled:true / backend:node:sqlite`、`/api/rehome/run` 干跑 `affected:46` —— **daemon 和改造版 rehome 逻辑都已在运行**。`.daemon.lock` 已存在，所以再点一次 `launcher.cmd` 会直接退出，窗口一闪而过属正常。

缺的只有 CDP：`/api/status` 返回 `cdpReachable:false`、`needsDebugRelaunch:true`，9222 无监听，WorkBuddy.exe 主进程命令行没有 `--remote-debugging-port`。面板注入不进去，于是看不到机器人按钮。

### 8.2 根因（launcher.log 12:09）

```
重启 WorkBuddy（带 --remote-debugging-port=9222） H:\Program Files\WorkBuddy\WorkBuddy.exe
[exit] taskkill /PID 28440 code=0 / 20664 code=0 / 38008 code=0 / 33128 code=1
launcher 异常: 结束已验证进程 taskkill 失败 (code=1)
Windows 本地提示调用失败: spawnSync powershell.exe ETIMEDOUT
```

退出阶段有一个子进程 `taskkill` 返回 1，launcher 抛异常；随后本地提示调用超时，重启流程中断。WorkBuddy 之后自行拉起，但没带上调试参数。daemon 日志据此给出提示：「检测到 WorkBuddy 正在运行但调试端口不可达……请在状态页一键恢复」。

### 8.3 一键恢复（任选其一）

**方式一 · 浏览器**：打开 `http://127.0.0.1:47832/`，点「重新启动客户端并恢复」。该页面是 WorkDaddy 自带的状态页，按钮 POST 到白名单路由 `/api/client/relaunch`（loopback 免 token），执行 `quitWorkBuddy()` → `relaunchWorkBuddy()` → 重置调试状态。

**方式二 · 双击脚本**：`scripts\fix-cdp.cmd`，等价地 POST 同一路由，循环探测 9222 最多 40s 后打印 CDP 与 daemon 状态。

两种方式都会**重启一次 WorkBuddy 窗口**（当前会话从落盘记录恢复；`startup-route.json` 已对齐到当前会话）。

### 8.4 恢复后验证

```powershell
curl.exe -s http://127.0.0.1:9222/json/version     # 应返回 Browser / webSocketDebuggerUrl
curl.exe -s http://127.0.0.1:47832/api/status      # cdpReachable 应为 true
```

WorkBuddy 右下角出现机器人按钮 → 「会话」Tab 出现「接管会话归属」开关（默认勾选）。随后按 §6 跑端到端验收。

若按钮/脚本仍失败：完全退出 WorkBuddy（含托盘与后台进程），再手动带参数启动
`Start-Process 'H:\Program Files\WorkBuddy\WorkBuddy.exe' -ArgumentList '--remote-debugging-port=9222'`。

### 8.5 14:43 复现与根因修复（停止后再启动失败）

14:43 用 `stop-workdaddy.ps1` 停止、再双击启动，`launcher.log` 完整复现了 §8.2 的同一错误：

```
[exit] 结束已验证进程 taskkill=/PID 35968 code=0
[exit] 结束已验证进程 taskkill=/PID 39068 code=0
[exit] 结束已验证进程 taskkill=/PID 34920 code=0
[exit] 结束已验证进程 taskkill=/PID 32068 code=1
launcher 异常: Error: 结束已验证进程 taskkill 失败 (code=1)
```

**真相**：`win-launcher.js` 的 `killForExit()` 把任意 `taskkill` 非零返回当作致命错误抛出，导致 `quitWorkBuddy()` 在杀到第 4 个 Electron 子进程时整个中断。WorkBuddy **根本没被关掉、更没以调试模式重启**（实测主进程 35968 仍在、命令行无 `--remote-debugging-port`、9222 无监听）。子进程随宿主一起消失、或 CIM 枚举滞后，都会让 `taskkill /PID` 返回 1（"进程未找到"），这是正常竞态，不该致命。

值得注意的是 **daemon 侧 `daemon.js:quitWorkBuddy()` 早已正确处理**：普通 `taskkill` 非零只记日志并继续，交给 `waitForWorkBuddyExit()` 与两轮强制结束统一判定。所以 `/api/client/relaunch`（状态页按钮 / `fix-cdp.cmd`）能绕开这个 bug —— 这也是 §8.3 一直有效的原因。

**修复**（`scripts/win-launcher.js` `killForExit()`，已同步到安装版）：

- `taskkill` 返回非零且无 spawn 级错误时，先 `sleep(350)` 后复验目标 PID；已消失 → 按竞态成功处理。
- 仍可见 → 只记日志、**返回而不抛**，把判定权交给上层 `waitForWorkBuddyExit()` + 两轮强杀；真正的失败仍由 `quitWorkBuddy()` 末尾的 fail-closed 抛「无法确认退出」，不会误判成功。
- `result.error`（如 taskkill 缺失 / 权限不足）仍照旧抛出。

`fix-cdp.cmd` 同步增强：先探测 47832/9222、daemon 不在时提示先启动、POST 后循环探测 9222 最多 40s、超时给出手动兜底命令。

**正确的停止 → 启动顺序**：

1. `powershell -ExecutionPolicy Bypass -File scripts\stop-workdaddy.ps1`（watchdog + daemon 一起停）
2. 双击桌面 `WorkDaddy.lnk`（或 `scripts\launcher.cmd`）→ 修好后会自动完成「退出 WorkBuddy → 带 9222 重启 → 注入」
3. 若中途 CDP 仍断，再双击 `scripts\fix-cdp.cmd`（走 daemon 侧 relaunch，与 launcher 的 bug 无关）

`node --check` 全过；改动已复制到 `%LOCALAPPDATA%\Programs\WorkDaddy\scripts\`（实际运行目录）。注意 `/api/client/relaunch` 与带调试参数的重启都会**关闭并重开 WorkBuddy 窗口**，当前会话从 `startup-route.json` 落盘记录恢复。

---

## 9. 与 §10 方案的关系

两者共用同一条 `UPDATE sessions SET user_id = ?`。本改造把它挂进 WorkDaddy，保留 WorkDaddy 全部增强功能；若只想要零手动续用、工具越少越好，仍可用 `xytss/workbuddy-session-sync` 单用 + 两次硬链接（选型报告 §10）。两条路随时可换。

---

## 10. 12:23 实测修复：账号信息加密 + 切号未同步

### 10.1 现象

面板账号卡片显示「(已加密)」「连续登录读取失败」「剩余 -」；在 WorkBuddy 客户端内切换账号后，会话没有跟过去。

### 10.2 根因一：信封取钥失败（账号信息）

WorkBuddy 5.6+ 把 `nickname` / `phoneNumber` / `accessToken` 加密成 `$wbEncrypted` 信封。WorkDaddy 的 `wdCompatStaticKey()` 需要 spawn `WorkBuddy.exe --wd-compat-print-key`（`ELECTRON_RUN_AS_NODE=1`）拿静态密钥，但 `wdCompatWindowsExeCandidates()` 只找 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`。本机装在 `H:\Program Files\WorkBuddy\WorkBuddy.exe`，候选里没有 → daemon.log 累计 **22528 条**「解密失败 ... 未找到 WorkBuddy 可执行文件」。取钥失败连带 `wdCompatAuthToken()` 返回空，积分与成长接口也失败。

**修复**：新增 `scripts/workbuddy-exe.json`（内容 `{"path":"H:\\Program Files\\WorkBuddy\\WorkBuddy.exe"}`），并在 `lib.js` 的 `wdCompatConfiguredExe()` 里优先读同目录这个文件。实测：

```
ELECTRON_RUN_AS_NODE=1 WorkBuddy.exe lib.js --wd-compat-print-key
  -> WD_COMPAT_KEY x0qvnfCRBKXgsf0C0cKx6lhuQGaESTPzJ5chxojUQFU=
解密后 nickname = 王冠林michael / phone = 133****6968 / accessToken = eyJhbGciOiJS...（明文）
```

重启后 daemon.log 出现 `[sync] 已备份账号 王冠林michael (...)`，watcher 启动之后解密失败 **0 次**。作为双保险，`listAccounts()` 增加 `account-display.json` 明文昵称兜底（由 watcher 从 CDP target URL 的 `accountSnapshot` 提取写入）。

### 10.3 根因二：切号没经过 `/api/switch`（会话未同步）

daemon.log 里全程只有 `[sync] 已备份账号`，**没有一条 `[switch]` / `[rehome]`**，`rehome.lastRun` 仍是上一次手动干跑。说明切账号走的是 WorkBuddy 客户端内退出/登录（或 WorkDaddy 无感登录），只触发 daemon 的「自动备份账号」路径，从不调用 `/api/switch` —— 挂在那个路由上的 rehome 钩子自然不会触发。`sessions.user_id` 仍是三份（A=28 / B=20 / C=26）。

**修复**：新增 `scripts/rehome-watcher.js`，在 HTTP server 成功监听后启动账号变化监听：

- 每 2 秒读 `AUTH_FILE` 的明文 `account.uid`（轮询而非 `fs.watch`，因为 auth 文件是原子替换写入，Windows 上 watch 易丢）
- 首次只记录 baseline，避免 daemon 重启就改库
- uid 变化时调用 `rehomeRunner.run(newUid)` + `alignStartupRoutes(DATA_DIR, prevUid)`，覆盖所有切号路径
- 与 `/api/switch` 里的钩子并存，幂等（`affected=0` 时跳过、并发保护）
- 环境变量 `WORKDADDY_REHOME_POLL_MS` 可调间隔，`WORKDADDY_CDP_PORT` 可调端口

单元测试 `test/rehome-watcher.test.js` 用原子替换的临时 auth 文件验证：启动不触发、A→B 触发、重复 B 不触发、B→C 触发、明文显示名持久化。

### 10.4 生效步骤与当前结果

改动同步到**正在运行的安装版目录**并重启 daemon 后生效：

```powershell
# 1) 源码改动同步到安装版（运行的是这里，不是源码目录）
$src='H:\AI工作区\wb账号同步\WorkDaddy\scripts'
$dst="$env:LOCALAPPDATA\Programs\WorkDaddy\scripts"
'lib.js','daemon.js','rehome-sessions.js','rehome-watcher.js','workbuddy-exe.json' | ForEach-Object { Copy-Item "$src\$_" "$dst\$_" -Force }

# 2) 重启 daemon（watchdog 3 秒后自动拉起，WorkBuddy 客户端不受影响）
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*WorkDaddy*scripts*daemon.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

实测结果（12:32）：

```
[rehome] 账号变化监听已启动 interval=2000ms
[sync] 已备份账号 王冠林michael (a2099672-…)
watcher 启动之后解密失败次数: 0
POST /api/rehome/run {uid:A} -> affected=46, backup=…\workbuddy-20261110-123248-998.db
收敛后 sessions.user_id 分布: a2099672-… 74 条（原 A=28 / B=20 / C=26）
```

即 46 条历史会话已原地接管到当前账号，74 条普通会话现在只有一份归属。此后任意路径切号，watcher 会在 2 秒内自动把归属切到新账号；切号后侧栏若未即时刷新，点一次重载即可。

> **运维要点**：运行的是 `%LOCALAPPDATA%\Programs\WorkDaddy\scripts`，改完源码必须按上面第 1 步同步过去再重启 daemon，否则改动不生效。

---

## 11. 历史副本去重 + 与「自动复制」互斥

### 11.1 现象与根因

12:57 切到新账号（`721d1e45`）后，watcher 正常触发（`[rehome] 账号变化 a2099672 -> 721d1e45`、`affected=74`），但侧栏里很多会话出现三份。

排查结果：**副本是历史遗留，不是这次切号生成的**。示例 `FFRS崩溃研究` 三条记录的 `created_at` 是 11-04 / 11-08，消息 JSONL 大小完全相同（10,306,966 字节）—— WorkBuddy 的「自动同步所有会话」（`meta.json` 里 `autoCopy.allSessions: true`）历史上为每个账号复制过一份完整会话。之前按 `user_id` 隔离，每个账号只看到自己那份；rehome 把归属统一到当前账号后，三份就同时出现在侧栏。

接管范围内共 **27 组重复**（18 组 3 条、9 组 2 条），多余 45 条。

### 11.2 修复

**A. `dedupeSessions(db, dataRoot, opts)`（`rehome-sessions.js`）**

- 按 `(title, cwd)` 分组，组内每条都建立 `projects/**/<id>.jsonl` 索引
- **保守模式（默认）**：只有组内存在大小完全一致的「复制对」才认定为副本链，保留 `updated_at` 最新一条，其余写 `deleted_at` 软删；大小全不同的组跳过，避免误删独立演化的内容
- **aggressive 模式**（`{aggressive:true}`）：同组内每条都有消息文件即保留最新、软删其余，用于一次性清理已分叉的历史副本
- 软删而非硬删，配合 `VACUUM INTO` 备份可完整回滚

**B. 接入点**

- `execute()` 每次接管后自动跑一次保守去重；`run(..., {dryRun:true})` 返回 `dedupe: {groups, dropped}` 预览
- `runDedupe({dryRun, aggressive})` + `POST /api/rehome/dedupe` 独立入口
- `createRehomeRunner` 增加 `dataRoot: PROFILE.dataRoot`（WorkBuddy 状态根，用于定位消息文件）

**C. 与 WorkDaddy「自动复制」互斥（防止再生成副本）**

- `startRehomeWatcher()` 启动时检测 `getAutoCopyRules(...).allSessions`，为真则自动 `setAutoCopyAllSessions(DATA_DIR, false)` 并记日志
- `POST /api/sessions/auto-copy-all` 在 rehome 开启且请求 `enabled:true` 时返回 409
- `/api/switch` 里的 `autoCopyJob` 增加 `!rehomeActive` 条件
- 本机实测日志：`[rehome] 已自动关闭「自动同步所有会话」（与接管模式互斥，避免生成副本）`

**D. 顺带修正**：`alignStartupRoutes()` 之前误传 `DATA_DIR`（WorkDaddy 配置目录），实际 `startup-route.json` 在 `PROFILE.dataRoot`（`~/.workbuddy/<uuid>/`）。两处调用已改，启动落点对齐现在真正生效。

### 11.3 实测结果（13:08）

```
保守去重：20 组 / 软删 31 条，备份 workbuddy-dedupe-20261110-130628-007.db
剩余 7 组内容已分叉（最新副本持续追加，大小不同）→ aggressive 清理
aggressive：7 组 / 软删 14 条，备份 workbuddy-dedupe-20261110-130838-901.db

最终：剩余重复组 = 0
      有效普通会话 = 29 条，全部归属 721d1e45-…
      autoCopy.allSessions = False
      daemon PID 17904 / CDP connected
```

侧栏刷新后每个会话只显示一份。此后任意路径切号：watcher 2 秒内接管归属 → 自动保守去重 → 落点对齐，且自动复制保持关闭，不再产生新副本。

### 11.4 回滚

两份去重备份在 `%APPDATA%\WorkDaddy\rehome-backups\`。软删的记录可用 `UPDATE sessions SET deleted_at = NULL WHERE id IN (...)` 恢复（`ids` 在 `/api/rehome/dedupe` 响应里），或直接用备份库覆盖 `workbuddy.db`（先完全退出 WorkBuddy）。

### 11.5 测试

```
node test/rehome-sessions.test.js    # 归属接管 / 排除口径 / 备份 / 幂等 / 落点对齐
node test/rehome-watcher.test.js     # 账号变化监听
node test/rehome-dedupe.test.js      # 保守去重 / 大小不一致跳过 / aggressive / 幂等
```

三组全 PASS。

### 11.6 「自动同步所有会话」开关已绑定接管模式（13:57）

**背景**：该复选框原本是 WorkDaddy 上游功能 —— 切号时把当前账号会话**复制**成新 ID 副本写入目标账号（`setAutoCopyAllSessions` → `startAutoCopyJob` → 复制 JSONL / 产物 / 插一行 `sessions`），源账号保留。§11.1 的「三份」正是它历史上开启留下的产物。它与接管归属是同一目标、两种相反手段（复制 = 新 ID / 多份 / 会分叉；接管 = 一条 UPDATE / ID 不变 / 始终一份）。

YG 要求：**把这个开关直接绑定接管模式，去掉原功能，消除 UI 误操作入口**。

**改动**

- `scripts/bind-rehome-ui.py`（幂等，可重复执行；WorkDaddy 升级覆盖 `inject.js` 后重跑）对 `inject.js` 应用 21 处替换：
  - 复选框文案改「接管会话归属」，状态绑定 `sessionsState.rehomeEnabled`，点击 → `POST /api/rehome/config`
  - 删除后加的重复复选框 `#wbs-sess-rehome`，删除上游 `toggleAutoCopyAll` / `updateAutoCopyAllButton` 及其调用
  - 首次引导弹窗文案改「切换账号自动接管会话归属」，保存行为同步
  - `loadSessions` 的 silent 快照、逐会话复制勾选渲染、批量模式按钮态全部改用 `rehomeEnabled` / `rehomeBusy`
- `daemon.js`：
  - `POST /api/sessions/auto-copy-all` → `getRehomeRunner().setEnabled(...)`，返回 `autoCopyAll` 与 `enabled` 同为接管状态（保留路径以兼容上游前端调用）
  - `GET /api/sessions` 的 `autoCopyAll` 改为返回接管状态
  - `startRehomeWatcher()` 无条件 `setAutoCopyAllSessions(DATA_DIR, false)`，历史残留规则一并清掉
  - 两处 `startAutoCopyJob` 调用加 `!rehomeActive`，上游复制路径彻底停用
  - 移除 409 互斥拦截（现在同一个开关，无需拦截）

**实测（13:57）**

```
GET  /api/sessions          -> autoCopyAll=True  rehomeEnabled=True
POST auto-copy-all false    -> 200 {autoCopyAll:false, enabled:false}
     /api/rehome/status     -> enabled=false
     meta.allSessions       -> False
POST auto-copy-all true     -> 200 {autoCopyAll:true, enabled:true}
     /api/rehome/status     -> enabled=true
     meta.allSessions       -> False      # 原复制功能保持关闭
剩余重复组 = 0，有效普通会话 = 30
日志：[rehome] UI 开关 -> 接管模式 enabled=false / enabled=true
```

界面现在只有一个「接管会话归属」复选框，勾选状态即接管模式开关；原复制功能没有任何 UI 或后端触发路径。面板刷新后显示新文案。
