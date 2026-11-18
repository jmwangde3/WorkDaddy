# 变更记录

本仓库是 [babygoton/WorkDaddy](https://github.com/babygoton/WorkDaddy) 的个人 fork。
这里记录**本 fork 相对上游**的改动；上游自己的版本演进见上游仓库与 [`README_UPSTREAM.md`](README_UPSTREAM.md)。

格式参考 Keep a Changelog；版本号沿用 `scripts/daemon.js` 里的 `DAEMON_VERSION`。

## [1.3.8] — 未发布（分支 `review/automation-guard-1.3.8`）

第二轮独立复审对 1.3.7 给出 NEEDS_FIX（P0 无、P1 三项）。本版按最小范围修完，
不改变 move/copy 双模式架构。

### 修复

- **分组纳入任务身份**：`fingerprint` 现在带规范化分组名。同名同内容但属于不同分组的
  跨账号任务不再被误判为同一任务合并（复审 P1-1）。
- **规划与写入之间的并发窗口**：新增 `db.writeTransaction`（读+写同一 `BEGIN IMMEDIATE`），
  move 的转移与软删除语句都带 `updated_at` 条件；命中 0 行说明该行在规划后被改过，
  整笔回滚并在下次切号重算，不会在旧决策上覆盖用户的新内容（复审 P1-2）。
- **切号成功但同步失败可自动恢复**：同步前把 `pending {sourceUid,targetUid}` 落盘，
  成功即清空；daemon 启动时若当前账号等于待处理目标，自动续做（复审 P1-3）。
- **直接登录路径接入同步**：`startRehomeWatcher` 的 `onSwitch` 现在也调用官方任务同步，
  客户端内直接登录不再漏掉归属转移（复审 P2-6）。
- **只对明确的 schema 缺失降级**：`space_id` 探测与 `spaces` 查询仅在 `no such column/table`
  时降级，库被锁、I/O 失败直接抛出，避免静默丢分组（复审 P2-1）。
- **同名分组消歧**：目标账号存在多个同名分组时按 `primary_folder_path`/`create_folder_path`
  唯一匹配；消不了歧就置空并保持不分组，不再按 `created_at` 随意绑定（复审 P2-2）。
- **同账号多 live 行冲突保护**：历史 mapping 把同账号不同定义的任务连在一起时报 `conflicts`
  并保持原样，不再选一条退役其余（复审 P2-4）。
- **`getMode` 每次同步只读一次**，避免两次读取之间设置变化导致语义前后不一致（复审 P2-5）。

### 测试

- 新增 `test/official-automation-sync-guard.test.js`（8 条）锁定上述契约；
- 旧复制契约 `official-automation-sync.test.js` 的故障注入同时覆盖 `writeTransaction` 路径；
- `upstream.json` 重算 `daemon.js` 的 sha256/size。

## [1.3.7] — 未发布（分支 `review/automation-move-1.3.7`）

### 变更

**定时任务从「每个账号各一份」改成「全局一份，跟着当前账号走」**

- 旧模型：切号时把任务复制给目标账号，四个账号就是四行同名任务。带来的实际问题是
  同一任务有四份独立运行状态 —— 切号后目标账号那份还停在「今天 09:00 没跑」，
  触发 24 小时补跑窗口，于是同一天跑两遍；删任务也只删掉当前账号那份。
- 新模型（`mode: move`，默认）：切号时把任务的 `owner_user_id` **转移**给目标账号，
  其余副本软删除（可恢复）。同一任务在任何时刻只有一行 live 记录，id 不变，
  运行历史不分裂。旧模型保留为 `mode: copy`，`automation-sync.json` 里写 `mode` 即可切回。
- 转移时把 `space_id` 改到目标账号的**同名分组**；目标账号没有同名分组就置空，
  不让任务引用别的账号的分组行。
- 任务被删后反向切号不复活；一次性任务按 `scheduled_at` 区分，不会被误并。
- 新增 `test/official-automation-sync-move.test.js`（7 条）锁定上述契约；
  旧的复制契约测试继续用 `mode: copy` 覆盖。

## [1.3.1] — 未发布（分支 `fix/1.3.1-reliability-security`）

可靠性 + 安全加固。不新增功能，六处都是「原本会在真实环境里出事」的地方。

### 修复

**进程枚举：一个读不到字段的进程不该让整条查询作废**

- 异常分七类：`PROCESS_DISAPPEARED` / `TRANSIENT_FIELD_MISSING` / `ACCESS_DENIED` /
  `OWNER_UNVERIFIED` / `PATH_UNVERIFIED` / `COMMANDLINE_UNVERIFIED` / `UNKNOWN_ERROR`。
  **只有确认进程已消失才静默跳过**，其余写 stderr 标记并交给调用方判定。
- 新增 `enumerateCimProcesses()` 返回 `{ processes, skipped, errors, complete }`。
  危险操作（结束进程、替换程序文件）读这个结构；`complete !== true` 一律失败关闭，
  因为「有进程但没验证成」和「没有进程在跑」是两件事。
- `verifiedWindowsWorkBuddyProcesses()` 改用结构化枚举：部分枚举直接抛错，
  不再可能因为漏掉一个进程而让新实例被单实例锁挡住（表现成「重启了但没生效」）。
- 单 PID 精确验证路径（`ConvertTo-WorkDaddyProcessRecord`）**一字未改**，安全边界不放松。
- 修 `cdp-targets.js` 的归属兜底：原来只要有 `WBSWITCH_PROFILE` 环境变量、标题像 WorkBuddy
  就认领页面。环境变量任何人都能设，等于把「设置过变量」当成归属证据 ——
  实测里留着 `WBSWITCH_PROFILE=workbuddy-cn` 就能让 AI profile 认领国内版页面，
  同一条用例在本机红、在 CI（变量为空）绿。改为要求变量值**等于**当前 profile id。

**安装器：不停托盘就会替换到一半失败，而且回滚不了**

- 新增共享函数 `Stop-WorkDaddyProcesses`：按命令行精确匹配停掉 daemon / watchdog，
  并**额外结束占用 `tray\WorkDaddyTray.exe` 的进程**（托盘会锁住自己被替换的文件）。
  停不掉就拒绝继续，绝不带着未知锁状态替换文件。
- `Test-SafeRootDir`：拒绝盘根、Windows 目录、`%APPDATA%`/`%LOCALAPPDATA%` 父目录、
  用户主目录、`..` 路径穿越、目录重解析点（junction / symlink）。
- `Test-DirOverlap`：AppDir 与 DataDir 相同或互相包含一律拒绝。
  不用 `StartsWith` 判断归属（`C:\Program\WorkDaddy-evil` 会被误认成子目录）。
- 卸载器在**归一化之前**保留原始参数检查穿越 —— `[IO.Path]::GetFullPath` 会把 `..`
  吃掉，等归一化完再查就查不出来了。
- 打包器修两处：`ExcludeNames` 加 `dist`（否则把上一次的产物打进这一次的包，
  包里还带一份过期的 `SHA256SUMS.txt`）；`SHA256SUMS.txt` 改 LF 行尾
  （`sha256sum -c` 在 Linux/macOS 上会把 `\r` 当文件名的一部分而全部失败）。

**会话去重：只比 `deleted_at` 不够**

- 执行前重读并逐字段比对**身份快照**（`id` / `user_id` / `cwd` / `title` / `transport` /
  `deleted_at`）。切换账号、改工作目录都不会碰 `deleted_at`，CAS 会照样通过，
  但那时删的已经不是计划里那一条了。
- sidecar 复验：`inspectSidecars` 产出摘要（文件逐个 SHA-256，目录记 文件数 + 总量 + 哈希集）。
  计划时没有、执行前冒出来 → 中止。这是真实时间窗（会话刚被打开、附件刚生成）。
- journal 状态机七态：`PREPARED` → `APPLYING` → `DB_COMMITTED` → `COMPLETED`，
  异常分支 `ROLLBACK_REQUIRED` → `ROLLED_BACK`，无法判定时 `RECOVERY_REQUIRED`。
  journal 在**写库之前**落盘 —— 否则「改了库但没留记录」这件事无从发现。
- 新增 `resumeDedupe()`：按数据库现状（每行 `deleted_at` 是否等于本次写入值）判断
  「已提交 / 未写入 / 现场不一致」。混合状态、行丢失、被别人改过一律停下要人看，
  绝不自动覆盖。默认 `dryRun`，重复调用幂等。
- 补偿回滚是否真的到位，用数据库说话，不信「没抛错就是成功」。
- `runRollback` 同时接受 v1（只有 rows）与 v2（含 state / identity）日志 —— 升级格式
  不能让已写进去的记录变成不可读。

**Sentry：脱敏要发生在最终发出去的那一刻**

- `sendEvent` 与 `queueEvent` 都对完整事件再过一遍 `sanitize`，不再只依赖调用方记得脱敏。
  outbox 落盘同样脱敏（它迟早会被 flush 发出去，而且比网络请求躺得更久）。
- `redactText` 补齐：裸写的 `Bearer`/`Basic`/`Token`/`Digest` 凭证（没有 `authorization:`
  前缀时原来不认）、`x-api-key`、`Cookie`/`Set-Cookie`、命令行凭证
  （`--password xxx`）、URL 查询参数、JWT、`sk-`/`key-` 前缀密钥。
- `daemon.js` 的 `redactDiagnosticText` 与 sentry 用同一套规则（原来缺裸 Bearer、
  `x-api-key`、URL 查询参数）。
- 新增测试：构造带全套假凭证的事件，patch `https.request` 捕获**最终请求体**，
  断言 `FAKE_BEARER_SECRET_123` 等七个 sentinel 一个都不出现。

**本地 API：`/api/client/relaunch` 不再免认证**

- 从 `PUBLIC_API_PATHS` 移除。它会重启客户端，属有副作用的操作；免认证时任何本机网页
  （`Origin: null` 也在放行名单里）都能触发。
- 状态页渲染时把 token 嵌进 HTML；`fix-cdp.cmd` 从 `%APPDATA%\WorkDaddy\.api-token` 读取。
- Origin 校验与 Token 校验分开：`Origin: null` 通过 Origin 校验，但**不再等于通过认证**。
- 只读路径（`/api/status`、`/api/about`、`/api/update-check`）继续免认证，否则本地 CLI
  与状态页自检全部退化。

**RC1 审查后的四处修正（同属 1.3.1）**

- **launcher 的枚举完整性不能丢在第二次 `filter()` 里**：`getWorkBuddyProcesses()` 返回的
  数组带 `complete`/`skipped`/`errors` 非枚举属性，`workBuddyProcesses()` 再 `filter()` 一次
  就变成了裸数组 —— 「有进程没验证成」于是退化成「没有进程」。现在两层筛选用
  `carryProcessEnumeration()` 显式接回元信息；退出 / 重启 / 启动新实例 / 结束进程走
  `workBuddyProcessesForAction()`，`complete === false` 直接中止并给出可照做的处置说明。
  「客户端是否已停止」改用 `clientProcessesStopped()`：枚举不完整或查询失败一律按
  「无法确认已停止」处理，宁可推迟清理也不动还开着的客户端。
- **去重恢复的状态必须真的写进磁盘**：`resumeDedupe()` 原来只改内存对象，进程退出后
  日志仍停在 `APPLYING`。现在支持显式 `journalPath`，以磁盘那份为准，状态经
  `writeJsonAtomic` 写回并**回读确认**才算成功；写不进去返回 `persist-failed`，不会
  出现「报告恢复完成、磁盘还是 APPLYING」。恢复前校验 journal 格式、`opId` 一致性和
  每行写入值，缺 `after` 的旧日志直接拒绝判定。`runRollback()` 不再 `catch (_) {}`
  吞掉写入错误，改成如实报告「已回滚但日志没写回去，重跑安全」。
- **卸载器的两个归属证明**：`-PurgeData` 要求 `install-state.json` 里存在有效 `dataDir`
  （缺失 / 为空 / 不是安全目录 / 与清理目标不一致都拒绝）；快捷方式不再「记录里写了就删」，
  必须是 `.lnk` 普通文件、位于桌面或开始菜单、且目标指向本次安装目录（`wscript.exe` 带
  AppDir 参数的形式也认）。`-Force` 的删除范围没有被扩大。
- **发布流程拆成「构建预演」与「发布」两段**：`release.yml` 用 `build_only` 输入只构建、
  校验、上传 Artifact，不建 tag / Release；发布路径先校验 tag 实际存在、检出的 HEAD 就是
  tag 指向的提交（手动触发原来会检出分支头，等于用错版本打包），再校验
  「tag = `DAEMON_VERSION` = `package.json`」三方一致；已存在同名 Release 默认拒绝覆盖，
  不再默认 `--clobber`。资产校验抽成 `tools/verify-release-assets.js`，`test.yml` 的
  Setup 作业每次 push 都跑一遍同一份逻辑。

### 变更

- **Tag 规则统一为不带 `v` 前缀**（`1.3.1` 这种，沿用 1.2.x 惯例）。
- `build-win.yml` 降级为 **LEGACY**：去掉 `push tags: v*` 触发与 Release 挂载，只留手动
  `workflow_dispatch`。它产出的是旧补丁版资产（`WorkDaddy-Setup-*.exe` + `WorkDaddyLauncher.exe`
  那套），与 1.3.x 的 `build-package.ps1` 产物完全不相容。之前因为只匹配 `v*` 而从未跑过，
  但按 `v*` 打 tag 会往 Release 上挂一套来源不同的资产。
- 新增 `release.yml`：唯一发布入口。tag 触发，调用 `installer/build-package.ps1`，
  发布前五道闸 —— 检出的 HEAD 必须等于 tag 提交；tag 名必须等于 `DAEMON_VERSION` 和
  `package.json` 版本；三件资产齐全且文件名带版本；`SHA256SUMS.txt` 必须覆盖全部资产
  且每条哈希当场重算；已存在同名 Release 默认拒绝覆盖。
- `scripts/upstream.json` 的 `localFileHashes` 随 `daemon.js` / `win-launcher.js` / `inject.js`
  改动重算（台账过期会让 `deploy-safety` 与 `fork-sync-contract` 红）。

## [1.3.0] — 未发布（分支 `feat/full-fork-migration`）

把「基于上游安装包的补丁仓库」升级为「完整、独立、可安装、可更新、可持续同步上游的改版」。
上游并入到 `1.2.22`（`9b9bad5`），分叉点是 `1.2.20`（`fb9f8db`）。

### 新增

- **独立安装器** `installer/install-workdaddy.ps1`：装到 `%LOCALAPPDATA%\Programs\WorkDaddy`，
  数据在 `%APPDATA%\WorkDaddy`；预检、逐文件 SHA-256 校验、旧补丁版配置导入、安装记录。
- **更新器** `installer/update-workdaddy.ps1`：版本闸门、暂存校验、停服务、整目录备份、
  替换、`node --check` 健康检查、失败自动回滚、`-Restart` 重启、暂存清理。
- **卸载器** `installer/uninstall-workdaddy.ps1`：按安装记录逐条删 + 哈希比对，
  改过的文件默认跳过；越界路径防护；快捷方式只删记录里的那一条；数据默认保留。
- **打包器** `installer/build-package.ps1` + `installer/setup/workdaddy.iss`：
  便携包、源码包、SHA256SUMS，可选 Setup（需要 Inno Setup 6）。
- **功能模块化** `src/features/`：接管与去重共 7 条 `/api/rehome/*` 路由搬出 daemon.js，
  用路由分发器 + `NOT_HANDLED` 哨兵串起来；daemon.js 只留一行分发。
- **上游同步机制**：`docs/upstream-tracking.md`（九步流程与冲突规则）、
  `.github/workflows/upstream-watch.yml`（每周巡检，只开 issue 不合并）、
  `tools/migration/inventory.js`（三树逐文件 A–G 分类）。
- **迁移文档** `docs/migration/`：基线、逐文件盘点、功能矩阵、风险清单、
  完整 Fork 导入报告、源码来源台账、安装器设计、CI 与发布说明。
- **测试**：`fork-routes`、`session-pin-sync-queue`、`installer-lifecycle`（27 条）、
  `fork-sync-contract`（10 条）、`package-hygiene`。

### 发布前收尾（`fix/release-hardening`）

- **更新事务完整性**：`install-state.json` 纳入更新事务 —— 替换前备份旧状态、新状态写临时文件、
  校验（版本 / appDir / 清单条数 / 每条 path+sha256）、同卷原子替换、再校验；任一步失败，
  程序与状态各自回滚并**分别**写入 `rollback.programRestored` / `rollback.stateRestored`。
  新增 `update-journal.json` 崩溃恢复线索：两侧版本不一致且无 `-Force` 时 exit 8 拒绝继续。
  新增退出码 `7`（状态提交失败并已回滚）、`8`（上次事务未完成）。
- **安装事务**：任何已有安装都先备份（不再只备份版本不同的情况）；全新安装失败只删本次清单内
  的文件、用户文件与数据目录不动；快捷方式先建并把路径写进安装记录，提交失败随回滚删除。
- **安装器故障注入**：`-InjectFault copy-mid | verify | state-write`；更新器
  `-InjectFault state-write | state-replace | state-restore`。新增
  `test/installer-transaction.test.js`（14 条）。
- **托盘可复现构建**：新增 `installer/build-tray.ps1`（记录 csc 版本、完整参数、源码与产物
  SHA-256，`-Verify` 跑 `--selftest` / `--status`）与 `test/tray-build.test.js`
  （现编对比仓库 EXE 的行为、正查/反查源码字面量）。CI 新增 `tray-build` 作业。
- **Setup 真机验证**：新增 `installer/setup/verify-setup.ps1`（必须带 `-IAmOnAThrowawayMachine`），
  CI 新增 `setup` 作业：`choco install innosetup` → 编译 → 静默安装 → 清单逐条哈希核对 →
  静默卸载 → 断言程序没了、数据还在。`workdaddy.iss` 补上 UTF-8 BOM（否则非 936 机器上中文乱码）。
- **打包产物**：`package-hygiene` 增加托盘 EXE 与仓库文件的 SHA-256 逐字节比对。
- **架构决策落地**：`session-pin-sync` 以 fork 实现为主干（两套测试都保留）；`deploy.ps1`
  标注 LEGACY、不再进入新安装与更新流程；托盘 EXE 暂时保留，等 CI 稳定后再评估移出。

### 变更

- `scripts/daemon.js` 在保留上游全部实现的前提下重放分叉补丁；版本常量取 fork 的 `1.3.0`。
- `scripts/session-pin-sync.js` 以上游实现为主干收编分叉的超集实现，两套测试都保留
  （上游测试原路径，分叉测试改名 `session-pin-sync-queue.test.js`）。
- `scripts/upstream.json` schema 3 → 4：修正分叉基线（`fb9f8db` / 1.2.20，而非旧记录的「无共同祖先」），
  代际哈希表改为多代际（1.2.20 与 1.2.22），新增 `supersededClaim` 记录错因。
- `deploy.ps1` 的代际闸门改为多代际 SHA-256 判定：任一已知上游代际命中即判 `pristine-upstream` 并中止。
- `README.md` 增加「这是个人改版（fork）」声明、安装 / 更新 / 卸载 / 数据位置 / 备份恢复 /
  支持范围 / 已知限制 / 许可证等章节；上游功能描述保留。
- CI 增加安装器测试、打包产物内容检查、零依赖断言、私密文件扫描四个作业；
  触发分支加上 `feat/**` 与 `sync/**`。

### 修复

- 仓库里 8 条长期失败的测试已修好，`known-failures.json` 从 57 条收紧到 49 条（只删不加）：
  `cdp-targets` 两项、`i18n` README 语言互链、`sentry` 隐私文档、`token-refresh-persistence` 四项。
- 卸载器曾按文件名删桌面快捷方式，会误删用户自己建的 `WorkDaddy.lnk`；
  改为安装时记录路径、卸载只认记录。
- 更新器健康检查在 PowerShell 5.1 下会因 `node --check` 写 stderr 触发 `NativeCommandError`
  而直接终止脚本、跳过回滚；改为调用前后切换 `$ErrorActionPreference`。
- 两条「环境相关」历史失败治根，不是放宽断言：
  `automation-packages`（工作区 CRLF 让示例包哈希对不上索引）按 `.gitattributes` 重新检出，
  新增 `test/line-endings.test.js` 用 `git ls-files --eol` 全量判定，并把行尾规范扩到打包产物；
  `workbuddy-compat`（旧补丁版 `workbuddy-exe.json` 盖掉显式 target）改为显式 target 优先。

### 已知问题

- `test/known-failures.json` 里仍有 47 条历史失败（迁移前就存在），CI 只对新增失败报警。
- `WorkDaddy-<版本>-setup.exe` 只在 CI 的一次性 Windows VM 上验证过，**开发机从未运行**；
  没有代码签名，没有在线下载与签名校验。
- 独立安装器只有 Windows 版。

## [1.2.x 及更早]

见上游仓库；本 fork 在该阶段只维护补丁脚本（`deploy.ps1` + `scripts/rehome-*` 等），没有独立版本线。
