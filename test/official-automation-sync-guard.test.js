'use strict';

// 第二轮复审（P1-1 / P1-2 / P1-3 / P2-1 / P2-2 / P2-4 / P2-5）锁定的契约：
//   1. 分组是任务身份的一部分：同名同内容但不同分组的跨账号任务不得合并；
//   2. 规划之后被并发修改的行必须整笔回滚，不能在旧决策上改新内容；
//   3. 切号成功但同步失败要留下可恢复的 pending，restart 后能续做；
//   4. 只有明确的 schema 缺失才降级，库被锁等错误必须抛出；
//   5. 目标账号多个同名分组时按路径消歧，消不了就不绑定；
//   6. 历史 mapping 把同账号不同定义的任务连在一起时报冲突、不动数据；
//   7. getMode 每次同步只读取一次。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionDb } = require('../scripts/session-db');
const { createOfficialAutomationSync } = require('../scripts/official-automation-sync');

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
  // 两个不同分组的任务都跟到当前账号，但依然是两条独立任务。
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

test('规划后被并发修改的任务整笔回滚，不在旧决策上改新内容', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 5 });
  // 模拟客户端在 SELECT 之后、事务提交之前改写了这一行。
  const racing = {
    ...f.db,
    async writeTransaction(work) {
      await f.db.run('UPDATE automations SET prompt = ?, updated_at = ? WHERE id = ?', ['用户刚改的内容', 99, 'only']);
      return f.db.writeTransaction(work);
    },
  };
  const sync = f.buildSync({ db: racing });
  await assert.rejects(sync('a', 'b'), /被修改|已回滚/);
  const row = (await f.db.all('SELECT * FROM automations WHERE id = ?', ['only']))[0];
  assert.equal(row.owner_user_id, 'a', '并发修改时不得转移归属');
  assert.equal(row.deleted_at, null);
  assert.equal(row.prompt, '用户刚改的内容', '用户刚写入的内容必须保留');
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
  assert.deepEqual({ ...sync.pendingSync() }, { sourceUid: 'a', targetUid: 'b', at: sync.pendingSync().at });
  assert.equal((await f.live())[0].owner_user_id, 'a', '失败时任务仍归旧账号');

  const resumed = await sync.resume();
  assert.equal(resumed.resumed, true);
  assert.equal((await f.live())[0].owner_user_id, 'b');
  assert.equal(sync.pendingSync(), null, '成功后必须清空 pending');
});

test('只有 schema 缺失才降级，库被锁必须抛出而不是丢分组', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a');
  const broken = {
    ...f.db,
    async all(sql, params) {
      if (/SELECT space_id FROM automations LIMIT 1/.test(sql)) throw new Error('database is locked');
      return f.db.all(sql, params);
    },
  };
  await assert.rejects(f.buildSync({ db: broken })('a', 'b'), /database is locked/);
});

test('目标账号存在多个同名分组时按路径消歧，消不了就不绑定', async t => {
  const f = await fixture(t);
  await f.space('src', 'a', '工作区', { primary_folder_path: 'H:/AI工作区/甲' });
  await f.space('dup-1', 'b', '工作区', { primary_folder_path: 'H:/AI工作区/甲' });
  await f.space('dup-2', 'b', '工作区', { primary_folder_path: 'H:/AI工作区/乙' });
  await f.insert('task', 'a', { updated_at: 3, space_id: 'src' });

  await f.buildSync()('a', 'b');
  const moved = (await f.live())[0];
  assert.equal(moved.space_id, 'dup-1', '路径一致的同名分组才是对应的那一个');

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

test('getMode 每次同步只读取一次', async t => {
  const f = await fixture(t);
  await f.insert('only', 'a', { updated_at: 3 });
  let calls = 0;
  const sync = f.buildSync({ mode: undefined, getMode: () => { calls++; return 'move'; } });
  await sync('a', 'b');
  assert.equal(calls, 1);
});
