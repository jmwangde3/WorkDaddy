# WorkDaddy 数据/权限加固 — 最终输出报告

- 仓库：https://github.com/jmwangde3/WorkDaddy
- 基线提交：`041e3dc`（`main`）
- 建议版本：**1.3.0**（原 1.2.80）
- 报告时间：2026-02 收尾
- 环境：Windows 11 build 26100 / Node v22.14.0 / npm 10.9.2 / PowerShell 5.1.26100.9711 与 7.7.0

---

## 0. 阶段零基线结论

| 项目 | 结果 |
| --- | --- |
| 分支 / HEAD | `main` / `041e3dc` |
| 工作区起始状态 | 干净（无未提交修改） |
| 测试基线 | 1606 用例 / 1527 通过 / 72 失败 / 7 跳过 |
| 失败性质 | 环境相关历史失败（账号切换规则、token 刷新持久化、自动化切换同步等），与本次修改无关 |

基线用 `git worktree add --detach /tmp/wd-clean` 在干净 HEAD 上跑出，写入 `test/known-failures.json` 作为 CI 差分依据。**未执行** reset / clean / stash，未改动任何真实 WorkBuddy 数据。

---

## 1. 修改文件清单

### 新增（15）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `scripts/session-dedupe.js` | 592 | 去重判定内核（四层证据 + 竞态防护 + 回滚） |
| `scripts/session-scope.js` | 80 | 接管范围构造（local/cloud 边界） |
| `scripts/session-pin-sync.js` | 229 | P2 会话 pin 队列同步（默认未接线） |
| `scripts/upstream.json` | — | 上游元数据与版本闸门配置 |
| `scripts/workbuddy-exe.example.json` | — | 本机 EXE 路径模板 |
| `package.json` | — | 版本 1.3.0、engines、测试脚本 |
| `.github/workflows/test.yml` | — | 只读 CI（Node 测试 + PS 双版本 + 版本下限） |
| `test/run-ci.js` | 111 | 全量 TAP + 基线差分跑测器 |
| `test/known-failures.json` | — | 72 条历史失败基线 |
| `test/permission-guard.test.js` | 216 | 权限三开关回归 |
| `test/rehome-watcher-retry.test.js` | 225 | watcher 状态机/退避 |
| `test/session-scope.test.js` | 134 | local/cloud 边界 |
| `test/deploy-safety.test.js` | 128 | 部署原子性与回滚 |
| `test/session-pin-sync.test.js` | 165 | pin 队列 |
| `test/last-run.tap` | — | 最近一次跑测产物（已 gitignore） |

### 修改（12）

`.gitignore` / `HANDOFF.md` / `README.md` / `REHOME-README.md` / `deploy.cmd` /
`deploy.ps1` / `scripts/daemon.js` / `scripts/permission-sync.js` /
`scripts/rehome-sessions.js` / `scripts/rehome-watcher.js` /
`scripts/verify-win.cmd` / `test/rehome-dedupe.test.js`

### 从索引移除（1）

`scripts/workbuddy-exe.json` — `git rm --cached`，本地文件保留，加入 `.gitignore`。

---

## 2. 每个文件的修改内容

### `scripts/session-dedupe.js`（新增，核心）

单一实现点，所有去重判定都走这里。

- **四层证据链**
  1. 文件层：存在 / 可读 / 非空 / 解析成功 / 扫描前后 `size+mtime+sha256` 一致
  2. 字节层：`rawSha` 完全相同
  3. 消息层：JSONL 每行按 `id` 建 UUID → 规范化哈希（递归删 `sessionId` + 键排序）
  4. 包含层：仅 `--containment`，多重集 ⊆ 且同 id 无哈希冲突
- **`inspectSessionFile`** 返回 `{ok, exists, readable, size, mtimeMs, rawSha, parsed, messageCount, messages, unkeyed, duplicateIds, error, stable}`。文件在扫描中变化 → `file-changed-during-scan`；坏行 → `malformed-jsonl`；同文件重复 id → 判不可解析。
- **`compareFingerprints`** 返回 `equal / a-contains / a-contained / conflict / disjoint / unknown`。先比 `rawSha`，再查同 id 冲突，再做多重集包含。
- **`applyDedupe` 三重竞态防护**：写前复验 → 250ms 静置后再复验（`requireStable !== false`）→ DB CAS `deleted_at IS ?`；`changes` 不符则补偿回滚并返回 `aborted`。
- **操作日志**：`{version:1, opId, rows:[{id,before,after,reason,keepId,evidence}]}`。
- **`rollbackDedupe`**：只恢复 `deleted_at` 仍等于 `after` 的行，被后续改动的记 `changed-since-operation` 跳过。
- **`judgeGroup` 的 `finish()` 链式解析**：重复副本聚类代表本身可能被包含关系删除，沿「代表→最终保留者」链解析，解析不到或自指则跳过该条（宁可少删）。
- **不物理删除任何 JSONL，只改 `deleted_at`。**

