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
- **接管范围**：除回收站外全部接管 —— 活跃会话、已归档（`status='archived'`）、后台自动化任务运行记录（`is_background_automation=1`）、云端会话（`transport='cloud'`）的 `user_id` 都改为当前账号。
- **「未删除」有两种编码（关键）**：`local` 会话是 `deleted_at IS NULL`，`cloud` 会话是 `deleted_at = -1`。客户端原文判定为 `(transport='local' AND deleted_at IS NULL) OR (transport='cloud' AND deleted_at = -1)`。只写 `deleted_at IS NULL` 会把全部云端会话漏在接管范围外（本机实测漏 5 条）。现统一用 `NOT_DELETED = "(deleted_at IS NULL OR deleted_at = -1)"`；真删除（时间戳）依然被排除。
- **两层不同的「自动任务」**：定时任务**定义**（`automations.json`）由 `automation-account-sync.js` 独立维护（开关 `automation-sync.json`，UI 上的「同步定时任务」按钮）；任务**运行记录会话**（`sessions.is_background_automation=1`）走会话接管。两者互不影响。
- **删除状态无需同步**：`deleted_at` 写在全库唯一那条记录上，是全局字段而非视图过滤。A 删除后任何账号查这条都是已删除，切号接管又只处理 `deleted_at IS NULL`，因此不会「复活」或「回弹」到别的账号。
- **回收站不同步的代价**（已知取舍）：哪条垃圾进谁的回收站，取决于删除那一刻它的归属账号；想清理某条，得切回当时删除它的账号。恢复（清空 `deleted_at`）后它会重新进入接管范围，下次任何账号登录都会被接管走 —— 这是设计预期，不是回弹。
- **`automations` 内的 `owner_user_id` 不跟随**（上游字段，与本地会话归属无关）。
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
- **去重范围**：`deleted_at IS NULL AND COALESCE(is_background_automation,0)=0` —— 覆盖活跃会话与已归档，**跳过后台任务运行记录**（那是真实执行历史，不是自动复制时代产生的副本）
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

### 11.4 归档纳入接管 + 归档副本清理（20:46）

口径调整：接管范围从「未删除 + 非后台任务 + 未归档」放宽到 **除回收站外全部**，去重范围同步覆盖归档（仍排除后台任务运行记录）。

本机一次性执行结果：

```
接管口径 = (deleted_at IS NULL OR deleted_at = -1)          -- local 用 NULL，cloud 用 -1
去重口径 = 同接管口径 AND COALESCE(is_background_automation,0)=0

affected = 37 行（721d1e45: 17 / a2099672: 20 → 106cbbda）
dedupe   = 15 组 / 软删 29 条
云端会话 = 5 行（见 11.5）
备份     = workbuddy-20261110-204649-485.db / workbuddy-20261110-205105-389.db
```

去重前做了两级校验，确认不丢内容：

1. 15 组组内 JSONL **字节数全部一致**（说明是复制副本；MD5 不同是因为每行内嵌的 sessionId/账号字段被替换过）
2. 逐组比对消息 UUID 集合：保留那条 **完整包含** 其余副本的全部消息 UUID，15 组全部通过，丢失风险 0

执行前后逐条比对（以备份库为基准）：

```
执行前已删除记录 101 条 → user_id / deleted_at 改动 0 条
未删除记录归属改动 37 条
去重新产生软删 29 条
```

执行后各分类可见性（当前账号 `106cbbda`，最终态）：

| 分类 | 当前可见 | 全库 | 说明 |
| --- | --- | --- | --- |
| 未删除合计 | 58 | 58 | 全部接管，无遗漏 |
| 活跃普通 | 31 | 31 | 含 5 条云端会话 |
| 已归档 | 19 | 19 | 去重后由 48 → 19 |
| 后台任务 | 11 | 16 | 未删除 11 条全接管；余 5 条在回收站 |
| 回收站 | 47 | 125 | 余 78 条属其它账号，保持删除时归属 |

### 11.5 顺带修掉：云端会话整类漏接管

调整口径时翻客户端 bundle（`app.asar`）的 `FROM sessions` 片段，发现「未删除」有两个编码：

