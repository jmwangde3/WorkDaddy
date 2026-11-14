'use strict';
/**
 * 分叉新增接口的统一分发入口。
 *
 * daemon.js 的 handleApi 里只留一行：
 *     const routed = forkRoute(req, res, p);
 *     if (routed !== NOT_HANDLED) return routed;
 *
 * 目的：把「分叉对 daemon.js 的改动」压缩成一行，而不是几十行内联路由。
 * 以后 `git merge upstream/main` 时，冲突只可能落在那一行上。
 *
 * 顺序有意义：takeover 与 dedupe 的路径前缀相同但具体路径不同，命中即返回。
 */
const { NOT_HANDLED } = require('./not-handled.js');
const { createTakeoverRoutes } = require('../sessions/takeover/routes.js');
const { createDedupeRoutes } = require('../sessions/dedupe/routes.js');

function createForkRoutes(ctx = {}) {
  const handlers = [createTakeoverRoutes(ctx), createDedupeRoutes(ctx)];
  return function forkRoute(req, res, p) {
    for (const handle of handlers) {
      const result = handle(req, res, p);
      if (result !== NOT_HANDLED) return result;
    }
    return NOT_HANDLED;
  };
}

module.exports = { createForkRoutes, NOT_HANDLED };
