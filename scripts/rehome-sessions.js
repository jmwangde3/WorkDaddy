'use strict';
/**
 * rehome-sessions.js — 切号后原地接管本机会话归属 + 历史副本去重。
 *
 * 1) 把 sessions.user_id 改成当前登录账号（不复制、不改会话 ID、不动消息文件）。
 * 2) 去重是**手动功能**，默认关闭。判定内核在 session-dedupe.js：
 *    字节相同 / 消息内容相同 才算副本；「包含关系」要显式 --containment；
 *    证明不了的组一律保留。自动接管不再触发任何去重。
 *
 * 复用 session-db.js 的 createSessionDb（node:sqlite → sqlite3 CLI 兜底）。
 * 接管口径：除回收站外全部接管（含已归档、后台自动化任务运行记录）。
 * 去重口径：人工会话（含归档），跳过后台任务运行记录 —— 后者有独立入口。
 * 每次写入前用 VACUUM INTO 生成一致性备份，写入走单事务并写操作日志（可回滚）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createSessionDb } = require('./session-db.js');
const dedupe = require('./session-dedupe.js');
const { buildTakeoverScope, readTransportStats, assessDeletedSemantics } = require('./session-scope.js');

const CONFIG_FILE = 'rehome-sessions.json';
const BACKUP_DIR = 'rehome-backups';

/**
 * 接管口径：只排除回收站。
 *
 * 「未删除」有两种编码（客户端 app.asar 里的原文）：
 *   - local 会话：deleted_at IS NULL
 *   - cloud 会话：deleted_at = -1
 * 客户端活跃判定就是 `(transport='local' AND deleted_at IS NULL) OR (transport='cloud' AND deleted_at = -1)`。
 *
 * 云端会话默认不自动接管（见 session-scope.js / cloudTakeover 配置）：
 * 服务端语义未验证前，改本地归属不等于改云端归属。
 */
const NOT_DELETED = "(deleted_at IS NULL OR deleted_at = -1)";
const WHERE = NOT_DELETED;

/**
 * 去重口径：在接管口径上再排除后台自动化任务会话。
 * 归档会话按产品既定规则参与（与 README 一致，不再有「注释说排除、SQL 却没排除」的矛盾）。
 */
const WHERE_DEDUPE = NOT_DELETED + " AND COALESCE(is_background_automation, 0) = 0";

const DEDUPE_MODES = new Set([dedupe.MODE_EXACT, dedupe.MODE_CONTAINMENT]);

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function stamp() {
  return dedupe.stamp();
}

/** 建立 <session-id> -> projects/**\/<id>.jsonl 路径索引，避免逐条递归查找。 */
const buildJsonlIndex = dedupe.buildJsonlIndex;

/**
 * 人工会话去重（可干跑）。默认 exact 模式：只处理字节相同或消息内容相同的副本。
 * 包含关系必须显式 mode='containment'（CLI --containment / --aggressive）。
 */
async function dedupeSessions(db, dataRoot, opts = {}) {
  const mode = opts.mode === dedupe.MODE_CONTAINMENT || opts.aggressive === true
    ? dedupe.MODE_CONTAINMENT
    : dedupe.MODE_EXACT;
  const plan = await dedupe.planDedupe(db, dataRoot, { scope: 'manual', mode });
  const result = await dedupe.applyDedupe(db, plan, {
    dryRun: !!opts.dryRun,
    backupRoot: opts.backupRoot || '',
    log: typeof opts.log === 'function' ? opts.log : () => {},
  });
  return { ...result, mode, plan };
}

/**
 * 后台自动化任务会话的去重 —— 唯一能碰 `is_background_automation = 1` 的路径。
 *
 * 语义边界：接管与人工去重**永不**触碰后台任务行；这里必须双重显式：
 *   1. `allowBackground: true` —— 承认「我知道这次动的是后台任务」；
 *   2. `apply: true`         —— 真的写库；只给 dryRun 一律按只读处理。
 * 缺任一条件都返回 skipped，不产生任何写入。
 */
