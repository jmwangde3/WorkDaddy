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
