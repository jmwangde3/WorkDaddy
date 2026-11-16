'use strict';
/**
 * watchdog ↔ daemon 生命周期可靠性。
 *
 *   node test/watchdog-daemon-lifecycle.test.js
 *
 * 要证明的核心不是「锁端口释放了」，而是「watchdog 消失后 daemon 真的没了、
 * 而且不会在同一 profile 上冒出第二个」。所以每个用例都统计**存活 daemon 数量**。
 *
 * Windows 上没有可投递的优雅信号：托盘 StopWd、任务管理器、崩溃都是
 * TerminateProcess，watchdog 的 SIGTERM 处理不会执行。所以「正常停止」和
 * 「强杀」在进程层面是同一条路径，能兜住孤儿的只有 IPC 断开。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fixture = require('./helpers/profile-fixture');

let failures = 0;
const started = [];
const directDaemons = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('ok - ' + name))
    .catch((error) => {
      failures += 1;
      console.error('not ok - ' + name + '\n  ' + error.message);
    });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function make(tag, profile, opts) {
  const ctx = fixture.makeInstall(Object.assign({ tag, profile }, opts || {}));
  fixture.track(ctx);
  return ctx;
}

function start(ctx, extra) {
  const record = fixture.startWatchdog(ctx, extra);
  started.push(record);
  return record;
}

async function waitRunning(ctx) {
  await fixture.waitFor(() => {
    const state = fixture.readStateFile(ctx);
    return Boolean(state && state.state === 'RUNNING' && state.daemonPid);
  }, 25000, ctx.profile + ' RUNNING');
  await fixture.waitFor(() => fixture.listeningDaemonPids(ctx).length === 1, 25000, ctx.profile + ' daemon 监听');
}

function exitRecord(ctx, pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ctx.outDir, 'exit-' + pid + '.json'), 'utf8'));
  } catch (_) { return null; }
}

// 用 -r 预加载一个「到点自己发 SIGTERM」的模块：Windows 上 process.kill 就是
// TerminateProcess，watchdog 的优雅停止分支根本不会执行，只能用 process.emit
// 触发它自己的 handler —— 走的是生产代码，不是测试替身。
function sigtermPreload(delayMs) {
  const dir = fixture.tmpRoot('life-preload');
  const file = path.join(dir, 'emit-sigterm.js');
  fs.writeFileSync(file, "'use strict';\nsetTimeout(function () { try { process.emit('SIGTERM'); } catch (_) {} }, " + delayMs + ");\n");
  return file;
}

// 直接以 IPC 托管方式拉起替身 daemon：用来单独验证「关闭握手」这条路径。
function startDirectDaemon(ctx, extra) {
  const child = spawn(process.execPath, [path.join(ctx.scripts, 'daemon.js')], {
    env: Object.assign({}, process.env, {
      WBSWITCH_PROFILE: ctx.profile,
      WBSWITCH_DATA_DIR: ctx.dataDir,
      WBSWITCH_PORT: String(extra && extra.uiPort ? extra.uiPort : ctx.uiPort),
      STUB_MODE: 'ok',
    }, (extra && extra.env) || {}),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  const record = { child, pid: child.pid, code: null };
  child.on('exit', (code) => { record.code = code; });
  directDaemons.push(record);
  return record;
}

async function main() {
  await test('正常启动：状态文件 RUNNING，daemon 监听，锁被持有', async () => {
    const ctx = make('life-ok', 'workbuddy-cn');
    start(ctx);
    await waitRunning(ctx);
    const state = fixture.readStateFile(ctx);
    assert(state.pid === ctx.watchdogPid, '状态文件应记录 watchdog pid：' + JSON.stringify(state));
    assert(state.daemonPid > 0, '状态文件应记录 daemon pid');
    assert(state.state === 'RUNNING', 'state 应为 RUNNING，实际 ' + state.state);
    assert(await fixture.portFree(ctx.lockPort) === false, 'profile 锁应被占用');
    ctx.keep = true;
  });

  await test('终止 watchdog：daemon 跟着退出，锁释放，不留孤儿', async () => {
    const ctx = make('life-kill', 'workbuddy-ai');
    const proc = start(ctx);
    await waitRunning(ctx);
    const daemonPid = fixture.readStateFile(ctx).daemonPid;
    try { process.kill(proc.pid); } catch (_) {}
    await fixture.waitFor(() => !fixture.alive(daemonPid), 8000, 'daemon 在 watchdog 消失后退出');
    await fixture.waitFor(() => fixture.portFree(ctx.lockPort), 8000, '锁端口释放');
    assert(fixture.listeningDaemonPids(ctx).length === 0, '不应有存活 daemon');
    // 退出原因的证据：本机沙箱会在父进程被终止时连带回收整棵子树（daemon 连
    // 'disconnect' 都收不到），所以这里只要求「真的没了 + 锁已释放」；IPC 通路本身
    // 由下面两条直连用例（shutdown 消息 / 通道断开）逐条证明，那两条会留下 STOPPED。
    const exit = exitRecord(ctx, daemonPid);
    if (exit) {
      assert(exit.lifecycle && exit.lifecycle.state === 'STOPPED', '若留下退出记录，必须是 STOPPED：' + JSON.stringify(exit.lifecycle));
    }
  });

  await test('启动过程中终止 watchdog：daemon 仍然不会变成孤儿', async () => {
    const ctx = make('life-startkill', 'workbuddy-cn');
    const proc = start(ctx, { STUB_STARTUP_DELAY_MS: '4000' });
    await fixture.waitFor(() => fixture.daemonRecords(ctx).length === 1, 20000, 'daemon 进程出现');
    const daemonPid = fixture.daemonRecords(ctx)[0].pid;
    await fixture.delay(300);            // 还在启动延迟里，端口尚未监听
    try { process.kill(proc.pid); } catch (_) {}
    await fixture.waitFor(() => !fixture.alive(daemonPid), 10000, '启动阶段被杀也要退出');
  });

  await test('关闭握手：显式 shutdown 消息让 daemon 走正常停止路径', async () => {
    const ctx = make('life-shutdown', 'workbuddy-ai');
    const direct = startDirectDaemon(ctx);
    await fixture.waitFor(() => fixture.listeningDaemonPids(ctx).length === 1, 20000, 'direct daemon 监听');
    direct.child.send({ type: 'shutdown' });
    direct.child.send({ type: 'shutdown' });   // 重复消息必须幂等
    const code = await fixture.waitExit(direct, 10000);
    assert(code === 0, 'daemon 应正常退出，实际 ' + code);
    const exit = exitRecord(ctx, direct.pid);
    assert(exit && exit.lifecycle.state === 'STOPPED', '应记录 STOPPED：' + JSON.stringify(exit && exit.lifecycle));
    assert(/watchdog 请求停止/.test(exit.lifecycle.reason), '原因应是 watchdog 请求：' + exit.lifecycle.reason);
  });

  await test('IPC 通道被断开（父进程侧主动断）→ daemon 退出', async () => {
    const ctx = make('life-disconnect', 'codebuddy-cn');
    const direct = startDirectDaemon(ctx);
    await fixture.waitFor(() => fixture.listeningDaemonPids(ctx).length === 1, 20000, 'direct daemon 监听');
    direct.child.disconnect();
    await fixture.waitFor(() => !fixture.alive(direct.pid), 8000, 'disconnect 后退出');
    const exit = exitRecord(ctx, direct.pid);
    assert(exit && exit.lifecycle.state === 'STOPPED', '应记录 STOPPED');
  });

  await test('daemon 自行退出：watchdog 检测到并重新拉起', async () => {
    const ctx = make('life-daemon-exit', 'workbuddy-cn');
    start(ctx, { STUB_EXIT_AFTER_MS: '2500' });
    await waitRunning(ctx);
    const first = fixture.readStateFile(ctx).daemonPid;
    await fixture.waitFor(() => !fixture.alive(first), 10000, '第一个 daemon 退出');
    await fixture.waitFor(() => fixture.daemonRecords(ctx).length >= 2, 25000, 'watchdog 重新拉起 daemon');
    await fixture.waitFor(() => fixture.listeningDaemonPids(ctx).length === 1, 25000, '新 daemon 恢复监听');
  });

  await test('daemon 启动失败：watchdog 不崩，记录退出原因并继续重试', async () => {
    const ctx = make('life-daemon-fail', 'workbuddy-ai');
    const proc = start(ctx, { STUB_MODE: 'fail' });
    await fixture.waitFor(() => fixture.daemonRecords(ctx).length >= 1, 20000, '第一次 spawn');
    await fixture.delay(1500);
    assert(proc.code === null, 'watchdog 不应退出，实际 exit=' + proc.code);
    const log = fixture.readLog(ctx);
    assert(/daemon 退出 code=7/.test(log), '日志应记录 daemon 退出码：' + log.split('\n').slice(-3).join(' | '));
  });

  await test('已有同 profile 的 daemon 时，新 watchdog 不启动第二个（exit 4）', async () => {
    const ctx = make('life-orphan', 'workbuddy-cn');
    const orphan = startDirectDaemon(ctx);
    await fixture.waitFor(() => fixture.listeningDaemonPids(ctx).length === 1, 20000, '孤儿 daemon 监听');
    const proc = start(ctx, { WORKDADDY_ORPHAN_WAIT_MS: '1500' });
    const code = await fixture.waitExit(proc, 25000);
    assert(code === 4, '应 exit 4（同 profile 已有 daemon），实际 ' + code + '：' + proc.out);
    assert(fixture.daemonRecords(ctx).length === 1, '不得再拉起第二个 daemon：' + fixture.daemonRecords(ctx).length);
    assert(fixture.alive(orphan.pid), '已存在的 daemon 不应被杀掉');
    const state = fixture.readStateFile(ctx);
    assert(state && /profile-daemon-alive/.test(state.reason || ''), '状态文件应记录拒绝原因：' + JSON.stringify(state));
  });

  await test('杀掉 watchdog 后立即重启：最终只有一份 daemon，没有重复', async () => {
    const ctx = make('life-restart', 'workbuddy-ai');
    const first = start(ctx);
    await waitRunning(ctx);
    const oldDaemon = fixture.readStateFile(ctx).daemonPid;
    try { process.kill(first.pid); } catch (_) {}
    await fixture.waitFor(() => !fixture.alive(oldDaemon), 8000, '旧 daemon 退出');
    const second = start(ctx, { WORKDADDY_ORPHAN_WAIT_MS: '6000' });
    await waitRunning(ctx);
    await fixture.delay(1200);
    const live = fixture.listeningDaemonPids(ctx);
    assert(live.length === 1, '应恰有一个存活 daemon，实际 ' + JSON.stringify(live));
    assert(second.code === null, '新 watchdog 应保持运行');
    assert(live[0] !== oldDaemon, '存活的应是新 daemon');
  });

  await test('CN 的 watchdog 被杀不影响 AI 的 daemon', async () => {
    const cn = make('life-cn', 'workbuddy-cn');
    const ai = make('life-ai', 'workbuddy-ai');
    const cnProc = start(cn);
    start(ai);
    await waitRunning(cn);
    await waitRunning(ai);
    const cnDaemon = fixture.readStateFile(cn).daemonPid;
    const aiDaemon = fixture.readStateFile(ai).daemonPid;
    try { process.kill(cnProc.pid); } catch (_) {}
    await fixture.waitFor(() => !fixture.alive(cnDaemon), 8000, 'CN daemon 退出');
    await fixture.delay(800);
    assert(fixture.alive(aiDaemon), 'AI daemon 不应受影响');
    const status = await fixture.statusOf(ai.uiPort);
    assert(status && status.profile.id === 'workbuddy-ai', 'AI 仍应正常应答');
  });

  await test('优雅停止：等 daemon 的异步清理真正跑完再放锁退出（exit 0 / STOPPED）', async () => {
    const ctx = make('life-graceful', 'workbuddy-ai');
    const preload = sigtermPreload(2000);
    const proc = fixture.startWatchdog(ctx, {
      STUB_SHUTDOWN_DELAY_MS: '1500',
      WORKDADDY_DAEMON_EXIT_WAIT_MS: '8000',
      WORKDADDY_FORCE_CONFIRM_MS: '2000',
    }, ['-r', preload]);
    started.push(proc);
    await waitRunning(ctx);
    const daemonPid = fixture.readStateFile(ctx).daemonPid;
    const code = await fixture.waitExit(proc, 30000);
    assert(code === 0, '优雅停止应 exit 0，实际 ' + code + '：' + proc.out);
    await fixture.waitFor(() => !fixture.alive(daemonPid), 8000, 'daemon 退出');
    const exit = exitRecord(ctx, daemonPid);
    assert(exit && exit.lifecycle.state === 'STOPPED', 'daemon 应走完 STOPPED：' + JSON.stringify(exit && exit.lifecycle));
    // 关键：异步清理（1500ms）必须真的跑完。旧实现 50ms 就 exit，这里会看到 exitVia=timeout。
    assert(exit.lifecycle.exitVia === 'done',
      '异步清理必须完成（exitVia=done），实际 ' + exit.lifecycle.exitVia + '：' + JSON.stringify(exit.lifecycle));
    assert(!exit.lifecycle.reason || !/超时/.test(JSON.stringify(exit)), '不应出现清理超时：' + JSON.stringify(exit));
    const log = fixture.readLog(ctx);
    assert(/daemon 已退出|daemon-exited/.test(log), '日志应记录 daemon 已退出：' + log.split('\n').slice(-4).join(' | '));
    assert(!/强制结束/.test(log), '不应走强制结束：' + log.split('\n').slice(-4).join(' | '));
    const state = fixture.readStateFile(ctx);
    assert(state && state.state === 'STOPPED' && !state.daemonPid,
      '状态应是 STOPPED 且清空 daemonPid：' + JSON.stringify(state));
  });

  await test('强杀后仍有服务在应答：不得宣称停止成功（exit 5 / FAILED）', async () => {
    const ctx = make('life-survive', 'workbuddy-cn');
    const preload = sigtermPreload(2500);
    const proc = fixture.startWatchdog(ctx, {
      STUB_SURVIVE_KILL: '1',        // 父进程被结束后，孙进程接管端口
      STUB_IGNORE_SHUTDOWN: '1',     // 父进程不理会 shutdown 消息 → 走强制结束
      WORKDADDY_DAEMON_EXIT_WAIT_MS: '700',
      WORKDADDY_FORCE_CONFIRM_MS: '1500',
      WORKDADDY_ORPHAN_WAIT_MS: '6000',
    }, ['-r', preload]);
    started.push(proc);
    await waitRunning(ctx);
    const daemonPid = fixture.readStateFile(ctx).daemonPid;
    const code = await fixture.waitExit(proc, 30000);
    assert(code === 5, '必须 exit 5（停止未确认），实际 ' + code + '：' + proc.out);
    assert(!fixture.alive(daemonPid), '被 watchdog 直接结束的 daemon 进程应已消失');
    // 孙进程接管端口 = 服务其实还在；watchdog 不能因此写 STOPPED。
    const status = await fixture.statusOf(ctx.uiPort);
    assert(status && status.profile.id === 'workbuddy-cn', '端口应仍由残留服务应答：' + JSON.stringify(status));
    await fixture.waitFor(() => fixture.grandchildPids(ctx).some((pid) => fixture.alive(pid)), 8000, '孙进程存活');
    const state = fixture.readStateFile(ctx);
    assert(state && state.state === 'FAILED', '状态必须是 FAILED，不得写 STOPPED：' + JSON.stringify(state));
    assert(/stop-unconfirmed/.test(state.reason || ''), '状态原因应标明停止未确认：' + JSON.stringify(state));
    const log = fixture.readLog(ctx);
    assert(/强制结束/.test(log), '日志应记录强制结束：' + log.split('\n').slice(-5).join(' | '));
    assert(/仍有服务/.test(log) && /停止未确认/.test(log), '日志应明确写出未确认的原因：' + log.split('\n').slice(-5).join(' | '));
    assert(fs.existsSync(path.join(ctx.dataDir, 'watchdog.pid')), '停止未确认时应保留 pid 文件作为证据');
  });
  // 自定义 preload：先杀掉 daemon（让 watchdog 的 child 变 null），再触发 SIGTERM。
  // 这样能稳定复现「没有 child，但服务还在」的 no-child 分支。
  await test('child 已退出但服务仍在：no-child 分支必须 exit 5', async () => {
    const ctx = make('life-nochild', 'workbuddy-ai');
    const dir = fixture.tmpRoot('life-killchild');
    const statePath = path.join(ctx.dataDir, 'watchdog-state.json');
    const preloadFile = path.join(dir, 'kill-child-then-sigterm.js');
    fs.writeFileSync(preloadFile, `'use strict';
const fs = require('fs');
setTimeout(function () {
  try {
    const st = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
    if (st && st.daemonPid) { try { process.kill(st.daemonPid); } catch (_) {} }
  } catch (_) {}
  setTimeout(function () { try { process.emit('SIGTERM'); } catch (_) {} }, 500);
}, 4000);
`);
    const proc = fixture.startWatchdog(ctx, {
      STUB_SURVIVE_KILL: '1',
      WORKDADDY_STOP_STABLE_MS: '1500',
    }, ['-r', preloadFile]);
    started.push(proc);
    await waitRunning(ctx);
    await fixture.waitFor(() => fixture.listeningDaemonPids(ctx).length >= 1, 20000, '孙进程接管端口');
    const code = await fixture.waitExit(proc, 40000);
    assert(code === 5, 'child 没了但服务还在，必须 exit 5，实际 ' + code + '：' + proc.out);
    const state = fixture.readStateFile(ctx);
    assert(state && state.state === 'FAILED', '状态必须是 FAILED：' + JSON.stringify(state));
    assert(/stop-unconfirmed/.test(state.reason || ''), 'reason 应写 stop-unconfirmed：' + state.reason);
    assert(fs.existsSync(path.join(ctx.dataDir, 'watchdog.pid')), '停止未确认时应保留 pid 证据');
  });

  await test('延迟接管端口：不能在服务回来之前写 STOPPED（exit 5）', async () => {
    const ctx = make('life-delay-takeover', 'workbuddy-cn');
    const preload = sigtermPreload(2000);
    const proc = fixture.startWatchdog(ctx, {
      STUB_SURVIVE_KILL: '1',
      STUB_IGNORE_SHUTDOWN: '1',
      STUB_GRANDCHILD_DELAY_MS: '1200',
      WORKDADDY_DAEMON_EXIT_WAIT_MS: '600',
      WORKDADDY_FORCE_CONFIRM_MS: '1500',
      WORKDADDY_STOP_STABLE_MS: '1600',
    }, ['-r', preload]);
    started.push(proc);
    await waitRunning(ctx);
    const code = await fixture.waitExit(proc, 40000);
    assert(code === 5, '端口在稳定窗口内被接管，必须 exit 5，实际 ' + code + '：' + proc.out);
    const state = fixture.readStateFile(ctx);
    assert(state && state.state === 'FAILED', '状态必须是 FAILED：' + JSON.stringify(state));
    const port = await fixture.statusOf(ctx.uiPort);
    assert(port && port.profile.id === 'workbuddy-cn', '孙进程应确实接管了端口（否则测的就不是这件事）');
  });

}

(async () => {
  try {
    await main();
  } finally {
    for (const d of directDaemons) { try { d.child.kill(); } catch (_) {} }
    fixture.cleanup(started.map((r) => ({ pid: r.pid })));
    await fixture.delay(600);
    fixture.cleanup(started.map((r) => ({ pid: r.pid })));
  }
  if (failures > 0) {
    console.error('FAIL watchdog-daemon-lifecycle.test.js (' + failures + ' 项失败)');
    process.exit(1);
  }
  console.log('PASS watchdog-daemon-lifecycle.test.js');
})();