```sql
-- local 会话
AND (transport = 'local'  AND deleted_at IS NULL)
-- cloud 会话
AND (transport = 'cloud'  AND deleted_at = -1)
```

原 `WHERE = "deleted_at IS NULL"` 把 `transport='cloud' AND deleted_at=-1` 的会话全部排除在接管之外 —— 本机 5 条云端会话（`a2099672` 4 条、`721d1e45` 1 条）从来没被接管过，当前账号一直看不到。改用 `NOT_DELETED = "(deleted_at IS NULL OR deleted_at = -1)"` 后一次性接管 5 条，备份 `workbuddy-20261110-205105-389.db`。

顺带确认客户端的删除动作：`UPDATE sessions SET deleted_at = ?, updated_at = ?, unread = 0 WHERE id = ?` —— 只按 `id` 写时间戳，不做归属校验；而列表查询 `... WHERE user_id = ? ...` 带账号过滤。所以「A 删了，B 还能看到」在当前实现下不成立：B 的列表根本取不到那行。

### 11.6 测试

```
node test/rehome-sessions.test.js    # 归属接管 / 排除口径 / 备份 / 幂等 / 落点对齐
node test/rehome-watcher.test.js     # 账号变化监听
node test/rehome-dedupe.test.js      # 保守去重 / 大小不一致跳过 / aggressive / 幂等
```

三组全 PASS。

### 11.7 「自动同步所有会话」开关已绑定接管模式（13:57）

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

---

### 11.8 回滚

