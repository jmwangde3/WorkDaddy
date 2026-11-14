# WorkDaddy 1.3.0 发布前复核报告

- 仓库：`H:\AI工作区\wb账号同步\WorkDaddy`
- 复核分支：`fix/workdaddy-data-permission-hardening`（从 `main` @ `041e3dc` 拉出，`main` 未动）
- 本轮提交：第一轮 1 个 + CI 适配 3 个（已推送，CI 全绿）；第二轮 P0/P1 修复 1 个（本地，待推）
- 复核日期：2026-11-14
- 环境：Windows 11 26100 / Node v22.14.0 / PS 5.1.26100.9711 / PS 7.7.0

## 0. 结论摘要

六个复核项全部有了明确结论：**9 处判定逻辑被收紧，3 处宁可少删的跳过条件新增，1 处语义冲突消解，1 组上游元数据换成实测值**。

- 发现并修复的实质问题：**9 个**（其中 4 个会导致误删或误判、2 个会让新增失败被误判为历史失败、1 个是本机文件被降级的风险、1 个是停止不彻底、1 个是语义自相矛盾）
- 复核后新增测试：去重 +4 类、范围 +2 组、权限 +2 组、部署 +3 组
- 全量结果（第二轮后）：**1612 用例 / 1552 通过 / 53 失败 / 7 跳过 / 新增失败 0**（退出码 0）
- 未触碰：真实 WorkBuddy 数据库、真实安装目录、`main` 分支历史

**已推送并跑通 GitHub CI**（首轮三轮适配见 §7）。第二轮四项修复见 §9。


---

## 1. 复核方法

- 只读真实数据库只用于「确认字段取值分布」类判断，且全部通过临时目录 + 模拟 JSONL/临时 SQLite 复现，测试里不含任何真实路径。
- 部署脚本只在临时 `-TargetDir` + `-DryRun` 下验证；`WORKDADDY_DEPLOY_TESTING` 故障注入仅测试进程内使用。
- 上游元数据通过 GitHub REST API 实查，不靠仓库内注释。

---

## 2. 逐项复核结论

### 2.1 `scripts/session-dedupe.js`

| # | 发现 | 性质 | 处理 |
|---|---|---|---|
| 1 | `canonicalize()` **递归**删除同名 `sessionId` | **会掩盖真实内容差异** | 已修：只删 `depth === 0` |
| 2 | `ok` 未包含 `parsed`；重复 UUID 时 `ok=true / parsed=false` 自相矛盾 | 状态位错误，下游靠 unknown 兜住 | 已修：新增 `error='duplicate-message-ids'`，`ok` 含 `parsed` |
| 3 | 字节相同判定排在 `ok` 之后 | 有重复 UUID 但逐字节相同的文件被一刀切拒绝 | 已修：`rawSha` 相同提前返回，`verifyPlanFiles` 只看存在/大小/哈希 |
| 4 | 包含关系只比集合，不看**顺序** | 两条独立会话撞了相同消息时可能被误判 | 已修：要求被包含者消息 id 序列是容器的**子序列** |
| 5 | 未处理**附属产物**（`<id>/`、`<id>.png`） | 判错会让人以为会话连附件一起丢 | 已修：有附属产物 → 整组保留 |
| 6 | 未处理**相对路径附件引用**（`images/a.png`） | 同名文件在不同会话目录下可能内容不同 | 已修：`relativeArtifactRefs > 0` 时只认逐字节相同 |
| 7 | 时间戳未参与任何判定 | 不是缺陷：`updated_at` 本来就不该用于反选（已在文档写明） | 保持 |
| 8 | 未知记录类型（无 `id`）按多重集比较 | 不是缺陷：内容哈希包含全部字段，不同类型必然不同 | 保持（保守方向：宁可不判） |
| 9 | 坏行 / 空文件 / 扫描中变化 | 已是整组保留 | 保持 |

**关于「工具调用 / 工具结果 / 附件 / 图片 / 不同消息类型」的结论**：这些记录全部按「整条记录规范化后的哈希」参与比较，`type` 字段本身也在哈希里，所以不同类型天然不同；工具调用的参数与工具结果正文都是内容，不会因为规范化被抹掉。唯一被抹掉的是每行最外层的 `sessionId`，而那正是复制时被改写的字段。

