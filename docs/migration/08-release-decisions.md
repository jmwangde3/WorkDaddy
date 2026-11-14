# 发布前稳定性收尾（fix/release-hardening）

基线：`feat/full-fork-migration` @ `3cd82d0`（架构基线，不再大改）。
本分支只做「发得出去、退得回来」这件事：事务完整性、Setup 真机验证、托盘可复现构建、
三项架构决策落地、两条环境相关失败治根。

---

## 1. 更新事务：install-state.json 进入事务

### 1.1 原来的问题

更新器把「替换程序文件」当成了事务，状态文件是事务外的一步：

```
替换 → 装后校验 → 健康检查 → 写状态（失败就 Fail-Update）
```

写状态失败时程序已经是新版本、`install-state.json` 还是旧版本。后果是可预期的：

- 卸载按旧清单删文件 → 新版本新增的文件全部漏删，留下一个删不掉的目录；
- 下次更新拿旧版本号做比较 → 版本闸门判断错误；
- 用户看到的是「更新失败」，但磁盘上跑的是新代码。

### 1.2 现在的事务边界

状态文件从「最后一步」变成「事务的最后一环」，顺序固定为：

| 步骤 | 动作 | 失败时 |
|---|---|---|
| 2 | 备份程序目录 **和** `install-state.json`（`backups/install-state-<版本>-<时间>.json`） | 中止，未改动任何文件 |
| 3.5 | 写 `update-journal.json`（from / to / backup / pid） | 中止，未改动任何文件 |
| 4 | 替换程序 + 逐文件 SHA-256 装后校验 | 回滚程序 + 状态 |
| 5 | `node --check` 四个核心文件 | 回滚程序 + 状态 |
| 6 | 写临时状态 → 校验 → 原子替换 → 再校验 | 回滚程序 + 状态 |

状态提交本身分四步，每一步都能失败并被记账：

1. `Get-InstalledFileTable` 重新算一遍清单（以磁盘为准，不是拿源目录的哈希）；
2. 写 `.install-state.tmp-<stamp>.json`；
3. `Test-StatePayload` 校验临时文件：JSON 可解析、`version` 等于目标版本、`appDir` 一致、
   清单条数 ≥ 文件数、每一条都有 `path` 与 `sha256`；
4. `[IO.File]::Replace` 同卷原子替换（目标不存在时退回 `Move-Item`，仍是同卷 rename），
   然后再校验一次落盘文件。

「JSON 能解析」不够 —— 一个空清单的合法 JSON 会让卸载什么都删不掉，所以清单条数与
每条字段都要查。

### 1.3 回滚必须分别报告两半

`Invoke-UpdateRollback` 是唯一出口，程序和状态各恢复一次、各记一次：

```json
"rollback": {
  "attempted": true,
  "programRestored": true,
  "stateRestored": false,
  "backup": "…\\backups\\app-1.3.0-preupdate-20261114-211500",
  "note": "故障注入：状态恢复失败"
}
```

`rolledBack` 只在**两半都回来**时为 true。只成一半时报告里能直接看出是哪一半没回来，
错误消息也分开写：

```
替换失败：…；程序已恢复到 1.3.0；安装记录未恢复（当前 1.3.1，备份在 …）
```

### 1.4 journal：不在未知状态上再做一次替换

`update-journal.json` 在替换前写、状态提交成功后删。下次启动先读它：

| 磁盘程序 | 状态记录 | 判定 |
|---|---|---|
| = `to` | = `to` | 上次其实成功了，清 journal 继续 |
| = `from` | = `from` | 上次没走到替换，清 journal 继续 |
| 其它 | 其它 | **exit 8 拒绝继续**，提示先让两侧一致或加 `-Force` |

这条是「不得出现半完成状态」的最后一道保险：即使进程被强杀、回滚也没跑完，
下一次更新也不会在未知状态上叠一次替换。

### 1.5 故障注入

`-InjectFault` 只给测试用，三个值对应要求里的三种故障：

