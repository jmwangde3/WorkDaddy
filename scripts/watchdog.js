#!/usr/bin/env node
/**
 * WorkDaddy Windows watchdog.
 *
 * The loopback lock belongs to the OS and disappears automatically when this
 * process exits. watchdog.pid is only a hint for the native install helper;
 * it is never trusted on its own for process termination.
 *
 * 单运行实例（约定 A：可以装多份，但同一台机器同时只允许一个后台服务）：
 *   1. 全局锁 47931 —— 与 profile 无关，新版本之间靠互斥；
 *   2. 旧版兼容探测 47932-47935 —— 1.3.1 及更早只有 per-profile 锁，
 *      它们不认全局锁，所以启动前必须逐个探一遍，命中就拒绝启动；
 *   3. profile 锁仍是原来的 47932-47935 —— 旧版 watchdog 看到它会自己退出，
 *      保持「同一 profile 不会双开」这条老保证。
 * 锁冲突一律 exit 3，并在日志里写清是哪个端口：托盘据此报告启动失败，
 * 不会把「第二个实例被挡下」当成启动成功。
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { getProfile, profileDataDir, isValidProfileId, isFullWindowsPath } = require('./profiles.js');

// 启动前的硬校验：watchdog 是「托盘 / 快捷方式 → 后台服务」这条链的最后一环，
// 走到这里还带着非法 profile 或相对数据目录，就说明上游传错了。宁可这里退出并
// 写清楚原因，也不能让 daemon 落到默认 profile 或某个相对路径下去写用户数据。
function failFast(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { process.stderr.write(line); } catch (_) {}
  process.exit(2);
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
const PID_FILE = path.join(DATA_DIR, 'watchdog.pid');
const LOG_FILE = path.join(DATA_DIR, 'watchdog.log');
const DAEMON_FILE = path.join(__dirname, 'daemon.js');
const PROFILE_LOCK_PORTS = ({'workbuddy-cn':47932,'workbuddy-ai':47933,'codebuddy-cn':47934,'codebuddy-intl':47935});
// 全局服务锁：与 profile 无关的「只允许一个后台服务」。
const GLOBAL_LOCK_BASE = 47931;
// 测试注入：WORKDADDY_LOCK_BASE 把 5 个锁端口整体平移，互不相同的相对关系不变。
// 自动化测试不能去抢真实服务正在用的 47931-47935（那会把用户的服务挡掉）。
const LOCK_OFFSET = (() => {
  const raw = Number(process.env.WORKDADDY_LOCK_BASE || 0);
  if (!Number.isInteger(raw) || raw < 1024 || raw > 65000) return 0;
  return raw - GLOBAL_LOCK_BASE;
})();
const GLOBAL_LOCK_PORT = GLOBAL_LOCK_BASE + LOCK_OFFSET;
const LOCK_PORT = PROFILE_LOCK_PORTS[PROFILE.id] + LOCK_OFFSET;
// 旧版（<=1.3.1）只监听上面那张表里的端口，不认全局锁。
const LEGACY_LOCK_PORTS = Object.keys(PROFILE_LOCK_PORTS).map((key) => PROFILE_LOCK_PORTS[key] + LOCK_OFFSET);

let child = null;
let stopping = false;
let restartDelay = 3000;
let globalLock = null;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  try { process.stdout.write(line); } catch (_) {}
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

function startDaemon() {
  if (stopping) return;
  const args = ['--experimental-sqlite', DAEMON_FILE];
  log('启动 daemon: ' + process.execPath + ' ' + args.join(' '));
  child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true, env: process.env });
  child.on('error', (error) => log('daemon 启动错误: ' + error.message));
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) {
      log('daemon 已退出（watchdog 停止中）');
      return;
    }
    const delay = restartDelay;
    log('daemon 退出 code=' + code + ' signal=' + signal + '，' + delay + 'ms 后重启');
    setTimeout(startDaemon, delay);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });
  setTimeout(() => { restartDelay = 3000; }, 60000);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  log('watchdog 收到停止信号，结束 daemon');
  if (child) {
    try { child.kill(); } catch (_) {}
  }
  setTimeout(() => {
    removePidFile();
    try { lockServer.close(); } catch (_) {}
    try { if (globalLock) globalLock.close(); } catch (_) {}
    process.exit(0);
  }, 800);
}

// 端口上是否有人在听。只用来发现「旧版 watchdog 还在跑」，不用于身份判断。
function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve(value);
    };
    socket.setTimeout(400);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const lockServer = net.createServer();
lockServer.unref();
lockServer.once('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    log('当前 profile 的 watchdog 已在运行（lock ' + LOCK_PORT + ' 被占用），本实例退出');
    process.exit(3);
  }
  throw error;
});

function listenGlobal() {
  return new Promise((resolve) => {
    globalLock = net.createServer();
    globalLock.unref();
    globalLock.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        log('已有 WorkDaddy 后台服务在运行（单实例锁 ' + GLOBAL_LOCK_PORT + ' 被占用），本实例退出');
        process.exit(3);
      }
      throw error;
    });
    globalLock.listen({ host: '127.0.0.1', port: GLOBAL_LOCK_PORT, exclusive: true }, resolve);
  });
}

function listenProfileLock() {
  // 冲突/异常统一由上面挂的 once('error') 处理（exit 3），这里只等成功。
  return new Promise((resolve) => {
    lockServer.listen({ host: '127.0.0.1', port: LOCK_PORT, exclusive: true }, resolve);
  });
}

async function acquireLocks() {
  await listenGlobal();
  // 旧版服务不认全局锁：逐个探，发现就退出（exit 3），不做「先起来再说」。
  for (const port of LEGACY_LOCK_PORTS) {
    if (await portListening(port)) {
      log('检测到旧版 WorkDaddy 后台服务仍在运行（lock ' + port + '），请先关闭它再启动本实例');
      process.exit(3);
    }
  }
  await listenProfileLock();
  writePidFile();
  log('watchdog 已获取单实例锁 global=' + GLOBAL_LOCK_PORT + ' profile=' + LOCK_PORT + ' pid=' + process.pid);
  startDaemon();
}

acquireLocks().catch((error) => {
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