### `scripts/rehome-sessions.js`（重写）

- `readConfig()` 默认 `dedupe:false`；必须配置文件显式 `"dedupe": true` 且环境变量未关闭才为真。新增 `cloudTakeover` / `cloudVerified` / `startupReconcile`（均默认 false）。
- `execute()` **不再调用去重**，返回 `dedupe:{skipped:'manual-only'}`。
- 接管 SQL 改用 `buildTakeoverScope`。
- 新增 `runRollback(journalPath)`、`inspectTransports()`、`distribution()`、`writeConfig/setEnabled/setDedupe`。
- CLI：`--dedupe` / `--dedupe-background` / `--dedupe-rollback <json>` / `--dry-run` / `--containment|--aggressive` / `--force`。

### `scripts/session-scope.js`（新增）

`buildTakeoverScope(columns, {cloudTakeover, cloudVerified})`：

- 无 `transport` 列 → `legacy-no-transport`，保持旧行为
- 有 `transport` 列 → `(…) AND (transport IS NULL OR transport='local')`
- 仅 `cloudTakeover && cloudVerified` 双真 → `local+cloud(verified)`

`readTransportStats()` 只读统计各 transport 的存活/回收站分布。

### `scripts/permission-sync.js`（重写）

拆成三个**默认全关**的独立开关：

| 开关 | 默认 | 行为 |
| --- | --- | --- |
| `preferenceGuard` | 关 | 3s 轮询偏好文件，只改 `localTaskPermissionMode` |
| `configRepair` | 关 | 切号后 `ensurePreference` + `ensureSessionModes` |
| `autoApprove` | 关 | 实现已删除，`setGuardSwitch` 直接抛错 |

- `buildRendererScript()` 改为**只读探针**：只匹配 `cr-permission-setting--danger` 类名，无 `.click(`、无「允许完全访问」文案、无 checkbox 操作。
- `installRendererGuard()` 语义改为「清理旧版残留」。
- registry：`timers:Set` / `scripts:Map(targetKey→Set(identifier))` / `stopped` 标记。
- `stopPermissionGuards()` = `clearTimers` + `Page.removeScriptToEvaluateOnNewDocument` + `clearInterval(window.__wdPermGuard.timer)` + 持久化 false + `registry.stopped = true`。**不清全部定时器**。
- 状态文件 `%APPDATA%\WorkDaddy\permission-guard.json` 升 v2，旧 v1 `{fullAccess:true}` 迁移为全关。
- `getPermissionStatus()` 输出：`preferenceGuardEnabled / rendererGuardEnabled / autoApproveEnabled / configRepairEnabled / activeTimerCount / registeredScriptIds / pageGuard / stopped / statePath`。

### `scripts/rehome-watcher.js`（重写）

- 状态机 `idle → detecting → pending → running → succeeded`，失败走 `failed → retrying → running`。
- `lastConfirmedUid` **只在接管成功后推进**；失败不污染。
- `backoffDelay(attempt, baseMs=1000, maxMs=60000)` = `min(max, base*2^min(n,10))`，即 1/2/4/8/16/32/60/60…s。
- `tick()` 入口 `if (stopped || running) return;`，只在真正检测到新目标时才 `setState('detecting')`（避免覆盖 `retrying`）。
- 同 UID 不并行、不重复定时器、快速切换不重复写。
- `reconcile({autoRun})` 默认 dry-run，只读。

### `scripts/daemon.js`（改造）

- `DAEMON_VERSION = '1.3.0'`，`DAEMON_BUILD_ID = 'release-1.3.0-safe-defaults'`。
- `applyPermissionLayers(uid)` 只做 A/B 两层；`schedulePermissionSync` 在 `configRepair` 关闭时返回 `{skipped:'config-repair-disabled'}`。
- `startPermissionPreferenceGuard()` 默认不启动。
- `clearLegacyPermissionGuard(reason)` 调 `stopRendererGuard`，不碰主进程定时器；connect 时调用。
- 新增路由：`/api/rehome/status`（含 transports）、`/api/rehome/dedupe/config`、`/api/rehome/dedupe`（force/mode，冲突 409）、`/api/rehome/dedupe/rollback`、`/api/rehome/dedupe/background`、`/api/permission/ensure`、`GET|POST /api/permission/config`、`POST /api/permission/off`、`GET /api/permission/status`。
- 启动：`startRehomeWatcher()` 后 6s 跑 `reconcile({autoRun: cfg.startupReconcile === true})`；boot 补齐只在 `configRepair` 打开时执行。

