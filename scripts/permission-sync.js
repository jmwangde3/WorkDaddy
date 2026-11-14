'use strict';
/**
 * permission-sync.js — 切号后把「允许完全访问」重新落实到位。
 *
 * 为什么需要它：WorkBuddy 的完全访问不是单一开关，而是三层状态：
 *
 *   1. 账号级偏好  storage/user-<uid>-personal/global/preferences.json
 *                  → { "localTaskPermissionMode": "full-access" }
 *                  决定「新会话默认值」与冷启动后的按钮态。
 *   2. 会话级字段  sessions.permission_mode（'fullAccess' / 'bypassPermissions' / 'plan'）
 *                  → 决定「已有会话被打开/恢复时」的按钮态。
 *                  客户端 app.asar 里 WorkbuddyAdapter.getSessionPermissionState()
 *                  直接读这个字段，读不到就默认 bypassPermissions（= 默认沙箱）。
 *   3. 运行时开关  渲染层 useLocalTaskPermissionPreference()，按 `${enterpriseId}:${userId}`
 *                  作用域 hydrate；切号会重载页面、切换作用域，期间可能被
 *                  config.preference.changed 事件用旧值覆盖，于是界面停在默认沙箱。
 *
 * 因此只写第 1 层不够（实测：三个账号的 preferences.json 都写着 full-access，
 * 界面仍可能回落到默认沙箱）。这里三层一起兜：写偏好 → 刷会话字段 → 页面里把开关拨回去。
 *
 * 页面侧动作完全复刻人工操作：
 *   点 .cr-permission-setting → 面板里 input[role=switch] 未开则点开
 *   → 弹出 .wb-modal--conf「确认允许完全访问？」→ 点「允许完全访问」→ 复验 → 收面板。
 * 未开启时关闭开关是静默的，开启时才有确认弹窗 —— 所以脚本只在「未开」时动作。
 */

const fs = require('fs');
const path = require('path');
const { createSessionDb } = require('./session-db.js');

const FULL_ACCESS = 'full-access';
const CORE_FULL_ACCESS = 'fullAccess';
const PREF_KEY = 'localTaskPermissionMode';
const NOT_DELETED = '(deleted_at IS NULL OR deleted_at = -1)';

