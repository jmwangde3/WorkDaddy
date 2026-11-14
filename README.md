<h1><img src="docs/images/workdaddy-app-icon-rounded.svg" alt="" width="40" height="40" align="absmiddle">  WorkDaddy</h1>

**语言：** [简体中文](README.md) · [English](README_en.md) · [日本語](README_ja.md)

---

> ## ⚠️ 这是个人改版（fork），不是上游发行版
>
> - 本仓库是 [babygoton/WorkDaddy](https://github.com/babygoton/WorkDaddy) 的**个人 fork**，当前版本 `1.3.0`（已并入上游 `1.2.22`），按 **AGPL-3.0** 分发，保留上游全部版权与许可声明。
> - **与 WorkBuddy 官方没有任何关系**：WorkDaddy 不是腾讯 / WorkBuddy 的产品，也未获其背书；它不修改官方客户端的安装包、签名或数据，只通过本机回环 CDP 与已安装的客户端交互。
> - 与上游的差别：上游是「补丁式部署」（把脚本覆盖进 WorkBuddy 安装目录），本 fork 改成**独立程序 + 独立数据目录**，自己安装、更新、回滚、卸载，并保留旧补丁版的配置迁移路径。差异逐文件记录在 [`docs/migration/`](docs/migration/)，同步流程见 [`docs/upstream-tracking.md`](docs/upstream-tracking.md)。
> - 下面的「它能做什么」等章节继承自上游文档，功能在本 fork 中同样可用。

## 安装

### 方式零：Setup 安装包（CI 验证过，未签名）

`WorkDaddy-<版本>-setup.exe` 是 Inno Setup 引导器：解便携包到临时目录 → 调**同一个**
`install-workdaddy.ps1` → 登记卸载入口。安装逻辑只有一份，Setup 不会和脚本各自漂移。

它已在 CI 的一次性 Windows VM 上通过「静默安装 → 安装记录逐条哈希核对 → 静默卸载 → 数据保留」验证。
**开发机从未运行过它，也没有代码签名**，SmartScreen 会拦；拿不准就用方式一。

### 方式一：装到本机（推荐，可更新可卸载）

```powershell
powershell -ExecutionPolicy Bypass -File installer\install-workdaddy.ps1
```

- 程序：`%LOCALAPPDATA%\Programs\WorkDaddy`；数据：`%APPDATA%\WorkDaddy`（两者必须分开）
- 预检：Windows 10+、是否装了 WorkBuddy 客户端、Node ≥ 22.13、磁盘余量、目标目录可写
- 装后逐文件校验 SHA-256，写 `install-state.json` 作为卸载依据
- 检测到旧补丁版时**只复制**配置到 `%APPDATA%\WorkDaddy\legacy-import\<时间戳>\`，原目录不动
- 常用参数：`-AppDir` `-DataDir` `-NoShortcut` `-SkipClientCheck` `-DryRun` `-Force`
- 退出码：`0` 成功 / `1` 源目录问题 / `2` 预检或路径越界 / `3` 不可写 / `4` 复制失败 / `5` 校验失败 / `6` 数据初始化失败

### 方式二：便携版（解压即用，不写注册表）

解开 `WorkDaddy-<版本>-portable-win-x64.zip`，双击 `scripts\launcher.cmd`。

## 更新

```powershell
powershell -ExecutionPolicy Bypass -File installer\update-workdaddy.ps1 -SourceDir <新版本解压目录>
```

顺序是固定的：版本闸门（拒绝降级，需 `-Force`）→ 暂存到临时目录并逐文件验哈希 → 停掉**本安装目录**的 `daemon.js`/`watchdog.js`（按命令行路径精确匹配，不碰其它进程）→ 整目录备份 → 替换 → 装后校验 → `node --check` 四项健康检查 → 写状态 → 清理暂存。

- 任何一步失败都自动回滚，报告里 `rolledBack` 写明结果；回滚不成功会直接给出备份路径，不会假装成功
- **安装记录也在事务里**：先备份旧 `install-state.json` → 新状态写临时文件并校验（版本、目录、清单条数、每条 path/sha256）→ 同卷原子替换 → 再校验一次。任一步失败，程序与状态各自回滚并**分别**汇报（`rollback.programRestored` / `rollback.stateRestored`），不会出现「程序已是新版本、安装记录还是旧版本」
- 替换前写 `update-journal.json`，状态提交成功后才删。上次更新没做完（磁盘程序与记录版本不一致）时，下一次会 **exit 8 拒绝继续**，确认后用 `-Force` 接着做
- 可恢复版本留在 `%APPDATA%\WorkDaddy\backups\app-<旧版本>-preupdate-<时间戳>`，同目录还有一份旧 `install-state-<版本>-<时间戳>.json`
- 加 `-Restart` 才会在更新后用 `scripts\launcher.cmd` 重新拉起（与双击快捷方式同一条路径）

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File installer\uninstall-workdaddy.ps1
```

- 只删 `install-state.json` 里登记过的文件，逐条比对哈希；**用户改过的文件默认跳过**（退出码 `3`），`-Force` 才删
- 桌面快捷方式只删安装时记录的那一条，不按名字猜
- 默认**保留**全部用户数据；要清理必须双开关：`-PurgeData -YesPurgeData`

## 数据在哪、怎么备份

| 用途 | 路径 |
| --- | --- |
| 程序 | `%LOCALAPPDATA%\Programs\WorkDaddy` |
| 配置与账号缓存 | `%APPDATA%\WorkDaddy`（`config.json`、`accounts\`、`credit-usage.db` 等） |
| 版本备份 | `%APPDATA%\WorkDaddy\backups\` |
| 旧补丁配置导入 | `%APPDATA%\WorkDaddy\legacy-import\<时间戳>\` |
| 日志 | `%APPDATA%\WorkDaddy\logs\`、`daemon.log` |

备份：整体复制 `%APPDATA%\WorkDaddy` 即可（数据库是单文件，直接复制是安全的；运行中复制建议先停服务）。
恢复：先 `scripts\stop-workdaddy.ps1` 停服务 → 把备份目录内容覆盖回 `%APPDATA%\WorkDaddy` → 重新启动。
版本回退：把 `backups\app-<版本>-preupdate-<时间戳>` 的内容覆盖回程序目录即可，它就是更新前的完整副本。

## 支持范围

| 项目 | 支持 |
| --- | --- |
| 系统 | Windows 10 / 11 x64（安装器与托盘） |
| Node | ≥ 22.13（CI 固定 22.14；`node:sqlite` 不需要实验开关） |
| PowerShell | Windows PowerShell 5.1 与 PowerShell 7 都跑过语法/编码检查 |
| 客户端 | WorkBuddy / WorkBuddy AI / CodeBuddy CN / CodeBuddy 桌面端（Electron 窗口） |

## 已知限制

- 仓库里有 49 条**历史测试失败**（`test/known-failures.json` 逐条登记了文件、用例名与错误指纹），不是本次迁移引入的；CI 只对「新增失败」报警。
- `WorkDaddy-<版本>-setup.exe` 已在 **CI 的一次性 Windows VM** 上完成编译与真机安装/卸载验证，但**开发机从未运行过**，且没有代码签名；首次发布前仍建议在一台干净机器上手动走一遍。
- **没有在线下载与签名校验**：不自动检查新版本，也不校验安装包来源；请只使用自己构建或自己核对过 `SHA256SUMS.txt` 的包。
- 仓库里仍提交着 `tray/WorkDaddyTray.exe`（可用 `tray\build.cmd` 或 `installer\build-tray.ps1` 复现，CI 每次现编比对）。等 CI 构建稳定后再评估是否移出 Git。
- `deploy.ps1` 已标为 **LEGACY**：只用于旧补丁版用户迁出配置、或上游大版本升级后临时救急。新安装 / 更新 / 卸载都走 `installer\`，不会再改 WorkBuddy 安装目录。
- 独立安装器目前只有 Windows 版；macOS / Linux 仍按上游方式使用。
- 卸载不会碰 WorkBuddy 客户端自己的数据目录，也不会替你删旧补丁版留下的文件。

## 托盘

`tray\WorkDaddyTray.exe` 是系统托盘控制器（状态 / 启动 / 关闭 / 重启 / 恢复 CDP / 开机自启 / 退出）。

重新编译只需 Windows 自带的 .NET Framework 4.x，不需要 Visual Studio、SDK 或 NuGet：

```powershell
tray\build.cmd
# 或带构建清单与运行验证（推荐）：
powershell -ExecutionPolicy Bypass -File installer\build-tray.ps1 -Verify
```

`installer\build-tray.ps1` 会记录 csc 版本、完整参数、源码与产物 SHA-256 到
`WorkDaddyTray.exe.build.json`，`-Verify` 还会真的跑 `--selftest` / `--status`。
CI 的 `tray-build` 作业每次现编一份，并与仓库里的 EXE 做行为与字面量比对。

## 许可证

[AGPL-3.0](LICENSE)，与上游一致。上游版权归其作者所有；本 fork 的修改同样以 AGPL-3.0 发布。二次分发请保留 `LICENSE` 与来源说明（见 [`docs/upstream-tracking.md`](docs/upstream-tracking.md)）。

---

> **WorkDaddy 是 WorkBuddy 和 CodeBuddy 桌面端增强助手：多账号独立备份、点切即用，跨账号会话迁移、模型管理与自动化任务。WorkBuddy 还支持免打扰、异常中断自动续接、暂存/快捷提示词和五种主题。账号与配置全部留在本机。**
> 本机回环 CDP 注入 · 不改官方安装包。

一个基于 **Chrome DevTools Protocol (CDP)** 的 [WorkBuddy](https://www.workbuddy.cn/)、[WorkBuddy AI](https://www.workbuddy.ai/)、[CodeBuddy CN](https://www.codebuddy.cn/) 和 [CodeBuddy](https://www.codebuddy.ai/) 桌面端增强工具。
CodeBuddy 支持范围为 **Electron 智能体窗口**，不包含 VS Code 编辑器模式的增强面板。通过本机调试接口连接运行中的客户端，不修改官方安装包或签名。

![License](https://img.shields.io/badge/license-AGPL--3.0-blueviolet)
![Platform](https://img.shields.io/badge/platform-macOS%2011%2B%20%7C%20Windows%2010%2F11%20%7C%20Linux-lightgrey)
![Node](https://img.shields.io/badge/node-%E2%89%A522.13-green)

---

## 💖 赞助商

> 想出现在这里？**首批广告位 99 元/月**，欢迎联系 [richdaddycashmany@163.com](mailto:richdaddycashmany@163.com)。

<table>
<tr>
<td width="180" align="center" valign="middle">
  <a href="https://nagora.ai/"><img src="docs/images/nagora.png" alt="Nagora" width="150"></a>
</td>
<td valign="middle"><a href="https://nagora.ai/">Nagora</a> 是专为开发者和团队打造的多模型 AI API 网关。通过一个账户和一枚 API Key，即可统一调用 26+ 款主流文本与图像模型，兼容 OpenAI、Anthropic 与 Gemini 协议，并可无缝接入 Claude Code、Codex、Gemini CLI 等开发工具。平台提供智能路由、自动故障转移、透明计费与统一账单，同时支持预算、限速、并发控制，让个人开发、团队协作和生产环境中的 AI 调用更稳定、更可控。无需改造现有应用，只需替换 Base URL 与 API Key，最快 1 分钟即可完成接入。</td>
</tr>
</table>

---

#### 它能做什么

- **方便切换账号**：每个客户端的账号独立备份，点一下就切，再也不用每次扫码。
- **无感登录新账号**：「登录新账号」支持免退出 OAuth 授权——不退出 WorkBuddy，在浏览器完成扫码后新账号自动加入列表；也可选传统的「假退出」方式回登录页扫码。
- **账号导入导出**：把全部账号备份加密导出，在另一台电脑安装 WorkDaddy 后一键导入，方便电脑之间迁移账号。
- **成长计划与活跃状态**：国内版账号页查询成长任务进度、当日签到和活跃状态、连续活跃天数，以及 Buddy 解锁和旅行状态。
- **Token 和积分用量统计页面**：按天查看 Token 与积分消耗，支持按账号筛选，并显示模型和账号用量排行。
- **积分不足时的账号切换建议**：当前账号积分不足时提示可用账号，方便继续工作。
- **模型频率限制与预计解封时间**：检测到模型限流后，在账号页展示受限模型及预计解封时间。
- **自动化任务**：从 GitHub / Gitee 公开仓库发现并导入任务，或用自然语言让 WorkBuddy 创建任务；支持编辑、手动、事件和定时触发，以及运行日志、停止任务和 JSON / ZIP 导出。
- **权限弹窗免打扰**：真正的零决策弹窗弹出，可以放心开启任务后睡觉。
- **暂存提示词**：输入框边上一键把草稿「暂存」到待发送队列——图片 / 文件 / 引用原样保留，择机发送。
- **切换精美主题**：WorkBuddy 的「接管主题」提供跟随系统、浅色、深色、护眼绿、赛博紫、毛玻璃六种外观；「跟随系统」监听操作系统的深浅色模式变化自动切换，毛玻璃支持预设壁纸、自定义图片壁纸和视频壁纸（MP4 / WebM，静音循环、窗口切后台自动暂停），关闭接管后恢复客户端原生主题。
- **账号间会话迁移**：自动或手动跨账号复制会话，跨账号继续接龙。
- **会话分支**：在「增强」页开启后，任意一条回复都能从此处开始新会话——复制到该条回复为止的聊天内容，原会话保持不变，可在当前工作区继续聊。
- **模型切换更便捷**：解决 WorkBuddy 不支持添加多个同名模型的问题。
- **防止电脑休眠**：睡前任务未完成，开启休眠模式，任务结束后自动切换成允许休眠。
- **异常中断会话自动继续**：AI 回复因网络波动、超时等原因中断时，自动让异常中断任务继续执行。
- **快捷短语**：常用语存进面板，输入框操作栏一键点发；

---

## 客户端与功能范围

| 官方客户端                      | 对应安装包品牌      | profile          |
| -------------------------- | ------------ | ---------------- |
| WorkBuddy 国内版              | WorkDaddy    | workbuddy-cn     |
| WorkBuddy AI 国际版           | WorkDaddy AI | `workbuddy-ai`   |
| CodeBuddy CN 国内版（Electron） | CodeDaddy CN | `codebuddy-cn`   |
| CodeBuddy 国际版（Electron）    | CodeDaddy    | `codebuddy-intl` |

- 请注意：CodeBuddy 不展示「增强」页；「主题」页仅提供悬浮机器人设置。



## 演示

<img src="docs/images/accounts-light.jpg" width="600">
<img src="docs/images/accounts-dark.jpg" width="600">

<img src="docs/images/grow-plan.png" width="700">

![用量统计图](docs/images/usage.png)

![界面预览图](docs/images/pannel-enhance.png)
![界面预览图](docs/images/pannel-robot.png)
![界面预览图](docs/images/pannel-theme.png)

---

## 安装

先安装并登录上表对应的官方客户端，再下载匹配的增强工具。四款包独立安装、使用各自的账号备份目录；安装包名称中的空格使用连字符。

### macOS

1. 在 [Releases](../../releases) 下载对应的 `WorkDaddy-x.y.z.dmg`、`WorkDaddy-AI-x.y.z.dmg`、`CodeDaddy-CN-x.y.z.dmg` 或 `CodeDaddy-x.y.z.dmg`

2. 打开 DMG，把里面对应的 `.app` 拖进 **应用程序** 文件夹

3. 第一次打开如果遇到「无法打开，因为 Apple 无法检查恶意软件」：

   1. 打开「系统设置 → 隐私与安全性」
   2. 在「WorkDaddy 已被阻止」处点 **仍要打开**
   3. 输入开机密码确认
      ![安装引导](docs/images/install-guide.png)

4. 双击对应的 WorkDaddy / CodeDaddy 应用：它会启动本地守护进程，并把面板注入匹配的客户端。macOS 启动器使用本机 Node.js，建议安装 Node.js 22.13 或更新版本。

5. 看到机器人按钮？**搞定**。

#### 企业专享版 / VPC 客户端

macOS 会自动扫描带 `WorkBuddy` 前缀且包含 `Contents/MacOS/Electron` 的客户端（例如 `WorkBuddy企业定制版.app`），并按 WorkDaddy/WorkDaddy AI profile 排除另一端。发现多个候选时会弹出系统选择窗口，选中后自动记住，不需要手动寻找配置文件。完全自定义名称也可以在源码目录执行下面的高级配置命令：

```bash
node scripts/workbuddy-target.js --configure --platform darwin \
  --profile workbuddy-cn \
  --binary "/Applications/企业客户端.app/Contents/MacOS/Electron" \
  --data-dir "$HOME/Library/Application Support/WorkDaddy"
```

### 会话工作目录恢复

默认不会自动重建已删除的会话工作目录。旧会话需要原目录时，请手动恢复目录；如需启用 Windows 上的自动恢复，可在启动 WorkDaddy 前设置环境变量 `WORKDADDY_REPAIR_MISSING_SESSION_WORKSPACES=1`。启用后，缺失目录会被定期重建。

### Windows

1. 在 [Releases](../../releases) 下载对应客户端的 `WorkDaddy-Setup-x.y.z.exe`、`WorkDaddy-AI-Setup-x.y.z.exe`、`CodeDaddy-CN-Setup-x.y.z.exe` 或 `CodeDaddy-Setup-x.y.z.exe`
2. 双击安装器完成安装
3. 双击打开对应品牌的桌面快捷方式

#### Windows 便携版 ZIP

不想安装时，可以使用对应的 `<品牌>-Portable-x.y.z.zip`：品牌为 `WorkDaddy`、`WorkDaddy-AI`、`CodeDaddy-CN` 或 `CodeDaddy`。

1. 先安装并登录对应的 WorkBuddy / CodeBuddy 客户端。
2. 将 ZIP 解压到一个有写入权限的目录，不要直接在压缩包内运行。
3. 双击解压目录顶层的 `Start-WorkDaddy.cmd`；也可以直接运行 `WorkDaddyLauncher.exe`。
4. 需要停止后台服务时，运行同目录的 `Stop-WorkDaddy.cmd`。

便携包不会创建桌面快捷方式或卸载项；账号备份和运行数据仍保存在当前用户的 `%APPDATA%\WorkDaddy`，不会随 ZIP 搬走。同一客户端 profile 不能同时运行安装版与便携版，也不能同时运行两份便携版。便携版不使用面板中的自动更新，升级时先运行 `Stop-WorkDaddy.cmd`，确认旧进程停止后再解压新版 ZIP。需要常驻安装和桌面快捷方式时，请下载对应的 Setup.exe。

#### 企业专享版 / VPC 客户端

企业专享版用户仍安装与界面最接近的 `WorkDaddy` 或 `WorkDaddy AI`。安装程序会先自动识别对应的官方客户端，并在安装向导中显示路径和版本；企业版用户点击「浏览」改选自己的 `.exe` 主程序即可，不需要修改配置文件或设置系统环境变量。

选择结果保存在 WorkDaddy 的个人数据目录中。更新安装默认保留上次选择，也可以在安装向导中修改；需要改回官方客户端时，重新运行安装程序并选择自动识别出的官方 `.exe`。WorkDaddy 会锁定所选客户端版本，客户端升级或移动后同样通过安装程序重新确认。

### Linux

Linux 发布包面向 Ubuntu / Debian `amd64` 和 `arm64`，内置对应架构的 Node.js。请先安装并登录同架构的官方客户端；增强工具通过本机调试接口连接，不修改客户端本体。

| 品牌           | DEB 文件                          | 安装目录 / Debian 包名                     |
| ------------ | ------------------------------- | ------------------------------------ |
| WorkDaddy    | `WorkDaddy_x.y.z_<arch>.deb`    | `/opt/workdaddy` / `workdaddy`       |
| WorkDaddy AI | `WorkDaddy-AI_x.y.z_<arch>.deb` | `/opt/workdaddy-ai` / `workdaddy-ai` |
| CodeDaddy CN | `CodeDaddy-CN_x.y.z_<arch>.deb` | `/opt/codedaddy-cn` / `codedaddy-cn` |
| CodeDaddy    | `CodeDaddy_x.y.z_<arch>.deb`    | `/opt/codedaddy` / `codedaddy`       |

1. 从 [Releases](../../releases) 下载对应文件，`<arch>` 为 `amd64` 或 `arm64`。

2. 在下载目录安装选中的包，例如：

   ```bash
   sudo apt install ./CodeDaddy-CN_1.2.9_amd64.deb
   ```

3. 从应用菜单启动对应品牌的应用。首次启动会准备数据目录并启动后台服务；随后按提示开启客户端 CDP。CodeBuddy 请进入 Electron 智能体窗口。

四款包可以同时安装，互不覆盖，默认不设置开机自启。没有应用菜单时，可运行对应入口：

```bash
bash /opt/workdaddy/scripts/launch-gui-linux.sh cn
bash /opt/workdaddy-ai/scripts/launch-gui-linux.sh ai
bash /opt/codedaddy-cn/scripts/launch-gui-linux.sh codebuddy-cn
bash /opt/codedaddy/scripts/launch-gui-linux.sh codebuddy-intl
```

需要开机启动后台服务时，按对应 profile 启用 systemd 用户服务，例如：

```bash
WBSWITCH_PROFILE=codebuddy-cn bash /opt/codedaddy-cn/scripts/systemd-install-linux.sh
```

用 `sudo apt remove <包名>` 卸载。卸载不会删除账号备份和运行数据；需要清理时，先确认 `~/.config/WorkDaddy` 中对应 profile 的数据。Linux 暂不支持面板内自动更新，请安装新版 DEB 升级。

#### 从源码安装 Linux 版本

在 Linux 主机上执行：

```bash
git clone https://github.com/babygoton/WorkDaddy.git
cd WorkDaddy
bash scripts/install-linux.sh
bash scripts/relaunch-with-cdp-linux.sh
```

国际版 WorkBuddy AI 使用隔离环境时执行：

```bash
WBSWITCH_PROFILE=workbuddy-ai bash scripts/workbuddy-ai-linux.sh install
bash scripts/workbuddy-ai-linux.sh relaunch
```

需要指定 WorkBuddy 可执行文件时，追加 `WBSWITCH_WORKBUDDY_BIN=/path/to/workbuddy`；安装脚本会创建备份目录、记录客户端路径并启动本地守护进程。

### 从源码运行（开发者）

```bash
git clone https://github.com/babygoton/WorkDaddy.git
cd WorkDaddy
bash scripts/install.sh        # 创建备份目录 + 启动守护进程
bash scripts/relaunch-with-cdp.sh   # 把 WorkBuddy 切换到调试模式（端口 9222）
```

四款客户端使用同一套 daemon，通过 profile 绑定客户端，不靠“第一个 CDP 端口”猜测目标：

```bash
WBSWITCH_PROFILE=workbuddy-cn bash scripts/relaunch-with-cdp.sh
WBSWITCH_PROFILE=workbuddy-ai bash scripts/relaunch-with-cdp.sh
WBSWITCH_PROFILE=codebuddy-cn bash scripts/relaunch-with-cdp.sh
WBSWITCH_PROFILE=codebuddy-intl bash scripts/relaunch-with-cdp.sh
```

macOS 发布四款 DMG；Linux 为四款客户端分别提供 `amd64`、`arm64` DEB；Windows 构建脚本为四款客户端生成 Setup.exe 和 Portable ZIP。具体可下载的平台与版本以 [Releases](../../releases) 中的资产为准。

```bash
WORKDADDY_BUILD_VERSION=1.2.9 bash scripts/build-mac-dmg.sh
WORKDADDY_BUILD_VERSION=1.2.9 WORKDADDY_BUILD_ARCH=amd64 bash scripts/build-linux-deb.sh
WORKDADDY_BUILD_VERSION=1.2.9 WORKDADDY_BUILD_ARCH=arm64 bash scripts/build-linux-deb.sh
```

macOS 可用 `WORKDADDY_BUILD_PROFILE` 指定上表中的单个 profile。Windows Portable ZIP 可直接使用；`*-win64.zip` 仅为安装器构建的临时输入，不作为发布包。

`install.sh` 做了：

- 创建 `~/Library/Application Support/WorkDaddy` 备份目录
- 首次启动自动兼容迁移旧版 `~/Library/Application Support/HelloBuddy/accounts` 账号备份（旧目录保留不删除）
- 首次备份当前 WorkBuddy 账号
- 清理旧 launchd 注册并手动启动守护进程（不再登录自启）
- 立即启动后台守护进程
- 打开管理界面 `http://127.0.0.1:47832`

> 守护进程会在安装结束时手动启动；需要使用时手动启动对应的 WorkDaddy 端即可。

---

## 原理

**CDP 注入 · 不改官方安装包**

```
┌─────────────┐  --remote-debugging-port=9222  ┌──────────────┐
│  WorkBuddy  │ <───────────────────────────> │  WorkDaddy   │
│  (Electron) │       Chrome DevTools          │   daemon.js  │
│             │        Protocol (CDP)          │              │
│  渲染进程    │  ←── Runtime.evaluate ────     │  HTTP :47832 │
│  右下角     │      注入 inject.js            │  本地 API    │
└─────────────┘                                └──────────────┘
```

以下示意图以 WorkBuddy 国内版为例；四个 profile 的默认本地 API 端口依次为 `47832`、`47833`、`47834`、`47835`，渲染器 CDP 端口依次为 `9222`、`9223`、`9224`、`9225`。CodeBuddy 另用本机主进程调试端口 `9244` / `9245` 访问原生登录态与会话存储。

1. **不修改 WorkBuddy 二进制**：用 `launcher` 启动 WorkBuddy 时多带一个 `--remote-debugging-port=9222` 参数，**二进制与签名原封不动**。
2. **守护进程通过 CDP 连接 WorkBuddy**：监听登录/认证网络事件 + 文件监听兜底，每次登录/刷新令牌都把当前登录信息按 `account.uid` 备份到稳定目录。
3. **注入界面组件**：`Runtime.evaluate` 把 `inject.js` 推到渲染进程执行，在右下角渲染机器人按钮和多标签页面板（账号 / 主题 / 会话 / 模型 / 增强 / 自动化 / 电脑 / 关于 / 设置），按客户端能力显示，CodeBuddy 隐藏「增强」。
4. **本地 HTTP API**：daemon 在 `127.0.0.1:47832` 起服务，组件通过 fetch 调用（账号切换、主题应用、成长进度查询、决策弹窗开关、休眠控制等）。
5. **数据边界清晰**：账号备份和本地配置保存在本机；按功能访问 WorkBuddy 官方 API 或 CodeBuddy 官方 API（登录、积分）和 GitHub Releases（更新检查），显式执行模型连通测试时会向你配置的模型服务发送请求及对应 API Key；脱敏错误诊断默认开启，可在「关于」页关闭。

> 为什么用 CDP 而不是官方插件机制：直接面向运行中的应用实例，事件级感知登录变化，
> 主动注入界面与样式补丁，**官方升级 WorkBuddy 后只要界面没大改就照常工作**。

---

## 使用

### 面板

WorkBuddy / CodeBuddy Electron 窗口右下角的机器人按钮 → 弹出面板 → 选你要的操作：

| Tab     | 能做什么                                                                            |
| ------- | ------------------------------------------------------------------------------- |
| **账号**  | 查看账号数、积分、模型频率限制与预计解封时间、当日签到状态、连续活跃天数、成长任务进度及 Buddy 旅行状态；切换、删除或登录新账号，并加密导入导出账号备份 |
| **主题**  | WorkBuddy：接管主题并选择六种外观（含跟随系统），管理壁纸、头像和背景；CodeBuddy：黑白悬浮机器人设置                          |
| **会话**  | 按账号和时间筛选会话，批量复制或删除，并设置会话 / 工作空间在切换账号时自动复制                                       |
| **模型**  | 管理当前模型和备选模型，支持备份、复制、编辑、启用、连通测试及批量删除                                             |
| **增强**  | 配置权限免打扰、异常中断自动续接、会话分支、暂存提示词和快捷短语                                                |
| **自动化** | 从 GitHub / Gitee 发现并导入任务、让 WorkBuddy 创建任务，管理触发方式与运行日志，以及 JSON / ZIP 导出          |
| **电脑**  | 允许或持续禁止休眠，也可在所有 AI 任务结束后自动恢复休眠                                                  |
| **关于**  | 查看版本和项目说明、检查并安装更新、控制脱敏错误诊断                                                      |
| **设置**  | 选择中文或英语；首次打开按系统语言匹配，未匹配时使用英语                                                    |

**输入框插件（仅 WorkBuddy / WorkBuddy AI）**：在「增强」页分别开启「暂存提示词」和「快捷短语」后，输入框操作栏会显示对应按钮。
暂存提示词可把当前草稿（文字、图片、文件、引用等**完整原样**）加入 WorkBuddy 自带的待发送队列，并暂停自动发送；
入队后输入框自动清空，内容按会话独立保存，可随时发送、编辑或删除。快捷短语可在增强页新增、编辑和批量管理，并从输入框操作栏一键发送，发送后不会自动删除。

### 自动化

把重复操作保存成任务，例如查询账号积分、按条件显示提醒，或在指定会话发送消息并等待回复。

1. 打开「自动化」页，通过「发现任务」浏览公开仓库中的任务，或使用「让 WorkBuddy 帮我创建」描述需求。WorkBuddy 会在新会话中生成任务，完成后自动加入列表；「查看接口说明」提供当前支持的操作说明。
2. 设置触发方式：手动运行，或在客户端加载、打开面板、页面就绪、账号切换等事件发生时执行；也支持按间隔、每日、每周、每月或指定时间调度。
3. 在列表中启用、停用、编辑或复制任务。手动任务可立即运行，事件和定时任务按配置触发；执行过程中可停止，并通过「运行日志」查看结果和失败步骤。

**任务导入导出**：通过「发现任务」从 GitHub / Gitee 公开仓库导入，导入后保持停用，不覆盖相同 ID 的已有任务；不兼容任务会提示原因。通过批量操作选择任务导出，单个保存为 JSON，多个保存为 ZIP。

#### 提交公开任务

「发现任务」收录 GitHub 和 Gitee 公开仓库中的任务，参考示例仓库 [`babygoton/workdaddy-official-plugin`](https://github.com/babygoton/workdaddy-official-plugin)：

1. 克隆示例仓库，删掉 `tasks/` 目录里不需要的示例任务；
2. 把自己的自动化任务 JSON 放进 `tasks/` 目录（单个文件不超过 1 MiB，每个仓库最多收录 200 个）；
3. 提交改动并推送到 GitHub 或 Gitee；
4. 在仓库描述（简介）里加入关键词 `WorkDaddyAutomationRepository`。

符合约定的仓库会在下一次刷新后出现在「发现任务」列表中（搜索结果有 10 分钟缓存）。导入只读取文件并做兼容性检查，不会执行任务；导入后保持停用，相同 ID 的已有任务不会被覆盖。

任务定义保存在本机，由 WorkDaddy 本地服务执行；定时和事件触发需要服务保持运行，涉及页面交互的步骤还需要对应 WorkBuddy 客户端可用。任务导出不包含账号备份或运行日志；自动化页不提供本地 JSON / ZIP 文件导入。

### 账号迁移到其他电脑

在账号页右上角使用「导出」和「导入」按钮即可迁移全部账号：

1. 在旧电脑打开 WorkDaddy 账号页，点击「导出」，保存生成的 `WorkDaddy-账号导出-YYYY-MM-DD.json` 文件。
2. 用安全方式把导出文件传到新电脑，并在新电脑安装、启动 WorkDaddy。
3. 打开账号页点击「导入」，选择导出文件；导入完成后即可在账号列表中切换恢复的账号。

新版导出会使用你输入的密码、每次导出随机 salt 和 AES-256-GCM 加密；密码不会写入导出文件。文件中仍包含可恢复登录状态的 token，请像保护密码一样安全保存和传输，迁移完成后及时删除不再需要的副本。旧版 v1 导出仍可兼容导入。

## 安全与隐私

- **本地数据优先**：账号备份、主题和本地配置不会在后台上传；登录、积分等功能会访问 WorkBuddy 官方 API 或 CodeBuddy 官方 API，自动更新会访问 GitHub Releases；显式执行模型连通测试时，会向你配置的第三方模型地址发送请求及对应 API Key。
- **发送错误诊断默认开启**：关于页的「发送错误诊断」开关同时控制 Sentry 远程错误诊断和本地脱敏渲染器日志，帮助定位版本和兼容性问题；处理内容经过脱敏、截断，远程上报不包含账号、会话内容、Token 或 API Key。随时可以在关于页关闭；`WORKDADDY_TELEMETRY=0`/`1` 可作为启动时的明确关闭/开启覆盖。

独立的 `SECURITY.md` 可补充完整威胁模型；未提供时，本节即为安全与隐私说明。

---

## 许可与声明

本项目采用 **[GNU Affero General Public License v3.0](LICENSE)** 开源（`SPDX-License-Identifier: AGPL-3.0-or-later`）。

- 本项目面向本机运行的 WorkBuddy / CodeBuddy 桌面端做界面与体验增强，**与两者官方无隶属关系**。
- WorkBuddy、CodeBuddy 及其商标、官方资源归其权利人所有；本项目未获得其官方授权或认可。
- 第三方主题、壁纸、背景图等素材仅作演示，商用前请自行确认权利。

---

<a href="https://www.star-history.com/?repos=babygoton%2Fworkdaddy&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=babygoton/workdaddy&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=babygoton/workdaddy&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=babygoton/workdaddy&type=date&legend=top-left" />
 </picture>
</a>

---

## 社区支持

[Linux.do](https://linux.do/)
