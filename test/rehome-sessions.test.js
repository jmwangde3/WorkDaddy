'use strict';
/**
 * Regression test for scripts/rehome-sessions.js
 *
 *   node test/rehome-sessions.test.js
 *
 * Uses a throwaway SQLite database; never touches the real WorkBuddy state.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionDb } = require('../scripts/session-db.js');
const { createRehomeRunner, alignStartupRoutes } = require('../scripts/rehome-sessions.js');

const CREATE = 'CREATE TABLE sessions (' +
  'id TEXT PRIMARY KEY, user_id TEXT NOT NULL, cwd TEXT, title TEXT, ' +
  'status TEXT, deleted_at INTEGER, is_background_automation INTEGER, ' +
  'created_at INTEGER, updated_at INTEGER)';
const INSERT = 'INSERT INTO sessions (id, user_id, cwd, title, status, deleted_at, is_background_automation, created_at, updated_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehome-test-'));
  const dbPath = path.join(tmp, 'workbuddy.db');
  const db = createSessionDb({ dbPath });
  await db.run(CREATE);

  const fixtures = [
    ['s1', A, 'H:/ws/a', 'normal-A', 'completed', null, 0, 1000, 2000],
    ['s2', B, 'H:/ws/a', 'normal-B', 'completed', null, 0, 1000, 2001],
    ['s3', C, 'H:/ws/b', 'normal-C', 'working', null, 0, 1000, 2002],
    ['s4', B, 'H:/ws/a', 'archived-B', 'archived', null, 0, 1000, 2003],
    ['s5', B, 'H:/ws/a', 'deleted-B', 'completed', 1, 0, 1000, 2004],
    ['s6', B, 'H:/ws/a', 'automation-B', 'completed', null, 1, 1000, 2005],
    // cloud 会话用 deleted_at = -1 表示「未删除」（客户端原文：transport='cloud' AND deleted_at = -1）
    ['s7', B, 'H:/ws/a', 'cloud-B', 'completed', -1, 0, 1000, 2006],
  ];
  for (const row of fixtures) await db.run(INSERT, row);

  const runner = createRehomeRunner({ dataDir: tmp, dbPath, log: (m) => console.log('[runner]', m) });

  // status
  const st = runner.status();
  assert.equal(st.enabled, true, 'default enabled');
  assert.equal(st.dbExists, true, 'db exists');
  assert.ok(st.backend, 'backend resolved');

  // dry run must not write
  const before = await db.all('SELECT id, user_id FROM sessions ORDER BY id');
  const dry = await runner.run(A, { dryRun: true });
  assert.equal(dry.ok, true, 'dry run ok');
  assert.equal(dry.dryRun, true, 'dry run flagged');
  assert.equal(dry.affected, 5, 's2/s3/s4(archived)/s6(automation)/s7(cloud,-1) are rehomed, s5(deleted) is not');
  assert.equal(dry.backup, null, 'dry run makes no backup');
  const afterDry = await db.all('SELECT id, user_id FROM sessions ORDER BY id');
  assert.deepEqual(afterDry, before, 'dry run left data untouched');

  // real run
  const applied = await runner.run(A);
  assert.equal(applied.ok, true, 'apply ok: ' + (applied.error || ''));
  assert.equal(applied.affected, 5, 'five rows changed');
  assert.ok(applied.backup && fs.existsSync(applied.backup), 'backup file created');

  const rows = await db.all('SELECT id, user_id FROM sessions ORDER BY id');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.user_id]));
  assert.equal(byId.s1, A, 's1 keeps A');
  assert.equal(byId.s2, A, 's2 rehomed to A');
  assert.equal(byId.s3, A, 's3 rehomed to A');
  assert.equal(byId.s4, A, 'archived row is rehomed (归档也接管)');
  assert.equal(byId.s5, B, 'deleted row untouched (回收站不接管)');
  assert.equal(byId.s6, A, 'background automation row is rehomed (运行记录也接管)');
  assert.equal(byId.s7, A, 'cloud row with deleted_at=-1 is rehomed (云端会话也接管)');

  // idempotent second run
  const second = await runner.run(A);
  assert.equal(second.ok, true, 'second run ok');
  assert.equal(second.affected, 0, 'second run changes nothing');
  assert.equal(second.backup, null, 'second run makes no backup');

  // disable switch
  runner.setEnabled(false);
  assert.equal(runner.readConfig().enabled, false, 'config persisted');
  const disabled = await runner.run(B);
  assert.equal(disabled.skipped, 'disabled', 'disabled run is a no-op');
  assert.equal(disabled.affected, 0, 'disabled run changes nothing');
  const afterDisabled = await db.all('SELECT id, user_id FROM sessions ORDER BY id');
  assert.deepEqual(afterDisabled, rows, 'disabled run left data untouched');

  // empty uid is rejected once re-enabled
  runner.setEnabled(true);
  const bad = await runner.run('');
  assert.equal(bad.ok, false, 'empty uid reports failure');

  // startup-route alignment: converge all accounts and keep hard links alive
  const dataRoot = path.join(tmp, 'wbroot');
  fs.mkdirSync(dataRoot);
  for (const id of [A, B, C]) fs.mkdirSync(path.join(dataRoot, id));
  const routeA = JSON.stringify({ path: '/conversation/session-1', savedAt: 1794280864424 });
  const routeB = JSON.stringify({ path: '/conversation/other', savedAt: 1 });
  fs.writeFileSync(path.join(dataRoot, A, 'startup-route.json'), routeA);
  fs.writeFileSync(path.join(dataRoot, B, 'startup-route.json'), routeB);
  fs.linkSync(path.join(dataRoot, A, 'startup-route.json'), path.join(dataRoot, C, 'startup-route.json'));
  const aligned = alignStartupRoutes(dataRoot, A);
  assert.equal(aligned.ok, true, 'align ok');
  assert.equal(aligned.written, 3, 'all three routes written');
  const routes = [A, B, C].map((id) => fs.readFileSync(path.join(dataRoot, id, 'startup-route.json'), 'utf8'));
  assert.deepEqual(routes, [routeA, routeA, routeA], 'all routes converge to source');
  const probe = JSON.stringify({ path: '/conversation/probe', savedAt: 2 });
  fs.writeFileSync(path.join(dataRoot, A, 'startup-route.json'), probe);
  assert.equal(fs.readFileSync(path.join(dataRoot, C, 'startup-route.json'), 'utf8'), probe,
    'A->C hard link survived in-place writes');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS rehome-sessions.test.js — backend=' + st.backend +
    ' dry=' + dry.affected + ' applied=' + applied.affected +
    ' backup=' + path.basename(applied.backup));
}

main().catch((error) => {
  console.error('FAIL rehome-sessions.test.js:', error);
  process.exitCode = 1;
});
