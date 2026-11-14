'use strict';
/**
 * permission-sync.js — 「完全访问」相关的**手动**配置修复与守卫（P0 重构版）。
 *
 * 背景：WorkBuddy 的完全访问不是单一开关，而是三层状态：
 *   1. 账号级偏好  storage/user-<uid>-personal/global/preferences.json
 *                  → { "localTaskPermissionMode": "full-access" }
 *   2. 会话级字段  sessions.permission_mode（'fullAccess' / 'plan' / …）
 *   3. 渲染层开关  .cr-permission-setting（页面里的「允许完全访问」）
 *
 * 旧版本把「补偏好 / 补会话字段 / 页面自动拨开关 / 执行期自动点允许」混在一起，
 * 并且默认全开 —— 这等于替用户做授权决定。本版本拆成三个独立开关，**默认全部关闭**，
 * 且永不自动点击「允许完全访问」、永不自动勾选风险确认、永不按弹窗文案批准执行请求。
 *
 *   开关 A  preferenceGuard —— 定时把被写回默认值的账号偏好还原（只碰文件，不碰页面）。
 *   开关 B  configRepair    —— 切号后补齐偏好 + 会话 permission_mode（不碰页面）。
 *   开关 C  autoApprove     —— 保留字段但**不实现**：执行期权限必须由用户本人确认。
 *
 * `stopPermissionGuards()` 会真正停掉：主进程定时器、页面里的守卫定时器、
 * 已注册的 CDP 新文档脚本，并持久化三个开关为关闭；daemon 重启后仍然是关闭。
 */

const fs = require('fs');
const path = require('path');
const { createSessionDb } = require('./session-db.js');

const FULL_ACCESS = 'full-access';
const CORE_FULL_ACCESS = 'fullAccess';
const PREF_KEY = 'localTaskPermissionMode';
const NOT_DELETED = '(deleted_at IS NULL OR deleted_at = -1)';
const STATE_VERSION = 2;

const SWITCHES = Object.freeze(['preferenceGuard', 'configRepair', 'autoApprove']);

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

function guardStatePath() {
  const base = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'WorkDaddy')
    : path.join(require('os').homedir(), '.workdaddy');
  return path.join(base, 'permission-guard.json');
}

/** 三个开关全部关闭 —— 也是任何异常状态下的兜底值。 */
function defaultGuardState() {
  return {
    version: STATE_VERSION,
    preferenceGuard: false,
    configRepair: false,
    autoApprove: false,
    // 已注册的 CDP 新文档脚本（identifier 只在注册它的会话里有效，所以必须落盘，
    // 否则 daemon 重启后再也列不出来、也删不掉，残留脚本会跟着每个新文档跑）。
    registeredScripts: [],
    updatedAt: 0,
  };
}

function sanitizeScripts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e === 'object' && typeof e.identifier === 'string' && e.identifier)
    .map((e) => ({ target: String(e.target || ''), identifier: String(e.identifier), at: Number(e.at || 0) }))
    .slice(0, 64);
}

/**
 * 读取开关状态。旧版（v1 `{fullAccess:true}`）一律迁移为全关：
 * 「升级不该继承一个会自动点授权的旧意图」。
 */
function readGuardConfig(file) {
  const target = file || guardStatePath();
  const raw = readJsonSafe(target);
  if (!raw || typeof raw !== 'object') return defaultGuardState();
  if (raw.version !== STATE_VERSION) {
    const migrated = { ...defaultGuardState(), migration: 'from-v1', updatedAt: Date.now() };
    try { writeJsonAtomic(target, migrated); } catch (_) {}
    return migrated;
  }
  return {
    version: STATE_VERSION,
    preferenceGuard: raw.preferenceGuard === true,
    configRepair: raw.configRepair === true,
    autoApprove: false,           // C 永不生效，读取时也强制 false
    registeredScripts: sanitizeScripts(raw.registeredScripts),
    updatedAt: Number(raw.updatedAt || 0),
  };
}

function writeGuardConfig(patch, file) {
  const target = file || guardStatePath();
  const cur = readGuardConfig(target);
  const next = { ...cur, ...patch, version: STATE_VERSION, updatedAt: Date.now() };
  next.autoApprove = false;
  writeJsonAtomic(target, next);
  return next;
}

