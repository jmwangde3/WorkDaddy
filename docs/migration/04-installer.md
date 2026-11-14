# 阶段 4：独立安装 / 更新 / 卸载

> 目标：WorkDaddy 不再依赖「把补丁覆盖进 WorkBuddy 安装目录」，而是自己拥有一套
> 可安装、可更新、可回滚、可卸载的目录与数据区；同时保留对旧补丁版用户的迁移路径。

## 1. 目录约定

| 用途 | 路径 | 说明 |
| --- | --- | --- |
| 程序 | `%LOCALAPPDATA%\Programs\WorkDaddy` | 只放运行所需文件；卸载时按清单逐条删除 |
| 数据 | `%APPDATA%\WorkDaddy` | 配置、账号缓存、日志、备份、安装记录；卸载默认保留 |
| 快捷方式 | 用户桌面 `WorkDaddy.lnk` | 只在不存在同名文件时创建，路径写进安装记录 |

数据目录不允许落在程序目录内（否则更新会覆盖用户配置），安装器在参数解析阶段就拒绝（exit 2）。

## 2. 三个脚本与分工

| 脚本 | 职责 | 退出码 |
| --- | --- | --- |
| `installer/install-workdaddy.ps1` | 预检 → 旧版迁移 → 备份 → 复制 → 校验 → 快捷方式 → 数据初始化 | 0/1/2/3/4/5/6 |
| `installer/update-workdaddy.ps1` | 版本闸门 → 暂存校验 → 停服务 → 备份 → 替换 → 健康检查 → 写状态 →（可选）重启 | 0/1/2/3/4/5/6 |
| `installer/uninstall-workdaddy.ps1` | 按清单删文件、按记录删快捷方式、可选清数据 | 0/1/3 |

`installer/lib/common.ps1` 是被三者共用的函数库（清单规则、哈希、JSON 读写、快捷方式、报告）。
**清单规则只有一处定义**，安装与更新用的是同一份，避免「装进去的文件」和「更新时的文件」两套口径。

## 3. 安装流程（对应方案 8.2 十步）

1. 解析路径并做越界校验（盘根 / Windows 目录 / 数据在程序目录内 → 拒绝）。
2. 从 `scripts/daemon.js` 读 `DAEMON_VERSION` 作为版本号；读不到直接失败（不猜版本）。
3. 生成安装清单；少于 20 个文件视为源目录不完整，拒绝安装。
4. 预检：Windows ≥ 10、WorkBuddy 客户端探测、Node 运行时、磁盘余量、目标目录可写性探测。
5. 旧补丁版识别与配置导入（见 §5）。
6. 已有安装且版本不同 → 先整目录备份到 `backups\app-<旧版本>-<时间戳>`，只保留最近 2 个。
7. 复制清单内文件。
8. 逐文件 SHA-256 校验，任何不一致即失败并报告具体文件。
9. 创建快捷方式（**先于写安装记录**，这样记录里能带上真实路径）。
10. 初始化数据目录（`config.json` 已存在则**不覆盖**）、写 `install-state.json`。

默认配置一律关闭副作用：`rehome.enabled=false`、`permission.preferenceGuard=false`，
`dedupeMode=exact`（精确副本），与「默认只读」的数据安全要求一致。

## 4. 更新流程（对应方案 8.4）

```
版本闸门 → 暂存到 %TEMP% 并逐文件校验 → 停服务 → 备份 → 替换 → 装后校验
        → node --check 健康检查 → 写状态 →（-Restart 才）重启 → 清理暂存
```

- **版本闸门**：逐段数值比较，降级必须显式 `-Force`；同版本无 `-Force` 视为已完成（不重写文件）。
- **暂存**：先复制到 `%TEMP%\workdaddy-update-<12hex>` 并比对哈希，确认包是完整的再动线上文件。
- **停服务**：只停「命令行里跑的是本安装目录 `scripts\daemon.js` / `watchdog.js`」的 node 进程。
  按路径精确匹配，因此不可能波及 WorkBuddy 客户端、其它 WorkDaddy 安装或无关 node。
  watchdog 会在 daemon 退出 3 秒后把它拉回来，所以两个必须都停；停不下来就中止（exit 6），
  绝不在服务运行时替换文件。
- **备份**：整目录复制到 `backups\app-<旧版本>-preupdate-<时间戳>`，这就是「最近一个可恢复版本」。
- **回滚**：替换失败、校验失败、健康检查失败都走同一段回滚逻辑；报告里 `rolledBack` 明确写出是否成功。
  回滚失败时不假装成功，直接给出备份路径并要求人工恢复。
- **健康检查**：对 `daemon.js`/`inject.js`/`lib.js`/`win-launcher.js` 跑 `node --check`。
  这是静态检查 —— 故意不启动守护进程：安装器不该在用户机器上拉起会读真实账号的服务。
- **重启**：`-Restart` 才会用 `scripts\launcher.cmd`（与用户双击快捷方式同一条路径）拉起。
  重启失败只记 warning，不回滚：文件已经验证过是好的，回滚只会把可用的新版本换回旧版本。
- **暂存清理**：成功与失败两条路径都删暂存目录，报告里 `stageRemoved` 记录结果。

### PowerShell 5.1 的两个坑（都在代码里注释了）

