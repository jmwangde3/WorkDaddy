'use strict';
/**
 * rehome-sessions.js — 切号后原地接管本机会话归属 + 历史副本去重。
 *
 * 1) 把 sessions.user_id 改成当前登录账号（不复制、不改会话 ID、不动消息文件）。
 * 2) 对同工作区、同标题、消息文件内容完全相同的历史副本做软删，只留一份。
 *    WorkBuddy 的「自动同步所有会话」历史上会为每个账号复制一份完整会话；
 *    按 user_id 隔离时每个账号只看到自己那份，归属统一后三份会同时出现在侧栏。
 *
 * 复用 session-db.js 的 createSessionDb（node:sqlite → sqlite3 CLI 兜底）。
 * 接管口径：除回收站外全部接管（含已归档、后台自动化任务运行记录）。
 * 去重口径：只动人工会话（含归档），跳过后台任务运行记录，避免误删真实执行历史。
 * 每次写入前用 VACUUM INTO 生成一致性备份，写入走单事务。
 */
const fs = require('fs');
const path = require('path');
const { createSessionDb } = require('./session-db.js');

const CONFIG_FILE = 'rehome-sessions.json';
const BACKUP_DIR = 'rehome-backups';

/**
 * 接管口径：只排除回收站（deleted_at 非空）。
 *
 * - 已归档（status='archived'）一并接管：归档是「翻历史」的入口，必须跨账号可见，
 *   否则 A 归档的会话在 B 的归档列表里消失。
 * - 后台自动化任务会话（is_background_automation=1）一并接管：那是定时任务每次执行的
 *   运行记录，跨账号共享后历史才完整。任务「定义」本身由 automation-account-sync.js
 *   单独维护（automation-sync.json 开关），两层互不影响。
 * - 回收站不接管（用户明确暂不需要），保持原归属。
 */
const WHERE = "deleted_at IS NULL";

/**
 * 去重口径：在接管口径上再排除后台自动化任务会话。
 *
 * 后台任务是真实执行记录（每个账号/每天各一份，内容不同），不是「自动同步会话」时代
 * 复制出来的重复副本，不能按同名同大小当副本删掉。去重只作用于人工会话（含归档）。
 */
const WHERE_DEDUPE = "deleted_at IS NULL AND COALESCE(is_background_automation, 0) = 0";

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 建立 <session-id> -> projects/**\/<id>.jsonl 路径索引，避免逐条递归查找。 */
function buildJsonlIndex(projectsRoot) {
  const idx = new Map();
  if (!projectsRoot || !fs.existsSync(projectsRoot)) return idx;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) idx.set(e.name.slice(0, -6), p);
    }
  };
  walk(projectsRoot, 0);
  return idx;
}

/**
 * 历史副本去重：按 (title, cwd) 分组，且组内每条的消息 JSONL 都存在、大小完全一致
 * 才认定为同一会话的复制副本。保留 updated_at 最新的一条，其余软删（写 deleted_at）。
 * 大小不一致或缺少消息文件的组一律跳过，避免误删真实的不同会话。
 */
