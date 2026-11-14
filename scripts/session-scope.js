'use strict';
/**
 * session-scope.js — 会话接管范围的唯一定义处（P1：local / cloud 边界）。
 *
 * 背景：WorkBuddy 的 sessions 表有两类会话，删除语义不同：
 *   - local：未删除 = `deleted_at IS NULL`，已删除 = `deleted_at` 为正的时间戳
 *   - cloud：未删除 = `deleted_at = -1`（哨兵值），已删除 = 正的时间戳
 *
 * 把 `(deleted_at IS NULL OR deleted_at = -1)` 无差别套到所有 transport 上，
 * 等于假设「云端会话的本地行就是权威」—— 这个假设没有经过服务端验证，会同时
 * 把「云端已删、本地还留着 -1」的会话当成活的接管走。
 *
 * 因此：
 *   - 有 transport 列 → 只取 `transport IS NULL OR transport = 'local'`，
 *     并且 `deleted_at IS NULL`（严格按 local 语义）。`deleted_at = -1` 出现在
 *     local 行上属**异常**：既不能确认是活的，也不能确认是回收站，一律不碰。
 *     既不是 local 也不是 cloud 的 transport 值 = 来源不明 → 永不接管（只读）。
 *   - 没有 transport 列 → 老库。**不能再假设 `-1` 是未删除**：这个哨兵值只在
 *     cloud 行上被观察到，老库是否用过没有证据。默认只取 `deleted_at IS NULL`，
 *     `-1` 行整行排除在写入范围之外；存在这类歧义行时，调用方必须**阻止写入**
 *     （见 rehome-sessions.js 的 `legacy-ambiguous` 判定），除非用户显式承认。
 *   - 云端会话必须同时满足「配置开启 cloudTakeover」且「cloudVerified 已验证」。
 *
 * 本模块只生成 SQL 片段，不执行写入。
 */

const LIVE_LOCAL = 'deleted_at IS NULL';
const LIVE_CLOUD = 'deleted_at = -1';
const NOT_DELETED = `(${LIVE_LOCAL} OR ${LIVE_CLOUD})`;
const LOCAL_TRANSPORT = "(transport IS NULL OR transport = 'local')";
/** 精确口径：local 用 NULL、cloud 用 -1，不互相套用。 */
const PRECISE_LIVE = `((${LOCAL_TRANSPORT}) AND ${LIVE_LOCAL}) OR (transport = 'cloud' AND ${LIVE_CLOUD})`;
const KNOWN_TRANSPORTS = new Set(['local', 'cloud', '(null)', '']);

/**
 * @param {Iterable<string>} columns  PRAGMA table_info('sessions') 的列名
 * @param {object} options
 *   cloudTakeover: 用户是否显式开启云端接管（默认 false）
 *   cloudVerified: 服务端语义是否已验证（默认 false；未验证时即使开启也不生效）
 * @returns {{where:string, params:any[], description:string, cloud:boolean,
 *            transportAware:boolean, verified:boolean, unknownOrigin:boolean}}
 */
function buildTakeoverScope(columns, options = {}) {
  const cols = columns instanceof Set
    ? columns
    : new Set(Array.from(columns || []).map((c) => (typeof c === 'string' ? c : String(c && c.name))));
  const transportAware = cols.has('transport');
  const cloud = options.cloudTakeover === true && options.cloudVerified === true;

  if (!transportAware) {
    return {
      // 老库：来源可确定（全 local），但 deleted_at 的编码无法交叉核对。
      // 只认 NULL；`-1` 行不在写入范围内 —— 这一条不接受任何配置改写。
      where: LIVE_LOCAL, params: [],
      description: 'legacy-no-transport(strict)',
      cloud: false, transportAware: false,
      legacy: true,
      verified: false,
      unknownOrigin: false,
      // 需要调用方先做「歧义行体检」，有 -1 行时默认阻止写入。
      requiresAmbiguityCheck: true,
    };
  }
  if (cloud) {
    return {
      where: PRECISE_LIVE, params: [],
      description: 'local+cloud(verified)',
      cloud: true, transportAware: true,
      legacy: false,
      verified: true, unknownOrigin: false,
      requiresAmbiguityCheck: false,
    };
  }
  return {
    where: `${LIVE_LOCAL} AND ${LOCAL_TRANSPORT}`,
    params: [],
    description: 'local-only(strict)',
    cloud: false, transportAware: true,
    legacy: false,
    verified: true, unknownOrigin: false,
    requiresAmbiguityCheck: false,
  };
}

/**
 * 只读语义体检：把「表里实际出现了哪些 deleted_at 取值」摆出来，
 * 而不是在代码里假设。任何异常都进 issues，供状态页与 --status 展示。
 */
