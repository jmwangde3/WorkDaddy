'use strict';
/**
 * B 架构（不同 profile 并行、同 profile 单实例）的测试夹具。
 *
 * 每个 ctx = 一份「安装」：临时 app 目录里放的是**仓库里真正的** watchdog.js /
 * profiles.js / ui-port.js / lifecycle-child.js，只把 daemon.js 换成替身，
 * 因此测的是生产代码的锁、状态文件和 IPC 生命周期，而不是 mock 出来的结论。
 *
 * 替身 daemon 复用生产模块 lifecycle-child.js（IPC 断开即退出），行为可用环境变量调：
 *   STUB_MODE=fail            启动即退出（码 7）
 *   STUB_STARTUP_DELAY_MS     延迟 N ms 再监听端口（模拟「启动中被强杀」）
 *   STUB_NO_LISTEN=1          完全不监听（模拟卡住不响应 shutdown 的 daemon）
 *   STUB_EXIT_AFTER_MS        N ms 后自行退出（模拟 daemon 崩溃）
 *
 * 所有目录都在仓库 tmp/ 下；进程只按本测试记录的 PID 清理。
 */
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const scriptsSrc = path.join(repo, 'scripts');
const tmpBase = path.join(repo, 'tmp');

const SHARED_FILES = ['watchdog.js', 'profiles.js', 'platform.js', 'workbuddy-target.js', 'ui-port.js', 'lifecycle-child.js'];

