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
 * 历史口径说明（**不再用于接管写入**，接管一律走 session-scope.buildTakeoverScope）：
 *
 * 「未删除」有两种编码：
 *   - local 会话：deleted_at IS NULL
 *   - cloud 会话：deleted_at = -1
 * 客户端活跃判定是 `(transport='local' AND deleted_at IS NULL) OR (transport='cloud' AND deleted_at = -1)`。
 *
 * 下面这两个常量保留给调用方做「历史行为」对照与测试断言；真正的写入范围由
 * buildTakeoverScope 生成，老库（无 transport 列）只认 `deleted_at IS NULL`。
 */
const NOT_DELETED = "(deleted_at IS NULL OR deleted_at = -1)";
const WHERE = NOT_DELETED;

/**
 * 去重口径（同样只作对照）：后台自动化任务会话有独立入口。
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

/**
 * spaces 是**账号级**实体：客户端按 `spaces.user_id = 当前 uid` 渲染左侧分组。
 * 只接管 sessions.user_id 时，分组仍留在原账号名下 → 切号后「会话在最近列表、
 * 分组不见了」。这里按 name 做幂等镜像：目标账号缺哪个分组就补一份（新 id，
 * 不删原账号的那份），再把目标账号下挂在「别人同名分组」上的会话改挂到自己的
 * 同名分组。切回原账号时它自己那份还在，两边都能看到同一套分组。
 */
const SPACE_ACTIVE = "COALESCE(status, 'active') = 'active' AND (deleted_at IS NULL OR deleted_at = -1)";

async function planSpaceMirror(db, targetUid) {
  const hasSpaces = await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spaces'"
  );
  if (!hasSpaces || !hasSpaces.length) {
    return { available: false, templates: 0, inserts: [], remaps: [] };
  }
  const rows = await db.all(
    `SELECT id, user_id, device_id, name, primary_folder_path, create_folder_path,
            pinned, sort_order, status, transport, conversation_origin, source_kind, created_at
       FROM spaces WHERE ${SPACE_ACTIVE}
      ORDER BY COALESCE(sort_order, 999999) ASC, created_at ASC`
  );
  // 同一 name 在多个账号下各有一份：统一取「created_at 最早、id 最小」那份当模板，
  // 结果与切号顺序无关（并列时用 id 兜底，避免顺序不定的库返回顺序）。
  const byName = new Map();
  for (const row of rows) {
    const name = String(row.name || '');
    if (!name) continue;
    const cur = byName.get(name);
    const a = Number(row.created_at || 0);
    const b = cur ? Number(cur.created_at || 0) : NaN;
    if (!cur || a < b || (a === b && String(row.id) < String(cur.id))) byName.set(name, row);
  }
  const targetRows = rows.filter((r) => String(r.user_id) === targetUid);
  const targetByName = new Map();
  const duplicateTargets = [];
  for (const r of targetRows) {
    const n = String(r.name);
    if (targetByName.has(n)) { duplicateTargets.push(n); continue; }
    targetByName.set(n, r);
  }
  const inserts = [];
  const remaps = [];
  const own = [];
  const conflicts = [];
  // 冲突分组上的会话不能改挂，但也不能留着指向别人账号的分组当孤儿：
  // 统一置 NULL 回到「最近列表」，等用户自己决定归到哪个分组。
  const detach = [];
  const srcIdsOf = (name) => rows
    .filter((r) => String(r.name) === name && String(r.user_id) !== targetUid)
    .map((r) => String(r.id));

  // 同名分组的「全来源」索引：身份冲突不能只看模板 vs 目标。A/B 路径相同、
  // C 指向别处时，C 的会话若被并进 B 就是错归，必须整体拒绝这个 name。
  const rowsByName = new Map();
  for (const r of rows) {
    const n = String(r.name || '');
    if (!n) continue;
    if (!rowsByName.has(n)) rowsByName.set(n, []);
    rowsByName.get(n).push(r);
  }
  const dupSet = new Set(duplicateTargets);

  for (const [name, tpl] of byName) {
    // 目标账号自己就有两份同名分组：身份有歧义，不镜像 / 不改挂 / 不归位。
    if (dupSet.has(name)) {
      conflicts.push({ name, reason: 'duplicate-target' });
      continue;
    }
    const mine = targetByName.get(name);
    const tplPath = normalizePath(tpl.primary_folder_path || '');
    const minePath = mine ? normalizePath(mine.primary_folder_path || '') : '';

    // 所有账号下同名分组的目录必须一致（或都没写），否则无法确认是同一逻辑分组。
    const srcPaths = new Set();
    for (const r of rowsByName.get(name) || []) {
      const p = normalizePath(r.primary_folder_path || '');
      const c = normalizePath(r.create_folder_path || '');
      if (p) srcPaths.add(p);
      if (c) srcPaths.add(c);
    }
    if (srcPaths.size > 1) {
      conflicts.push({ name, reason: 'source-paths-differ', paths: [...srcPaths].slice(0, 6) });
      if (mine) own.push({ id: String(mine.id), name });
      const ids = srcIdsOf(name);
      if (ids.length) detach.push({ name, srcIds: ids });
      continue;
    }

    // 同名不等于同一分组：两边都写明了目录且目录不同 → 视为不同逻辑分组，
    // 不镜像、不改挂，只把归位目标限定到目标账号自己那份。
    if (mine && tplPath && minePath && tplPath !== minePath) {
      conflicts.push({ name, reason: 'template-vs-target', template: tpl.primary_folder_path, target: mine.primary_folder_path });
      own.push({ id: String(mine.id), name });
      const ids = srcIdsOf(name);
      if (ids.length) detach.push({ name, srcIds: ids });
      continue;
    }
    const targetId = mine ? String(mine.id) : crypto.randomUUID();
    if (!mine) inserts.push({ template: tpl, id: targetId, name });
    own.push({ id: targetId, name });
    const srcIds = rows
      .filter((r) => String(r.name) === name && String(r.user_id) !== targetUid)
      .map((r) => String(r.id))
      .filter((id) => id !== targetId);
    if (srcIds.length) remaps.push({ name, targetId, srcIds });
  }
  return {
    available: true, templates: byName.size, inserts, remaps, own,
    conflicts, duplicateTargets, detach,
  };
}

