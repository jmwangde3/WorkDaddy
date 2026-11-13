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
  ensurePreference,
  ensureSessionModes,
  listAccountUids,
  userPreferencePath,
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