async function dedupeBackgroundSessions(db, dataRoot, opts = {}) {
  const mode = opts.mode === dedupe.MODE_CONTAINMENT || opts.aggressive === true
    ? dedupe.MODE_CONTAINMENT
    : dedupe.MODE_EXACT;
  const skipped = (reason) => ({
    ok: true, applied: false, dryRun: true, scope: 'background', mode,
    skipped: reason, groups: 0, dropped: 0, ids: [], keptIds: [],
    details: [], skippedNoFile: 0, backup: null, journal: null, aborted: null,
  });
  if (opts.allowBackground !== true) return skipped('background-dedupe-requires-allow-background');
  const dryRun = opts.apply === true ? false : true;
  const plan = await dedupe.planDedupe(db, dataRoot, { scope: 'background', mode });
  const result = await dedupe.applyDedupe(db, plan, {
    dryRun,
    backupRoot: opts.backupRoot || '',
    log: typeof opts.log === 'function' ? opts.log : () => {},
  });
  return { ...result, mode, plan };
}

function createRehomeRunner(options = {}) {
  const dataDir = String(options.dataDir || '');          // WorkDaddy 配置/备份目录
  const dataRoot = String(options.dataRoot || '');        // WorkBuddy 状态根（含 projects/）
  const dbPath = String(options.dbPath || '');
  const log = typeof options.log === 'function' ? options.log : () => {};
  const configPath = path.join(dataDir, CONFIG_FILE);
  const backupRoot = path.join(dataDir, BACKUP_DIR);
  let lastRun = null;
  let running = null;

  /**
   * 去重默认关闭。开启条件必须同时满足：
   *   - 配置文件里显式写 `"dedupe": true`；
   *   - 环境变量没有显式关掉（WORKDADDY_REHOME_DEDUPE=0/false/off/no）。
   * 环境变量单独设成 1 不能绕过配置文件 —— 两者不一致时以「关」为准。
   */
  function readConfig() {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { parsed = null; }
    const envOff = !envFlag('WORKDADDY_REHOME_DEDUPE', true);
    const enabled = parsed && parsed.enabled !== undefined
      ? parsed.enabled !== false
      : envFlag('WORKDADDY_REHOME_SESSIONS', true);
    const dedupeOn = !!(parsed && parsed.dedupe === true) && !envOff;
    const mode = parsed && DEDUPE_MODES.has(parsed.dedupeMode) ? parsed.dedupeMode : dedupe.MODE_EXACT;
    return {
      enabled,
      dedupe: dedupeOn,
      dedupeMode: mode,
      // 云端接管默认关闭；cloudVerified 只能由人工验证后手写，代码不自动置真。
      cloudTakeover: !!(parsed && parsed.cloudTakeover === true),
      cloudVerified: !!(parsed && parsed.cloudVerified === true),
      // 启动恢复检查默认只读；autoRun 必须显式开启。
      startupReconcile: !!(parsed && parsed.startupReconcile === true),
    };
  }

  function writeConfig(next) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, configPath);
    return readConfig();
  }

  function setEnabled(enabled) {
    const cur = readConfig();
    return writeConfig({
      enabled: !!enabled,
      dedupe: cur.dedupe,
      dedupeMode: cur.dedupeMode,
      cloudTakeover: cur.cloudTakeover,
      cloudVerified: cur.cloudVerified,
    });
  }

  function setDedupe(enabled, mode) {
    const cur = readConfig();
    return writeConfig({
      enabled: cur.enabled,
      dedupe: !!enabled,
      dedupeMode: DEDUPE_MODES.has(mode) ? mode : cur.dedupeMode,
      cloudTakeover: cur.cloudTakeover,
      cloudVerified: cur.cloudVerified,
    });
  }

  function status() {
    let db = null;
    try { db = createSessionDb({ dbPath }); } catch (_) {}
    const cfg = readConfig();
    return {
      enabled: cfg.enabled,
      dedupe: cfg.dedupe,
      dedupeMode: cfg.dedupeMode,
      dedupeDefault: false,
      dbPath, dataRoot,
      dbExists: !!dbPath && fs.existsSync(dbPath),
      backend: db ? db.backend : null,
      configPath, backupDir: backupRoot, lastRun,
    };
  }

  async function run(uid, opts = {}) {
    if (running) return running;
    running = execute(String(uid || '').trim(), !!opts.dryRun)
      .then((result) => { lastRun = { at: Date.now(), uid: String(uid || '').trim(), ...result }; return result; })
      .catch((error) => {
        const result = { ok: false, error: error.message, affected: 0, backup: null };
        lastRun = { at: Date.now(), uid: String(uid || '').trim(), ...result };
        log(`[rehome] 执行失败: ${error.message}`);
        return result;
      })
      .finally(() => { running = null; });
    return running;
  }

  function ensureEnabled(opts) {
    const cfg = readConfig();
    if (!cfg.dedupe && opts.force !== true) {
      return { skipped: 'dedupe-disabled', hint: `在 ${configPath} 里写 "dedupe": true，或用 --force 仅本次执行` };
    }
    return null;
  }

  /** 手动去重入口（供 /api/rehome/dedupe 与 CLI 调用）。 */
  async function runDedupe(opts = {}) {
    if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`会话数据库不存在: ${dbPath || '(未配置)'}`);
    const blocked = ensureEnabled(opts);
    if (blocked) return { ok: true, applied: false, dropped: 0, groups: 0, ids: [], ...blocked };
    const db = createSessionDb({ dbPath });
    return dedupeSessions(db, dataRoot, {
      dryRun: !!opts.dryRun,
      mode: opts.mode,
      aggressive: !!opts.aggressive,
      backupRoot,
      log,
    });
  }

  /** 后台任务副本去重（唯一入口，双重显式开关见 dedupeBackgroundSessions）。 */
  async function runBackgroundDedupe(opts = {}) {
    if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`会话数据库不存在: ${dbPath || '(未配置)'}`);
    const blocked = ensureEnabled(opts);
    if (blocked) return { ok: true, applied: false, dropped: 0, groups: 0, ids: [], ...blocked };
    const db = createSessionDb({ dbPath });
    return dedupeBackgroundSessions(db, dataRoot, {
      dryRun: !!opts.dryRun,
      allowBackground: opts.allowBackground === true,
      apply: opts.apply === true,
      mode: opts.mode,
      aggressive: !!opts.aggressive,
      backupRoot,
      log,
    });
  }

  /** 按操作日志回滚一次去重（只回滚仍是本次写入值的行）。 */
  async function runRollback(journalPath, opts = {}) {
    const file = String(journalPath || '');
    if (!file || !fs.existsSync(file)) throw new Error(`操作日志不存在: ${file || '(未指定)'}`);
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!journal || journal.version !== 1 || !Array.isArray(journal.rows)) {
      throw new Error('操作日志格式不支持');
    }
    const db = createSessionDb({ dbPath });
    return dedupe.rollbackDedupe(db, journal, { dryRun: !!opts.dryRun });
  }

  /**
   * 接管：只改 user_id，**不再**顺带跑去重。
   * 去重是独立的手动动作，避免「切一次号就按猜测删一批会话」。
   */
  async function execute(targetUid, dryRun) {
    const cfg = readConfig();
    if (!cfg.enabled) return { ok: true, skipped: 'disabled', affected: 0, backup: null };
    if (!targetUid) throw new Error('缺少目标账号 uid');
    if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`会话数据库不存在: ${dbPath || '(未配置)'}`);

    const db = createSessionDb({ dbPath });
    const semantics = await assessDeletedSemantics(db);
    const scope = buildTakeoverScope(await db.all("PRAGMA table_info('sessions')"), {
      cloudTakeover: cfg.cloudTakeover,
      cloudVerified: cfg.cloudVerified,
    });
    // 来源不明的 transport 一律不写入：范围 SQL 已经把非 local 排除在外，
    // 这里再把「体检不通过」作为可见状态报出去，而不是悄悄扩大范围。
    const scopeReport = {
      mode: scope.description,
      cloud: scope.cloud,
      verified: scope.verified,
      unknownOrigin: scope.unknownOrigin,
      semantics: {
        verified: !!(semantics && semantics.verified),
        issues: (semantics && semantics.issues) || [],
      },
    };
    const rows = await db.all(`SELECT user_id, COUNT(*) AS n FROM sessions WHERE ${scope.where} GROUP BY user_id`, scope.params);
    const byUid = rows.map((r) => ({ uid: String(r.user_id || ''), count: Number(r.n || 0) }));
    const affected = byUid.filter((r) => r.uid !== targetUid).reduce((sum, r) => sum + r.count, 0);

    if (dryRun) {
      return {
        ok: true, dryRun: true, affected, byUid, backup: null,
        scope: scope.description, scopeReport, dedupe: { skipped: 'manual-only' },
      };
    }

    // WAL 模式下直接复制主库文件会拿到不完整快照，用 VACUUM INTO 生成一致性备份。
    let backupPath = null;
    if (affected > 0) {
      fs.mkdirSync(backupRoot, { recursive: true });
      backupPath = path.join(backupRoot, `workbuddy-${stamp()}.db`);
      await db.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      if (!fs.existsSync(backupPath)) throw new Error('备份未生成，已中止写入');
    }

    const statements = [];
    if (affected > 0) {
      statements.push({
        sql: `UPDATE sessions SET user_id = ? WHERE ${scope.where} AND user_id <> ?`,
        params: [targetUid, ...scope.params, targetUid],
      });
    }
    let changed = null;
    if (statements.length) {
      const results = await db.transaction(statements);
      if (results && results[0]) changed = Number(results[0].changes || 0);
    }
    return {
      ok: true,
      affected: changed === null ? affected : changed,
      byUid, backup: backupPath, backend: db.backend,
      scope: scope.description, scopeReport,
      dedupe: { skipped: 'manual-only' },
    };
  }

  /** 只读统计：local/cloud 分布 + deleted_at 语义体检。不写任何东西。 */
  async function inspectTransports() {
    if (!dbPath || !fs.existsSync(dbPath)) return { ok: false, error: 'db-missing' };
    const db = createSessionDb({ dbPath });
    return {
      ok: true,
      ...(await readTransportStats(db)),
      semantics: await assessDeletedSemantics(db),
    };
  }

  /** 只读统计：当前账号分布（启动恢复检查用）。 */
  async function distribution() {
    if (!dbPath || !fs.existsSync(dbPath)) return [];
    const db = createSessionDb({ dbPath });
    const cfg = readConfig();
    const scope = buildTakeoverScope(await db.all("PRAGMA table_info('sessions')"), {
      cloudTakeover: cfg.cloudTakeover,
      cloudVerified: cfg.cloudVerified,
    });
    const rows = await db.all(
      `SELECT user_id, COUNT(*) AS n FROM sessions WHERE ${scope.where} GROUP BY user_id`,
      scope.params
    );
    return rows.map((r) => ({ uid: String(r.user_id || ''), count: Number(r.n || 0) }));
  }

  return {
    run, runDedupe, runBackgroundDedupe, runRollback, inspectTransports, distribution,
    status, readConfig, setEnabled, setDedupe,
    WHERE, WHERE_DEDUPE, NOT_DELETED, CONFIG_FILE, BACKUP_DIR,
  };
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 切号后把源账号的 startup-route.json 内容原地写到所有账号目录（保持 inode）。 */
function alignStartupRoutes(dataRoot, sourceUid) {
  const root = String(dataRoot || '');
  const srcUid = String(sourceUid || '');
  if (!root || !srcUid) return { ok: false, reason: 'missing dataRoot/sourceUid', written: 0 };
  const src = path.join(root, srcUid, 'startup-route.json');
  if (!fs.existsSync(src)) return { ok: false, reason: 'source startup-route.json missing', written: 0 };
  let content;
  try { content = fs.readFileSync(src); } catch (e) { return { ok: false, reason: e.message, written: 0 }; }
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && UUID_RE.test(d.name))
      .map((d) => d.name);
  } catch (e) { return { ok: false, reason: e.message, written: 0 }; }
  let written = 0;
  const errors = [];
  for (const dir of dirs) {
    const target = path.join(root, dir, 'startup-route.json');
    if (!fs.existsSync(target)) continue;
    try { fs.writeFileSync(target, content); written += 1; }
    catch (e) { errors.push(`${dir}: ${e.message}`); }
  }
  return { ok: errors.length === 0, written, errors };
}