/* ---------------- 运行时资源登记表 ---------------- */
/* 只登记本模块创建的资源；stop 时只清这些，绝不清页面里的其它定时器。 */
const registry = {
  timers: new Set(),
  scripts: new Map(),       // targetKey -> Set(identifier)
  lastSend: null,
  stopped: false,
};

function registerTimer(timer) {
  registry.timers.add(timer);
  return timer;
}

function clearTimers() {
  let cleared = 0;
  for (const timer of registry.timers) {
    try { clearInterval(timer); cleared += 1; } catch (_) {}
    try { clearTimeout(timer); } catch (_) {}
  }
  registry.timers.clear();
  return cleared;
}

/** 记住可用的 CDP 发送函数，供没有显式传 send 的 stop 调用复用。 */
function rememberSend(send) {
  if (typeof send === 'function') registry.lastSend = send;
  return registry.lastSend;
}

/** 落盘登记一个待清理的 CDP 脚本 identifier（注册成功后调用）。 */
function rememberScript(target, identifier) {
  if (!identifier) return;
  const key = String(target || '');
  if (!registry.scripts.has(key)) registry.scripts.set(key, new Set());
  registry.scripts.get(key).add(String(identifier));
  const cur = readGuardConfig();
  const list = cur.registeredScripts.filter((e) => e.identifier !== String(identifier));
  list.push({ target: key, identifier: String(identifier), at: Date.now() });
  writeGuardConfig({ registeredScripts: list });
}

function persistedScripts() {
  try { return readGuardConfig().registeredScripts || []; } catch (_) { return []; }
}

/* ---------------- 第 1 层：账号偏好 ---------------- */

/**
 * 只补 `localTaskPermissionMode` 一个键，其余键原样保留。
 * 仅在开关 B（configRepair）或手动 --apply 时调用。
 */
