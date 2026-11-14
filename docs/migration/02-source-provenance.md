# 阶段 2 源码来源台账（Source Provenance）

目的：任何一个文件，都能回答「这行代码从哪来、为什么是这个版本」。

四个引用：

| 代号 | 引用 | 含义 |
|---|---|---|
| BASE | `fb9f8db` | 1.2.20，本 fork 的补丁基线 |
| FORK | `33d0e66` | 迁移前的分叉（28 个提交） |
| UP | `9b9bad5` | 上游 1.2.22 |
| NOW | `feat/full-fork-migration` HEAD | 合并结果 |

## 1. 判定规则

对每个路径，取 `BASE / FORK / UP` 三个 blob 比较：

| 情况 | 处理 | 数量 |
|---|---|---|
| 三者相同 | 直接用 | 308 |
| 只有 FORK 变 | 用 FORK | 8 |
| 只有 FORK 有 | 用 FORK | 38 |
| 只有 UP 变/有 | 用 UP | 44 |
| 两侧都变 | 人工合并 | 5 |
| 两侧同名独立新增 | 人工决策 | 2 |

逐文件明细见 `01-file-diff.csv`（含三方 blob、SHA-256、字节差、触及提交）。
生成器 `tools/migration/inventory.js` 可随时重跑核对。

## 2. 七个需要人判断的文件

### 2.1 `scripts/daemon.js`

| 项 | 值 |
|---|---|
| BASE | `d40d2d2`（719017 B） |
| FORK | `daaee64`（737269 B，+375/-9） |
| UP | `3ffc2f4`（749088 B，+633/-97） |
| NOW | `b9350be`（767555 B） |

做法：先落到 UP，再用 `git diff BASE FORK -- scripts/daemon.js` 生成补丁，
`git apply --3way` 打回（补丁带 index 行，git 用 BASE blob 做三方）。
489 行补丁只剩 1 处冲突：`DAEMON_VERSION` / `DAEMON_BUILD_ID` 常量块。

取舍：保留上游 1.2.69 / 1.2.70 / #507 / 1.2.81 四条版本注记（解释视频壁纸与临时文件清理），
版本号仍用本 fork 的 `1.3.0`，BUILD_ID 改 `release-1.3.0-full-fork`。
理由：`DAEMON_VERSION` 是本仓库自己的版本线（自 1.2.80 起与上游 1.2.x 分道），
合并上游不应该把版本号回退；`test/daemon-status-nonblocking.test.js` 要求
BUILD_ID 以 `release-<version>-` 开头，所以必须同步改名。

结果里包含：12 条 `/api/rehome/*`、`/api/permission/*` 路由、`getRehomeRunner`
懒初始化、`alignStartupRoutes`、启动 6s `reconcile({autoRun:false})`、
`permission-sync` 五个导入。

### 2.2 `scripts/inject.js`

| 项 | 值 |
|---|---|
| BASE | `0d18838`（1359391 B） |
| FORK | `2d4aada`（1359561 B，+44/-44） |
| UP | `9c99248`（1386282 B，+487/-118） |
| NOW | `017810a`（1386452 B） |

两侧改动落在不同位置，git 自动三方合并成功，无人工介入。
现存证据：`wbs-sess-auto-all` / `rehomeEnabled` / `updateRehomeButton` 共 41 处（分叉）；
`wallpaperVideo` / 视频壁纸相关（上游）。`node --check` 通过。

### 2.3 `scripts/lib.js`

| 项 | 值 |
|---|---|
| BASE | `86a4cf8`（94114 B） |
| FORK | `0e7f56c`（95030 B，+14） |
| UP | `fb92206`（96050 B，+48/-5） |
| NOW | `b6e8baa`（96966 B） |

自动合并。分叉两处补丁都在：
- 第 120 行 `[rehome] 自定义安装盘符`（读同目录 `workbuddy-exe.json` 覆盖客户端路径）
- 第 1905 行 `[rehome] CDP accountSnapshot 明文兜底`（信封取钥不可用时仍显示昵称）

### 2.4 `scripts/win-launcher.js`

