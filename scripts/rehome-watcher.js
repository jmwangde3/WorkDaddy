'use strict';
/**
 * rehome-watcher.js — 账号变化监听器（带状态机与失败重试）。
 *
 * 覆盖所有不经过 /api/switch 的切号路径：
 *   - WorkBuddy 客户端内退出 / 登录另一个账号
 *   - WorkDaddy「无感登录」新账号
 *   - 外部替换 auth 文件
 *
 * 用轮询而非 fs.watch：auth 文件是「临时文件 + 原子替换」写入，
 * Windows 上 watch 事件容易丢；uid 是明文，读取开销极小。
 *
 * 状态机（只有 succeeded 才推进 lastConfirmedUid）：
 *   idle → detecting → pending → running → succeeded
 *                                    └──→ retrying → running …
 *   任何失败都不会丢掉目标账号：按 1s / 2s / 4s / 8s … 退避重试，上限 60s。
 *   同一时刻只有一个在飞任务、一个定时器；快速连续切号会合并到最新目标。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const DISPLAY_FILE = 'account-display.json';
const STATES = Object.freeze([
  'idle', 'detecting', 'pending', 'running', 'retrying', 'succeeded', 'failed', 'blocked',
]);
const MAX_BACKOFF_MS = 60000;

function readUid(authPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const acct = raw.account || (Array.isArray(raw.accounts) && raw.accounts[0]);
    if (acct && acct.uid) return String(acct.uid);
  } catch (_) {}
  return null;
}

function getJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** CDP /json/list 的 target.url 里带 accountSnapshot=<双重编码 JSON>。 */
async function readAccountSnapshot(cdpPort) {
  const targets = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
  for (const t of targets || []) {
    let raw = '';
    try { raw = new URL(String(t.url || '')).searchParams.get('accountSnapshot') || ''; } catch (_) { continue; }
    if (!raw) continue;
    let text = raw;
    try { text = decodeURIComponent(text); } catch (_) {}
    try {
      const snap = JSON.parse(text);
      if (snap && snap.uid) return snap;
    } catch (_) {}
  }
  return null;
}

function writeDisplay(dataDir, snap) {
  if (!snap || !snap.uid) return null;
  const file = path.join(dataDir, DISPLAY_FILE);
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
  all[snap.uid] = {
    nickname: String(snap.nickname || ''),
    type: String(snap.type || ''),
    editionType: String(snap.editionType || ''),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return all[snap.uid];
}

/** 指数退避：第 1 次 1s、第 2 次 2s、第 3 次 4s…… 上限 60s。 */
function backoffDelay(attempt, baseMs = 1000, maxMs = MAX_BACKOFF_MS) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(maxMs, baseMs * Math.pow(2, Math.min(n, 10)));
}

