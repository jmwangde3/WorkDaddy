'use strict';
/**
 * 单运行实例（约定 A：可以装多份，但同一台机器只允许一个后台服务）。
 *
 *   node test/single-instance.test.js
 *
 * 为什么必须跑真进程：单实例是「两把锁 + 一段兼容探测」的行为，任何静态断言
 * （读源码里有没有 47931）都证明不了它真的挡住了第二个实例。这里用仓库里真正的
 * watchdog.js，只把 daemon.js 换成「记录自己的环境后待着」的替身：
 *
 *   A 起在 profile X  → 拿到全局锁 + profile 锁
 *   B 同 profile 起   → 全局锁冲突，exit 3，不产生第二份 daemon
 *   C 换 profile 起   → 同样 exit 3（A 的核心诉求：不同 profile 也不能并行）
 *   A 停掉后 B 能起   → 锁真的随进程释放
 *   B 再起一次        → exit 3，daemon 数量仍是 1（重复启动不产生孤儿）
 *   旧版锁被占用      → 明确拒绝启动（兼容 1.3.1 及更早的 per-profile 锁）
 *
 * 隔离：锁端口用 WORKDADDY_LOCK_BASE 整体平移，绝不使用真实的 47931-47935；
 *   daemon.js 是替身，不会碰真 WorkBuddy / CodeBuddy；所有临时目录在 tmp/ 下。
 * 清理：只杀本测试创建并记录了 PID 的进程。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');
const scriptsSrc = path.join(repo, 'scripts');
const tmpBase = path.join(repo, 'tmp');
const isWin = process.platform === 'win32';

let counter = 0;
const roots = [];
const watchdogs = [];
const stubPids = new Set();
const installs = [];
let failures = 0;

function test(name, fn) {
  if (!isWin) {
    console.log(`SKIP ${name} (非 Windows)`);
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((error) => {
      failures += 1;
      console.error(`not ok - ${name}\n  ${error.message}`);
    });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tmpRoot(tag) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const dir = path.join(tmpBase, `single-${tag}-${process.pid}-${counter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

const HOLD_PORTS = [
  "'use strict';",
  "const net = require('net');",
  'const base = Number(process.argv[2]);',
  'const slots = Number(process.argv[3]);',
  'const servers = [];',
  'function step(i) {',
  "  if (i >= slots) { console.log('OK'); process.exit(0); }",
  '  const server = net.createServer();',
  "  server.once('error', () => { console.log('BUSY:' + (base + i)); process.exit(0); });",
  "  server.listen({ host: '127.0.0.1', port: base + i, exclusive: true }, () => { servers.push(server); step(i + 1); });",
  '}',
  'step(0);',
  'setTimeout(() => process.exit(0), 5000);',
].join('\n');

/** 找一段连续的空闲端口（全局锁 + 四个 profile 锁共 5 个）。 */
function freeBlock() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // 避开 47800-47999：那是真实 UI / 锁端口所在区间
    const base = 41000 + Math.floor(Math.random() * 9000);
    const holder = path.join(tmpBase, `hold-${process.pid}.js`);
    writeFile(holder, HOLD_PORTS);
    const r = spawnSync(process.execPath, [holder, String(base), '5'], { encoding: 'utf8', timeout: 20000 });
    if (String(r.stdout || '').trim() === 'OK') return base;
  }
  throw new Error('找不到 5 个连续空闲端口');
}

// 占位用：绑住端口后一直待着（模拟「旧版 watchdog 还在跑」），由测试 kill。
const HOLD_KEEP = [
  "'use strict';",
  "const net = require('net');",
  'const port = Number(process.argv[2]);',
  "const server = net.createServer((socket) => socket.end(''));",
  "server.listen({ host: '127.0.0.1', port, exclusive: true }, () => console.log('OK'));",
  'setTimeout(() => process.exit(0), 120000);',
].join('\n');

