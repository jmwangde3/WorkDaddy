'use strict';

// 第二轮复审（P1-1 / P1-2 / P1-3 / P2-1 / P2-2 / P2-4 / P2-5）锁定的契约：
//   1. 分组是任务身份的一部分：同名同内容但不同分组的跨账号任务不得合并；
//   2. 1.3.7 的历史快照升级后仍然有效，升级本身不算一次全量编辑；
//   3. 读取、判定、写入同处一个事务；回滚后 retired 不得残留；
//   4. pending 在任何数据库读取之前落盘，读取失败也能恢复；
//   5. 只有明确的 schema 缺失才降级，库被锁等错误必须抛出；
//   6. 目标账号多个同名分组时按路径消歧，消不了就不绑定；
//   7. 历史 mapping 把同账号不同定义的任务连在一起时报冲突、不动数据。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionDb } = require('../scripts/session-db');
const { createOfficialAutomationSync, legacyFingerprint } = require('../scripts/official-automation-sync');

async function fixture(t, accounts = ['a', 'b', 'h']) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-official-guard-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = createSessionDb({ dbPath: path.join(dataDir, 'tasks.db') });
  await db.run(`CREATE TABLE automations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'recurring', next_run_at INTEGER, last_run_at INTEGER,
    cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT NOT NULL DEFAULT '', scheduled_at TEXT,
    valid_from TEXT, valid_until TEXT, model_id TEXT, model_is_thinking INTEGER NOT NULL DEFAULT 0,
    skills_json TEXT NOT NULL DEFAULT '[]', push_to_wechat INTEGER NOT NULL DEFAULT 0,
    push_to_wecom_bot INTEGER NOT NULL DEFAULT 0, owner_user_id TEXT,
    owner_status TEXT NOT NULL DEFAULT 'legacy_unassigned', owner_source TEXT, expert_id TEXT,
    expert_marketplace TEXT, connector_ids_json TEXT NOT NULL DEFAULT '[]', permission_mode TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    wecom_bot_source TEXT, context_window INTEGER, reasoning_effort TEXT, workspace_scope TEXT,
    wecom_bot_chat_id TEXT, space_id TEXT)`);
  await db.run(`CREATE TABLE spaces (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT 'd', name TEXT NOT NULL,
    primary_folder_path TEXT, create_folder_path TEXT, pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER, status TEXT NOT NULL DEFAULT 'active', transport TEXT NOT NULL DEFAULT 'local',
    conversation_origin TEXT, deleted_at INTEGER NOT NULL DEFAULT -1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source_kind TEXT)`);
  const insert = async (id, owner, extra = {}) => {
    const row = { id, owner_user_id: owner, name: 'AI 信息汇总', prompt: 'fixture prompt',
      status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=10', created_at: 1, updated_at: 1, ...extra };
    const columns = Object.keys(row);
    await db.run(`INSERT INTO automations (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row));
  };
  const space = async (id, owner, name, extra = {}) => {
    const row = { id, user_id: owner, name, created_at: 1, updated_at: 1, ...extra };
    const columns = Object.keys(row);
    await db.run(`INSERT INTO spaces (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row));
  };
  const mappingFile = path.join(dataDir, 'official-automation-sync.json');
  const buildSync = (options = {}) => createOfficialAutomationSync({ dataDir, db, getAccountUids: () => accounts, mode: 'move', ...options });
  const live = () => db.all('SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY id');
  return { db, insert, space, mappingFile, buildSync, live, dataDir };
}

test('分组参与任务身份：同名同内容但不同分组的跨账号任务不合并', async t => {
  const f = await fixture(t);
  await f.space('sp-a', 'a', '工作区甲');
  await f.space('sp-b', 'b', '工作区乙');
  await f.insert('task-a', 'a', { updated_at: 3, space_id: 'sp-a' });
  await f.insert('task-b', 'b', { updated_at: 3, space_id: 'sp-b' });

  await f.buildSync()('a', 'b');
  const rows = await f.live();
  assert.equal(rows.length, 2, '不同分组不得被当成同一任务合并');
  assert.deepEqual(rows.map(r => r.id).sort(), ['task-a', 'task-b']);
  assert.ok(rows.every(r => r.owner_user_id === 'b'));
});

