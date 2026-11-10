'use strict';
/**
 * Regression test for dedupeSessions() in scripts/rehome-sessions.js
 *
 *   node test/rehome-dedupe.test.js
 *
 * Uses a throwaway SQLite DB + fake projects/**\/<id>.jsonl files.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionDb } = require('../scripts/session-db.js');
const { dedupeSessions } = require('../scripts/rehome-sessions.js');

const CREATE = 'CREATE TABLE sessions (' +
  'id TEXT PRIMARY KEY, user_id TEXT, cwd TEXT, title TEXT, status TEXT, ' +
  'created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, is_background_automation INTEGER)';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehome-dedupe-test-'));
  const projects = path.join(tmp, 'projects', 'ws-slug');
  fs.mkdirSync(projects, { recursive: true });
  const dbPath = path.join(tmp, 'workbuddy.db');
  const db = createSessionDb({ dbPath });
  await db.run(CREATE);

  const mk = (id, title, cwd, updated, size, status = 'completed') => {
    fs.writeFileSync(path.join(projects, id + '.jsonl'), 'x'.repeat(size));
    return db.run(
      'INSERT INTO sessions (id,user_id,cwd,title,status,created_at,updated_at,deleted_at,is_background_automation) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)',
      [id, 'uid-a', cwd, title, status, 1000, updated, null, 0]
    );
  };

  // 3 identical copies -> keep the newest, soft-delete 2
  await mk('id-aaa', '同一会话', 'H:/ws/a', 3000, 500);
  await mk('id-bbb', '同一会话', 'H:/ws/a', 2000, 500);
  await mk('id-ccc', '同一会话', 'H:/ws/a', 1000, 500);
  // 2 identical copies in another workspace
  await mk('id-ddd', '另一个', 'H:/ws/b', 4000, 300);
  await mk('id-eee', '另一个', 'H:/ws/b', 3500, 300);
  // group with mismatched message size -> must be skipped entirely
  await mk('id-fff', '大小不同', 'H:/ws/c', 5000, 100);
  await mk('id-ggg', '大小不同', 'H:/ws/c', 4500, 999);
  // unique session
  await mk('id-hhh', '独立会话', 'H:/ws/d', 6000, 700);
  // archived row is outside the WHERE scope
  await mk('id-iii', '已归档', 'H:/ws/e', 7000, 400, 'archived');

  const dry = await dedupeSessions(db, tmp, { dryRun: true });
  assert.equal(dry.groups, 2, 'two safe duplicate groups detected');
  assert.equal(dry.dropped, 3, 'three redundant rows would be dropped');
  assert.equal(dry.applied, false, 'dry run writes nothing');
  const before = await db.all('SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL');
  assert.equal(Number(before[0].n), 9, 'dry run left rows untouched');

  const applied = await dedupeSessions(db, tmp, { dryRun: false });
  assert.equal(applied.groups, 2, 'two groups cleaned');
  assert.equal(applied.dropped, 3, 'three rows soft-deleted');
  assert.equal(applied.applied, true, 'applied flag set');

  const rows = await db.all('SELECT id, deleted_at FROM sessions ORDER BY id');
  const deleted = Object.fromEntries(rows.map((r) => [r.id, r.deleted_at]));
  assert.equal(deleted['id-aaa'], null, 'newest copy kept');
  assert.ok(deleted['id-bbb'] && deleted['id-ccc'], 'older copies soft-deleted');
  assert.equal(deleted['id-ddd'], null, 'newest of group 2 kept');
  assert.ok(deleted['id-eee'], 'older of group 2 soft-deleted');
  assert.equal(deleted['id-fff'], null, 'mismatched-size group skipped (kept)');
  assert.equal(deleted['id-ggg'], null, 'mismatched-size group skipped (kept)');
  assert.equal(deleted['id-hhh'], null, 'unique session kept');
  assert.equal(deleted['id-iii'], null, 'archived row untouched');

  // idempotent second run
  const second = await dedupeSessions(db, tmp, { dryRun: false });
  assert.equal(second.dropped, 0, 'second run drops nothing');

  // aggressive mode cleans the group whose copies diverged in size
  const aggressive = await dedupeSessions(db, tmp, { dryRun: false, aggressive: true });
  assert.equal(aggressive.dropped, 1, 'aggressive cleans the mismatched-size group');
  const rows2 = await db.all('SELECT id, deleted_at FROM sessions ORDER BY id');
  const d2 = Object.fromEntries(rows2.map((r) => [r.id, r.deleted_at]));
  assert.ok(d2['id-ggg'], 'older mismatched copy soft-deleted');
  assert.equal(d2['id-fff'], null, 'newest mismatched copy kept');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS rehome-dedupe.test.js — groups=' + applied.groups + ' dropped=' + applied.dropped);
}

main().catch((error) => {
  console.error('FAIL rehome-dedupe.test.js:', error);
  process.exitCode = 1;
});
