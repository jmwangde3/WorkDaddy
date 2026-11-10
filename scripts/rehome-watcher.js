'use strict';
/**
 * rehome-watcher.js — 账号变化监听器。
 *
 * 覆盖所有不经过 /api/switch 的切号路径：
 *   - WorkBuddy 客户端内退出 / 登录另一个账号
 *   - WorkDaddy「无感登录」新账号
 *   - 外部替换 auth 文件
 * 这些路径只会触发 daemon 的「自动备份账号」，不会调用 /api/switch，
 * 因此挂在 /api/switch 上的 rehome 钩子不会被触发。本监听器直接盯 auth 文件。
 *
 * 用轮询而非 fs.watch：auth 文件是「临时文件 + 原子替换」写入，
 * Windows 上 watch 事件容易丢；uid 是明文，读取开销极小。
 *
 * 同时从 CDP target URL 的 accountSnapshot（双重 URL 编码 JSON）取明文账号信息，
 * 写入 <dataDir>/account-display.json，供 listAccounts 在信封取钥失败时兜底显示。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const DISPLAY_FILE = 'account-display.json';

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

function createAccountWatcher(options = {}) {
  const {
    authPath,
    dataDir,
    cdpPort = 9222,
    intervalMs = 2000,
    enableDisplay = true,
    log = () => {},
    onSwitch = async () => {},
  } = options;
  let lastUid = null;
  let timer = null;
  let busy = false;

  async function refreshDisplay() {
    if (!enableDisplay) return null;
    try {
      const snap = await readAccountSnapshot(cdpPort);
      return writeDisplay(dataDir, snap);
    } catch (_) { return null; }
  }

  async function tick() {
    if (busy) return;
    const uid = readUid(authPath);
    if (!uid) return;
    if (lastUid === null) {           // 首次只记录，避免 daemon 重启就写库
      lastUid = uid;
      await refreshDisplay();
      return;
    }
    if (uid === lastUid) return;

    const prev = lastUid;
    lastUid = uid;
    busy = true;
    try {
      log(`[rehome] 账号变化 ${prev} -> ${uid}`);
      const result = await onSwitch(uid, prev);
      log(`[rehome] watcher 接管完成 uid=${uid} affected=${(result && result.affected) || 0}` +
        (result && result.error ? ` error=${result.error}` : ''));
      await refreshDisplay();
    } catch (e) {
      log(`[rehome] watcher 失败: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      tick().catch(() => {});
      timer = setInterval(() => tick().catch(() => {}), intervalMs);
      if (timer.unref) timer.unref();
      log(`[rehome] 账号变化监听已启动 interval=${intervalMs}ms auth=${authPath}`);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    current() { return lastUid; },
  };
}

module.exports = { createAccountWatcher, readUid, readAccountSnapshot, writeDisplay, DISPLAY_FILE };
