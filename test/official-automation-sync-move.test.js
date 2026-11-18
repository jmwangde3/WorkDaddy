'use strict';

// 单份任务模型（mode=move）：同一个定时任务全局只有一行，切号时转移归属，
// 不再给每个账号复制一份。锁死的契约：
//   1. 任何时刻 live 行数 == 逻辑任务数（不随账号数增长）；
//   2. 切号只改 owner_user_id，不产生新 id；
//   3. 目标账号删除任务后，反向切号不复活；
//   4. 分组引用改到目标账号的同名分组，找不到就置空，绝不跨账号悬空。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionDb } = require('../scripts/session-db');
const { createOfficialAutomationSync } = require('../scripts/official-automation-sync');

async function fixture(t, accounts = ['a', 'b', 'h']) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-official-move-'));
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
  const space = async (id, owner, name) => {
    await db.run('INSERT INTO spaces (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, owner, name, 1, 1]);
  };
  const mappingFile = path.join(dataDir, 'official-automation-sync.json');
  const buildSync = (options = {}) => createOfficialAutomationSync({ dataDir, db, getAccountUids: () => accounts, mode: 'move', ...options });
  const live = () => db.all('SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY id');
  const liveFor = owner => db.all('SELECT * FROM automations WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY id', [owner]);
  return { db, insert, space, mappingFile, buildSync, live, liveFor };
}

test('四账号各一份同名任务收敛成一行，切号只换归属不换 id', async t => {
  const f = await fixture(t);
  for (const owner of ['a', 'b', 'h']) await f.insert(`task-${owner}`, owner, { updated_at: 3 });
  const sync = f.buildSync();

  const first = await sync('a', 'b');
  assert.equal(first.mode, 'move');
  assert.equal(first.moved, 1, '只转移一行');
  assert.equal(first.copied, 0, '不再复制');
  const live = await f.live();
  assert.equal(live.length, 1, '全局只剩一行');
  assert.equal(live[0].owner_user_id, 'b');
  const survivorId = live[0].id;

  for (const [from, to] of [['b', 'a'], ['a', 'h'], ['h', 'b'], ['b', 'a']]) {
    await sync(from, to);
    const rows = await f.live();
    assert.equal(rows.length, 1, `${from}->${to} 后仍只有一行`);
    assert.equal(rows[0].id, survivorId, 'id 始终不变');
    assert.equal(rows[0].owner_user_id, to);
  }
  // 停用的副本是可恢复的软删除，不是物理删除。
  const retired = await f.db.all('SELECT id, deleted_at FROM automations WHERE deleted_at IS NOT NULL ORDER BY id');
  assert.equal(retired.length, 2);
  assert.ok(retired.every(row => row.deleted_at));
});

test('目标账号删除任务后，反向切号不复活', async t => {
  const f = await fixture(t);
  await f.insert('a-task', 'a');
  await f.insert('b-task', 'b');
  const sync = f.buildSync();
  await sync('a', 'b');
  assert.equal((await f.live()).length, 1);
  await f.db.run('UPDATE automations SET deleted_at = ?, updated_at = ?', [99, 99]);
  for (const pair of [['b', 'a'], ['a', 'h'], ['h', 'b']]) await sync(...pair);
  assert.deepEqual(await f.live(), []);
});

test('任务转移时分组引用改到目标账号的同名分组，找不到同名分组则置空', async t => {
  const f = await fixture(t);
  await f.space('sp-a', 'a', '路由器');
  await f.space('sp-b', 'b', '路由器');
  await f.insert('with-space', 'a', { space_id: 'sp-a' });
  await f.insert('no-counterpart', 'a', { space_id: 'sp-a-only', name: '只有 a 有的分组' });
  await f.space('sp-a-only', 'a', '私有分组');
  const sync = f.buildSync();
  await sync('a', 'b');
  const rows = await f.live();
  const moved = rows.find(row => row.id === 'with-space');
  assert.equal(moved.owner_user_id, 'b');
  assert.equal(moved.space_id, 'sp-b', '换成本账号同名分组');
  const orphan = rows.find(row => row.id === 'no-counterpart');
  assert.equal(orphan.owner_user_id, 'b');
  assert.equal(orphan.space_id, null, '目标账号没有同名分组时置空，不跨账号悬空');
});

test('编辑跟随单行：改名后再切号不会回退旧名称，也不会多出副本', async t => {
  const f = await fixture(t);
  await f.insert('a-task', 'a');
  await f.insert('b-task', 'b');
  const sync = f.buildSync();
  await sync('a', 'b');
  await f.db.run('UPDATE automations SET name = ?, updated_at = ? WHERE owner_user_id = ?', ['改过的名称', 7, 'b']);
  await sync('b', 'h');
  await sync('h', 'a');
  const rows = await f.live();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '改过的名称');
  assert.equal(rows[0].owner_user_id, 'a');
});

test('only-once 计划不同视为独立任务，各自转移互不吞并', async t => {
  const f = await fixture(t);
  const once = (id, owner, at, name) => f.insert(id, owner, { name, schedule_type: 'once', rrule: '', scheduled_at: at });
  await once('once-a', 'a', '2030-01-01T10:00:00Z', '一次性任务');
  await once('once-b', 'b', '2030-01-02T10:00:00Z', '一次性任务');
  const sync = f.buildSync();
  await sync('a', 'b');
  const rows = await f.live();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.owner_user_id === 'b'));
});

test('两个账号都停用同步时不写库；相同账号/null 参数同样不动', async t => {
  const f = await fixture(t);
  await f.insert('a-task', 'a');
  const sync = f.buildSync({ getMode: () => 'move' });
  await sync('a', 'a');
  await sync('', 'b');
  await sync('../bad', 'b');
  const rows = await f.live();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_user_id, 'a');
});

test('getMode 支持运行期切换：copy 仍按旧模型给每个账号补一份', async t => {
  const f = await fixture(t);
  await f.insert('a-task', 'a');
  let mode = 'move';
  const sync = f.buildSync({ mode: undefined, getMode: () => mode });
  await sync('a', 'b');
  assert.equal((await f.live()).length, 1, 'move 不复制');
  mode = 'copy';
  await sync('b', 'a');
  assert.equal((await f.live()).length, 3, 'copy 模式回填给各已保存账号');
});