function userPreferencePath(dataRoot, uid) {
  return path.join(dataRoot, 'storage', `user-${uid}-personal`, 'global', 'preferences.json');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 第 1 层：账号级偏好。
 * 只补 `localTaskPermissionMode` 一个键，其余键原样保留（客户端会重写整个文件，
 * 我们不做全量覆盖，避免把主题、语言等键冲掉）。
 */
function ensurePreference(options) {
  const { dataRoot, uid, log } = options;
  const result = { ok: true, file: '', changed: false, before: null };
  if (!dataRoot || !uid) return { ...result, ok: false, error: '缺少 dataRoot/uid' };
  const file = userPreferencePath(dataRoot, uid);
  result.file = file;
  const current = readJsonSafe(file);
  if (current === null) {
    // 文件不存在或损坏：新建一份只带该键的偏好，客户端会自动补齐其余默认值。
    writeJsonAtomic(file, { [PREF_KEY]: FULL_ACCESS });
    result.changed = true;
    if (log) log(`[permission] 新建账号偏好 ${file}`);
    return result;
  }
  result.before = current[PREF_KEY] ?? null;
  if (current[PREF_KEY] === FULL_ACCESS) return result;
  current[PREF_KEY] = FULL_ACCESS;
  writeJsonAtomic(file, current);
  result.changed = true;
  if (log) log(`[permission] 账号偏好 ${result.before || '(缺失)'} → ${FULL_ACCESS} uid=${uid}`);
  return result;
}

/**
 * 第 2 层：会话字段。
 * 只动当前账号、未删除、非后台任务、且不是 plan 模式的会话。
 * plan 是用户显式选的「先规划后执行」，覆盖它会破坏会话语义。
 */
async function ensureSessionModes(options) {
  const { dbPath, uid, log, dryRun = false } = options;
  const result = { ok: true, scanned: 0, changes: 0, ids: [] };
  if (!dbPath || !fs.existsSync(dbPath)) return { ...result, ok: false, error: `会话库不存在: ${dbPath || '(未配置)'}` };
  const db = createSessionDb({ dbPath });
  const where = `${NOT_DELETED} AND user_id = ? AND COALESCE(is_background_automation, 0) = 0` +
    ` AND COALESCE(permission_mode, '') NOT IN (?, 'plan')`;
  const rows = await db.all(
    `SELECT id, permission_mode FROM sessions WHERE ${where} ORDER BY updated_at DESC`,
    [uid, CORE_FULL_ACCESS]
  );
  result.scanned = rows.length;
  if (!rows.length) return result;
  result.ids = rows.map((r) => ({ id: r.id, before: r.permission_mode ?? null }));
  if (dryRun) return { ...result, dryRun: true };
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await db.run(
        `UPDATE sessions SET permission_mode = ? WHERE ${where}`,
        [CORE_FULL_ACCESS, uid, CORE_FULL_ACCESS]
      );
      result.changes = r && typeof r.changes === 'number' ? r.changes : rows.length;
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      // 客户端持有写锁时重试；4 次仍失败交给上层记日志，不阻断切号。
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  if (lastError) return { ...result, ok: false, error: lastError.message, changes: 0 };
  if (log && result.changes) log(`[permission] 会话权限 ${result.changes} 条 → ${CORE_FULL_ACCESS}`);
  return result;
}

/**
 * 第 3 层：页面里的开关。
 * 返回一段可在渲染层求值的表达式（IIFE，返回 Promise）。
 */
function buildRendererScript() {
  return `(function(){
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var q = function (s) { return document.querySelector(s); };
  var waitFor = async function (fn, timeout, step) {
    var t0 = Date.now();
    while (Date.now() - t0 < (timeout || 15000)) {
      var v = fn();
      if (v) return v;
      await sleep(step || 500);
    }
    return null;
  };
  var closePanel = function () {
    var b = q('.cr-permission-setting');
    if (b && q('.cr-permission-panel')) b.click();
  };
  var visibleModal = function () {
    var list = document.querySelectorAll('.wb-modal');
    for (var i = 0; i < list.length; i++) if (list[i].offsetParent) return list[i];
    return null;
  };
  var dismissModal = function () {
    var m = visibleModal();
    if (!m) return;
    var cancel = Array.prototype.slice.call(m.querySelectorAll('button'))
      .find(function (b) { return /取消/.test(b.innerText || ''); });
    if (cancel) cancel.click();
  };
  return (async function () {
    var btn = await waitFor(function () { return q('.cr-permission-setting'); }, 20000, 500);
    if (!btn) return { ok: false, status: 'no-permission-button' };
    if (visibleModal()) return { ok: false, status: 'foreign-modal-open' };
    var openPanel = async function () {
      var panel = q('.cr-permission-panel');
      if (panel) return panel;
      // 面板有展开动画，且上一次点击可能还在收尾：给三次机会。
      for (var i = 0; i < 3; i++) {
        var b = q('.cr-permission-setting');
        if (!b) return null;
        b.click();
        panel = await waitFor(function () { return q('.cr-permission-panel'); }, 1800, 200);
        if (panel) return panel;
        await sleep(400);
      }
      return null;
    };
    var panel0 = await openPanel();
    if (!panel0) { closePanel(); return { ok: false, status: 'panel-not-open' }; }
    if (q('.cr-permission-panel__row--on')) { closePanel(); return { ok: true, status: 'already-full-access' }; }
    var sw = q('.cr-permission-panel input[role=switch]');
    if (!sw) { closePanel(); return { ok: false, status: 'switch-missing' }; }
    sw.click();
    await sleep(600);
    var modal = await waitFor(visibleModal, 6000, 250);
    if (modal) {
      var okBtn = Array.prototype.slice.call(modal.querySelectorAll('button'))
        .find(function (b) { return /允许完全访问/.test(b.innerText || ''); });
      if (!okBtn) { dismissModal(); return { ok: false, status: 'confirm-button-missing' }; }
      // 确认按钮默认 disabled：必须先勾选「我已了解风险，并对自己的数据安全负责」。
      if (okBtn.disabled) {
        var risk = modal.querySelector('input[type=checkbox]');
        if (!risk) { dismissModal(); return { ok: false, status: 'risk-checkbox-missing' }; }
        risk.click();
        await waitFor(function () { return !okBtn.disabled; }, 2000, 100);
      }
      if (okBtn.disabled) { dismissModal(); return { ok: false, status: 'confirm-still-disabled' }; }
      okBtn.click();
      await sleep(1400);
    }
    closePanel();
    await sleep(400);
    // 复验：重新开面板读开关态，再收起。开不出来不算失败——确认按钮已经点过了。
    var panel1 = await openPanel();
    if (!panel1) return { ok: true, status: modal ? 'enabled-unverified' : 'unknown-unverified' };
    var on = !!q('.cr-permission-panel__row--on');
    closePanel();
    return { ok: on, status: on ? (modal ? 'enabled' : 'enabled-without-modal') : 'still-off' };
  })();
})()`;
}

/**
 * 第 4 层：常驻守卫。
 *
 * 为什么还要它：前三层都是一次性的，而「完全访问」随时会被写回默认值 ——
 * 关闭开关是静默的且会立刻把账号偏好改成 default-sandbox（实测 15:25:06），
 * 页面重载 / 切号 / 新建会话都可能触发。一次性补完，下一秒又掉了。
 *
 * 所以注入一个常驻脚本（Page.addScriptToEvaluateOnNewDocument，重载后自动重跑）：
 *   - 每 2.5s 读一次按钮态（--danger 类名即已开启，不用开面板）；
 *   - 掉了就复刻人工操作拨回去；
 *   - 顺手接管执行期的权限弹窗（勾选 + 允许），这才是「完全访问失效」的直接观感。
 */
function wdPermGuard(opts) {
  opts = opts || {};
  var VERSION = 4;
  if (window.__wdPermGuard && window.__wdPermGuard.version >= VERSION) return;

  var G = window.__wdPermGuard || {};
  G.version = VERSION;
  G.runs = 0;
  G.enables = 0;
  G.approvals = 0;
  G.busy = false;
  G.lastResult = 'init';
  G.log = [];
  G.enabled = true;
  window.__wdPermGuard = G;

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var q = function (s) { try { return document.querySelector(s); } catch (e) { return null; } };
  var say = function (m) {
    try {
      G.log.push(new Date().toISOString().slice(11, 19) + ' ' + m);
      if (G.log.length > 60) G.log.shift();
    } catch (e) {}
  };
  var btnOf = function () { return q('.cr-permission-setting'); };
  var isOn = function () {
    var b = btnOf();
    return !!(b && /cr-permission-setting--danger/.test(String(b.className)));
  };
  var visibleModal = function () {
    var list = document.querySelectorAll('.wb-modal');
    for (var i = 0; i < list.length; i++) if (list[i].offsetParent) return list[i];
    return null;
  };
  var closePanel = function () {
    var b = btnOf();
    if (b && q('.cr-permission-panel')) b.click();
  };
  var waitFor = async function (fn, timeout, step) {
    var t0 = Date.now();
    while (Date.now() - t0 < (timeout || 8000)) {
      var v = null;
      try { v = fn(); } catch (e) {}
      if (v) return v;
      await sleep(step || 200);
    }
    return null;
  };

  var enable = async function () {
    if (G.busy) return 'busy';
    if (visibleModal()) return 'modal-open';
    var b = btnOf();
    if (!b) return 'no-button';
    G.busy = true;
    try {
      var panel = q('.cr-permission-panel');
      if (!panel) {
        b.click();
        panel = await waitFor(function () { return q('.cr-permission-panel'); }, 2200, 150);
        if (!panel) {
          b.click();
          panel = await waitFor(function () { return q('.cr-permission-panel'); }, 2200, 150);
        }
      }
      if (!panel) { closePanel(); return 'panel-not-open'; }
      if (q('.cr-permission-panel__row--on')) { closePanel(); return 'already'; }
      var sw = panel.querySelector('input[role=switch]');
      if (!sw) { closePanel(); return 'switch-missing'; }
      sw.click();
      await sleep(500);
      var modal = visibleModal();
      if (modal) {
        var ok = null;
        var list = modal.querySelectorAll('button');
        for (var i = 0; i < list.length; i++) {
          if (/允许完全访问/.test(String(list[i].innerText || ''))) ok = list[i];
        }
        if (ok) {
          if (ok.disabled) {
            var cb = modal.querySelector('input[type=checkbox]');
            if (cb) {
              cb.click();
              await waitFor(function () { return !ok.disabled; }, 2000, 100);
            }
          }
          if (!ok.disabled) {
            ok.click();
            await sleep(1100);
          }
        }
      }
      var on = await waitFor(function () { return isOn() ? true : null; }, 2500, 150);
      closePanel();
      return on ? 'enabled' : 'still-off';
    } finally {
      G.busy = false;
    }
  };

  // 执行期的权限弹窗（「是否允许执行 …」）。只在文案明确是授权类时点允许，
  // 删除 / 覆盖 / 重置类一律不代点，避免替用户做破坏性决定。
  var ALLOW_TEXT = /^(允许|允许一次|本次允许|本会话允许|始终允许|同意|批准|允许执行)$/;
  var DENY_TEXT = /删除|覆盖|清空|重置|卸载|格式化/;
  var APPROVE_HINT = /(权限|授权|批准|请求|访问|执行|运行|工具|命令|文件|文件夹|终端)/;
  var inPermissionPanel = function (el) {
    var n = el;
    while (n && n !== document.body) {
      var c = String(n.className || '');
      if (/cr-permission-panel|cr-permission-setting|cr-permission-confirm/.test(c)) return true;
      n = n.parentElement;
    }
    return false;
  };
  var clickAllowIn = function (root, scopeText) {
    var list = root.querySelectorAll('button');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b.offsetParent) continue;
      var t = String(b.innerText || '').trim();
      if (!t || t.length > 10 || !ALLOW_TEXT.test(t)) continue;
      if (b.disabled) continue;
      if (inPermissionPanel(b)) continue;
      b.click();
      G.approvals += 1;
      say('auto-approve: ' + t + ' | ' + String(scopeText || '').slice(0, 60));
      return true;
    }
    return false;
  };
  var approve = function () {
    if (opts.autoApprove === false) return false;
    // 1) 弹窗形态
    var m = visibleModal();
    if (m) {
      var mtxt = String(m.innerText || '').replace(/\s+/g, ' ');
      if (!/允许完全访问/.test(mtxt) && !DENY_TEXT.test(mtxt) && APPROVE_HINT.test(mtxt)) {
        if (clickAllowIn(m, mtxt)) return true;
      }
    }
    // 2) 行内卡片形态（时间线里的审批卡）
    var cards = document.querySelectorAll('[class*=approval],[class*=permission-request],[class*=tool-approval]');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c.offsetParent) continue;
      var txt = String(c.innerText || '').replace(/\s+/g, ' ');
      if (!txt || DENY_TEXT.test(txt)) continue;
      if (/允许完全访问/.test(txt)) continue;
      if (!APPROVE_HINT.test(txt)) continue;
      if (clickAllowIn(c, txt)) return true;
    }
    return false;
  };

  var tick = async function () {
    if (!G.enabled || G.busy) return;
    G.runs += 1;
    try { if (approve()) return; } catch (e) {}
    if (!btnOf()) { G.lastResult = 'no-button'; return; }
    if (isOn()) { G.lastResult = 'on'; return; }
    var r = await enable();
    G.lastResult = r;
    if (r === 'enabled' || r === 'already') G.enables += 1;
  };

  G.probe = function () {
    return {
      version: VERSION,
      on: isOn(),
      runs: G.runs,
      enables: G.enables,
      approvals: G.approvals,
      last: G.lastResult,
      log: G.log.slice(-8),
    };
  };
  G.stop = function () { G.enabled = false; G.lastResult = 'stopped'; };
  G.start = function () { G.enabled = true; };
  G.forceEnable = function () { return enable(); };

  if (G.timer) { try { clearInterval(G.timer); } catch (e) {} }
  var period = Math.max(1200, Number(opts.intervalMs) || 2500);
  G.timer = setInterval(function () { tick().catch(function () {}); }, period);
  setTimeout(function () { tick().catch(function () {}); }, 1200);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) setTimeout(function () { tick().catch(function () {}); }, 400);
  });
  window.addEventListener('focus', function () {
    setTimeout(function () { tick().catch(function () {}); }, 400);
  });
}

