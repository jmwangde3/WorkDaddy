# 阶段 0 安全基线（只读检查记录）

执行时间：2026-11-14
执行方式：只读 git / gh 命令，未切换、未覆盖、未删除任何东西。

## 1. 检查项与实测输出

```
$ git rev-parse --abbrev-ref HEAD
fix/workdaddy-data-permission-hardening

$ git rev-parse HEAD
33d0e66f60a8ba57a918fd54d3f90c1826390bf7

$ git status --short
（空 —— 工作区干净）

$ git remote -v
origin    https://github.com/jmwangde3/WorkDaddy.git (fetch/push)

$ git branch -vv
* fix/workdaddy-data-permission-hardening 33d0e66 docs(1.3.0): 记录第二轮 CI 结果与本地/CI 数字差异
  main                                    041e3dc [origin/main] fix(permission): 三层补一次追不上写盘 —— 改成四层常驻守卫（1.2.80）

$ git tag -l
1.2.20

$ git ls-remote --heads origin | grep -E 'main|workdaddy-data'
041e3dcb1edeb463b140cf8c69ed9076a427043b  refs/heads/main
33d0e66f60a8ba57a918fd54d3f90c1826390bf7  refs/heads/fix/workdaddy-data-permission-hardening
```

最近一次 CI（GitHub Actions）：

```
$ gh run list --limit 1
completed  success  docs(1.3.0): 记录第二轮 CI 结果与本地/CI 数字差异
           .github/workflows/test.yml  fix/workdaddy-data-permission-hardening  push
           43588619959  2m55s  2026-11-14T11:08:50Z
```

`main` 与功能分支的差异：

```
$ git rev-list --count main..33d0e66   → 13
$ git rev-list --count 33d0e66..main   → 0
$ git diff --stat main..33d0e66 | tail -1
39 files changed, 7143 insertions(+), 1123 deletions(-)
```

即：功能分支比 `main` 多 13 个提交、7143 行新增、1123 行删除，`main` 没有领先提交（快进关系）。

## 2. 结论

- 工作区干净，无未提交修改，不需要建备份分支。
- 未执行 `git reset --hard` / `git clean` / 强推。
- `main` 停在 `041e3dc`，与 `origin/main` 一致，本轮不动。

## 3. 迁移分支

```
$ git switch -c feat/full-fork-migration
Switched to a new branch 'feat/full-fork-migration'

$ git rev-parse HEAD
33d0e66f60a8ba57a918fd54d3f90c1826390bf7
```

- 基于**已审查通过**的 `fix/workdaddy-data-permission-hardening` @ `33d0e66`，不是从 `main` 重开。
- 原始分支 `fix/workdaddy-data-permission-hardening` 保留，未删除、未改写。
- 迁移基线 SHA：`33d0e66`。

## 4. 上游接入

```
$ git remote add upstream https://github.com/babygoton/WorkDaddy.git
$ git fetch upstream --tags
```

上游 HEAD：`9b9bad5`（2026-11-13，`merge: integrate 1.2.22 into main`）。
`upstream` 只配置 fetch 用途，不用于 push。