/** 占住单个端口，模拟「旧版 watchdog 还在跑」。 */
function holdPort(port) {
  const holder = path.join(tmpBase, `hold1-${process.pid}-${counter++}.js`);
  writeFile(holder, HOLD_KEEP);
  const child = spawn(process.execPath, [holder, String(port)], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 50; i += 1) {
    const probe = spawnSync(process.execPath, ['-e',
      "const s=require('net').createConnection({host:'127.0.0.1',port:" + port + "});s.on('connect',()=>{console.log('up');s.destroy()});s.on('error',()=>{})",
    ], { encoding: 'utf8', timeout: 5000 });
    if (String(probe.stdout || '').includes('up')) return child;
    sleepSync(100);
  }
  throw new Error('占位进程未就绪:' + port);
}

// daemon 替身：只记录自己的环境与 PID 然后待着（120s 兜底自退）。
const STUB_DAEMON = [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "const out = path.join(__dirname, '..', '..', 'out');",
  'fs.mkdirSync(out, { recursive: true });',
  'fs.writeFileSync(path.join(out, "daemon-" + process.pid + ".json"), JSON.stringify({',
  '  pid: process.pid,',
  '  profile: process.env.WBSWITCH_PROFILE || null,',
  '  dataDir: process.env.WBSWITCH_DATA_DIR || null,',
  '  at: new Date().toISOString(),',
  '}, null, 2));',
  'setTimeout(() => process.exit(0), 120000);',
].join('\n');

function makeInstall(tag, profile) {
  const root = tmpRoot(tag);
  const appDir = path.join(root, 'app');
  const scripts = path.join(appDir, 'scripts');
  for (const name of ['watchdog.js', 'profiles.js', 'platform.js', 'workbuddy-target.js']) {
    writeFile(path.join(scripts, name), fs.readFileSync(path.join(scriptsSrc, name)));
  }
  writeFile(path.join(scripts, 'daemon.js'), STUB_DAEMON);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'appdata'), { recursive: true });
  const ctx = { root, appDir, scripts, dataDir, profile };
  installs.push(ctx);
  return ctx;
}

function startWatchdog(ctx, lockBase) {
  const env = Object.assign({}, process.env, {
    WBSWITCH_PROFILE: ctx.profile,
    WBSWITCH_DATA_DIR: ctx.dataDir,
    WORKDADDY_LOCK_BASE: String(lockBase),
    NODE_OPTIONS: '',
    TEMP: path.join(ctx.root, 'tmp'),
    TMP: path.join(ctx.root, 'tmp'),
    APPDATA: path.join(ctx.root, 'appdata'),
  });
  const child = spawn(process.execPath, [path.join(ctx.scripts, 'watchdog.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const record = { child, out: '', err: '', code: null };
  child.stdout.on('data', (chunk) => { record.out += String(chunk); });
  child.stderr.on('data', (chunk) => { record.err += String(chunk); });
  child.on('exit', (code) => { record.code = code; });
  watchdogs.push(record);
  return record;
}

function readLog(ctx) {
  try { return fs.readFileSync(path.join(ctx.dataDir, 'watchdog.log'), 'utf8'); } catch (_) { return ''; }
}

function daemonFiles(ctx) {
  try {
    return fs.readdirSync(path.join(ctx.root, 'out')).filter((f) => f.startsWith('daemon-'));
  } catch (_) { return []; }
}

function collectStubPids(ctx) {
  for (const name of daemonFiles(ctx)) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(ctx.root, 'out', name), 'utf8'));
      if (info && Number(info.pid) > 0) stubPids.add(Number(info.pid));
    } catch (_) {}
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('等待超时：' + label);
}