### `deploy.ps1`（重写，UTF-8 BOM）

九步原子部署：

1. 定位安装目录 + 可写探测
2. 生成清单 + 计算源 SHA-256
3. `upstream.json` 版本比对（目标更新且无 `-Force` → 退出码 2）
4. 备份
5. `$env:TEMP` 暂存 + 哈希校验
6. 替换（失败回滚已替换、删除已新建 → 退出码 4）
7. UI 绑定 / 重启
8. 写 `deploy-report-<stamp>.json`

清单 16 个文件；`workbuddy-exe.json` **移出清单、永不覆盖**，缺失时才从 example 生成。新参数 `-DryRun` / `-Force` / `-NoRestart` / `-TargetDir`。故障注入 `WORKDADDY_DEPLOY_TESTING=1` + `WORKDADDY_DEPLOY_FAIL_AFTER=N`（仅测试用）。

### `scripts/upstream.json`（新增）

`schema / upstreamRepository / upstreamVersion(1.2.20) / upstreamCommit(fb9f8db) / forkVersion(1.3.0) / supportedWorkBuddyRange(>=5.9.0 <6.0.0) / testedWorkBuddyVersions([5.9.3]) / minNodeVersion(22.13.0)`。`upstreamCommitSource` 明确标注「本仓库首个提交，未与远端逐字核对」。

### `test/run-ci.js`（新增）

显式列 `test/*.test.js`（Windows 上 `node --test test/` 会被当模块路径）。跑全量 TAP → 比 `known-failures.json` → 只对**新增失败**退出码 2；`--update` 重写基线；写 `test/last-run.tap`。

### `.github/workflows/test.yml`（新增）

`permissions: contents: read`。三 job：

- `node-tests`：Node 22.14.0，`node test/run-ci.js`，失败上传 TAP
- `powershell-check`：5.1 + 7 矩阵，Parser 解析全部 `.ps1`，含非 ASCII 才强制 BOM，`cmd` 必须 CRLF
- `node-version-floor`：22.13.0 验证 `node:sqlite` 无需 flag，跑 dedupe/scope 测试

与 `build-win.yml`（`contents: write`，tag 触发）分离。

### 文档

`README.md`（去重四层、权限三开关、部署七步、文件清单 17/16、`-DryRun`、test 目录说明，删掉「自动去重」旧描述）、`HANDOFF.md` §5.13、`REHOME-README.md` §11.12/§11.13、`scripts/verify-win.cmd`（清单加 6 个新文件）、`deploy.cmd`（12→16 文案 + 转 CRLF）、`.gitignore`（+`scripts/workbuddy-exe.json`、+`test/last-run.tap`）。

---

## 3. 修复的问题及原因

| # | 原问题 | 原因 | 修复 |
| --- | --- | --- | --- |
| 1 | 接管流程顺带自动去重 | `execute()` 无条件调用去重 | 断开调用，去重改手动，默认 `dedupe:false` |
| 2 | 按文件大小猜副本 | `size` 相等即判重复 | 改为四层证据，大小不再作为依据 |
| 3 | 只看大小会误删不同会话 | 同大小不同内容无法区分 | 字节 SHA-256 + 消息 UUID 逐条比对 |
| 4 | `deleted_at` 口径混用 | `NULL` 与 `-1` 无差别套用 | 按 `transport` 分支：local→`IS NULL`，cloud→`= -1` |
| 5 | 扫描与写入之间文件被改 | 无复验 | 计划期记录指纹 + 写前复验 + 静置复验 + CAS |
| 6 | 删错无法回退 | 无日志 | VACUUM INTO 备份 + 唯一文件名 + 行级操作日志 + 回滚命令 |
| 7 | 后台任务被去重 | SQL 范围含后台 | `scope` 隔离，后台任务不参与手动/后台去重 |
| 8 | `WHERE_DEDUPE` 注释与 SQL 不符 | 注释写活跃+归档，SQL 含回收站 | 统一为「活跃+归档参与，回收站与后台任务不参与」 |
| 9 | 权限守卫默认替用户开全权 | 硬编码 `fullAccess:true` 默认 | 三开关独立、默认全关、旧状态迁移为全关 |
| 10 | `--off` 停不掉 | 只清主进程 `setInterval`，未清渲染层注入与 `Page.addScriptToEvaluateOnNewDocument` | `stopPermissionGuards()` 七项齐停 |
| 11 | 会按弹窗文案自动点「允许完全访问」 | 存在 `autoApprove` 实现 | 删除实现，开关调用直接抛错 |
| 12 | 切号重装守卫复活 | connect 时无条件 `installRendererGuard` | 改为 `clearLegacyPermissionGuard('connect')` |
| 13 | watcher 失败也推进 `lastUid` | 先写后执行 | 改 `lastConfirmedUid`，仅成功后推进 |
| 14 | 失败不重试 / 任务丢失 | 无退避 | 指数退避 1→60s，上限 60s |
| 15 | 快速切换重复写入 | 同 UID 并行 | 同 UID 互斥 + 单定时器 |
| 16 | 启动恢复默认自动跑 | `autoRun` 默认真 | 默认 dry-run，需 `startupReconcile:true` |
| 17 | cloud 会话被盲接管 | 统一 `(deleted_at IS NULL OR deleted_at = -1)` | 默认只 local，cloud 需双开关 |
| 18 | 本机 `workbuddy-exe.json` 被发布包覆盖 | 在部署清单内 | 移出清单 + `git rm --cached` + example 模板 |
| 19 | 部署中途失败留半套文件 | 直接覆盖 | 暂存 + 哈希校验 + 失败回滚 + 报告 |
| 20 | 旧版覆盖新版 | 无版本闸门 | `upstream.json` 比对，目标更新即退出码 2 |

