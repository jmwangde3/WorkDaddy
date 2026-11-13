# WorkDaddy 多账号接管 · 交接文档

> **给接手 agent 的唯一入口。读完这一份就能开工，不必先读全库。**
> 更新：2026-11-10 21:00 · 交接人：小码酱 · 接手人：[待填]

---

## 0. 一句话与当前状态

在一台 Windows 机器上，让 **3 个 WorkBuddy 账号共享同一套本机会话**：切号后所有会话（活跃 / 归档 / 云端 / 定时任务运行记录）原地改归属到当前账号，**不复制、不改会话 ID、始终只有一份**。

**当前状态：已上线可用。** daemon + watchdog + 托盘都在跑，全部历史数据已收敛，远端已推送。

---

## 1. 背景：为什么不用上游的「复制会话」

上游 WorkDaddy 切号时把当前账号的会话**复制**一份给目标账号（新 ID、新 JSONL、源账号保留）。三个账号切几轮之后，同一条会话在库里出现三份，侧栏三倍重复，内容还会各自分叉。

本项目改为**原地改归属**：一条 `UPDATE sessions SET user_id = ?`，会话 ID 不变、消息文件不动、产物不动。

两层必须分清：

- **状态共享不需要同步** —— `status`（归档）、`deleted_at`（删除）是那唯一一条记录上的字段，A 改了 B 读同一条记录天然就是该状态。
- **可见性需要同步** —— 客户端列表查询带 `user_id = ?` 过滤，不改 `user_id` 就看不到。这才是接管要解决的问题。

---

## 2. 机器环境（硬事实，别猜）

| 项 | 值 |
| --- | --- |
| 仓库 | `H:\AI工作区\wb账号同步\WorkDaddy` |
| 远端 | `https://github.com/jmwangde3/WorkDaddy`（fork 自 `babygoton/WorkDaddy`） |
| **运行中的代码** | `C:\Users\jmwan\AppData\Local\Programs\WorkDaddy\scripts`（**不是**仓库目录） |
| 配置与数据 | `C:\Users\jmwan\AppData\Roaming\WorkDaddy` |
| 会话库 | `C:\Users\jmwan\.workbuddy\workbuddy.db`（SQLite，WAL） |
| 消息文件 | `C:\Users\jmwan\.workbuddy\projects\<workspace>\<session-id>.jsonl` |
| node | `C:\Users\jmwan\.workbuddy\binaries\node\versions\22.22.2-6\node.exe`（≥22.13，需要 `node:sqlite`） |
| 客户端 | `H:\Program Files\WorkBuddy\WorkBuddy.exe`（profile id = `workbuddy-cn`） |

**端口**

- `47832` — daemon HTTP/API（管理页 `http://127.0.0.1:47832/`）
- `47932` — watchdog 单实例锁（`exclusive: true`，抢不到就说明已有 watchdog）
- `9222` — CDP，面板注入用；**必须随 WorkBuddy 进程启动带 `--remote-debugging-port`**

**三个账号**

| uid 前缀 | 昵称 | 备注 |
| --- | --- | --- |
| `106cbbda…` | `157****5718` | 当前登录 |
| `a2099672…` | `王冠林michael` | |
| `721d1e45…` | 未知 | `account-display.json` 里没有，昵称可能显示为 uid |

完整 uid 见 `%APPDATA%\WorkDaddy\account-display.json`；当前登录 uid 明文在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` 的 `account.uid`（token 是加密信封，uid 不是）。

**开关**

```json
// %APPDATA%\WorkDaddy\rehome-sessions.json
{ "enabled": true, "dedupe": true }

// %APPDATA%\WorkDaddy\automation-sync.json
{ "enabled": true }
```

---

## 3. 架构与数据流

三层，我们只碰第三层：

1. **WorkBuddy 客户端** — Electron，直读 `workbuddy.db`，列表带 `user_id` 过滤；删除 = 写 `deleted_at` 时间戳。
2. **WorkDaddy daemon**（上游，Node）— 账号备份/切换、CDP 注入、面板 UI、管理页。
3. **本项目补丁层** — 接管 + 去重 + 托盘。

**切号后的完整链路**

```
用户在客户端切号 / WorkDaddy「无感登录」/ 外部替换 auth 文件
        ↓