async function assessDeletedSemantics(db) {
  let cols;
  try {
    cols = new Set((await db.all("PRAGMA table_info('sessions')")).map((r) => String(r.name)));
  } catch (error) {
    return { ok: false, error: error.message, transportAware: false, verified: false, issues: [] };
  }
  if (!cols.has('transport')) {
    const rows = await db.all(
      `SELECT SUM(CASE WHEN ${LIVE_LOCAL} THEN 1 ELSE 0 END) AS liveNull, ` +
      `SUM(CASE WHEN deleted_at = -1 THEN 1 ELSE 0 END) AS liveMinusOne, ` +
      `SUM(CASE WHEN deleted_at > 0 THEN 1 ELSE 0 END) AS trashed, ` +
      `SUM(CASE WHEN deleted_at = 0 THEN 1 ELSE 0 END) AS zero, COUNT(*) AS total FROM sessions`
    );
    const r = rows[0] || {};
    const ambiguous = Number(r.liveMinusOne || 0);
    return {
      ok: true,
      transportAware: false,
      verified: false,
      description: 'legacy-no-transport',
      // 老库的 -1 语义没有证据可交叉核对：出现一行就算歧义，默认阻止写入。
      blocking: ambiguous > 0,
      blockReason: ambiguous > 0 ? `legacy-minus-one-rows:${ambiguous}` : null,
      issues: ambiguous > 0 ? [`legacy-minus-one-rows:${ambiguous}`] : [],
      counts: {
        live: Number(r.liveNull || 0),
        ambiguous,
        trashed: Number(r.trashed || 0),
        zero: Number(r.zero || 0),
        total: Number(r.total || 0),
      },
    };
  }

  const rows = await db.all(
    `SELECT COALESCE(transport, '(null)') AS transport, ` +
    `SUM(CASE WHEN ${LIVE_LOCAL} THEN 1 ELSE 0 END) AS liveNull, ` +
    `SUM(CASE WHEN deleted_at = -1 THEN 1 ELSE 0 END) AS liveMinusOne, ` +
    `SUM(CASE WHEN deleted_at > 0 THEN 1 ELSE 0 END) AS trashed, ` +
    `SUM(CASE WHEN deleted_at = 0 THEN 1 ELSE 0 END) AS zero, ` +
    `COUNT(*) AS total FROM sessions GROUP BY COALESCE(transport, '(null)')`
  );

  const issues = [];
  const unknownTransports = [];
  const buckets = rows.map((r) => {
    const transport = String(r.transport);
    const isCloud = transport === 'cloud';
    const live = isCloud ? Number(r.liveMinusOne || 0) : Number(r.liveNull || 0);
    const ambiguous = isCloud ? Number(r.liveNull || 0) : Number(r.liveMinusOne || 0);
    if (!KNOWN_TRANSPORTS.has(transport)) unknownTransports.push(transport);
    if (ambiguous > 0) issues.push(`${transport}-rows-with-other-marker:${ambiguous}`);
    return {
      transport,
      live,
      ambiguous,
      trashed: Number(r.trashed || 0),
      zero: Number(r.zero || 0),
      total: Number(r.total || 0),
    };
  });

  // 只有 local 与 cloud 两种取值都符合各自编码，才算「语义已验证」。
  const verified = issues.length === 0 && unknownTransports.length === 0;
  if (unknownTransports.length) issues.push(`unknown-transport:${unknownTransports.join('|')}`);
  return {
    ok: true,
    transportAware: true,
    verified,
    description: verified ? 'local/cloud-consistent' : 'inconsistent',
    blocking: false,          // 异常行已被排除在范围之外，不需要额外阻断
    blockReason: null,
    issues,
    unknownTransports,
    rows: buckets,
  };
}

/** 只读统计：各类 transport 的存活 / 回收站 / 语义存疑分布，供 CLI 与状态页展示。 */
async function readTransportStats(db) {
  let cols;
  try {
    cols = new Set((await db.all("PRAGMA table_info('sessions')")).map((r) => String(r.name)));
  } catch (_) {
    return { transportAware: false, rows: [] };
  }
  if (!cols.has('transport')) return { transportAware: false, rows: [] };
  const alive = await db.all(
    `SELECT COALESCE(transport, '(null)') AS transport, ` +
    `SUM(CASE WHEN ${PRECISE_LIVE} THEN 1 ELSE 0 END) AS alive, ` +
    `SUM(CASE WHEN ${PRECISE_LIVE} THEN 0 ELSE 1 END) AS trashed ` +
    'FROM sessions GROUP BY COALESCE(transport, \'(null)\')'
  );
  return {
    transportAware: true,
    rows: alive.map((r) => ({
      transport: String(r.transport),
      alive: Number(r.alive || 0),
      trashed: Number(r.trashed || 0),
    })),
  };
}

module.exports = {
  LIVE_LOCAL,
  LIVE_CLOUD,
  NOT_DELETED,
  PRECISE_LIVE,
  buildTakeoverScope,
  assessDeletedSemantics,
  readTransportStats,
};
