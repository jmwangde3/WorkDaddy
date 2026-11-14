'use strict';
/**
 * 置顶（pin）同步队列测试（P2）
 *
 *   node --test test/session-pin-sync.test.js
 *
 * 只测队列语义（读写都用注入的假实现），不接触真实客户端 / 云端：
 *   - 只同步 ID，不复制内容；
 *   - 只补缺少的 pin，永不取消；
 *   - 重复执行幂等；
 *   - 官方取消 pin 后已交付记录失效；
 *   - 映射失效的条目跳过；
 *   - 快速 A→B→C 轮换不丢也不重复。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionPinSync, cleanIds } = require('../scripts/session-pin-sync.js');

const DIRS = [];
function stateFile(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wd-pin-${tag}-`));
  DIRS.push(d);
  return path.join(d, 'pins.json');
}

function fakeWorld() {
  const pins = new Map();      // uid -> Set(ids)
  const writes = [];
  return {
    pins, writes,
    read: async (uid) => Array.from(pins.get(uid) || []),
    apply: async (uid, ids) => {
      writes.push([uid, ids.slice()]);
      const set = pins.get(uid) || new Set();
      for (const id of ids) set.add(id);
      pins.set(uid, set);
      return true;
    },
  };
}

async function main() {
  assert.deepEqual(cleanIds(['a', 'a', '', null, 'bad id', 'ok-1']), ['a', 'ok-1'], 'ID 过滤');

  // ---- 基本同步 ----
  {
    const world = fakeWorld();
    world.pins.set('A', new Set(['s1', 's2']));
    const sync = createSessionPinSync({ file: stateFile('basic'), read: world.read, apply: world.apply, log: () => {} });
    assert.equal(await sync.capture('A'), true);
    assert.equal(await sync.sync('A', 'B'), true);
    assert.deepEqual(Array.from(world.pins.get('B')).sort(), ['s1', 's2'], '目标账号补上 pin');
    assert.equal(await sync.sync('A', 'B'), false, '重复执行不再写入');
    assert.equal(world.writes.length, 1, '幂等');
  }

  // ---- 只补不删 ----
  {
    const world = fakeWorld();
    world.pins.set('A', new Set(['s1']));
    world.pins.set('B', new Set(['keep-me']));
    const sync = createSessionPinSync({ file: stateFile('nodel'), read: world.read, apply: world.apply, log: () => {} });
    await sync.capture('A');
    await sync.sync('A', 'B');
    assert.deepEqual(Array.from(world.pins.get('B')).sort(), ['keep-me', 's1'], '目标已有的 pin 保留');
  }

  // ---- 官方取消 pin 后记录失效 ----
  {
    const world = fakeWorld();
    world.pins.set('A', new Set(['s1', 's2']));
    const sync = createSessionPinSync({ file: stateFile('unpin'), read: world.read, apply: world.apply, log: () => {} });
    await sync.capture('A');
    await sync.sync('A', 'B');
    world.pins.set('A', new Set(['s2']));       // 官方取消 s1
    await sync.capture('A');
    assert.equal(sync.status().delivered, 1, '只清掉被取消的那条的 delivered 记录');
    assert.equal(await sync.sync('A', 'B'), false, '剩下的 s2 已交付，不重复写');
    world.pins.set('A', new Set(['s1', 's2'])); // 重新 pin
    await sync.capture('A');
    assert.equal(await sync.sync('A', 'B'), true, '重新 pin 后允许再次同步（只补 s1）');
    assert.deepEqual(world.writes[world.writes.length - 1][1], ['s1']);
  }

  // ---- 映射失效跳过 ----
  {
    const world = fakeWorld();
    world.pins.set('A', new Set(['s1', 'gone']));
    let calls = 0;
    const sync = createSessionPinSync({
      file: stateFile('map'), read: world.read, apply: world.apply, log: () => {},
      resolve: async (_s, _t, ids) => {
        calls += 1;
        return ids.filter((id) => id !== 'gone').map((id) => ({ sourceId: id, targetId: 'copy-' + id }));
      },
    });
    await sync.capture('A');
    await sync.sync('A', 'B');
    assert.deepEqual(Array.from(world.pins.get('B')).sort(), ['copy-s1'], '失效映射跳过');
    assert.equal(calls, 2, '入队解析一次 + 交付前复核一次（失效映射不会在交付时复活）');
  }

  // ---- 快速轮换 A→B→C ----
  {
    const world = fakeWorld();
    world.pins.set('A', new Set(['s1']));
    const sync = createSessionPinSync({ file: stateFile('rapid'), read: world.read, apply: world.apply, log: () => {} });
    await sync.capture('A');
    await sync.sync('A', 'B');
    await sync.sync('B', 'C');
    assert.deepEqual(Array.from(world.pins.get('C') || []), ['s1'], 'B 尚未 capture 也能把待交付项带到 C');
    const before = world.writes.length;
    await sync.sync('B', 'C');
    assert.equal(world.writes.length, before, '不重复写入');
  }

  // ---- 写失败保留队列 ----
  {
    const world = fakeWorld();
    world.pins.set('A', new Set(['s1']));
    let fail = true;
    const sync = createSessionPinSync({
      file: stateFile('fail'), read: world.read, log: () => {},
      apply: async (uid, ids) => {
        if (fail) { world.writes.push([uid, ids.slice()]); return false; }
        return world.apply(uid, ids);
      },
    });
    await sync.capture('A');
    assert.equal(await sync.sync('A', 'B'), false, '写入失败返回 false');
    assert.equal(sync.status().pending.B, 1, '失败后保留待交付');
    fail = false;
    assert.equal(await sync.flush('B'), true, '恢复后补交付');
    assert.equal(sync.status().pending.B, undefined);
  }

  // ---- 状态文件只存 ID ----
  {
    const file = stateFile('persist');
    const world = fakeWorld();
    world.pins.set('A', new Set(['s1']));
    const sync = createSessionPinSync({ file, read: world.read, apply: world.apply, log: () => {} });
    await sync.capture('A');
    await sync.sync('A', 'B');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(/content|title|token|nickname/i.test(raw), false, '不得写入内容或凭据');
    const reloaded = createSessionPinSync({ file, read: world.read, apply: world.apply, log: () => {} });
    assert.equal(await reloaded.sync('A', 'B'), false, '重启后仍然幂等');
  }

  console.log('PASS session-pin-sync-queue.test.js — 队列 / 幂等 / 只补不删');
}

main()
  .catch((error) => {
    console.error('FAIL session-pin-sync-queue.test.js:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const d of DIRS) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  });