| 值 | 注入点 | 期望 |
|---|---|---|
| `state-write` | 写临时状态前抛 | exit 7，程序与状态都回滚 |
| `state-replace` | 原子替换前抛 | exit 7，程序与状态都回滚 |
| `state-restore` | 状态提交成功后抛，且回滚时故意不写回状态 | exit 7，`programRestored=true` / `stateRestored=false` / `rolledBack=false`，journal 保留 |

另外还有一条**不用注入**的真实故障：把 `install-state.json` 设成只读，`File.Replace`
会真的失败。这条也走同一套回滚，用来证明不是只有注入路径才正确。

`state-restore` 之后紧接着验证三件事：下一次更新 exit 8 且不改文件；`-Force` 能继续；
继续成功后 journal 被清掉。

---

## 2. 安装流程的事务性

### 2.1 三种起点的失败语义

| 起点 | 失败时做什么 | 不做什么 |
|---|---|---|
| 全新安装 | 只删**本次清单内**的文件，再删空目录；目录是本次新建且已空才删 | 不删用户自己的文件，不删数据目录 |
| 同版本重装 | 先从备份整目录恢复，再恢复状态 | 不留下半新半旧的文件 |
| 旧版本升级 | 同上 | 不动 `%APPDATA%` 里的用户配置 |

关键改动：**任何已有安装都先备份**，不再只备份「版本不同」的情况。同版本重装一样可能
在复制中途失败，没有备份就只剩一堆半新半旧的文件 —— 那是最难收拾的状态。

### 2.2 状态提交同一套写法

安装器的状态提交与更新器完全一致：临时文件 → 校验 → 原子替换 → 再校验。失败 exit 7，
回滚时程序与状态分开记账。

### 2.3 快捷方式先建、后记账、失败就撤

顺序改成：建快捷方式（`-DesktopDir` 可注入，测试不碰真实桌面） → 路径留在内存 →
状态提交时写进 `shortcut` 字段。状态提交失败时回滚第一步就是删掉这条刚建的 `.lnk`
（`rollback.shortcutRemoved=true`）。

不再按名字猜「桌面上叫 WorkDaddy.lnk 的就是我们的」—— 上一轮就是这么误删了用户的
真实快捷方式。

### 2.4 故障注入

| 值 | 注入点 | 覆盖的用例 |
|---|---|---|
| `copy-mid` | 复制到第 6 个文件时抛 | 全新安装清理 / 不删用户文件 / 同版本重装回滚 / 升级回滚 |
| `verify` | 复制完把 `scripts\lib.js` 写坏 | 哈希校验失败（全新清理 / 已有安装回滚） |
| `state-write` | 写临时状态前抛 | 快捷方式已建但记录失败 → 快捷方式随回滚删除 |

---

## 3. Setup：已编译、已真机验证 / 仍未验证的部分

### 3.1 本机为什么不能验证

开发机没有 Inno Setup 6，且本机装着真实的 WorkBuddy 与 WorkDaddy。
在开发机上装 ISCC 再跑一遍 Setup，等于拿用户的真实环境做实验，明确不做。

### 3.2 CI 上怎么验证

`.github/workflows/test.yml` 的 `setup` 作业（`windows-latest`，一次性 VM）：

1. `choco install innosetup` → 找到 `ISCC.exe`；
2. `installer/build-package.ps1 -Setup` → 出便携包 + 源码包 + `setup.exe` + `SHA256SUMS.txt`；
3. `installer/setup/verify-setup.ps1 -IAmOnAThrowawayMachine`：
   - 前置：这台机器上不能已有 `…\Programs\WorkDaddy\scripts\daemon.js`，否则 exit 3；
   - `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` 静默安装；
   - 检查 `install-state.json`、`daemon.js`、清单里**每一条**的 SHA-256 与磁盘一致；
   - 检查 `config.json` 已生成；
   - 跑 `unins*.exe /VERYSILENT` 卸载；
   - 检查程序文件没了、`install-state.json` 还在（数据默认保留）、快捷方式没了。

`verify-setup.ps1` 不带 `-IAmOnAThrowawayMachine` 会直接 exit 2，防止有人在开发机上顺手跑。

### 3.3 仍然未验证 / 未实现（不要当成已完成）

