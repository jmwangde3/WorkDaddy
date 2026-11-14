# 上游同步流程

> 这份文档定义「上游发了新版本，我们怎么安全地把改动并进来」。
> 核心原则：**同步是人工审查后的合并，不是自动 merge。** 任何一步出问题都可以停在原地，不会把仓库带进不可回退的状态。

## 1. 当前状态快照

| 项 | 值 | 怎么来的 |
| --- | --- | --- |
| Fork 版本 | `1.3.0` | `scripts/daemon.js` 的 `DAEMON_VERSION` |
| Fork 分叉点（BASE） | `fb9f8db` = 上游 1.2.20 | `git merge-base HEAD upstream/main` |
| 已并入的上游最新提交 | `9b9bad5` = 上游 1.2.22 | 双父合并提交 `42e517e` |
| 上游仓库 | `https://github.com/babygoton/WorkDaddy` | remote `upstream` |
| 上游版本声明方式 | 提交信息（`merge: integrate 1.2.22 into main`），**不是 tag** | 见 `scripts/upstream.json` 的 `versionSource` |

BASE 是上游祖先（`git merge-base --is-ancestor fb9f8db upstream/main` 成立），
所以每次同步都是正常的三方合并，**不需要** `--allow-unrelated-histories`。

## 2. 三方关系

```
        fb9f8db (1.2.20)          ← BASE：共同祖先
        /            \
   FORK 33d0e66      9b9bad5 (1.2.22)   ← UP：上游 HEAD
   (分叉补丁)              |
        \               /
        42e517e (合并提交，双父)
              |
        当前 HEAD
```

分类判定一律基于这三棵树逐路径比 blob sha，不用「看文件名猜」：

| 类 | 含义 | 处理 |
| --- | --- | --- |
| A | 上游未改，Fork 未改 | 跟随上游 |
| B | 仅 Fork 改 | 保留 Fork |
| C | Fork 新增 | 保留，检查是否与上游新文件重名 |
| D | Fork 删除 | 逐个人工确认（可能是上游该删的） |
| E | 同名但实现不同 | **逐函数比对**，不能整文件覆盖 |
| F | 上游新增，Fork 缺失 | 全部引入 |
| G | 无法判定 | 停下来问，不猜 |

## 3. 同步流程（九步）

```bash
# 0. 分支与洁净检查：工作区不干净不许开始
git status --short
git switch -c sync/upstream-<版本> feat/full-fork-migration

# 1. 取上游最新（只 fetch，不 merge）
git fetch upstream --tags --prune
git log --oneline -30 upstream/main

# 2. 盘点：三树分类，产出可审查的 CSV / JSON
node tools/migration/inventory.js \
  --base $(git merge-base HEAD upstream/main) \
  --fork HEAD --upstream upstream/main \
  --out docs/migration/sync-<版本>
#    → 生成 01-file-diff.csv（逐路径 A–G 分类）与 01-inventory.json（机读）

# 3. 看风险项：high 风险的（E/G 类与四个核心文件）逐条写处理方案再动手。
#    风险清单是人工写的（本轮样例：docs/migration/01-risk-register.md），工具只给分类。

# 4. 试合并（不提交；冲突就地停下）
git merge --no-commit --no-ff upstream/main

# 5. 逐文件解决冲突（见 §4），禁止 git checkout --ours/--theirs . 批量操作

# 6. 逐功能提交：一个功能一个 commit，每个 commit 自带回归测试

# 7. 全量回归
node test/run-ci.js            # 必须「新增失败 0」

# 8. 更新哈希台账（见 §5），并让 deploy 闸门重新可用

# 9. 推送独立分支，等审查；不合并 main、不打 tag、不发 Release
git push -u origin sync/upstream-<版本>
```

## 4. 冲突处理规则

| 文件类型 | 规则 |
| --- | --- |
| 四个核心文件（`daemon.js` `inject.js` `lib.js` `win-launcher.js`） | **上游完整实现 + Fork 功能性修改**。禁止整文件覆盖上游，也禁止整文件保留 Fork |
| Fork 独有文件（`rehome-*.js` `session-dedupe.js` `session-scope.js` `permission-sync.js`） | 上游没有同名文件 → 保留；若上游新增了同名不同实现 → 按「E 类」逐函数比对 |
| `src/features/**` | Fork 自有模块，上游不存在，直接保留 |
| 测试 | 两套都留。上游测试用例一条都不能删；Fork 测试与上游同名时改名保留（先例：`session-pin-sync-queue.test.js`） |
| 文档 | README 类按 Fork 版本重写（要说明是个人改版）；其余跟随上游 |
| CI / 构建脚本 | 以上游为基础，叠加 Fork 新增的检查项 |

冲突里最容易出错的是「上游把某段代码删了，而 Fork 在同一位置加过东西」。
这类冲突必须读懂上游为什么删，不允许用「保留 Fork 侧」蒙过去。

## 5. 哈希台账维护（`scripts/upstream.json`）

`deploy.ps1` 的代际闸门靠这张表判断「目标文件是不是原版上游」：

- `upstreamFileHashes`：**主表**，对应 BASE 代际（1.2.20）。
- `upstreamFileHashesByVersion`：按版本分组的历史代际（1.2.20 / 1.2.22）。
- `localFileHashes`：Fork 侧当前哈希；改了核心文件就必须重算，否则 `test/deploy-safety.test.js` 会失败。

重算方法（无第三方依赖）：

```bash
node -e "const c=require('crypto'),f=require('fs');for(const n of ['daemon.js','inject.js','lib.js','win-launcher.js']){const b=f.readFileSync('scripts/'+n);console.log(n,c.createHash('sha256').update(b).digest('hex'),b.length)}"
```

上游每发一个版本，取三个数据补进 `upstreamFileHashesByVersion`：
该版本四个文件的 `sha256`、`size`、代际名。**不要删除旧代际** —— 用户可能从任意老版本升级上来。

## 6. 定期检查机制

`.github/workflows/upstream-watch.yml`：每周一 03:00 UTC 拉一次上游，
有新提交就**只开 issue**（附提交列表与需要重跑的盘点命令），不建 PR、不合并、不打 tag。

这条工作流没有任何写权限，`permissions: contents: read` + `issues: write`。

## 7. 复盘：本轮实际执行过的命令

```bash
git merge-base HEAD upstream/main
# fb9f8dbc75db7acb501c72d276acf066a18350b1  → 1.2.20，推翻了「无共同祖先」的旧结论

node tools/migration/inventory.js --base fb9f8db --fork 33d0e66 --upstream 9b9bad5
# A 308 / B 8 / C 38 / D 0 / E 5 / F 44 / G 2，high 风险 42

git merge --no-commit --no-ff upstream/main      # 冲突只在 daemon.js 的版本常量块
git apply --3way <(git diff fb9f8db 33d0e66 -- scripts/daemon.js)   # 重放分叉补丁，仅 1 处冲突
```

结论：**分叉补丁可以重放，不需要手工重写**。下次同步用同样的两段式（先合上游、再重放分叉 diff），
每一步都小到能审。

## 8. 禁止事项

- 不自动合并上游（`git merge` 必须人工发起并在本地跑完回归）。
- 不用 `--ours` / `--theirs` 批量解决冲突。
- 不在 `main` 上开发、不改 `main`、不强推、不 `reset --hard`、不 `clean -fd`。
- 不因为「上游没这个功能」就删掉 Fork 的测试或降低断言。
- 不自动打 tag、不发 Release。
- 同步分支合不进来时保持分支存在，等人工判断；不删分支灭迹。