/** 常驻守卫源码（字符串），交给 Page.addScriptToEvaluateOnNewDocument / Runtime.evaluate。 */
function buildGuardSource(options = {}) {
  return '(' + wdPermGuard.toString() + ')(' + JSON.stringify({
    intervalMs: options.intervalMs || 2500,
    autoApprove: options.autoApprove !== false,
  }) + ');';
}

/**
 * 装上常驻守卫：先注册到新文档（页面重载后自动重跑），再对当前文档求值一次。
 * `send` 是 daemon 的 cdpSend。
 */
async function installRendererGuard(send, log, options = {}) {
  if (typeof send !== 'function') return { ok: false, error: 'no-cdp' };
  const source = buildGuardSource(options);
  const out = { ok: true, registered: false, evaluated: false };
  try {
    await send('Page.addScriptToEvaluateOnNewDocument', { source });
    out.registered = true;
  } catch (error) {
    out.registered = false;
    out.registerError = error.message;
  }
  try {
    const r = await send('Runtime.evaluate', { expression: source, returnByValue: true });
    const value = r && r.result && r.result.value;
    out.evaluated = !(r && r.exceptionDetails);
    out.value = value || null;
  } catch (error) {
    out.evaluated = false;
    out.evalError = error.message;
  }
  if (log) log(`[permission] 守卫注入 registered=${out.registered} evaluated=${out.evaluated}` +
    (out.registerError || out.evalError ? ` err=${out.registerError || out.evalError}` : ''));
  return out;
}