### 2.2 `scripts/session-scope.js`

| # | 发现 | 处理 |
|---|---|---|
| 1 | local-only 谓词仍是 `(deleted_at IS NULL OR deleted_at = -1)` | 已修：收紧为 `deleted_at IS NULL AND (transport IS NULL OR transport='local')` |
| 2 | 没有验证 `deleted_at` 编码是否与 transport 自洽 | 新增 `assessDeletedSemantics(db)`：按 transport 分组统计 `NULL / -1 / >0 / =0`，不一致即 `verified=false` 并列 `issues` |
| 3 | 未知 transport 值（既非 local 也非 cloud）会被 union 谓词扫进来 | 已修：strict 谓词天然排除；`unknownTransports` 单独报出 |

**legacy（无 transport 列）模式**：老库没有云会话，来源可确定（全 local），因此保留旧的 `IS NULL OR = -1` 行为，但把 `-1` 行数作为 `issues` 暴露出来（`legacy-minus-one-rows`），不假装已验证。

**「不确定即只读」的落点**：来源不明（未知 transport）与编码异常（local 上的 `-1`、cloud 上的 `NULL`）的行**永不进入写入范围**，只在 `--status` / `inspectTransports()` 里报告。这比「整库只读」更精确：能确定的行照常处理，确定不了的行一个都不动。

### 2.3 `known-failures.json` + `test/run-ci.js`

| # | 发现 | 处理 |
|---|---|---|
| 1 | 多文件 TAP 流的失败行**不带文件名** | 已修：改逐文件跑，基线 schema 3 存 `{file, name}` 双匹配 |
| 2 | 匹配用 `^not ok`（不容忍缩进） | 已修：`^\s*not ok`，嵌套子测试也能捕获 |
| 3 | 只检查「有 fresh 就失败」，进程半途挂掉仍可判 PASS | 已修：`counts.tests < 基线用例数` → 退出码 4；`status!==0 且无失败行` → 退出码 3 |
| 4 | 解析到的失败数与 TAP `# fail` 不一致时静默通过 | 已修：不一致 → 退出码 5 |

**严格性实测**：临时造了一个新文件 `zz-strictness-probe.test.js`，里面放一条**与历史失败同名**的用例。结果：
```
已知失败(基线): 57    新增失败: 1
- zz-strictness-probe.test.js :: switch route reloads without syncing when no rule is enabled
[+] 新增测试文件 1 个
```
即「同名但不同文件」不再被误判为历史失败。验证后已删除该探针。

**1606 → 1611 的统计口径**（这是原报告没解释清楚的地方）：

- `test/*.test.js` 里有两类文件：
  - 用 `node:test` 的：每个 `test()` 是一条 TAP 用例；
  - 自己写 runner、`console.log('ok - …')` 再 `process.exit` 的：整个文件在 TAP 里**只算 1 条**（Node 把文件本身当一条测试），内部的 17 / 8 / 7 / 4 个场景全部不可见。
- 上一轮新增 5 个"自写 runner"文件（`permission-guard` / `rehome-watcher-retry` / `session-scope` / `deploy-safety` / `session-pin-sync`），每个 +1 条 → **+5**。
- `rehome-dedupe.test.js` 改造前就存在，本来就算 1 条，所以不加。
- 1606 + 5 = **1611**。而「场景数」是另一套计数：本轮 `run-ci.js` 会单独统计自报的 `ok -` 行（当前 14 条），并明确标注「不计入 TAP 用例数」。

也就是说：**1611 不是断言数，是文件级用例数**；真实断言数远大于此。这个口径现在写进了 CI 输出，不再靠口头解释。

### 2.4 `scripts/upstream.json`

实查结果（GitHub REST API，2026-11-14）：

| 项 | 值 |
|---|---|
| 上游仓库 | `github.com/babygoton/WorkDaddy` |
| 分支 | `main` |
| **真实 HEAD** | `9b9bad5f4d8cbba36486bca455db6910a1c7b948` |
| 提交时间 / 信息 | 2026-11-13T13:36:57Z / `merge: integrate 1.2.22 into main` |
| **版本** | **1.2.22**（原记录写的 1.2.20 是错的） |