test('分组名一致的跨账号副本仍然收敛成一行', async t => {
  const f = await fixture(t);
  await f.space('sp-a', 'a', '工作区甲');
  await f.space('sp-b', 'b', '工作区甲');
  await f.insert('task-a', 'a', { updated_at: 3, space_id: 'sp-a' });
  await f.insert('task-b', 'b', { updated_at: 3, space_id: 'sp-b' });

  const result = await f.buildSync()('a', 'b');
  assert.equal(result.moved + result.skipped, 1);
  assert.equal((await f.live()).length, 1);
});

test('读取发生在事务内：move 模式不再用事务外的 db.all 读任务表', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 5 });
  const strict = {
    ...f.db,
    async all(sql, params) {
      if (/FROM automations/.test(sql)) throw new Error('读取必须走事务内连接');
      return f.db.all(sql, params);
    },
  };
  await f.buildSync({ db: strict })('a', 'b');
  assert.equal((await f.live())[0].owner_user_id, 'b');
});

test('事务开始时看到的修改会被完整带上，不产生丢失更新', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 5 });
  const racing = {
    ...f.db,
    async writeTransaction(work) {
      await f.db.run('UPDATE automations SET prompt = ?, updated_at = ? WHERE id = ?', ['用户刚改的内容', 99, 'only']);
      return f.db.writeTransaction(work);
    },
  };
  await f.buildSync({ db: racing })('a', 'b');
  const row = (await f.db.all('SELECT * FROM automations WHERE id = ?', ['only']))[0];
  assert.equal(row.owner_user_id, 'b');
  assert.equal(row.prompt, '用户刚改的内容', '用户刚写入的内容必须跟着任务一起走');
});

test('切号成功但同步失败会留下 pending，resume 能续做并清空', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 5 });
  let failOnce = true;
  const flaky = {
    ...f.db,
    async writeTransaction(work) {
      if (failOnce) { failOnce = false; throw new Error('fixture busy'); }
      return f.db.writeTransaction(work);
    },
  };
  const sync = f.buildSync({ db: flaky });
  await assert.rejects(sync('a', 'b'), /fixture busy/);
  const held = sync.pendingSync();
  assert.equal(held.sourceUid, 'a');
  assert.equal(held.targetUid, 'b');
  assert.equal(held.mode, 'move');
  assert.equal((await f.live())[0].owner_user_id, 'a', '失败时任务仍归旧账号');

  const resumed = await sync.resume('b');
  assert.equal(resumed.resumed, true);
  assert.equal((await f.live())[0].owner_user_id, 'b');
  assert.equal(sync.pendingSync(), null, '成功后必须清空 pending');
});

test('读取阶段就失败也会留下 pending（库被锁不能被吞）', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a');
  const broken = {
    ...f.db,
    async writeTransaction(work) {
      return f.db.writeTransaction(async (tx) => {
        const wrapped = {
          all(sql, params) {
            if (/SELECT space_id FROM automations LIMIT 1/.test(sql)) throw new Error('database is locked');
            return tx.all(sql, params);
          },
          run(sql, params) { return tx.run(sql, params); },
        };
        return work(wrapped);
      });
    },
  };
  const sync = f.buildSync({ db: broken });
  await assert.rejects(sync('a', 'b'), /database is locked/);
  assert.equal(sync.pendingSync().targetUid, 'b', '读取失败也必须留下可恢复记录');
  assert.equal((await f.live())[0].owner_user_id, 'a');
});