- **本机（开发机）从未跑过 Setup**。它的正确性证据只来自 CI 的一次性 Windows VM。
- **没有代码签名**：`setup.exe` 与 `WorkDaddyTray.exe` 都未签名，Windows SmartScreen 会拦。
- **没有在线下载与签名校验**：更新器只接受「已经拿到可信包」之后的本地目录，
  不联网、不验签。发布链（下载 → 校验 SHA-256 → 验签 → 暂存）尚未实现。
- **没有增量更新**：每次全量替换，包体约 4.7 MB。
- **没有自动升级检查**：不轮询版本，用户需手动下载。
- Inno 的 `[Run]` 不传递子进程退出码，所以「安装脚本失败但 Setup 报成功」在 Setup 层面
  看不出来 —— CI 靠落盘检查兜住，真实用户侧没有这层兜底。

### 3.4 顺带修掉的编码问题

`workdaddy.iss` 之前没有 BOM。Inno Setup 6 对无 BOM 文件按系统 ANSI 代码页解析，
在非 936 的机器上中文 `StatusMsg` 会变乱码。已补 UTF-8 BOM（`installer/build-tray.ps1`
同样补了，否则中文错误信息会乱码）。

---

## 4. 托盘 EXE：可复现构建

### 4.1 现状核对

`tray/WorkDaddyTray.cs`（614 行）与 `tray/WorkDaddyTray.exe`（20 992 字节）同期存在。
用两种方式核对对应关系，都通过：

1. **行为**：现编产物与仓库 EXE 的 `--selftest` / `--status` 输出归一化后逐行相同；
2. **字面量**：解析 .NET 元数据的 `#US` 堆，
   - 正查：源码里所有独立字面量都能在**两个** EXE 里找到；
   - 反查：EXE 里所有中文串都能在当前源码字面量里找到（防「EXE 里有源码已删掉的旧 UI」）。
3. 体积差 < 15%（超过就说明源码改过但没重编）。

不做字节比对：.NET Framework 的 csc 会把 MVID 与链接时间戳写进 PE，同一份源码两次编译
也不会字节相同。能证明的是「同一份源码、同一套参数、同一套行为」。

### 4.2 构建入口

`installer/build-tray.ps1` 与 `tray/build.cmd` 用**完全相同的参数**（测试逐项比对）：

```
/nologo /target:winexe /optimize+ /codepage:65001
/r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll
/r:System.Drawing.dll /r:System.Management.dll
```

