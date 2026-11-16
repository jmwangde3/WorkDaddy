'use strict';
/**
 * 托盘：profile 级 Mutex 与「只停自己这一份」的 StopWd。
 *
 *   node test/tray-profile-mutex.test.js
 *
 * 两条都是 B 架构的必要条件：
 *   - 托盘的 Mutex 必须按 profile 隔离，否则 CN 的托盘会把 AI 的托盘挡在门外；
 *   - StopWd 必须能证明「这个 watchdog 属于本安装、本 profile」，否则停 CN 会顺手
 *     杀掉 AI（或另一份安装）的服务。
 * 用真实的托盘 EXE + 真实 watchdog 进程，不启动任何真实客户端。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fixture = require('./helpers/profile-fixture');

let failures = 0;
const started = [];
const extraProcs = [];

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

function writeBinding(ctx) {
  fs.writeFileSync(path.join(ctx.appDir, 'install-binding.json'), JSON.stringify({
    schema: 1,
    clientProfile: ctx.profile,
    dataDir: ctx.dataDir,
    appDir: ctx.appDir,
    updatedAt: '2026-11-16T00:00:00Z',
  }, null, 2));
}

function make(tag, profile) {
  const ctx = fixture.makeInstall({ tag, profile });
  writeBinding(ctx);
  fixture.track(ctx);
  return ctx;
}

function start(ctx, extra) {
  const record = fixture.startWatchdog(ctx, extra);
  started.push(record);
  return record;
}

// 托盘只探本测试的端口：默认候选 47832 那族是本机真实安装的端口。
function stopTray(ctx) {
  return fixture.runTray(ctx, ['--stop'], { WORKDADDY_TRAY_PORT: String(ctx.uiPort) });
}

async function waitRunning(ctx) {
  await fixture.waitFor(() => {
    const state = fixture.readStateFile(ctx);
    return Boolean(state && state.state === 'RUNNING');
  }, 25000, ctx.profile + ' RUNNING');
  await fixture.waitFor(() => fixture.listeningDaemonPids(ctx).length === 1, 25000, 'daemon 监听');
}

function holdMutex(ctx, ms) {
  const trayExe = path.join(fixture.repo, 'tray', 'WorkDaddyTray.exe');
  const child = spawn(trayExe, ['--mutex-hold', String(ms)], {
    env: Object.assign({}, process.env, {
      WORKDADDY_SCRIPTS: ctx.scripts,
      TEMP: path.join(ctx.root, 'tmp'),
      TMP: path.join(ctx.root, 'tmp'),
      APPDATA: path.join(ctx.root, 'appdata'),
    }),
    windowsHide: true,
    stdio: 'ignore',
  });
  extraProcs.push(child.pid);
  return child;
}

async function main() {
  const cn = make('mx-cn', 'workbuddy-cn');
  const ai = make('mx-ai', 'workbuddy-ai');

  await test('同 profile 的第二个托盘被 Mutex 拒绝，不同 profile 的托盘可以同时起来', async () => {
    const holder = holdMutex(cn, 9000);
    await fixture.waitFor(() => fs.existsSync(path.join(cn.root, 'tmp', 'WorkDaddyTray-cli.txt')), 15000, 'holder 输出');
    await fixture.delay(300);
    const busy = fixture.runTray(cn, ['--mutex-check'], {});
    assert(/mutex = busy/.test(busy.cli), 'CN 第二个托盘应 busy：' + busy.cli);
    const other = fixture.runTray(ai, ['--mutex-check'], {});
    assert(/mutex = acquired/.test(other.cli), 'AI 托盘不应被 CN 挡住：' + other.cli);
    assert(/WorkDaddyTraySingleton_workbuddy-ai/.test(other.cli), 'Mutex 名应带 profile：' + other.cli);
    const released = await new Promise((resolve) => holder.once('exit', () => resolve(true)));
    assert(released, 'holder 应正常退出');
  });

  await test('持锁进程消失后，同 profile 的托盘可以重新启动', async () => {
    const holder = holdMutex(cn, 30000);
    await fixture.waitFor(() => fs.existsSync(path.join(cn.root, 'tmp', 'WorkDaddyTray-cli.txt')), 15000, 'holder 输出');
    await fixture.delay(400);
    const busy = fixture.runTray(cn, ['--mutex-check'], {});
    assert(/mutex = busy/.test(busy.cli), '前置：应处于 busy');
    try { process.kill(holder.pid); } catch (_) {}
    await fixture.waitFor(() => {
      try { process.kill(holder.pid, 0); return false; } catch (_) { return true; }
    }, 10000, 'holder 退出');
    await fixture.delay(300);
    const again = fixture.runTray(cn, ['--mutex-check'], {});
    assert(/mutex = acquired/.test(again.cli), '崩溃后锁应释放：' + again.cli);
  });

  await test('非法 profile 不会拼出未经验证的 Mutex 名（回落到白名单默认值）', async () => {
    const ctx = make('mx-bad-profile', 'workbuddy-cn');
    const r = fixture.runTray(ctx, ['--status'], { WBSWITCH_PROFILE: 'workbuddy-cn-evil; rm -rf' });
    assert(/bindingErr : 环境变量 WBSWITCH_PROFILE 非法/.test(r.cli), '应拒绝非法 profile：' + r.cli);
    assert(/mutex\s+: Local\\WorkDaddyTraySingleton_workbuddy-cn/.test(r.cli), 'Mutex 名应回落到白名单里的默认 profile：' + r.cli);
    assert(!/evil/.test((r.cli.match(/mutex\s+: .*/) || [''])[0]), 'Mutex 名不得包含非法输入');
  });

  await test('StopWd 只停当前 profile：停 CN 不动 AI，停 AI 不动 CN', async () => {
    const a = make('stop-cn', 'workbuddy-cn');
    const b = make('stop-ai', 'workbuddy-ai');
    start(a);
    start(b);
    await waitRunning(a);
    await waitRunning(b);
    const aDaemon = fixture.readStateFile(a).daemonPid;
    const bDaemon = fixture.readStateFile(b).daemonPid;
    const stopA = stopTray(a);
    assert(/stop = True/.test(stopA.cli), '停止 CN 应成功：' + stopA.cli);
    await fixture.waitFor(() => !fixture.alive(aDaemon), 15000, 'CN daemon 退出');
    const aiStatus = await fixture.statusOf(b.uiPort);
    assert(aiStatus && aiStatus.profile.id === 'workbuddy-ai', 'AI 必须继续运行：' + JSON.stringify(aiStatus));
    assert(fixture.alive(bDaemon), 'AI daemon 不得被杀');

    // 反向：CN 重启后再停 AI，CN 不受影响
    start(a);
    await waitRunning(a);
    const newCN = fixture.readStateFile(a).daemonPid;
    const stopB = stopTray(b);
    assert(/stop = True/.test(stopB.cli), '停止 AI 应成功：' + stopB.cli);
    await fixture.waitFor(() => !fixture.alive(bDaemon), 15000, 'AI daemon 退出');
    const cnStatus = await fixture.statusOf(a.uiPort);
    assert(cnStatus && cnStatus.profile.id === 'workbuddy-cn', 'CN 必须继续运行：' + JSON.stringify(cnStatus));
    assert(fixture.alive(newCN), 'CN daemon 不得被杀');
    assert(newCN !== aDaemon, 'CN 应是重启后的新 daemon');
  });

  await test('StopWd 拒绝停止属于另一个安装的服务（状态文件 appDir 不符）', async () => {
    const a = make('foreign-a', 'workbuddy-cn');
    const b = make('foreign-b', 'workbuddy-cn');
    start(b);
    await waitRunning(b);
    const bDaemon = fixture.readStateFile(b).daemonPid;
    // 把 B 的归属记录搬到 A 的数据目录：profile 一样，appDir 不一样
    const bState = fixture.readStateFile(b);
    fs.writeFileSync(path.join(a.dataDir, 'watchdog-state.json'), JSON.stringify(bState, null, 2));
    const r = stopTray(a);
    assert(/stop = False/.test(r.cli), '应拒绝停止：' + r.cli);
    assert(/属于另一个安装/.test(r.cli), '应说明归属不符：' + r.cli);
    assert(fixture.alive(bDaemon), 'B 的 daemon 必须还活着');
    const status = await fixture.statusOf(b.uiPort);
    assert(status && status.profile.id === 'workbuddy-cn', 'B 应继续正常应答');
  });

  await test('StopWd 不碰身份不明的 node 进程', async () => {
    const a = make('unrelated', 'workbuddy-cn');
    start(a);
    await waitRunning(a);
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore', windowsHide: true });
    extraProcs.push(bystander.pid);
    await fixture.delay(300);
    const r = stopTray(a);
    assert(/stop = True/.test(r.cli), '停止应成功：' + r.cli);
    await fixture.delay(500);
    let alive = true;
    try { process.kill(bystander.pid, 0); } catch (_) { alive = false; }
    assert(alive, '无关的 node 进程不得被结束');
  });
}

(async () => {
  try {
    await main();
  } finally {
    for (const pid of extraProcs) { try { process.kill(pid); } catch (_) {} }
    fixture.cleanup(started.map((r) => ({ pid: r.pid })));
    await fixture.delay(600);
    fixture.cleanup(started.map((r) => ({ pid: r.pid })));
  }
  if (failures > 0) {
    console.error('FAIL tray-profile-mutex.test.js (' + failures + ' 项失败)');
    process.exit(1);
  }
  console.log('PASS tray-profile-mutex.test.js');
})();