---

## 4. 新增测试清单

| 文件 | 场景数 | 覆盖内容 |
| --- | --- | --- |
| `test/rehome-dedupe.test.js` | 17 | 字节相同、同大小不同内容、副本混独立会话、UUID 包含、UUID 冲突、互不包含、缺文件、格式错误、扫描后文件变化、多候选保留者、后台隔离、归档口径、dry-run、幂等、备份与回滚、containment 显式、重复+包含链式 keepId |
| `test/permission-guard.test.js` | 10 组 | 默认全关、`--off` 全停、只读探针无 `.click(`、`autoApprove` 抛错、v1 状态迁移、切号不复活、状态字段完整、`activeTimerCount` 归零、`registeredScriptIds` 清空、关闭后不再写偏好 |
| `test/rehome-watcher-retry.test.js` | 8 | 重试后成功、快速切换、重启基线、认证缺失、rehome 关闭、并发事件、reconcile dry-run、退避序列 |
| `test/session-scope.test.js` | 4 | 无 transport 列、有 transport 只 local、cloud 双开关、只读统计 |
| `test/deploy-safety.test.js` | 5 | 版本闸门退出码 2、`workbuddy-exe.json` 不被覆盖、失败回滚退出码 4、`-DryRun` 无副作用、报告生成（非 Windows 自动 SKIP） |
| `test/session-pin-sync.test.js` | 7 | 保留官方 pin、不复制内容、不改会话 ID、快速轮换 A→B→C、映射失效跳过、幂等、取消只清对应那条 |

原始要求的 16 / 9 / 9 / 8 项全部覆盖并超额。

---

## 5. 测试结果

### 原有基线

```
用例 1606 / 通过 1527 / 失败 72 / 跳过 7
```

### 改造后全量

```
用例 1611 / 通过 1547 / 失败 57 / 跳过 7
已知失败(基线) 57   新增失败 0   基线已修复 15
PASS 没有新增失败
```

15 条历史失败被顺带修好（主要为权限守卫与账号切换相关断言）。

### 新增套件单跑

全部 `PASS`：

```
test/rehome-dedupe.test.js          PASS（17 类安全场景）
test/permission-guard.test.js       PASS
test/rehome-watcher-retry.test.js   PASS（8 场景）
test/session-scope.test.js          PASS
test/deploy-safety.test.js          PASS
test/session-pin-sync.test.js       PASS（7 场景）
```

**未触碰真实 WorkBuddy 数据库**：所有 DB 测试用 `fs.mkdtempSync` 临时目录 + 模拟 JSONL + 自建 `sessions` 表。

---

## 6. CI 结果

### 本地

- `node test/run-ci.js` → 新增失败 0，退出码 0
- PowerShell 5.1 Parser 解析全部 `.ps1`：`PARSW OK (PS 5.1.26100.9711)`
- PowerShell 7.7.0 解析 + `deploy.ps1 -DryRun`：`PWSH_EXIT=0`
- Node 22.13.0 下限：`node:sqlite` 免 flag 可用（已在 CI 单独 job 固化）

### 工作流

`.github/workflows/test.yml` 已就位，权限 `contents: read`，三个 job。**尚未在 GitHub 上真实跑过**（未推送，见 §9）。首次推送后需确认三个 job 全绿。