async function waitExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (record.code !== null) return record.code;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => { try { socket.destroy(); } catch (_) {} resolve(value); };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function main() {
  const base = freeBlock();

  const A = makeInstall('a', 'workbuddy-cn');
  const B = makeInstall('b', 'workbuddy-cn');
  const C = makeInstall('c', 'workbuddy-ai');

  // 顺序启动：三个实例同时抢锁会让「谁赢」变成不确定事件
  const a = startWatchdog(A, base);
  await test('A 启动成功并拉起唯一一份 daemon', async () => {
    await waitFor(() => fs.existsSync(path.join(A.dataDir, 'watchdog.pid')), 15000, 'A 的 watchdog.pid');
    await waitFor(() => daemonFiles(A).length === 1, 15000, 'A 的 daemon 落盘');
    assert(alive(a), 'A 的 watchdog 不应退出');
  });

  const b = startWatchdog(B, base);

  await test('同 profile 的第二份安装被全局锁挡住（exit 3，不产生 daemon）', async () => {
    const code = await waitExit(b, 15000);
    assert(code === 3, 'B 应以 exit 3 退出，实际 ' + code + '；stderr=' + b.err);
    assert(/单实例锁/.test(readLog(B)), 'B 的日志应说明锁冲突：' + readLog(B));
    sleepSync(600);
    assert(daemonFiles(B).length === 0, 'B 不得拉起 daemon：' + daemonFiles(B).join(','));
  });

  const c = startWatchdog(C, base);
  await test('不同 profile 的第二份安装同样被挡住（不同 profile 不能并行）', async () => {
    const code = await waitExit(c, 15000);
    assert(code === 3, 'C 应以 exit 3 退出，实际 ' + code + '；stderr=' + c.err);
    assert(/单实例锁/.test(readLog(C)), 'C 的日志应说明锁冲突：' + readLog(C));
    sleepSync(600);
    assert(daemonFiles(C).length === 0, 'C 不得拉起 daemon：' + daemonFiles(C).join(','));
  });

  await test('A 停掉后锁释放，另一份安装可以启动', async () => {
    try { a.child.kill(); } catch (_) {}
    await waitExit(a, 10000);
    await waitForAsync(async () => !(await portListening(base)), 15000, '全局锁释放');
    const d = startWatchdog(B, base);
    await waitFor(() => fs.existsSync(path.join(B.dataDir, 'watchdog.pid')), 15000, 'B 的 watchdog.pid');
    await waitFor(() => daemonFiles(B).length === 1, 15000, 'B 的 daemon 落盘');
    assert(d.code === null, 'B 应保持运行');
  });

  await test('重复启动不产生第二份 daemon', async () => {
    const again = startWatchdog(B, base);
    const code = await waitExit(again, 15000);
    assert(code === 3, '重复启动应 exit 3，实际 ' + code);
    sleepSync(600);
    assert(daemonFiles(B).length === 1, '重复启动后 B 仍应只有一份 daemon：' + daemonFiles(B).join(','));
  });

  await test('旧版 per-profile 锁被占用时拒绝启动（兼容 1.3.1 及更早）', async () => {
    const base2 = freeBlock();
    const legacy = makeInstall('legacy', 'workbuddy-cn');
    const holder = holdPort(base2 + 1);   // 47932(workbuddy-cn) 平移后的位置
    try {
      const e = startWatchdog(legacy, base2);
      const code = await waitExit(e, 15000);
      assert(code === 3, '检测到旧版锁时应 exit 3，实际 ' + code + '；stderr=' + e.err);
      assert(/旧版/.test(readLog(legacy)), '日志应指出是旧版服务在跑：' + readLog(legacy));
      assert(daemonFiles(legacy).length === 0, '不得拉起 daemon');
    } finally {
      try { holder.kill(); } catch (_) {}
    }
  });
}

function alive(record) {
  return record.code === null;
}

async function waitForAsync(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('等待超时：' + label);
}

(async () => {
  try {
    await main();
  } catch (error) {
    failures += 1;
    console.error('not ok - 测试骨架\n  ' + error.message);
  } finally {
    for (const ctx of installs) {
      try { collectStubPids(ctx); } catch (_) {}
    }
    for (const record of watchdogs) {
      try { record.child.kill(); } catch (_) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const pid of stubPids) {
      try { process.kill(pid); } catch (_) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const dir of roots) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
    }
  }
  if (failures > 0) {
    console.error(`FAIL single-instance.test.js (${failures} 项失败)`);
    process.exit(1);
  }
  console.log('PASS single-instance.test.js');
})();
