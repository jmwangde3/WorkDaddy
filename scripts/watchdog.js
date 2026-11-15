#!/usr/bin/env node
/**
 * WorkDaddy Windows watchdog.
 *
 * The loopback lock belongs to the OS and disappears automatically when this
 * process exits. watchdog.pid is only a hint for the native install helper;
 * it is never trusted on its own for process termination.
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
const LOCK_PORT = ({'workbuddy-cn':47932,'workbuddy-ai':47933,'codebuddy-cn':47934,'codebuddy-intl':47935})[PROFILE.id];

let child = null;
let stopping = false;
let restartDelay = 3000;

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
    process.exit(0);
  }, 800);
}

const lockServer = net.createServer();
lockServer.unref();
lockServer.once('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    log('当前 profile 的 watchdog 已在运行，本实例退出');
    process.exit(0);
  }
  throw error;
});
lockServer.listen({ host: '127.0.0.1', port: LOCK_PORT, exclusive: true }, () => {
  writePidFile();
  log('watchdog 已获取回环单实例锁 port=' + LOCK_PORT + ' pid=' + process.pid);
  startDaemon();
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', removePidFile);