| 项 | 值 |
|---|---|
| BASE | `a0ec07e`（85164 B） |
| FORK | `0a5ebc9`（86115 B，+18/-1） |
| UP | `71dc523`（85801 B，+34/-22） |
| NOW | `a65b247`（86752 B） |

自动合并。分叉的 `taskkill` 非零竞态处理在第 1114 行；
上游的 `runPendingClientTempCleanup`（`client-temp.js`）也接在同文件里。

### 2.5 `scripts/session-pin-sync.js`

| 项 | 值 |
|---|---|
| BASE | 不存在 |
| FORK | `5c4e51e`（9854 B / +229 行） |
| UP | `cbc4283`（5723 B / +95 行，提交 `03aeabc`） |
| NOW | `5c4e51e`（= FORK） |

决策依据：先逐函数比对（`capture` / `flush` / `sync` / 两个 renderer 片段），
核心算法一致；分叉多出 log 注入 + resolve/apply 的 try/catch（失败保留 pending）、
`status()` 诊断、默认恒等映射（rehome 不改会话 id）、flush 后把已写入 id 并入目标快照
（A→B→C 快速轮换时 B 渲染层可能未挂载）。上游没有分叉缺的能力。
所以取分叉实现，并验证上游 10 个用例全部通过（说明确实是超集）。

### 2.6 `test/session-pin-sync.test.js` / `test/session-pin-sync-queue.test.js`

| 项 | 值 |
|---|---|
| 上游测试 | `ee53189`（7036 B / 10 个 node:test 用例），原路径保留 |
| 分叉测试 | `c7fbbad`（6308 B / 自写 runner，PASS 行），改名 `session-pin-sync-queue.test.js` |
| NOW | 两个文件都在 |

为什么改名而不是合并：同路径会被上游版占用；合并会把两套断言揉成一个文件，
将来上游再改这个测试就产生冲突。改名后两者独立演进，且一条用例没删。

### 2.7 `README.md`

| 项 | 值 |
|---|---|
| BASE | `62877f4` |
| FORK | `07fad5a`（+431/-212，重写成入门文档） |
| UP | `478cb3d`（+16/-1，加了 Nagora 赞助章节） |
| NOW | `478cb3d`（= UP，暂取上游） |

原因：分叉版 README 讲的是「17 文件补丁包」的部署方式，迁移后整段失效；
在阶段 6 一次性重写（安装方式、数据目录、与上游关系、许可证）比现在做两次合并更省事。
风险登记 R14 已记录。

## 3. 机械确定的部分（不需要人判断）

- **A 类 308 个**：三方一致，直接用。
- **B 类 8 个**：`.gitattributes`、`.gitignore`、`scripts/Install-WorkDaddy.cmd`、
  `scripts/build-win-zip.sh`、`scripts/install-win.cmd`、`scripts/launcher.cmd`、
  `scripts/verify-win.cmd`、`test/automation-v2.test.js`。上游没动，原样保留分叉版。
- **C 类 38 个**：rehome / dedupe / scope / permission / tray / deploy / CI 工具链 /
  分叉文档。全部保留。
- **F 类 44 个**：上游 1.2.21–1.2.22 的修改与新增，全部采纳。
  其中 `workbuddy-compat.js`（+3609 B）与 `renderer-api-bridge.js`（+797 B）
  是客户端接口层，采纳后由上游测试兜底（`workbuddy-compat.test.js` 16 条已通过）。

## 4. 如何复核

```bash
# 三树分类是否与台账一致
node tools/migration/inventory.js

# 合并结果与上游的差异是否只剩分叉自有文件
git diff --name-status upstream/main | awk '{print $1}' | sort | uniq -c
# 期望：46 A（分叉新增/保留） 13 M（8 个 B 类 + 4 个手工/自动合并的 E 类 + session-pin-sync）

# 分叉补丁是否在合并结果里（逐点）
grep -c "'/api/rehome/\|'/api/permission/" scripts/daemon.js      # 期望 12
grep -c "wbs-sess-auto-all\|rehomeEnabled" scripts/inject.js      # 期望 >0
grep -n "\[rehome\]" scripts/lib.js                               # 期望 2 处
grep -n "taskkill 非零" scripts/win-launcher.js                    # 期望 1 处

# 分叉原版随时可取
git show 33d0e66:scripts/daemon.js
```