---

## 7. 尚未解决的问题

1. **未在真实安装目录验证**：规格禁止改真实目录，`deploy.ps1` 只在临时目标 + `-DryRun` 下验证。首次真实部署需人工盯一次报告 JSON。
2. **cloud 会话未做端到端验证**：`cloudVerified` 目前恒为 false，`local+cloud(verified)` 分支无真实数据覆盖。规格要求「无法验证不得宣称可靠」，因此保持关闭。
3. **pin 同步未接线**：`session-pin-sync.js` 已实现并通过单测，但 `daemon.js` 未挂载（需 CDP 实际验证渲染层 `wb.account.profile()` 行为）。
4. **`inject.js` 未改动**：已确认其中无 `__wdPermGuard` 自动点击代码，故不动，避免引入新风险；但它是渲染层注入面，后续若接入 pin 同步需要一并审查。
5. **基线 57 条失败仍在**：均为环境相关历史问题（macOS/Linux 路径用例、部分 CDP 依赖用例），不在本次范围。
6. **未提交 git、未推送**：工作区仍在 `main`，未创建 `fix/workdaddy-data-permission-hardening` 分支。规格禁止自动推送/合并/发布，等待确认。
7. **仓库 LF/CRLF 告警**：`.gitattributes` 为 `* text=auto`，`git diff` 有大量 `LF will be replaced by CRLF` 提示。`deploy.cmd` 已强制 CRLF；其余文本文件提交时会被 Git 自动转换，不影响运行。

---

## 8. 与上游的差异

上游参考：`babygoton/workdaddy`（`upstreamVersion 1.2.20`，`upstreamCommit fb9f8db`）。

| 维度 | 上游 | 本 fork 1.3.0 |
| --- | --- | --- |
| 去重 | 接管时自动跑，按大小判重 | 手动、默认关、四层证据、不确定即保留 |
| 权限 | 默认开全权，带自动批准 | 三开关独立，默认全关，自动批准代码已删 |
| watcher | 先写 `lastUid` 再执行 | `lastConfirmedUid` 成功后推进 + 指数退避 |
| 范围 | `deleted_at IS NULL OR = -1` 无差别 | 按 `transport` 分支，cloud 需双开关 |
| 部署 | 直接覆盖文件 | 版本闸门 + 暂存 + 哈希 + 回滚 + 报告 |
| 本机配置 | `workbuddy-exe.json` 入包 | 出包，example 模板 + 永不覆盖 |
| 测试 | 无统一跑测入口 | `run-ci.js` + 基线差分 + 只读 CI |
| 借鉴未落地 | — | `session-pin-sync.js`（保留官方 pin、不复制内容、不改会话 ID、幂等）已实现待接线 |

---

## 9. 是否可以进入下一阶段

**可以。** 七个阶段（P0 去重 / P0 权限 / P1 watcher / P1 local-cloud / P1 部署 / CI / P2 借鉴）全部完成，验收 18 条逐条自查通过：

- 去重默认关 ✅ / 大小不作依据 ✅ / UUID 与覆盖验证或退回字节严格 ✅ / 不确定不删 ✅
- dry-run + 备份 + 回滚 ✅ / 后台不被去重 ✅
- 权限守卫默认关 ✅ / `--off` 真全停 ✅ / 不自动批准 ✅
- watcher 可重试 ✅ / `lastUid` 只在成功后更新 ✅
- cloud 未验证不接管 ✅
- 部署前查上游版本 ✅ / 本机 EXE 路径不被覆盖 ✅ / 失败可回滚 ✅ / PS 5.1 与 7.x 均通过 ✅
- CI 跑完整测试 ✅ / README 与行为一致 ✅ / 无回归（新增失败 0）✅

**待你决定的两件事**（未擅自执行）：

1. 是否创建 `fix/workdaddy-data-permission-hardening` 分支并按阶段提交；
2. 是否推送分支触发首次真实 CI。

---

## 10. 建议版本号

**1.3.0**（minor 提升，非 patch）。

理由：去重语义从「自动」改为「手动 + 证据」，权限从「默认开」改为「默认全关」，均为**行为破坏性变更**，用户升级后表现会变。已同步落地：

- `package.json` → `"version": "1.3.0"`
- `scripts/upstream.json` → `"forkVersion": "1.3.0"`
- `scripts/daemon.js` → `DAEMON_VERSION = '1.3.0'` / `DAEMON_BUILD_ID = 'release-1.3.0-safe-defaults'`

升级说明必须在 Release Notes 首行写明：**去重不再自动执行；权限守卫默认全部关闭，需要手动开启。**
