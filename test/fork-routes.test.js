'use strict';
/**
 * 分叉路由分发器（src/features/integration/fork-routes.js）的单元测试。
 *
 * 这些接口原来内联在 daemon.js 的 handleApi 里，搬出来时最容易出的错是
 * 「参数名写错 / 状态码反了 / 默认值丢了」。这里用假 ctx 把 7 条路由的行为
 * 逐条钉住，不启守护进程、不连 CDP、不碰数据库。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createForkRoutes, NOT_HANDLED } = require('../src/features/integration/fork-routes');

function harness(overrides = {}) {
  const calls = { setEnabled: [], setDedupe: [], run: [], runDedupe: [], runRollback: [], runBackground: [], inspect: 0 };
  const runner = {
    inspectTransports: () => { calls.inspect += 1; return Promise.resolve({ local: 3 }); },
    status: () => ({ enabled: true, dedupe: false }),
    setEnabled: (v) => { calls.setEnabled.push(v); return { enabled: v }; },
    setDedupe: (on, mode) => { calls.setDedupe.push([on, mode]); return { dedupe: on, mode }; },
    run: async (uid, opts) => { calls.run.push([uid, opts]); return { ok: true, affected: 2 }; },
    runDedupe: async (opts) => { calls.runDedupe.push(opts); return { ok: true, dropped: 1 }; },
    runRollback: async (journal, opts) => { calls.runRollback.push([journal, opts]); return { restored: 1 }; },
    runBackgroundDedupe: async (opts) => { calls.runBackground.push(opts); return { ok: true, applied: 0 }; },
    ...overrides.runner,
  };
  const ctx = {
    getRunner: () => runner,
    readBody: async () => (overrides.body === undefined ? {} : overrides.body),
    json: (res, status, obj) => { res.status = status; res.body = obj; return Promise.resolve(); },
    currentAccount: () => (overrides.account === undefined ? { uid: 'uid-from-account' } : overrides.account),
  };
  const route = createForkRoutes(ctx);
  const send = (method, p) => {
    const res = {};
    const out = route({ method, url: p }, res, p);
    return { out, res };
  };
  return { calls, send };
}

/** 发一个应被接管的请求，等它把响应写完，返回 {res, calls}。 */
async function dispatch(method, p, body, extra = {}) {
  const h = harness({ body, ...extra });
  const { out, res } = h.send(method, p);
  assert.notEqual(out, NOT_HANDLED, `${method} ${p} 必须被接管`);
  await out;
  return { res, calls: h.calls };
}

test('GET /api/rehome/status 返回 transports 与 runner 状态', async () => {
  const { res, calls } = await dispatch('GET', '/api/rehome/status');
  assert.equal(calls.inspect, 1);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.transports, { local: 3 });
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.ok, true);
});

test('POST /api/rehome/config 透传布尔值，缺字段返回 400', async () => {
  const ok = await dispatch('POST', '/api/rehome/config', { enabled: true });
  assert.deepEqual(ok.calls.setEnabled, [true]);
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.body.enabled, true);

  const bad = await dispatch('POST', '/api/rehome/config', { enabled: 'yes' });
  assert.equal(bad.res.status, 400);
  assert.match(bad.res.body.error, /enabled/);
  assert.equal(bad.calls.setEnabled.length, 0);
});

test('POST /api/rehome/run 用 body.uid，缺省回落到当前账号，并透传 dryRun', async () => {
  const withBody = await dispatch('POST', '/api/rehome/run', { uid: 'u1', dryRun: true });
  assert.deepEqual(withBody.calls.run, [['u1', { dryRun: true }]]);
  assert.equal(withBody.res.status, 200);
  assert.equal(withBody.res.body.affected, 2);

  const fallback = await dispatch('POST', '/api/rehome/run', {});
  assert.deepEqual(fallback.calls.run, [['uid-from-account', { dryRun: false }]]);
});

test('POST /api/rehome/run 在 ok===false 时返回 500（不是 200）', async () => {
  const { res } = await dispatch('POST', '/api/rehome/run', { uid: 'u1' }, {
    runner: { run: async () => ({ ok: false, blocked: true, skipped: 'legacy-deleted-at-ambiguous' }) },
  });
  assert.equal(res.status, 500);
  assert.equal(res.body.blocked, true);
});

test('POST /api/rehome/dedupe/config 只接受 exact / containment', async () => {
  const c = await dispatch('POST', '/api/rehome/dedupe/config', { dedupe: true, mode: 'containment' });
  assert.deepEqual(c.calls.setDedupe, [[true, 'containment']]);

  const bad = await dispatch('POST', '/api/rehome/dedupe/config', { dedupe: true, mode: 'aggressive' });
  assert.deepEqual(bad.calls.setDedupe, [[true, 'exact']], '非法 mode 必须退回 exact，而不是透传');
});

test('POST /api/rehome/dedupe 支持 aggressive 别名，ok===false 映射 409', async () => {
  const a = await dispatch('POST', '/api/rehome/dedupe', { aggressive: true, force: true });
  assert.equal(a.calls.runDedupe[0].mode, 'containment');
  assert.equal(a.calls.runDedupe[0].force, true);
  assert.equal(a.calls.runDedupe[0].dryRun, false);

  const conflict = await dispatch('POST', '/api/rehome/dedupe', {}, {
    runner: { runDedupe: async () => ({ ok: false, error: 'busy' }) },
  });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.res.body.ok, false);
});

test('POST /api/rehome/dedupe/rollback 缺 journal 返回 400，有则透传', async () => {
  const bad = await dispatch('POST', '/api/rehome/dedupe/rollback', {});
  assert.equal(bad.res.status, 400);
  assert.match(bad.res.body.error, /操作日志/);

  const ok = await dispatch('POST', '/api/rehome/dedupe/rollback', { journal: '/tmp/op.json', dryRun: true });
  assert.deepEqual(ok.calls.runRollback, [['/tmp/op.json', { dryRun: true }]]);
  assert.equal(ok.res.status, 200);
});

test('POST /api/rehome/dedupe/background 默认只读，写入需双开关', async () => {
  const def = await dispatch('POST', '/api/rehome/dedupe/background', {});
  assert.equal(def.calls.runBackground[0].dryRun, true);
  assert.equal(def.calls.runBackground[0].allowBackground, false);
  assert.equal(def.calls.runBackground[0].apply, false);

  const write = await dispatch('POST', '/api/rehome/dedupe/background', {
    dryRun: false, allowBackground: true, apply: true, mode: 'containment',
  });
  assert.equal(write.calls.runBackground[0].dryRun, false);
  assert.equal(write.calls.runBackground[0].allowBackground, true);
  assert.equal(write.calls.runBackground[0].apply, true);
  assert.equal(write.calls.runBackground[0].mode, 'containment');
});

test('未知路径与错误方法原样交回 daemon（NOT_HANDLED）', () => {
  const h = harness();
  assert.equal(h.send('GET', '/api/rehome/run').out, NOT_HANDLED, 'GET 不该命中 POST 路由');
  assert.equal(h.send('POST', '/api/rehome/status').out, NOT_HANDLED);
  assert.equal(h.send('GET', '/api/accounts').out, NOT_HANDLED);
  assert.equal(h.send('GET', '/api/permission/status').out, NOT_HANDLED, '权限路由尚未搬出，必须交回 daemon');
  assert.equal(h.calls.inspect, 0, '未命中的请求不得产生副作用');
});