const STUB_DAEMON = `'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { installChildLifecycle } = require('./lifecycle-child.js');

const outDir = process.env.STUB_OUT_DIR || path.resolve(__dirname, '..', '..', 'out');
fs.mkdirSync(outDir, { recursive: true });
const profile = process.env.WBSWITCH_PROFILE || '';
const dataDir = process.env.WBSWITCH_DATA_DIR || '';
const port = Number(process.env.WBSWITCH_PORT || 0);
const mode = process.env.STUB_MODE || 'ok';
const delay = Number(process.env.STUB_STARTUP_DELAY_MS || 0);
const exitAfter = Number(process.env.STUB_EXIT_AFTER_MS || 0);
const shutdownDelay = Number(process.env.STUB_SHUTDOWN_DELAY_MS || 0);
const ignoreShutdown = process.env.STUB_IGNORE_SHUTDOWN === '1';
const grandchild = process.env.STUB_GRANDCHILD === '1';
const surviveKill = process.env.STUB_SURVIVE_KILL === '1';
const noListen = process.env.STUB_NO_LISTEN === '1';
const lockFile = path.join(dataDir, '.daemon.lock');
const record = (name, payload) => {
  try { fs.writeFileSync(path.join(outDir, name), JSON.stringify(payload, null, 2)); } catch (_) {}
};

record('daemon-' + process.pid + '.json', {
  pid: process.pid, ppid: process.ppid, profile, dataDir, port, mode, grandchild,
  startedAt: new Date().toISOString(),
});

// 生产 daemon 在数据目录写的单实例锁：托盘 StopWd 靠它证明「这个 pid 就是本目录
// 的那个 daemon」。替身必须照做，否则「有归属证明才允许强杀」这条规则测不出来。
//
// 关键细节：生产实现在写完内容后把句柄**降级成只读**（写句柄会让托盘以
// FileShare.Read 打开时撞上共享冲突，于是永远读不到 pid）。替身也照做 —— 之前是
// 写完就关，掩盖了「锁根本读不了」这个事实。
const stubStartedAt = new Date().toISOString();
let lockFd = null;
let ownsLock = false;
if (!grandchild) {
  try {
    lockFd = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: stubStartedAt, version: 'stub' }), 'utf8');
    ownsLock = true;
    fs.closeSync(lockFd);
    lockFd = fs.openSync(lockFile, 'r');
  } catch (_) {
    try { if (lockFd !== null) fs.closeSync(lockFd); } catch (_) {}
    lockFd = null;
  }
}
const releaseLock = () => {
  if (!ownsLock) return;
  ownsLock = false;
  if (lockFd !== null) { try { fs.closeSync(lockFd); } catch (_) {} lockFd = null; }
  try { fs.unlinkSync(lockFile); } catch (_) {}
};

// STUB_IGNORE_SHUTDOWN：模拟「不响应 shutdown / IPC 断开」的 daemon（旧版没有 IPC
// 托管时就是这样）。只吞掉停止信号，RUNNING 状态照常上报 —— 否则 watchdog 永远
// 不知道它起来了，测的就不是「停不下来」而是「起不来」。
const life = ignoreShutdown
  ? {
      managed: false,
      markRunning() {
        record('state-' + process.pid + '-RUNNING.json', { managed: false, state: 'RUNNING', pid: process.pid });
        try { if (process.send && process.connected) process.send({ type: 'state', state: 'RUNNING', pid: process.pid, reason: '' }); } catch (_) {}
      },
      stop() {},
      snapshot() { return { managed: false, state: 'RUNNING', pid: process.pid }; },
    }
  : installChildLifecycle({
      log: () => {},
      onShutdown: () => {
        releaseLock();
        // 模拟「清理需要时间」：异步 onShutdown 必须被等到，否则 50ms 就会被截断。
        return shutdownDelay > 0 ? new Promise((resolve) => setTimeout(resolve, shutdownDelay)) : undefined;
      },
      onState: (snapshot) => {
        try { record('state-' + process.pid + '-' + snapshot.state + '.json', snapshot); } catch (_) {}
        try {
          if (process.send && process.connected) process.send({ type: 'state', state: snapshot.state, pid: process.pid, reason: snapshot.reason });
        } catch (_) {}
      },
    });

process.on('exit', (code) => {
  if (!grandchild) releaseLock();
  record('exit-' + process.pid + '.json', { pid: process.pid, code, at: new Date().toISOString(), lifecycle: life.snapshot() });
});

if (mode === 'fail') { process.exit(7); }
if (exitAfter > 0) setTimeout(() => process.exit(0), exitAfter);

// 「daemon 被杀但服务还在」：父进程先正常监听，再留一个抢端口的孙进程。
function spawnSurvivor() {
  const g = spawn(process.execPath, [__filename], {
    env: Object.assign({}, process.env, { STUB_GRANDCHILD: '1', STUB_IGNORE_SHUTDOWN: '1', STUB_SURVIVE_KILL: '0' }),
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  });
  g.unref();
  record('grandchild-' + g.pid + '.json', { pid: g.pid, parent: process.pid });
}

const statusPayload = () => JSON.stringify({ ok: true, version: 'stub', profile: { id: profile }, dataDir, appDir: path.resolve(__dirname, '..') });
const handler = (req, res) => {
  const p = String(req.url || '').split('?')[0];
  if (p === '/api/status') {
    res.setHeader('content-type', 'application/json');
    res.end(statusPayload());
    return;
  }
  res.statusCode = 404;
  res.end('{}');
};

// 孙进程：一直重试直到抢到端口 —— 父进程死后它接管，模拟「daemon 被杀但服务还在」。
if (grandchild) {
  const attempt = () => {
    const s = http.createServer(handler);
    s.once('error', () => setTimeout(attempt, 100));
    s.listen(port, '127.0.0.1', () => record('listening-' + process.pid + '.json', { pid: process.pid, port, grandchild: true }));
  };
  attempt();
} else {
  const startListening = () => {
    if (noListen) return;
    const server = http.createServer(handler);
    server.listen(port, '127.0.0.1', () => {
      record('listening-' + process.pid + '.json', { pid: process.pid, port });
      life.markRunning();
      // 必须先由自己占住端口，孙进程才可能在父进程死后接管（否则两个进程抢绑定）。
      if (surviveKill) spawnSurvivor();
    });
  };
  if (delay > 0) setTimeout(startListening, delay); else startListening();
}
setInterval(() => {}, 1000);
`;

