'use strict';
/**
 * Regression test: 切号后分组（spaces）必须跟着账号走。
 *
 *   node test/rehome-spaces.test.js
 *
 * 背景：客户端只渲染 `spaces.user_id = 当前 uid` 的分组。旧实现只 UPDATE
 * sessions.user_id，分组留在原账号名下 → 切回原账号时分组消失、会话只剩在
 * 「最近列表」。这里锁死四条不变量：镜像缺的分组、不动原账号那份、会话改挂到
 * 自己的同名分组、NULL 会话按 cwd 目录归位，并且重复执行零写入。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionDb } = require('../scripts/session-db.js');
const { createRehomeRunner } = require('../scripts/rehome-sessions.js');

const A = 'aaaaaaaa-0000-0000-0000-000000000000';
const B = 'bbbbbbbb-0000-0000-0000-000000000000';
const C = 'cccccccc-0000-0000-0000-000000000000';

const SPACE_FFRS_A = 's-ffrs-a';
const SPACE_COMPUTER_A = 's-computer-a';
const SPACE_WORKSPACE_A = 's-workspace-a';
const SPACE_COMPUTER_B = 's-computer-b';

const CREATE_SPACES = 'CREATE TABLE spaces (' +
  'id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL, name TEXT NOT NULL, ' +
  'primary_folder_path TEXT, create_folder_path TEXT, pinned INTEGER NOT NULL DEFAULT 0, ' +
  'sort_order INTEGER, status TEXT NOT NULL DEFAULT \'active\', ' +
  'transport TEXT NOT NULL DEFAULT \'local\', conversation_origin TEXT, ' +
  'deleted_at INTEGER NOT NULL DEFAULT -1, created_at INTEGER NOT NULL, ' +
  'updated_at INTEGER NOT NULL, source_kind TEXT)';

const CREATE_SESSIONS = 'CREATE TABLE sessions (' +
  'id TEXT PRIMARY KEY, user_id TEXT NOT NULL, cwd TEXT, title TEXT, ' +
  'status TEXT, deleted_at INTEGER, is_background_automation INTEGER, ' +
  'created_at INTEGER, updated_at INTEGER, transport TEXT NOT NULL DEFAULT \'local\', ' +
  'space_id TEXT)';

const INSERT_SPACE = 'INSERT INTO spaces (id, user_id, device_id, name, pinned, status, ' +
  'transport, deleted_at, created_at, updated_at, source_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const INSERT_SESSION = 'INSERT INTO sessions (id, user_id, cwd, title, status, deleted_at, ' +
  'is_background_automation, created_at, updated_at, transport, space_id) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehome-spaces-'));
  const dbPath = path.join(tmp, 'workbuddy.db');
  const db = createSessionDb({ dbPath });
  await db.run(CREATE_SPACES);
  await db.run(CREATE_SESSIONS);

  // 源账号 A：三个分组；目标账号 B：只有「电脑相关」。
  await db.run(INSERT_SPACE, [SPACE_FFRS_A, A, 'dev-1', 'FFRS', 0, 'active', 'local', -1, 1000, 1000, 'seed']);
  await db.run(INSERT_SPACE, [SPACE_COMPUTER_A, A, 'dev-1', '电脑相关', 0, 'active', 'local', -1, 1001, 1001, 'seed']);
  await db.run(INSERT_SPACE, [SPACE_WORKSPACE_A, A, 'dev-1', 'workspace', 0, 'active', 'local', -1, 1002, 1002, 'seed']);
  await db.run(INSERT_SPACE, [SPACE_COMPUTER_B, B, 'dev-1', '电脑相关', 0, 'active', 'local', -1, 1003, 1003, 'seed']);

  // 同名但目录明确不同 → 不是同一个逻辑分组，必须只报不合并不改挂。
  await db.run('INSERT INTO spaces (id, user_id, device_id, name, primary_folder_path, pinned, ' +
    'status, transport, deleted_at, created_at, updated_at, source_kind) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['s-conflict-a', A, 'dev-1', '项目X', 'H:/proj/x', 0, 'active', 'local', -1, 1010, 1010, 'seed']);
  await db.run('INSERT INTO spaces (id, user_id, device_id, name, primary_folder_path, pinned, ' +
    'status, transport, deleted_at, created_at, updated_at, source_kind) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['s-conflict-b', B, 'dev-1', '项目X', 'C:/work/x', 0, 'active', 'local', -1, 1011, 1011, 'seed']);

  // 多来源同名异目录：A/B 都是 H:/shared，C 是 D:/other → 身份无法确认，整体不镜像。
  const INS_SPACE_PATH = 'INSERT INTO spaces (id, user_id, device_id, name, primary_folder_path, pinned, ' +
    'status, transport, deleted_at, created_at, updated_at, source_kind) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  await db.run(INS_SPACE_PATH, ['s-shared-a', A, 'dev-1', '共享组', 'H:/shared', 0, 'active', 'local', -1, 1020, 1020, 'seed']);
  await db.run(INS_SPACE_PATH, ['s-shared-b', B, 'dev-1', '共享组', 'H:/shared', 0, 'active', 'local', -1, 1021, 1021, 'seed']);
  await db.run(INS_SPACE_PATH, ['s-shared-c', C, 'dev-1', '共享组', 'D:/other', 0, 'active', 'local', -1, 1022, 1022, 'seed']);

  // 目标账号自带两份同名分组：身份有歧义，不能挑一份继续 remap。
  await db.run(INS_SPACE_PATH, ['s-dup-b1', B, 'dev-1', '重复组', null, 0, 'active', 'local', -1, 1030, 1030, 'seed']);
  await db.run(INS_SPACE_PATH, ['s-dup-b2', B, 'dev-1', '重复组', null, 0, 'active', 'local', -1, 1031, 1031, 'seed']);
  await db.run(INS_SPACE_PATH, ['s-dup-a1', A, 'dev-1', '重复组', null, 0, 'active', 'local', -1, 1032, 1032, 'seed']);

  // t1/t3 属于 A 且挂 A 的分组；t2 属于 B 但还没挂分组（散在最近列表）。
  await db.run(INSERT_SESSION, ['t1', A, 'H:/AI工作区/FFRS', 'ffrs-A', 'completed', null, 0, 1000, 1000, 'local', SPACE_FFRS_A]);
  await db.run(INSERT_SESSION, ['t2', B, 'H:/AI工作区/workspace', 'ws-B', 'completed', null, 0, 1001, 1001, 'local', null]);
  await db.run(INSERT_SESSION, ['t3', A, 'H:/AI工作区/电脑相关', 'pc-A', 'completed', null, 0, 1002, 1002, 'local', SPACE_COMPUTER_A]);
  // t4 是 B 的回收站会话：cwd 看起来落在 workspace 下，但已删除，不能自动归位。
  await db.run(INSERT_SESSION, ['t4', B, 'H:/AI工作区/workspace', 'trash-B', 'completed', 1, 0, 1003, 1003, 'local', null]);
  // t5 挂在 A 的「共享组」上：该 name 多源目录冲突，会话应被 detach 成 NULL，不能留在别人分组里。
  await db.run(INSERT_SESSION, ['t5', A, 'H:/shared', 'shared-A', 'completed', null, 0, 1004, 1004, 'local', 's-shared-a']);
  // t7 的 cwd 是 workspace2：目录边界要挡住，不能被 workspace 抢走。
  await db.run(INSERT_SESSION, ['t7', B, 'H:/AI工作区/workspace2/proj', 'ws2-B', 'completed', null, 0, 1005, 1005, 'local', null]);
  // t8：A 的会话挂在 A 自己的「重复组」上，而 B 有两份同名分组 → 必须 detach，不能留在 A 的分组里。
  await db.run(INSERT_SESSION, ['t8', A, 'H:/AI工作区/重复组', 'dup-A', 'completed', null, 0, 1006, 1006, 'local', 's-dup-a1']);

  fs.writeFileSync(path.join(tmp, 'rehome-sessions.json'),
    JSON.stringify({ enabled: true, dedupe: false }, null, 2) + '\n');
  const runner = createRehomeRunner({ dataDir: tmp, dbPath });

  // 干跑：不动库，但要如实报出计划
  const dry = await runner.run(B, { dryRun: true });
  assert.equal(dry.ok, true, 'dry run ok');
  assert.equal(dry.affected, 4, 'A 的 t1/t3/t5/t8 会被接管');
  assert.deepEqual(dry.spaces.created.sort(), ['FFRS', 'workspace'], 'B 缺两个分组');
  assert.ok(!dry.spaces.created.includes('项目X'), '同名但目录不同 → 不镜像');
  assert.ok(dry.spaces.conflicts.some((c) => c.name === '项目X'), '冲突要出现在报告里');
  assert.ok(dry.spaces.conflicts.some((c) => c.reason === 'source-paths-differ'), '多来源同名异目录要报冲突');
  assert.ok(dry.spaces.conflicts.some((c) => c.reason === 'duplicate-target'), '目标重复同名要报冲突');
  assert.ok(!dry.spaces.created.includes('共享组'), '多源冲突不镜像');
  assert.equal(dry.spaces.adopted, 1, 't2 按目录归位（回收站 t4、workspace2 的 t7 都不算）');
  assert.equal(dry.spaces.remapped, 2, 't1/t3 从 A 的分组改挂到 B 的同名分组');
  const untouched = await db.all('SELECT COUNT(*) AS n FROM spaces WHERE user_id = ?', [B]);
  assert.equal(Number(untouched[0].n), 5, '干跑不写库');

  // 真跑
  const applied = await runner.run(B);
  assert.equal(applied.ok, true, 'apply ok: ' + (applied.error || ''));
  assert.ok(applied.backup && fs.existsSync(applied.backup), '写入前有备份');

  // 1) 目标账号拿到全套分组，且「电脑相关」复用自己的那份、不重复建
  const bSpaces = await db.all('SELECT id, name FROM spaces WHERE user_id = ? ORDER BY name', [B]);
  const names = bSpaces.map((r) => r.name).sort();
  assert.equal(names.length, 7, 'B 补上 FFRS / workspace 后共 7 个分组');
  assert.ok(names.includes('FFRS') && names.includes('workspace'), '缺的分组已补齐');
  assert.equal(bSpaces.filter((r) => r.name === '共享组').length, 1, '多源冲突的「共享组」不新增副本');
  assert.equal(bSpaces.filter((r) => r.name === '重复组').length, 2, '重复组保持两份不动');
  assert.equal(bSpaces.filter((r) => r.name === '电脑相关').length, 1, '同名分组不重复');
  assert.equal(bSpaces.find((r) => r.name === '电脑相关').id, SPACE_COMPUTER_B, '复用 B 原有分组');

  // 2) 原账号 A 的分组一份都不能少（切回去还要用）
  const aCount = await db.all('SELECT COUNT(*) AS n FROM spaces WHERE user_id = ?', [A]);
  assert.equal(Number(aCount[0].n), 6, 'A 的分组保持原样');

  // 3) 会话全归 B，并挂到 B 自己的同名分组
  const sessions = await db.all('SELECT id, user_id, space_id FROM sessions ORDER BY id');
  const byId = Object.fromEntries(sessions.map((r) => [r.id, r]));
  assert.equal(byId.t1.user_id, B, 't1 归 B');
  assert.equal(byId.t3.user_id, B, 't3 归 B');
  const bComputer = SPACE_COMPUTER_B;
  assert.equal(byId.t3.space_id, bComputer, 't3 改挂到 B 的电脑相关');
  const bFfrs = bSpaces.find((r) => r.name === 'FFRS').id;
  assert.equal(byId.t1.space_id, bFfrs, 't1 改挂到 B 新建的 FFRS');
  const bWorkspace = bSpaces.find((r) => r.name === 'workspace').id;
  assert.equal(byId.t2.space_id, bWorkspace, 't2 按 cwd 归位到 workspace');
  assert.equal(byId.t4.space_id, null, '回收站会话不自动归位');
  assert.equal(byId.t5.user_id, B, 't5 会话归 B');
  assert.equal(byId.t5.space_id, null, '冲突分组上的会话被 detach，不留在别人分组');
  assert.equal(byId.t7.space_id, null, 'workspace2 不被 workspace 抢走');
  assert.equal(byId.t8.user_id, B, 't8 会话归 B');
  assert.equal(byId.t8.space_id, null, 'duplicate-target 分组上的会话同样 detach');
  const conflictRow = await db.all("SELECT primary_folder_path FROM spaces WHERE id = 's-conflict-b'");
  assert.equal(conflictRow[0].primary_folder_path, 'C:/work/x', '冲突分组保留目标账号自己的目录');
  const conflictCount = await db.all("SELECT COUNT(*) AS n FROM spaces WHERE name = '项目X'");
  assert.equal(Number(conflictCount[0].n), 2, '冲突分组不新增副本');

  // 4) 幂等：再跑一次零写入、零备份
  const second = await runner.run(B);
  assert.equal(second.ok, true, 'second run ok');
  assert.equal(second.affected, 0, 'second run 不改会话');
  assert.deepEqual(second.spaces.created, [], 'second run 不新建分组');
  assert.equal(second.spaces.adopted, 0, 'second run 不再归位');
  assert.equal(second.spaces.remapped, 0, 'second run 不再改挂');
  assert.equal(second.backup, null, 'second run 不产生备份');

  // 5) 切回 A：A 的分组和会话都还在（这就是用户报的那个场景）
  const back = await runner.run(A);
  assert.equal(back.ok, true, 'switch back ok');
  const aAfter = await db.all('SELECT COUNT(*) AS n FROM spaces WHERE user_id = ?', [A]);
  assert.ok(Number(aAfter[0].n) >= 5, '切回 A 分组齐全（镜像只会补缺，不会删）');
  assert.ok(Array.isArray(back.spaces.created), '切回 A 允许补缺（镜像只增不删）');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS rehome-spaces.test.js — created=' + dry.spaces.created.join(',') +
    ' adopted=' + dry.spaces.adopted + ' remapped=' + dry.spaces.remapped);
}

main().catch((error) => {
  console.error('FAIL rehome-spaces.test.js:', error);
  process.exitCode = 1;
});