1. `$ErrorActionPreference='Stop'` 下原生命令往 stderr 写东西会抛 `NativeCommandError`。
   `node --check` 的错误正是写 stderr —— 不临时降级，健康检查失败会变成脚本崩溃，**跳过回滚**。
2. 非 ASCII 脚本必须带 UTF-8 BOM，否则 5.1 按 ANSI(936) 解读中文全乱。CI 的 `check-powershell.ps1` 会查。

## 5. 旧补丁版迁移（对应方案 8.3）

识别顺序：显式 `-LegacyScriptsDir` → `%LOCALAPPDATA%\Programs\WorkBuddy\resources\app\scripts`
→ `...\WorkBuddy\scripts` → `%PROGRAMFILES%\WorkBuddy\resources\app\scripts`；
命中条件是该目录里存在 `rehome-sessions.js`。

只**复制**下列内容到 `%APPDATA%\WorkDaddy\legacy-import\<时间戳>\`：

`workbuddy-exe.json`、`rehome-config.json`、`rehome-state.json`、`dedupe-config.json`、
`permission-guard.json`、`session-dedupe-journal.json`，以及 `logs\`、`backups\` 两个目录。

原目录一律不动 —— 迁移失败也不能让用户丢掉旧补丁的现场。无法识别的配置文件不会导入、也不会被覆盖。

## 6. 卸载与数据保留（对应方案 8.5）

- 只删 `install-state.json` 里登记过的文件，逐条比对哈希。
- 哈希不一致（用户改过 / 被别的版本覆盖）默认**跳过**并 exit 3，`-Force` 才删。
- 清单里的路径做了三重越界防护：非空、不含 `..`、不是绝对路径、且 `GetFullPath` 后仍在 AppDir 内。
  安装记录是本机 JSON，可能被改过；不能拿它当可信输入去删文件。
- 快捷方式只删**记录里那一条**，不按名字猜。桌面上同名的 `WorkDaddy.lnk` 可能是用户自己建的。
- 默认保留数据目录；清理必须 `-PurgeData -YesPurgeData` 双开关，报告里列出清理范围。

## 7. 测试证据

`test/installer-lifecycle.test.js`，27 条用例，全部在临时目录里真跑 PowerShell 5.1：

```
node --test test/installer-lifecycle.test.js
# ok - ... 27 条 ... 
# PASS installer-lifecycle.test.js
```

覆盖范围：

- 安装 11 条：全新安装、同版本重装、旧版本升级（含备份内容比对）、目录逐级创建、
  源目录无效、目标不可写、数据目录在程序目录内、已有配置不被覆盖、旧补丁版迁移、
  客户端探测与文件系统一致、`-DryRun` 零写入。
- 更新 11 条：同版本幂等、降级拒绝 / `-Force` 放行、正常升级（状态 + 备份 + 四项健康检查 + 暂存清理）、
  坏包回滚（exit 5 且文件字节级还原）、无安装记录、`-DryRun` 零改动、
  停掉本目录守护进程（真起一个 node 进程再验证它被杀掉）、`-Restart` 拉起。
- 卸载 5 条：默认保留数据、单开关被拒、双开关清空、哈希变化跳过 / `-Force`、
  越界路径不越界删、只删记录中的快捷方式、无记录不猜着删、`-DryRun`。

安全前提：所有 `AppDir`/`DataDir` 都在仓库内 `tmp/`（已 gitignore），TEMP 也指到那里，
一律 `-NoShortcut`。`os.tmpdir()` 在本机会指向 `%APPDATA%\WorkDaddy\client-tmp`
（真实数据目录内部），所以测试**不能**用它 —— 这也是用例改用仓库内 `tmp/` 的原因。

跑完自查过：真实桌面快捷方式仍在、真实 `%APPDATA%\WorkDaddy` 67 个条目未动、
真实守护进程（pid 42956 daemon / 23400 watchdog）仍在运行。

## 8. 已知缺口（后续阶段）

| 缺口 | 计划 |
| --- | --- |
| 没有下载 + 来源/签名校验 | 阶段 7 发布链：下载后先校验 SHA-256 与来源，再交给本脚本 |
| 没有 Setup / Portable ZIP 打包 | 阶段 7：`scripts/build-win-release.ps1` 对接，产出 Setup + ZIP + 源码包 |
| 健康检查是静态的，没有 HTTP 探针 | 保持现状：安装器不启动会读真实账号的服务；需要真实探针时由启动器负责 |
| 与上游 `install-win.ps1` / `workdaddy.iss` 的关系未打通 | 上游安装器是「装到 WorkBuddy 目录」的补丁模式，与本安装器互不替代；文档里要说清 |
| `-StrictFileGate` 与代际闸门的一致性 | 阶段 7 与 `deploy.ps1` 一起对齐 |

## 9. 与上游安装器的关系

上游 `scripts/install-win.ps1` + `scripts/win/workdaddy.iss` 的思路是：把脚本复制进
WorkBuddy 的 `resources\app\scripts` 并改写客户端启动参数。本安装器**不这么做**，
它把 WorkDaddy 当作独立程序，通过 CDP 与被改写的启动参数之外的方式与客户端交互。

两者共存不会互相破坏：本安装器只写自己的三处路径，从不触碰 WorkBuddy 安装目录。
选择哪种由用户决定，README 与迁移文档里会写明差异。旧补丁版迁移只复制配置，不删除旧补丁，
所以升级到独立安装后仍可回退。