auth 文件被原子替换（temp + rename）
        ↓
rehome-watcher.js 每 2 秒轮询该文件，读到新 uid
        ↓
rehome-sessions.js run(newUid)
        ├─ VACUUM INTO 备份（有改动才做）
        ├─ UPDATE sessions SET user_id = newUid WHERE <NOT_DELETED>
        ├─ dedupeSessions()（可选，见 §5.5）
        └─ alignStartupRoutes()  把 startup-route.json 硬链接对齐
        ↓
侧栏刷新即见全部会话（若未刷新，点一次重载）
```

`watcher` 是刻意用轮询而非 `fs.watch`：Windows 上原子替换的 watch 事件会丢。

**工作区落点共享（第二条腿）**

接管只管会话归属。要让三个账号「打开的是同一个会话」，还有两个文件用 **NTFS 硬链接**共享同一份内容：

| 文件 | 作用 |
| --- | --- |
| `~/.workbuddy/<uid>/startup-route.json` | 客户端启动时打开的会话 |
| `~/.workbuddy/user-<uid>-personal/MEMORY.md` | 用户级长期记忆 |

首次建立用 `scripts/setup-rehome.ps1`（取内容最大/最新的那份当 master，其余换成硬链接，原件备份）。之后每 `fsutil hardlink list <path>` 应看到 3 条路径。

客户端写这两个文件时若用「临时文件 + 原子替换」，硬链接会断。`alignStartupRoutes()` 会在每次切号后用 `fs.writeFileSync` **原地写**（保持 inode）把三个落点重新对齐 —— 但只在切号时触发，长期不切号就可能一直是断的（见 §7 实测）。

检测与修复：

```bash
# 检测：三个 inode 应完全相同
for d in /c/Users/jmwan/.workbuddy/*/; do ls -i "$d/startup-route.json" 2>/dev/null; done
for d in /c/Users/jmwan/.workbuddy/*personal*/; do ls -i "$d/MEMORY.md" 2>/dev/null; done