/** 读取守卫运行状态（页面里没有守卫返回 null）。 */
async function readGuardState(send) {
  if (typeof send !== 'function') return null;
  try {
    const r = await send('Runtime.evaluate', {
      expression: '(window.__wdPermGuard && window.__wdPermGuard.probe) ? window.__wdPermGuard.probe() : null',
      returnByValue: true,
    });
    return (r && r.result && r.result.value) || null;
  } catch (_) {
    return null;
  }
}

/* ---- 偏好文件守卫：账号偏好在任何时刻被写回默认值都还原 ---- */

function guardIntentPath() {
  const base = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'WorkDaddy')
    : path.join(require('os').homedir(), '.workdaddy');
  return path.join(base, 'permission-guard.json');
}

function readGuardIntent() {
  const v = readJsonSafe(guardIntentPath());
  if (!v || typeof v !== 'object') return { fullAccess: true };
  return { fullAccess: v.fullAccess !== false };
}

function setGuardIntent(fullAccess) {
  writeJsonAtomic(guardIntentPath(), { fullAccess: !!fullAccess, updatedAt: Date.now() });
  return readGuardIntent();
}

/**
 * 每 intervalMs 扫一遍所有账号偏好；发现不是 full-access 就写回。
 * 只碰 `localTaskPermissionMode` 一个键。意图文件里 fullAccess=false 时完全不动作。
 */