编译器是 Windows 自带的 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`
（实测 4.8.9221.0），不需要 VS / SDK / NuGet。

脚本额外产出 `WorkDaddyTray.exe.build.json`：

```json
{
  "compiler": { "path": "…\\csc.exe", "fileVersion": "4.8.9221.0", "framework": "Framework64" },
  "arguments": ["/nologo", "…", "/out:…", "…\\WorkDaddyTray.cs"],
  "source": { "path": "…", "sha256": "…", "size": 25630 },
  "output": { "path": "…", "sha256": "…", "size": 20992 },
  "verify": { "ran": true, "selftest": "…SELF-TEST OK", "status": "…", "ok": true }
}
```

`-Verify` 会真的跑 `--selftest`（含自启动项的写入-还原）与 `--status`，结果进清单。

### 4.3 CI

`tray-build` 作业：编译 → 跑 `--selftest` / `--status` → 与仓库 EXE 比对 → 上传产物与清单。

### 4.4 打包器用的是哪一份

`build-package.ps1` 通过 `Get-InstallFileList` 收 `tray/**`，即仓库里那一份。
`test/package-hygiene.test.js` 现在会解出便携包里的 `tray/WorkDaddyTray.exe`，
与仓库文件的 SHA-256 逐字节比对 —— 「包里是临时编的 / 别的机器上编的」会直接失败。

### 4.5 决策

**CI 构建稳定之前不删仓库里的 EXE。** 等 `tray-build` 作业连续若干次绿、且发版流程
改成「从 CI 产物取 EXE」之后，再评估是否移出 Git。

---

## 5. 三项架构决策

### 5.1 session-pin-sync.js：Fork 版本为主干

- `scripts/session-pin-sync.js` 保留 Fork 实现（上游功能的超集：多一个队列/去重层）。
- 上游的 10 个用例原路径保留并全绿；Fork 自写的队列用例改名为
  `test/session-pin-sync-queue.test.js`，同样保留。
- 未验证场景（拿不到账号、CDP 不通、客户端未登录）继续降级为「不写、只报告」，
  不抛错、不改用户数据。

结论：这条不再是待决项。

### 5.2 deploy.ps1：降级为 Legacy 工具

- 头部已加 LEGACY 声明：新安装 / 更新 / 卸载不再引用它。
- 保留能力：`-TargetDir`、`-DryRun`、代际闸门、备份回滚、`workbuddy-exe.json` 永不覆盖。
- 用途只剩两个：老用户迁出配置；上游大版本升级后临时救急。
- 新安装器的旧补丁版识别**不执行** `deploy.ps1`，只按文件名复制配置（只读，不动原目录）。

### 5.3 tray/WorkDaddyTray.exe：暂时保留

见 §4.5。

---

## 6. 两条环境相关失败的根因

两条都挂在历史失败基线里很久，根因都不是业务断言，而是「开发机环境渗进测试」。
处理原则：**不放宽断言、不把它们留在基线里当挡箭牌**，改的是让环境不再能影响结果。

### 6.1 automation-packages：包字节被行尾污染

`examples/automation-packages/workdaddy-automations.json` 用 SHA-256 钉死示例包的字节。
开发机工作区是在 `.gitattributes` 生效之前检出的，263 个文本文件带 CRLF，索引里却是 LF，
于是包哈希对不上索引 —— CI 是新克隆所以一直是绿的。

修法：

1. 按属性重新检出这些文件（索引未变，工作区字节回到 LF）；
2. `.gitattributes` 对 `examples/automation-packages/*.json` 显式再钉一次 `eol=lf`；
3. 新增 `test/line-endings.test.js`：用 `git ls-files --eol` 判定全部被跟踪文件
   （文本必须 `i/lf + w/lf`，`cmd/bat` 必须 CRLF，混合行尾直接失败）；
4. `package-hygiene` 扩到产物层：解压便携包 / 源码包，逐条检查文本条目无 CRLF、
   `cmd/bat` 有 CRLF（zlib 解 deflate，零依赖）。

### 6.2 workbuddy-compat：legacy 配置盖掉了显式 target

`wdCompatConfiguredExe()` 先读 `<scripts>\workbuddy-exe.json`（旧补丁版遗留的本机路径），
再读数据目录的 `workbuddy-target.json`。开发机上那份 legacy 文件指向真实安装目录，
于是测试里显式配置的 `Z:\custom-workbuddy\WorkBuddy.exe` 被盖掉。

修法：显式 target 优先，legacy 文件只在没有 target 时兜底。语义上也更对 ——
前者随安装迁移、由安装器维护；后者是没有配置入口时代的临时补丁。

### 6.3 基线

两条修好后用 `run-ci --update` 收紧基线，并逐条 diff 确认 `removed=2 / added=0`、
签名无变化。没有新增任何豁免。

---

## 7. 剩余风险

| # | 风险 | 影响 | 现状 |
|---|---|---|---|
| 1 | Setup 只在 CI 一次性 VM 验证过，开发机从未跑过 | 中 | 已记录为「本机未验证」，见 §3.3 |
| 2 | 没有代码签名 / 在线下载 / 签名校验 | 高（发布链） | 未实现，明确写在 README 与 07-ci-release |
| 3 | `verify-setup.ps1` 会往当前用户目录装东西 | 中 | 必须带 `-IAmOnAThrowawayMachine` 才执行 |
| 4 | 托盘 EXE 仍是提交进 Git 的二进制 | 低 | 可复现构建已就位，待 CI 稳定后评估移出 |
| 5 | 5 条 `/api/permission/*` 仍在 daemon.js 里 | 低 | 见 `src/features/README.md`，需要先做守卫控制器 |
| 6 | 更新器健康检查是静态的（`node --check`） | 中 | 不启动守护进程是有意的（不该读真实账号） |
| 7 | Inno `[Run]` 不传递子进程退出码 | 中 | CI 用落盘检查兜底，用户侧无兜底 |
