'use strict';
/**
 * Watcher 状态机 / 失败重试回归测试（P1）
 *
 *   node --test test/rehome-watcher-retry.test.js
 *
 * 覆盖：失败后重试成功、lastUid 只在成功后推进、快速连续切号合并、
 * daemon 重启基线、auth 文件暂时缺失/损坏、并发事件、禁用后不写库、退避序列。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAccountWatcher, backoffDelay } = require('../scripts/rehome-watcher.js');

const A = 'aaaaaaaa-1111-1111-1111-111111111111';
const B = 'bbbbbbbb-2222-2222-2222-222222222222';
const C = 'cccccccc-3333-3333-3333-333333333333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeAuth(file, uid) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ account: { uid }, auth: {} }) + '\n');
  fs.renameSync(tmp, file);
}

function mkAuth(tag, uid) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `wd-watch-${tag}-`));
  const auth = path.join(tmp, 'auth.json');
  writeAuth(auth, uid);
  return { tmp, auth };
}

function makeWatcher(auth, tmp, onSwitch, extra = {}) {
  return createAccountWatcher({
    authPath: auth, dataDir: tmp, intervalMs: 15, enableDisplay: false,
    retryBaseMs: 25, log: () => {}, onSwitch, ...extra,
  });
}

async function waitFor(fn, timeoutMs = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

async function caseRetryThenSuccess() {
  const { tmp, auth } = mkAuth('retry', A);
  const calls = [];
  let fail = true;
  const w = makeWatcher(auth, tmp, async (uid, prev) => {
    calls.push([uid, prev]);
    if (fail) return { ok: false, error: 'database is locked' };
    return { ok: true, affected: 3 };
  });
  w.start();
  await waitFor(() => w.current() === A);
  assert.equal(w.state().state, 'idle');

  writeAuth(auth, B);
  assert.equal(await waitFor(() => calls.length >= 1), true, 'change detected');
  await sleep(10);
  assert.equal(w.current(), A, '失败时 lastUid 不前进');
  assert.equal(w.state().state, 'retrying', '失败进入 retrying');

  fail = false;
  assert.equal(await waitFor(() => w.current() === B, 2000), true, '退避后重试成功');
  assert.equal(w.state().state, 'idle');
  assert.equal(calls.length, 2, '一次失败 + 一次成功');
  assert.deepEqual(calls[1], [B, A], '重试仍带正确的 prevUid');
  w.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function caseRapidSwitch() {
  const { tmp, auth } = mkAuth('rapid', A);
  const calls = [];
  const w = makeWatcher(auth, tmp, async (uid) => {
    calls.push(uid);
    await sleep(60);            // 模拟接管耗时
    return { ok: true, affected: 1 };
  });
  w.start();
  await waitFor(() => w.current() === A);

  writeAuth(auth, B);
  await sleep(20);
  writeAuth(auth, C);           // B 还没跑完就切到 C
  assert.equal(await waitFor(() => w.current() === C, 3000), true, '最终接管 C');
  assert.equal(w.state().running, false, '同一时刻只有一个在飞任务');
  assert.ok(calls.length <= 2, `不应为中间态产生多次写入，实际 ${calls.length} 次`);
  assert.equal(calls[calls.length - 1], C);
  w.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function caseRestartBaseline() {
  const { tmp, auth } = mkAuth('restart', A);
  let count = 0;
  const first = makeWatcher(auth, tmp, async () => { count += 1; return { ok: true }; });
  first.start();
  await waitFor(() => first.current() === A);
  first.stop();

  // daemon 重启：新实例以当前账号为基线，不得自动写库
  const second = makeWatcher(auth, tmp, async () => { count += 1; return { ok: true }; });
  second.start();
  await sleep(120);
  assert.equal(count, 0, '重启不触发接管');
  assert.equal(second.current(), A);
  second.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function caseAuthMissingOrBroken() {
  const { tmp, auth } = mkAuth('missing', A);
  let count = 0;
  const w = makeWatcher(auth, tmp, async () => { count += 1; return { ok: true }; });
  w.start();
  await waitFor(() => w.current() === A);

  fs.unlinkSync(auth);                       // 文件暂时不存在
  await sleep(80);
  assert.equal(w.state().state, 'idle', '读不到 uid 时不崩溃');
  fs.writeFileSync(auth, '{broken json');    // UID 读取错误
  await sleep(80);
  assert.equal(w.state().state, 'idle');

  writeAuth(auth, B);                        // 恢复后继续正常工作
  assert.equal(await waitFor(() => w.current() === B), true);
  assert.equal(count, 1);
  w.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function caseDisabledRehome() {
  const { tmp, auth } = mkAuth('disabled', A);
  let calls = 0;
  const w = makeWatcher(auth, tmp, async () => {
    calls += 1;
    return { ok: true, skipped: 'disabled', affected: 0 };
  });
  w.start();
  await waitFor(() => w.current() === A);
  writeAuth(auth, B);
  await waitFor(() => w.current() === B);
  await sleep(100);
  assert.equal(calls, 1, '禁用时只探测一次，不反复重试');
  assert.equal(w.state().state, 'idle');
  w.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function caseConcurrentEvents() {
  const { tmp, auth } = mkAuth('concurrent', A);
  let inFlight = 0;
  let maxInFlight = 0;
  const seen = [];
  const w = makeWatcher(auth, tmp, async (uid) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    seen.push(uid);
    await sleep(30);
    inFlight -= 1;
    return { ok: true };
  });
  w.start();
  await waitFor(() => w.current() === A);
  // 连续快速写入多个账号，模拟多个切号事件同时到达
  for (const uid of [B, C, B, C]) { writeAuth(auth, uid); await sleep(5); }
  await waitFor(() => w.current() === C, 3000);
  assert.equal(maxInFlight, 1, '不并行执行多个接管');
  w.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function caseReconcileDryRun() {
  const { tmp, auth } = mkAuth('reconcile', A);
  let wrote = 0;
  const w = makeWatcher(auth, tmp, async () => { wrote += 1; return { ok: true }; }, {
    inspectAccounts: async () => [{ uid: A, count: 2 }, { uid: B, count: 5 }],
  });
  w.start();
  await waitFor(() => w.current() === A);

  const dry = await w.reconcile({});
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldAffect, 5);
  assert.equal(wrote, 0, '默认只检查，不改数据库');

  const applied = await w.reconcile({ autoRun: true });
  assert.equal(applied.applied, true);
  assert.equal(wrote, 1, '显式开启后才执行');
  w.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

function caseBackoffSequence() {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((n) => backoffDelay(n)),
    [1000, 2000, 4000, 8000, 16000],
    '退避序列 1s/2s/4s/8s'
  );
  assert.equal(backoffDelay(20), 60000, '上限 60s');
}

async function main() {
  caseBackoffSequence();
  await caseRetryThenSuccess();
  await caseRapidSwitch();
  await caseRestartBaseline();
  await caseAuthMissingOrBroken();
  await caseDisabledRehome();
  await caseConcurrentEvents();
  await caseReconcileDryRun();
  console.log('PASS rehome-watcher-retry.test.js — 状态机 / 重试 / 并发 / 恢复检查');
}

main().catch((error) => {
  console.error('FAIL rehome-watcher-retry.test.js:', error);
  process.exitCode = 1;
});