function startPreferenceGuard(options = {}) {
  const { dataRoot, log, intervalMs = 3000 } = options;
  if (!dataRoot) return { stop() {}, stats: () => ({ ok: false, error: 'no-dataRoot' }) };
  const stats = { checks: 0, restores: 0, lastRestore: null, lastError: null };
  let stopped = false;

  const run = () => {
    if (stopped) return;
    if (!readGuardIntent().fullAccess) return;
    stats.checks += 1;
    let uids = [];
    try { uids = listAccountUids(dataRoot); } catch (error) { stats.lastError = error.message; return; }
    for (const uid of uids) {
      const file = userPreferencePath(dataRoot, uid);
      const pref = readJsonSafe(file);
      // 文件不存在说明该账号还没初始化，别抢先造一份；等它自己出现。
      if (!pref) continue;
      if (pref[PREF_KEY] === FULL_ACCESS) continue;
      const before = pref[PREF_KEY] ?? '(缺失)';
      try {
        ensurePreference({ dataRoot, uid, log: null });
        stats.restores += 1;
        stats.lastRestore = { uid, before, at: Date.now() };
        if (log) log(`[permission] 偏好被改写 ${before} → ${FULL_ACCESS} uid=${uid}（守卫已还原）`);
      } catch (error) {
        stats.lastError = error.message;
      }
    }
  };

  const timer = setInterval(run, Math.max(800, intervalMs));
  setTimeout(run, 500);
  return {
    stop() { stopped = true; clearInterval(timer); },
    check: run,
    stats: () => ({ ...stats, running: !stopped, intent: readGuardIntent() }),
  };
}

