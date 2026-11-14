# 阶段 2 完整 Fork 导入报告

- 分支：`feat/full-fork-migration`
- 起点：`33d0e66`（已审查的 `fix/workdaddy-data-permission-hardening`）
- 上游：`upstream/main` = `9b9bad5`（1.2.22）
- 合并提交：`42e517e`（双父：`0ff4002` + `9b9bad5`）

## 1. 历史策略与实施

| 决策点 | 结论 | 依据 |
|---|---|---|
| 是否需要 `--allow-unrelated-histories` | **不需要** | `git merge-base HEAD upstream/main` = `fb9f8db`，两侧同源 |
| 是否复制文件伪装 Fork | 不做 | 双父合并提交，上游 19 个提交全部进入本仓历史 |
| 是否改写历史 | 不做 | 未 reset / 未 rebase / 未强推 |
| 冲突解决方式 | 逐文件，核心文件「上游实现 + 分叉补丁」 | 见 §3 |

合并后 `git log --oneline` 里能直接看到上游 19 个提交（`9b9bad5`…`1ac90bd`），
`git log --graph` 显示 `0ff4002` 与 `9b9bad5` 两个父提交。

文件树规模：合并前 398 → 合并后 413（+7 上游新增，+5 上游新测试，+1 分叉测试改名，-若干重合）。

## 2. 我做了什么（按提交）

| 提交 | 内容 |
|---|---|
| `0ff4002` | 阶段 0 基线 + 阶段 1 三树盘点（`docs/migration/00-*`、`01-*`、`tools/migration/inventory.js`） |
| `42e517e` | 合并 `upstream/main`；4 处冲突暂取上游，其余自动三方合并 |
| `d250794` | 在纯上游 1.2.22 之上重放分叉 `daemon.js` 补丁（12 条路由 + 启动 reconcile） |
| `3572b81` | `session-pin-sync` 收编：以分叉实现为主干，上游 10 个用例 + 分叉队列用例同时保留 |
| `b67e813` | `upstream.json` 基线纠正（1.2.22 → 1.2.20）+ 代际闸门识别多代际原版 |

## 3. 逐文件处理结果（7 个需要人判断的文件）

| 文件 | 处理 | 结果 |
|---|---|---|
| `scripts/daemon.js` | 取上游，再用 `git apply --3way` 重放分叉 489 行补丁 | 只剩 1 处冲突（版本号），已按「保留上游注释 + 本 fork 版本线」解决 |
| `scripts/inject.js` | 自动三方合并 | 两侧改动共存：上游 +487/-118 与分叉「接管会话归属」UI 均在 |
| `scripts/lib.js` | 自动三方合并 | 上游 +48/-5 与分叉两处 `[rehome]` 兜底均在第 120、1905 行 |
| `scripts/win-launcher.js` | 自动三方合并 | 上游 `client-temp` 清理与分叉 `taskkill` 竞态处理均在第 1114 行附近 |
| `README.md` | 暂取上游 | 阶段 6 随文档整体重写（现在写会与上游新增章节打架） |
| `scripts/session-pin-sync.js` | 取分叉实现（上游逻辑超集） | 上游 10 用例 10/10 通过 |
| `test/session-pin-sync.test.js` | 保留上游版；分叉版改名 `test/session-pin-sync-queue.test.js` | 两套用例都在跑，一条没删 |

## 4. 验证证据

### 4.1 结构验证

```
$ git log -1 --format=%P 42e517e
0ff400224df37ad0353e78e6645dcda3bb9f9add 9b9bad5f4d8cbba36486bca455db6910a1c7b948
$ git ls-tree -r --name-only HEAD | wc -l
413
$ git ls-files --eol scripts/*.js | grep -c CRLF
0
```

### 4.2 分叉功能未丢（逐点 grep 证据）

| 功能 | 断言 |
|---|---|
| 接管/去重/权限路由 | `grep -c "'/api/rehome/\|'/api/permission/" scripts/daemon.js` → 12 条全在 |
| 模块接线 | `require('./rehome-sessions.js')`、`require('./rehome-watcher.js')`、`require('./permission-sync.js')` 均在 |
| 注入层 UI | `grep -c "wbs-sess-auto-all\|rehomeEnabled\|updateRehomeButton" scripts/inject.js` → 41 |
| 客户端路径兜底 | `grep "\[rehome\] 自定义安装盘符" scripts/lib.js` → 命中 |
| 昵称明文兜底 | `grep "\[rehome\] CDP accountSnapshot" scripts/lib.js` → 命中 |
| 启动器竞态修复 | `grep "taskkill 非零，延迟复验后目标 PID 已消失" scripts/win-launcher.js` → 命中 |
| 上游新功能同时在位 | `grep "wallpaper-video\|client-temp\|workbuddy-launch-env" scripts/daemon.js` → 命中 |

### 4.3 测试证据

合并后首轮全量（`node test/run-ci.js`）：

```
文件 190   用例 1688   通过 1632   失败 49   跳过 7
基线 schema 4   已知失败 49   新增失败 0   基线已修复 8
基线用例 1612   本次 1688   差 +76
退出码 0
```

- 上游 1.2.22 的 34 个改过的测试文件全部跑在合并后的树上，没有新增失败。
- 1688 - 1612 = +76：上游新增 5 个测试文件（`account-travel-badge`、`client-temp`、
  `conversation-area`、`theme-video` + 分叉 `session-pin-sync-queue`）以及上游多个
  测试文件本身扩了用例。
- 8 条历史失败现在通过了（`cdp-targets` 2 条、`i18n` 1 条、`sentry` 1 条、
  `token-refresh-persistence` 4 条）。**没有据此收紧基线**：删条目属收紧动作，
  留到独立提交做，避免和「合并上游」混在一起看不清。
- 分支上新增的验证：`node --test test/daemon-status-nonblocking.test.js` 11/11、
  `node --test test/session-pin-sync.test.js` 10/10、`node test/session-pin-sync-queue.test.js` PASS、
  `node test/deploy-safety.test.js` 14/14。

## 5. 阶段 2 验收对照

| 验收项 | 结论 | 证据 |
|---|---|---|
| 仓库已包含完整上游源码 | 是 | 树 413 文件；`git diff upstream/main --stat` 只剩 59 个分叉自有/改过的文件（46 新增 + 13 修改） |
| 上游 Git 历史可追溯 | 是 | 双父合并，`9b9bad5` 及其 18 个祖先进入本仓 |
| Fork 历史保留 | 是 | `33d0e66` 及 28 个提交完整在图上 |
| 增强功能没有丢失 | 是 | §4.2 逐点 grep + 190 个测试文件全跑 |
| 没有覆盖本机配置 | 是 | 全程未触碰真实安装目录/数据库 |
| 能识别当前上游基线 | 是 | `scripts/upstream.json` schema 4，1.2.20 / 1.2.22 双代哈希 |
| 核心文件均有明确来源 | 是 | `02-source-provenance.md` |
| 工作区干净 | 是 | `git status --short` 无输出 |
| 原功能测试通过或明确记录历史失败 | 是 | 49 条历史失败在基线内，新增 0 |

## 6. 遗留

1. `README.md` 仍是上游版，分叉的安装/数据/备份说明在阶段 6 一次性重写。
2. 8 条已修复的历史失败仍留在基线里（收紧动作待独立提交）。
3. 托盘 `tray/WorkDaddyTray.exe` 仍是仓库内二进制（R7），阶段 4 决定去留。