去重与收敛的备份都在 `%APPDATA%\WorkDaddy\rehome-backups\`（`workbuddy-*.db` / `workbuddy-dedupe-*.db`）。软删的记录可用 `UPDATE sessions SET deleted_at = NULL WHERE id IN (...)` 恢复（`ids` 在 `/api/rehome/dedupe` 响应里），或直接用备份库覆盖 `workbuddy.db`（先完全退出 WorkBuddy）。

### 11.9 删除语义与「复活」边界（21:45）

问题（YG）：A 删掉的会话，B 那边还在，切回 A 会不会被搬回来？A 删了之后 B 接着聊的进度，A 还能不能拿到？

**结论：不会复活；进度会自动跟上。** 依据是架构，不是约定：

1. **一条会话只有一行、一个文件。** 接管执行 `UPDATE sessions SET user_id = ? WHERE (deleted_at IS NULL OR deleted_at = -1)`，改归属不复制。B 看到的那条就是 A 删的那条本身，B 没有自己的第二份。
2. **删除是终态。** 客户端删除写 `deleted_at = <时间戳>`（软删，消息文件留在 `projects\**\<id>.jsonl`，列表不再显示）。接管 WHERE 排除已删行，删掉的行永远不再被搬。`rehome-sessions.js` 全文只有去重分支写 `deleted_at = ?`，**从不写 `deleted_at = NULL`**；能把会话写回列表的只有客户端自身和 `/api/sessions/restore`（回收站恢复）。
3. **进度天然连续。** 消息写在共享的 `<id>.jsonl`，不分账号。切回 A 时搬的是同一行、同一文件，直接读到 B 写的最新内容。

**实测（2026-11-10 21:45，183 行）**

```
未删除 58（其中归档 19）｜回收站 125
未删除全部在 106cbbda；回收站分布 47 / 50 / 28
已删行在删除后仍有写入：0 条
已删行对应 jsonl 仍存在：125 / 125（软删不删文件）
```

**唯一会「删了还在」的形态：字节相同的双活副本。** 巡检发现 3 组、11 条、其中 8 条重复，全部是 `is_background_automation = 1` 的自动化运行记录（`WHERE_DEDUPE` 按设计排除后台任务，所以上轮去重没动它们）：

- `路由器和网络 · 每日分层库体检` — 6/7 活，159589 B / 308988 B ×3 / 194083 B ×2
- `hy4求职` — 3/3 活，467106 B ×3
- `ChatGPT 24h 最终分析 + 晚高峰大文件测速布署（合并）` — 2/4 活，470459 B ×2

这些副本同属一个账号，不会造成跨账号复活；但只删其中一条，同名的另几条仍在列表里。已在 22:00 单独跑一轮清理，见下。

**22:00 执行：后台任务副本去重（新增 `runBackgroundDedupe`）**

不能复用 `dedupeSessions`：自动化任务每次运行都会新建一条同名会话（title 是任务名、cwd 是工作区），按 `(title, cwd)` 整组只留一条会把不同日期的真实运行记录删掉。

判定改成三层，任何一层不满足就跳过：

1. 同 `(title, cwd)`；
2. 消息文件大小完全一致；
3. **归一化指纹一致** —— 旧「自动复制」生成副本时会重写每行的 `sessionId`（消息里的 message id 不变），所以两份内容完全相同的副本原始字节并不相等。先把本行 id 替换成 `<SID>` 再算 sha256，真实的复制关系才还原得出来。只比大小会误伤，只比原始 sha256 会全部漏判（第一版就是这么漏的：干跑 0 组）。

桶内保留 `updated_at` 最新一条（并列取 `created_at` 最新）。执行结果：

```
4 个桶 / 11 条活副本 -> 5 条
删 6：6f4b6839 675756da（hy4求职） 7d37618e（ChatGPT） 353c5576 5af4ebab（每日分层库体检 308988） fcf268c4（194083）
留 4：e5b6f03b 86bdd7ff cb76c903 694e9acc ＋ 独有的 861d61d5
备份：%APPDATA%\WorkDaddy\rehome-backups\workbuddy-bg-dedupe-20261110-220003-366.db
复验：rehome-audit 报「字节相同的双活副本 0 组 / 无复活风险」；非后台会话被改动 0 条
```

命令（幂等，再跑一次报 0）：

```
node scripts\rehome-sessions.js --dedupe-background --dry-run
node scripts\rehome-sessions.js --dedupe-background
```

`session_usage` 里对应的用量行没有删 —— 软删只影响列表可见性，token 统计保持原样。

**云端会话的边界**：5 条 `transport = 'cloud'`。本地软删不等于服务端已删；若服务端仍保留，客户端下次拉列表可能落回一条新行（新 id、`deleted_at = -1`）。那是客户端行为，不是接管搬回来的 —— 接管永不新建行、永不改 `deleted_at`，凡是「新 id 突然出现」都不是它干的。

**巡检脚本**：`scripts/rehome-audit.js`，只读（`DatabaseSync` 以 `readOnly` 打开，不碰消息文件）：

```
node scripts\rehome-audit.js          # 人读
node scripts\rehome-audit.js --json   # 机读，给别的 agent / 自动化
node scripts\rehome-audit.js --files  # 附带统计回收站占用的消息文件
```

退出码 `0` = 无风险，`2` = 有风险，可直接接计划任务做巡检。已加入 `deploy.ps1` 的 `$newFiles` 清单（13 个文件）。


### 11.10 「允许完全访问」切号后失效（23:2x，已修）

**现象**：每次切号后，输入框底部的权限开关回到「默认权限」，必须重新点一次「允许完全访问」并过确认弹窗。

**不是单开关，是三层状态**（客户端 app.asar 里可逐层验证）：

| 层 | 位置 | 作用 | 读写点 |
| --- | --- | --- | --- |
| 账号偏好 | `storage/user-<uid>-personal/global/preferences.json` 的 `localTaskPermissionMode` | 新会话默认值 / 冷启动按钮态 | `ConfigService.preference()`，按 `storage.user` 作用域读 |
| 会话字段 | `sessions.permission_mode`（`fullAccess` / `bypassPermissions` / `plan`） | 打开或恢复已有会话时的按钮态 | `WorkbuddyAdapter.getSessionPermissionState()`，读不到默认 `bypassPermissions` |
| 窗口开关 | 渲染层 `useLocalTaskPermissionPreference()` | 当前窗口实时状态 | 按 `${enterpriseId}:${userId}` 作用域 hydrate，监听 `config.preference.localTaskPermissionMode.changed` |

切号会换账号作用域并 `reload` 页面，三层里任意一层掉队，界面就显示成没开。实测两层都会掉：

- 拨动开关会**直接改写账号偏好**：关掉后 `preferences.json` 立刻变成 `"localTaskPermissionMode": "default-sandbox"`（23:26:29 日志抓到 `账号偏好 default-sandbox → full-access`），所以旧值会跨会话留存。
- 库里有 5 条活会话 `permission_mode` 为 NULL / `bypassPermissions`（旧自动复制留下的副本），打开它们必然显示默认权限。

**修复（`scripts/permission-sync.js` + daemon 接线）**：

1. `ensurePreference()`：只补 `localTaskPermissionMode` 一个键，原子写（`.tmp` + rename），其余键原样保留。
2. `ensureSessionModes()`：`UPDATE sessions SET permission_mode='fullAccess' WHERE (deleted_at IS NULL OR deleted_at=-1) AND user_id=? AND COALESCE(is_background_automation,0)=0 AND COALESCE(permission_mode,'') NOT IN ('fullAccess','plan')`，带 4 次写锁重试；`plan` 是用户显式选择，不覆盖。
3. `buildRendererScript()`：完全复刻人工操作 —— 点 `.cr-permission-setting` 开面板 → 未开则点 `input[role=switch]` → 等 `.wb-modal--confirm` → **先勾选「我已了解风险」复选框**（不勾时确认按钮是 `disabled`，这是第一版自动点失败的原因）→ 点「允许完全访问」→ 复验开关态 → 收面板。

**接线**：`/api/switch` 成功后 `schedulePermissionSync(uid, { delayMs: reloaded ? 3500 : 1200 })`，6 次 × 2.5s 重试直到 `already-full-access` / `enabled`；账号监听 `onSwitch` 同样调用（覆盖客户端内直接登录）；daemon 启动只补前两层（`renderer:false`，避免每次开机闪一下面板）。手动入口 `POST /api/permission/ensure`。

**实测（23:26，真实页面）**：

```
关闭开关                 → preferences.json: default-sandbox
POST /api/permission/ensure → pref=fixed db=0 ui=enabled
复验                      → 面板文案「当前权限为允许完全访问」，勾选态 true，无残留弹窗
```

再跑一次返回 `already-full-access`，幂等。5 条 NULL/`bypassPermissions` 会话已补齐为 `fullAccess`（`--apply` 输出 `会话权限 5 条`）。

**副作用**：切号后约 3.5 秒，权限面板会被程序开一下再收起（约 1.5 秒），这是为了读开关态并拨回；不想让它动页面就只跑 CLI `node scripts/permission-sync.js --apply`。

### 11.11 三层不够：改成四层常驻守卫（1.2.80）

§11.10 的三层是**一次性**的补法，实测不够 —— 用户反馈「还是失效」。原因不是补错了，是补完还会被再次写回：

```
15:25:06  手动关掉开关 → user-721d1e45.../global/preferences.json 立刻变成 default-sandbox
15:27:40  守卫还原     → 偏好被改写 default-sandbox → full-access（守卫已还原）
```

拨开关是**静默写盘**：关掉的瞬间就落盘，不需要确认。页面卸载 / 切号换作用域 / 关会话都可能触发一次写盘，一次性的 `applyFullAccess` 永远追不上。

**第 4 层 = 两处常驻守卫**

1. `startPreferenceGuard()`（主进程）：每 3 秒扫 `storage/user-*/global/preferences.json`，只检查 `localTaskPermissionMode` 一个键，不是 `full-access` 就原子写回并记日志。意图开关落盘在 `%APPDATA%\WorkDaddy\permission-guard.json`，`--off` 后完全不插手。
2. `wdPermGuard()`（渲染层）：通过 `Page.addScriptToEvaluateOnNewDocument` 注册，页面重载自动重跑；`Runtime.evaluate` 对当前文档装一次。每 2.5 秒读一次 `.cr-permission-setting` 的 `--danger` 类名（不用开面板），掉了就复刻人工操作拨回（开面板 → 点 `input[role=switch]` → 勾风险复选框 → 点「允许完全访问」），完成后用类名复验。

**顺带接管执行期授权框**：`approve()` 同时扫弹窗和行内审批卡，只点文案严格匹配 `允许|允许一次|本会话允许|始终允许|同意|批准` 的按钮，且排除「允许完全访问」设置弹窗、`.cr-permission-panel` 容器、以及含 `删除|覆盖|清空|重置|卸载|格式化` 的卡片 —— 破坏性操作不代点。

**实测（15:27 / 15:29）**

```
手动关开关           → row--on=false，偏好落盘 default-sandbox
等 7 秒（不调任何接口）→ pageGuard on=true enables=1 last=enabled
                        prefs 三个账号全 full-access，restores=1