**分叉基线**：本仓库首个提交 `041e3dc` 是**整棵工作树导入**，不是任何上游提交的后代（`git merge-base` 无法给出有效祖先）。所以：

- `upstreamCommit` 旧值 `fb9f8db` **无法核实，已弃用**；
- `fork.baseIsUpstreamAncestor = false` 写进元数据；
- 版本号闸门降级为 **advisory**（默认只提示，`-StrictVersionGate` 才阻断）。

**部署文件与上游版本的对应关系**（这是本轮最重要的发现）：

| 文件 | 本 fork | 上游 1.2.22 | 结论 |
|---|---:|---:|---|
| `daemon.js` | 737 067 | **749 088** | 本 fork 少 **12 021** 字节 → 补丁基线不是 1.2.22 |
| `inject.js` | 1 378 619 | **1 386 282** | 少 **7 663** 字节 → 同上 |
| `lib.js` | 97 154 | 96 050 | 本 fork 更大（有新增） |
| `win-launcher.js` | 88 039 | 85 801 | 本 fork 更大（有新增） |
| `session-pin-sync.js` | 9 854 | **5 723（上游已有同名文件）** | 名字冲突，本 fork 实现**不进部署清单** |

由此立起**文件代际闸门**（硬拦）：如果目标文件的字节数 == 上游 1.2.22 实测字节数，说明装的是**没打过我们补丁的原版**，覆盖会丢掉上游修复（例如 1.2.22 的 pin 同步、过期账号跳过积分查询）。这条判据是**可测量的字节事实**，不是版本字符串推断，因此可以作为硬拦；`-Force` 可越过。

### 2.5 `--dedupe-background` 与后台隔离的语义冲突

**冲突确认**：原实现里 `--dedupe-background` + `--force` 会直接写库，而文档同时写着「后台任务不参与去重」。两条规则在同一个仓库里互相矛盾。

**消解方式**（不删入口，加双重显式）：

1. `allowBackground: true` —— 承认「我知道这次动的是后台任务」；
2. `apply: true` —— 承认「我知道这次会写库」。

行为矩阵：

| 参数 | 结果 |
|---|---|
| 只有 `--dedupe-background` | `skipped: background-dedupe-requires-allow-background`，零写入 |
| `+ --allow-background` | 只读计划，打印将删哪些，零写入 |
| `+ --allow-background --apply` | 执行（仍需配置 `dedupe:true` 或 `--force`） |

daemon 的 `POST /api/rehome/dedupe/background` 同步改为默认 `dryRun`。人工去重（`--dedupe`）与接管流程仍然严格排除 `is_background_automation = 1`。

### 2.6 权限守卫关闭后的彻底性

| 层 | 原状态 | 现状态 |
|---|---|---|
| 主进程 `setInterval` | 清本模块登记的 | 同（另补 `clearTimeout` 兜底） |
| 页面 `window.__wdPermGuard.timer` | 清 | 清 |
| 页面 MutationObserver | **未处理** | `disconnect()`（`observer` / `mutationObserver` / `mo` 三个已知字段） |
| 页面事件监听器 | **未处理** | 对 `g.handlers` / `g.listeners` 登记的 handler 做 `removeEventListener`（capture + bubble 各一次） |
| 残留全局对象 | **未处理** | `delete` 5 个已知名（`__wdPermGuard` / `Installed` / `Version` / `__wdPermAutoApprove` / `__wdPermTimer`） |
| CDP `Page.addScriptToEvaluateOnNewDocument` | 只清内存登记 → **daemon 重启后残留无法删除** | identifier **落盘**（`permission-guard.json` v2 `registeredScripts`），重启后仍能删 |
| 未知结构的监听器 | 无法保证 | 检测到旧守卫对象时返回 `needsReload: true`；`--reload` / `reload:true` 发 `Page.reload` 彻底清 |

