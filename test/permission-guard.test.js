'use strict';
/**
 * 权限守卫三开关回归测试（P0）
 *
 *   node --test test/permission-guard.test.js
 *
 * 关键约束：
 *   - A / B / C 默认全关，互相不能隐式启用；
 *   - C（执行期自动批准）不实现，且页面脚本里不得出现任何 click；
 *   - stopPermissionGuards / --off 真正停掉定时器并持久化关闭；
 *   - 关闭后重新连接 / 重新加载页面不会重新装上守卫；
 *   - 重复 stop 幂等。
 *
 * 用临时 APPDATA 隔离状态文件，不读写真实 WorkDaddy 配置。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const perm = require('../scripts/permission-sync.js');

const tmpRoots = [];
function tempAppData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-perm-'));
  tmpRoots.push(d);
  process.env.APPDATA = d;
  process.env.WORKDADDY_DATA = d;
  return d;
}

function fakeSend() {
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      return { result: { value: { ok: true, status: 'sandbox' } } };
    }
    return { identifier: 'legacy-script-1' };
  };
  send.calls = calls;
  return send;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可编排页面返回值的假 CDP 发送器。 */
function fakePageSend(payload) {
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') return { result: { value: payload } };
    return { identifier: 'stub' };
  };
  send.calls = calls;
  return send;
}

