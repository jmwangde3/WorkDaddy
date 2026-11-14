'use strict';
/**
 * 会话去重（dedupe）的 HTTP 路由。
 *
 * 四个接口都落在 runner 上：开关、执行、回滚、后台任务隔离。
 * 从 daemon.js 原样搬出，依赖用 ctx 注入，理由同 takeover/routes.js。
 */
const { NOT_HANDLED } = require('../../integration/not-handled.js');

function createDedupeRoutes(ctx = {}) {
  const getRunner = ctx.getRunner;
  const readBody = ctx.readBody;
  const json = ctx.json;

  return function handleDedupeRoutes(req, res, p) {
    // 去重开关：默认关闭，必须显式打开；mode 只能是 exact / containment。
    if (req.method === 'POST' && p === '/api/rehome/dedupe/config') {
      return readBody(req).then((body) => {
        if (!body || typeof body.dedupe !== 'boolean') return json(res, 400, { ok: false, error: '缺少 dedupe 布尔值' });
        const mode = body.mode === 'containment' ? 'containment' : 'exact';
        return json(res, 200, { ok: true, ...getRunner().setDedupe(body.dedupe, mode) });
      }).catch((error) => json(res, 400, { ok: false, error: error.message }));
    }

    if (req.method === 'POST' && p === '/api/rehome/dedupe') {
      return readBody(req).then(async (body) => {
        const payload = body || {};
        const result = await getRunner().runDedupe({
          dryRun: !!payload.dryRun,
          mode: payload.mode === 'containment' || payload.aggressive === true ? 'containment' : 'exact',
          force: payload.force === true,
        });
        return json(res, result.ok === false ? 409 : 200, { ok: result.ok !== false, ...result });
      }).catch((error) => json(res, 400, { ok: false, error: error.message }));
    }

    if (req.method === 'POST' && p === '/api/rehome/dedupe/rollback') {
      return readBody(req).then(async (body) => {
        const journal = String((body && body.journal) || '').trim();
        if (!journal) return json(res, 400, { ok: false, error: '缺少操作日志路径' });
        const result = await getRunner().runRollback(journal, { dryRun: !!(body && body.dryRun) });
        return json(res, 200, { ok: true, ...result });
      }).catch((error) => json(res, 400, { ok: false, error: error.message }));
    }

    if (req.method === 'POST' && p === '/api/rehome/dedupe/background') {
      return readBody(req).then(async (body) => {
        const payload = body || {};
        // 后台任务隔离：默认只读；写入必须同时给 allowBackground 与 apply。
        const result = await getRunner().runBackgroundDedupe({
          dryRun: payload.dryRun !== false,
          allowBackground: payload.allowBackground === true,
          apply: payload.apply === true,
          mode: payload.mode === 'containment' || payload.aggressive === true ? 'containment' : 'exact',
          force: payload.force === true,
        });
        return json(res, result.ok === false ? 409 : 200, { ok: result.ok !== false, ...result });
      }).catch((error) => json(res, 400, { ok: false, error: error.message }));
    }

    return NOT_HANDLED;
  };
}

module.exports = { createDedupeRoutes };