**诚实边界（写进 README 与输出）**：
- 旧版守卫的监听器结构没有文档，只能按已知字段名拆；拆不掉的只有重载能保证消失。
- CLI 进程没有 CDP 会话，页面侧清理必须走 daemon 的 `POST /api/permission/off`；`--off` 会明确打印这条提示，不假装已完成。

---

## 3. 本轮修改文件清单

| 文件 | 改动 |
|---|---|
| `scripts/session-dedupe.js` | 规范化限深；`duplicate-message-ids`；字节判定前置；`relativeArtifactRefs` / `sidecars` / `order` 三个新指纹；`isSubsequence` 顺序证据；`finish()` 支持 note 透出 |
| `scripts/session-scope.js` | `LIVE_LOCAL` / `LIVE_CLOUD` 拆分；local 谓词收紧；新增 `assessDeletedSemantics()`；`unknownTransports` / `issues` |
| `scripts/rehome-sessions.js` | 后台去重双开关；`execute()` 返回 `scopeReport`（含语义体检）；`inspectTransports()` 带体检；CLI `--allow-background` / `--apply` |
| `scripts/daemon.js` | `/api/rehome/dedupe/background` 默认只读 + 双开关 |
| `scripts/permission-sync.js` | 落盘 `registeredScripts`；`rememberSend/rememberScript/persistedScripts`；页面拆除扩到 observer/listener/全局对象；`reload` 选项；CLI `--off --reload` |
| `scripts/upstream.json` | schema 2；实测上游 1.2.22 @ `9b9bad5`；`fileGenerationGate`；`conflicts`；`versionGate.mode = advisory` |
| `deploy.ps1` | 版本号闸门降级 advisory；新增文件代际硬闸；新增 `-StrictVersionGate` / `-StrictFileGate`；兼容 5.1/7.x |
| `test/run-ci.js` | 逐文件跑；基线 schema 3；四道闸（解析一致性/用例下限/文件崩溃/新增失败） |
| `test/known-failures.json` | 重写为 schema 3（57 条，带文件名） |
| `test/rehome-dedupe.test.js` | 21 类场景（+4） |
| `test/session-scope.test.js` | 6 组（+2） |
| `test/permission-guard.test.js` | +2 组（页面残留、落盘脚本） |
| `test/deploy-safety.test.js` | 8 组（+3） |
| `README.md` / `REHOME-README.md` / `HANDOFF.md` | 同步上述行为；新增 §11.14 / §5.14 复核记录 |

---

## 4. 测试结果

```
逐文件全量：185 个文件（第二轮新增 run-ci-signature.test.js）
用例 1612 / 通过 1552 / 失败 53 / 跳过 7
基线 57 条：命中 53，4 条已不再失败（CRLF 检出造成的假失败，行尾规范化后消失，未从基线里删除）
已知失败(基线) 53   新增失败 0
基线用例 1612   本次 1612   差 +0
基线 schema 4（文件 + 用例名 + 规范化错误签名，三重匹配）
退出码 0
```

同一个 commit 在 CI（run `43588287807`）上是 **1612 用例 / 1554 通过 / 51 失败 /
7 跳过 / 新增失败 0**。差的 2 条是 `automation-packages` 与 `workbuddy-compat`
在 CI 通过、本机失败 —— 环境相关的历史噪声，两边「新增失败」都是 0。

| 套件 | 结果 |
|---|---|
| `rehome-dedupe.test.js` | PASS — 24 类场景（含同 ID 乱序 / 无 ID 乱序 / 混合乱序） |
| `session-scope.test.js` | PASS — 6 组（含真实临时 SQLite 验证 `-1` 不被接管） |
| `permission-guard.test.js` | PASS |
| `rehome-watcher-retry.test.js` | PASS — 8 场景 |
| `deploy-safety.test.js` | PASS — 13 组（含同大小不同内容、pristine、unknown、`-Force` / `-ForceVersion` 分离） |
| `run-ci-signature.test.js` | PASS — 13 组（含 2 条「同名不同错误必须算新增」负例） |
| `rehome-sessions.test.js` | PASS — 含「老库 -1 默认阻断写入」+「显式承认后 `-1` 仍不接管」 |
| `session-pin-sync.test.js` | PASS — 7 场景 |