function defaultPaths() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.workbuddy', 'workbuddy.db'),
    path.join(home, '.workbuddy-ai', 'workbuddy.db'),
  ];
  const dbPath = process.env.WORKBUDDY_DB || candidates.find((p) => fs.existsSync(p)) || candidates[0];
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return {
    dbPath,
    dataRoot: path.dirname(dbPath),
    dataDir: process.env.WORKDADDY_DATA || path.join(appData, 'WorkDaddy'),
  };
}

function printUsage() {
  process.stdout.write(
    '用法:\n' +
    '  node rehome-sessions.js --dedupe [--dry-run] [--containment] [--force]\n' +
    '  node rehome-sessions.js --dedupe-background --allow-background [--apply] [--containment] [--force]\n' +
    '  node rehome-sessions.js --dedupe-rollback <日志.json> [--dry-run]\n' +
    '  node rehome-sessions.js --status\n' +
    '\n' +
    '去重默认关闭：配置文件 rehome-sessions.json 需要显式 "dedupe": true，\n' +
    '或本次用 --force 明确执行。--containment 才启用「消息包含关系」判定。\n' +
    '\n' +
    '后台任务隔离：接管与 --dedupe 永不触碰 is_background_automation = 1 的行。\n' +
    '--dedupe-background 是唯一入口，且必须再加 --allow-background 承认目标；\n' +
    '不加 --apply 时只做只读计划，打印会删哪些，不做任何写入。\n'
  );
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const wantsBackground = argv.includes('--dedupe-background') || argv.includes('--dedupe-bg');
  const wantsDedupe = argv.includes('--dedupe');
  const rollbackAt = argv.findIndex((a) => a === '--dedupe-rollback');
  const wantsRollback = rollbackAt !== -1;
  if (!wantsBackground && !wantsDedupe && !wantsRollback) {
    printUsage();
    process.exit(1);
  }
  const { dbPath, dataRoot, dataDir } = defaultPaths();
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`找不到会话库: ${dbPath}\n`);
    process.exit(1);
  }
  const runner = createRehomeRunner({ dataDir, dataRoot, dbPath, log: (m) => process.stdout.write(m + '\n') });
  const common = {
    dryRun: argv.includes('--dry-run'),
    mode: argv.includes('--containment') || argv.includes('--aggressive') ? dedupe.MODE_CONTAINMENT : dedupe.MODE_EXACT,
    force: argv.includes('--force'),
    // 后台任务只有加了这两个开关才可能产生写入：
    allowBackground: argv.includes('--allow-background'),
    apply: argv.includes('--apply'),
  };
  const task = wantsRollback
    ? runner.runRollback(argv[rollbackAt + 1], { dryRun: common.dryRun })
    : (wantsBackground ? runner.runBackgroundDedupe(common) : runner.runDedupe(common));
  task
    .then((r) => {
      // plan 里含 Map（指纹），JSON 化时去掉，避免输出巨大且不可读。
      const printable = { ...r };
      delete printable.plan;
      delete printable.journalData;
      process.stdout.write(JSON.stringify(printable, null, 2) + '\n');
      process.exit(r && r.ok === false ? 2 : 0);
    })
    .catch((e) => {
      process.stderr.write(String(e && e.message || e) + '\n');
      process.exit(1);
    });
}

module.exports = {
  createRehomeRunner, alignStartupRoutes, dedupeSessions, dedupeBackgroundSessions,
  buildJsonlIndex, defaultPaths, WHERE, WHERE_DEDUPE, NOT_DELETED, CONFIG_FILE, BACKUP_DIR,
};