/** 统一斜杠 + 小写，只用于路径前缀比较。 */
function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 把「没挂分组的会话」按 cwd 归位：会话所在目录落在某个分组目录之下（含子目录）
 * 就归到那个分组。分组目录 = <root>/<space name>，root 取该账号已归组会话的众数根，
 * 避免不同机器/不同工作区根时猜错。
 */
async function planCwdAdoption(db, targetUid, ownSpaces, options = {}) {
  if (!ownSpaces || !ownSpaces.length) return { bySpace: [], total: 0 };
  const anchored = await db.all(
    `SELECT s.user_id AS uid, s.cwd AS cwd, sp.name AS name
       FROM sessions s JOIN spaces sp ON sp.id = s.space_id
      WHERE s.space_id IS NOT NULL AND s.cwd IS NOT NULL AND s.cwd <> ''
        AND (s.deleted_at IS NULL OR s.deleted_at = -1)
        AND (sp.deleted_at IS NULL OR sp.deleted_at = -1)`
  );
  // 取「最靠前」那次同名目录出现：`H:/AI工作区/workspace/proj/workspace` 的根是
  // `H:/AI工作区`，不是 `H:/AI工作区/workspace/proj`。
  const tally = (filter) => {
    const roots = new Map();
    for (const row of anchored) {
      if (filter && !filter(row)) continue;
      const name = String(row.name || '');
      if (!name) continue;
      const cwd = normalizePath(row.cwd);
      const needle = '/' + name.toLowerCase();
      const idx = cwd.indexOf(needle);
      if (idx <= 0) continue;
      // 目录边界：workspace 不能命中 workspace2/proj。
      const after = cwd.charAt(idx + needle.length);
      if (after && after !== '/') continue;
      const root = cwd.slice(0, idx);
      roots.set(root, (roots.get(root) || 0) + 1);
    }
    return roots;
  };
  const pick = (roots) => {
    let root = '';
    let best = 0;
    let sum = 0;
    for (const [candidate, n] of roots) {
      sum += n;
      if (n > best) { best = n; root = candidate; }
    }
    return { root, best, sum };
  };
  // 优先用目标账号自己的样本；它一条已归组会话都没有时，才回退全局，
  // 且只在众数足够集中时采用 —— 宁可少归位，也不要按别人的目录结构错归。
  let { root, best, sum } = pick(tally((r) => String(r.uid) === targetUid));
  let source = 'target';
  if (!root) {
    const fallback = pick(tally(null));
    if (fallback.root && fallback.sum > 0 && fallback.best / fallback.sum >= 0.8) {
      root = fallback.root;
      best = fallback.best;
      sum = fallback.sum;
      source = 'global';
    }
  }
  if (!root) return { bySpace: [], total: 0, root: null, source: null };

  // 归位与接管共用同一套资格判定：范围没放开 cloud 时，cloud 行不参与归位。
  const transportGuard = options.transportAware && !options.allowCloud
    ? "AND COALESCE(transport, 'local') = 'local'"
    : '';
  const loose = await db.all(
    `SELECT id, cwd FROM sessions
      WHERE user_id = ? AND space_id IS NULL AND cwd IS NOT NULL AND cwd <> ''
        AND (deleted_at IS NULL OR deleted_at = -1) ${transportGuard}`,
    [targetUid]
  );
  const groups = new Map();
  for (const row of loose) {
    const cwd = normalizePath(row.cwd);
    let hit = null;
    for (const sp of ownSpaces) {
      const name = String(sp.name || '').toLowerCase();
      if (!name) continue;
      if (cwd === root + '/' + name || cwd.startsWith(root + '/' + name + '/')) {
        // 同名多义时取最长名，避免 workspace 抢走 xx-workspace
        if (!hit || name.length > hit.name.length) hit = { id: sp.id, name: sp.name };
      }
    }
    if (!hit) continue;
    if (!groups.has(hit.id)) groups.set(hit.id, { spaceId: hit.id, name: hit.name, ids: [] });
    groups.get(hit.id).ids.push(String(row.id));
  }
  const bySpace = [...groups.values()];
  return {
    bySpace,
    total: bySpace.reduce((n, g) => n + g.ids.length, 0),
    root,
    source,
    confidence: sum ? best / sum : null,
  };
}