静态检查：

- PS 5.1：全部 `.ps1` 解析通过（`PARSW OK all .ps1`）
- PS 7.7.0：`deploy.ps1` 解析通过（`PWSH PARSE OK 7.7.0`）
- PS 7.7.0：`deploy.ps1 -DryRun` 退出码 0（临时目录，`already-patched` 判定正确）

---

## 5. 剩余风险

| # | 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 补丁基线不是上游 1.2.22 | 直接部署到 1.2.22 安装目录 | 丢失上游修复（含 pin 同步） | 文件代际硬闸；`-Force` 才越过 |
| R2 | 上游 HEAD 会继续前进 | 上游再发版 | 哈希不同 → 判 `unknown-generation`，默认中止（`-Force` 才越过） | 重跑 API 更新 `upstreamFileHashes` |
| R3 | 旧守卫监听器结构未知 | 1.2.80 装过且页面没重载 | 极少数监听器可能残留 | `needsReload` + `--reload` |
| R4 | cloud 会话端到端未验证 | 开启 `cloudVerified` | 可能改错云会话归属 | 默认关；代码不自动置真 |
| R5 | 相对路径附件引用 | 客户端未来改成相对路径 | 去重能力下降（退化为只认字节） | 安全方向，不误删 |
| R6 | 57 条历史失败仍在 | — | 真回归可能被淹没在噪声里 | 三重匹配（文件+名字+错误签名）+ 四道闸；新增失败与「同名换原因」一定报 |
| R7 | `zz` 探测验证依赖人工 | — | — | 已实测一次并删除探针 |
| R8 | CI 环境与本地差异 | 后续提交 | 行尾/编码/时区类失败 | 已在 GitHub 真跑通三轮适配（§7），`.gitattributes` 钉死 LF |

---

## 6. 是否具备推送条件

**具备，且已执行。** 判断依据：

1. 全量测试退出码 0，新增失败 0，基线 schema 4 已固化；
2. 分支 `fix/workdaddy-data-permission-hardening` 独立，`main` 仍停在 `041e3dc`，历史未被改写；
3. 已提交，工作区干净；
4. `deploy.ps1` 在 PS 5.1 与 7.7.0 双版本解析通过，`-DryRun` 实跑通过；
5. CI workflow 只申请 `contents: read`，不含任何发布/写 Release 步骤。

推送已获授权并完成（首次推送 commit `0bebf5f` 之前那一串），CI 结果见 §7。
第二轮仍只推这个独立分支，不合并、不发 Release。

## 7. 推送与首轮 CI（2026-11-14）

分支已推送，`main` 未动（远端 `main` 仍为 `041e3dcb`）。首轮 CI 连挂三轮，
全部为 CI 环境适配问题，非安全改造回归；逐轮修复记录见 commit：

| commit | 问题 | 修法 |
| --- | --- | --- |
| `46b6c91` | 工作流 0 秒 0 job：`steps[*].shell` 不接受 `${{ matrix.* }}` | 检查逻辑落到 `.github/scripts/check-powershell.ps1`，`shell: bash` + `matrix.exe` 起子进程 |
| `4506d42` | 新增失败 16 条：runner `autocrlf=true` 让 `.js` 检出成 CRLF；另 1 条是 cp1252 下 `print` 中文崩溃 | `.gitattributes` 加 `* text=auto eol=lf`；品牌化块加 `sys.stdout.reconfigure(encoding='utf-8')` |
| `be55268` | 新增失败 1 条：`localDate` 断言写死 UTC+8 的日期 | 期望值按本地日期规则算，另钉死 `runtime.time.iso` |

最终运行 `43580991376`：`node-tests` 1611 用例 / 1553 通过 / 51 失败 / 7 跳过 /
**新增失败 0**；`powershell-check` 5.1 与 7 双绿；`node-version-floor` 绿。
基线未改动。

## 8. 发布前事项的处理状态（第二轮已全部处理）

上一版这一节是 5 条待办。第二轮按 P0-1 / P0-2 / P1-1 / P1-2 逐条落地，
每条都配了回归用例，没有一条只是「改注释 / 改文档」。