test('目标账号存在多个同名分组时按路径消歧，消不了就不绑定', async t => {
  const f = await fixture(t);
  await f.space('src', 'a', '工作区', { primary_folder_path: 'H:/AI工作区/甲' });
  await f.space('dup-1', 'b', '工作区', { primary_folder_path: 'H:/AI工作区/甲' });
  await f.space('dup-2', 'b', '工作区', { primary_folder_path: 'H:/AI工作区/乙' });
  await f.insert('task', 'a', { updated_at: 3, space_id: 'src' });

  await f.buildSync()('a', 'b');
  assert.equal((await f.live())[0].space_id, 'dup-1', '路径一致的同名分组才是对应的那一个');

  const g = await fixture(t);
  await g.space('src', 'a', '工作区');
  await g.space('dup-1', 'b', '工作区');
  await g.space('dup-2', 'b', '工作区');
  await g.insert('task', 'a', { updated_at: 3, space_id: 'src' });
  await g.buildSync()('a', 'b');
  assert.equal((await g.live())[0].space_id, null, '无法消歧时宁可不分组，也不乱绑');
});

test('历史 mapping 把同账号不同定义的任务连在一起时报冲突并保持原样', async t => {
  const f = await fixture(t);
  await f.insert('x1', 'a', { name: '任务一', updated_at: 3 });
  await f.insert('x2', 'a', { name: '任务二', updated_at: 3 });
  fs.writeFileSync(f.mappingFile, JSON.stringify({
    'a:x1:a': { targetAutomationId: 'x2', sourceUpdatedAt: '3' },
    __syncState: { snapshots: {}, retired: {} },
  }));

  const result = await f.buildSync()('a', 'b');
  assert.equal(result.conflicts, 1, '必须报冲突');
  assert.equal(result.moved, 0, '冲突时不得转移');
  const rows = await f.live();
  assert.equal(rows.length, 2, '冲突时不得软删除任何一条');
  assert.ok(rows.every(r => r.owner_user_id === 'a'));
});

test('1.3.7 的历史快照升级后仍生效：真实编辑压过调度器更新时间', async t => {
  const f = await fixture(t);
  await f.insert('x1', 'a', { name: '今日汇总', updated_at: 100 });
  await f.insert('x2', 'b', { name: '今日汇总', updated_at: 200 });
  const [rowA] = await f.db.all('SELECT * FROM automations WHERE id = ?', ['x1']);
  const [rowB] = await f.db.all('SELECT * FROM automations WHERE id = ?', ['x2']);
  // 用 1.3.7 的算法写快照，模拟升级前留下的历史记录。
  fs.writeFileSync(f.mappingFile, JSON.stringify({
    'a:x1:b': { targetAutomationId: 'x2', sourceUpdatedAt: '100' },
    __syncState: {
      snapshots: { 'a:x1': legacyFingerprint(rowA), 'b:x2': legacyFingerprint(rowB) },
      retired: {},
    },
  }));
  // A 被真实改过名（更新时间反而更旧），B 只是被调度器跑过一次。
  await f.db.run('UPDATE automations SET name = ? WHERE id = ?', ['今日汇总 v2', 'x1']);

  await f.buildSync()('a', 'b');
  const rows = await f.live();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '今日汇总 v2', '真实编辑不能被调度器时间戳顶掉');
  assert.equal(rows[0].owner_user_id, 'b');
});

test('getMode 每次同步只读取一次', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 3 });
  let calls = 0;
  const sync = f.buildSync({ mode: undefined, getMode: () => { calls++; return 'move'; } });
  await sync('a', 'b');
  assert.equal(calls, 1);
});

