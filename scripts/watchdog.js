#!/usr/bin/env node
/**
 * WorkDaddy Windows watchdog.
 *
 * 拓扑（B：不同 profile 可并行，同一 profile 只有一个后台实例）：
 *
 *   profile 锁（47932-47935）
 *        │  一个 profile 一把，与 profile 一一对应；不同 profile 互不影响
 *        ▼
 *   watchdog ──IPC──▶ daemon
 *        │              │
 *        │              └─ 通道断开 = watchdog 消失 ⇒ 自行退出（不依赖 SIGTERM：
 *        │                 Windows 上强杀进程不会执行任何 handler）
 *        └─ 启动前再探一次「本 profile 的 /api/status 是否还活着」：
 *           上一个 watchdog 被强杀时它的 daemon 可能还在退出路上，
 *           不等它消失就 spawn，新 daemon 会落到备用 UI 端口，
 *           同一个 profile 就出现两个后台服务。
 *
 * The loopback lock belongs to the OS and disappears automatically when this
 * process exits. watchdog.pid is only a hint for the native install helper;
 * it is never trusted on its own for process termination. watchdog-state.json
 * 是给托盘 StopWd 用的所有权记录（profile / appDir / dataDir / 两个 PID / 状态）。
 */
'use strict';

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { getProfile, profileDataDir, isValidProfileId, isFullWindowsPath } = require('./profiles.js');
const { PROFILE_UI_PORTS } = require('./ui-port.js');

// 启动前的硬校验：watchdog 是「托盘 / 快捷方式 → 后台服务」这条链的最后一环，
// 走到这里还带着非法 profile 或相对数据目录，就说明上游传错了。宁可这里退出并
// 写清楚原因，也不能让 daemon 落到默认 profile 或某个相对路径下去写用户数据。
function failFast(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { process.stderr.write(line); } catch (_) {}
  process.exit(2);
}

