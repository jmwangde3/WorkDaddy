'use strict';
/**
 * scripts/lifecycle-child.js：子进程侧的生命周期与清理宽限。
 *
 *   node test/lifecycle-child.test.js
 *
 * 重点是「清理有时间跑完，但整体仍有上界」：
 *   - 旧实现用 setTimeout(exitNow, 50) 兜底，50ms 一到就 process.exit，
 *     graceMs=4000 从来没生效过，任何异步清理都被截断；
 *   - 现在只有一条路径：onShutdown（可返回 Promise）跑完 → 落盘窗口 → 退出；
 *     跑不完 → graceMs 到点强制退出。两条都不能无限等。
 *
 * 子进程都是真实 node 进程，全部落在仓库 tmp/ 下。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const repo = path.join(__dirname, '..');
const tmpBase = path.join(repo, 'tmp');
const lifecycleModule = path.join(repo, 'scripts', 'lifecycle-child.js');

const CHILD = `'use strict';
const fs = require('fs');
const { installChildLifecycle } = require(process.env.LIFECYCLE_MODULE);

const mode = process.env.LIFE_MODE || 'sync';
const out = process.env.LIFE_EVENTS;
const rec = (name, payload) => {
  try { fs.appendFileSync(out, JSON.stringify({ name: name, payload: payload || {}, at: Date.now() }) + '\\n'); } catch (_) {}
};

let calls = 0;
const life = installChildLifecycle({
  graceMs: Number(process.env.LIFE_GRACE_MS || 600),
  flushMs: 20,
  log: (text) => rec('log', { text: text }),
  onState: (snapshot) => rec('state', { state: snapshot.state, exitVia: snapshot.exitVia }),
  onShutdown: () => {
    calls += 1;
    rec('shutdown:start', { calls: calls });
    if (mode === 'delay') {
      return new Promise((resolve) => setTimeout(() => { rec('cleanup:done', {}); resolve(); }, 300));
    }
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'throw') throw new Error('boom');
    rec('cleanup:done', {});
    return undefined;
  },
});

process.on('exit', (code) => rec('exit', { code: code, snapshot: life.snapshot() }));
life.markRunning();
setInterval(() => {}, 500);
`;

let counter = 0;
const created = [];
const children = [];
let failures = 0;

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCase(tag) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const dir = path.join(tmpBase, 'lifecycle-' + tag + '-' + process.pid + '-' + counter++);
  fs.mkdirSync(dir, { recursive: true });
  created.push(dir);
  const script = path.join(dir, 'child.js');
  fs.writeFileSync(script, CHILD, 'utf8');
  return { dir, script, events: path.join(dir, 'events.jsonl') };
}

function spawnChild(ctx, opts) {
  const args = [ctx.script];
  const record = { code: null, startedAt: Date.now(), exitedAt: 0 };
  const child = spawn(process.execPath, args, {
    env: Object.assign({}, process.env, {
      LIFECYCLE_MODULE: lifecycleModule,
      LIFE_EVENTS: ctx.events,
      LIFE_MODE: opts.mode || 'sync',
      LIFE_GRACE_MS: String(opts.graceMs || 600),
    }),
    stdio: opts.ipc === false ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  record.child = child;
  record.pid = child.pid;
  child.on('exit', (code) => { record.code = code; record.exitedAt = Date.now(); });
  children.push(record);
  return record;
}

function events(ctx) {
  try {
    return fs.readFileSync(ctx.events, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (_) { return []; }
}

function exitEvent(ctx) {
  const all = events(ctx);
  for (let i = all.length - 1; i >= 0; i -= 1) if (all[i].name === 'exit') return all[i].payload;
  return null;
}

async function waitExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (record.code !== null) return record.code;
    await delay(50);
  }
  return null;
}

async function waitEvent(ctx, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events(ctx).some((e) => e.name === name)) return true;
    await delay(50);
  }
  return false;
}

async function main() {
  await test('异步清理（300ms）必须跑完才退出，exitVia=done', async () => {
    const ctx = makeCase('delay');
    const record = spawnChild(ctx, { mode: 'delay', graceMs: 4000 });
    await waitEvent(ctx, 'state', 5000);
    record.child.send({ type: 'shutdown' });
    const code = await waitExit(record, 15000);
    assert(code === 0, '应正常退出，实际 ' + code);
    assert(events(ctx).some((e) => e.name === 'cleanup:done'), '异步清理应完成（旧实现 50ms 就被截断）');
    const exit = exitEvent(ctx);
    assert(exit && exit.snapshot.state === 'STOPPED', '应记录 STOPPED：' + JSON.stringify(exit));
    assert(exit.snapshot.exitVia === 'done', 'exitVia 应为 done，实际 ' + exit.snapshot.exitVia);
    assert(record.exitedAt - record.startedAt >= 280, '总耗时应覆盖清理时间，实际 ' + (record.exitedAt - record.startedAt) + 'ms');
  });

  await test('清理卡死（Promise 永不 resolve）：graceMs 到点强制退出，FAILED / exit 1', async () => {
    const ctx = makeCase('hang');
    const record = spawnChild(ctx, { mode: 'hang', graceMs: 400 });
    await waitEvent(ctx, 'state', 5000);
    const startedAt = Date.now();
    record.child.send({ type: 'shutdown' });
    const code = await waitExit(record, 10000);
    const elapsed = Date.now() - startedAt;
    assert(code === 1, '清理未完成必须以 1 退出（不能伪装成正常停止），实际 ' + code);
    assert(elapsed < 5000, '必须有上界，实际 ' + elapsed + 'ms');
    const exit = exitEvent(ctx);
    assert(exit && exit.snapshot.exitVia === 'timeout', 'exitVia 应为 timeout，实际 ' + (exit && exit.snapshot.exitVia));
    assert(exit.snapshot.state === 'FAILED', '超时后状态必须是 FAILED：' + JSON.stringify(exit.snapshot));
    assert(events(ctx).some((e) => e.name === 'log' && /强制退出/.test(e.payload.text || '')), '日志应写明强制退出');
  });

  await test('清理抛错：仍然退出，FAILED / exit 1', async () => {
    const ctx = makeCase('throw');
    const record = spawnChild(ctx, { mode: 'throw', graceMs: 2000 });
    await waitEvent(ctx, 'state', 5000);
    record.child.send({ type: 'shutdown' });
    const code = await waitExit(record, 10000);
    assert(code === 1, '清理失败必须以 1 退出，实际 ' + code);
    const exit = exitEvent(ctx);
    assert(exit && exit.snapshot.exitVia === 'error', 'exitVia 应为 error，实际 ' + (exit && exit.snapshot.exitVia));
    assert(exit.snapshot.state === 'FAILED', '抛错后状态必须是 FAILED：' + JSON.stringify(exit.snapshot));
  });

  await test('重复 shutdown / 断开：清理只执行一次（幂等）', async () => {
    const ctx = makeCase('idem');
    const record = spawnChild(ctx, { mode: 'delay', graceMs: 4000 });
    await waitEvent(ctx, 'state', 5000);
    record.child.send({ type: 'shutdown' });
    record.child.send({ type: 'shutdown' });
    try { record.child.disconnect(); } catch (_) {}
    const code = await waitExit(record, 15000);
    assert(code === 0, '应退出，实际 ' + code);
    const starts = events(ctx).filter((e) => e.name === 'shutdown:start');
    assert(starts.length === 1, 'onShutdown 只能执行一次，实际 ' + starts.length);
  });

  await test('没有 IPC 通道（独立 daemon）：不注册任何退出逻辑，进程照常存活', async () => {
    const ctx = makeCase('noipc');
    const record = spawnChild(ctx, { mode: 'sync', ipc: false, graceMs: 300 });
    await delay(1200);
    assert(record.code === null, '无 IPC 时不得自行退出，实际 exit=' + record.code);
    const state = events(ctx).filter((e) => e.name === 'state').map((e) => e.payload.state);
    assert(state.includes('RUNNING'), '应能正常进入 RUNNING：' + JSON.stringify(state));
    assert(!state.includes('STOPPING') && !state.includes('STOPPED'), '无 IPC 时不得进入停止流程：' + JSON.stringify(state));
    assert(!events(ctx).some((e) => e.name === 'shutdown:start'), '无 IPC 时不得调用 onShutdown');
    try { record.child.kill(); } catch (_) {}
    await waitExit(record, 5000);
  });
}

(async () => {
  try {
    await main();
  } finally {
    for (const record of children) { try { record.child.kill(); } catch (_) {} }
    for (const dir of created) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
    }
  }
  if (failures > 0) {
    console.error('FAIL lifecycle-child.test.js (' + failures + ' 项失败)');
    process.exit(1);
  }
  console.log('PASS lifecycle-child.test.js');
})();