test('copy 模式新增与更新都会带上目标账号的分组', async t => {
  const f = await fixture(t);
  await f.space('sp-a', 'a', '工作区甲');
  await f.space('sp-b1', 'b', '工作区甲');
  await f.space('sp-b2', 'b', '工作区乙');
  await f.space('sp-h', 'h', '工作区甲');
  await f.insert('only', 'a', { updated_at: 3, space_id: 'sp-a' });

  const sync = f.buildSync({ mode: 'copy' });
  await sync('a', 'b');
  const bRow = (await f.db.all('SELECT * FROM automations WHERE owner_user_id = ?', ['b']))[0];
  assert.equal(bRow.space_id, 'sp-b1', '副本要换成目标账号自己的同名分组');
  const hRow = (await f.db.all('SELECT * FROM automations WHERE owner_user_id = ?', ['h']))[0];
  assert.equal(hRow.space_id, 'sp-h');
});

/* ===== 第三轮复审（P1-A / P1-B / P1-C / P2-1 / P2-2 / P2-4）新增契约 ===== */

test('旧 mapping 已关联、定义相同但分组不同的跨账号任务：判冲突不合并不删除', async t => {
  // v1 快照不含分组，兼容判定会把这两行都当成「未修改」。若继续执行 move，
  // 就会把两个本来属于不同分组的任务合成一个并软删一条。
  const f = await fixture(t);
  await f.space('sp-a', 'a', '工作区甲');
  await f.space('sp-b', 'b', '工作区乙');
  await f.insert('x1', 'a', { updated_at: 3, space_id: 'sp-a' });
  await f.insert('x2', 'b', { updated_at: 3, space_id: 'sp-b' });
  const [rowA] = await f.db.all('SELECT * FROM automations WHERE id = ?', ['x1']);
  const [rowB] = await f.db.all('SELECT * FROM automations WHERE id = ?', ['x2']);
  fs.writeFileSync(f.mappingFile, JSON.stringify({
    'a:x1:b': { targetAutomationId: 'x2', sourceUpdatedAt: '3' },
    __syncState: {
      snapshots: { 'a:x1': legacyFingerprint(rowA), 'b:x2': legacyFingerprint(rowB) },
      retired: {},
    },
  }));

  const result = await f.buildSync()('a', 'b');
  assert.equal(result.conflicts, 1, '跨账号分组漂移必须报冲突');
  assert.equal(result.removed, 0, '冲突时不得软删除任何一条');
  const rows = await f.live();
  assert.equal(rows.length, 2, '两个不同分组的任务都必须保留');
  assert.deepEqual(rows.map(r => r.id).sort(), ['x1', 'x2']);
  assert.equal(rows.find(r => r.id === 'x1').owner_user_id, 'a', '冲突时不得转移归属');
});

test('pending 里的旧 copy 不会在新 move 成功之后反向执行', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 5 });
  // 先制造一条 a->b 的 copy 欠账（模拟上次切号同步失败）。
  let failOnce = true;
  const flaky = {
    ...f.db,
    async writeTransaction(work) {
      if (failOnce) { failOnce = false; throw new Error('fixture busy'); }
      return f.db.writeTransaction(work);
    },
  };
  const cold = f.buildSync({ db: flaky, mode: 'copy' });
  await assert.rejects(cold('a', 'b'), /fixture busy/);
  assert.equal(cold.pendingSync('b').mode, 'copy', '欠账记录原始 mode');

  // 用户改成 move 后再切一次同样的账号：新意图必须压过旧欠账，
  // 不能出现「move 刚收敛完、旧 copy 又造出副本」。
  const warm = f.buildSync({ mode: 'move' });
  const result = await warm('a', 'b');
  assert.equal(result.moved, 1);
  assert.equal(result.drained, undefined, '同 source/target 的旧欠账不单独重放');
  const rows = await f.live();
  assert.equal(rows.length, 1, '同一任务只能剩一行');
  assert.equal(rows[0].owner_user_id, 'b');
  assert.equal(warm.pendingSync('b'), null, '成功后必须清空欠账');
});

