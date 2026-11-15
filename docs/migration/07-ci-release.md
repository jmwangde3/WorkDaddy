# 阶段 7：CI 与发布

> 原则：CI 只读、只验证；**不自动打 tag、不发 Release、不碰用户真实数据**。
> 发布动作全部是人工的，能力先备好。

## 1. 九类检查的落点

| # | 检查 | 在哪 | 会不会碰真实数据 |
| --- | --- | --- | --- |
| 1 | 全量测试（逐文件 + 错误指纹） | `.github/workflows/test.yml` → `node-tests` | 否 |
| 2 | PowerShell 语法 / BOM / CRLF | `powershell-check`（5.1 与 7 两个矩阵） | 否（只解析文件） |
| 3 | `node:sqlite` 最低版本 | `node-version-floor`（Node 22.13） | 否 |
| 4 | 安装器生命周期 | `installer-tests` → `test/installer-lifecycle.test.js` | 否（仓库内 `tmp/`，`-NoShortcut`） |
| 5 | 更新回滚 | 同上（坏包 → 回滚 → 字节级还原断言）+ `test/installer-transaction.test.js` 的故障注入 | 否 |
| 6 | 上游兼容 / 同步结构契约 | `node-tests` 里的 `fork-sync-contract.test.js` | 否 |
| 7 | 产物检查 | `package` → `test/package-hygiene.test.js` 真打一次包 | 否 |
| 8 | 依赖与供应链 | `supply-chain`（零依赖断言 + engines 核对） | 否 |
| 9 | 安装包内容 | 同 7：断言 zip 里没有 test/docs/tools/.git/workbuddy-exe.json/日志 | 否 |
| 10 | 托盘可复现构建 | `tray-build`：现编 → `--selftest` / `--status` → 与仓库 EXE 比行为与字面量 | 否（只读端口/进程，自启动项写后即还原） |
| 11 | Setup 真机验证 | `setup`：choco 装 Inno → 编译 → 静默安装 → 卸载 → 数据保留 | 是，但在**一次性 CI VM** 上，不是用户机器 |

另有 `.github/workflows/upstream-watch.yml`：每周巡检上游，**只开 issue**。

## 2. 为什么这些断言值得写

- **打包产物内容**（第 9 类）：`scripts/workbuddy-exe.json` 存的是本机客户端路径，
  它在 `.gitignore` 里但确实存在于工作区。打包器如果直接按安装清单复制工作区，
  这个文件就会进发布包 —— 发出去就收不回来。`package-hygiene` 用零依赖的 ZIP 中央目录
  解析器逐条检查条目名，`workbuddy-exe.json`、`test/`、`docs/`、`*.log` 一律不允许出现。
- **零依赖**（第 8 类）：项目现在 `dependencies: {}`，供应链面就是 0。
  断言一旦被加依赖就会失败，强制在 PR 里讨论，而不是悄悄多一棵依赖树。
- **同步结构契约**（第 6 类）：见 `test/fork-sync-contract.test.js` 注释 ——
  它盯的是「下次合并上游时哪些结构性承诺不能被合没」，例如 `typeof handleForkRoutes`
  守卫被合掉后，那批把 `handleApi` 切片塞进 `vm` 跑的上游测试会以 `ReferenceError` 失败。
- **私密文件扫描**：`git ls-files` 里出现 `.api-token`、`workbuddy-exe.json`、`*.pem`、`*.pfx`、`credentials.json` 直接失败。

## 3. 打包能力（Release 暂不执行）

`installer/build-package.ps1` 产出：

| 产物 | 说明 | 实测 |
| --- | --- | --- |
| `WorkDaddy-1.3.0-portable-win-x64.zip` | 185 个文件 / 4.65 MB；含 `installer/`，解压后可直接装到本机 | ✅ |
| `WorkDaddy-1.3.0-source.zip` | `git archive HEAD`，7.01 MB；带 `WorkDaddy-1.3.0-source/` 前缀 | ✅ |
| `SHA256SUMS.txt` | 便携包 + 源码包的哈希；`-Setup` 成功时**追加** `setup.exe` 那一行。LF 行尾（`sha256sum -c` 跨平台可用） | ✅ |
| `WorkDaddy-1.3.0-setup.exe` | `-Setup` + 找到 `ISCC.exe` 时才产出 | CI 编译 + 真机安装；**开发机未验证** |

