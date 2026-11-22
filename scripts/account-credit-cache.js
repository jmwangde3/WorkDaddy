'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { replaceFileWithRetry } = require('./atomic-file-write');

// Public balance projection only; never persist an API response or auth data.
function projection(result) {
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    credits: number(result.credits),
    creditUnlimited: result.unlimited === true,
    creditSegments: (Array.isArray(result.segments) ? result.segments : []).filter(segment => segment && number(segment.remaining) !== null).map(segment => ({
      remaining: number(segment.remaining), total: number(segment.total), expiresAt: number(segment.expiresAt),
      source: typeof segment.source === 'string' ? segment.source : '',
      packageCode: typeof segment.packageCode === 'string' ? segment.packageCode : '',
    })),
  };
}
function nearestExpiry(account) {
  let nearest = Infinity;
  for (const segment of account.creditSegments || []) {
    if (segment.remaining > 0 && typeof segment.expiresAt === 'number' && Number.isFinite(segment.expiresAt)) nearest = Math.min(nearest, segment.expiresAt);
  }
  return nearest;
}
function createAccountCreditCache(dataDir) {
  const file = path.join(dataDir, 'account-credit-cache.json');
  const entries = new Map();
  // 老文件没有 updatedAt：回退到文件 mtime。既不能把所有老条目当新鲜
  // （那会让 `-` 永远补不上），也不能全当过期（会让刚写过的缓存被重复拉一遍）。
  let fileMtimeMs = 0;
  try {
    const stat = fs.statSync(file);
    if (Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0) fileMtimeMs = Math.floor(stat.mtimeMs);
  } catch (_) { /* Missing cache file: nothing to read a timestamp from. */ }
  try {
    for (const [uid, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !value || typeof value !== 'object') continue;
      const updatedAt = Number.isFinite(value.updatedAt) && value.updatedAt > 0 ? value.updatedAt : fileMtimeMs;
      entries.set(uid, { data: projection({ credits: value.credits, unlimited: value.creditUnlimited, segments: value.creditSegments }), updatedAt });
    }
  } catch (_) { /* A missing or corrupt optional cache is safe to discard. */ }
  function get(uid) { return entries.has(uid) ? structuredClone(entries.get(uid).data) : {}; }
  // 供 /api/accounts 判断「要不要补拉」：没有条目、条目是查不到钱的空壳、
  // 或者写入时间早于 TTL，都算过期。credits=null 但 unlimited 的账号不算。
  function isStale(uid, ttlMs, now = Date.now()) {
    if (!entries.has(uid)) return true;
    const entry = entries.get(uid);
    if (entry.data.credits === null && entry.data.creditUnlimited !== true) return true;
    if (!Number.isFinite(entry.updatedAt) || entry.updatedAt <= 0) return true;
    return now - entry.updatedAt >= ttlMs;
  }
  function set(uid, result, now = Date.now()) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return;
    const updatedAt = Number.isFinite(now) && now > 0 ? Math.floor(now) : Date.now();
    entries.set(uid, { data: projection(result), updatedAt });
    fs.mkdirSync(dataDir, { recursive: true });
    const serialized = {};
    for (const [key, entry] of entries) serialized[key] = Object.assign({}, entry.data, { updatedAt: entry.updatedAt });
    replaceFileWithRetry(file, JSON.stringify(serialized), 0o600);
  }
  function order(accounts) {
    // Capture all keys before the first request; refreshed balances cannot move
    // remaining accounts while this loop is running. Unknown expiry goes last.
    return accounts.map((account, index) => ({ account, index, expiry: nearestExpiry(get(account.uid)) }))
      .sort((a, b) => a.expiry === b.expiry ? a.index - b.index : a.expiry - b.expiry)
      .map(item => item.account);
  }
  return { get, set, isStale, order };
}
module.exports = { createAccountCreditCache };