test('不同 source 的同目标欠账先于本次同步执行（FIFO，不被新结果顶掉）', async t => {
  const f = await fixture(t);
  await f.insert('task-a', 'a', { updated_at: 5, name: '甲任务' });
  await f.insert('task-c', 'c', { updated_at: 5, name: '丙任务' });
  fs.writeFileSync(f.mappingFile, JSON.stringify({
    __syncState: {
      snapshots: {}, retired: {},
      pending: [{ sourceUid: 'a', targetUid: 'b', mode: 'copy', at: 1 }],
    },
  }));

  const result = await f.buildSync({ mode: 'move' })('c', 'b');
  assert.equal(result.drained, 1, '同目标的旧欠账必须先执行');
  const rows = await f.live();
  // 旧 copy 把甲任务复制到各账号；新 move 把丙任务转到 b。
  assert.ok(rows.some(r => r.name === '甲任务' && r.owner_user_id === 'b'), '旧 copy 已按原始 mode 完成');
  assert.ok(rows.some(r => r.name === '丙任务' && r.owner_user_id === 'b'), '新 move 也已执行');
});

test('resume 一次把该目标账号的欠账全部做完并清空', async t => {
  const f = await fixture(t);
  await f.insert('t1', 'a', { updated_at: 5, name: '任务一', rrule: 'FREQ=DAILY;BYHOUR=9' });
  await f.insert('t2', 'c', { updated_at: 5, name: '任务二', rrule: 'FREQ=DAILY;BYHOUR=11' });
  fs.writeFileSync(f.mappingFile, JSON.stringify({
    __syncState: {
      snapshots: {}, retired: {},
      pending: [
        { sourceUid: 'a', targetUid: 'b', mode: 'move', at: 1 },
        { sourceUid: 'c', targetUid: 'b', mode: 'move', at: 2 },
      ],
    },
  }));

  const sync = f.buildSync();
  assert.equal(sync.pendingList('b').length, 2);
  const result = await sync.resume('b');
  assert.equal(result.resumed, true);
  assert.equal(result.drained, 2, '两条欠账都要处理');
  assert.equal(sync.pendingList('b').length, 0, '全部完成后必须清空');
  const rows = await f.live();
  assert.ok(rows.every(r => r.owner_user_id === 'b'), '两条任务都要落到目标账号');
  assert.equal(rows.length, 2);
});

test('待恢复队列满载时拒绝新增，不静默丢弃最旧记录', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 5 });
  const full = [];
  for (let i = 0; i < 32; i++) {
    full.push({ sourceUid: `u${i}`, targetUid: `t${i}`, mode: 'move', at: i + 1 });
  }
  fs.writeFileSync(f.mappingFile, JSON.stringify({ __syncState: { snapshots: {}, retired: {}, pending: full } }));
  const sync = f.buildSync();
  await assert.rejects(sync('a', 'b'), /待恢复队列已满/);
  assert.equal(sync.pendingList().length, 32, '满载时既不能丢旧的，也不能塞新的');
});

test('copy 模式纠正跨账号错误分组引用', async t => {
  const f = await fixture(t);
  await f.space('sp-a', 'a', '工作区甲');
  await f.space('sp-b', 'b', '工作区甲');
  await f.insert('x1', 'a', { updated_at: 3, space_id: 'sp-a' });
  // B 的副本名称一致，但 space_id 错误地指向 A 账号的分组。
  await f.insert('x2', 'b', { updated_at: 3, space_id: 'sp-a' });
  fs.writeFileSync(f.mappingFile, JSON.stringify({
    'a:x1:b': { targetAutomationId: 'x2', sourceUpdatedAt: '3' },
    __syncState: { snapshots: {}, retired: {} },
  }));

  await f.buildSync({ mode: 'copy' })('a', 'b');
  const bRow = (await f.db.all('SELECT * FROM automations WHERE id = ?', ['x2']))[0];
  assert.equal(bRow.space_id, 'sp-b', '必须改回 B 自己的同名分组，不能留跨账号悬空引用');
});