function createAccountWatcher(options = {}) {
  const {
    authPath,
    dataDir,
    cdpPort = 9222,
    intervalMs = 2000,
    enableDisplay = true,
    log = () => {},
    onSwitch = async () => {},
    inspectAccounts = null,
    retryBaseMs = 1000,
    maxBackoffMs = MAX_BACKOFF_MS,
  } = options;

  let state = 'idle';
  let lastConfirmedUid = null;
  let targetUid = null;
  let attempts = 0;
  let lastError = null;
  let nextDelayMs = 0;
  let lastResult = null;

  let pollTimer = null;
  let attemptTimer = null;
  let running = false;
  let stopped = true;

  function setState(next, detail) {
    if (state === next) return;
    state = next;
    if (detail) log(`[rehome] 状态 ${next} ${detail}`);
  }

  function clearAttemptTimer() {
    if (attemptTimer) { clearTimeout(attemptTimer); attemptTimer = null; }
  }

  function schedule(delayMs, why) {
    clearAttemptTimer();
    nextDelayMs = Math.max(0, Number(delayMs) || 0);
    setState(nextDelayMs > 0 ? 'retrying' : 'pending', `delay=${nextDelayMs}ms ${why || ''}`.trim());
    attemptTimer = setTimeout(() => { attemptTimer = null; runAttempt().catch(() => {}); }, nextDelayMs);
    if (attemptTimer.unref) attemptTimer.unref();
  }

  async function refreshDisplay() {
    if (!enableDisplay) return null;
    try {
      const snap = await readAccountSnapshot(cdpPort);
      return writeDisplay(dataDir, snap);
    } catch (_) { return null; }
  }

  async function runAttempt() {
    if (stopped || running) return;
    const uid = targetUid;
    if (!uid) { setState('idle'); return; }
    running = true;
    setState('running', `uid=${uid} attempt=${attempts + 1}`);
    let result = null;
    let error = null;
    try {
      result = await onSwitch(uid, lastConfirmedUid);
    } catch (e) {
      error = e;
    }
    running = false;
    if (stopped) return;

    const ok = !error && result && result.ok !== false;
    if (ok) {
      lastConfirmedUid = uid;
      attempts = 0;
      lastError = null;
      nextDelayMs = 0;
      lastResult = result;
      setState('succeeded', `uid=${uid} affected=${(result && result.affected) || 0}`);
      log(`[rehome] watcher 接管完成 uid=${uid} affected=${(result && result.affected) || 0}` +
        (result && result.error ? ` error=${result.error}` : ''));
      await refreshDisplay();
      // 接管期间又切到了别的账号：立刻处理最新目标。
      if (targetUid && targetUid !== uid) schedule(0, 'new-target-after-success');
      else { targetUid = null; setState('idle'); }
      return;
    }

    attempts += 1;
    lastError = (error && error.message) || (result && result.error) || 'unknown';
    // 「语义未确认」「配置不允许」这类是**永久性阻断**，重试一万次也不会变。
    // 重试只对瞬时故障（数据库忙、文件正在写）有意义；阻塞态直接停在这里等人处理。
    if (!error && result && result.retryable === false) {
      lastError = result.skipped || result.error || 'blocked';
      lastResult = result;
      attempts = 0;
      targetUid = null;
      setState('blocked', `uid=${uid} reason=${lastError}`);
      log(`[rehome] watcher 停止重试：${lastError}（需人工处理）`);
      return;
    }
    setState('failed', `uid=${uid} error=${lastError}`);
    log(`[rehome] watcher 失败（第 ${attempts} 次）: ${lastError}`);
    // 失败不丢目标：按退避继续重试，直到成功或账号再次变化。
    if (targetUid === uid) schedule(backoffDelay(attempts - 1, retryBaseMs, maxBackoffMs), 'retry');
    else if (targetUid) schedule(0, 'new-target-after-failure');
  }

  async function tick() {
    if (stopped || running) return;
    const uid = readUid(authPath);
    if (!uid) {                                  // 文件暂时不可读 / 正在替换：保持现状
      return;
    }
    if (lastConfirmedUid === null) {             // 首次只记录基线，避免 daemon 重启就写库
      lastConfirmedUid = uid;
      setState('idle', `baseline=${uid}`);
      await refreshDisplay();
      return;
    }
    if (uid === lastConfirmedUid && !targetUid) {
      if (state !== 'idle') setState('idle');
      return;
    }
    if (uid === targetUid) return;               // 已在处理（含重试等待）同一目标

    const prev = lastConfirmedUid;
    log(`[rehome] 账号变化 ${prev} -> ${uid}`);
    setState('detecting', `uid=${uid}`);
    targetUid = uid;
    attempts = 0;
    lastError = null;
    schedule(0, 'detected');
  }

  return {
    start() {
      if (pollTimer) return;
      stopped = false;
      tick().catch(() => {});
      pollTimer = setInterval(() => tick().catch(() => {}), intervalMs);
      if (pollTimer.unref) pollTimer.unref();
      log(`[rehome] 账号变化监听已启动 interval=${intervalMs}ms auth=${authPath}`);
    },
    stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      clearAttemptTimer();
      targetUid = null;
      nextDelayMs = 0;
      setState('idle');
    },
    current() { return lastConfirmedUid; },
    target() { return targetUid; },
    state() {
      return {
        state, lastConfirmedUid, targetUid, attempts, lastError, nextDelayMs,
        running, stopped, lastResult,
      };
    },
    /** 立即重试当前目标（手动排障用）。 */
    retryNow() { if (targetUid) schedule(0, 'manual'); },
    /**
     * 启动恢复检查：默认只读，不改数据库。
     * `autoRun: true` 时才真正执行一次接管（需要调用方显式开启）。
     */
    async reconcile(opts = {}) {
      const uid = readUid(authPath);
      if (!uid) return { ok: false, error: 'uid-unreadable' };
      let distribution = [];
      if (typeof inspectAccounts === 'function') {
        try { distribution = await inspectAccounts(); } catch (e) { return { ok: false, error: e.message }; }
      }
      const pending = distribution.filter((d) => String(d.uid) !== uid && Number(d.count) > 0);
      const wouldAffect = pending.reduce((sum, d) => sum + Number(d.count), 0);
      const report = {
        ok: true, currentUid: uid, distribution, pending, wouldAffect,
        dryRun: opts.autoRun !== true, applied: false,
      };
      if (opts.autoRun !== true || !wouldAffect) return report;
      const result = await onSwitch(uid, null);
      if (result && result.ok !== false) lastConfirmedUid = uid;
      return { ...report, applied: true, result };
    },
  };
}

module.exports = {
  createAccountWatcher, readUid, readAccountSnapshot, writeDisplay,
  backoffDelay, DISPLAY_FILE, STATES, MAX_BACKOFF_MS,
};