1. **无 ID 消息的包含关系安全性** → **已修**。顺序不再丢：每行记录都进
   `order` 序列（无 id 用内容哈希占位），`equal` 要求序列相等，包含关系要求
   子序列。A=[m1,m2] / B=[m2,m1] 一律各自保留。见 §9.1。

2. **Legacy `deleted_at = -1`** → **已修**。老库 `-1` 行移出写入范围，且
   「存在 `-1` 行 + 未显式承认」默认**阻断写入**（返回 `blocked:true`，不是
   只打一行警告）。即使写 `allowLegacyAmbiguous: true`，`-1` 行仍不接管。见 §9.2。

3. **上游文件 SHA-256 代际验证** → **已修**。`upstream.json` 升 schema 3，
   存上游原版与本地补丁双方的 `{sha256,size}`；`deploy.ps1` 三种判定全部按
   哈希，`pristine-upstream` 与 `unknown-generation` 默认中止（`exit 2`），
   只有 `-Force` 越过。见 §9.3。

4. **历史失败增加错误指纹** → **已修**。`known-failures.json` 升 schema 4，
   匹配改为「文件 + 用例名 + 规范化错误签名」；同名但错误内容变化按新增失败
   处理，并打印基线签名与本次签名。见 §9.4。

5. **PowerShell 5.1 实际 DryRun 与回滚测试** → **已覆盖**。
   `deploy-safety.test.js` 全部用例都用 `powershell.exe`（5.1）实际执行
   `deploy.ps1`，包含 `-DryRun`、临时目录真实部署、故障注入回滚三条路径。
   见 §9.5。

---

## 9. 第二轮修复（P0-1 / P0-2 / P1-1 / P1-2，2026-11-14）

### 9.1 P0-1 精确副本必须比「完整规范化记录序列」

问题：`compareFingerprints` 只比消息多重集，顺序不同也判 equal；无 ID 记录
只进多重集，顺序信息彻底丢失。

改法：

- `inspectSessionFile` 每行 push 一个 `order` 元素（有 `id` 用 id，无 id 用
  内容哈希占位），得到完整序列；`messages`（id→哈希）与 `unkeyed`（多重集）保留。
- 新增 `orderEqual(a,b)`；`equal` 判定改为
  `messagesEqual && multisetEqual && orderEqual`。
- 新增 `isSubsequence(a,b)`；允许包含时除集合包含外，还要求
  `b.order` 是 `a.order` 的子序列。
- `judgeGroup` 第 1 步并查集只 union `relation === 'equal'` 的组；第 2 步对
  不满足子序列的候选记入 `containmentSkipped`，不合并。

效果：顺序不同的一律各自保留，宁可少删。

测试：`test/rehome-dedupe.test.js` 新增 `writeSessionOrdered` 与三类乱序用例
（同 ID 乱序 / 无 ID 乱序 / 混合乱序），断言 `ok === true` 但 `groups === 0`、
`dropped === 0`。

### 9.2 P0-2 legacy `deleted_at = -1` 移出写入范围 + 默认阻断

问题：老库（无 `transport` 列）沿用旧口径，`-1` 行只被统计不阻断，仍在
可能的写入范围内。

改法：

- `session-scope.js`：local-only 改为
  `deleted_at IS NULL AND (transport IS NULL OR transport = 'local')`；
  新增 `assessDeletedSemantics(db)`，按 transport 分组统计 `deleted_at`，
  出现 local=-1 / cloud=NULL / 未知 transport 即 `verified=false` 并列出 `issues`。
- `rehome-sessions.js`：真实写入前判断「老库 + 存在 `-1` 行 + 未显式承认」→
  返回 `{ ok:false, skipped:'legacy-deleted-at-ambiguous', blocked:true,
  affected:0, hint }`；dry-run 不写库，但如实标 `blocked:true` 与 `ambiguity.rows`。
- `rehome-watcher.js`：`ok === false` 或 `blocked` 时不推进 `lastConfirmedUid`，
  状态进 `failed`。

即使配置 `allowLegacyAmbiguous: true`，`-1` 行仍然不进写入范围（只写
`deleted_at IS NULL`）。

