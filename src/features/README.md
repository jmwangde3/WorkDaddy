# src/features —— 分叉增强功能的模块边界

这个目录只放**本 fork 新增**的能力，上游代码继续留在 `scripts/`。
目的很直接：把「分叉对上游文件的改动」压到最少，让 `git merge upstream/main`
的冲突面持续缩小。

## 现状

```
src/features/
  integration/
    not-handled.js     路由处理器共用的哨兵（Symbol，不会被 undefined/false 混淆）
    fork-routes.js     分叉接口的统一分发入口
  sessions/
    takeover/
      routes.js        /api/rehome/status | config | run                （3 条）
    dedupe/
      routes.js        /api/rehome/dedupe/config | dedupe | rollback | background（4 条）
```

`scripts/daemon.js` 里现在只剩：

```js
const routed = handleForkRoutes(req, res, p);
if (routed !== FORK_NOT_HANDLED) return routed;
```

改动前这 7 条接口是 62 行内联 `if` 链，现在是 1 行分发。

依赖通过 `ctx` 注入（`getRunner` / `readBody` / `json` / `currentAccount`），
模块自己不 `require` daemon —— 否则就是循环依赖，也没法单测。
单测见 `test/fork-routes.test.js`（9 条，覆盖状态码、默认值、非法入参、未命中）。

## 还没搬的部分，以及为什么

| 代码 | 位置 | 阻塞原因 | 建议顺序 |
|---|---|---|---|
| 5 条 `/api/permission/*` 路由 | `daemon.js` handleApi | 路由体直接读写 `preferenceGuard` 这个**可变模块级变量**（启动/停止定时器），还依赖 `applyPermissionLayers`、`cdpReadyForPermission`。要搬必须先决定「谁持有守卫句柄」 | 先给 permission-sync 加 `createGuardController()` 返回句柄对象，再搬路由 |
| `schedulePermissionSync` / `startPermissionPreferenceGuard` | `daemon.js` | 与切号流程、CDP 连接状态强耦合 | 与上一条一起做 |
| `getRehomeRunner`（懒初始化） | `daemon.js` | 依赖 `PROFILE` / `DATA_DIR` / `log` 在 daemon 里初始化 | 引入 `createRuntimeContext()` 后再搬 |
| 启动 6s reconcile | `daemon.js` startServer | 依赖 server 启动时序 | 保持现状（本来就只有 3 行） |
| `rehome-sessions.js` / `session-dedupe.js` / `session-scope.js` / `permission-sync.js` | `scripts/` | 上游没有同名文件，移动它们**不减少任何冲突**，却要让 6 个测试文件改路径 | 低优先级；等上面三项完成后统一搬进 `sessions/{takeover,dedupe,audit}`、`permissions/` |

结论：模块化的收益来自「减少与上游重叠的代码」，不是「目录长得像目标结构」。
在上游没有对应文件的地方搬目录，属于纯成本。

## 约束

1. `src/` 下不得 `require('../../scripts/daemon.js')`，也不得 `require` 会反过来
   `require` 自己的模块（避免循环依赖）。
2. 每个新增模块必须有独立单测，且测试不得启动守护进程、不得连 CDP、不得碰真实数据库。
3. 路由层只做「解析入参 → 调 runner → 映射状态码」，业务逻辑留在 `scripts/` 的
   runner 里；否则搬出来的只是把复杂度换了个地方。
4. 接口契约（路径、方法、状态码）改动必须在 `docs/` 里记录，因为注入层的 UI
   直接依赖这些路径。