# 修复（会以最新的那份为准覆盖其余两个，原件自动备份）
powershell -ExecutionPolicy Bypass -File scripts\setup-rehome.ps1
```

---

## 4. 文件地图（改哪里）

**本项目新增 / 修改的文件**（其余都是上游的，除非明确需要否则别动）

| 文件 | 作用 | 改动风险 |
| --- | --- | --- |
| `scripts/rehome-sessions.js` | 接管 + 去重核心。`NOT_DELETED` / `WHERE_DEDUPE` 两个口径常量在这里 | **高** — 改错会误改/误删全库 |
| `scripts/rehome-watcher.js` | auth 文件轮询、账号快照写 `account-display.json` | 中 |
| `scripts/rehome_sessions.py` | 不依赖 Node 的独立 CLI 版（同口径） | 中 — 必须与 JS 版同步 |
| `scripts/daemon.js` | 上游主服务；本项目加了 rehome 接入点、`/api/rehome/*` 路由、relaunch | **高** — 724 KB，改动只加不删 |
| `scripts/inject.js` | 注入 UI（含「接管会话归属」「同步定时任务」两个按钮） | 中 — 1.4 MB，改文案用 `bind-rehome-ui.py` 而非手改 |
| `scripts/bind-rehome-ui.py` | 幂等脚本：对 `inject.js` 应用固定替换集；**上游升级覆盖 inject.js 后必须重跑** | 低 |
| `scripts/tray/*` | 托盘（C# 5 + `csc.exe`，无需 SDK） | 中 — 改 `.cs` 后必须 rebuild |
| `tray/WorkDaddyTray.exe` | 20,992 B 预编译产物，**直接提交进仓库** | 低 |
| `test/rehome-*.test.js` | 三组回归测试（纯临时库，不碰真实数据） | 低 |
| `scripts/lib.js` | 上游文件，改了 2 处：① 读 `workbuddy-exe.json` 支持非 C 盘安装 ② CDP 明文兜底显示昵称 | 中 |
| `scripts/win-launcher.js` | 上游文件，修 `taskkill` 非零导致 relaunch 中途放弃（改为延迟复验后放行） | 中 |
| `scripts/workbuddy-exe.json` | **本机专用**：客户端实际路径 `H:\\Program Files\\WorkBuddy\\WorkBuddy.exe`。换机器必须改 | 低 |
| `scripts/fix-cdp.cmd` / `setup-rehome.ps1` / `stop-workdaddy.ps1` | 一次性运维脚本：修 CDP / 建 startup-route 硬链接 / 停服务。不参与常规运行 | 低 |
| `deploy.cmd` / `deploy.ps1` | **一键部署**：定位安装目录 → 校验 14 文件 → 按时间戳备份 → 复制 → 绑 UI → 重启 daemon → 轮询 47832。上游升级后跑一次即恢复 | 低 — 幂等；改了要实测一遍再提交 |
| `README.md` | **入门文档**（408 行），给不熟悉项目的人看：痛点 → 三步安装 → 托盘菜单 → FAQ | — |
| `README_UPSTREAM.md` | 上游原版 README 存档，完整功能清单 | — |
| `REHOME-README.md` | **主文档**，37 KB / 12 章，所有坑与实测都在里面 | — |

**别碰**：`scripts/theme-patches.js`、`scripts/persona.js`、`scripts/growth-*.js` 等上游功能文件。

---

## 5. 必须知道的 10 条硬知识

每一条都是踩出来的，改之前先看。

### 5.1 改的是仓库，跑的是安装版

仓库里改完 **不会生效**。必须：

```powershell
# 1) 同步（只同步你改的文件）
$src='H:\AI工作区\wb账号同步\WorkDaddy\scripts'
$dst='C:\Users\jmwan\AppData\Local\Programs\WorkDaddy\scripts'
Copy-Item "$src\rehome-sessions.js" $dst -Force

# 2) 重启 daemon（watchdog 会自动拉起，WorkBuddy 客户端不受影响）
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'WorkDaddy[\\/]scripts[\\/]daemon\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### 5.2 「未删除」有两种编码（最坑的一条）

客户端原文：

```sql
(transport = 'local' AND deleted_at IS NULL)
OR (transport = 'cloud' AND deleted_at = -1)
```

`local` 会话未删除是 `NULL`，`cloud` 会话未删除是 `-1`。**只写 `deleted_at IS NULL` 会把全部云端会话永久漏在接管范围外**（本机漏了 5 条，很久没被发现）。

现用常量：

```js
const NOT_DELETED = "(deleted_at IS NULL OR deleted_at = -1)";
const WHERE = NOT_DELETED;
const WHERE_DEDUPE = NOT_DELETED + " AND COALESCE(is_background_automation, 0) = 0";
```

### 5.3 托盘不能用 `cmd /c launcher.cmd` 启动

托盘是 `/target:winexe`（无控制台），它调 `cmd` 时 cmd 拿到无效 stdout 句柄会空转 —— 实测吃 **124 秒 CPU**、只有 conhost 子进程、没有 node、`launcher.log` 零新增，还卡在 `pause` 弹出窗口。

现在 `StartWd()` 直接隐藏启动 `node.exe watchdog.js`（`UseShellExecute=true` + `WindowStyle.Hidden`），`FindNode()` 倒序找 `%USERPROFILE%\.workbuddy\binaries\node\versions` 里最新的 node。

### 5.4 `POST /api/client/relaunch` 要 ~60 秒，别用短超时同步等

它做的是「逐个 taskkill 十几个 WorkBuddy 进程 → 带调试端口重启 → 连 CDP → 注入面板」，完成之后才返回 202。早期托盘 `Timeout=10000` 同步 `GetResponse()`，10 秒一到就 catch 成失败弹「操作失败」，**而 daemon 那边其实跑完并注入成功**。

现为 `BeginGetResponse` 异步 fire-and-forget + 2 秒轮询 9222，通了提示「已恢复」，90 秒超时才报超时。

### 5.5 去重不能碰定时任务运行记录（但副本可以单独清）

`sessions.is_background_automation = 1` 是**真实执行记录**：自动化任务每次运行都新建一条同名会话（title 是任务名、cwd 是工作区），按 `(title, cwd)` 整组只留一条会删掉不同日期的运行。

所以默认口径仍然排除它们：`WHERE_DEDUPE` 比 `WHERE` 多一个 `COALESCE(is_background_automation, 0) = 0`。

**但后台任务里确实会混进副本** —— 旧「自动复制」把运行记录也一并复制了。这类只能按内容指纹分桶清：同 `(title, cwd)` + 同大小 + **归一化 sha256 相同**，桶内留 `updated_at` 最新一条，**逐桶判、不按组判**（同组不同大小 = 不同次运行，各自都要留）。

入口：`runBackgroundDedupe()` / `node scripts\rehome-sessions.js --dedupe-background [--dry-run]`。2026-11-10 22:00 实跑：4 桶、11 条活副本 → 5 条，删 6（备份 `workbuddy-bg-dedupe-20261110-220003-366.db`）。

### 5.6 去重判定不能只看 MD5

历史副本的 JSONL **字节数完全相同、MD5 不同** —— 因为复制时把行内 `sessionId` / 账号字段替换过，长度刚好不变。

正确判定顺序：

1. 按 `(title, cwd)` 分组，组内每条都要能定位到 `projects/**/<id>.jsonl`
2. 组内**字节数**全等（有缺失或大小全异的组直接跳过）
3. 逐组比对**消息 UUID 集合**：保留那条必须完整覆盖其余副本的全部 UUID
4. 保留 `updated_at` 最新的一条，其余写 `deleted_at` 软删

第 3 步是关键校验，跳过它就是在赌。

**11-10 补充：代码里已改成「归一化 sha256」实现第 2–3 步** —— 把本行 session id 替换成 `<SID>` 再哈希，等于比对除 id 之外的全部内容，比 UUID 集合覆盖更严格也更快。**原始 sha256 不行**：复制时 `sessionId` 被逐行改写，字节长度不变但内容不同，直接哈希会把真副本全部漏判（22:00 那轮第一版干跑就是 0 组，踩过）。

### 5.7 `sessions` 表没有 `owner_user_id`

只有 `status` 和 `is_background_automation`。`owner_user_id` 在 `automations` 表（定时任务定义），那是另一层，由 `automation-account-sync.js` 管，**不跟随会话接管**。

**两层自动任务别混**：

- 定时任务**定义** → `%APPDATA%\WorkDaddy\automations.json`，开关 `automation-sync.json`，UI 按钮「同步定时任务」
- 任务**运行记录会话** → `sessions.is_background_automation = 1`，走会话接管

### 5.8 工具会话会清掉它派生的进程树

用 agent 工具起的进程（daemon / 托盘）在工具会话结束时可能被连根清理 —— 这是测试环境限制，**不代表程序有问题**。要验证常驻，用 `explorer.exe` 或计划任务脱离会话启动。用户自己双击 `Start-WorkDaddyTray.cmd` 起的托盘本身就是常驻的。

### 5.9 客户端没有「回收站」界面

扒 `app.asar` 确认：`回收站` 只出现在 4 处无关文案（文件管理器工具描述、邮箱）。删除动作是：

```sql
UPDATE sessions SET deleted_at = ?, updated_at = ?, unread = 0 WHERE id = ?
```

**只按 id 写时间戳，不校验 `user_id`**。而列表查询 `... WHERE user_id = ? ...` 带账号过滤 —— 所以「A 删了 B 还能看到」在当前实现下不成立（B 取不到那行）。

**推论（重要）**：软删的会话在 UI 上直接消失，**没有恢复入口**。去重软删的 29 条也一样 —— 要恢复只能走 SQL 或覆盖备份库（见 §9）。

### 5.11 「允许完全访问」是三层状态，不是单开关

改权限相关的东西之前先记住这条：客户端把完全访问拆成三层，缺一层界面就显示成没开。

1. **账号偏好** `storage/user-<uid>-personal/global/preferences.json` → `localTaskPermissionMode: "full-access"`；决定新会话默认值，冷启动也读它。
2. **会话字段** `sessions.permission_mode` → `fullAccess`；`WorkbuddyAdapter.getSessionPermissionState()` 直接读，读不到默认 `bypassPermissions`（= 默认沙箱）。`plan` 是用户显式选择，别覆盖。
3. **渲染层开关** 输入框底部 `.cr-permission-setting` → 面板 `.cr-permission-panel`，开启时 `.cr-permission-panel__row--on`；改动会立刻回写第 1 层。

两个坑：

- 开启确认弹窗是 `.wb-modal--confirm`（不是 `--conf`），里面的「允许完全访问」按钮**默认 disabled**，必须先勾 `input[type=checkbox]`（我已了解风险）。不勾就点，看起来像点了没反应。
- 关闭开关是**静默**的，会直接把账号偏好改成 `default-sandbox`；所以「关一下再开」不是无副作用操作，偏好会被改写。

自动保活：`scripts/permission-sync.js`（三层一起补，幂等），daemon 在 `/api/switch` 成功后 3.5s 调一次、账号监听触发时也调、启动只补前两层。手动：`POST /api/permission/ensure`（需 `x-workdaddy-token`）或 `node scripts/permission-sync.js --apply`。

### 5.10 章节号是契约

`REHOME-README.md` 的 `§` 编号被各文件引用。**改内容可以，别重排编号、别复用已作废的小节号。**

---

## 6. 运维 SOP

### 6.1 改代码 → 生效 → 验证（每次都用这一套）

```powershell
# 0) 确认服务活着
foreach ($p in 47832,47932) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Out-Null }