测试：`test/session-scope.test.js` 用真实临时 SQLite 造老库，断言
`blocked.ok === false`、`affected === 0`、`scope === 'legacy-no-transport(strict)'`；
`test/rehome-sessions.test.js` 覆盖「默认阻断 → 一行没动 → 显式承认后只写 4 行 →
第二次幂等 0 行」。

### 9.3 P1-1 部署代际闸门改 SHA-256

问题：旧实现比字节数，同大小不同内容会被判 `already-patched` 直接覆盖。

改法：

- `scripts/upstream.json` 升 schema 3，新增 `deploy.upstreamFileHashes` 与
  `deploy.localFileHashes`，每项 `{sha256,size}`；上游按 `9b9bad5`（1.2.22）实取，
  本地按当前补丁文件实算。
- `deploy.ps1` 3b：目标哈希 == 补丁哈希 → `already-patched`；
  == 上游哈希 → `pristine-upstream`；其余（含缺上游哈希）→ `unknown-generation`。
  `pristine-upstream` 与 `unknown-generation` 默认 `exit 2`，只有 `-Force` 越过。
- 顺带解耦：`-StrictVersionGate` 原来会被 `-Force` 一起越过。而「目标版本被
  改过」必然意味着 daemon.js 哈希不等于补丁哈希，也就必然要 `-Force` 才能过
  代际闸门 —— 于是版本闸门永远不可能触发，等于被代际闸门顺手拆掉。现在版本
  闸门只认新开关 `-ForceVersion`，两个闸门各用各的开关。

测试：`test/deploy-safety.test.js` 13 组，全程 `powershell.exe` 实跑，含：

- 同大小不同内容（把 `daemon.js` 里一个 `A` 改成 `B`，字节数不变）→
  `exit 2` + `代际不明`；
- pristine 上游 → `exit 2` + `原版上游`；
- `-Force` 越过代际、`-ForceVersion` 越过版本闸门；
- 真实部署（`workbuddy-exe.json` 保留、新文件落盘、报告生成）；
- 故障注入回滚 → `exit 4`，`daemon.js` 恢复原内容、新建文件被清理。

### 9.4 P1-2 历史失败指纹（schema 4）

问题：`known-failures.json` 只按 `{file,name}` 匹配，同名换原因会被当成
历史失败放过去。

改法：

- 新增 `test/tap-fingerprint.js`：从 TAP 提取每个失败用例的 `error`
  （块标量 / 单行标量 / `stack` 兜底），规范化后作为签名。
- 规范化范围：绝对路径 → `<PATH>`、UUID → `<UUID>`、ISO 时间 → `<TIME>`、
  日期 → `<DATE>`、长十六进制 → `<HEX>`、端口 → `<PORT>`、6 位以上数字 →
  `<NUM>`、mkdtemp 风格目录名 → `<TMPNAME>`。**不**规范化错误类型、错误码、
  actual/expected 的值 —— 那正是错误原因本身。
- 匹配从「文件 + 名字」升为「文件 + 名字 + 签名」三重；同名不同签名 →
  `reason: 'signature-changed'`，按新增失败处理，并打印基线签名与本次签名。
- schema < 4 的旧条目仍可匹配（只按名字），但会打印条数告警，不静默放宽。
- 顺带修了个真 bug：`parseTap` 里最后一个 `not ok` 会吞掉尾部
  `# tests` / `# fail` 统计块，导致 `mismatch` 检查形同虚设。

测试：`test/run-ci-signature.test.js` 13 组，含两条负例（同文件同名字不同签名
→ `kind === null`；文件不同 → `name-unknown`），以及「两台机器不同路径 / UUID /
时间 / 端口 / pid 得到同一签名」。

结果：基线从 schema 3（57 条无签名）升到 schema 4（57 条带签名）。升级前后
各跑一次全量，新增失败都是 0；条目数没有减少（57 → 57）。

### 9.5 PowerShell 5.1 实测范围（回应上一版 §8-5）

`test/deploy-safety.test.js` 里所有部署用例都是
`spawnSync('powershell.exe', ...)`，即 Windows PowerShell 5.1 实际执行
`deploy.ps1`，不是静态解析：

