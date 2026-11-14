# 阶段 0–1 仓库与文件清单

- 生成时间：2026-11-14
- 操作分支：`feat/full-fork-migration`（从 `fix/workdaddy-data-permission-hardening` @ `33d0e66` 拉出）
- 本阶段性质：**只读盘点**，除本目录下的报告与 `tools/migration/inventory.js` 外未改任何代码。

---

## 1. 仓库身份

| 项 | 值 |
|---|---|
| 本地路径 | `H:\AI工作区\wb账号同步\WorkDaddy` |
| origin | `https://github.com/jmwangde3/WorkDaddy.git` |
| upstream | `https://github.com/babygoton/WorkDaddy.git`（本轮新增并 `fetch --tags`） |
| 许可证 | AGPL-3.0（`LICENSE` blob `5d509ec`，两侧**逐字节相同**） |

`git remote -v` 现状：

```
origin    https://github.com/jmwangde3/WorkDaddy.git (fetch/push)
upstream  https://github.com/babygoton/WorkDaddy.git (fetch/push)
```

`upstream` 只用于 fetch，不配置 push。

## 2. 基线（实测，非假定）

| 角色 | 引用 | SHA | 日期 | 提交标题 |
|---|---|---|---|---|
| main（未动） | `main` = `origin/main` | `041e3dc` | — | fix(permission): 三层补一次追不上写盘 |
| 已审查功能分支 | `fix/workdaddy-data-permission-hardening` | `33d0e66` | 2026-11-14 | docs(1.3.0): 记录第二轮 CI 结果 |
| **共同祖先** | `merge-base` | **`fb9f8db`** | **2026-11-08** | **Merge branch codex/1.2.20 into main** |
| 上游 HEAD | `upstream/main` | `9b9bad5` | 2026-11-13 | merge: integrate 1.2.22 into main |

- 自共同祖先以来：分叉 **28** 个提交、上游 **19** 个提交。
- 迁移分支起点记为 `33d0e66`，写入本文件作为基线。
- 工作区在拉分支前是干净的（`git status --short` 无输出）。
- 现有标签：本地与远程均只有 `1.2.20`（其余 `1.2.3`…`1.2.22` 随 `fetch upstream --tags` 从上游带入，未推送）。

### 2.1 一处必须纠正的旧结论

`scripts/upstream.json` 目前写着 `baseIsUpstreamAncestor: false`，并据此把上游基线当成 1.2.22、把文件代际闸门的上游哈希按 1.2.22 取值。**这个结论是错的。**

实测：

```
git merge-base --is-ancestor fb9f8db HEAD          → 真
git merge-base --is-ancestor fb9f8db upstream/main → 真
```

即 `fb9f8db`（1.2.20，2026-11-08）同时是两侧祖先。本分叉不是「无共同祖先的独立仓库」，而是**从 1.2.20 正常拉出、打了 28 个提交的分叉**。之前判断「daemon.js 比 1.2.22 小 12021 字节，说明基线不是 1.2.22」——那句话本身没错，但结论应落在「基线是 1.2.20」，而不是「没有祖先关系」。

这条纠正有三个直接后果：

1. **阶段 2 不需要 `--allow-unrelated-histories`**，可以做正常三方合并；也不需要「复制文件伪装成 Fork」。
2. 核心文件可以用 `git diff fb9f8db HEAD -- <file>` 精确取出「分叉补丁」，不必猜上游原始代码。
3. `upstream.json` 的上游哈希必须按 **1.2.20**（`fb9f8db`）取，而不是 1.2.22；否则代际闸门永远判 `unknown-generation`。修正排进阶段 2 的提交。

## 3. 目录规模

| 树 | 文件数（blob） |
|---|---|
| 共同祖先 `fb9f8db` | 358 |
| 分叉 `33d0e66` | 398 |
| 上游 `9b9bad5` | 367 |
| 三树并集 | 405 |

分叉侧 `scripts/` 147 个文件、`test/` 188 个；上游 `test/` 181 个。上游**没有** `package.json`，也没有 `tray/`、没有权限守卫、没有会话接管/去重/范围识别模块。

## 4. 逐文件分类结果

分类口径：以共同祖先 `fb9f8db` 为基准，分别看两侧是否改动过该路径。

| 类 | 含义 | 数量 | 迁移方式 |
|---|---|---|---|
| A | 两侧都没动 | 308 | 保留上游实现 |
| B | 只有分叉改了 | 8 | 保留分叉实现（用祖先校验没被整文件覆盖） |
| C | 只有分叉新增 | 38 | 保留 |
| D | 只有分叉删除 | 0 | — |
| E | **两侧都改了** | **5** | **必须逐文件手工合并** |
| F | 只有上游改了/新增 | 44 | 采纳上游版本 |
| G | **同名但两侧各自新增、内容不同** | **2** | **暂停，单独确认** |

风险分布：`high` 42、`medium` 159、`low` 202、`unknown` 2。

完整逐文件表见 `01-file-diff.csv`（19 列，含两侧 SHA-256、字节差、分叉侧触及提交、迁移方式、测试要求、风险级）；机读版 `01-inventory.json`。生成器 `tools/migration/inventory.js` 可重跑，参数 `--base/--fork/--upstream/--out`。

### 4.1 五个 E 类（两侧都改，必须手工合并）

| 文件 | 分叉侧改动 | 上游侧改动 | 祖先字节 | 分叉字节 | 上游字节 |
|---|---|---|---|---|---|
| `scripts/daemon.js` | +375 / -9 | +633 / -97 | 719017 | 737269 | 749088 |
| `scripts/inject.js` | +44 / -44 | +487 / -118 | 1359391 | 1359561 | 1386282 |
| `scripts/lib.js` | +14 / -0 | +48 / -5 | 94114 | 95030 | 96050 |
| `scripts/win-launcher.js` | +18 / -1 | +34 / -22 | 85164 | 86115 | 85801 |
| `README.md` | +431 / -212 | +16 / -1 | 23119 | 26206 | 24189 |