function spaceInsertStatement(insert, targetUid, now) {
  const tpl = insert.template;
  // 只继承「分组身份」相关字段。目录、置顶、排序属于账号偏好，不跨账号复制：
  // A 把分组置顶、把目录指向 H:/x，不代表 B 也要这样。
  // INSERT ... WHERE NOT EXISTS：计划在事务外生成，若客户端在此期间已建了同名分组，
  // 这条语句自动跳过，不会产生同名重复行。
  return {
    sql: `INSERT INTO spaces (id, user_id, device_id, name, primary_folder_path, create_folder_path,
            pinned, sort_order, status, transport, conversation_origin, deleted_at,
            created_at, updated_at, source_kind)
          SELECT ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, ?, -1, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM spaces
              WHERE user_id = ? AND name = ? AND ${SPACE_ACTIVE}
           )`,
    params: [
      insert.id,
      targetUid,
      tpl.device_id || '',
      insert.name,
      tpl.status || 'active',
      tpl.transport || 'local',
      tpl.conversation_origin === undefined ? null : tpl.conversation_origin,
      now,
      now,
      tpl.source_kind === undefined || tpl.source_kind === null ? 'seed' : tpl.source_kind,
      targetUid,
      insert.name,
    ],
  };
}

/** SQLite 变量上限因版本而异（999 / 32766），重语句一律分块，分块仍在同一事务内。 */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function countSpaceRemaps(db, remaps, targetUid, scope) {
  let total = 0;
  const detail = [];
  // 计数器要在「改 user_id 之前」看清最终归属：既算已经属于目标账号的行，
  // 也算本次会被接管的行（同一事务里先改 user_id、再改 space_id）。
  const inScope = scope && scope.where ? ` OR (${scope.where})` : '';
  const inScopeParams = scope && scope.where ? (scope.params || []) : [];
  for (const rm of remaps) {
    const placeholders = rm.srcIds.map(() => '?').join(', ');
    const row = await db.all(
      `SELECT COUNT(*) AS n FROM sessions WHERE space_id IN (${placeholders}) AND (user_id = ?${inScope})`,
      [...rm.srcIds, targetUid, ...inScopeParams]
    );
    const n = Number((row && row[0] && row[0].n) || 0);
    if (n > 0) detail.push({ name: rm.name, sessions: n });
    total += n;
  }
  return { total, detail };
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
      // 老库（无 transport 列）出现 deleted_at = -1 行时，默认阻止写入。
      // 该值只被观察到用于 cloud 行，老库是否用过没有证据；承认风险才继续，
      // 且即使承认，-1 行仍然不进写入范围（只能写 NULL 行）。
      allowLegacyAmbiguous: !!(parsed && parsed.allowLegacyAmbiguous === true),
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
      allowLegacyAmbiguous: cur.allowLegacyAmbiguous,
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
      allowLegacyAmbiguous: cur.allowLegacyAmbiguous,
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
      cloudTakeover: cfg.cloudTakeover,
      allowLegacyAmbiguous: cfg.allowLegacyAmbiguous,
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
    // v1 只有 rows；v2 增加了 state 与 identity。两者都能回滚 —— 旧日志不能因为
    // 升级了格式就变成不可读，那等于把已经写进去的记录丢在半路。
    const supported = journal && (journal.version === 1 || journal.version === 2) && Array.isArray(journal.rows);
    if (!supported) {
      throw new Error('操作日志格式不支持');
    }
    // 已经是终态的回滚没有必要重做，直接说清楚而不是再跑一遍。
    if (journal.state === 'ROLLED_BACK') {
      return { ok: true, total: journal.rows.length, restored: 0, skipped: [], dryRun: !!opts.dryRun, alreadyTerminal: true };
    }
    const db = createSessionDb({ dbPath });
    const result = await dedupe.rollbackDedupe(db, journal, { dryRun: !!opts.dryRun });
    if (!opts.dryRun && result.ok && !result.skipped.length) {
      // 会话已经回滚进库了，但操作日志必须写回磁盘才算这条记录闭环。
      // 吞掉写入错误会让命令报告「已回滚」而磁盘仍停在 APPLYING —— 下次恢复
      // 会以为操作没结束，甚至再回滚一遍。
      const written = dedupe.persistJournalState(file, journal, 'ROLLED_BACK');
      if (!written.ok) {
        return {
          ...result, ok: false, persisted: false, action: 'persist-failed',
          error: written.error,
          note: '会话已回滚，但操作日志未能写回状态；重跑本命令是安全的（回滚幂等）',
        };
      }
      return { ...result, persisted: true, journal: written.journal };
    }
    return result;
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
    const ambiguousRows = Number((semantics && semantics.counts && semantics.counts.ambiguous) || 0);
    const ambiguity = {
      required: scope.requiresAmbiguityCheck === true,
      rows: ambiguousRows,
      // 只有老库需要这道闸：有 transport 列时异常行已被范围 SQL 排除。
      blocking: scope.requiresAmbiguityCheck === true && ambiguousRows > 0,
      acknowledged: cfg.allowLegacyAmbiguous === true,
      marker: scope.requiresAmbiguityCheck === true ? 'deleted_at=-1' : null,
    };
    const scopeReport = {
      mode: scope.description,
      cloud: scope.cloud,
      verified: scope.verified,
      unknownOrigin: scope.unknownOrigin,
      semantics: {
        verified: !!(semantics && semantics.verified),
        issues: (semantics && semantics.issues) || [],
      },
      ambiguity,
    };
    const rows = await db.all(`SELECT user_id, COUNT(*) AS n FROM sessions WHERE ${scope.where} GROUP BY user_id`, scope.params);
    const byUid = rows.map((r) => ({ uid: String(r.user_id || ''), count: Number(r.n || 0) }));
    const affected = byUid.filter((r) => r.uid !== targetUid).reduce((sum, r) => sum + r.count, 0);

    // 分组（spaces）也要跟着账号走：镜像缺的分组 + 把会话改挂到自己的同名分组。
    const mirror = await planSpaceMirror(db, targetUid);
    const remapCounts = mirror.remaps.length
      ? await countSpaceRemaps(db, mirror.remaps, targetUid, scope)
      : { total: 0, detail: [] };
    // 上一轮可能只改了 user_id 没挂分组：按 cwd 落点把散落在「最近列表」的会话归位。
    const adoption = mirror.available
      ? await planCwdAdoption(db, targetUid, mirror.own, {
        allowCloud: !!scope.cloud,
        transportAware: !!scope.transportAware,
      })
      : { bySpace: [], total: 0 };
    // 冲突分组：会话不改挂，但必须脱离「别人账号的分组」，否则就是跨账号孤儿引用。
    // 计数要算上「本次会被接管的会话」（此刻它们还属于源账号），否则第一次切号会漏。
    let detachTotal = 0;
    const detachPlan = [];
    const detachScope = scope && scope.where ? ` OR (${scope.where})` : '';
    const detachScopeParams = scope && scope.where ? (scope.params || []) : [];
    for (const d of mirror.detach || []) {
      for (const part of chunk(d.srcIds, 400)) {
        const placeholders = part.map(() => '?').join(', ');
        const row = await db.all(
          `SELECT COUNT(*) AS n FROM sessions
            WHERE space_id IN (${placeholders}) AND (user_id = ?${detachScope})
              AND (deleted_at IS NULL OR deleted_at = -1)`,
          [...part, targetUid, ...detachScopeParams]
        );
        const n = Number((row && row[0] && row[0].n) || 0);
        if (n > 0) { detachPlan.push({ part, n }); detachTotal += n; }
      }
    }
    const spaceReport = {
      available: mirror.available,
      templates: mirror.templates,
      created: mirror.inserts.map((i) => i.name),
      remapped: remapCounts.total,
      remappedDetail: remapCounts.detail,
      adopted: adoption.total,
      adoptedDetail: adoption.bySpace.map((g) => ({ name: g.name, sessions: g.ids.length })),
      root: adoption.root || null,
      rootSource: adoption.source || null,
      rootConfidence: adoption.confidence === undefined ? null : adoption.confidence,
      // 同名但目录不同的分组、以及目标账号自身的重复同名分组：只报不合并。
      conflicts: mirror.conflicts || [],
      duplicateTargets: mirror.duplicateTargets || [],
      // 冲突分组上的会话被置 NULL（避免跨账号孤儿引用）。
      detached: detachTotal,
    };
    const spaceWrites = mirror.inserts.length + remapCounts.total + adoption.total + detachTotal;

    // 老库有 -1 行且用户没有显式承认 → 不写库。这不是「提醒」，是硬停：
    // 我们无法证明这些行是活的还是回收站，改归属可能把已删会话搬给新账号。
    if (ambiguity.blocking && !ambiguity.acknowledged && !dryRun) {
      log(`[rehome] 中止：老库存在 ${ambiguousRows} 行 deleted_at=-1，语义未确认`);
      return {
        ok: false,
        skipped: 'legacy-deleted-at-ambiguous',
        blocked: true,
        retryable: false,                 // 语义未确认属于永久阻断，重试无意义
        affected: 0, byUid, backup: null,
        scope: scope.description, scopeReport, ambiguity,
        hint: '确认旧库 deleted_at=-1 的实际含义后，在配置里写 "allowLegacyAmbiguous": true 再执行；'
          + '即使承认，这些行也不会被接管（只处理 deleted_at IS NULL）。',
      };
    }

    if (dryRun) {
      return {
        ok: true, dryRun: true, affected, byUid, backup: null,
        scope: scope.description, scopeReport, ambiguity,
        spaces: spaceReport,
        blocked: ambiguity.blocking && !ambiguity.acknowledged,
        dedupe: { skipped: 'manual-only' },
      };
    }

    // WAL 模式下直接复制主库文件会拿到不完整快照，用 VACUUM INTO 生成一致性备份。
    let backupPath = null;
    if (affected > 0 || spaceWrites > 0) {
      fs.mkdirSync(backupRoot, { recursive: true });
      backupPath = path.join(backupRoot, `workbuddy-${stamp()}.db`);
      await db.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      if (!fs.existsSync(backupPath)) throw new Error('备份未生成，已中止写入');
    }

    const statements = [];
    // 顺序有语义：先改会话归属，再补分组，最后把会话改挂到目标账号自己的同名分组。
    if (affected > 0) {
      statements.push({
        sql: `UPDATE sessions SET user_id = ? WHERE ${scope.where} AND user_id <> ?`,
        params: [targetUid, ...scope.params, targetUid],
      });
    }
    const now = Date.now();
    for (const insert of mirror.inserts) {
      statements.push(spaceInsertStatement(insert, targetUid, now));
    }
    // IN 列表分块：SQLite 变量上限因版本而异（常见 999 / 32766），
    // 大账号一次上千条会直接让整个切号事务回滚。分块但不分事务。
    // 目标 id 用子查询现场解析，不用 plan 阶段生成的随机 uuid：即使上面的
    // INSERT 因 NOT EXISTS 被跳过（客户端并发建了同名分组），这里也落到真实行上；
    // 万一分组确实不存在，子查询给 NULL，比留下悬空 space_id 更安全。
    for (const rm of mirror.remaps) {
      for (const part of chunk(rm.srcIds, 400)) {
        const placeholders = part.map(() => '?').join(', ');
        statements.push({
          sql: `UPDATE sessions SET space_id = (
                   SELECT id FROM spaces
                    WHERE user_id = ? AND name = ? AND ${SPACE_ACTIVE}
                    ORDER BY created_at ASC, id ASC LIMIT 1
                 ), updated_at = ?
                 WHERE user_id = ? AND space_id IN (${placeholders})
                   AND (deleted_at IS NULL OR deleted_at = -1)`,
          params: [targetUid, rm.name, now, targetUid, ...part],
        });
      }
    }
    // 冲突分组：会话不改挂，但必须脱离「别人账号的分组」，否则就是跨账号孤儿引用。
    for (const dp of detachPlan) {
      const placeholders = dp.part.map(() => '?').join(', ');
      statements.push({
        sql: `UPDATE sessions SET space_id = NULL, updated_at = ?
               WHERE user_id = ? AND space_id IN (${placeholders})
                 AND (deleted_at IS NULL OR deleted_at = -1)`,
        params: [now, targetUid, ...dp.part],
      });
    }
    for (const group of adoption.bySpace) {
      for (const part of chunk(group.ids, 400)) {
        const placeholders = part.map(() => '?').join(', ');
        statements.push({
          sql: `UPDATE sessions SET space_id = ?, updated_at = ?
                 WHERE id IN (${placeholders}) AND space_id IS NULL`,
          params: [group.spaceId, now, ...part],
        });
      }
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
      scope: scope.description, scopeReport, ambiguity,
      spaces: spaceReport,
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