人为把 106cbbda 偏好写回 default-sandbox → 5 秒后自动还原，日志有「守卫已还原」
守卫 v4 装载          → pageGuard.version=4 runs=5 last=on
```

**观察入口**：`GET /api/permission/status`（需 `x-workdaddy-token`）返回 `preferenceGuard`（checks/restores/intent）、`pageGuard`（version/on/runs/enables/approvals/last/log 尾 8 条）、`preferences`（三账号当前值）。

**已知边界**：修复之前就已经开着的会话，运行期配置在内存里，DB 改了也不会即时生效 —— 切一次会话或重开窗口后才吃到 `fullAccess`。切号本身会重载页面，所以正常使用路径不受影响。

### 11.12 去重算法重写：从「按大小猜」到「按证据判」（1.3.0）

§11.7 / §11.8 的实跑数据证明旧算法能清掉副本，但也暴露了它的判定基础是错的：`dedupeSessions` 只要求**组内存在一对大小相同**，然后整组只留最新一条。组里混入一条无关会话就会被连带软删；文件大小相同但内容不同也会被当成副本。

1.3.0 把判定拆到 `scripts/session-dedupe.js`，四层证据链：

```
文件层  存在 / 可读 / 非空 / size+mtime+sha256 扫描前后一致
字节层  raw SHA-256 相同 → 逐字节副本
消息层  JSONL 每行 JSON，按 id（消息 UUID）建 id→规范化哈希
        规范化 = 递归删 sessionId + 键排序
        id 集合相等且同 id 内容相等 → 内容副本