test('没有回调式事务的后端，copy 也必须拒绝（不再降级）', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 5 });
  const legacy = { all: f.db.all.bind(f.db), run: f.db.run.bind(f.db) };
  await assert.rejects(f.buildSync({ db: legacy, mode: 'copy' })('a', 'b'), /不支持事务内读取/);
  assert.equal((await f.live())[0].owner_user_id, 'a', '拒绝时不得留下半成品');
});

/* ===== 第四轮复审（P1-A1 / P1-A2 / P1-C）新增契约 ===== */

const writePending = (file, list) => fs.writeFileSync(file, JSON.stringify({
  __syncState: { snapshots: {}, retired: {}, pending: list },
}));

test('旧欠账没还完时暂缓本次同步，新意图排到队尾而不是硬执行', async t => {
  const f = await fixture(t);
  await f.insert('task-a', 'a', { updated_at: 5, name: '甲任务' });
  await f.insert('task-c', 'c', { updated_at: 5, name: '丙任务' });
  writePending(f.mappingFile, [{ sourceUid: 'a', targetUid: 'b', mode: 'copy', at: 1 }]);

  // 第一个事务（旧欠账）失败，后续调用正常。
  let calls = 0;
  const flaky = {
    ...f.db,
    async writeTransaction(work) {
      calls++;
      if (calls === 1) throw new Error('fixture busy');
      return f.db.writeTransaction(work);
    },
  };
  const sync = f.buildSync({ db: flaky, mode: 'move' });
  const result = await sync('c', 'b');
  assert.equal(result.deferred, true, '旧账未清时必须暂缓本次同步');
  assert.equal(result.moved, 0, '暂缓时不得执行新 move');

  const rows = await f.live();
  assert.equal(rows.find(r => r.name === '丙任务').owner_user_id, 'c', '新任务不得先动');
  const queue = sync.pendingList('b');
  assert.equal(queue.length, 2, '旧欠账与新意图都要留在队列里');
  assert.deepEqual(queue.map(i => i.sourceUid), ['a', 'c'], '新意图必须排在队尾');
});

test('重试保留原始 at，失败不会把该条推到队尾打乱 FIFO', async t => {
  const f = await fixture(t);
  await f.insert('task-a', 'a', { updated_at: 5, name: '甲任务' });
  await f.insert('task-c', 'c', { updated_at: 5, name: '丙任务' });
  writePending(f.mappingFile, [
    { sourceUid: 'a', targetUid: 'b', mode: 'move', at: 1 },
    { sourceUid: 'c', targetUid: 'b', mode: 'move', at: 2 },
  ]);

  let calls = 0;
  const flaky = {
    ...f.db,
    async writeTransaction(work) {
      calls++;
      if (calls === 1) throw new Error('fixture busy');
      return f.db.writeTransaction(work);
    },
  };
  const sync = f.buildSync({ db: flaky });
  // resume 把单条失败收敛成「未完成」而不是抛出：调用方看 pending 决定是否重试。
  const result = await sync.resume('b');
  assert.equal(result.resumed, false);
  assert.equal(result.pending, 2, '一条都没成功时两条都要留着');

  const queue = sync.pendingList('b');
  assert.equal(queue[0].sourceUid, 'a', '失败的那条仍应排在队首');
  assert.equal(queue[0].at, 1, '原始 at 必须保留，不能被重写成当前时间');
  assert.equal(queue[1].at, 2);
});