let counter = 0;
const created = [];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tmpRoot(tag) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const dir = path.join(tmpBase, `bfx-${tag}-${process.pid}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

function freePort() {
  const r = spawnSync(process.execPath, ['-e',
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
  ], { encoding: 'utf8', timeout: 10000 });
  const port = Number(String(r.stdout || '').trim());
  if (!port) throw new Error('无法分配空闲端口：' + (r.stderr || ''));
  return port;
}

function makeInstall(options) {
  const opts = options || {};
  const profile = opts.profile || 'workbuddy-cn';
  const root = tmpRoot(opts.tag || profile);
  // 允许两份「安装」共用同一个 appDir：CN 与 AI 装在一起是真实存在的布局，
  // 也是「只按目录枚举 daemon.js 会误杀」那个漏洞的前提。
  const appDir = opts.appDir ? path.resolve(opts.appDir) : path.join(root, 'app');
  const scripts = path.join(appDir, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of SHARED_FILES) {
    fs.copyFileSync(path.join(scriptsSrc, name), path.join(scripts, name));
  }
  fs.writeFileSync(path.join(scripts, 'daemon.js'), STUB_DAEMON, 'utf8');
  const dataDir = path.join(root, 'data');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'appdata'), { recursive: true });
  return {
    root,
    appDir,
    scripts,
    dataDir,
    outDir,
    profile,
    lockPort: opts.lockPort || freePort(),
    uiPort: opts.uiPort || freePort(),
    watchdogPid: 0,
    daemonPids: [],
  };
}

function baseEnv(ctx, extra) {
  return Object.assign({}, process.env, {
    WBSWITCH_PROFILE: ctx.profile,
    WBSWITCH_DATA_DIR: ctx.dataDir,
    WBSWITCH_PORT: String(ctx.uiPort),
    WORKDADDY_LOCK_PORT: String(ctx.lockPort),
    WORKDADDY_ORPHAN_WAIT_MS: '4000',
    WORKDADDY_DAEMON_EXIT_WAIT_MS: '4000',
    // 两份安装共用同一个 appDir 时，替身 daemon 不能靠「脚本位置的上一级」猜输出
    // 目录，否则两个 profile 的记录会写进同一份 out/。
    STUB_OUT_DIR: ctx.outDir,
    TEMP: path.join(ctx.root, 'tmp'),
    TMP: path.join(ctx.root, 'tmp'),
    APPDATA: path.join(ctx.root, 'appdata'),
  }, extra || {});
}

function startWatchdog(ctx, extraEnv, nodeArgs) {
  // detached：与生产一致（托盘用 Process.Start 起 watchdog，托盘退出不带走服务），
  // 同时让 watchdog 的生死只由本测试决定。非 detached 时，沙箱会在父进程退出后
  // 连带杀死整棵子树，那样「daemon 是否自己退出」就永远测不出来。
  const args = (nodeArgs || []).slice();
  args.push(path.join(ctx.scripts, 'watchdog.js'));
  const child = spawn(process.execPath, args, {
    env: baseEnv(ctx, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true,
  });
  ctx.watchdogPid = child.pid;
  const record = { ctx, pid: child.pid, code: null, signal: null, out: '' };
  child.stdout.on('data', (chunk) => { record.out += String(chunk); });
  child.stderr.on('data', (chunk) => { record.out += String(chunk); });
  child.on('exit', (code, signal) => { record.code = code; record.signal = signal; });
  try { child.unref(); } catch (_) {}
  return record;
}

// 直接拉起一个「没有 IPC 托管」的 daemon：旧版 watchdog 拉起的 daemon 就是这样，
// 也正是「watchdog 没了、daemon 还在」那个需要超时兜底的场景。
function startDetachedDaemon(ctx, extraEnv) {
  const child = spawn(process.execPath, [path.join(ctx.scripts, 'daemon.js')], {
    env: baseEnv(ctx, extraEnv),
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  });
  try { child.unref(); } catch (_) {}
  return { pid: child.pid };
}

async function waitListening(ctx, pid, timeoutMs) {
  await waitFor(() => {
    try { return fs.existsSync(path.join(ctx.outDir, 'listening-' + pid + '.json')); } catch (_) { return false; }
  }, timeoutMs || 20000, 'daemon ' + pid + ' 监听');
}

function runTray(ctx, args, extraEnv) {
  const trayExe = path.join(repo, 'tray', 'WorkDaddyTray.exe');
  const cliFile = path.join(ctx.root, 'tmp', 'WorkDaddyTray-cli.txt');
  try { fs.rmSync(cliFile, { force: true }); } catch (_) {}
  const r = spawnSync(trayExe, args, {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    // WORKDADDY_SCRIPTS 决定托盘的 installRoot：--stop 的归属校验就是拿它比 appDir。
    env: baseEnv(ctx, Object.assign({ WORKDADDY_SCRIPTS: path.join(ctx.appDir, 'scripts') }, extraEnv || {})),
    cwd: ctx.root,
  });
  let cli = '';
  for (let i = 0; i < 40 && !fs.existsSync(cliFile); i += 1) sleepSync(100);
  if (fs.existsSync(cliFile)) {
    for (let i = 0; i < 20; i += 1) {
      try { cli = fs.readFileSync(cliFile, 'utf8'); break; } catch (_) { sleepSync(50); }
    }
  }
  return { code: r.status, cli, stderr: r.stderr || '' };
}

function daemonRecords(ctx) {
  try {
    return fs.readdirSync(ctx.outDir)
      .filter((f) => /^daemon-\d+\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(ctx.outDir, f), 'utf8')));
  } catch (_) { return []; }
}

function daemonPids(ctx) {
  return daemonRecords(ctx).map((r) => r.pid);
}

function readStateFile(ctx) {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'watchdog-state.json'), 'utf8')); } catch (_) { return null; }
}

function readLog(ctx) {
  try { return fs.readFileSync(path.join(ctx.dataDir, 'watchdog.log'), 'utf8'); } catch (_) { return ''; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function listeningDaemonPids(ctx) {
  return daemonPids(ctx).filter((pid) => alive(pid));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await delay(100);
  }
  throw new Error('等待超时：' + label);
}

async function waitExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (record.code !== null) return record.code;
    await delay(100);
  }
  return null;
}

function statusOf(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 500 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { done(JSON.parse(body)); } catch (_) { done(null); }
        });
      });
    } catch (_) { done(null); return; }
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} done(null); });
    req.on('error', () => done(null));
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => { try { socket.destroy(); } catch (_) {} resolve(value); };
    socket.setTimeout(300);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

function killPids(pids) {
  for (const pid of pids) {
    if (!pid) continue;
    try { process.kill(pid); } catch (_) {}
  }
}

// 孙进程（STUB_SURVIVE_KILL 造出来的「僵尸服务」）单独记录一份，必须一起清掉。
function grandchildPids(ctx) {
  try {
    return fs.readdirSync(ctx.outDir)
      .filter((f) => /^grandchild-\d+\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(ctx.outDir, f), 'utf8')).pid);
  } catch (_) { return []; }
}

function cleanup(records) {
  for (const record of records || []) {
    if (record && record.pid) { try { process.kill(record.pid); } catch (_) {} }
  }
  for (const ctx of collectContexts) {
    killPids(daemonPids(ctx));
    killPids(grandchildPids(ctx));
    killPids([ctx.watchdogPid, ctx.extraPid]);
  }
}

const collectContexts = [];

module.exports = {
  repo,
  freePort,
  makeInstall,
  startWatchdog,
  startDetachedDaemon,
  waitListening,
  runTray,
  daemonRecords,
  daemonPids,
  grandchildPids,
  listeningDaemonPids,
  readStateFile,
  readLog,
  alive,
  waitFor,
  waitExit,
  delay,
  statusOf,
  portFree,
  killPids,
  cleanup,
  track(ctx) { collectContexts.push(ctx); return ctx; },
  tmpRoot,
};
