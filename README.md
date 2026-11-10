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
> 本仓库只存了**改动的 13 个文件**，没有上游那几百个文件。它是一个「补丁包」，不是完整程序。

装完确认一下这个目录存在：

```
C:\Users\<你的用户名>\AppData\Local\Programs\WorkDaddy\scripts
```

里面应该有一个 `daemon.js`。有就对了。

### 第 2 步：铺补丁

把本仓库下载下来（`git clone` 或右上角 Download ZIP 都行），然后**双击根目录的 `deploy.cmd`**。

它会自动做六件事，每一步都打印出来：

1. 找到你的 WorkDaddy 装在哪儿
2. 检查 12 个补丁文件齐不齐
3. 备份会被覆盖的文件（存到 `%APPDATA%\WorkDaddy\script-backups\deploy-<时间戳>\`）
4. 复制 13 个文件过去
5. 重新绑定面板上的按钮（有 Python 才会跑，没有也不影响功能）
6. 重启后台服务

看到 `完成` 就好了。这个脚本可以反复跑，不会出问题。

> 想先看看它会干什么、不实际改动？用 PowerShell 跑 `.\deploy.ps1 -NoRestart`，它只铺文件不动服务。

### 第 3 步：起服务

双击 `tray\WorkDaddyTray.exe`，右下角出现一个小圆点图标。

**右键它 → 点「启动 WorkDaddy」**。圆点从灰色变绿，服务就起来了。

这时候切号接管、归档同步、副本去重全部生效，不需要再做任何事。

---

## 装完之后怎么用

### 平时你要做的

**几乎什么都不用做。** 装好、启动一次，之后正常用 WorkBuddy 就行：

- 在面板上切换账号 → 2 秒内自动接管会话归属
- 新账号登录 → 同样自动接管
- 侧栏出现重复会话 → 下一个切号周期自动去重

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

历史上游的「复制」功能会留下副本。去重的判定标准：

1. 同一个工作目录 + 同一个标题
2. 消息文件**字节数完全一致**（是真的复制品，不是各自演化）
3. 保留的那份，消息 UUID 必须**完全覆盖**被删的那些（保证不丢内容）

三条都满足才软删（写 `deleted_at` 时间戳），不做物理删除。删错了还能恢复。

**后台任务的运行记录不参与去重** —— 那是真实的执行历史，不是复制品，误删就真丢了。

### 安全措施

- 每次改数据库前自动 `VACUUM INTO` 一份完整备份
- 所有写入在一个事务里，要么全成要么全不成
- 去重只做软删，随时可恢复

---

## 常见问题

### 切完号，右下角没有机器人按钮

点托盘菜单的「**恢复 CDP**」，等约 1 分钟。会重开一次 WorkBuddy 窗口。

### 点了「恢复 CDP」，提示操作失败

现在不会了。旧版有这个问题：那个操作实际要 60 秒，旧版等 10 秒就报失败，其实已经成功了。

新版改成异步：点了立刻提示「已请求」，恢复好之后再提示「已恢复」。

### 侧栏出现两条一模一样的会话

去重在下一次切号时自动跑。想立刻处理，打开管理页用接口触发，或者直接切一次账号。

### 删掉的会话，会被另一个账号顶回来吗

**不会。**

库里一条会话只有**一行**记录，切号是把这一行的归属改掉，不是复制一份。你在 A 删掉它，这一行就被标记删除；B 那边看到的是同一行，所以也一起没了；下次切号，已删除的行不参与接管，不会被搬回来。

唯一例外是它本来就有「复制副本」——历史上自动复制留下的、内容完全相同的另一条（会话 id 不同）。这种删一条另一条还在。想确认有没有：

```
node scripts\rehome-audit.js
```

只读，不改任何东西。看到「字节相同的双活副本 0 组」就安全。

后台自动化任务的副本要单独清（它们每次运行都是新会话，不能按标题整组只留一条）：

```
node scripts\rehome-sessions.js --dedupe-background --dry-run   # 先看要删哪几条
node scripts\rehome-sessions.js --dedupe-background             # 真删，自动备份
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

**代码层面**：13 个文件。8 个新增，5 个是上游文件的改造版。

| 类型 | 文件 | 作用 |
| --- | --- | --- |
| 新增 | `rehome-sessions.js` | 接管 + 去重的核心逻辑 |
| 新增 | `rehome-watcher.js` | 盯账号变化，2 秒内触发接管 |
| 新增 | `rehome-sessions.py` | 独立的命令行版，可手动跑 |
| 新增 | `bind-rehome-ui.py` | 把面板按钮绑到接管模式 |
| 新增 | `setup-rehome.ps1` | 初始化工作区落点 |
| 新增 | `stop-workdaddy.ps1` | 强制停止（压住 watchdog） |
| 新增 | `fix-cdp.cmd` | 手工修复 CDP 的入口 |
| 新增 | `rehome-audit.js` | 只读体检：查复活风险、双活副本、删除后写入 |
| 改造 | `daemon.js` | 接入 rehome 逻辑 + `/api/rehome/*` 路由 |
| 改造 | `inject.js` | 面板文案与复选框绑定 |
| 改造 | `lib.js` | 非 C 盘路径解析 + CDP 明文兜底 |
| 改造 | `win-launcher.js` | 修 taskkill 返回非零导致启动中断 |
| 改造 | `workbuddy-exe.json` | 本机客户端路径（换机器必改） |

**另外还有**：

- `tray\WorkDaddyTray.exe` —— C# 写的托盘控制器，20 KB，用 Windows 自带的 `csc.exe` 编译，不需要 .NET SDK
- `tray\WorkDaddyTray.cs` —— 源码。改完跑 `tray\build.cmd` 重新编译
- `deploy.cmd` / `deploy.ps1` —— 一键部署
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
├── scripts/                      13 个补丁文件都在这
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
├── test/                         三组回归测试
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
