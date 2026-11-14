'use strict';
/**
 * 会话归属接管（takeover / rehome）的 HTTP 路由。
 *
 * 从 scripts/daemon.js 的 handleApi 里整块搬出来，逻辑逐行照搬，唯一变化是依赖
 * 通过 ctx 注入。daemon.js 只保留一行分发 —— 这样以后同步上游时，冲突面从
 * 「几十行路由代码」缩到「一行调用」。
 *
 * 依赖（由 daemon 注入，模块自己不 require daemon，避免循环依赖）：
 *   getRunner()      → rehome runner（懒初始化在 daemon 里，因为要等 PROFILE/DATA_DIR）
 *   readBody(req)    → Promise<body>
 *   json(res,s,obj)  → 写响应
 *   currentAccount() → 当前账号快照
 */
const { NOT_HANDLED } = require('../../integration/not-handled.js');

function createTakeoverRoutes(ctx = {}) {
  const getRunner = ctx.getRunner;
  const readBody = ctx.readBody;
  const json = ctx.json;
  const currentAccount = ctx.currentAccount || (() => null);

  return function handleTakeoverRoutes(req, res, p) {
    if (req.method === 'GET' && p === '/api/rehome/status') {
      return Promise.resolve(getRunner().inspectTransports())
        .catch(() => null)
        .then((transports) => json(res, 200, { ok: true, ...getRunner().status(), transports }));
    }

    if (req.method === 'POST' && p === '/api/rehome/config') {
      return readBody(req).then((body) => {
        if (!body || typeof body.enabled !== 'boolean') return json(res, 400, { ok: false, error: '缺少 enabled 布尔值' });
        return json(res, 200, { ok: true, ...getRunner().setEnabled(body.enabled) });
      }).catch((error) => json(res, 400, { ok: false, error: error.message }));
    }

    if (req.method === 'POST' && p === '/api/rehome/run') {
      return readBody(req).then(async (body) => {
        const payload = body || {};
        const uid = String(payload.uid || (currentAccount() || {}).uid || '').trim();
        const result = await getRunner().run(uid, { dryRun: !!payload.dryRun });
        return json(res, result.ok === false ? 500 : 200, result);
      }).catch((error) => json(res, 400, { ok: false, error: error.message }));
    }

    return NOT_HANDLED;
  };
}

module.exports = { createTakeoverRoutes };