> 1.3.1 修了一处：`release\dist` 不再被打进便携包。之前 `Get-InstallFileList` 的
> `IncludeDirs` 含 `release` 而排除列表没有 `dist`，于是「把上一次的产物打进这一次的包」——
> 包里还会带一份过期的 `SHA256SUMS.txt`，哈希对不上自己。`package-hygiene` 报的是
> 「便携包里这些文本文件不是 LF：release/dist/SHA256SUMS.txt」。

Setup 的设计是**引导器而不是第二套安装逻辑**：解便携包到临时目录 → 调
`install-workdaddy.ps1` → 卸载时调 `uninstall-workdaddy.ps1`（脚本随包落在 `{app}\_setup`）。
这样安装逻辑只有一份，Setup 不会和脚本各自漂移。

Setup 的验证分两层，别混：

- **编译**：CI `setup` 作业 `choco install innosetup`，然后 `build-package.ps1 -Setup`。
  失败会让整个作业红。
- **真机行为**：`installer/setup/verify-setup.ps1 -IAmOnAThrowawayMachine`，
  在一次性 runner 上静默装 → 逐条比对清单哈希 → 静默卸载 → 断言程序没了、数据还在。
  不带这个开关直接 exit 2，防止有人在开发机上顺手跑。

**仍然未验证**：开发机（本机）从未执行过 Setup；没有代码签名；没有在线下载与签名校验；
卸载侧仍拿不到 `uninstall-workdaddy.ps1` 的退出码（安装侧已经改造：解包与安装走 `[Code]`，
由 `GetCustomSetupExitCode` 把失败码交回去）。
完整清单见 `08-release-decisions.md` §3.3。

## 4. 实测证据

```bash
node test/package-hygiene.test.js
# PASS package-hygiene.test.js
# 便携包 185 个文件；不该出现的条目 0 个
# 报告里的 sha256/size 与磁盘一致；SHA256SUMS.txt 与之一致
```

```bash
powershell -File .github/scripts/check-powershell.ps1 -Root .
# 18 个 .ps1 / 15 个 .cmd，语法 / BOM / CRLF 三项 0 问题
# PowerShell 5.1.26100.9711 → 通过
# PowerShell 7.7.0        → 通过
```

```bash
node test/run-ci.js
# 文件 201 / 用例 1740 / 通过 1686 / 历史失败 47 / 跳过 7 / 新增失败 0
```

## 5. 发布流程与人工清单

### 5.1 Tag 规则（1.3.1 统一）

**tag 名不带 `v` 前缀**，形如 `1.3.0` —— 与实际发布的 1.3.0、以及 1.2.x 的历史惯例一致。

| workflow | 触发 | 产出 | 是否挂 Release |
| --- | --- | --- | --- |
| `release.yml` | `push tags: [0-9]+.[0-9]+.[0-9]+` / 手动 | `build-package.ps1` 那套（setup + portable + source + SHA256SUMS） | **是，唯一入口** |
| `build-win.yml`（LEGACY） | 仅手动 `workflow_dispatch` | 旧补丁版资产（`WorkDaddy-Setup-*.exe` + `WorkDaddyLauncher.exe` 那套） | 否（1.3.1 起移除） |
| `test.yml` | push / PR | 无（只跑测试） | 否 |

`release.yml` 的两道闸：

1. **tag 名必须等于 `scripts/daemon.js` 的 `DAEMON_VERSION`**。不一致直接失败 ——
   防止「tag 是 1.3.1、程序还写着 1.3.0」这种发布。
2. **`SHA256SUMS.txt` 必须覆盖全部资产，且每条哈希当场重算**。只检查「清单存在」
   是不够的：一份只覆盖一半资产的清单看起来有校验，实际没有。

### 5.2 仍需人工做的事

1. 在一台**没有装过** WorkDaddy 的机器上跑便携包与安装器。
2. 在一台**装过旧补丁版**的机器上验证配置迁移（`legacy-import`）。
3. 打 tag 前先 `workflow_dispatch` 空跑一次 `release.yml`：它至今**没有被真正触发过**，
   语法与逻辑经本地核对，但「首次真跑」仍是未验证状态。
4. 发布说明里必须写明：个人改版、AGPL-3.0、与 WorkBuddy 官方无关、数据位置与卸载方式。