// 读整数环境变量：未设置/非法/越界一律回退默认值（空字符串不算 0）。
function envInt(name, fallback, min, max) {
  const text = String(process.env[name] == null ? '' : process.env[name]).trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

const RAW_PROFILE = String(process.env.WBSWITCH_PROFILE || '').trim();
if (RAW_PROFILE && !isValidProfileId(RAW_PROFILE)) {
  failFast(`WBSWITCH_PROFILE 非法：${RAW_PROFILE}（只接受 workbuddy-cn / workbuddy-ai / codebuddy-cn / codebuddy-intl）`);
}
const RAW_DATA_DIR = String(process.env.WBSWITCH_DATA_DIR || '').trim();
if (RAW_DATA_DIR) {
  // Windows 判完整绝对路径（C:foo / \foo 都算相对）；POSIX 用 path.isAbsolute
  const ok = process.platform === 'win32'
    ? isFullWindowsPath(RAW_DATA_DIR)
    : path.isAbsolute(RAW_DATA_DIR);
  if (!ok) failFast(`WBSWITCH_DATA_DIR 不是完整的绝对路径：${RAW_DATA_DIR}`);
}

let PROFILE;
try {
  PROFILE = getProfile(RAW_PROFILE || 'workbuddy-cn');
} catch (error) {
  failFast(error && error.message ? error.message : String(error));
}
const DATA_DIR = RAW_DATA_DIR || profileDataDir(PROFILE);
const APP_DIR = path.resolve(__dirname, '..');
const PID_FILE = path.join(DATA_DIR, 'watchdog.pid');
const STATE_FILE = path.join(DATA_DIR, 'watchdog-state.json');
const LOG_FILE = path.join(DATA_DIR, 'watchdog.log');
const DAEMON_FILE = path.join(__dirname, 'daemon.js');
// 一个 profile 一把锁，与 profile 一一对应。旧版（<=1.3.1）用同一张表，所以
// 「新旧版本同 profile」天然互斥；不同 profile 是不同端口，可以同时跑。
const PROFILE_LOCK_PORTS = ({'workbuddy-cn':47932,'workbuddy-ai':47933,'codebuddy-cn':47934,'codebuddy-intl':47935});
// 测试注入：直接指定本实例的 profile 锁端口。自动化测试不能抢真实服务正在用的
// 47932-47935，也不能让四个 profile 抢同一把锁。
const LOCK_PORT = (() => {
  const raw = Number(process.env.WORKDADDY_LOCK_PORT || 0);
  if (Number.isInteger(raw) && raw >= 1024 && raw <= 65535) return raw;
  return PROFILE_LOCK_PORTS[PROFILE.id];
})();
// 探测「本 profile 是否已有 daemon 在跑」用的端口：与 daemon.js 的 UI_PORT_BASE
// 同源（WBSWITCH_PORT 显式指定时 daemon 不启用备用端口，这里也只探那一个）。
const UI_PROBE_PORTS = (() => {
  const pinned = Number(process.env.WBSWITCH_PORT || 0);
  if (Number.isInteger(pinned) && pinned >= 1024 && pinned <= 65535) return [pinned];
  return PROFILE_UI_PORTS[PROFILE.id] || [];
})();
// 等上一个 daemon 退出的上限；测试可以调小（0 = 只探一次，不等）。
const ORPHAN_WAIT_MS = envInt('WORKDADDY_ORPHAN_WAIT_MS', 8000, 0, 60000);
const DAEMON_EXIT_WAIT_MS = envInt('WORKDADDY_DAEMON_EXIT_WAIT_MS', 6000, 0, 60000);

const STATE = {
  state: 'STARTING',
  reason: '',
  daemonPid: null,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let child = null;
let stopping = false;
let restartDelay = 3000;
let restartTimer = null;
let shutdownTimer = null;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  try { process.stdout.write(line); } catch (_) {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 状态文件：托盘 StopWd 靠它证明「这个 watchdog 属于我这一份安装、这一个 profile」。
// 只写本 profile 自己的 DATA_DIR，不写全局位置。
function writeState(next) {
  if (next) Object.assign(STATE, next);
  STATE.updatedAt = new Date().toISOString();
  const payload = {
    schema: 1,
    profile: PROFILE.id,
    pid: process.pid,
    daemonPid: STATE.daemonPid || null,
    appDir: APP_DIR,
    dataDir: DATA_DIR,
    state: STATE.state,
    reason: STATE.reason || '',
    startedAt: STATE.startedAt,
    updatedAt: STATE.updatedAt,
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temporary = STATE_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
    try { fs.renameSync(temporary, STATE_FILE); } catch (_) {
      try { fs.unlinkSync(STATE_FILE); } catch (_) {}
      fs.renameSync(temporary, STATE_FILE);
    }
  } catch (_) {}
}

function writePidFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = PID_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(temporary, String(process.pid), 'utf8');
  try {
    fs.renameSync(temporary, PID_FILE);
  } catch (_) {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    fs.renameSync(temporary, PID_FILE);
  }
}

function removePidFile() {
  try {
    if (Number(fs.readFileSync(PID_FILE, 'utf8').trim()) === process.pid) fs.unlinkSync(PID_FILE);
  } catch (_) {}
}

/* ------------------------------ 上一个 daemon ------------------------------ */

// 只问 profile 身份，不要 token：这里不需要区分安装实例，只需要知道
// 「本 profile 的后台服务还在不在」。端口能连上不代表是 daemon，必须看 body。
function probeProfileDaemon(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 400 }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 8192) {
            try { request.destroy(); } catch (_) {}
            done(false);
          }
        });
        response.on('end', () => {
          try {
            const status = JSON.parse(body);
            done(Boolean(status && status.profile && status.profile.id === PROFILE.id));
          } catch (_) { done(false); }
        });
      });
    } catch (_) {
      done(false);
      return;
    }
    request.on('timeout', () => { try { request.destroy(); } catch (_) {} done(false); });
    request.on('error', () => done(false));
  });
}

async function liveProfileDaemonPort() {
  for (const port of UI_PROBE_PORTS) {
    if (await probeProfileDaemon(port)) return port;
  }
  return 0;
}

// 返回 0 表示「已经没有本 profile 的 daemon」；否则返回仍占着端口的那个。
async function waitForNoProfileDaemon(budgetMs) {
  const started = Date.now();
  let port = await liveProfileDaemonPort();
  while (port && Date.now() - started < budgetMs) {
    await delay(250);
    port = await liveProfileDaemonPort();
  }
  return port;
}

/* -------------------------------- daemon -------------------------------- */

