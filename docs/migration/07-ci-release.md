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
| 5 | 更新回滚 | 同上（坏包 → 回滚 → 字节级还原断言） | 否 |
| 6 | 上游兼容 / 同步结构契约 | `node-tests` 里的 `fork-sync-contract.test.js` | 否 |
| 7 | 产物检查 | `package` → `test/package-hygiene.test.js` 真打一次包 | 否 |
| 8 | 依赖与供应链 | `supply-chain`（零依赖断言 + engines 核对） | 否 |
| 9 | 安装包内容 | 同 7：断言 zip 里没有 test/docs/tools/.git/workbuddy-exe.json/日志 | 否 |

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
| `SHA256SUMS.txt` | 上面两个包的哈希，报告里也有一份 | ✅ |
| `WorkDaddy-1.3.0-setup.exe` | `-Setup` + 找到 `ISCC.exe` 时才产出 | ⚠ 未验证（本机无 Inno Setup 6） |

Setup 的设计是**引导器而不是第二套安装逻辑**：解便携包到临时目录 → 调
`install-workdaddy.ps1` → 卸载时调 `uninstall-workdaddy.ps1`（脚本随包落在 `{app}\_setup`）。
这样安装逻辑只有一份，Setup 不会和脚本各自漂移。

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
# 文件 193 / 用例 1700+ / 新增失败 0 / 历史失败 49
```

## 5. 发布前人工清单（还没做，也不会自动做）

1. 在**装有 Inno Setup 6** 的机器上 `installer\build-package.ps1 -Setup`，实测安装 → 卸载 → 数据保留。
2. 在一台**没有装过** WorkDaddy 的机器上跑便携包与安装器。
3. 在一台**装过旧补丁版**的机器上验证配置迁移（`legacy-import`）。
4. 人工打 tag（`v1.3.0`）并触发 `build-win.yml`；本分支不合 main、不打 tag、不发 Release。
5. 发布说明里必须写明：个人改版、AGPL-3.0、与 WorkBuddy 官方无关、数据位置与卸载方式。
