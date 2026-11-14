'use strict';
/**
 * local / cloud 会话接管边界回归测试（P1）
 *
 *   node --test test/session-scope.test.js
 *
 * 默认只接管 transport='local'；云端会话在未验证前一律不动，
 * 即使配置里写了 cloudTakeover 也一样（必须同时 cloudVerified=true）。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionDb } = require('../scripts/session-db.js');
const { buildTakeoverScope, readTransportStats, assessDeletedSemantics } = require('../scripts/session-scope.js');
const { createRehomeRunner } = require('../scripts/rehome-sessions.js');

const TMP = [];
function tempDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wd-scope-${tag}-`));
  TMP.push(d);
  return d;
}

const CREATE = 'CREATE TABLE sessions (' +
  'id TEXT PRIMARY KEY, user_id TEXT, cwd TEXT, title TEXT, status TEXT, transport TEXT, ' +
  'created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, is_background_automation INTEGER)';

async function seed() {
  const root = tempDir('db');
  const dbPath = path.join(root, 'workbuddy.db');
  const db = createSessionDb({ dbPath });
  await db.run(CREATE);
  const ins = (id, transport, deleted, uid = 'uid-a') => db.run(
    'INSERT INTO sessions (id,user_id,cwd,title,status,transport,created_at,updated_at,deleted_at,is_background_automation) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, uid, 'H:/ws', 't', 'completed', transport, 1, 2, deleted, 0]
  );
  await ins('local-alive', 'local', null);
  await ins('local-archived', 'local', null);
  await ins('local-trashed', 'local', 1700000000000);
  await ins('cloud-alive', 'cloud', -1);
  await ins('cloud-trashed', 'cloud', 1700000000001);
  return { root, dbPath };
}

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`));
}

async function main() {
  // ---- 纯函数层 ----
  const legacy = buildTakeoverScope(['id', 'deleted_at']);
  assert.equal(legacy.transportAware, false);
  assert.equal(legacy.description, 'legacy-no-transport');
  assert.match(legacy.where, /deleted_at IS NULL OR deleted_at = -1/);

  const localOnly = buildTakeoverScope(['id', 'transport', 'deleted_at']);
  assert.equal(localOnly.description, 'local-only(strict)');
  assert.match(localOnly.where, /transport IS NULL OR transport = 'local'/);
  assert.match(localOnly.where, /^deleted_at IS NULL/, 'local 必须严格按 IS NULL 判定，不能带 -1');
  assert.doesNotMatch(localOnly.where, /deleted_at = -1/, 'local-only 不得把 -1 当存活');

  const cloudNotVerified = buildTakeoverScope(['id', 'transport'], { cloudTakeover: true, cloudVerified: false });
  assert.equal(cloudNotVerified.description, 'local-only(strict)', '未验证时即使开启也只接管 local');

  const cloudVerified = buildTakeoverScope(['id', 'transport'], { cloudTakeover: true, cloudVerified: true });
  assert.equal(cloudVerified.description, 'local+cloud(verified)');
  assert.equal(cloudVerified.where, '(deleted_at IS NULL OR deleted_at = -1)');

  // ---- 真实 SQL 行为（临时库）----
  const { root, dbPath } = await seed();
  const db = createSessionDb({ dbPath });

  await test('默认接管只改 local 存活行', async () => {
    const scope = buildTakeoverScope(await db.all("PRAGMA table_info('sessions')"));
    await db.run(
      `UPDATE sessions SET user_id = 'uid-target' WHERE ${scope.where} AND user_id <> 'uid-target'`,
      [...scope.params]
    );
    const rows = await db.all('SELECT id, user_id FROM sessions ORDER BY id');
    const map = Object.fromEntries(rows.map((r) => [r.id, r.user_id]));
    assert.equal(map['local-alive'], 'uid-target', 'local 存活行被接管');
    assert.equal(map['local-archived'], 'uid-target', 'local 归档行同样接管');
    assert.equal(map['local-trashed'], 'uid-a', '回收站不动');
    assert.equal(map['cloud-alive'], 'uid-a', '云端行默认不动');
    assert.equal(map['cloud-trashed'], 'uid-a', '云端回收站不动');
  });

  await test('云端未验证时不因配置而改变', async () => {
    const runner = createRehomeRunner({ dataDir: path.join(root, 'cfg'), dataRoot: root, dbPath });
    fs.mkdirSync(path.join(root, 'cfg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cfg', 'rehome-sessions.json'),
      JSON.stringify({ enabled: true, cloudTakeover: true }));
    const cfg = runner.readConfig();
    assert.equal(cfg.cloudTakeover, true);
    assert.equal(cfg.cloudVerified, false, '代码不会自动把 cloudVerified 置真');
    const out = await runner.run('uid-second');
    assert.equal(out.ok, true);
    const rows = await db.all("SELECT id, user_id FROM sessions WHERE id LIKE 'cloud-%' ORDER BY id");
    for (const r of rows) assert.equal(r.user_id, 'uid-a', `云端行不得被接管: ${r.id}`);
  });

  await test('transport 统计正确', async () => {
    const stats = await readTransportStats(db);
    assert.equal(stats.transportAware, true);
    const byName = Object.fromEntries(stats.rows.map((r) => [r.transport, r]));
    assert.equal(byName.local.alive, 2, 'local 存活 2（含归档，排除回收站）');
    assert.equal(byName.local.trashed, 1);
    assert.equal(byName.cloud.alive, 1);
    assert.equal(byName.cloud.trashed, 1);
  });

  await test('接管默认不跑去重', async () => {
    const cfgPath = path.join(root, 'cfg', 'rehome-sessions.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ enabled: true, dedupe: true }));
    const runner = createRehomeRunner({ dataDir: path.join(root, 'cfg'), dataRoot: root, dbPath });
    const out = await runner.run('uid-third');
    assert.equal(out.dedupe.skipped, 'manual-only');
    assert.equal(out.scopeReport.mode, 'local-only(strict)', '报告里要写明实际接管口径');
    assert.equal(out.scopeReport.semantics.verified, true, '干净库的语义体检应通过');
  });

  await test('deleted_at 语义体检：编码一致才算已验证', async () => {
    const sem = await assessDeletedSemantics(db);
    assert.equal(sem.transportAware, true);
    assert.equal(sem.verified, true, `干净库不应报异常: ${JSON.stringify(sem.issues)}`);
    const byName = Object.fromEntries((sem.rows || []).map((r) => [r.transport, r]));
    assert.equal(byName.local.live, 2);
    assert.equal(byName.local.trashed, 1);
    assert.equal(byName.local.ambiguous, 0);
    assert.equal(byName.cloud.live, 1, 'cloud 存活按 -1 统计');
    assert.equal(byName.cloud.ambiguous, 0);
  });

  await test('异常行与来源不明的 transport 一律不接管', async () => {
    const dir = tempDir('anomaly');
    const p = path.join(dir, 'workbuddy.db');
    const adb = createSessionDb({ dbPath: p });
    await adb.run(CREATE);
    const ins = (id, transport, deleted) => adb.run(
      'INSERT INTO sessions (id,user_id,cwd,title,status,transport,created_at,updated_at,deleted_at,is_background_automation) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, 'uid-a', 'H:/ws', 't', 'completed', transport, 1, 2, deleted, 0]
    );
    await ins('local-normal', 'local', null);
    await ins('local-minus-one', 'local', -1);        // local 行上出现 cloud 哨兵 → 异常
    await ins('proxy-alive', 'proxy', null);          // 来源不明的 transport
    await ins('cloud-normal', 'cloud', -1);

    const sem = await assessDeletedSemantics(adb);
    assert.equal(sem.verified, false, '有异常时必须判为未验证');
    assert.ok(sem.issues.some((x) => /local-rows-with-other-marker/.test(x)), sem.issues.join('|'));
    assert.deepEqual(sem.unknownTransports, ['proxy']);

    const scope = buildTakeoverScope(await adb.all("PRAGMA table_info('sessions')"));
    await adb.run(
      `UPDATE sessions SET user_id = 'uid-target' WHERE ${scope.where} AND user_id <> 'uid-target'`,
      [...scope.params]
    );
    const rows = await adb.all('SELECT id, user_id FROM sessions ORDER BY id');
    const map = Object.fromEntries(rows.map((r) => [r.id, r.user_id]));
    assert.equal(map['local-normal'], 'uid-target');
    assert.equal(map['local-minus-one'], 'uid-a', 'local 上的 -1 语义不确定，不碰');
    assert.equal(map['proxy-alive'], 'uid-a', '来源不明不碰');
    assert.equal(map['cloud-normal'], 'uid-a', 'cloud 未验证不碰');
  });

  console.log('PASS session-scope.test.js — local/cloud 边界 + 语义体检');
}

main()
  .catch((error) => {
    console.error('FAIL session-scope.test.js:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const d of TMP) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  });