test('部分恢复成功时 resume 必须报告剩余条数，不能只报 resumed', async t => {
  const f = await fixture(t);
  await f.insert('task-a', 'a', { updated_at: 5, name: '甲任务' });
  await f.insert('task-c', 'c', { updated_at: 5, name: '丙任务' });
  writePending(f.mappingFile, [
    { sourceUid: 'a', targetUid: 'b', mode: 'move', at: 1 },
    { sourceUid: 'c', targetUid: 'b', mode: 'move', at: 2 },
  ]);

  // 第一条成功，第二条失败：resumed=true 但 pending 仍为 1。
  let calls = 0;
  const flaky = {
    ...f.db,
    async writeTransaction(work) {
      calls++;
      if (calls === 2) throw new Error('fixture busy');
      return f.db.writeTransaction(work);
    },
  };
  const sync = f.buildSync({ db: flaky });
  const result = await sync.resume('b');
  assert.equal(result.resumed, true, '前一条确实成功了');
  assert.equal(result.drained, 1);
  assert.equal(result.pending, 1, '剩余条数必须如实返回，调用方据此继续重试');
  assert.equal(sync.pendingList('b').length, 1);
});

/* ===== 第四轮复审 WD-04：分组身份约定（同名不同路径） ===== */

test('同名但目录完全不同的两个分组：旧 mapping 关联时判冲突，不合并不删除', async t => {
  const f = await fixture(t);
  await f.space('sp-a', 'a', '工作区', { primary_folder_path: 'H:/AI工作区/甲' });
  await f.space('sp-b', 'b', '工作区', { primary_folder_path: 'H:/AI工作区/乙' });
  await f.insert('x1', 'a', { updated_at: 3, space_id: 'sp-a' });
  await f.insert('x2', 'b', { updated_at: 3, space_id: 'sp-b' });
  const [rowA] = await f.db.all('SELECT * FROM automations WHERE id = ?', ['x1']);
  const [rowB] = await f.db.all('SELECT * FROM automations WHERE id = ?', ['x2']);
  fs.writeFileSync(f.mappingFile, JSON.stringify({
    'a:x1:b': { targetAutomationId: 'x2', sourceUpdatedAt: '3' },
    __syncState: {
      snapshots: { 'a:x1': legacyFingerprint(rowA), 'b:x2': legacyFingerprint(rowB) },
      retired: {},
    },
  }));

  const result = await f.buildSync()('a', 'b');
  assert.equal(result.conflicts, 1, '同名不同路径必须按不同分组处理');
  assert.equal(result.removed, 0, '冲突时不得软删除');
  const rows = await f.live();
  assert.equal(rows.length, 2, '两条任务都必须保留');
  assert.equal(rows.find(r => r.id === 'x1').owner_user_id, 'a', '冲突时不得转移');
});

test('同名但目录完全不同的两个分组：没有历史关联时也不吸附合并', async t => {
  const f = await fixture(t);
  await f.space('sp-a', 'a', '工作区', { primary_folder_path: 'H:/AI工作区/甲' });
  await f.space('sp-b', 'b', '工作区', { primary_folder_path: 'H:/AI工作区/乙' });
  await f.insert('x1', 'a', { updated_at: 3, space_id: 'sp-a' });
  await f.insert('x2', 'b', { updated_at: 3, space_id: 'sp-b' });

  await f.buildSync()('a', 'b');
  const rows = await f.live();
  assert.equal(rows.length, 2, '同名不同路径不得被吸附成一条');
  assert.equal(rows.filter(r => r.owner_user_id === 'b').length, 2, '各自随切号转移，但不合并');
  // 身份判定说「不是一个分组」，绑定时也必须一致：不能挂到路径不同的同名分组下。
  assert.equal(rows.find(r => r.id === 'x1').space_id, null, '同名但路径不同，不得绑定到目标账号的无关分组');
});

test('同名且目录一致的跨账号分组仍然可以合并', async t => {
  const f = await fixture(t);
  await f.space('sp-a', 'a', '工作区', { primary_folder_path: 'H:/AI工作区/甲' });
  await f.space('sp-b', 'b', '工作区', { primary_folder_path: 'H:/AI工作区/甲' });
  await f.insert('x1', 'a', { updated_at: 3, space_id: 'sp-a' });
  await f.insert('x2', 'b', { updated_at: 3, space_id: 'sp-b' });

  await f.buildSync()('a', 'b');
  const rows = await f.live();
  assert.equal(rows.length, 1, '路径一致才是同一个分组，可以收敛成一行');
  assert.equal(rows[0].space_id, 'sp-b', '分组引用改到目标账号自己的那一份');
});