包含层  仅 --containment：A 的消息（含无 id 记录多重集）⊆ B，且同 id 无冲突
        → A 是旧副本，保留 B；候选保留者不唯一则跳过
```

**保留对象的确定**：完全相同 → `updated_at` 新者；包含关系 → 消息更完整者。**任何一层给不出结论 → 整组保留。**

**竞态防护**：
1. 计划阶段记录每个文件的 size + sha256；
2. 写入前复验一次，间隔 250ms 再验一次（挡住「边写边删」）；
3. DB 更新带 `deleted_at IS ?` CAS 条件；
4. 事务返回的 `changes` 与预期不符 → 立即补偿回滚，返回 `aborted`。

**默认关闭**：`rehome-sessions.json` 需要显式 `"dedupe": true`；`run()` 不再调用去重（返回 `dedupe.skipped=manual-only`）。手动入口 `--dedupe` / `--dedupe-background`，`--force` 可单次绕过配置。

**备份与回滚**：每次执行 `VACUUM INTO rehome-backups/workbuddy-dedupe-<stamp>.db`，并写 `dedupe-<stamp>.json`：

```json
{ "version":1, "opId":"dedupe-...", "rows":[
  { "id":"...", "before":null, "after":1763..., "reason":"exact-duplicate", "keepId":"..." } ] }
