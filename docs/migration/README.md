# 迁移文档索引

按阶段排列。想快速判断「这次迁移到底改了什么、凭什么认为没改坏」，看第 2 和第 6 行即可。

| 文档 | 内容 | 什么时候看 |
| --- | --- | --- |
| [`00-baseline.md`](00-baseline.md) | 阶段 0 只读检查全量输出：分支、HEAD、工作区、本地/远程分支、最近提交、tag、CI、未提交修改 | 怀疑「起点到底干不干净」时 |
| [`01-repository-inventory.md`](01-repository-inventory.md) | 仓库身份、**基线纠正**（旧结论「无共同祖先」是错的，实测 merge-base = `fb9f8db`）、A–G 逐类明细、CI/工具链对比 | 想理解两个仓库的真实关系 |
| [`01-file-diff.csv`](01-file-diff.csv) | 405 个路径的逐文件分类（19 列：状态、方法、风险、测试要求…） | 逐文件对账 |
| [`01-inventory.json`](01-inventory.json) | 上面 CSV 的机读版 | 写脚本统计 |
| [`01-feature-matrix.md`](01-feature-matrix.md) | 上游 19 项 + 分叉 11 项功能清单与五种状态；唯一重叠功能 `session-pin-sync` 的逐函数行为比对 | 想确认某个功能还在不在 |
| [`01-risk-register.md`](01-risk-register.md) | R1–R16 风险与处置，其中 3 项需人工决策 | 审查前必看 |
| [`02-full-fork-import.md`](02-full-fork-import.md) | 历史策略、5 个提交的分工、7 个核心文件的处理方式、验证证据 | 判断合并是否「真合并」 |
| [`02-source-provenance.md`](02-source-provenance.md) | BASE/FORK/UP/NOW 四方 blob 台账 + 复核命令 | 追某一行代码的来源 |
| [`04-installer.md`](04-installer.md) | 安装 / 更新 / 卸载的设计、退出码、数据位置、测试证据、已知缺口 | 用或改安装器 |
| [`07-ci-release.md`](07-ci-release.md) | 九类 CI 检查的落点、打包产物实测、发布前人工清单 | 想发版前 |
| [`08-release-decisions.md`](08-release-decisions.md) | **发布前稳定性收尾**：更新/安装事务完整性（含故障注入）、Setup 真机验证边界、托盘可复现构建、三项架构决策、两条环境失败的根因 | 发版前最后一关；想知道「哪些是真验证过、哪些没有」 |

配套：

- 上游同步流程：[`../upstream-tracking.md`](../upstream-tracking.md)
- 模块边界与「为什么这些没搬」：[`../../src/features/README.md`](../../src/features/README.md)
- 本 fork 相对上游的改动：[`../../CHANGELOG.md`](../../CHANGELOG.md)
- 上游原版说明：[`../../README_UPSTREAM.md`](../../README_UPSTREAM.md)

## 复核用的三条命令

```bash
# 1. 祖先关系（结论错了，后面全错）
git merge-base HEAD upstream/main

# 2. 逐文件分类（只读，产出 CSV/JSON 到指定目录）
node tools/migration/inventory.js --fork HEAD --upstream upstream/main --out docs/migration

# 3. 全量回归（只对新增失败报警）
node test/run-ci.js
```