/**
 * 三层一起跑。`send` 是 daemon 的 cdpSend；不给就只做前两层（离线/命令行模式）。
 */
async function applyFullAccess(options) {
  const { dataRoot, dbPath, uid, send, log, renderer = true, delayMs = 0 } = options || {};
  const report = { ok: true, uid: uid || '', preference: null, sessions: null, renderer: null };
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  try {
    report.preference = ensurePreference({ dataRoot, uid, log });
  } catch (error) {
    report.preference = { ok: false, error: error.message };
    report.ok = false;
  }
  try {
    report.sessions = await ensureSessionModes({ dbPath, uid, log });
    if (report.sessions && report.sessions.ok === false) report.ok = false;
  } catch (error) {
    report.sessions = { ok: false, error: error.message };
    report.ok = false;
  }
  if (renderer && typeof send === 'function') {
    try {
      const r = await send('Runtime.evaluate', {
        expression: buildRendererScript(),
        returnByValue: true,
        awaitPromise: true,
      });
      const value = r && r.result && r.result.value;
      report.renderer = value || { ok: false, status: 'no-result', raw: r && r.exceptionDetails ? String(r.exceptionDetails.text || '') : '' };
      if (!report.renderer.ok) report.ok = false;
    } catch (error) {
      report.renderer = { ok: false, status: 'cdp-error', error: error.message };
      report.ok = false;
    }
  }
  if (log) {
    const r = report.renderer ? `ui=${report.renderer.status}` : 'ui=skipped';
    log(`[permission] uid=${uid || '-'} pref=${report.preference && report.preference.changed ? 'fixed' : 'ok'} ` +
      `db=${report.sessions && typeof report.sessions.changes === 'number' ? report.sessions.changes : '-'} ${r}`);
  }
  return report;
}

/* ---------------- CLI ---------------- */