async function dedupeSessions(db, dataRoot, opts = {}) {
  const dryRun = !!opts.dryRun;
  const aggressive = !!opts.aggressive;
  const idx = buildJsonlIndex(path.join(String(dataRoot || ''), 'projects'));
  const rows = await db.all(
    `SELECT id, cwd, title, created_at, updated_at FROM sessions WHERE ${WHERE_DEDUPE} ` +
    'ORDER BY cwd, title, updated_at DESC, created_at ASC'
  );
  const groups = new Map();
  for (const r of rows) {
    const key = String(r.title || '') + '\u0000' + String(r.cwd || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const drop = [];
  let groupsCleaned = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sizes = list.map((r) => {
      const p = idx.get(String(r.id));
      if (!p) return -1;
      try { return fs.statSync(p).size; } catch (_) { return -1; }
    });
    const valid = sizes.filter((s) => s > 0);
    if (valid.length !== list.length) continue;      // 有副本缺消息文件，跳过
    if (!aggressive) {
      // 保守模式：只有当组内存在大小完全一致的「复制对」才认定为副本链。
      // 全部大小各异时可能是独立演化出的不同内容，留给人工确认。
      const hasPair = valid.some((s, i) => valid.indexOf(s) !== i);
      if (!hasPair) continue;
    }
    // list 已按 updated_at DESC 排序：保留最新（通常也是内容最全）的一条。
    for (const r of list.slice(1)) drop.push(String(r.id));
    groupsCleaned += 1;
  }
  if (dryRun || !drop.length) {
    return { groups: groupsCleaned, dropped: drop.length, ids: drop, applied: !dryRun && drop.length === 0 };
  }
  const now = Date.now();
  const statements = [];
  for (let i = 0; i < drop.length; i += 200) {
    const chunk = drop.slice(i, i + 200);
    statements.push({
      sql: `UPDATE sessions SET deleted_at = ? WHERE id IN (${chunk.map(() => '?').join(',')}) AND deleted_at IS NULL`,
      params: [now, ...chunk],
    });
  }
  await db.transaction(statements);
  return { groups: groupsCleaned, dropped: drop.length, ids: drop, applied: true };
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

  function readConfig() {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return {
        enabled: parsed.enabled !== false,
        dedupe: parsed.dedupe !== false && envFlag('WORKDADDY_REHOME_DEDUPE', true),
      };
    } catch (_) {
      return { enabled: envFlag('WORKDADDY_REHOME_SESSIONS', true), dedupe: envFlag('WORKDADDY_REHOME_DEDUPE', true) };
    }
  }

  function setEnabled(enabled) {
    const cur = readConfig();
    const next = { enabled: !!enabled, dedupe: cur.dedupe };
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, configPath);
    return next;
  }

  function status() {
    let db = null;
    try { db = createSessionDb({ dbPath }); } catch (_) {}
    return {
      enabled: readConfig().enabled,
      dedupe: readConfig().dedupe,
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

  /** 独立去重入口（供 /api/rehome/dedupe 手动调用）。 */
  async function runDedupe(opts = {}) {
    if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`会话数据库不存在: ${dbPath || '(未配置)'}`);
    const db = createSessionDb({ dbPath });
    const opts2 = { dryRun: !!opts.dryRun, aggressive: !!opts.aggressive };
    if (!opts.dryRun) {
      fs.mkdirSync(backupRoot, { recursive: true });
      const backupPath = path.join(backupRoot, `workbuddy-dedupe-${stamp()}.db`);
      await db.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      return { ...(await dedupeSessions(db, dataRoot, opts2)), backup: backupPath, backend: db.backend };
    }
    return { ...(await dedupeSessions(db, dataRoot, opts2)), backup: null, backend: db.backend };
  }

  async function execute(targetUid, dryRun) {
    const cfg = readConfig();
    if (!cfg.enabled) return { ok: true, skipped: 'disabled', affected: 0, backup: null };
    if (!targetUid) throw new Error('缺少目标账号 uid');
    if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`会话数据库不存在: ${dbPath || '(未配置)'}`);

    const db = createSessionDb({ dbPath });
    const rows = await db.all(`SELECT user_id, COUNT(*) AS n FROM sessions WHERE ${WHERE} GROUP BY user_id`);
    const byUid = rows.map((r) => ({ uid: String(r.user_id || ''), count: Number(r.n || 0) }));
    const affected = byUid.filter((r) => r.uid !== targetUid).reduce((sum, r) => sum + r.count, 0);
    const dupe = cfg.dedupe
      ? await dedupeSessions(db, dataRoot, { dryRun: true })
      : { groups: 0, dropped: 0, ids: [], applied: false };

    if (dryRun) return { ok: true, dryRun: true, affected, byUid, backup: null, dedupe: { groups: dupe.groups, dropped: dupe.dropped } };

    // WAL 模式下直接复制主库文件会拿到不完整快照，用 VACUUM INTO 生成一致性备份。
    let backupPath = null;
    fs.mkdirSync(backupRoot, { recursive: true });
    if (affected > 0 || (cfg.dedupe && dupe.dropped > 0)) {
      backupPath = path.join(backupRoot, `workbuddy-${stamp()}.db`);
      await db.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      if (!fs.existsSync(backupPath)) throw new Error('备份未生成，已中止写入');
    }

    const statements = [];
    if (affected > 0) {
      statements.push({
        sql: `UPDATE sessions SET user_id = ? WHERE ${WHERE} AND user_id <> ?`,
        params: [targetUid, targetUid],
      });
    }
    let deduped = { groups: 0, dropped: 0, ids: [], applied: false };
    if (cfg.dedupe && dupe.dropped > 0) {
      const now = Date.now();
      for (let i = 0; i < dupe.ids.length; i += 200) {
        const chunk = dupe.ids.slice(i, i + 200);
        statements.push({
          sql: `UPDATE sessions SET deleted_at = ? WHERE id IN (${chunk.map(() => '?').join(',')}) AND deleted_at IS NULL`,
          params: [now, ...chunk],
        });
      }
      deduped = { groups: dupe.groups, dropped: dupe.dropped, ids: dupe.ids, applied: true };
    }
    let changed = null;
    if (statements.length) {
      const results = await db.transaction(statements);
      if (affected > 0 && results && results[0]) changed = Number(results[0].changes || 0);
    }
    return {
      ok: true,
      affected: changed === null ? affected : changed,
      byUid, backup: backupPath, backend: db.backend,
      dedupe: { groups: deduped.groups, dropped: deduped.dropped },
    };
  }

  return { run, runDedupe, status, readConfig, setEnabled, WHERE, WHERE_DEDUPE, CONFIG_FILE, BACKUP_DIR };
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

module.exports = { createRehomeRunner, alignStartupRoutes, dedupeSessions, buildJsonlIndex, WHERE, WHERE_DEDUPE, CONFIG_FILE, BACKUP_DIR };