function ensurePreference(options) {
  const { dataRoot, uid, log } = options;
  const result = { ok: true, file: '', changed: false, before: null };
  if (!dataRoot || !uid) return { ...result, ok: false, error: '缺少 dataRoot/uid' };
  const file = userPreferencePath(dataRoot, uid);
  result.file = file;
  const current = readJsonSafe(file);
  if (current === null) {
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

/* ---------------- 第 2 层：会话字段 ---------------- */

/**
 * 只动当前账号、未删除、非后台任务、且不是 plan 模式的会话。
 * plan 是用户显式选择的「先规划后执行」，覆盖它会破坏会话语义。
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

/* ---------------- 第 3 层：页面（只读探针，永不点击） ---------------- */

/**
 * 只读探针：返回当前页面开关状态。
 * **不打开面板、不点开关、不勾选风险确认、不点「允许完全访问」。**
 * 保留这个函数是为了让状态查询能显示「页面当前是不是完全访问」。
 */
function buildRendererScript() {
  return `(function(){
  try {
    var btn = document.querySelector('.cr-permission-setting');
    if (!btn) return { ok: false, status: 'no-permission-button' };
    var on = /cr-permission-setting--danger/.test(String(btn.className || ''));
    return { ok: on, status: on ? 'full-access' : 'sandbox' };
  } catch (e) {
    return { ok: false, status: 'probe-error', error: String(e && e.message || e) };
  }
})()`;
}

/**
 * 兼容旧调用：以前这里会注入一个会自动拨开关、自动点允许的常驻守卫。
 * 现在只做清理 —— 把页面里可能残留的旧守卫停掉，然后什么都不装。
 */
async function installRendererGuard(send, log) {
  if (typeof send !== 'function') return { ok: false, error: 'no-cdp' };
  const cleaned = await stopRendererGuard(send);
  if (log) log(`[permission] 渲染层守卫已停用（策略：不自动点击）cleaned=${cleaned.pageStopped}`);
  return { ok: true, registered: false, evaluated: false, disabledByPolicy: true, cleaned };
}

/**
 * 拆除页面里的旧守卫。
 *
 * CDP 的 `Page.addScriptToEvaluateOnNewDocument` 没有「列出已注册脚本」的接口，
 * identifier 只有注册方知道 —— 所以这里同时清理**内存登记**与**落盘登记**，
 * 覆盖「daemon 重启后仍能删掉上次注册的脚本」。
 *
 * 页面内清理是尽力而为：旧版守卫的定时器 / MutationObserver / 事件监听器结构
 * 没有文档，只能按已知字段名逐个拆，拆不掉的用 `needsReload` 明确报出来，
 * 由调用方决定要不要 `Page.reload`（`reload: true` 会在拆除后真的重载）。
 */
async function stopRendererGuard(send, options = {}) {
  const out = {
    removed: 0, persistedRemoved: 0, pageStopped: false,
    globalsRemoved: 0, observersDisconnected: 0, listenersRemoved: 0,
    needsReload: false, reloaded: false, errors: [],
  };
  const target = typeof send === 'function' ? send : registry.lastSend;
  if (typeof target !== 'function') { out.errors.push('no-cdp-sender'); return out; }

  // 1) 内存里登记的 identifier
  for (const [targetKey, ids] of registry.scripts) {
    for (const identifier of ids) {
      try {
        await target('Page.removeScriptToEvaluateOnNewDocument', { identifier });
        out.removed += 1;
      } catch (error) {
        out.errors.push(`${targetKey}:${error.message}`);
      }
    }
  }
  registry.scripts.clear();

  // 2) 落盘的 identifier（上次 daemon 进程注册的）
  const persisted = persistedScripts();
  for (const entry of persisted) {
    try {
      await target('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.identifier });
      out.persistedRemoved += 1;
    } catch (error) {
      out.errors.push(`persisted:${entry.identifier}:${error.message}`);
    }
  }
  if (persisted.length) writeGuardConfig({ registeredScripts: [] });

  // 3) 页面内残留
  try {
    const r = await target('Runtime.evaluate', {
      expression: `(function(){
  var out = { found:false, timer:false, observers:0, listeners:0, globals:0 };
  var g = window.__wdPermGuard;
  if (g && typeof g === 'object') {
    out.found = true;
    try { if (g.timer) { clearInterval(g.timer); clearTimeout(g.timer); out.timer = true; } } catch (e) {}
    var obs = [g.observer, g.mutationObserver, g.mo];
    for (var i = 0; i < obs.length; i++) {
      try { if (obs[i] && typeof obs[i].disconnect === 'function') { obs[i].disconnect(); out.observers++; } } catch (e) {}
    }
    try {
      var hs = g.handlers || g.listeners || {};
      for (var k in hs) {
        var fn = hs[k];
        if (typeof fn !== 'function') continue;
        var parts = String(k).split('|');
        var el = parts[0] === 'document' ? document : (parts[0] === 'window' ? window : (parts[0] === 'body' ? document.body : null));
        if (!el || !parts[1]) continue;
        try { el.removeEventListener(parts[1], fn, true); } catch (e) {}
        try { el.removeEventListener(parts[1], fn, false); } catch (e) {}
        out.listeners++;
      }
    } catch (e) {}
    try {
      var one = g.listener;
      if (one && one.el && one.type && one.fn) { one.el.removeEventListener(one.type, one.fn); out.listeners++; }
    } catch (e) {}
    try { g.enabled = false; g.lastResult = 'stopped'; } catch (e) {}
  }
  var names = ['__wdPermGuard','__wdPermGuardInstalled','__wdPermGuardVersion','__wdPermAutoApprove','__wdPermTimer'];
  for (var n = 0; n < names.length; n++) {
    try { if (names[n] in window) { delete window[names[n]]; out.globals++; } } catch (e) {}
  }
  return out;
})()`,
      returnByValue: true,
    });
    const v = (r && r.result && r.result.value) || null;
    if (v) {
      out.pageStopped = !!v.found;
      out.globalsRemoved = Number(v.globals || 0);
      out.observersDisconnected = Number(v.observers || 0);
      out.listenersRemoved = Number(v.listeners || 0);
      // 旧守卫存在过 = 结构未知的监听器可能还在；只有重载能给出确定答案。
      out.needsReload = !!v.found;
    }
  } catch (error) {
    out.errors.push(`eval:${error.message}`);
  }

  if (out.needsReload && options.reload === true) {
    try { await target('Page.reload', { ignoreCache: false }); out.reloaded = true; } catch (error) {
      out.errors.push(`reload:${error.message}`);
    }
  }
  return out;
}

/** 读取页面状态（只读）。顺带记住可用的 CDP 发送函数。 */
async function readGuardState(send) {
  if (typeof send !== 'function') return null;
  rememberSend(send);
  try {
    const r = await send('Runtime.evaluate', { expression: buildRendererScript(), returnByValue: true });
    return (r && r.result && r.result.value) || null;
  } catch (_) {
    return null;
  }
}

/* ---------------- 第 4 层：偏好守卫（开关 A） ---------------- */

/**
 * 每 intervalMs 扫一遍所有账号偏好；发现不是 full-access 就写回。
 * 仅当开关 A 打开时启动；stop() 只清本模块登记的定时器。
 */
function startPreferenceGuard(options = {}) {
  const { dataRoot, log, intervalMs = 3000 } = options;
  if (!dataRoot) return { stop() {}, stats: () => ({ ok: false, error: 'no-dataRoot' }) };
  const cfg = readGuardConfig();
  const stats = { checks: 0, restores: 0, lastRestore: null, lastError: null, enabled: cfg.preferenceGuard };
  if (!cfg.preferenceGuard) {
    return {
      stop() {},
      check() {},
      stats: () => ({ ...stats, running: false, intent: cfg }),
    };
  }
  registry.stopped = false;
  let stopped = false;

  const run = () => {
    if (stopped || registry.stopped) return;
    if (!readGuardConfig().preferenceGuard) return;
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

  const timer = registerTimer(setInterval(run, Math.max(800, intervalMs)));
  const kick = setTimeout(run, 500);
  if (kick.unref) kick.unref();
  return {
    stop() {
      stopped = true;
      try { clearInterval(timer); } catch (_) {}
      registry.timers.delete(timer);
    },
    check: run,
    stats: () => ({ ...stats, running: !stopped && !registry.stopped, intent: readGuardConfig() }),
  };
}

/* ---------------- 统一停止 ---------------- */

/**
 * 真正停掉全部守卫：
 *   1. 主进程定时器（只清本模块登记的，不动别的模块）
 *   2. 页面里的旧守卫：定时器、MutationObserver、已登记的事件监听器、全局对象
 *   3. 已注册的 CDP 新文档脚本（内存登记 + 落盘登记，覆盖重启后残留）
 *   4. 持久化三个开关为关闭
 * `reload: true` 会在发现旧守卫后重载页面，保证未知结构的监听器彻底消失。
 * 重复调用安全（幂等）。
 */
async function stopPermissionGuards(options = {}) {
  const { send, log, persist = true, reload = false } = options;
  registry.stopped = true;
  const timers = clearTimers();
  const page = await stopRendererGuard(send || registry.lastSend, { reload });
  if (persist) writeGuardConfig({ preferenceGuard: false, configRepair: false, autoApprove: false, registeredScripts: [] });
  if (log) {
    log(`[permission] 已停止全部守卫 timers=${timers} scripts=${page.removed}+${page.persistedRemoved} ` +
      `globals=${page.globalsRemoved} observers=${page.observersDisconnected} listeners=${page.listenersRemoved} ` +
      `reload=${page.reloaded}`);
  }
  return {
    ok: page.errors.length === 0,
    timersStopped: timers,
    scriptsRemoved: page.removed + page.persistedRemoved,
    pageStopped: page.pageStopped,
    globalsRemoved: page.globalsRemoved,
    observersDisconnected: page.observersDisconnected,
    listenersRemoved: page.listenersRemoved,
    needsReload: page.needsReload,
    reloaded: page.reloaded,
    errors: page.errors,
    state: readGuardConfig(),
  };
}

/** 切换单个开关。开启时解除 stopped 标记；C 永远拒绝开启。 */
function setGuardSwitch(name, enabled, options = {}) {
  if (!SWITCHES.includes(name)) throw new Error(`未知开关: ${name}`);
  if (name === 'autoApprove' && enabled) {
    throw new Error('autoApprove 已按策略移除：执行期权限必须由用户本人确认');
  }
  const next = writeGuardConfig({ [name]: !!enabled }, options.file);
  if (enabled) registry.stopped = false;
  return next;
}

/** 完整状态：三个开关 + 运行中的定时器数 + 已注册脚本 id（内存 + 落盘）。 */
async function getPermissionStatus(options = {}) {
  const cfg = readGuardConfig(options.file);
  const page = options.send ? await readGuardState(options.send) : null;
  const registeredScriptIds = [];
  for (const ids of registry.scripts.values()) registeredScriptIds.push(...ids);
  for (const entry of cfg.registeredScripts) {
    if (!registeredScriptIds.includes(entry.identifier)) registeredScriptIds.push(entry.identifier);
  }
  return {
    preferenceGuardEnabled: cfg.preferenceGuard,
    rendererGuardEnabled: false,        // 渲染层自动动作已移除
    autoApproveEnabled: false,          // C 永不生效
    configRepairEnabled: cfg.configRepair,
    activeTimerCount: registry.timers.size,
    registeredScriptIds,
    persistedScriptCount: cfg.registeredScripts.length,
    pageGuard: page,
    pageGuardPresent: !!(page && page.status && page.status !== 'no-permission-button'),
    stopped: registry.stopped,
    statePath: options.file || guardStatePath(),
  };
}

/* ---------------- 组合入口 ---------------- */

/**
 * 补齐偏好 + 会话字段（开关 B 的动作）。**不碰页面。**
 * 手动 `--apply` 也走这里。
 */
async function applyFullAccess(options) {
  const { dataRoot, dbPath, uid, log, delayMs = 0 } = options || {};
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
  report.renderer = { ok: false, status: 'disabled-by-policy' };
  if (log) {
    log(`[permission] uid=${uid || '-'} pref=${report.preference && report.preference.changed ? 'fixed' : 'ok'} ` +
      `db=${report.sessions && typeof report.sessions.changes === 'number' ? report.sessions.changes : '-'} ui=untouched`);
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

  if (argv.includes('--off')) {
    const out = await stopPermissionGuards({
      log: json ? null : (m) => process.stdout.write(m + '\n'),
      reload: argv.includes('--reload'),
    });
    if (json) {
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return 0;
    }
    process.stdout.write(
      `持久化开关已关闭：preferenceGuard=false configRepair=false autoApprove=false\n` +
      `主进程定时器清理: ${out.timersStopped}   CDP 脚本清理: ${out.scriptsRemoved}   ` +
      `页面全局对象: ${out.globalsRemoved}   observer: ${out.observersDisconnected}   listener: ${out.listenersRemoved}\n`
    );
    if (!out.pageStopped) {
      process.stdout.write(
        '提示：CLI 进程没有 CDP 会话，页面内的旧守卫无法在这里拆除。\n' +
        '      要清页面请走 daemon 的 POST /api/permission/off（带 CDP），或重启客户端。\n'
      );
    } else if (out.needsReload && !out.reloaded) {
      process.stdout.write('提示：检测到旧守卫残留，加 --reload 可强制重载页面彻底清掉监听器。\n');
    }
    return 0;
  }

  if (argv.includes('--on')) {
    const name = argv.includes('--preference-guard') ? 'preferenceGuard'
      : (argv.includes('--config-repair') ? 'configRepair' : null);
    if (!name) {
      process.stdout.write('开启需要指定开关：--preference-guard 或 --config-repair\n');
      return 1;
    }
    setGuardSwitch(name, true);
    process.stdout.write(`已开启 ${name}\n`);
    return 0;
  }

  if (argv.includes('--status')) {
    const status = await getPermissionStatus();
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return 0;
  }

  if (!apply) {
    const uids = listAccountUids(dataRoot);
    const rows = [];
    const cfg = readGuardConfig();
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
    if (json) {
      process.stdout.write(JSON.stringify({ dataRoot, dbPath, switches: cfg, accounts: rows }, null, 2) + '\n');
    } else {
      process.stdout.write(`开关: preferenceGuard=${cfg.preferenceGuard} configRepair=${cfg.configRepair} autoApprove=false\n`);
      process.stdout.write(`会话库: ${dbPath}\n`);
      for (const r of rows) {
        process.stdout.write(`  ${r.uid}  偏好=${r.preference}  待修会话=${r.sessionsNeedFix}\n`);
      }
    }
    return 0;
  }

  // --apply 属于开关 B 的手动动作；不会碰页面。
  const uids = all ? listAccountUids(dataRoot) : (uidArg ? [uidArg] : listAccountUids(dataRoot));
  let failed = 0;
  for (const uid of uids) {
    const report = await applyFullAccess({
      dataRoot, dbPath, uid,
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
  installRendererGuard,
  stopRendererGuard,
  readGuardState,
  rememberSend,
  rememberScript,
  persistedScripts,
  startPreferenceGuard,
  stopPermissionGuards,
  setGuardSwitch,
  getPermissionStatus,
  readGuardConfig,
  writeGuardConfig,
  guardStatePath,
  defaultGuardState,
  ensurePreference,
  ensureSessionModes,
  listAccountUids,
  userPreferencePath,
  readJsonSafe,
  SWITCHES,
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