- `-DryRun` 走到「代际检查」并输出报告；
- 真实部署（临时 `-TargetDir`）验证 `workbuddy-exe.json` 不被覆盖、新文件落盘、
  部署报告生成；
- 故障注入（`WORKDADDY_DEPLOY_TESTING=1` + `WORKDADDY_DEPLOY_FAIL_AFTER=3`）
  验证回滚顺序：`exit 4`、`daemon.js` 恢复原内容、新建文件被清理。

唯一没覆盖的是「真实安装目录」——按约束不碰。

### 9.6 附带修正

- `test/rehome-sessions.test.js` 原来断言 `deleted_at=-1` 的 s7 会被接管（5 行）。
  按 P0-2 新语义改为 4 行 + 默认阻断，并补「显式承认后 s7 仍不动」。
- `deploy.ps1` 的 pristine 提示文案补上「原版上游文件」字样，与文档里的
  `pristine-upstream` 对齐，否则日志看不出拦的是哪一类。
- GitHub Actions 的 `actions/checkout` / `setup-node` 由 `v4` 升到 `v5`，
  消掉 Node 20 runtime 弃用警告；`upload-artifact` 暂留 `v4`（只在失败时用，
  升级风险大于收益）。
- 本文件顶部的提交数、§0 与 §4 的用例数、§5 的 R2/R6/R8 都改成当前事实。

### 9.7 第二轮验证

```
逐文件全量：185 个文件
用例 1612 / 通过 1552 / 失败 53 / 跳过 7
基线 schema 4   已知失败 53   新增失败 0   基线中已不再失败 4
退出码 0
```

基线没有为了「通过」而删掉任何条目：升级前后都是 57 条，那 4 条「不再失败」
留在基线里（它们只是本机 CRLF 检出造成的假失败），删除属于收紧，不是本轮该做的事。
新增的 2 条用例（`run-ci-signature.test.js`）让总数从 1611 变 1612，属于新增文件，
不是旧用例消失。

### 9.8 第二轮 CI 的一处真实失败（已修）

第一次推送后 `node-tests` 挂在 `deploy-safety.test.js` 的第 12 条断言：

```
- deploy-safety.test.js :: test\deploy-safety.test.js
      签名: test failed
```

原因不是闸门逻辑，而是**工作副本行尾**：`inject.js` / `lib.js` / `win-launcher.js`
在本机是 CRLF，而 `.gitattributes` 规定 `eol=lf`，CI 检出的是 LF。于是
`upstream.json.deploy.localFileHashes` 记的是 CRLF 字节的哈希，CI 用 LF 字节比对
必然不等。

修法：把这三个文件按仓库规范重新落盘为 LF（`rm` + `git checkout`，因为内容
「无差异」时 checkout 不会重写），再用 LF 字节重算 `localFileHashes`；
`generationFinding` 的字节差也按 LF 重算（daemon.js / inject.js / lib.js 分别比
上游少 11819 / 26721 / 1020 字节，win-launcher.js 多 314 字节）。
用 `git cat-file -p HEAD:scripts/<f>` 的字节复核，四个哈希与仓库 blob 完全一致。
顺带在断言信息里写明「工作副本若是 CRLF 会误报，先按 LF 重新检出再算」。

这条测试本身就是「元数据必须与真实字节一致」的守卫 —— 它抓到的第一个问题
是它自己的输入，属于正常工作。

### 9.9 第二轮 CI 结果（run 43588287807，2026-11-14）

| Job | 结果 | 耗时 |
| --- | --- | --- |
| Node 22.14.0 on Windows | 通过（1612 用例 / 1554 通过 / 51 失败 / 7 跳过 / 新增失败 0） | 3m8s |
| PowerShell 5.1 语法 / 编码 | 通过 | 12s |
| PowerShell 7 语法 / 编码 | 通过 | 11s |
| node:sqlite 最低版本检查 | 通过 | 24s |

`actions/checkout@v5` 与 `actions/setup-node@v5` 生效，Node 20 runtime 弃用警告
只剩 `upload-artifact@v4` 一条（仅失败时触发，暂不升级）。