# 1) 改仓库源码
#    H:\AI工作区\wb账号同步\WorkDaddy\scripts\...

# 2) 跑回归测试（三组，纯临时库，不碰真实数据）
#    node 用版本目录里最新的那个，不写死版本号
$node = (Get-ChildItem "$env:USERPROFILE\.workbuddy\binaries\node\versions" -Directory |
         Sort-Object Name -Descending | Select-Object -First 1).FullName + '\node.exe'
Set-Location 'H:\AI工作区\wb账号同步\WorkDaddy'
& $node test/rehome-sessions.test.js
& $node test/rehome-watcher.test.js
& $node test/rehome-dedupe.test.js

# 3) 干跑，确认影响面（不写库）
& $node -e "const {createRehomeRunner}=require('./scripts/rehome-sessions.js');createRehomeRunner({dataDir:'C:/Users/jmwan/AppData/Roaming/WorkDaddy',dataRoot:'C:/Users/jmwan/.workbuddy',dbPath:'C:/Users/jmwan/.workbuddy/workbuddy.db'}).run('<当前uid>',{dryRun:true}).then(r=>console.log(JSON.stringify(r)))"

# 4) 同步到安装版
Copy-Item .\scripts\rehome-sessions.js 'C:\Users\jmwan\AppData\Local\Programs\WorkDaddy\scripts\' -Force

