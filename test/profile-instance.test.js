'use strict';
/**
 * B 架构：profile 级实例隔离。
 *
 *   node test/profile-instance.test.js
 *
 * 验收的是任务书阶段 1 的完整矩阵：四个 profile 各自一把锁、可以同时运行；
 * 同一个 profile 第二次启动被拒绝（包括「不同安装目录、同 profile」）；
 * 停在旧版（<=1.3.1）锁协议上时，同 profile 互斥、不同 profile 仍可共存。
 *
 * 这里跑的是仓库里真正的 watchdog.js（把 daemon.js 换成会应答 /api/status 的替身），
 * 所以锁、状态文件、port 探测都是生产代码在跑，不是 mock 出来的结论。
 */
const path = require('path');
const fixture = require('./helpers/profile-fixture');

const PROFILES = ['workbuddy-cn', 'workbuddy-ai', 'codebuddy-cn', 'codebuddy-intl'];
let failures = 0;
const started = [];

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

async function waitRunning(ctx, label) {
  await fixture.waitFor(() => {
    const state = fixture.readStateFile(ctx);
    return Boolean(state && state.state === 'RUNNING' && state.daemonPid);
  }, 20000, label || 'state RUNNING ' + ctx.profile);
  await fixture.waitFor(() => fixture.listeningDaemonPids(ctx).length === 1, 20000, 'daemon 起来 ' + ctx.profile);
}

