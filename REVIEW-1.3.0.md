# WorkDaddy 1.3.0 发布前复核报告

- 仓库：`H:\AI工作区\wb账号同步\WorkDaddy`
- 复核分支：`fix/workdaddy-data-permission-hardening`（从 `main` @ `041e3dc` 拉出，`main` 未动）
- 本轮提交：1 个（本地，未推送）
- 复核日期：2026-11-14
- 环境：Windows 11 26100 / Node v22.14.0 / PS 5.1.26100.9711 / PS 7.7.0

## 0. 结论摘要

六个复核项全部有了明确结论：**9 处判定逻辑被收紧，3 处宁可少删的跳过条件新增，1 处语义冲突消解，1 组上游元数据换成实测值**。

- 发现并修复的实质问题：**9 个**（其中 4 个会导致误删或误判、2 个会让新增失败被误判为历史失败、1 个是本机文件被降级的风险、1 个是停止不彻底、1 个是语义自相矛盾）
- 复核后新增测试：去重 +4 类、范围 +2 组、权限 +2 组、部署 +3 组
- 全量结果：**1611 用例 / 1547 通过 / 57 历史失败 / 7 跳过 / 新增失败 0**（退出码 0）
- 未触碰：真实 WorkBuddy 数据库、真实安装目录、`main` 分支历史

**具备推送独立分支并触发 GitHub CI 的条件**（详见 §6）。

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
逐文件全量：184 个文件
用例 1611 / 通过 1547 / 失败 57 / 跳过 7
已知失败(基线) 57   新增失败 0   基线已修复 0
基线用例 1611   本次 1611   差 +0
退出码 0
```

| 套件 | 结果 |
|---|---|
| `rehome-dedupe.test.js` | PASS — 21 类场景 |
| `session-scope.test.js` | PASS — 6 组 |
| `permission-guard.test.js` | PASS |
| `rehome-watcher-retry.test.js` | PASS — 8 场景 |
| `deploy-safety.test.js` | PASS — 8 组 |
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
| R2 | 上游 HEAD 会继续前进 | 上游再发版 | 字节数变化 → 代际闸门判 `unknown-generation` 只警告 | 重跑 API 更新 `upstreamFileSizes` |
| R3 | 旧守卫监听器结构未知 | 1.2.80 装过且页面没重载 | 极少数监听器可能残留 | `needsReload` + `--reload` |
| R4 | cloud 会话端到端未验证 | 开启 `cloudVerified` | 可能改错云会话归属 | 默认关；代码不自动置真 |
| R5 | 相对路径附件引用 | 客户端未来改成相对路径 | 去重能力下降（退化为只认字节） | 安全方向，不误删 |
| R6 | 57 条历史失败仍在 | — | 真回归可能被淹没在噪声里 | 双匹配 + 四道闸；新增失败一定报 |
| R7 | `zz` 探测验证依赖人工 | — | — | 已实测一次并删除探针 |
| R8 | CI 尚未在 GitHub 真跑 | 首次推送 | workflow 语法/权限可能有小问题 | 只读 `contents: read`，三个 job 独立 |

---

## 6. 是否具备推送条件

**具备。** 判断依据：

1. 全量测试退出码 0，新增失败 0，基线 schema 3 已固化；
2. 分支 `fix/workdaddy-data-permission-hardening` 独立，`main` 仍停在 `041e3dc`，历史未被改写；
3. 已提交（1 个 commit），工作区干净；
4. `deploy.ps1` 在 PS 5.1 与 7.7.0 双版本解析通过，`-DryRun` 实跑通过；
5. CI workflow 只申请 `contents: read`，不含任何发布/写 Release 步骤。

**推送前唯一需要你点头的**：是否允许 `git push -u origin fix/workdaddy-data-permission-hardening`。推送后 CI 会自动跑 `node-tests`（Windows + Node 22.14）、`powershell-check`（5.1/7 矩阵）、`node-version-floor`（22.13）。

不推送、不合并、不发 Release —— 等你的指令。

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

## 8. 后续发布前事项（未在本轮处理）

1. **无 ID 消息的包含关系安全性**
   当前包含层对无 `id` 记录用「内容哈希多重集 ⊆」判定。同一条无 id 记录
   重复出现多次时，多重集计数能区分，但**顺序信息丢失**：A 有 [m1,m2]、
   B 有 [m2,m1]，集合层面互为子集，若同 id 部分也一致就会被判 equal。
   发布前应改为「按行序列做子序列校验」或直接对无 id 记录要求逐字节相同。

2. **Legacy `deleted_at = -1` 的处理**
   `legacy-no-transport`（表里没有 `transport` 列）目前沿用旧行为，只把
   `-1` 行数作为 `legacy-minus-one-rows` 报出来，不纳入接管范围也不判失败。
   发布前需在真实旧库副本上确认：旧版到底用 `NULL` 还是 `-1` 表示未删除，
   再决定是否把 legacy 分支也收紧为单一编码。

3. **上游文件 SHA-256 代际验证**
   现在的文件代际闸门比的是**字节数**（目标 == 上游实测大小 → 判为原版）。
   字节数会撞：不同版本恰好同大小就无法区分。应改为比对上游文件的
   SHA-256，把 `upstream.json.deploy.upstreamFileSizes` 扩成
   `upstreamFileHashes`，同时保留大小作为快速预筛。

4. **历史失败增加错误指纹**
   `known-failures.json` 目前按 `{file, name}` 匹配。若某条历史失败换了
   失败原因（比如断言语义变了但用例名没变），会被继续当成同一条已知失败。
   应把 TAP 的 `error` / `code` 归一化后存成指纹，匹配时要求用例名 + 指纹
   同时命中，否则算新增失败。

5. **PowerShell 5.1 实际 DryRun 与回滚测试**
   目前 `deploy-safety.test.js` 用 `spawnSync('powershell.exe')` 跑，覆盖了
   版本闸门与故障注入回滚，但**没有**在 5.1 上跑一次完整 `-DryRun` 到
   「生成部署报告」的端到端路径；也没验证 5.1 下 `Copy-Item` 失败时的
   回滚顺序。发布前补一条「PS 5.1 + 真实临时目录 + 中途失败」的用例。