# 5) 重启 daemon（watchdog 3 秒内自动拉起）
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'WorkDaddy[\\/]scripts[\\/]daemon\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 6
(Invoke-WebRequest 'http://127.0.0.1:47832/api/status' -UseBasicParsing).Content
```

### 6.2 托盘重建

```cmd
cd /d H:\AI工作区\wb账号同步\WorkDaddy\tray
build.cmd
```

源码必须 **UTF-8 with BOM**（`csc /codepage:65001` 读中文注释会乱码），C# 语法限制在 **C# 5**（Framework 4.0 自带编译器：无字符串插值、无 `?.`、无 `out var`）。

### 6.3 托盘命令行（结果同时写 `%TEMP%\WorkDaddyTray-cli.txt`）

```
WorkDaddyTray.exe --status / --selftest
WorkDaddyTray.exe --start / --stop / --restart
WorkDaddyTray.exe --autoon / --autooff
```

停止逻辑：WMI 查 `Win32_Process`，正则 `WorkDaddy\scripts\(watchdog|daemon)\.js`，先 watchdog 后 daemon、循环 4 轮压住自动重启；不会误伤 Codex / MCP 那些 `node.exe`。

### 6.4 WorkDaddy 自身升级后怎么恢复（**每次升级必做**）

上游发布版升级会**整目录覆盖** `%LOCALAPPDATA%\Programs\WorkDaddy\scripts`，本项目的改动会全部丢失（表现为切号不再接管、面板两个按钮变回原来的复选框）。

**日常用法：双击仓库根目录的 `deploy.cmd`。** 它已经把下面的四步全部做完：定位安装目录 → 校验 14 个文件齐全 → 按时间戳备份 → 复制 → 绑面板 UI → 重启 daemon → 轮询 47832 最长 20 秒确认恢复。幂等，退出码 0 即成功。

只有两种情况才需要看下面的手工步骤：

- 脚本报「没找到安装目录」（WorkDaddy 装在非默认路径）→ 改用 `deploy.ps1 -TargetDir "<你的 scripts 目录>"`
- 上游改动过大，覆盖后 daemon 起不来 → 需要手工并冲突

手工方式（与 `deploy.cmd` 等价）：

```powershell
$src='H:\AI工作区\wb账号同步\WorkDaddy\scripts'
$dst='C:\Users\jmwan\AppData\Local\Programs\WorkDaddy\scripts'

