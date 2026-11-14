# 阶段 1 功能矩阵

口径：每条功能给出**代码证据**（文件/函数）、两侧状态、迁移判定。判定只用五个值：

- `已确认完整` —— 代码在、测试在、行为可解释
- `需要移植` —— 分叉新增，需逐块搬到合并后的树上
- `需要重构` —— 能与上游同类模块合并，或需要拆出独立模块
- `需要重新测试` —— 代码可用但行为依赖被上游改过的接口
- `无法确认` —— 证据不足，禁止凭猜测迁移

---

## 1. 上游功能（1.2.22）

| # | 功能 | 代码证据 | 分叉现状 | 合并后判定 |
|---|---|---|---|---|
| U1 | 多账号与身份 | `account-identity.js`、`primary-account.js`、`profiles.js`（`workbuddy-cn` / `workbuddy-ai` / `codebuddy-cn` / `codebuddy-intl`，端口 47832–47835） | 分叉保留（A 类，未改） | 已确认完整 |
| U2 | 账号切换与重启 | `switch.js`、`windows-relaunch-standard.ps1`、`windows-startup-recovery.js`、`relaunch-with-cdp*.sh` | 分叉保留 | 已确认完整（上游 1.2.22 改过 `windows-startup-recovery`，取上游） |
| U3 | 会话备份/迁移（加密归档） | `session-transfer.js`（v4 archive：认证头 + AES-GCM(gzip)）、`secure-transfer.js`、`session-copy-error.js` | 分叉保留 | 已确认完整（取上游，分叉无改动） |
| U4 | 会话分叉（Fork 会话） | `session-fork.js`、`docs/session-fork.md` | 分叉保留 | 已确认完整 |
| U5 | 会话同步/复制/去脏 | `session-sync.js`、`session-db.js`、`session-dirty.js`、`codebuddy-session-store.js` | 分叉保留，但 `daemon.js` 侧被分叉改过（E 类） | 需要重新测试 |
| U6 | 官方会话置顶保活 | `session-pin-sync.js`（上游 1.2.22 新增，5723 B） | **分叉已自研同名实现（9854 B）** | **需要重构 —— 见 §3** |
| U7 | 自动化任务体系 | `automation.js` + `automation-{account-sync,compatibility,discovery,likes,model,packages,picker,runtime,transfer,zip}.js`、`builtin/automations/*.json`、`schemas/automation-package.v1.schema.json` | 分叉保留（仅 `test/automation-v2.test.js` 改过时区断言） | 已确认完整 |
| U8 | 主题与壁纸 | `theme-patches.js`、`theme-text-shadow.js`、`theme-vars.js`、`wallpaper-rotation.js`、`wallpaper-video.js`（上游 1.2.22 新增）、`builtin/wallpapers/*`、`builtin/nebula/*` | 分叉缺失 `wallpaper-video.js` | 需要移植（取上游新增） |
| U9 | 模型管理 | `automation-model.js`、`third-party-models.js` | 分叉保留 | 已确认完整 |
| U10 | Token 与积分统计 | `token-stats.js`、`token-refresh.js`、`credit-{history-sync,request-usage,resource-queries,rotation,segments,usage-store}.js`、`growth-{active,daily}.js`、`account-credit-cache.js` | 分叉保留 | 已确认完整（上游 1.2.22 改过过期账号查询，取上游） |
| U11 | CDP 管理与客户端目标识别 | `cdp-targets.js`、`workbuddy-target.js`、`workbuddy-compat.js`、`windows-native/main.go`、`relaunch-with-cdp*` | 分叉有改动（`daemon.js` 侧） | 需要重新测试 |
| U12 | UI 注入与面板 | `inject.js`（1.36 MB，模板内嵌）、`renderer-api-bridge.js`、`ui-port.js`、`toast-{options,runtime}.js`、`markdown-preview.js` | 分叉改过 `inject.js`（E 类） | **需要重新测试 + 手工合并** |
| U13 | 人设/记忆 | `persona.js` | 分叉保留 | 已确认完整 |
| U14 | 独立安装与更新 | `install-win.ps1`、`install-win.cmd`、`Install-WorkDaddy.cmd`、`Uninstall-WorkDaddy.cmd`、`uninstall-win.ps1`、`apply-update.{ps1,sh,vbs}`、`prepare-win-install.ps1`、`make-setup.cmd`、`win/setup.sed`、`win/workdaddy.iss`、`build-win-{zip.sh,installer.ps1,release.cmd,release.ps1}`、`build-windows-native.ps1`、`watchdog.js`、`win-launcher.js`、`launcher.cmd`、`launcher-hidden.vbs` | 分叉保留但被 `deploy.ps1` 那套绕过；`install-win.cmd`/`launcher.cmd`/`Install-WorkDaddy.cmd` 被分叉改过（B 类） | **需要重构 —— 阶段 4 的底座** |
| U15 | 权限边界与提权探测 | `windows-process-boundary.{js,ps1}`、`win/probe/probe-windows.{cmd,ps1}` | 分叉保留 | 已确认完整 |
| U16 | 多平台（Linux/macOS） | `install.sh`、`install-linux.sh`、`install-desktop-linux.sh`、`uninstall-linux.sh`、`systemd-install-linux.sh`、`launch-gui-linux.sh`、`linux-daemon-process.js`、`build-linux-deb.sh`、`build-mac-dmg.sh`、`relaunch-with-cdp-linux.sh`、`workbuddy-ai-linux.sh`、`assets/*.icns`、`assets/dmg-layout/*` | 分叉保留 | 已确认完整（本轮只保证 Windows 可用） |
| U17 | 诊断与遥测 | `sentry-report.js`、`usage-report.js`、`completion-report.js` | 分叉保留 | 已确认完整 |
| U18 | 原子写与文件安全 | `atomic-file-write.js` | 分叉保留 | 已确认完整 |
| U19 | 清单/账号列表工具 | `list.js`、`sync.js`、`components`（`client-launch-settings.js`、`codebuddy-files.js`、`codebuddy-native*.js`） | 分叉保留 | 已确认完整 |