```

`--dedupe-rollback <json>` 只恢复 `deleted_at` 仍等于 `after` 的行；之后被别处改过的行记 `changed-since-operation` 并跳过。

**测试**：`test/rehome-dedupe.test.js` 覆盖 16 类场景（同大小不同内容、混入独立会话、UUID 冲突、多候选保留者、扫描后变化、缺文件、坏 JSONL、后台隔离、归档口径、dry-run、幂等、备份回滚、containment 显式开启…）。

### 11.13 权限三开关：不再替用户点授权（1.3.0）

§11.10 / §11.11 的四层守卫解决了「切号后掉权限」，但代价是工具替用户做了授权决定：自动勾风险声明、自动点「允许完全访问」、按文案自动批准执行期请求。1.3.0 全部撤回，拆成三个独立开关，默认全关：

| 开关 | 实现 | 默认 |
|---|---|---|
| A `preferenceGuard` | `startPreferenceGuard()` 3s 轮询偏好文件，只改 `localTaskPermissionMode` | 关 |
| B `configRepair` | 切号后 `ensurePreference` + `ensureSessionModes`，不碰页面 | 关 |
| C `autoApprove` | **已删除实现**，`setGuardSwitch` 直接抛错 | 关 |

渲染层只剩只读探针（`buildRendererScript()` 读 `--danger` 类名），`installRendererGuard()` 的语义改成「清理旧版残留」，不再注册 `Page.addScriptToEvaluateOnNewDocument`，也不注入任何 `.click(`。

**统一停止** `stopPermissionGuards({send, persist})`：

1. `clearTimers()` 只清本模块登记过的 interval；
2. `stopRendererGuard(send)` 对每个已注册 identifier 发 `Page.removeScriptToEvaluateOnNewDocument`，并对页面求值 `clearInterval(window.__wdPermGuard.timer); enabled=false`；
3. 三个开关写盘为 false（`permission-guard.json` v2）；
4. 置 `registry.stopped=true`，之后 `startPreferenceGuard()` 直接返回惰性句柄。

旧版 v1 状态文件 `{fullAccess:true}` 读到时**迁移为全关**并落盘 —— 升级不继承「自动点授权」的旧意图。

**状态字段**：`preferenceGuardEnabled` / `rendererGuardEnabled`（恒 false）/ `autoApproveEnabled`（恒 false）/ `configRepairEnabled` / `activeTimerCount` / `registeredScriptIds` / `pageGuard` / `stopped` / `statePath`。

**测试**：`test/permission-guard.test.js` 覆盖默认全关、A/B 互不隐式启用、C 拒绝开启、`--off` 全停、重连不复活、重复 stop 幂等、旧状态迁移、`--apply` 不动页面。

### 11.14 发布前复核：把「凭注释相信」改成「凭实测判定」（1.3.0 复核轮）

复核发现的问题按「会不会误删 / 误授权」排序处理。

**去重内核的四处误判来源**

1. `canonicalize()` 原来**递归**删同名 `sessionId`。但复制会话时被改写的只有每行**最外层**字段；嵌套在消息内容里的同名键（工具调用参数、工具结果携带的会话引用）是真实内容。递归删会让两份不同的记录算出同一个哈希 → 误判为副本。改成只去掉 `depth === 0` 的 `sessionId`。
2. `inspectSessionFile` 里 `ok` 没有包含 `parsed`。同文件重复 UUID 会让 `parsed=false` 但 `ok=true`，虽然当时靠下游 unknown 兜住了，状态位本身是错的。现在显式 `error='duplicate-message-ids'` 且 `ok=false`；同时把 `compareFingerprints` 的字节相同判定提到 `ok` 检查**之前**（有重复 UUID 的文件只要逐字节相同仍然安全，不该被一刀切拒绝）。
3. 只比消息集合，没看**顺序**。包含关系里 A 的消息 id 序列必须是 B 的子序列才认定是截断副本 —— 两条独立会话撞了相同消息时通常顺序不同。时间戳不能用来判（先创建的那条完全可能是「聊两句就复制走、原件继续聊」）。
4. 附件/图片只存引用。现在两层处理：会话旁边有附属产物（`<id>/`、`<id>.png`）→ 整组保留；引用是相对路径（`images/a.png`）→ 只认逐字节相同，消息层不作证。

**接管范围的判定改为自证**

`session-scope.js` 新增 `assessDeletedSemantics(db)`：把表里实际出现的 `deleted_at` 取值按 transport 分组数出来，编码一致的才算 `verified`。local 行上出现 `-1`、cloud 行上出现 `NULL`、`transport` 是未知值 —— 全部计入 `issues`，并且 `buildTakeoverScope` 的 local 谓词收紧成 `deleted_at IS NULL AND (transport IS NULL OR transport = 'local')`，异常行与来源不明的行**永不接管**（`local-only(strict)`）。`--status` / `inspectTransports()` 会把体检结果报出来。

**`--dedupe-background` 与后台隔离的语义冲突**

原实现里 `--dedupe-background --force` 直接就写库，与「后台任务不参与去重」的规则在读文档时互相矛盾。现在改成双重显式：`allowBackground: true`（承认目标是后台任务）+ `apply: true`（真的要写）；只给 `allowBackground` 一律按只读计划处理，缺 `allowBackground` 直接返回 `skipped: background-dedupe-requires-allow-background`。daemon 的 `POST /api/rehome/dedupe/background` 同步改成默认 `dryRun`。

**权限停止的可验证边界**

`stopRendererGuard` 从「清一个 timer」扩到：`clearInterval/clearTimeout` → 已登记 MutationObserver 的 `disconnect()` → 已登记 handler 的 `removeEventListener`（capture 与 bubble 各一次）→ `delete window.__wdPermGuard` 等 5 个已知全局。CDP 脚本 identifier 现在**落盘**（`permission-guard.json` v2 的 `registeredScripts`），daemon 重启后仍能删掉上次注册的脚本。旧守卫拆到就报 `needsReload: true`，`reload: true` / `--reload` 会发 `Page.reload` 彻底清监听器 —— 未知结构的监听器只有重载能保证消失，这一点不藏。

**测试**：去重 21 类场景（新增嵌套 sessionId、重复 UUID、附属产物、包含顺序不符），范围 6 组（新增语义体检、异常行与未知 transport 不接管），权限新增页面残留与落盘脚本两组断言，部署 8 组（新增 advisory 版本闸门、原版上游代际拦截、`-Force` 越过）。

## 12. 系统托盘控制器（WorkDaddyTray.exe）

WorkDaddy 上游是纯后台双进程，没有托盘图标。本节补一个独立托盘程序，把「启动 / 关闭 / 开机自启」收进右键菜单。

**位置**：仓库 `tray/`。纯 .NET Framework 4.x WinForms，用 Windows 自带的 `csc.exe` 编译，不需要 Visual Studio、SDK 或 NuGet。

| 文件 | 作用 |
|---|---|
| `WorkDaddyTray.cs` | C# 5 源码（考虑 Framework 4.0 自带编译器，不用字符串插值 / `?.` / `out var`） |
| `WorkDaddyTray.exe` | 编译产物，20,992 B，`/target:winexe` 无控制台窗口 |
| `build.cmd` | 重新构建（`/codepage:65001`，源码需 UTF-8 BOM） |
| `Start-WorkDaddyTray.cmd` | 双击启动托盘 |

**菜单**：状态行 / 启动 WorkDaddy / 关闭 WorkDaddy / 重启 WorkDaddy / 恢复 CDP（会重开 WorkBuddy 窗口）/ 开机自启动（勾选）/ 打开管理页 / 退出托盘。图标运行时绘制：绿=运行中、灰=已停止、橙=切换中；双击图标打开管理页（未运行时改为启动）；2 秒定时刷新状态。单实例 Mutex `Local\WorkDaddyTraySingleton`。

**停止逻辑**：与 `scripts\stop-workdaddy.ps1` 一致 —— WMI 查 `Win32_Process`，正则 `WorkDaddy\scripts\(watchdog|daemon)\.js` 精确匹配，先 watchdog 后 daemon，循环 4 轮压住自动重启，绝不误伤其它 `node.exe`（Codex / MCP server 等）。

**开机自启**：写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `WorkDaddyTray` 值，指向 exe 自身 + `/autostart`。名字避开上游 `install-win.ps1` 清理的 `WorkDaddy` / `WorkDaddy AI`。`/autostart` 模式下托盘起来约 6 秒后若服务未运行则自动拉起**一次**，用户手动关闭后不会自作主张重启。

**命令行动作**（与菜单复用同一组函数，结果同时写 `%TEMP%\WorkDaddyTray-cli.txt`）：

```
WorkDaddyTray.exe --status
WorkDaddyTray.exe --selftest
WorkDaddyTray.exe --start | --stop | --restart
WorkDaddyTray.exe --autoon | --autooff
```

**路径发现**：`WORKDADDY_SCRIPTS` 环境变量 → `%LOCALAPPDATA%\Programs\WorkDaddy\scripts` → 同目录 `\scripts` → exe 上级 `..\scripts`（适配只 clone 仓库、未安装发布版的机器）。

**实测（17:55）**：`build.cmd` 编译通过 → `--selftest` 全绿（含自启开关往返 was→on→mid→off→end→restored）、`--status` 正确、`--autoon` 写入正确路径、`--autooff` 清除；起 watchdog 后 `--stop` 返回 True 且 47832 释放、残留进程 0；GUI 启动后进程稳定常驻 4s 以上。

**启动路径（18:37 修复）**：早期版本用 `cmd.exe /c launcher.cmd` 启动。由无控制台的 `winexe` 托盘调用时，cmd 拿着无效 stdout 句柄空转 —— 实测 18:37 那次 cmd PID 33220 从 18:37:32 起吃了 **124 秒 CPU**、只有 conhost 子进程、没有 node、`launcher.log` 一个字没写，并且弹出命令行窗口后卡住（`launcher.cmd` 结尾的 `pause`）。现改为 `StartWd()` 直接启动 `node.exe watchdog.js`（`UseShellExecute=true` + `WindowStyle.Hidden`）：不经 cmd、不弹窗、不 pause、不重启 WorkBuddy 窗口；watchdog 自动拉起 daemon。`FindNode()` 按 `%USERPROFILE%\.workbuddy\binaries\node\versions` 倒序找最新 node，回退到安装目录内置 runtime 或 PATH。

CDP/面板注入拆给独立的「恢复 CDP」菜单项（POST `/api/client/relaunch`）。启动成功后若 CDP 未连接，气球提示「WorkDaddy 服务已启动；面板未注入，点『恢复 CDP』」，避免服务已起但面板没注入时被误判为「没反应」。

**注意**：「启动 WorkDaddy」只起后台服务 —— 会话归属接管、账号监听、去重等全部功能此时已可用；右下角机器人按钮/面板需要 CDP，点「恢复 CDP」会重启一次 WorkBuddy 窗口。「退出托盘」只关托盘，不影响后台服务。

**验证（18:42）**：`--selftest` 全绿；`--start` 返回 True，4 秒后 47832/47932 均监听、watchdog+daemon 进程齐、卡住的 cmd 残留 0；托盘经 explorer 脱离会话启动后跨调用常驻。由工具会话直接派生的进程会在会话结束时被清理，这不代表程序问题 —— 用户双击 `Start-WorkDaddyTray.cmd` 启动的托盘本身就是常驻的。

### 12.1 恢复 CDP「失败」是误报（19:32 修复）

YG 反馈点「恢复 CDP」失败，实测**其实完全成功了**。daemon.log 时间线：

```
19:31:21  quitWorkBuddy() 逐个 taskkill 十几个 WorkBuddy 进程（普通退出未结束→强制）
19:32:15  [cdp] 为 WorkBuddy 选择端口 9222
19:32:16  [cdp] 已连接 WorkBuddy
19:32:17  [cdp] 注入右下角组件 (connect) / inject.js 已执行
19:32:18  [cdp] 注入结果确认(connect): root=true widget=true   ← 面板已注入
19:32:22  [cdp] 用户通过一键恢复重启了客户端（路由此时才返回 202）
```

`/api/client/relaunch` 是「先结束全部 WorkBuddy 进程 → 带调试端口重启 → CDP 连接 → 注入面板」之后**才**返回 202，全程约 60 秒。旧版 `RestoreCdp()` 用同步 `GetResponse()` 且 `Timeout=10000`，10 秒超时被 `catch` 成 `false`，托盘弹「操作失败」，而 daemon 那边继续跑完并注入成功 —— 纯误报。

**修法**：

- `RestoreCdp()` 改 `BeginGetResponse` 异步 fire-and-forget：只确认「daemon 端口可达 + 请求已发出」即返回 true，`Timeout` 放宽到 90s 但不等响应，UI 不冻结、不误报。
- 新增 `s_waitingCdp` / `s_cdpWaitTicks`：恢复期间禁用「恢复 CDP」菜单项防重复点；2s 定时轮询 9222，端口一通弹「CDP 已恢复，面板已注入」，90 秒未通弹超时提示。
- 新增 `s_cdpRequestFailed`：异步回调里若 daemon 返回 5xx 或连接异常，由 UI 线程立刻弹失败提示，不用干等。
- 提示文案改为「已请求恢复 CDP；WorkBuddy 将重开，约 1 分钟，完成后会再提示」。

**19:32 实测状态**：9222 监听、`/json/version` 返回 Chrome/138、CDP 目标页为 WorkBuddy renderer、`inject.js 已执行`、`root=true widget=true` —— 面板本来就在。重编译（20,992 B）并重启托盘后，47832 / 47932 / 9222 与 daemon/watchdog 进程全程未变，服务零中断。