# 1) 恢复全部补丁文件（7 个新增 + 4 个上游修改版）
$patched = @(
  # 新增 —— 上游没有这些文件
  'rehome-sessions.js','rehome-watcher.js','rehome_sessions.py',
  'bind-rehome-ui.py','fix-cdp.cmd','setup-rehome.ps1','stop-workdaddy.ps1',
  # 上游文件的修改版 —— 升级会覆盖成原版，必须盖回去
  'daemon.js','inject.js','lib.js','win-launcher.js','workbuddy-exe.json'
)
foreach ($f in $patched) { Copy-Item "$src\$f" $dst -Force }

# 2) 重新绑定 UI（inject.js 被覆盖后必须重跑，幂等）
py "$dst\bind-rehome-ui.py"

# 3) 重启 daemon
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'WorkDaddy[\\/]scripts[\\/]daemon\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 4) 验证：dryRun 应返回 affected=0；端口 47832/47932 应恢复监听
```

`daemon.js` / `lib.js` / `win-launcher.js` / `inject.js` 是上游文件的**增量修改版**，升级后必须用仓库版覆盖 —— 只补新文件不够，否则 rehome 接入点、`/api/rehome/*` 路由、非 C 盘路径解析、taskkill 容错全都不存在。若上游改动较大导致覆盖后启动报错，用 `git diff <上游版本标签> -- scripts/daemon.js` 看冲突点手工并入。

**换机器时额外要做**：改 `scripts/workbuddy-exe.json` 里的客户端路径；确认 `%USERPROFILE%\.workbuddy\binaries\node` 下有 ≥22.13 的 node（没有就改用手上的 node，托盘 `FindNode()` 会回退到 PATH）。

---

## 7. 当前数据状态（2026-11-10 20:55 快照）

| 分类 | 当前账号可见 | 全库 | 说明 |
| --- | --- | --- | --- |
| 未删除合计 | 58 | 58 | 全部接管，无遗漏 |
| 活跃普通 | 31 | 31 | 含 5 条云端会话 |
| 已归档 | 19 | 19 | 去重后 48 → 19 |
| 后台任务 | 11 | 16 | 未删除 11 条全接管；余 5 条已删 |
| 已删除 | 47 | 125 | 余 78 条属其它账号（**按约定不接管**） |

**服务**：daemon PID 9496、watchdog 39068、托盘 1 个；47832 / 47932 均 LISTEN；9222 未监听（客户端当前未以调试端口启动）。

**硬链接实测（21:05）**

| 文件 | inode 是否一致 | 结论 |
| --- | --- | --- |
| `MEMORY.md` × 3 | 相同（`16044073672992589`） | 共享有效 |
| `startup-route.json` × 3 | **各不相同** | **已断开**，三个账号各自指向不同会话 |

`startup-route.json` 现状：`106cbbda` → `26964c04`（20:35，当前这个会话）、`721d1e45` → `d9682b3b`（15:58）、`a2099672` → `73041cde`（13:33）。修复命令见 §3，会以最新的 `106cbbda` 那份为准覆盖另外两个。

**最近提交**

```
119c8a4 chore: 忽略 Python 缓存目录，移除误提交的 .pyc
d2ba1ea fix(rehome): 修正「未删除」判定，云端会话不再整类漏接管
b65367c feat(rehome): 归档与会话运行记录纳入接管，去重覆盖归档
2c771bd fix(tray): 恢复 CDP 改异步 fire-and-forget，消除 10s 超时误报
068e6c0 fix(tray): 启动改走 node watchdog.js，绕开旧批处理入口空转与弹窗
```

**备份**（`%APPDATA%\WorkDaddy\rehome-backups\`）

- `workbuddy-20261110-204649-485.db` — 归档收敛前
- `workbuddy-20261110-205105-389.db` — 云端修正前
- 另有 13:06 / 13:08 两次去重备份

---

## 8. 已知缺口与下一步

按建议优先级排。**没有一条是阻塞性问题**，都属可选增强。

| 优先级 | 缺口 | 说明与建议 |
| --- | --- | --- |
| ~~P0~~ | ~~上游升级会冲掉全部补丁~~ | **已解决**：仓库根目录 `deploy.cmd` 一键恢复，升级后双击一次即可（见 §6.4） |
| **P1** | `startup-route.json` 硬链接已断 | 三个 inode 各不相同（详见 §7），意味着三个账号打开的是不同会话，核心目标之一没达成。跑一次 `setup-rehome.ps1` 可恢复，之后切号会自动维持。**会以最新那份覆盖另外两个，先确认保留哪个落点** |
| P2 | 回收站不同步 | 用户明确「删除暂时不需要」。代价：垃圾进谁的回收站取决于删除时归属；想清理得切回那个账号。要放开只需把 `WHERE` 的 `NOT_DELETED` 换成 `1`（**先确认客户端 UI 能承载 125 条**） |
| P3 | 软删无 UI 恢复入口 | 客户端没有回收站页面。如需恢复只能 SQL 或覆盖备份库（§9） |
| P4 | `721d1e45` 不在 `account-display.json` | 昵称显示可能回退成 uid。下次该账号登录且 CDP 可用时会自动补写 |
| P5 | 去重只在切号时触发 | 长期不切号会积累副本。可加定时任务，或手动 `POST /api/rehome/dedupe {"dryRun":true}` 先看 |
| P6 | 无 CI | 测试靠手工跑三组 `node test/*.js`。上游有 `.github/`，可挂 workflow |
| P7 | 托盘 exe 是提交的二进制 | 改 `.cs` 必须记得 rebuild 再 commit，否则仓库里的 exe 与源码不一致 |

**若要继续做功能，优先级建议**：先修 P1（一条命令就能验证核心目标是否达成），再把 P3 补上（一个只读的「最近软删」管理页最省事），P2 由用户决定。

---

## 9. 危险操作与回滚

### 9.1 恢复被软删的会话

```sql
-- 单条 / 一批（ids 来自 /api/rehome/dedupe 的响应，或自查）
UPDATE sessions SET deleted_at = NULL WHERE id IN ('<id1>','<id2>');
```

云端会话（`transport='cloud'`）要恢复成「未删除」，值应为 `-1` 而不是 `NULL`：

```sql
UPDATE sessions SET deleted_at = -1 WHERE id IN (...) AND transport = 'cloud';
```

### 9.2 覆盖整个库

**必须先完全退出 WorkBuddy**（含所有子进程），否则 WAL 里的数据会覆盖回去：

```powershell
Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force
Copy-Item '<备份>.db' 'C:\Users\jmwan\.workbuddy\workbuddy.db' -Force
```

### 9.3 绝对不要做

- 直接 `UPDATE sessions SET user_id = ...` 不带 `NOT_DELETED` 条件 —— 会把回收站也洗掉
- 用 `dedupeSessions({aggressive:true})` 在没跑过干跑的情况下直接执行
- 在 WorkBuddy 运行时覆盖 `workbuddy.db`
- 改 `REHOME-README.md` 的小节编号

---

## 10. 开工自检（6 条命令，30 秒）

```powershell
# 1) 服务活着吗（应输出两个 True）
foreach ($p in 47832,47932) { "$p = " + [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

# 2) 谁在跑
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'WorkDaddy' } | Select-Object ProcessId,CommandLine
Get-Process WorkDaddyTray -ErrorAction SilentlyContinue

# 3) 仓库与安装版是否一致（输出任何 MISMATCH = 有人改了没同步，或上游刚升级）
$src='H:\AI工作区\wb账号同步\WorkDaddy\scripts'; $dst='C:\Users\jmwan\AppData\Local\Programs\WorkDaddy\scripts'
$patched = 'rehome-sessions.js','rehome-watcher.js','rehome_sessions.py','bind-rehome-ui.py','fix-cdp.cmd',
           'setup-rehome.ps1','stop-workdaddy.ps1','daemon.js','inject.js','lib.js','win-launcher.js','workbuddy-exe.json'
foreach ($f in $patched) {
  if (-not (Test-Path "$dst\$f")) { "MISSING : $f" }
  elseif ((Get-FileHash "$src\$f").Hash -ne (Get-FileHash "$dst\$f").Hash) { "MISMATCH: $f" }
}

# 4) 接管是否已全收敛（应为 0 或只有本轮预期变更）
#    用 §6.1 第 3 步的 dryRun，看 affected

# 5) 仓库状态
Set-Location 'H:\AI工作区\wb账号同步\WorkDaddy'; git status --short; git log --oneline -3

# 6) 落点硬链接（三个 inode 应一致；不一致 = 三账号打开不同会话，见 §3 与 §8-P1）
#    Git Bash 下：for d in /c/Users/jmwan/.workbuddy/*/; do ls -i "$d/startup-route.json" 2>/dev/null; done
fsutil hardlink list "$env:USERPROFILE\.workbuddy\<uid>\startup-route.json"
```

---

## 11. 文档索引（读什么、别读什么）

| 文档 | 大小 | 什么时候读 |
| --- | --- | --- |
| **本文件** | 小 | **每次接手必读** |
| `REHOME-README.md` | 37 KB / 12 章 | 需要细节时**按章节查**，别整份读。§1 原理、§7 风险、§8 CDP 故障、§11 去重、§12 托盘 |
| `AGENTS.md` | 24 KB | 上游开发约定。只在要动上游代码时查 |
| `README.md` | 16 KB / 408 行 | **入门版**（痛点 → 安装 → 托盘 → FAQ）。改功能或改部署流程时同步更新，这是仓库门面 |
| `README_UPSTREAM.md` + `_en` / `_ja` | 各 23–32 KB | 上游功能说明存档，交接**不需要**读 |
| `WorkBuddy三账号状态共享_可行性与需求规格.md` | 36 KB | 顶层目录。设计背景，**只在质疑方案时读** |
| `WorkBuddy三账号状态共享_现成项目调研与选型推荐.md` | 52 KB | 顶层目录。选型对比，**不需要读** |

### 验收四问（读完本文件应能答出）

1. 现在三个账号的会话各自是什么状态？→ §7
2. 下一手该做什么？→ §8
3. 哪些已完成、哪些待定？→ §7 + §8
4. 想改接入口径，该动哪份文件的哪个常量？→ §5.2 + §4

---

## 12. 给接手的启动话术

把下面这段直接粘给接手的 agent（替换 `<DIR>`）：

```text
接手 WorkDaddy 多账号接管项目。工作目录 H:\AI工作区\wb账号同步\WorkDaddy。

