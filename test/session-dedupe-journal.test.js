'use strict';
/**
 * 去重事务状态机与身份快照（任务书 7.3–7.5）。
 *
 * 对应三个真实会发生的窗口：
 *   1. 计划与执行之间，会话被别人切了账号 / 改了工作目录 —— deleted_at 没变，CAS 发现不了；
 *   2. 计划与执行之间，附件目录冒出来了 —— 判定前提消失；
 *   3. 写库与写日志之间进程被杀 —— 库改了、日志没标，重启后得知道该怎么办。
 *
 * 全部使用临时目录 + 模拟 JSONL，不触碰真实数据。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSessionDb } = require('../scripts/session-db.js');
const {
  MODE_EXACT, planDedupe, applyDedupe, resumeDedupe, inspectJournalRows, JOURNAL_STATES,
} = require('../scripts/session-dedupe.js');

const CREATE = 'CREATE TABLE sessions (' +
  'id TEXT PRIMARY KEY, user_id TEXT, cwd TEXT, title TEXT, status TEXT, ' +
  'created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, is_background_automation INTEGER)';

const dirs = [];
function tempDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wd-dedupe-journal-${tag}-`));
  dirs.push(d);
  fs.mkdirSync(path.join(d, 'projects', 'ws'), { recursive: true });
  return d;
}
test.after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function jsonl(messages, sessionId) {
  return messages.map((m, i) => JSON.stringify({
    type: 'message', id: m.id, sessionId, role: 'user', content: m.content, timestamp: 1700000000000 + i,
  })).join('\n') + '\n';
}
function writeSession(root, id, messages, sessionId) {
  const p = path.join(root, 'projects', 'ws', id + '.jsonl');
  fs.writeFileSync(p, jsonl(messages, sessionId || id));
  return p;
}
async function makeDb(root) {
  const db = createSessionDb({ dbPath: path.join(root, 'workbuddy.db') });
  await db.run(CREATE);
  return db;
}
let seq = 0;
async function insert(db, { id, title, cwd = 'H:/ws/a', updated = 1000, userId = 'uid-a' }) {
  seq += 1;
  return db.run(
    'INSERT INTO sessions (id,user_id,cwd,title,status,created_at,updated_at,deleted_at,is_background_automation) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)',
    [id, userId, cwd, title, 'completed', 1000 + seq, updated, null, 0]
  );
}
const msgs = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-msg-${i}`, content: `text-${prefix}-${i}` }));
async function deletedMap(db) {
  const rows = await db.all('SELECT id, deleted_at FROM sessions');
  return Object.fromEntries(rows.map((r) => [r.id, r.deleted_at]));
}

async function seedPair(root, db, title) {
  const m = msgs(3, title);
  writeSession(root, 'id-keep', m, 'id-keep');
  writeSession(root, 'id-drop', m, 'id-keep');
  await insert(db, { id: 'id-keep', title, updated: 3000 });
  await insert(db, { id: 'id-drop', title, updated: 1000 });
}

test('状态机：一次成功执行会把 journal 推到 COMPLETED，并记下应用值', async () => {
  const root = tempDir('ok');
  const db = await makeDb(root);
  await seedPair(root, db, '正常去重');
  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  assert.equal(plan.drops.length, 1, '前置：应有 1 条待删');

  const backupRoot = path.join(root, 'bak');
  const out = await applyDedupe(db, plan, { backupRoot });
  assert.equal(out.ok, true);
  assert.equal(out.applied, true);
  assert.ok(out.journal, '必须有 journal 文件');

  const journal = JSON.parse(fs.readFileSync(out.journal, 'utf8'));
  assert.equal(journal.state, 'COMPLETED', '成功执行后应停在终态');
  assert.equal(journal.version, 2);
  assert.ok(JOURNAL_STATES.includes(journal.state));
  const after = (await deletedMap(db))['id-drop'];
  assert.ok(after > 0, '待删行应被软删除');
  assert.equal(journal.rows[0].after, after, 'journal 记的写入值必须与库一致');
  assert.ok(journal.rows[0].identity, 'journal 必须带身份快照');
  assert.equal(journal.rows[0].identity.user_id, 'uid-a');
});

test('身份快照：计划后 user_id 被改，即使 deleted_at 没变也必须中止', async () => {
  const root = tempDir('identity');
  const db = await makeDb(root);
  await seedPair(root, db, '身份变化');
  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  assert.equal(plan.drops.length, 1);

  // 模拟：期间这个会话被「接管」到另一个账号，deleted_at 仍是 NULL
  await db.run('UPDATE sessions SET user_id = ? WHERE id = ?', ['uid-evil', 'id-drop']);

  const out = await applyDedupe(db, plan, { backupRoot: path.join(root, 'bak') });
  assert.equal(out.ok, false, '身份变化必须中止');
  assert.equal(out.aborted, 'identity-changed');
  assert.match(String(out.abortedReason), /user_id/, '要指出哪个字段变了');
  assert.equal((await deletedMap(db))['id-drop'], null, '中止后不得写库');
});

test('身份快照：cwd 变化同样中止', async () => {
  const root = tempDir('cwd');
  const db = await makeDb(root);
  await seedPair(root, db, 'cwd 变化');
  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  await db.run('UPDATE sessions SET cwd = ? WHERE id = ?', ['H:/ws/elsewhere', 'id-drop']);
  const out = await applyDedupe(db, plan, { backupRoot: path.join(root, 'bak') });
  assert.equal(out.aborted, 'identity-changed');
  assert.match(String(out.abortedReason), /cwd/);
});

test('附件复验：计划后冒出 sidecar，必须中止（判定前提没了）', async () => {
  const root = tempDir('sidecar');
  const db = await makeDb(root);
  await seedPair(root, db, '附件冒出来');
  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  assert.equal(plan.drops.length, 1, '前置：计划时没有 sidecar，判为可删');

  // 模拟：期间该会话生成了附件目录
  fs.mkdirSync(path.join(root, 'projects', 'ws', 'id-drop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'ws', 'id-drop', 'a.png'), 'png');

  const out = await applyDedupe(db, plan, { backupRoot: path.join(root, 'bak') });
  assert.equal(out.ok, false, 'sidecar 出现后必须中止');
  assert.match(String(out.abortedReason || ''), /sidecar-changed/);
  assert.equal((await deletedMap(db))['id-drop'], null, '中止后不得写库');
});

test('恢复：库已改而日志停在 APPLYING，判为可推进到 COMPLETED', async () => {
  const root = tempDir('resume-committed');
  const db = await makeDb(root);
  await seedPair(root, db, '推进');
  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  const out = await applyDedupe(db, plan, { backupRoot: path.join(root, 'bak') });
  const journal = JSON.parse(fs.readFileSync(out.journal, 'utf8'));

  // 模拟崩溃现场：库已提交，但日志还没写完成
  journal.state = 'APPLYING';
  const verdict = await inspectJournalRows(db, journal);
  assert.equal(verdict.state, 'DB_COMMITTED');

  const resume = await resumeDedupe(db, journal, { dryRun: false });
  assert.equal(resume.ok, true);
  assert.equal(resume.action, 'mark-completed');
  assert.equal(journal.state, 'COMPLETED', '恢复后应推进到终态');
});

test('恢复：一行都没写进去，判为已回滚', async () => {
  const root = tempDir('resume-pending');
  const db = await makeDb(root);
  await seedPair(root, db, '未写入');
  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  const out = await applyDedupe(db, plan, { backupRoot: path.join(root, 'bak') });
  const journal = JSON.parse(fs.readFileSync(out.journal, 'utf8'));

  // 模拟：库回退到执行前，日志停在 APPLYING
  await db.run('UPDATE sessions SET deleted_at = NULL WHERE id = ?', ['id-drop']);
  journal.state = 'APPLYING';
  const verdict = await inspectJournalRows(db, journal);
  assert.equal(verdict.state, 'ROLLED_BACK');

  const resume = await resumeDedupe(db, journal, { dryRun: false });
  assert.equal(resume.action, 'mark-rolled-back');
  assert.equal(journal.state, 'ROLLED_BACK');
});

test('恢复：现场不一致时停下来，绝不自动覆盖', async () => {
  const root = tempDir('resume-mixed');
  const db = await makeDb(root);
  const m = msgs(3, 'mixed');
  writeSession(root, 'id-a', m, 'id-a');
  writeSession(root, 'id-b', m, 'id-a');
  writeSession(root, 'id-c', m, 'id-a');
  await insert(db, { id: 'id-a', title: '混合现场', updated: 5000 });
  await insert(db, { id: 'id-b', title: '混合现场', updated: 4000 });
  await insert(db, { id: 'id-c', title: '混合现场', updated: 3000 });

  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  assert.ok(plan.drops.length >= 2, '前置：至少 2 条待删');
  const out = await applyDedupe(db, plan, { backupRoot: path.join(root, 'bak') });
  const journal = JSON.parse(fs.readFileSync(out.journal, 'utf8'));

  // 模拟：一半被改回去、一半还留着 —— 这正是「看不出该前进还是该后退」的现场
  await db.run('UPDATE sessions SET deleted_at = ? WHERE id = ?', [null, journal.rows[0].id]);
  journal.state = 'APPLYING';

  const verdict = await inspectJournalRows(db, journal);
  assert.equal(verdict.state, 'RECOVERY_REQUIRED');

  const resume = await resumeDedupe(db, journal, { dryRun: false });
  assert.equal(resume.ok, false, '必须停下来');
  assert.equal(resume.action, 'stop');
  assert.ok(resume.reason, '要给出原因');
  assert.equal(journal.state, 'APPLYING', '不能擅自改状态');
});

test('恢复：终态重复调用是幂等的', async () => {
  const root = tempDir('resume-terminal');
  const db = await makeDb(root);
  await seedPair(root, db, '幂等');
  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  const out = await applyDedupe(db, plan, { backupRoot: path.join(root, 'bak') });
  const journal = JSON.parse(fs.readFileSync(out.journal, 'utf8'));
  assert.equal(journal.state, 'COMPLETED');

  const first = await resumeDedupe(db, journal, { dryRun: false });
  const second = await resumeDedupe(db, journal, { dryRun: false });
  assert.equal(first.action, 'already-terminal');
  assert.equal(second.action, 'already-terminal');
  assert.equal(journal.state, 'COMPLETED');
});

test('恢复默认只判定不动作（dryRun 默认 true）', async () => {
  const root = tempDir('resume-dry');
  const db = await makeDb(root);
  await seedPair(root, db, '干跑');
  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  const out = await applyDedupe(db, plan, { backupRoot: path.join(root, 'bak') });
  const journal = JSON.parse(fs.readFileSync(out.journal, 'utf8'));
  journal.state = 'APPLYING';
  const resume = await resumeDedupe(db, journal);
  assert.equal(resume.dryRun, true);
  assert.equal(journal.state, 'APPLYING', '默认不得改状态');
});

test('journal 状态集合覆盖任务书要求的七种', () => {
  assert.deepEqual([...JOURNAL_STATES].sort(), [
    'APPLYING', 'COMPLETED', 'DB_COMMITTED', 'PREPARED',
    'RECOVERY_REQUIRED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK',
  ].sort());
});