`daemon.js` 两侧都动过的区域：`primaryAccountStore` 初始化（祖先 537 行附近）、`handleApi` 路由分发、`startServer`。其余改动落在不同区段，三方合并能自动合大部分，冲突集中在上述三处。

`inject.js` 分叉侧 +44/-44 是等量替换，属于小范围改写；上游 +487/-118 覆盖主题/壁纸/会话区，冲突面主要看是否命中同一段。

### 4.2 两个 G 类（同名、各自新增、实现不同）

| 文件 | 上游 | 分叉 |
|---|---|---|
| `scripts/session-pin-sync.js` | 5723 字节，+95 行（提交 `03aeabc fix: preserve official session pins across account switches`） | 9854 字节，+229 行 |
| `test/session-pin-sync.test.js` | 7036 字节，+113 行 | 6308 字节，+165 行 |

两个实现目标相同（切号时保住官方会话置顶），但上游在 1.2.22 才引入，分叉更早自研。**不能简单取一侧**：需要读两份实现、确认行为覆盖面，选一个作为主实现，把另一个的独有能力并进去。这是阶段 2 里唯一需要「设计决策」而不是「机械合并」的地方，单独列在风险登记 R3。

### 4.3 八个 B 类（只有分叉改了）

| 文件 | 说明 |
|---|---|
| `.gitattributes` | 分叉加了 `eol=lf` 与 `*.cmd/*.bat eol=crlf`（CI 必需） |
| `.gitignore` | 分叉加了 `__pycache__`、报告产物等 |
| `scripts/Install-WorkDaddy.cmd` | 分叉改过（2167 vs 祖先 2214） |
| `scripts/build-win-zip.sh` | 分叉加了品牌化与 `sys.stdout.reconfigure` |
| `scripts/install-win.cmd` | 分叉改过 |
| `scripts/launcher.cmd` | 分叉改过 |
| `scripts/verify-win.cmd` | 分叉改过 |
| `test/automation-v2.test.js` | 分叉改了 `localDate` 断言的时区处理 |

这些上游都没动，合并时会原样保留分叉版本。

### 4.4 四十四项 F 类里必须注意的

- `scripts/workbuddy-compat.js`：上游 29585 vs 分叉 25976，+3609 字节。这是客户端兼容层，上游 1.2.22 扩了版本识别，**采纳上游**。
- `scripts/renderer-api-bridge.js`：上游 9980 vs 分叉 9183，**采纳上游**。
- `scripts/cdp-targets.js`、`scripts/windows-native/main.go`、`scripts/build-mac-dmg.sh`：小幅上游修改，采纳上游。
- 上游新增三个运行文件：`scripts/client-temp.js`、`scripts/wallpaper-video.js`、`docs/images/nagora.png`，直接带入。
- 其余 34 个是 `test/*`，采纳上游；这些测试会顺带把上游 1.2.21/1.2.22 的行为变更变成可执行约束。

## 5. 工具链与 CI 对比

| 项 | 上游 | 分叉 |
|---|---|---|
| `package.json` | 无 | 有，`engines.node >= 22.13.0`，`npm test` → `test/run-ci.js` |
| 测试文件 | 181 | 188 |
| 测试运行方式 | 直接 `node --test` | 自写逐文件 runner（Windows 不接受目录参数），带基线差分 |
| GitHub Actions | 仅 `.github/workflows/build-win.yml` | `build-win.yml` + 自建 `test.yml`（4 job：node-tests 22.14 / powershell-check 5.1+7 / node-version-floor 22.13） |
| CI 权限 | 见 `build-win.yml` | `permissions: contents: read` |
| 安装器 | **已有完整独立安装**：`install-win.ps1`（装到 `%LOCALAPPDATA%\Programs\WorkDaddy`，数据在 `%APPDATA%\WorkDaddy`，多 profile 端口 47832–47835）、`make-setup.cmd`（IExpress 自解压 Setup）、`apply-update.ps1`、`build-win-*` | 只有 `deploy.ps1`（补丁覆盖到 WorkBuddy 安装目录）+ 上游那套原封保留 |

**这是阶段 4 的关键发现**：上游本来就有独立安装、多 profile、自动更新、Setup 打包。迁移不需要从零写安装器，需要做的是「以上游安装器为底座 + 补我们的安全闸门与旧补丁版迁移」。

## 6. 历史与来源判定

- 分叉 28 个提交全部可追溯到 `fb9f8db`，没有「来历不明的整文件覆盖」：`daemon.js`/`inject.js`/`lib.js`/`win-launcher.js` 都是 1.2.20 + 有据可查的补丁。
- 因此阶段 2 的核心文件合并策略可以定为：**上游 1.2.22 完整实现 + 分叉补丁逐块重放**，而不是「猜上游原版」。
- 剩余无法判定来源的只有 §4.2 两个 `session-pin-sync` 文件，迁移方式标记 `hold-for-review`。

## 7. 本阶段结论

1. 两侧**有**共同祖先 `fb9f8db`，可用正常三方合并；`--allow-unrelated-histories` 不适用也不需要。
2. 需要人工决策的文件只有 5 个 E 类 + 2 个 G 类，其余 398 个路径的迁移方式可以机械确定。
3. 可以继续阶段 2；但 `session-pin-sync.js` 必须先定主实现（本条作为进入阶段 3 的门槛，不阻塞阶段 2 的合并本身）。
4. `upstream.json` 的上游基线必须从 1.2.22 改回 1.2.20，否则代际闸门会持续误判。