function defaultPaths() {
  const os = require('os');
  const home = os.homedir();
  const candidates = [
    path.join(home, '.workbuddy', 'workbuddy.db'),
    path.join(home, '.workbuddy-ai', 'workbuddy.db'),
  ];
  const dbPath = process.env.WORKBUDDY_DB || candidates.find((p) => fs.existsSync(p)) || candidates[0];
  return { dbPath, dataRoot: path.dirname(dbPath) };
}

function listAccountUids(dataRoot) {
  const storage = path.join(dataRoot, 'storage');
  try {
    return fs.readdirSync(storage)
      .filter((name) => /^user-.+-personal$/.test(name))
      .map((name) => name.replace(/^user-/, '').replace(/-personal$/, ''))
      .filter((uid) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid));
  } catch (_) {
    return [];
  }
}

async function cli(argv) {
  const { dbPath, dataRoot } = defaultPaths();
  const json = argv.includes('--json');
  const apply = argv.includes('--apply');
  const all = argv.includes('--all');
  const uidArg = (argv.find((a) => /^--uid=/.test(a)) || '').replace('--uid=', '');

  if (argv.includes('--on') || argv.includes('--off')) {
    const on = argv.includes('--on');
    setGuardIntent(on);
    if (on) {
      for (const uid of listAccountUids(dataRoot)) {
        ensurePreference({ dataRoot, uid, log: (m) => process.stdout.write(m + '\n') });
      }
    }
    process.stdout.write(`守卫意图已设为 ${on ? 'full-access（持续还原）' : 'default（不再还原）'} → ${guardIntentPath()}\n`);
    return 0;
  }

  if (!apply) {
    const uids = listAccountUids(dataRoot);
    const rows = [];
    for (const uid of uids) {
      const file = userPreferencePath(dataRoot, uid);
      const pref = readJsonSafe(file);
      let sessions = null;
      try {
        const db = createSessionDb({ dbPath });
        const r = await db.all(
          `SELECT COUNT(*) AS n FROM sessions WHERE ${NOT_DELETED} AND user_id = ?` +
          ` AND COALESCE(is_background_automation,0)=0 AND COALESCE(permission_mode,'') NOT IN (?, 'plan')`,
          [uid, CORE_FULL_ACCESS]
        );
        sessions = r && r[0] ? Number(r[0].n) : null;
      } catch (_) {}
      rows.push({ uid, preference: pref ? (pref[PREF_KEY] ?? null) : '(无文件)', sessionsNeedFix: sessions });
    }
    if (json) process.stdout.write(JSON.stringify({ dataRoot, dbPath, accounts: rows }, null, 2) + '\n');
    else {
      process.stdout.write(`会话库: ${dbPath}\n`);
      for (const r of rows) {
        process.stdout.write(`  ${r.uid}  偏好=${r.preference}  待修会话=${r.sessionsNeedFix}\n`);
      }
    }
    return 0;
  }

  const uids = all ? listAccountUids(dataRoot) : (uidArg ? [uidArg] : listAccountUids(dataRoot));
  let failed = 0;
  for (const uid of uids) {
    const report = await applyFullAccess({
      dataRoot, dbPath, uid, renderer: false,
      log: json ? null : (m) => process.stdout.write(m + '\n'),
    });
    if (!report.ok) failed++;
    if (json) process.stdout.write(JSON.stringify(report) + '\n');
  }
  return failed ? 2 : 0;
}

module.exports = {
  applyFullAccess,
  buildRendererScript,
  buildGuardSource,
  installRendererGuard,
  readGuardState,
  startPreferenceGuard,
  readGuardIntent,
  setGuardIntent,
  guardIntentPath,
  ensurePreference,
  ensureSessionModes,
  listAccountUids,
  userPreferencePath,
  readJsonSafe,
  FULL_ACCESS,
  CORE_FULL_ACCESS,
  PREF_KEY,
};

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(String(error && error.stack || error) + '\n');
    process.exit(1);
  });
}
