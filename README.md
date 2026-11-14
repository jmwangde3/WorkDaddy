<h1><img src="docs/images/workdaddy-app-icon-rounded.svg" alt="" width="40" height="40" align="absmiddle"> WorkDaddy 多账号会话接管版</h1>

**一句话**：让多个 WorkBuddy 账号看到同一批会话 —— 切换账号时，会话原地改归属，**不复制、不改 ID、不产生副本**。附带一个 Windows 托盘控制器，负责启动/关闭/重启和开机自启。

> 这是 [babygoton/workdaddy](https://github.com/babygoton/workdaddy) 的个人改造版。
> 上游负责「账号切换 + 界面面板」，我在这之上加了两块：**会话归属接管** 和 **系统托盘**，其余功能全部是上游原样，没有改动。
> 想了解上游的完整功能（主题、自动化、用量统计、成长计划……），看 [README_UPSTREAM.md](README_UPSTREAM.md)。

---

## 目录

- [这东西到底解决什么问题](#这东西到底解决什么问题)
- [装之前你需要有什么](#装之前你需要有什么)
- [安装：三步](#安装三步)
- [装完之后怎么用](#装完之后怎么用)
- [它内部到底做了什么](#它内部到底做了什么)
- [常见问题](#常见问题)
- [和上游的区别](#和上游的区别)
- [文件都在哪](#文件都在哪)
- [想深入看什么](#想深入看什么)

---

## 这东西到底解决什么问题

### 先说痛点

WorkBuddy 的会话是**按账号隔离**的。你登在账号 A，侧栏就只有 A 的会话；切到账号 B，A 的历史全部消失。

如果你有多个账号（比如工作号、个人号、小号分开用积分），切换之后就等于换了一台电脑 —— 昨天在 A 里聊的方案，B 里根本找不到。

### 上游是怎么做的

上游 WorkDaddy 的做法是「**复制**」：切号时把 A 的会话复制一份，把副本的归属改成 B。

问题很明显：

- 一份会话变成两份、三份，各自独立演化
- 在 B 里继续聊，A 那边看不到后续
- 聊得越久，副本越多，侧栏越乱，磁盘越占

### 这个版本改成什么

**不复制，改归属。**

数据库里只有一条会话记录，切号时把这条记录的 `user_id` 改一下。会话 ID 不变、消息文件不动、产物目录不搬。

效果：

| 场景 | 上游（复制） | 本版（改归属） |
| --- | --- | --- |
| A 聊完切到 B | B 看到一份副本 | B 看到同一份，可以接着聊 |
| 在 B 里继续 | A 那份不会更新 | 本来就是同一条，A 回来就是最新的 |
| 三个账号来回切 | 最多 3 份副本 | 始终 1 份 |
| 会话 ID | 每条副本一个 ID | 永远不变 |

一句话：**切换账号，就像在同一台电脑上换了个登录名，文件还是那些文件。**

---

## 装之前你需要有什么

**必须有的：**

- Windows 10 或 Windows 11（本版只在 Windows 上实测过，macOS / Linux 未验证）
- WorkBuddy 客户端（国内版），装好并且至少登录过一个账号
- 上游 WorkDaddy（下一步会教你装）

**不需要的：**

- 不需要 Node.js —— WorkBuddy 自己带了一个，脚本会用那个
- 不需要 Visual Studio 或编译工具 —— 托盘 exe 仓库里就是编译好的
- 不需要 Python —— 只有想修正面板按钮文案时才用得上，没有也能跑

---

## 安装：三步

### 第 1 步：装上游 WorkDaddy

去 [babygoton/workdaddy/releases](https://github.com/babygoton/workdaddy/releases) 下载 `WorkDaddy-Setup-x.y.z.exe`，双击装完。

> 为什么不能直接用本仓库？
> 本仓库只存了**改动的 17 个文件**，没有上游那几百个文件。它是一个「补丁包」，不是完整程序。

装完确认一下这个目录存在：

```
C:\Users\<你的用户名>\AppData\Local\Programs\WorkDaddy\scripts
```

里面应该有一个 `daemon.js`。有就对了。

### 第 2 步：铺补丁

把本仓库下载下来（`git clone` 或右上角 Download ZIP 都行），然后**双击根目录的 `deploy.cmd`**。

它会自动做七件事，每一步都打印出来：

1. 找到你的 WorkDaddy 装在哪儿，并确认目录可写
2. 校验 16 个补丁文件齐不齐，计算源文件哈希
3. 读 `scripts\upstream.json` 做两道检查：
   - **文件代际（硬拦，按 SHA-256 判定）**：
     目标哈希 == 本补丁版 → 已在目标代际，可覆盖；
     目标哈希 == 上游 1.2.22 原版 → 是没打过补丁的原版上游文件，覆盖会丢掉上游修复 → 中止（`-Force` 可越过）；
     两者都不等 → 代际不明（可能是别的版本打过补丁）→ 同样中止（`-Force` 可越过）。
     **只比字节数是不够的**：同大小不同内容的文件会被误判成「已打补丁」然后被覆盖。
   - **版本号（默认只提示）**：上游版本号只来自提交信息，且本 fork 与上游没有祖先关系，不足以下判断；加 `-StrictVersionGate` 才升级为阻断，越过它要用 `-ForceVersion`（`-Force` 只管代际闸门，不会顺手拆掉版本闸门）
4. 备份会被覆盖的文件（存到 `%APPDATA%\WorkDaddy\script-backups\deploy-<时间戳>\`）
5. 先复制到临时目录并逐个校验 SHA-256，全部一致才替换
6. 替换失败自动回滚，并生成 `deploy-report-<时间戳>.json`
7. 重新绑定面板按钮、重启后台服务

看到 `完成` 就好了。这个脚本可以反复跑，不会出问题。

> 想先看看它会干什么、不实际改动？用 PowerShell 跑 `.\deploy.ps1 -DryRun`：只预检并打印报告，零写入。
>
> `scripts\workbuddy-exe.json` 是你这台机器的客户端路径，**部署时永不覆盖**：已存在就保持原样，只有缺失时才从 `workbuddy-exe.example.json` 生成一份，需要你自己改成实际路径。

### 第 3 步：起服务

双击 `tray\WorkDaddyTray.exe`，右下角出现一个小圆点图标。

**右键它 → 点「启动 WorkDaddy」**。圆点从灰色变绿，服务就起来了。

这时候切号接管与归档同步生效，不需要再做任何事。去重与权限修复默认关闭，需要时按下面「常见问题」里的命令手动执行。

---

## 装完之后怎么用

### 平时你要做的

**几乎什么都不用做。** 装好、启动一次，之后正常用 WorkBuddy 就行：

- 在面板上切换账号 → 2 秒内自动接管会话归属
- 新账号登录 → 同样自动接管
- 侧栏出现重复会话 → 手动跑 `node scripts\rehome-sessions.js --dedupe --dry-run` 看判定，确认后再执行

### 托盘图标是什么意思

| 图标 | 含义 |
| --- | --- |
| 灰色圆点 | 后台服务没在跑 |
| 绿色圆点 | 服务正常，接管工作中 |
| 橙色圆点 | 正在执行操作（启动/停止/恢复中） |

### 托盘菜单每一行干什么

**状态** —— 两秒刷新一次，显示服务状态和 CDP 连接状态

**启动 WorkDaddy** —— 只启动后台服务。不弹窗、不重启 WorkBuddy 窗口。切号接管从这里开始生效

**关闭 WorkDaddy** —— 停掉后台服务。账号数据、会话记录**一个都不会删**

**重启 WorkDaddy** —— 先停再起，改完脚本后用这个

**恢复 CDP** —— 让右下角的机器人按钮出现。**会重开一次 WorkBuddy 窗口**，约 1 分钟，中途别以为卡了

**开机自启动** —— 勾上之后开机自动起托盘并拉起服务

**打开管理页** —— 浏览器打开 `http://127.0.0.1:47832/`

**退出托盘** —— 只关托盘程序，**后台服务继续跑**

### 什么时候需要点「恢复 CDP」

只有当你想用面板时（右下角那个机器人按钮）。

原因是官方限制：Electron 的调试端口必须在**进程启动时**就带参数，所以只能重开一次窗口。

如果只要「切号自动接管」这个功能，**永远不用点它**。

### 不想开托盘时，可以命令行

在 `tray` 目录打开命令行：

```
WorkDaddyTray.exe --start      启动服务
WorkDaddyTray.exe --stop       停止服务
WorkDaddyTray.exe --restart    重启服务
WorkDaddyTray.exe --status     查看状态
WorkDaddyTray.exe --autoon     开启开机自启
WorkDaddyTray.exe --autooff    关闭开机自启
```

结果会同时写到 `%TEMP%\WorkDaddyTray-cli.txt`。

---

## 它内部到底做了什么

看不懂可以跳过，不影响使用。

### 连接方式：不改造 WorkBuddy

```
┌─────────────┐  --remote-debugging-port=9222  ┌──────────────┐
│  WorkBuddy  │ <───────────────────────────> │  WorkDaddy   │
│  (Electron) │       Chrome DevTools          │   daemon.js  │
│             │        Protocol (CDP)          │              │
│  渲染进程    │  ←── 注入面板组件 ───           │  HTTP :47832 │
└─────────────┘                                └──────────────┘
```

WorkBuddy 是用 Electron 做的（本质是个浏览器）。启动时多给它一个 `--remote-debugging-port` 参数，就能从外部连上去读写界面。

**WorkBuddy 的程序文件和数字签名一个字节都没动。**

### 会话归属是怎么改的

WorkBuddy 把会话存在一个 SQLite 数据库里：`C:\Users\<你>\.workbuddy\workbuddy.db`，表叫 `sessions`。

每条会话有一个 `user_id` 字段，标明它属于哪个账号。侧栏查询时带 `WHERE user_id = ?`，所以只能看到自己的。

接管做的事只有一句 SQL：

```sql
UPDATE sessions SET user_id = '当前账号' WHERE ...;
```

消息内容、产物文件、会话 ID 全都不动。

**接管范围**（重要，决定了你能看到什么）：

- 活跃会话 —— 接管
- 已归档会话 —— 接管（归档是翻历史的入口，必须跨账号可见）
- 后台自动化任务的运行记录 —— 接管
- 云端会话 —— 接管
- **回收站里的 —— 不接管**，保持删除时那个账号的归属

> 有个坑：客户端用**两种写法**表示「没删除」。本地会话是 `deleted_at IS NULL`，云端会话是 `deleted_at = -1`。只判前者会把云端会话整类漏掉。

### 重复会话怎么去重

去重是**手动功能，默认关闭**。自动接管只改归属，不会顺带删任何会话。

判定分四层，任何一层证明不了「是副本」，该组一律保留：

1. **文件层** —— 消息文件存在、可读、非空，且扫描期间大小与内容哈希没变；
2. **字节层** —— 整文件 SHA-256 相同 = 逐字节相同的副本；
3. **消息层** —— 解析 JSONL，按消息 `id` 比对：id 集合完全一致且同 id 内容一致，才算内容相同的副本。只有**记录最外层**的 `sessionId` 不参与比较（复制时会被改写）；嵌套在消息内容里的 `sessionId`（工具调用参数、工具结果里携带的会话引用）是真实内容，必须参与比对 —— 否则两份不同的记录会被算成同一个哈希。
4. **包含层** —— 只有显式加 `--containment` 才启用：A 的全部消息都在 B 里、同 id 内容无冲突、**且 A 的消息 id 序列是 B 的子序列**（截断型旧副本一定满足），才认定 A 是 B 的旧副本，并保留内容更完整的 B（不看 `updated_at`）。

以下情况一律跳过、绝不删：文件缺失/损坏、同 UUID 内容冲突、同文件里重复的消息 UUID、两边互不包含、消息顺序对不上、候选保留者不唯一、扫描后文件又发生变化。

**附件与图片**：JSONL 里只存引用。如果会话旁边有附属产物（`<会话id>/`、`<会话id>.png` 等），整组保留 —— 判错会让人以为会话连附件一起丢了。如果引用写的是相对路径（`images/a.png`），同名文件在不同会话目录下可能是不同内容，此时只认逐字节相同，消息层不作证。

执行前后：

- 自动 `VACUUM INTO` 备份到 `%APPDATA%\WorkDaddy\rehome-backups\`
- 写一份操作日志（每个会话的原 `deleted_at`、新值、判定理由）
- 只写 `deleted_at` 软删，**从不物理删除 JSONL**
- 可按日志回滚；回滚只恢复「仍等于本次写入值」的行，不覆盖之后的新修改

```bash
# 先看要处理哪些（零写入）
node scripts\rehome-sessions.js --dedupe --dry-run

# 确认后执行（需要配置里 "dedupe": true，或 --force 仅本次）
node scripts\rehome-sessions.js --dedupe

# 消息包含关系（更激进，必须显式指定）
node scripts\rehome-sessions.js --dedupe --containment

# 按操作日志回滚
node scripts\rehome-sessions.js --dedupe-rollback %APPDATA%\WorkDaddy\rehome-backups\dedupe-<时间戳>.json
```

**后台任务的运行记录不参与接管与人工去重** —— 那是真实的执行历史，不是复制品。它们有一个独立入口，但它要求**双重显式**：

```bash
# 只读计划：打印会动哪几条，不写库
node scripts\rehome-sessions.js --dedupe-background --allow-background --dry-run

# 真的要写，必须再加 --apply
node scripts\rehome-sessions.js --dedupe-background --allow-background --apply
```

只给 `--dedupe-background` 而不给 `--allow-background` 会被直接拒绝（返回 `skipped: background-dedupe-requires-allow-background`）；给了 `--allow-background` 但没给 `--apply`，一律按只读计划处理。

**接管范围**：默认只接管 `transport = 'local'`（或历史库里 `transport` 为 NULL）且 `deleted_at IS NULL` 的会话。云端会话要同时 `cloudTakeover` 且 `cloudVerified` 双开才参与；`deleted_at` 取值与 transport 编码不一致的行（例如 local 行上出现 `-1`）、以及来源不明的 transport 值，一律不碰，并在 `--status` 里报出来。

### 安全措施

- 默认**不自动去重**、**不自动改权限**、**不自动点任何授权按钮**
- 每次改数据库前自动 `VACUUM INTO` 一份完整备份
- 所有写入在一个事务里，要么全成要么全不成
- 文件在扫描后变化、数据库行被并发修改 → 中止并补偿回滚
- 去重只做软删，可审计、可回滚

---

## 常见问题

### 切完号，右下角没有机器人按钮

点托盘菜单的「**恢复 CDP**」，等约 1 分钟。会重开一次 WorkBuddy 窗口。

### 点了「恢复 CDP」，提示操作失败

现在不会了。旧版有这个问题：那个操作实际要 60 秒，旧版等 10 秒就报失败，其实已经成功了。

新版改成异步：点了立刻提示「已请求」，恢复好之后再提示「已恢复」。

### 切完号，「允许完全访问」又变回默认权限了

v1.3.0 起改成**三个独立开关，默认全关**，工具不再替你做授权决定：

| 开关 | 作用 | 默认 |
|---|---|---|
| A `preferenceGuard` | 定时把被写回默认值的账号偏好还原（只碰文件） | **关** |
| B `configRepair` | 切号后补齐偏好 + `sessions.permission_mode`（不碰页面） | **关** |
| C `autoApprove` | 执行期自动批准 | **已移除，永远关** |

页面里的「允许完全访问」开关、风险确认复选框、执行期权限弹窗，**一律由你本人点击**。工具不注入自动点击脚本，也不注册页面重载后自动执行的守卫。

```bash
# 看状态：三个开关、活动定时器数、已注册脚本 id、页面当前状态
node scripts\permission-sync.js --status

# 单独开启 A（配置里也支持 "preferenceGuard": true）
node scripts\permission-sync.js --on --preference-guard

# 单独开启 B（切号时补配置）
node scripts\permission-sync.js --on --config-repair

# 一键全停：主进程定时器 + 页面定时器/observer/监听器 + 已注册脚本 + 持久化关闭
node scripts\permission-sync.js --off

# 若检测到旧版守卫残留（结构未知的监听器），加 --reload 强制重载页面彻底清干净
node scripts\permission-sync.js --off --reload
```

接口侧同样分开了：

```bash
curl -s -H "x-workdaddy-token: $(cat %APPDATA%\WorkDaddy\.api-token)" ^
  http://127.0.0.1:47832/api/permission/status

# 改开关（autoApprove=true 会被拒绝）
curl -s -X POST -H "x-workdaddy-token: ..." -H "Content-Type: application/json" ^
  -d "{\"preferenceGuard\":true}" http://127.0.0.1:47832/api/permission/config

# 全停
curl -s -X POST -H "x-workdaddy-token: ..." http://127.0.0.1:47832/api/permission/off
```

> 关闭是**真的关闭**，逐层都有对应动作：
>
> - **主进程定时器**：只清本模块登记的（不碰别的模块的 timer）
> - **页面定时器**：`clearInterval(window.__wdPermGuard.timer)`
> - **页面 observer / 监听器**：`disconnect()` 已登记的 MutationObserver、`removeEventListener` 已登记的 handler
> - **残留全局对象**：`delete window.__wdPermGuard` 等
> - **CDP 新文档脚本**：内存登记 + 落盘登记的 identifier 都删（daemon 重启后仍能删掉上次注册的）
> - **持久化**：三个开关写盘为 false
>
> daemon 重启、页面重载、切号都不会把它们装回来。
>
> 诚实边界：旧版守卫的监听器结构没有文档，只能按已知字段名拆。如果拆到了旧守卫对象（`pageStopped: true`），返回里会带 `needsReload: true` —— 只有 `Page.reload` 才能保证未知结构的监听器彻底消失，所以想彻底清就加 `--reload`。CLI 进程没有 CDP 会话，页面侧清理要走 daemon 的 `POST /api/permission/off`。

### 侧栏出现两条一模一样的会话

去重默认关闭，不会再自动跑。先干跑看看：

```bash
node scripts\rehome-sessions.js --dedupe --dry-run
```

确认判定合理再执行 `--dedupe`。判定标准见上文「重复会话怎么去重」。

### 删掉的会话，会被另一个账号顶回来吗

**不会。**

库里一条会话只有**一行**记录，切号是把这一行的归属改掉，不是复制一份。你在 A 删掉它，这一行就被标记删除；B 那边看到的是同一行，所以也一起没了；下次切号，已删除的行不参与接管，不会被搬回来。

唯一例外是它本来就有「复制副本」——历史上自动复制留下的、内容完全相同的另一条（会话 id 不同）。这种删一条另一条还在。想确认有没有：

```
node scripts\rehome-audit.js
```

只读，不改任何东西。看到「字节相同的双活副本 0 组」就安全。

后台自动化任务的副本要单独清（它们每次运行都是新会话，不能按标题整组只留一条）。这条路径必须双重显式，少一个都不会写库：

```
node scripts\rehome-sessions.js --dedupe-background --allow-background --dry-run   # 只读计划
node scripts\rehome-sessions.js --dedupe-background --allow-background --apply     # 真删，自动备份
```

### A 删了，B 又接着聊，A 还能拿到后面的进度吗

**能，不用做任何操作。**

消息只存一份（`%USERPROFILE%\.workbuddy\projects\**\<会话id>.jsonl`），不分账号。切回 A 时搬的是同一行、同一个文件，打开就是 B 写到的最新内容。

代价是同一时刻只有一个账号能看到它——这是「搬」不是「复制」的取舍。

注意：A 已经删掉的话（进回收站），B 窗口里那条刷新后也会消失。想让两条各自独立往下走，先在 B 那边「复制会话」分叉出一个新会话再继续。

### 关掉托盘，服务还跑吗

**跑。** 退出托盘只是关掉那个图标和菜单，后台服务是独立进程。

想真正停止，点「关闭 WorkDaddy」，或用 `--stop`。

### WorkDaddy 自己升级了怎么办

升级会**整个目录覆盖**，补丁全部丢失（表现为切号不再接管、面板按钮变回原样）。

**重新双击一次 `deploy.cmd` 就好。** 备份和幂等它都处理好了。

### 换一台电脑

1. 装 WorkBuddy 客户端，登录
2. 装上游 WorkDaddy
3. 跑 `deploy.cmd`
4. 改 `scripts\workbuddy-exe.json`，把里面的路径改成你电脑上 `WorkBuddy.exe` 的实际位置
5. 起托盘

`deploy.cmd` 跑完会帮你检查这个路径对不对。

### 怎么看日志

```
%APPDATA%\WorkDaddy\daemon.log       后台服务日志
%APPDATA%\WorkDaddy\watchdog.log     守护进程日志
%APPDATA%\WorkDaddy\launcher.log     启动器日志
```

grep 关键字：`[cdp]`、`[rehome]`、`error`。

### 改坏了怎么回滚

每次部署都会备份：

```
%APPDATA%\WorkDaddy\script-backups\deploy-<时间戳>\
```

把里面的文件盖回安装目录，再重启服务。

数据库也有备份，在 `%APPDATA%\WorkDaddy\rehome-backups\`。

---

## 和上游的区别

**代码层面**：17 个文件。13 个新增（其中 `workbuddy-exe.example.json` 只作模板，不参与部署），4 个是上游文件的改造版。

| 类型 | 文件 | 作用 |
| --- | --- | --- |
| 新增 | `rehome-sessions.js` | 接管核心（去重已拆到独立模块） |
| 新增 | `rehome-watcher.js` | 盯账号变化，带状态机与失败退避重试 |
| 新增 | `session-dedupe.js` | 副本判定内核：文件 / 字节 / 消息 UUID / 包含关系，四层证据 + 竞态防护 + 回滚 |
| 新增 | `session-scope.js` | local / cloud 接管边界 + `deleted_at` 语义体检（默认只接管 local 且 `IS NULL`） |
| 新增 | `session-pin-sync.js` | 会话 pin 跨账号同步队列（默认未接线；上游 1.2.22 已有同名实现，部署清单不含它） |
| 新增 | `rehome-sessions.py` | 独立的命令行版，可手动跑 |
| 新增 | `bind-rehome-ui.py` | 把面板按钮绑到接管模式 |
| 新增 | `setup-rehome.ps1` | 初始化工作区落点 |
| 新增 | `stop-workdaddy.ps1` | 强制停止（压住 watchdog） |
| 新增 | `fix-cdp.cmd` | 手工修复 CDP 的入口 |
| 新增 | `rehome-audit.js` | 只读体检：查复活风险、双活副本、删除后写入 |
| 新增 | `permission-sync.js` | 三开关（偏好守卫 / 配置修复 / 自动批准），默认全关 |
| 新增 | `upstream.json` | 上游版本 / commit / 每个补丁文件的上游字节数 / 版本闸门模式（全部带来源标注） |
| 新增 | `workbuddy-exe.example.json` | 本机路径模板（真实配置不入库） |
| 改造 | `daemon.js` | 接入 rehome / 去重 / 权限三开关 + `/api/rehome/*`、`/api/permission/*` 路由 |
| 改造 | `inject.js` | 面板文案与复选框绑定 |
| 改造 | `lib.js` | 非 C 盘路径解析 + CDP 明文兜底 |
| 改造 | `win-launcher.js` | 修 taskkill 返回非零导致启动中断 |

**另外还有**：

- `tray\WorkDaddyTray.exe` —— C# 写的托盘控制器，20 KB，用 Windows 自带的 `csc.exe` 编译，不需要 .NET SDK
- `tray\WorkDaddyTray.cs` —— 源码。改完跑 `tray\build.cmd` 重新编译
- `deploy.cmd` / `deploy.ps1` —— 一键部署（原子替换 + 文件代际闸门 + 失败回滚）
- `package.json` / `test/run-ci.js` —— 完整测试入口：逐文件跑，按「文件 + 用例名」双匹配基线，只对新增失败报错
- `HANDOFF.md` —— 给接手的人（或 AI）看的完整交接文档
- `REHOME-README.md` —— 实现文档，所有踩过的坑和实测数据

**上游功能一个都没删。** 主题、自动化、用量统计、成长计划、快捷短语、休眠控制……全部保留原样。

---

## 文件都在哪

```
WorkDaddy/
├── deploy.cmd                  ← 小白入口，双击这个
├── deploy.ps1                    它实际干活的脚本
├── README.md                     你正在看的
├── README_UPSTREAM.md            上游完整功能文档（原版 README）
├── HANDOFF.md                    交接文档：硬知识、SOP、已知缺口
├── REHOME-README.md              实现文档：踩坑记录、实测数据
│
├── scripts/                      17 个补丁文件都在这
│   ├── rehome-sessions.js        ← 接管核心
│   ├── rehome-watcher.js
│   ├── daemon.js                 上游改版
│   └── ...
│
├── tray/                         托盘控制器
│   ├── WorkDaddyTray.exe         ← 双击启动
│   ├── WorkDaddyTray.cs          源码
│   └── build.cmd                 重新编译
│
├── test/                         回归测试（去重 / 权限 / watcher / 边界 / 部署 / pin）
└── docs/images/                  截图素材
```

**装好之后**，实际运行的是安装目录里那份：

```
%LOCALAPPDATA%\Programs\WorkDaddy\scripts\
```

所以**改仓库 ≠ 生效**。改完必须跑一次 `deploy.cmd`（或手工复制 + 重启 daemon）。

---

## 想深入看什么

| 你想干什么 | 看哪份 |
| --- | --- |
| 了解上游的全部功能 | [README_UPSTREAM.md](README_UPSTREAM.md) |
| 接手维护这个项目 | [HANDOFF.md](HANDOFF.md) |
| 搞懂实现细节、看踩过的坑 | [REHOME-README.md](REHOME-README.md) |
| 看上游英文 / 日文文档 | [README_en.md](README_en.md) / [README_ja.md](README_ja.md) |

`HANDOFF.md` 里有十条「硬知识」，接手前必须看，能省半天：

1. 改的是仓库，跑的是安装版
2. `deleted_at` 有两种编码，云端是 `-1`
3. 托盘不能走 `cmd /c launcher.cmd`（会空转 124 秒）
4. `relaunch` 要 60 秒，不能短超时同步等
5. 去重不能碰后台任务运行记录
6. 去重判定不能只看 MD5（要校验 UUID 覆盖）
7. `sessions` 表没有 `owner_user_id`（那是 `automations` 的）
8. 工具会话会清掉它派生的进程树
9. 客户端没有回收站 UI，软删不可恢复
10. 章节号是契约，别重排

---

## 许可与声明

本项目沿用上游的 **[GNU Affero General Public License v3.0](LICENSE)**（`SPDX-License-Identifier: AGPL-3.0-or-later`）。

- 与 WorkBuddy / CodeBuddy 官方**无隶属关系**，未获其授权或认可
- 相关商标与官方资源归其权利人所有
- 本改造版由个人维护，**只在 Windows + WorkBuddy 国内版上验证过**
- 涉及修改客户端本地数据库，**用前请自己备份**（`deploy.cmd` 会自动备份脚本，数据库备份由接管逻辑自动生成）

上游项目：[babygoton/workdaddy](https://github.com/babygoton/workdaddy)