先读 HANDOFF.md（就在这个目录），读完再动手，不要先读别的文档。
硬约束（读完 HANDOFF 也要记住）：
1. 改仓库不等于生效 —— 运行的是 %LOCALAPPDATA%\Programs\WorkDaddy\scripts，必须同步 + 重启 daemon
2. 「未删除」是 (deleted_at IS NULL OR deleted_at = -1)，云端会话用 -1，别写成单一条件
3. 去重默认跳过 is_background_automation=1；后台任务副本只走 --dedupe-background（按归一化指纹分桶，别按 title+cwd 整组删）
4. 动生产库前先 dryRun，写入前会自动 VACUUM INTO 备份到 %APPDATA%\WorkDaddy\rehome-backups
5. 改 inject.js 用 bind-rehome-ui.py，别手改 1.4 MB 文件
6. 托盘是 C# 5 / .NET Framework 4.0，改 .cs 后必须跑 tray\build.cmd
7. 「三账号打开同一会话」靠 startup-route.json 硬链接；当前 MEMORY.md 仍共享、startup-route 已断（见 HANDOFF §7 与 §8-P1）

当前状态见 HANDOFF.md §7；已知缺口与优先级见 §8。
本轮任务：<填>
```

---

*本文档与代码同仓，改完接口/口径记得回来更新 §5 / §7 / §8。*
