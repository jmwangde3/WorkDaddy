'use strict';
/**
 * 托盘 StopWd 的归属证明与超时兜底。
 *
 *   node test/tray-stop-ownership.test.js
 *
 * 上一版在「daemon 没在超时内退出」时会枚举本安装目录下所有 daemon.js 并逐个结束。
 * CN 与 AI 完全可以装在同一个 AppDir 里（默认安装路径就是这么设计的），命令行逐字
 * 相同 —— 枚举等于把兄弟 profile 一起杀掉。现在只允许结束「状态文件 + daemon 自己
 * 写的 .daemon.lock + 命令行」三者一致的**那一个** pid；证明不齐就失败关闭。
 *
 * 全部用真实托盘 EXE + 真实 watchdog 进程；daemon 是替身（复用生产 lifecycle-child），
 * 不启动任何真实客户端，所有目录都在仓库 tmp/ 下。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fixture = require('./helpers/profile-fixture');

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

function install(tag, profile, opts) {
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
  await fixture.waitFor(() => fixture.listeningDaemonPids(ctx).length >= 1, 25000, ctx.profile + ' daemon 监听');
}

// 托盘必须只探本测试的端口：默认会去探 47832 那族真实端口，本机装着 WorkDaddy
// 的时候「daemon 是否还在」就永远为真。
function stopTray(ctx) {
  return fixture.runTray(ctx, ['--stop'], {
    WORKDADDY_TRAY_PORT: String(ctx.uiPort),
    WORKDADDY_TRAY_STOP_WAIT_MS: '1500',
    WORKDADDY_TRAY_STOP_CONFIRM_MS: '4000',
  });
}

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  void r;
  // 刚退出的进程 pid 一定已经失效（Windows 上 pid 复用需要时间，且这里只是「不在」）
  return Number(r.pid) || 0;
}

function writeState(ctx, patch) {
  const state = {
    schema: 1,
    profile: ctx.profile,
    pid: ctx.watchdogPid,
    daemonPid: null,
    appDir: ctx.appDir,
    dataDir: ctx.dataDir,
    state: 'RUNNING',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ctx.dataDir, 'watchdog-state.json'), JSON.stringify(Object.assign(state, patch), null, 2));
}

function writeDaemonLock(ctx, pid) {
  fs.writeFileSync(path.join(ctx.dataDir, '.daemon.lock'), JSON.stringify({ pid, startedAt: new Date().toISOString(), version: 'stub' }));
}

async function main() {
  // 回归用例：daemon 用写句柄持有锁时，托盘 File.ReadAllText（FileShare.Read）会撞
  // 共享冲突，读到的永远是「正由另一进程使用」——于是归属证明恒失败、超时兜底恒拒绝。
  // daemon 现在写完就把句柄降级成只读，这条必须一直绿。
  await test('运行中的 daemon：锁文件可被托盘读取，归属证明为 ok', async () => {
    const cn = install('own-proof-cn', 'workbuddy-cn');
    start(cn);
    await waitRunning(cn);
    const state = fixture.readStateFile(cn);
    assert(state && state.daemonPid > 0, '应有 daemonPid');
    const r = fixture.runTray(cn, ['--status'], { WORKDADDY_TRAY_PORT: String(cn.uiPort) });
    const cli = r.cli || '';
    const own = (cli.split(/\r?\n/).find((line) => /^own\s+:/.test(line)) || '').trim();
    assert(/proof=ok/.test(own), '归属证明必须是 ok（锁可读）：' + own);
    assert(!/锁文件/.test(own), '不应出现锁文件读取错误：' + own);
  });

  await test('CN / AI 共用同一个 AppDir：CN daemon 超时，Stop CN 不得结束 AI', async () => {
    const cn = install('own-share-cn', 'workbuddy-cn');
    const ai = install('own-share-ai', 'workbuddy-ai', { appDir: cn.appDir });
    // CN 的 watchdog 已经不在了、daemon 还卡着（旧版 daemon 没有 IPC 托管时就是这样）。
    // 替身以 detached 方式直接拉起，避免测试宿主把整棵进程树一起回收。
    const stuck = fixture.startDetachedDaemon(cn, { STUB_IGNORE_SHUTDOWN: '1' });
    await fixture.waitListening(cn, stuck.pid);
    writeState(cn, { pid: deadPid(), daemonPid: stuck.pid });

    start(ai);
    await waitRunning(ai);
    const aiDaemon = fixture.readStateFile(ai).daemonPid;
    assert(aiDaemon > 0 && aiDaemon !== stuck.pid, '两个 daemon 应各自独立');

    const startedAt = Date.now();
    const r = stopTray(cn);
    const elapsed = Date.now() - startedAt;
    assert(/stop = True/.test(r.cli), 'CN 应停止成功（按记录的 pid 精确结束）：' + r.cli);
    assert(elapsed >= 1400, '应真的等满超时窗口再兜底结束，实际 ' + elapsed + 'ms');
    await fixture.waitFor(() => !fixture.alive(stuck.pid), 12000, 'CN daemon 被精确结束');
    assert(fixture.alive(aiDaemon), 'AI daemon 不得被结束（旧实现会按目录枚举把它一起杀掉）');
    const aiStatus = await fixture.statusOf(ai.uiPort);
    assert(aiStatus && aiStatus.profile.id === 'workbuddy-ai', 'AI 必须继续应答：' + JSON.stringify(aiStatus));
  });

  await test('状态文件的 daemonPid 被另一个 Profile 的进程占用 → 拒绝结束', async () => {
    const cn = install('own-reuse-cn', 'workbuddy-cn');
    const ai = install('own-reuse-ai', 'workbuddy-ai', { appDir: cn.appDir });
    start(ai);
    await waitRunning(ai);
    const aiDaemon = fixture.readStateFile(ai).daemonPid;

    // 伪造 CN 的归属记录：daemonPid 指向 AI 的 daemon（PID 复用），锁文件还是旧的。
    writeState(cn, { pid: deadPid(), daemonPid: aiDaemon });
    writeDaemonLock(cn, deadPid());

    const r = stopTray(cn);
    assert(/stop = False/.test(r.cli), '必须拒绝结束：' + r.cli);
    assert(/不一致|拒绝结束/.test(r.cli), '应说明归属证明不通过：' + r.cli);
    assert(fixture.alive(aiDaemon), '另一个 profile 的 daemon 不得被结束');
  });

  await test('状态文件的 dataDir 与本实例不符 → 拒绝结束', async () => {
    const cn = install('own-data-cn', 'workbuddy-cn');
    const ai = install('own-data-ai', 'workbuddy-ai', { appDir: cn.appDir });
    start(ai);
    await waitRunning(ai);
    const aiState = fixture.readStateFile(ai);
    // 把 AI 的记录搬进 CN 的数据目录，只把 profile 改成 CN —— dataDir 仍是 AI 的。
    writeState(cn, { pid: deadPid(), daemonPid: aiState.daemonPid, dataDir: ai.dataDir });

    const r = stopTray(cn);
    assert(/stop = False/.test(r.cli), '必须拒绝结束：' + r.cli);
    assert(/dataDir 与本实例不一致/.test(r.cli), '应指明 dataDir 不符：' + r.cli);
    assert(fixture.alive(aiState.daemonPid), 'AI daemon 不得被结束');
  });

  await test('daemonPid 缺失且服务仍在应答：不得虚报停止成功', async () => {
    const cn = install('own-nopid', 'workbuddy-cn');
    const stuck = fixture.startDetachedDaemon(cn, { STUB_IGNORE_SHUTDOWN: '1' });
    await fixture.waitListening(cn, stuck.pid);
    // 抹掉 daemonPid：只剩一个已经死掉的 watchdog pid，无法证明 daemon 是谁
    writeState(cn, { pid: deadPid(), daemonPid: null });

    const r = stopTray(cn);
    assert(/stop = False/.test(r.cli), '没有 daemonPid 就不能报成功：' + r.cli);
    assert(/pid|无法/.test(r.cli), '应说明无法确认 daemon：' + r.cli);
    assert(fixture.alive(stuck.pid), '证明不齐时不得结束进程');
    assert(fixture.readStateFile(cn) !== null, '停止失败时不应删掉状态文件（要留下证据）');
  });

  await test('旧版 watchdog.pid 指向别的安装的进程 → 拒绝结束', async () => {
    const a = install('own-legacy-a', 'workbuddy-cn');
    const b = install('own-legacy-b', 'workbuddy-cn');
    start(b);
    await waitRunning(b);
    const bDaemon = fixture.readStateFile(b).daemonPid;
    // A 的数据目录只有 pid 文件，且指向 B 的 watchdog
    fs.writeFileSync(path.join(a.dataDir, 'watchdog.pid'), String(b.watchdogPid), 'utf8');

    const r = stopTray(a);
    assert(/stop = False/.test(r.cli), '必须拒绝结束：' + r.cli);
    assert(/不属于本安装/.test(r.cli), '应说明 pid 文件不属于本安装：' + r.cli);
    assert(fixture.alive(bDaemon), 'B 的 daemon 不得被结束');
    const status = await fixture.statusOf(b.uiPort);
    assert(status && status.profile.id === 'workbuddy-cn', 'B 应继续应答');
  });

  await test('无关的 node 进程（命令行不含本安装 daemon.js）不会被结束', async () => {
    const cn = install('own-bystander', 'workbuddy-cn');
    start(cn);
    await waitRunning(cn);
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore', windowsHide: true });
    try {
      await fixture.delay(300);
      const r = stopTray(cn);
      assert(/stop = True/.test(r.cli), '正常停止应成功：' + r.cli);
      await fixture.delay(400);
      let alive = true;
      try { process.kill(bystander.pid, 0); } catch (_) { alive = false; }
      assert(alive, '无关进程不得被结束');
    } finally {
      try { process.kill(bystander.pid); } catch (_) {}
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
    console.error('FAIL tray-stop-ownership.test.js (' + failures + ' 项失败)');
    process.exit(1);
  }
  console.log('PASS tray-stop-ownership.test.js');
})();