async function main() {
  const cn = make('cn', 'workbuddy-cn');
  const ai = make('ai', 'workbuddy-ai');
  const ccn = make('ccn', 'codebuddy-cn');
  const cintl = make('cintl', 'codebuddy-intl');

  const cnProc = start(cn);

  await test('CN 首次启动成功并拿到自己的锁与端口', async () => {
    await waitRunning(cn);
    const state = fixture.readStateFile(cn);
    assert(state.profile === 'workbuddy-cn', '状态文件应记录 profile：' + JSON.stringify(state));
    assert(state.appDir.toLowerCase() === cn.appDir.toLowerCase(), '状态文件应记录 appDir：' + state.appDir);
    const status = await fixture.statusOf(cn.uiPort);
    assert(status && status.profile && status.profile.id === 'workbuddy-cn', 'UI 端口应返回本 profile：' + JSON.stringify(status));
  });

  await test('同 profile 的第二份安装被 profile 锁挡住（exit 3，不产生 daemon）', async () => {
    const cn2 = make('cn2', 'workbuddy-cn', { lockPort: cn.lockPort });
    const proc = start(cn2);
    const code = await fixture.waitExit(proc, 20000);
    assert(code === 3, '第二个 CN 应 exit 3，实际 ' + code + '：' + proc.out);
    assert(/当前 profile 的 watchdog 已在运行/.test(fixture.readLog(cn2)), '应写明锁冲突：' + fixture.readLog(cn2));
    await fixture.delay(800);
    assert(fixture.daemonRecords(cn2).length === 0, '不得拉起 daemon');
  });

  const aiProc = start(ai);

  await test('CN 与 AI 可以同时运行，各自的状态接口互不串台', async () => {
    await waitRunning(ai);
    assert(cnProc.code === null, 'CN watchdog 应仍在运行，实际 exit=' + cnProc.code);
    const cnStatus = await fixture.statusOf(cn.uiPort);
    const aiStatus = await fixture.statusOf(ai.uiPort);
    assert(cnStatus.profile.id === 'workbuddy-cn', 'CN 端口应返回 CN：' + JSON.stringify(cnStatus));
    assert(aiStatus.profile.id === 'workbuddy-ai', 'AI 端口应返回 AI：' + JSON.stringify(aiStatus));
    assert(cn.uiPort !== ai.uiPort && cn.lockPort !== ai.lockPort, '两个 profile 必须用不同的端口');
  });

  const ccnProc = start(ccn);
  const cintlProc = start(cintl);

  await test('四个 profile 可以同时运行', async () => {
    await waitRunning(ccn);
    await waitRunning(cintl);
    for (const ctx of [cn, ai, ccn, cintl]) {
      const status = await fixture.statusOf(ctx.uiPort);
      assert(status && status.profile.id === ctx.profile, ctx.profile + ' 状态接口不对：' + JSON.stringify(status));
      assert(fixture.listeningDaemonPids(ctx).length === 1, ctx.profile + ' 应恰有一个 daemon');
    }
    const pids = [cnProc, aiProc, ccnProc, cintlProc].map((r) => r.pid);
    assert(new Set(pids).size === 4, '四个 watchdog 应是四个不同进程');
  });

  await test('每个 profile 的第二次启动都被拒绝', async () => {
    for (const ctx of [ai, ccn, cintl]) {
      const dup = make('dup-' + ctx.profile, ctx.profile, { lockPort: ctx.lockPort });
      const proc = start(dup);
      const code = await fixture.waitExit(proc, 20000);
      assert(code === 3, ctx.profile + ' 的重复启动应 exit 3，实际 ' + code);
      assert(fixture.daemonRecords(dup).length === 0, ctx.profile + ' 重复启动不得产生 daemon');
    }
  });

  await test('停止 CN 不影响 AI / CodeBuddy', async () => {
    cnProc.ctx = cn;
    try { process.kill(cnProc.pid); } catch (_) {}
    await fixture.waitExit(cnProc, 15000);
    await fixture.waitFor(() => fixture.listeningDaemonPids(cn).length === 0, 15000, 'CN daemon 退出');
    for (const ctx of [ai, ccn, cintl]) {
      const status = await fixture.statusOf(ctx.uiPort);
      assert(status && status.profile.id === ctx.profile, ctx.profile + ' 应不受影响：' + JSON.stringify(status));
    }
  });

  await test('CN 退出后可以重新启动（锁已释放）', async () => {
    await fixture.waitFor(() => fixture.portFree(cn.lockPort), 15000, 'CN 锁端口释放');
    const again = start(cn);
    await waitRunning(cn, 'CN 重启');
    assert(again.code === null, 'CN 重启后应保持运行');
  });

  await test('旧版协议兼容：旧 CN 锁被占用 → 新 CN 互斥、新 AI 仍可启动', async () => {
    // 旧版（<=1.3.1）只监听 profile 锁端口，没有任何「全局」概念。
    const legacyCn = make('legacy-cn', 'workbuddy-cn');
    const { spawn } = require('child_process');
    const holder = spawn(process.execPath, ['-e',
      "const net=require('net');net.createServer(c=>c.end('')).listen(" + legacyCn.lockPort + ",'127.0.0.1');setTimeout(()=>{},60000)",
    ], { stdio: 'ignore', windowsHide: true });
    legacyCn.extraPid = holder.pid;
    try {
      await fixture.waitFor(() => fixture.portFree(legacyCn.lockPort).then((free) => free === false), 10000, '旧版锁就绪');
      // 同一把锁 → 新 CN 被挡
      const sameCn = make('old-vs-new-cn', 'workbuddy-cn', { lockPort: legacyCn.lockPort });
      const blocked = start(sameCn);
      const code = await fixture.waitExit(blocked, 20000);
      assert(code === 3, '旧版 CN 在跑时新 CN 应 exit 3，实际 ' + code);
      // 不同锁 → 新 AI 正常起（证明没有全局锁）
      const newAi = make('old-cn-new-ai', 'workbuddy-ai');
      start(newAi);
      await waitRunning(newAi, '旧版 CN + 新版 AI');
      const status = await fixture.statusOf(newAi.uiPort);
      assert(status && status.profile.id === 'workbuddy-ai', '新版 AI 应正常运行：' + JSON.stringify(status));
    } finally {
      try { process.kill(holder.pid); } catch (_) {}
    }
  });
}

(async () => {
  try {
    await main();
  } finally {
    fixture.cleanup(started.map((r) => ({ pid: r.pid })));
    await fixture.delay(600);
    fixture.cleanup(started.map((r) => ({ pid: r.pid })));
  }
  if (failures > 0) {
    console.error('FAIL profile-instance.test.js (' + failures + ' 项失败)');
    process.exit(1);
  }
  console.log('PASS profile-instance.test.js');
})();