function startDaemon() {
  if (stopping) return;
  const args = ['--experimental-sqlite', DAEMON_FILE];
  log('启动 daemon: ' + process.execPath + ' ' + args.join(' '));
  writeState({ state: 'STARTING' });
  try {
    // 第 4 个 stdio 是 IPC 通道：它既是「谁是我父进程」的证据，也是父进程消失时
    // 子进程唯一能收到的通知（Windows 上强杀不投递信号）。
    child = spawn(process.execPath, args, {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      env: Object.assign({}, process.env, { WORKDADDY_SUPERVISED: '1' }),
    });
  } catch (error) {
    log('daemon 启动失败: ' + (error && error.message ? error.message : String(error)));
    writeState({ state: 'FAILED', reason: 'spawn-failed', daemonPid: null });
    return;
  }
  const current = child;
  writeState({ daemonPid: current.pid, state: 'STARTING' });
  log('daemon 已启动 pid=' + current.pid + '（IPC 托管）');
  current.on('message', (message) => {
    if (!message || current !== child) return;
    if (message.type === 'state' && message.state === 'RUNNING') {
      writeState({ state: 'RUNNING', daemonPid: current.pid, reason: '' });
    } else if (message.type === 'state' && message.state === 'STOPPING') {
      log('daemon 报告正在停止: ' + (message.reason || ''));
    }
  });
  current.on('error', (error) => log('daemon 启动错误: ' + (error && error.message ? error.message : String(error))));
  current.on('exit', (code, signal) => {
    child = null;
    STATE.daemonPid = null;
    if (stopping) {
      log('daemon 已退出（watchdog 停止中）');
      return;
    }
    const wait = restartDelay;
    writeState({ state: 'STARTING', daemonPid: null, reason: 'daemon-exited:' + code });
    log('daemon 退出 code=' + code + ' signal=' + signal + '，' + wait + 'ms 后重启');
    restartTimer = setTimeout(startDaemon, wait);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });
  setTimeout(() => { restartDelay = 3000; }, 60000);
}

function finishShutdown(reason) {
  if (shutdownTimer) { clearInterval(shutdownTimer); shutdownTimer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  removePidFile();
  try { lockServer.close(); } catch (_) {}
  writeState({ state: 'STOPPED', daemonPid: null, reason: reason });
  log('watchdog 已停止（' + reason + '）');
  process.exit(0);
}

// 停止顺序很重要：先请 daemon 自己退出，等它真的没了再释放锁退出。
// 反过来（先放手锁）新实例会立刻拿到锁，而旧 daemon 还占着 UI 端口。
function shutdown() {
  if (stopping) return;
  stopping = true;
  writeState({ state: 'STOPPING', reason: 'signal' });
  log('watchdog 收到停止信号，结束 daemon');
  if (!child) {
    finishShutdown('no-daemon');
    return;
  }
  try { child.send({ type: 'shutdown' }); } catch (_) {}
  const deadline = Date.now() + DAEMON_EXIT_WAIT_MS;
  let forced = false;
  shutdownTimer = setInterval(() => {
    if (!child) {
      finishShutdown('daemon-exited');
      return;
    }
    if (!forced && Date.now() >= deadline) {
      forced = true;
      log('daemon 未在超时内退出，强制结束 pid=' + child.pid);
      try { child.kill(); } catch (_) {}
      return;
    }
    if (forced && Date.now() >= deadline + 2000) {
      finishShutdown('forced');
    }
  }, 100);
}

/* --------------------------------- main --------------------------------- */

const lockServer = net.createServer();
lockServer.unref();
lockServer.once('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    log('当前 profile 的 watchdog 已在运行（lock ' + LOCK_PORT + ' 被占用），本实例退出');
    try { process.stderr.write(`[${new Date().toISOString()}] 当前 profile 的 watchdog 已在运行（lock ${LOCK_PORT} 被占用）\n`); } catch (_) {}
    process.exit(3);
  }
  throw error;
});

function listenProfileLock() {
  // 冲突/异常统一由上面挂的 once('error') 处理（exit 3），这里只等成功。
  return new Promise((resolve) => {
    lockServer.listen({ host: '127.0.0.1', port: LOCK_PORT, exclusive: true }, resolve);
  });
}

async function main() {
  await listenProfileLock();
  writePidFile();
  writeState({ state: 'STARTING', reason: '' });
  log('watchdog 已获取 profile 锁 port=' + LOCK_PORT + ' pid=' + process.pid + ' profile=' + PROFILE.id);
  const busyPort = await waitForNoProfileDaemon(ORPHAN_WAIT_MS);
  if (busyPort) {
    log('同 Profile 的后台服务仍在运行（ui=' + busyPort + '），本实例不启动第二个 daemon');
    writeState({ state: 'FAILED', reason: 'profile-daemon-alive:' + busyPort });
    process.exit(4);
  }
  startDaemon();
}

main().catch((error) => {
  const code = error && error.code ? error.code : '';
  if (code === 'EADDRINUSE') {
    log('当前 profile 的 watchdog 已在运行（lock ' + LOCK_PORT + ' 被占用），本实例退出');
    process.exit(3);
  }
  log('watchdog 启动失败: ' + (error && error.message ? error.message : String(error)));
  process.exit(2);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', removePidFile);