test('不支持事务的后端不留下无法处理的 pending', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 5 });
  const legacy = { all: f.db.all.bind(f.db), run: f.db.run.bind(f.db) };
  const sync = f.buildSync({ db: legacy });
  await assert.rejects(sync('a', 'b'), /不支持事务内读取/);
  assert.equal(sync.pendingList().length, 0, '能力检查必须先于 pending 落盘');
});

/* ===== 第五轮复审（P1 WD-04 绑定缺口 / P2-01 / P2-03）新增契约 ===== */

test('无事务能力的后端即使已有旧欠账，也不得通过 deferred 分支写入新 pending', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 5 });
  writePending(f.mappingFile, [{ sourceUid: 'a', targetUid: 'b', mode: 'move', at: 1, seq: 1 }]);
  const legacy = { all: f.db.all.bind(f.db), run: f.db.run.bind(f.db) };
  const sync = f.buildSync({ db: legacy });

  await assert.rejects(sync('c', 'b'), /不支持事务内读取/);
  const queue = sync.pendingList('b');
  assert.equal(queue.length, 1, '既不能新增第二条，也不能丢掉原有那条');
  assert.equal(queue[0].sourceUid, 'a', '原有欠账保持原样');
  assert.equal(queue[0].at, 1);
});

test('两条意图 at 相同时，重试不会把记录换位', async t => {
  const f = await fixture(t);
  await f.insert('task-a', 'a', { updated_at: 5, name: '甲任务' });
  await f.insert('task-c', 'c', { updated_at: 5, name: '丙任务' });
  // 同一毫秒入队：at 完全相等，只能靠 seq 保序。
  writePending(f.mappingFile, [
    { sourceUid: 'a', targetUid: 'b', mode: 'move', at: 100, seq: 1 },
    { sourceUid: 'c', targetUid: 'b', mode: 'move', at: 100, seq: 2 },
  ]);

  let calls = 0;
  const flaky = {
    ...f.db,
    async writeTransaction(work) {
      calls++;
      if (calls === 1) throw new Error('fixture busy');
      return f.db.writeTransaction(work);
    },
  };
  const sync = f.buildSync({ db: flaky });
  const result = await sync.resume('b');
  assert.equal(result.resumed, false);
  const queue = sync.pendingList('b');
  assert.deepEqual(queue.map(i => i.sourceUid), ['a', 'c'], 'at 相同也必须保持原始顺序');
  assert.deepEqual(queue.map(i => i.seq), [1, 2]);

  // 再恢复一次，仍然按 a → c 的顺序执行，并被清空。
  const retry = await sync.resume('b');
  assert.equal(retry.drained, 2);
  assert.equal(sync.pendingList('b').length, 0);
});

test('分组在同步期间被改名时整笔回滚', async t => {
  const f = await fixture(t);
  await f.space('sp-a', 'a', '工作区甲');
  await f.space('sp-b', 'b', '工作区甲');
  await f.insert('only', 'a', { updated_at: 3, space_id: 'sp-a' });

  // 预取之后（事务外）把目标分组改名，事务内复核必须发现并回滚。
  const racing = {
    ...f.db,
    async writeTransaction(work) {
      await f.db.run('UPDATE spaces SET name = ? WHERE id = ?', ['被改名了', 'sp-b']);
      return f.db.writeTransaction(work);
    },
  };
  await assert.rejects(f.buildSync({ db: racing })('a', 'b'), /分组在同步期间被改名/);
  const row = (await f.live())[0];
  assert.equal(row.owner_user_id, 'a', '回滚后归属不变');
});
