'use strict';
/**
 * 子进程侧的生命周期绑定（watchdog → daemon）。
 *
 * 为什么需要它：watchdog 用独立子进程跑 daemon，Windows 上终止进程不会投递可处理的
 * 信号（`process.kill` 就是 TerminateProcess），所以 watchdog 被强杀时它的 SIGTERM
 * 处理逻辑根本不会执行 —— 旧实现里 daemon 会继续活着，profile 锁却随 watchdog 一起
 * 释放，新 watchdog 于是能在同一个 profile 上再起一个 daemon。
 *
 * 现在 watchdog 用带 IPC 通道的 spawn 拉起 daemon，通道就是「父进程还活着」的唯一
 * 可靠证据：父进程无论正常退出、崩溃还是被强杀，管道都会关闭，子进程收到
 * `disconnect` 并在有界时间内退出。
 *
 * 约束（对应任务书的生命周期要求）：
 *   1. 没有 IPC 通道时（人工 `node daemon.js`、旧版 watchdog）不注册任何退出逻辑；
 *   2. `stop()` 幂等：IPC 断开、显式 shutdown 消息、SIGTERM 只执行一次；
 *   3. 退出有硬超时（graceMs）：清理卡住也必须退出，否则「孤儿」照旧存在；
 *   4. 先通知父进程 STOPPING，再执行 onShutdown 里的清理（释放 daemon 锁等）；
 *   5. 状态机 STARTING → RUNNING → STOPPING → STOPPED / FAILED，可通过 snapshot() 读。
 */

const STATE_STARTING = 'STARTING';
const STATE_RUNNING = 'RUNNING';
const STATE_STOPPING = 'STOPPING';
const STATE_STOPPED = 'STOPPED';
const STATE_FAILED = 'FAILED';

function installChildLifecycle(options) {
  const opts = options || {};
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const onShutdown = typeof opts.onShutdown === 'function' ? opts.onShutdown : function () {};
  const onState = typeof opts.onState === 'function' ? opts.onState : function () {};
  const graceMs = Number.isFinite(opts.graceMs) ? Number(opts.graceMs) : 4000;

  const state = {
    managed: Boolean(process.channel) && typeof process.send === 'function',
    state: STATE_STARTING,
    stopping: false,
    stopped: false,
    reason: '',
    since: new Date().toISOString(),
  };

  function safeLog(text) {
    try { log(text); } catch (_) {}
  }

  function notify() {
    try { onState(snapshot()); } catch (_) {}
  }

  function snapshot() {
    return {
      managed: state.managed,
      state: state.state,
      stopping: state.stopping,
      stopped: state.stopped,
      reason: state.reason,
      since: state.since,
      pid: process.pid,
      ppid: process.ppid,
    };
  }

  function markRunning() {
    if (state.stopping) return;
    state.state = STATE_RUNNING;
    state.since = new Date().toISOString();
    notify();
  }

  function markFailed(reason) {
    state.state = STATE_FAILED;
    state.reason = String(reason || '');
    state.since = new Date().toISOString();
    notify();
  }

  function stop(reason) {
    if (state.stopping) return;          // 幂等：重复的 disconnect / 消息 / 信号都走这一条
    state.stopping = true;
    state.state = STATE_STOPPING;
    state.reason = String(reason || '');
    state.since = new Date().toISOString();
    safeLog('[lifecycle] 开始停止：' + state.reason);
    notify();

    let exited = false;
    function exitNow() {
      if (exited) return;
      exited = true;
      state.stopped = true;
      try { onShutdown(state.reason); } catch (error) {
        safeLog('[lifecycle] 清理失败（忽略）：' + (error && error.message ? error.message : String(error)));
      }
      state.state = STATE_STOPPED;
      notify();
      process.exit(0);
    }

    // 硬超时：清理或子进程收尾卡住时也必须退出，否则「父进程已死、子进程还在」
    // 这个孤儿场景就没有被真正解决。
    const hard = setTimeout(exitNow, graceMs);
    if (hard.unref) hard.unref();
    setTimeout(exitNow, 50);
  }

  if (state.managed) {
    process.on('disconnect', function () { stop('watchdog 已断开（IPC 通道关闭）'); });
    process.on('message', function (message) {
      if (!message) return;
      if (message.type === 'shutdown' || message.cmd === 'shutdown') stop('watchdog 请求停止');
    });
    // 启动阶段就可能已经断开：watchdog 在 spawn 之后、daemon 完成初始化之前被杀。
    if (!process.connected) stop('IPC 通道在启动阶段已断开');
  }

  return {
    managed: state.managed,
    stop: stop,
    markRunning: markRunning,
    markFailed: markFailed,
    snapshot: snapshot,
  };
}

module.exports = { installChildLifecycle, STATE_STARTING, STATE_RUNNING, STATE_STOPPING, STATE_STOPPED, STATE_FAILED };