## 2. 分叉增强（28 个提交的产出）

| # | 功能 | 代码证据 | 与上游关系 | 判定 |
|---|---|---|---|---|
| F1 | 会话归属接管（把同机其他账号的会话改归属） | `rehome-sessions.js`（21700 B）、`rehome-audit.js`（只读体检）、`rehome-watcher.js`（状态机+退避）、`rehome_sessions.py`（早期实现）、`bind-rehome-ui.py`（面板绑定）、`setup-rehome.ps1` | 全新，上游无对应 | 需要移植（C 类，合并时原样保留） |
| F2 | 会话去重 | `session-dedupe.js`（31553 B）：四层证据 + 顺序证据 + 包含层 | 全新 | 需要移植 + 需要重新测试（涉及写库） |
| F3 | 会话范围识别 | `session-scope.js`（8342 B）：`buildTakeoverScope`、`assessDeletedSemantics` | 全新 | 需要移植 + 需要重新测试 |
| F4 | 权限配置保护 | `permission-sync.js`（27208 B）：A/B/C 三开关、默认全关、`stopPermissionGuards` 七层停闭、只读探针 | 全新，**上游完全无此模块** | 需要移植 + 需要重新测试 |
| F5 | Windows 托盘控制器 | `tray/WorkDaddyTray.cs`（25630 B）、`WorkDaddyTray.exe`（二进制 20992 B）、`build.cmd`、`Start-WorkDaddyTray.cmd` | 全新 | 需要重建（二进制不入源码可信链，阶段 2 只保留源码与构建脚本） |
| F6 | 补丁部署工具 | `deploy.ps1`（24345 B，七步 + SHA-256 代际闸门 + 回滚）、`deploy.cmd`、`scripts/upstream.json`、`workbuddy-exe.example.json` | 与上游安装器职责重叠 | **需要重构 —— 降级为「旧补丁版迁移工具」** |
| F7 | 自建 CI 与测试基线 | `.github/workflows/test.yml`、`.github/scripts/check-powershell.ps1`、`test/run-ci.js`（逐文件 runner + 四道闸 + 基线差分）、`test/tap-fingerprint.js`（TAP 解析 + 错误指纹）、`test/known-failures.json`（schema 4，57 条历史失败） | 上游无 | 需要移植（C 类） |
| F8 | 分叉专属测试 | `test/rehome-*.test.js`、`test/session-scope.test.js`、`test/permission-guard.test.js`、`test/deploy-safety.test.js`、`test/run-ci-signature.test.js` | 上游无 | 需要移植 |
| F9 | 守护进程路由扩展 | `daemon.js` +375 行：9 条 `/api/rehome/*`、`/api/permission/*` 路由、启动 6s reconcile | 与上游 1.2.22 的 `handleApi` 改动重叠 | **需要手工合并** |
| F10 | 启动/停止辅助 | `stop-workdaddy.ps1`、`fix-cdp.cmd` | 上游有 `Stop-WorkDaddy.cmd`，职责重叠 | 需要重构（择一） |
| F11 | 分叉文档 | `HANDOFF.md`（36754 B）、`REHOME-README.md`（56393 B）、`REPORT-1.3.0.md`、`REVIEW-1.3.0.md`、`README_UPSTREAM.md` | 上游无 | 保留，阶段 6 重新组织 |

## 3. 唯一的重叠功能：官方会话置顶保活

| 维度 | 上游 `03aeabc`（1.2.22） | 分叉自研 |
|---|---|---|
| 文件 | `scripts/session-pin-sync.js` 5723 B / +95 行 | 同路径 9854 B / +229 行 |
| 测试 | `test/session-pin-sync.test.js` 7036 B / +113 行 | 同路径 6308 B / +165 行 |
| 引入时间 | 2026-11-13 | 早于上游（分叉第 2 批提交内） |
| 行为假设 | 切号后重放官方置顶 | 切号后重放官方置顶 + 分叉自己的边界处理 |

判定：**需要重构**。处理顺序定为

1. 先读两份实现与两份测试，列出各自覆盖的场景（阶段 2 的提交 3 之前完成）。
2. 以上游实现为主干（保证跟上游同步时冲突最小），把分叉测试里上游没覆盖的场景作为增量用例补进去；若分叉实现确有上游没有的边界处理，以**补丁形式**加到上游实现上，而不是整文件替换。
3. 两者测试合并后必须全部通过；不允许为了合并通过而删除任一侧用例。

在完成上述比对前，这两个文件标记 `无法确认`，禁止机械取一侧。

## 4. 合并后的功能归属

| 归属 | 功能 |
|---|---|
| 上游主干（不改） | U1–U5、U7、U9–U11、U13、U15–U19 |
| 上游主干 + 分叉补丁 | U12（`inject.js`）、U14（安装器，加安全闸门）、F9（`daemon.js` 路由） |
| 分叉独立模块 | F1–F4、F7、F8 |
| 需要决策 | U6 / F6 / F10 |
| 仅保留源码、不进发行包 | F5（托盘二进制） |
