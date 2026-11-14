# 变更记录

本仓库是 [babygoton/WorkDaddy](https://github.com/babygoton/WorkDaddy) 的个人 fork。
这里记录**本 fork 相对上游**的改动；上游自己的版本演进见上游仓库与 [`README_UPSTREAM.md`](README_UPSTREAM.md)。

格式参考 Keep a Changelog；版本号沿用 `scripts/daemon.js` 里的 `DAEMON_VERSION`。

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