async function main() {
  const step = (n) => { if (process.env.WD_TEST_TRACE) console.error(`[step] ${n}`); };
  step('boot');
  // ---- 1. 默认全关 ----
  tempAppData();
  let cfg = perm.readGuardConfig();
  assert.equal(cfg.preferenceGuard, false, 'A 默认关闭');
  assert.equal(cfg.configRepair, false, 'B 默认关闭');
  assert.equal(cfg.autoApprove, false, 'C 默认关闭');

  let status = await perm.getPermissionStatus();
  assert.equal(status.preferenceGuardEnabled, false);
  assert.equal(status.rendererGuardEnabled, false);
  assert.equal(status.autoApproveEnabled, false);
  assert.equal(status.activeTimerCount, 0);
  assert.deepEqual(status.registeredScriptIds, []);

  // 默认状态下启动偏好守卫是空操作（不产生定时器）
  let guard = perm.startPreferenceGuard({ dataRoot: path.join(process.env.APPDATA, 'wb'), intervalMs: 10 });
  await sleep(60);
  assert.equal((await perm.getPermissionStatus()).activeTimerCount, 0, '开关 A 关闭时不得启动定时器');
  assert.equal(guard.stats().running, false);
  guard.stop();

  // ---- 2. 单独开 A 不影响 B/C ----
  perm.setGuardSwitch('preferenceGuard', true);
  cfg = perm.readGuardConfig();
  assert.equal(cfg.preferenceGuard, true);
  assert.equal(cfg.configRepair, false, '开 A 不得隐式开 B');
  assert.equal(cfg.autoApprove, false, '开 A 不得隐式开 C');

  const dataRoot = path.join(process.env.APPDATA, 'wb');
  const uid = 'aaaaaaaa-1111-1111-1111-111111111111';
  const prefFile = perm.userPreferencePath(dataRoot, uid);
  fs.mkdirSync(path.dirname(prefFile), { recursive: true });
  fs.writeFileSync(prefFile, JSON.stringify({ localTaskPermissionMode: 'default-sandbox' }));

  guard = perm.startPreferenceGuard({ dataRoot, intervalMs: 800 });
  guard.check();                       // 直接触发一次，避免依赖定时器时序
  await sleep(20);
  assert.equal(JSON.parse(fs.readFileSync(prefFile, 'utf8')).localTaskPermissionMode, 'full-access', 'A 打开后还原偏好');
  assert.equal((await perm.getPermissionStatus()).activeTimerCount, 1, 'A 启动后有且仅有 1 个定时器');
  guard.stop();
  assert.equal((await perm.getPermissionStatus()).activeTimerCount, 0, 'stop 只清自己的定时器');

  // ---- 3. 单独开 B 不影响 A/C ----
  perm.setGuardSwitch('preferenceGuard', false);
  perm.setGuardSwitch('configRepair', true);
  cfg = perm.readGuardConfig();
  assert.equal(cfg.configRepair, true);
  assert.equal(cfg.preferenceGuard, false, '开 B 不得隐式开 A');
  assert.equal(cfg.autoApprove, false, '开 B 不得隐式开 C');
  await sleep(60);
  assert.equal((await perm.getPermissionStatus()).activeTimerCount, 0, 'B 是切号时的动作，不常驻定时器');

  // ---- 4. C 拒绝开启，页面脚本不含任何点击 ----
  assert.throws(() => perm.setGuardSwitch('autoApprove', true), /autoApprove/);
  const probe = perm.buildRendererScript();
  assert.equal(/\.click\s*\(/.test(probe), false, '页面探针不得包含 click');
  assert.equal(/允许完全访问/.test(probe), false, '页面探针不得出现授权按钮文案');
  assert.equal(/checkbox/i.test(probe), false, '页面探针不得勾选复选框');

  const send = fakeSend();
  const installed = await perm.installRendererGuard(send);
  assert.equal(installed.disabledByPolicy, true);
  const added = send.calls.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(added.length, 0, '不得注册自动执行的新文档脚本');
  const clicked = send.calls.filter((c) => /\.click\s*\(/.test(String(c.params && c.params.expression || '')));
  assert.equal(clicked.length, 0, '不得向页面注入点击逻辑');

  // ---- 5. --off 真正全停（定时器 + 页面守卫 + 持久化）----
  perm.setGuardSwitch('preferenceGuard', true);
  perm.setGuardSwitch('configRepair', true);
  guard = perm.startPreferenceGuard({ dataRoot, intervalMs: 800 });
  await sleep(20);
  assert.equal((await perm.getPermissionStatus()).activeTimerCount, 1);

  const offSend = fakeSend();
  const stopped = await perm.stopPermissionGuards({ send: offSend, log: null });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.timersStopped, 1);
  assert.ok(offSend.calls.some((c) => c.method === 'Runtime.evaluate'), '必须向页面发停止指令');
  const afterOff = await perm.getPermissionStatus();
  assert.equal(afterOff.preferenceGuardEnabled, false);
  assert.equal(afterOff.configRepairEnabled, false);
  assert.equal(afterOff.autoApproveEnabled, false);
  assert.equal(afterOff.activeTimerCount, 0);
  assert.equal(afterOff.stopped, true);

  // ---- 5b. 页面残留：定时器 / observer / listener / 全局对象都要清 ----
  const legacyPage = fakePageSend({ found: true, timer: true, globals: 2, observers: 1, listeners: 1 });
  const legacyStop = await perm.stopPermissionGuards({ send: legacyPage });
  assert.equal(legacyStop.pageStopped, true, '检测到旧守卫要报 pageStopped');
  assert.equal(legacyStop.globalsRemoved, 2, '要删掉残留全局对象');
  assert.equal(legacyStop.observersDisconnected, 1, '要断开 MutationObserver');
  assert.equal(legacyStop.listenersRemoved, 1, '要移除登记过的监听器');
  assert.equal(legacyStop.needsReload, true, '旧守卫存在时必须提示「结构未知，建议重载」');
  const teardownExpr = String((legacyPage.calls.find((c) => c.method === 'Runtime.evaluate') || {}).params?.expression || '');
  assert.ok(/removeEventListener/.test(teardownExpr), '拆除脚本必须显式 removeEventListener');
  assert.ok(/disconnect/.test(teardownExpr), '拆除脚本必须 disconnect observer');
  assert.equal(/\.click\s*\(/.test(teardownExpr), false, '拆除脚本不得包含任何点击');

  const reloadSend = fakePageSend({ found: true, timer: false, globals: 1, observers: 0, listeners: 0 });
  const withReload = await perm.stopPermissionGuards({ send: reloadSend, reload: true });
  assert.equal(withReload.reloaded, true, 'reload=true 时要用 Page.reload 彻底清监听器');
  assert.ok(reloadSend.calls.some((c) => c.method === 'Page.reload'));

  // ---- 5c. CDP 新文档脚本：内存 + 落盘双登记，重启后仍能删 ----
  perm.rememberScript('target-1', 'script-abc');
  const withScript = await perm.getPermissionStatus();
  assert.equal(withScript.persistedScriptCount, 1, '脚本 identifier 必须落盘');
  assert.ok(withScript.registeredScriptIds.includes('script-abc'));
  const psSend = fakeSend();
  const clearedScripts = await perm.stopPermissionGuards({ send: psSend });
  assert.ok(
    psSend.calls.some((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument' && c.params && c.params.identifier === 'script-abc'),
    'stop 必须删掉落盘登记的脚本'
  );
  assert.ok(clearedScripts.scriptsRemoved >= 1);
  assert.deepEqual(perm.readGuardConfig().registeredScripts, [], '删完要清空落盘清单');

  // ---- 6. 关闭后重新连接 / 重载页面不会恢复守卫 ----
  const reconnect = fakeSend();
  await perm.installRendererGuard(reconnect);
  assert.equal(reconnect.calls.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument').length, 0);
  assert.equal((await perm.getPermissionStatus()).activeTimerCount, 0);
  // 重新启动偏好守卫也不得复活
  fs.writeFileSync(prefFile, JSON.stringify({ localTaskPermissionMode: 'default-sandbox' }));
  const ghost = perm.startPreferenceGuard({ dataRoot, intervalMs: 800 });
  await sleep(80);
  assert.equal((await perm.getPermissionStatus()).activeTimerCount, 0, '关闭后 start 不得复活');
  assert.equal(JSON.parse(fs.readFileSync(prefFile, 'utf8')).localTaskPermissionMode, 'default-sandbox',
    '关闭后不得再写偏好');
  ghost.stop();

  // ---- 7. 重复 stop 幂等 ----
  const again = await perm.stopPermissionGuards({ send: fakeSend() });
  assert.equal(again.ok, true);
  assert.equal(again.timersStopped, 0);
  const third = await perm.stopPermissionGuards({ send: fakeSend() });
  assert.equal(third.ok, true);

  // ---- 8. 持久化：新进程读到仍然是全关（daemon 重启语义）----
  const out = execFileSync(process.execPath, ['-e',
    'const p=require(' + JSON.stringify(path.join(__dirname, '..', 'scripts', 'permission-sync.js')) + ');' +
    'process.stdout.write(JSON.stringify(p.readGuardConfig()))',
  ], { env: { ...process.env, APPDATA: process.env.APPDATA }, encoding: 'utf8' });
  const persisted = JSON.parse(out);
  assert.equal(persisted.preferenceGuard, false);
  assert.equal(persisted.configRepair, false);
  assert.equal(persisted.autoApprove, false);

  // ---- 9. 旧版意图文件迁移为全关 ----
  const legacyRoot = tempAppData();
  const statePath = perm.guardStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ fullAccess: true }));
  const migrated = perm.readGuardConfig();
  assert.equal(migrated.preferenceGuard, false, '旧版 fullAccess=true 不继承为自动守卫');
  assert.equal(migrated.configRepair, false);
  assert.equal(migrated.autoApprove, false);
  assert.ok(fs.existsSync(path.join(legacyRoot, 'WorkDaddy', 'permission-guard.json')) ||
    fs.existsSync(statePath), '迁移结果要落盘');

  // ---- 10. --apply 只改偏好与会话字段，不碰页面 ----
  const applyRoot = tempAppData();
  const dbRoot = path.join(applyRoot, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const { createSessionDb } = require('../scripts/session-db.js');
  const dbPath = path.join(dbRoot, 'workbuddy.db');
  const db = createSessionDb({ dbPath });
  await db.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, updated_at INTEGER, deleted_at INTEGER, permission_mode TEXT, is_background_automation INTEGER)');
  await db.run('INSERT INTO sessions (id,user_id,updated_at,deleted_at,permission_mode,is_background_automation) VALUES (?,?,?,?,?,?)',
    ['s-1', uid, 1, null, 'bypassPermissions', 0]);
  await db.run('INSERT INTO sessions (id,user_id,updated_at,deleted_at,permission_mode,is_background_automation) VALUES (?,?,?,?,?,?)',
    ['s-plan', uid, 2, null, 'plan', 0]);
  await db.run('INSERT INTO sessions (id,user_id,updated_at,deleted_at,permission_mode,is_background_automation) VALUES (?,?,?,?,?,?)',
    ['s-bg', uid, 3, null, 'bypassPermissions', 1]);

  const report = await perm.applyFullAccess({ dataRoot: applyRoot, dbPath, uid });
  assert.equal(report.ok, true);
  assert.equal(report.renderer.status, 'disabled-by-policy', '不碰页面');
  const rows = await db.all('SELECT id, permission_mode FROM sessions ORDER BY id');
  const mode = Object.fromEntries(rows.map((r) => [r.id, r.permission_mode]));
  assert.equal(mode['s-1'], 'fullAccess', '普通会话补齐');
  assert.equal(mode['s-plan'], 'plan', 'plan 模式不动');
  assert.equal(mode['s-bg'], 'bypassPermissions', '后台任务不动');

  console.log('PASS permission-guard.test.js — 三开关默认关闭 / stop 全停 / 无自动点击');
}

main()
  .catch((error) => {
    console.error('FAIL permission-guard.test.js:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const d of tmpRoots) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  });
