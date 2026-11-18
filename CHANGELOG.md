# 变更记录

本仓库是 [babygoton/WorkDaddy](https://github.com/babygoton/WorkDaddy) 的个人 fork。
这里记录**本 fork 相对上游**的改动；上游自己的版本演进见上游仓库与 [`README_UPSTREAM.md`](README_UPSTREAM.md)。

格式参考 Keep a Changelog；版本号沿用 `scripts/daemon.js` 里的 `DAEMON_VERSION`。

## [1.3.14] — 未发布（分支 `review/automation-migrate-1.3.14`）

第六轮验收对 1.3.13 判 NO-GO，只卡一条：1.3.12 及更早写下的 `pending` 没有 `seq`，
升级后全部读成 0，排序键完全相同，重试「删旧记录再追加」仍会换位，FIFO 被旧数据绕过。

### 修复

- **旧队列 seq 一次性迁移（P2-03 升级兼容）**：`writePendingIntent()` 在写队列前先
  迁移：整队都是旧格式时按数组现有顺序补 `1..n`；新旧混排时缺号的排在已有号之后。
  迁移随本次写入持久化，之后一直沿用。升级前排队的两条同 `at` 意图，升级后仍按原顺序恢复。

### 测试

`test/official-automation-sync-guard.test.js` 增至 30 条，新增覆盖：旧格式（无 `seq`、
`at` 相同）队列首次重试不换位且序号唯一不重复、再恢复一轮按原顺序清空；
目标分组预取后被软删除 / 被改属时分别整笔回滚（两条分支各一条断言，不再只靠改名那条覆盖）。

## [1.3.13] — 未发布（分支 `review/automation-bind-1.3.13`）

第五轮复审对 1.3.12 判 NO-GO（P0 零项、P1 一项 + 若干 P2）。WD-01/02/03/05/06 确认
闭环，剩一条真缺口：分组身份判定说「不是同一个分组」，实际绑定时却仍会把任务挂到
路径不同的同名分组下。

### 修复

- **分组绑定与身份判定对齐（P1 WD-04）**：`resolveSpaceFor()` 在目标账号只有**一个**
  同名候选时原先无条件返回。现在双方都写了目录且完全不重合就不绑定，返回空分组。
  这样「同名不同路径 = 两个不同分组」的判定在吸附、冲突、绑定三处口径一致，
  不会出现「判定成两个任务、却都挂到同一个分组」的矛盾状态。
- **能力检查覆盖 deferred 分支（P2-01）**：`sync()` 入口也检查 `writeTransaction`。
  此前 `drainPending` 失败后走 deferred 分支直接写 pending，绕过了 reconcile 内的检查，
  给不支持事务的后端留下处理不掉的欠账。现在入口即拒绝，队列保持原样。
- **退避只在有进展时重置（P2-02）**：`pending > 0` 时只有 `drained > 0` 才把退避
  重置回 5s。此前无条件重置，一直失败也会停在 5s 反复打库，指数退避形同虚设。
- **相同 at 的稳定 FIFO（P2-03）**：pending 记录增加 `seq` 次级键。两条意图落在同一
  毫秒时，重试不再因「删旧记录再追加」而换位。
- **分组改名校验（P2-05）**：事务内复核除了存活与归属，还比对分组名是否与预取时一致；
  被改名同样整笔回滚。

### 测试

`test/official-automation-sync-guard.test.js` 增至 28 条，新增覆盖：同名不同路径时
`space_id` 必须为空（不能挂到无关分组）、无事务能力 + 已有旧欠账不得新增 pending、
at 相同靠 seq 保序且两轮恢复能全部清空、分组在同步期间被改名整笔回滚。

## [1.3.12] — 未发布（分支 `review/automation-identity-1.3.12`）

第四轮复审除三条恢复队列缺陷外，另指出分组身份约定不完整（WD-04，条件性 P1）
与三条 P2。1.3.11 已修前者三条，本版补后者四条。

### 修复

- **分组身份约定（WD-04）**：跨账号分组身份 = 规范化名称；同账号内重名时用目录
  消歧（与 `resolveSpaceFor` 同口径）。新增 `spaceSignature()` 与
  `spaceIdentityConflicts()`：名称不同必然不同组；**名称相同但双方都写了目录且
  完全不重合**，视为两个恰好同名的不同分组，按不同任务处理。
  迁移冲突判定与「自动吸附」两处都用这个判据：旧 mapping 已关联的报 `conflicts`
  原样保留，没有关联的也不吸附。名称相同、目录一致（或一方没写目录）仍然正常合并。
- **定时器状态（WD-05）**：`scheduleAutomationResume()` 改为「已有更早的定时器就
  保留，已有更晚的按当前退避重排」；轮到本账号时先 `cancelAutomationResume()`
  立即重试。此前切回目标账号后仍要等上一轮按「账号不匹配」排下的 60s/300s 定时器，
  指数退避形同虚设。
- **分组引用复核（WD-06）**：分组索引仍在事务外预取（避免拉长写事务），但提交前
  在事务内用一次 `SELECT id, user_id FROM spaces WHERE id IN (...)` 复核将要写入的
  每个分组仍存活且归属正确；发现变化整笔回滚，下一轮重新取。
- **能力检查前移（WD-07）**：`writeTransaction` 能力检查移到写 pending 之前。
  此前对确定不支持事务的后端会先留下一条永远没人能处理的欠账，恢复流程无限重试。

### 测试

`test/official-automation-sync-guard.test.js` 增至 25 条，新增覆盖：同名不同路径 +
旧 mapping 关联必须报冲突且保留两行、同名不同路径无关联时也不吸附、
同名且目录一致仍可合并、不支持事务的后端不留下 pending。

## [1.3.11] — 未发布（分支 `review/automation-drain-1.3.11`）

第四轮独立复审对 1.3.10 判 NO-GO（P0 零项、P1 三项）。三条都成立，全部出在
「恢复队列」这一层，与事务架构无关；本版只修这三处。

### 修复

- **旧欠账没还完就暂缓新同步（P1-A1）**：`drainPending()` 原先失败后只 `break`，
  `sync()` 仍无条件执行本次 `reconcile`。于是「旧 `C→B/copy` 恢复失败 → 新
  `A→B/move` 照常成功 → 下次恢复再把旧 copy 跑一遍」，本轮要消除的反向执行路径
  还在。现在 `drainPending()` 返回 `{done, pending}`，只要该目标账号队列没清空，
  本次同步就不执行：新意图用 `writePendingIntent()` 排到队尾，返回
  `{deferred: true, pending}`，交给恢复流程按顺序处理。
- **重试不再打乱 FIFO（P1-A2）**：`reconcile()` 重写 pending 时用的是 `Date.now()`，
  一条失败记录会被推到队尾，下次排序就跑到更晚的意图后面。抽出
  `writePendingIntent(source, target, mode, {keepAt})`：恢复路径传 `keepAt: true`
  沿用原始 `at`，只有用户新发起的调用才取当前时间。
- **部分恢复必须继续重试（P1-C）**：daemon 原先用 `if (result.resumed)` 判断完成，
  而 `resume()` 在「前 2 条成功、第 3 条失败」时返回 `resumed: true, pending: 1`，
  剩下那条就再也没人管。现在以 `pending === 0` 为唯一完成判据，只要还有剩余就重排
  退避重试；异常路径也会带上剩余条数，不再出现「抛错就丢掉重试」。

### 测试

`test/official-automation-sync-guard.test.js` 增至 21 条，新增覆盖：旧欠账未清时
新同步必须 `deferred` 且新意图排在队尾、重试保留原始 `at`、部分成功时
`resume()` 必须如实返回 `pending`。

## [1.3.10] — 未发布（分支 `review/automation-order-1.3.10`）

第三轮独立复审对 1.3.9 判 NO-GO（P0 零项、P1 三项）。事务与 retired 的核心边界已被
确认通过，不需要重新设计；本版只按复审给出的最小顺序补三个缺口与四条 P2。

### 修复

- **恢复顺序（P1-A）**：`sync()` 在串行链内部先按 `pending` 里记录的**原始 mode**
  把该目标账号的旧欠账按 FIFO 全部还完，再执行本次调用。此前 watcher 是
  「先新同步、后恢复」，新 `move` 成功之后旧 `copy` 还会反向执行，重新造出副本。
  同一 `source/target` 的旧记录不单独重放：新调用即该任务的最新意图，
  成功后在阶段 C 一并清掉。
- **v1 快照兼容缺口（P1-B）**：`legacyFingerprint()` 只证明定义字段没变，不证明分组
  身份一致。新增 `componentHasCrossOwnerGroupDrift()`：历史 mapping 已把「定义相同、
  分组不同」的跨账号任务连在一起时报 `conflicts` 并原样保留，不合并、不转移、不软删。
  这是 v1 算法本身缺分组字段导致的确定性漏判，不是哈希碰撞。
- **恢复可达性（P1-C）**：恢复不再受「同步开关」限制——pending 是切号成功后的欠账，
  关开关只是不想再自动同步，不等于可以不还。新增 `pumpAutomationResume()`：
  启动、切号、直接登录三条路径都会触发；失败按 5s→300s 指数退避重排，
  账号不匹配时降到 60s 低频轮询，切回该账号即续做。`resume()` 一次把该目标账号的
  欠账全部做完（FIFO），不再只处理一条。

### 修复（P2）

- **copy 分组纠正（P2-1）**：指纹用的是分组名而非分组 id，目标账号的副本若引用了
  源账号的同名分组，两边哈希相等会让 UPDATE 被跳过，跨账号悬空引用就留下来了。
  新增 `spaceChanged` 作为更新条件之一。
- **降级路径收敛（P2-2）**：`copy` 与 `move` 一样要求回调式事务，没有就拒绝。
  一条路径有守卫、另一条没有，比两条都拒绝更危险。
- **缩短持锁（P2-3）**：`getAccountUids()` 与分组表读取移出事务，分组改为一次性
  预取成 `byId`/`byOwner` 索引，`resolveSpaceFor()` 变成纯内存查询；
  `BEGIN IMMEDIATE` 期间不再有非数据库工作。有 `space_id` 列却读不到分组表时
  直接失败，避免把 `space_id` 写成空值。
- **队列语义（P2-4）**：`pending` 改为完整 FIFO 队列，上限 32 条，满载时拒绝新增并
  明确报错；不再用 `slice(-4)` 静默丢弃最旧记录。`pendingSync()` 无参数返回队首。

### 测试

`test/official-automation-sync-guard.test.js` 增至 18 条，新增覆盖：旧 mapping 跨账号
分组漂移必须报冲突、同 pair 旧 copy 不重放、不同 source 欠账先于本次同步、
`resume` 一次清空多条 FIFO、队列满载拒绝新增、copy 纠正错误分组引用、
无事务后端连 copy 也拒绝。

## [1.3.9] — 未发布（分支 `review/automation-tx-1.3.9`）

第二轮独立复审对 1.3.8 判 NO-GO（P1 三项未闭环）。1.3.8 未发布、未部署。
本版按复审给出的最小顺序重做三个安全边界，仍不推翻 move/copy 双模式架构。

### 修复

- **历史快照迁移（P1-1）**：新增 `legacyFingerprint()`，完整复现 1.3.7 的纯定义算法。
  判定「是否被真实修改」时，旧快照命中 v1 或 v2 任一即视为未修改；新快照统一写 v2。
  升级不再被当成一次全量编辑，`canonical` 不会退化成「谁 `updated_at` 最新谁赢」，
  真实编辑仍压过调度器跑批造成的更新时间。
- **事务边界（P1-2）**：`reconcile` 拆成规划与提交两段。规划、canonical 选择、
  分组解析、SQL 写入全部在同一个 `BEGIN IMMEDIATE`（`db.writeTransaction`）内完成，
  读取一律走 `tx.all`，不再用事务外的 `db.all`。
  `retired` 与 `snapshots` 改为**提交成功后**才写回 mapping：事务回滚时这两项完全没动过，
  下一轮重新读取、重新判定，不会拿上一轮的 retired 标记去删用户刚改过的行。
  copy 模式仍保留「先落 lineage 再插行」，避免崩溃后出现没有身份的新副本。
- **恢复记录前置（P1-3）**：`pending` 在任何数据库读取之前落盘，记录 `sourceUid/targetUid/mode`，
  最多保留 4 条；读取阶段失败（库被锁）同样留下记录。恢复时按记录里的原始 `mode` 执行，
  不受失败后用户改设置影响。启动检查与 `startRehomeWatcher` 的 `onSwitch` 都会按当前账号
  匹配 pending 并当场续做。
- **后端能力 fail-closed（P2-3）**：没有回调式事务的后端拒绝 move 同步并报错，
  不再保留「看起来有并发保护、实际没有」的降级路径。
- **分组名口径统一（P2-2）**：目标分组匹配改用与 fingerprint 相同的 `normalizeSpaceName`，
  不再一边忽略大小写、一边精确匹配。
- **copy 模式分组（P2-1）**：INSERT/UPDATE 补 `space_id`，值取自目标账号的同名分组，
  不再出现「副本丢失分组」或「引用别的账号分组」。

### 测试

- `test/official-automation-sync-guard.test.js` 增至 11 条：新增「读取必须走事务内连接」、
  「1.3.7 历史快照升级后真实编辑仍胜出」、「读取阶段失败也留 pending」、
  「copy 模式副本带上目标账号分组」。
- 回归：copy 契约 11、move 7、account-sync 3、transfer 10、workspace-binding 13、
  session-db 6、fork-sync-contract 1，全部 exit=0、0 fail。
- `upstream.json` 重算 `daemon.js` 的 sha256/size（size 779818）。

## [1.3.8] — 未发布、已被 1.3.9 取代

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
