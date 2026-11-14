'use strict';
/**
 * 会话去重安全回归测试（P0）
 *
 *   node --test test/rehome-dedupe.test.js
 *
 * 覆盖 16 类场景：字节相同 / 同大小不同内容 / 混入独立会话 / UUID 覆盖 /
 * UUID 冲突 / 互不包含 / 缺文件 / 格式错误 / 扫描后文件变化 / 多候选保留者 /
 * 后台任务隔离 / 归档口径 / dry-run / 幂等 / 备份与回滚 / containment 显式开启。
 *
 * 全部使用临时目录 + 模拟 JSONL，不触碰真实 WorkBuddy 数据。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionDb } = require('../scripts/session-db.js');
const {
  createRehomeRunner, dedupeSessions, dedupeBackgroundSessions,
} = require('../scripts/rehome-sessions.js');
const { MODE_EXACT, MODE_CONTAINMENT, inspectSessionFile, planDedupe } = require('../scripts/session-dedupe.js');

const CREATE = 'CREATE TABLE sessions (' +
  'id TEXT PRIMARY KEY, user_id TEXT, cwd TEXT, title TEXT, status TEXT, ' +
  'created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, is_background_automation INTEGER)';

const dirs = [];
function tempDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wd-dedupe-${tag}-`));
  dirs.push(d);
  fs.mkdirSync(path.join(d, 'projects', 'ws'), { recursive: true });
  return d;
}

/** 生成一份 JSONL：每条消息一个 id，sessionId 可改写（模拟客户端复制行为）。 */
function jsonl(messages, sessionId) {
  return messages.map((m, i) => JSON.stringify({
    type: 'message',
    id: m.id,
    sessionId,
    role: m.role || 'user',
    content: m.content,
    timestamp: 1700000000000 + i,
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
async function insert(db, { id, title, cwd = 'H:/ws/a', updated = 1000, status = 'completed', bg = 0 }) {
  seq += 1;
  return db.run(
    'INSERT INTO sessions (id,user_id,cwd,title,status,created_at,updated_at,deleted_at,is_background_automation) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)',
    [id, 'uid-a', cwd, title, status, 1000 + seq, updated, null, bg]
  );
}

const msgs = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-msg-${i}`, content: `text-${prefix}-${i}` }));

async function deletedMap(db) {
  const rows = await db.all('SELECT id, deleted_at FROM sessions');
  return Object.fromEntries(rows.map((r) => [r.id, r.deleted_at]));
}

async function caseByteIdentical() {
  const root = tempDir('byte');
  const db = await makeDb(root);
  const m = msgs(3, 'a');
  writeSession(root, 'id-aaa', m, 'id-aaa');
  writeSession(root, 'id-bbb', m, 'id-aaa');   // 同一份字节复制
  await insert(db, { id: 'id-aaa', title: '同一会话', updated: 3000 });
  await insert(db, { id: 'id-bbb', title: '同一会话', updated: 2000 });

  const dry = await dedupeSessions(db, root, { dryRun: true });
  assert.equal(dry.dropped, 1, '字节相同的副本应识别为 1 条');
  assert.equal((await deletedMap(db))['id-bbb'], null, 'dry-run 不写库');

  const out = await dedupeSessions(db, root, { dryRun: false });
  assert.equal(out.applied, true);
  assert.equal(out.dropped, 1);
  const d = await deletedMap(db);
  assert.equal(d['id-aaa'], null, '保留 updated_at 最新的一条');
  assert.ok(d['id-bbb'], '旧副本被软删');
}

async function caseSameSizeDifferentContent() {
  const root = tempDir('samesize');
  const db = await makeDb(root);
  // 长度相同、内容不同：旧实现会误判成副本。
  writeSession(root, 'id-aaa', [{ id: 'x-1', content: 'AAAAAAAA' }], 'id-aaa');
  writeSession(root, 'id-bbb', [{ id: 'x-2', content: 'BBBBBBBB' }], 'id-bbb');
  const s1 = fs.statSync(path.join(root, 'projects', 'ws', 'id-aaa.jsonl')).size;
  const s2 = fs.statSync(path.join(root, 'projects', 'ws', 'id-bbb.jsonl')).size;
  assert.equal(s1, s2, '前置条件：文件大小相同');
  await insert(db, { id: 'id-aaa', title: '同大小', updated: 2000 });
  await insert(db, { id: 'id-bbb', title: '同大小', updated: 1000 });

  const out = await dedupeSessions(db, root, { dryRun: false });
  assert.equal(out.dropped, 0, '大小相同但内容不同，绝不能删');
  const d = await deletedMap(db);
  assert.equal(d['id-aaa'], null);
  assert.equal(d['id-bbb'], null);
}

async function caseCopiesPlusIndependent() {
  const root = tempDir('mixed');
  const db = await makeDb(root);
  const m = msgs(2, 'c');
  writeSession(root, 'id-aaa', m, 'id-aaa');
  writeSession(root, 'id-bbb', m, 'id-aaa');          // 与 aaa 完全相同（大小一致）
  writeSession(root, 'id-ccc', msgs(9, 'other'), 'id-ccc'); // 同标题同目录，内容独立
  await insert(db, { id: 'id-aaa', title: '混合组', updated: 3000 });
  await insert(db, { id: 'id-bbb', title: '混合组', updated: 2000 });
  await insert(db, { id: 'id-ccc', title: '混合组', updated: 1000 });

  const out = await dedupeSessions(db, root, { dryRun: false });
  assert.equal(out.dropped, 1, '只删确定的副本');
  const d = await deletedMap(db);
  assert.equal(d['id-aaa'], null);
  assert.ok(d['id-bbb'], '副本被删');
  assert.equal(d['id-ccc'], null, '独立会话必须保留（旧实现会误删）');
}

async function caseUuidContainment() {
  const root = tempDir('contain');
  const db = await makeDb(root);
  const base = msgs(3, 'k');
  writeSession(root, 'id-sub', base, 'id-sub');
  writeSession(root, 'id-full', base.concat([{ id: 'k-msg-3', content: 'later' }]), 'id-full');
  // 故意让「更完整」的那条 updated_at 更旧：包含关系必须优先于时间排序。
  await insert(db, { id: 'id-sub', title: '包含', updated: 9000 });
  await insert(db, { id: 'id-full', title: '包含', updated: 1000 });

  const exact = await dedupeSessions(db, root, { dryRun: true });
  assert.equal(exact.dropped, 0, '默认 exact 模式不动包含关系');

  const out = await dedupeSessions(db, root, { dryRun: false, mode: MODE_CONTAINMENT });
  assert.equal(out.dropped, 1, 'containment 模式删掉被完整覆盖的旧副本');
  const d = await deletedMap(db);
  assert.ok(d['id-sub'], '消息较少的被删');
  assert.equal(d['id-full'], null, '保留消息更完整的（不看 updated_at）');
}

async function caseUuidConflict() {
  const root = tempDir('conflict');
  const db = await makeDb(root);
  writeSession(root, 'id-aaa', [
    { id: 'same-1', content: 'AAAA' }, { id: 'same-2', content: 'shared' },
  ], 'id-aaa');
  writeSession(root, 'id-bbb', [
    { id: 'same-1', content: 'BBBB' }, { id: 'same-2', content: 'shared' },
  ], 'id-bbb');
  await insert(db, { id: 'id-aaa', title: '冲突', updated: 2000 });
  await insert(db, { id: 'id-bbb', title: '冲突', updated: 1000 });

  const out = await dedupeSessions(db, root, { dryRun: false, mode: MODE_CONTAINMENT });
  assert.equal(out.dropped, 0, '同 UUID 内容冲突：整组跳过');
  const d = await deletedMap(db);
  assert.equal(d['id-aaa'], null);
  assert.equal(d['id-bbb'], null);
}

async function caseDisjoint() {
  const root = tempDir('disjoint');
  const db = await makeDb(root);
  writeSession(root, 'id-aaa', [{ id: 'a-1', content: 'A' }, { id: 'a-2', content: 'B' }], 'id-aaa');
  writeSession(root, 'id-bbb', [{ id: 'a-1', content: 'A' }, { id: 'b-2', content: 'C' }], 'id-bbb');
  await insert(db, { id: 'id-aaa', title: '分叉', updated: 2000 });
  await insert(db, { id: 'id-bbb', title: '分叉', updated: 1000 });

  const out = await dedupeSessions(db, root, { dryRun: false, mode: MODE_CONTAINMENT });
  assert.equal(out.dropped, 0, '互不包含：两条都保留');
}

async function caseMissingFile() {
  const root = tempDir('missing');
  const db = await makeDb(root);
  writeSession(root, 'id-aaa', msgs(2, 'm'), 'id-aaa');
  await insert(db, { id: 'id-aaa', title: '缺文件', updated: 2000 });
  await insert(db, { id: 'id-bbb', title: '缺文件', updated: 1000 }); // 没有 jsonl

  const out = await dedupeSessions(db, root, { dryRun: false });
  assert.equal(out.dropped, 0, '有会话缺消息文件时整组跳过');
  assert.ok(out.skippedNoFile >= 1, '统计缺文件条数');
}

async function caseMalformedFile() {
  const root = tempDir('malformed');
  const db = await makeDb(root);
  writeSession(root, 'id-aaa', msgs(2, 'm'), 'id-aaa');
  fs.writeFileSync(path.join(root, 'projects', 'ws', 'id-bbb.jsonl'), '{not json}\n');
  await insert(db, { id: 'id-aaa', title: '坏文件', updated: 2000 });
  await insert(db, { id: 'id-bbb', title: '坏文件', updated: 1000 });

  const fp = inspectSessionFile(path.join(root, 'projects', 'ws', 'id-bbb.jsonl'));
  assert.equal(fp.ok, false, '坏 JSONL 不可解析');

  const out = await dedupeSessions(db, root, { dryRun: false, mode: MODE_CONTAINMENT });
  assert.equal(out.dropped, 0, '格式错误：不猜、不删');
}

async function caseFileChangesBetweenPlanAndApply() {
  const root = tempDir('race');
  const db = await makeDb(root);
  const m = msgs(3, 'r');
  writeSession(root, 'id-aaa', m, 'id-aaa');
  const target = writeSession(root, 'id-bbb', m, 'id-aaa');
  await insert(db, { id: 'id-aaa', title: '竞态', updated: 2000 });
  await insert(db, { id: 'id-bbb', title: '竞态', updated: 1000 });

  const { planDedupe, applyDedupe } = require('../scripts/session-dedupe.js');
  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  assert.equal(plan.drops.length, 1, '前置：计划内有 1 条待删');
  fs.appendFileSync(target, JSON.stringify({ type: 'message', id: 'r-msg-new', sessionId: 'id-bbb', content: 'new' }) + '\n');

  const out = await applyDedupe(db, plan, { backupRoot: path.join(root, 'bak') });
  assert.equal(out.ok, false, '文件变化必须中止');
  assert.equal(out.aborted, 'file-changed');
  assert.equal(out.backup, null, '中止时不该产生备份');
  const d = await deletedMap(db);
  assert.equal(d['id-bbb'], null, '中止后不写库');
}

async function caseMultipleKeepers() {
  const root = tempDir('multi');
  const db = await makeDb(root);
  const base = [{ id: 'base-1', content: 'base' }];
  writeSession(root, 'id-small', base, 'id-small');
  writeSession(root, 'id-big1', base.concat([{ id: 'big1', content: 'one' }]), 'id-big1');
  writeSession(root, 'id-big2', base.concat([{ id: 'big2', content: 'two' }]), 'id-big2');
  await insert(db, { id: 'id-small', title: '多候选', updated: 3000 });
  await insert(db, { id: 'id-big1', title: '多候选', updated: 2000 });
  await insert(db, { id: 'id-big2', title: '多候选', updated: 1000 });

  const out = await dedupeSessions(db, root, { dryRun: false, mode: MODE_CONTAINMENT });
  assert.equal(out.dropped, 0, '两个互不相同的候选保留者：无法唯一确定，全部保留');
}

async function caseBackgroundIsolated() {
  const root = tempDir('bg');
  const db = await makeDb(root);
  const m = msgs(2, 't');
  writeSession(root, 'id-bg1', m, 'id-bg1');
  writeSession(root, 'id-bg2', m, 'id-bg1');
  await insert(db, { id: 'id-bg1', title: '定时任务', updated: 2000, bg: 1 });
  await insert(db, { id: 'id-bg2', title: '定时任务', updated: 1000, bg: 1 });

  const manual = await dedupeSessions(db, root, { dryRun: false });
  assert.equal(manual.dropped, 0, '人工去重不碰后台任务');

  // 双重显式开关：只给 allowBackground 是只读计划，不写库。
  const planned = await dedupeBackgroundSessions(db, root, { allowBackground: true });
  assert.equal(planned.dropped, 1, 'allowBackground 后能看到将是副本的那条');
  assert.equal(planned.applied, false, '没有 apply 时必须是只读计划');
  assert.ok((await deletedMap(db))['id-bg2'] === null, '只读计划不写库');

  const refused = await dedupeBackgroundSessions(db, root, { apply: true });
  assert.equal(refused.skipped, 'background-dedupe-requires-allow-background', '缺 allowBackground 必须拒绝写入');
  assert.ok((await deletedMap(db))['id-bg2'] === null, '拒绝时也不写库');

  const bg = await dedupeBackgroundSessions(db, root, { allowBackground: true, apply: true });
  assert.equal(bg.dropped, 1, '后台任务有独立入口');
  assert.equal(bg.applied, true);
  const d = await deletedMap(db);
  assert.equal(d['id-bg1'], null);
  assert.ok(d['id-bg2']);
}

/** 嵌套层的 sessionId 是内容：两份文件仅嵌套值不同，绝不能被当成同一份。 */
async function caseNestedSessionIdIsContent() {
  const root = tempDir('nested');
  const db = await makeDb(root);
  const build = (sid, nested) => [0, 1].map((i) => JSON.stringify({
    type: 'message', id: `n-msg-${i}`, sessionId: sid, role: 'user',
    content: { text: `t${i}`, sessionId: nested },
  })).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'projects', 'ws', 'id-n1.jsonl'), build('id-n1', 'nested-alpha'));
  fs.writeFileSync(path.join(root, 'projects', 'ws', 'id-n2.jsonl'), build('id-n2', 'nested-beta'));
  await insert(db, { id: 'id-n1', title: '嵌套', updated: 2000 });
  await insert(db, { id: 'id-n2', title: '嵌套', updated: 1000 });

  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  assert.equal(plan.drops.length, 0, '嵌套 sessionId 不同 = 内容不同，不能判重复');
  assert.ok(/content-conflict/.test(plan.details[0].reason), `应报内容冲突，实际: ${plan.details[0].reason}`);
}

/** 同文件重复消息 UUID：覆盖关系无法确定 → 整组保留。 */
async function caseDuplicateMessageIds() {
  const root = tempDir('dupid');
  const db = await makeDb(root);
  const dup = [
    { type: 'message', id: 'd-1', sessionId: 'id-d1', content: 'a' },
    { type: 'message', id: 'd-1', sessionId: 'id-d1', content: 'b' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'projects', 'ws', 'id-d1.jsonl'), dup);
  fs.writeFileSync(path.join(root, 'projects', 'ws', 'id-d2.jsonl'), jsonl(msgs(1, 'd'), 'id-d2'));
  await insert(db, { id: 'id-d1', title: '重复UUID', updated: 2000 });
  await insert(db, { id: 'id-d2', title: '重复UUID', updated: 1000 });

  const fp = inspectSessionFile(path.join(root, 'projects', 'ws', 'id-d1.jsonl'));
  assert.equal(fp.ok, false, '重复 id 的指纹不能标成可用');
  assert.equal(fp.error, 'duplicate-message-ids');

  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  assert.equal(plan.drops.length, 0, '重复 UUID 的组必须整组保留');
  assert.ok(/unreadable-or-unstable/.test(plan.details[0].reason));
}

/** 附属产物（附件目录/同名图片）：即使字节完全相同也不动。 */
async function caseSidecarArtifacts() {
  const root = tempDir('sidecar');
  const db = await makeDb(root);
  const text = jsonl(msgs(2, 's'), 'id-s1').replace(/id-s1/g, 'id-s1');
  const p1 = path.join(root, 'projects', 'ws', 'id-s1.jsonl');
  const p2 = path.join(root, 'projects', 'ws', 'id-s2.jsonl');
  fs.writeFileSync(p1, text);
  fs.writeFileSync(p2, text.replace(/id-s1/g, 'id-s2'));
  // 同一目录下给 id-s1 造一个同名附件
  fs.writeFileSync(path.join(root, 'projects', 'ws', 'id-s1.png'), Buffer.from([1, 2, 3]));
  await insert(db, { id: 'id-s1', title: '附件', updated: 2000 });
  await insert(db, { id: 'id-s2', title: '附件', updated: 1000 });

  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_EXACT });
  assert.equal(plan.drops.length, 0, '有附属产物时不能按内容相同去重');
  assert.ok(/sidecar-artifacts/.test(plan.details[0].reason), plan.details[0].reason);
}

/** 包含关系里消息顺序不成立（id 序列不是子序列）→ 放弃，保留。 */
async function caseContainmentOrderMismatch() {
  const root = tempDir('order');
  const db = await makeDb(root);
  const mk = (ids) => ids.map((id) => JSON.stringify({
    type: 'message', id, sessionId: 'x', content: `c-${id}`,
  })).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'projects', 'ws', 'id-o1.jsonl'), mk(['m0', 'm2', 'm1']));
  fs.writeFileSync(path.join(root, 'projects', 'ws', 'id-o2.jsonl'), mk(['m0', 'm1', 'm2', 'm3']));
  await insert(db, { id: 'id-o1', title: '顺序', updated: 2000 });
  await insert(db, { id: 'id-o2', title: '顺序', updated: 1000 });

  const plan = await planDedupe(db, root, { scope: 'manual', mode: MODE_CONTAINMENT });
  assert.equal(plan.drops.length, 0, '顺序不成立的包含关系必须放弃');
  assert.ok(/subsequence/.test(plan.details[0].reason), plan.details[0].reason);
}

async function caseArchivedRule() {
  const root = tempDir('arch');
  const db = await makeDb(root);
  const m = msgs(2, 'ar');
  writeSession(root, 'id-ar1', m, 'id-ar1');
  writeSession(root, 'id-ar2', m, 'id-ar1');
  await insert(db, { id: 'id-ar1', title: '归档会话', updated: 2000, status: 'archived' });
  await insert(db, { id: 'id-ar2', title: '归档会话', updated: 1000, status: 'archived' });

  const out = await dedupeSessions(db, root, { dryRun: false });
  assert.equal(out.dropped, 1, '归档会话按既定规则参与去重（WHERE_DEDUPE 不排除 archived）');
}

async function caseDryRunAndIdempotent() {
  const root = tempDir('idem');
  const db = await makeDb(root);
  const m = msgs(2, 'i');
  writeSession(root, 'id-aaa', m, 'id-aaa');
  writeSession(root, 'id-bbb', m, 'id-aaa');
  await insert(db, { id: 'id-aaa', title: '幂等', updated: 2000 });
  await insert(db, { id: 'id-bbb', title: '幂等', updated: 1000 });

  const dry = await dedupeSessions(db, root, { dryRun: true });
  assert.equal(dry.dropped, 1);
  assert.equal(dry.applied, false);
  assert.equal((await db.all('SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL'))[0].n, 2, 'dry-run 零写入');

  const first = await dedupeSessions(db, root, { dryRun: false });
  assert.equal(first.dropped, 1);
  const second = await dedupeSessions(db, root, { dryRun: false });
  assert.equal(second.dropped, 0, '第二次执行幂等');
}

async function caseBackupRollback() {
  const root = tempDir('rollback');
  const db = await makeDb(root);
  const m = msgs(2, 'b');
  writeSession(root, 'id-aaa', m, 'id-aaa');
  writeSession(root, 'id-bbb', m, 'id-aaa');
  await insert(db, { id: 'id-aaa', title: '回滚', updated: 2000 });
  await insert(db, { id: 'id-bbb', title: '回滚', updated: 1000 });
  const backupRoot = path.join(root, 'rehome-backups');

  const runner = createRehomeRunner({ dataDir: path.join(root, 'cfg'), dataRoot: root, dbPath: path.join(root, 'workbuddy.db') });
  runner.setDedupe(true, MODE_EXACT);
  const out = await runner.runDedupe({});
  assert.equal(out.dropped, 1);
  assert.ok(out.backup && fs.existsSync(out.backup), '执行前必须生成 VACUUM INTO 备份');
  assert.ok(out.journal && fs.existsSync(out.journal), '执行后必须写操作日志');

  const journal = JSON.parse(fs.readFileSync(out.journal, 'utf8'));
  assert.equal(journal.rows.length, 1);
  assert.equal(journal.rows[0].id, 'id-bbb');
  assert.equal(journal.rows[0].before, null);
  assert.ok(journal.rows[0].after > 0);

  // 模拟「回滚前该行又被别处改过」：不能被旧日志覆盖。
  await db.run('UPDATE sessions SET deleted_at = ? WHERE id = ?', [123456, 'id-bbb']);
  const stale = await runner.runRollback(out.journal, {});
  assert.equal(stale.restored, 0, '记录之后被改过的行不回滚');
  assert.equal(stale.skipped[0].reason, 'changed-since-operation');

  // 恢复成操作写入值，再回滚。
  await db.run('UPDATE sessions SET deleted_at = ? WHERE id = ?', [journal.rows[0].after, 'id-bbb']);
  const ok = await runner.runRollback(out.journal, {});
  assert.equal(ok.restored, 1);
  assert.equal((await deletedMap(db))['id-bbb'], null, '回滚把 deleted_at 还原为 NULL');

  fs.existsSync(backupRoot);
}

async function caseConfigDefaultsOff() {
  const root = tempDir('cfg');
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  const db = await makeDb(root);
  const runner = createRehomeRunner({
    dataDir: path.join(root, 'cfg'), dataRoot: root, dbPath: path.join(root, 'workbuddy.db'),
  });
  const cfg = runner.readConfig();
  assert.equal(cfg.dedupe, false, '默认配置必须 dedupe=false');
  assert.equal(cfg.cloudTakeover, false, '默认不接管云端会话');

  // 配置显式 true 才生效
  runner.setDedupe(true);
  assert.equal(runner.readConfig().dedupe, true);

  // 环境变量显式关闭优先于配置
  process.env.WORKDADDY_REHOME_DEDUPE = '0';
  assert.equal(runner.readConfig().dedupe, false, '环境变量关掉时以关为准');
  delete process.env.WORKDADDY_REHOME_DEDUPE;

  // 未启用时手动入口拒绝执行
  const off = createRehomeRunner({ dataDir: path.join(root, 'cfg2'), dataRoot: root, dbPath: path.join(root, 'workbuddy.db') });
  const blocked = await off.runDedupe({});
  assert.equal(blocked.skipped, 'dedupe-disabled');
  assert.equal(blocked.dropped, 0);

  // 接管流程不再自动去重
  const m = msgs(2, 'auto');
  writeSession(root, 'id-x1', m, 'id-x1');
  writeSession(root, 'id-x2', m, 'id-x1');
  await insert(db, { id: 'id-x1', title: '接管', updated: 2000 });
  await insert(db, { id: 'id-x2', title: '接管', updated: 1000 });
  const enabledRunner = createRehomeRunner({
    dataDir: path.join(root, 'cfg3'), dataRoot: root, dbPath: path.join(root, 'workbuddy.db'),
  });
  enabledRunner.setDedupe(true);
  const takeover = await enabledRunner.run('uid-target');
  assert.equal(takeover.ok, true);
  assert.equal(takeover.dedupe.skipped, 'manual-only', '接管不再顺带执行去重');
  const d = await deletedMap(db);
  assert.equal(d['id-x1'], null);
  assert.equal(d['id-x2'], null, '接管后副本仍在（去重是手动动作）');
}

async function caseContainmentExplicit() {
  const root = tempDir('explicit');
  const db = await makeDb(root);
  const base = msgs(2, 'e');
  writeSession(root, 'id-sub', base, 'id-sub');
  writeSession(root, 'id-full', base.concat([{ id: 'e-msg-2', content: 'x' }]), 'id-full');
  await insert(db, { id: 'id-sub', title: '显式', updated: 5000 });
  await insert(db, { id: 'id-full', title: '显式', updated: 1000 });

  const runner = createRehomeRunner({
    dataDir: path.join(root, 'cfg'), dataRoot: root, dbPath: path.join(root, 'workbuddy.db'),
  });
  runner.setDedupe(true, MODE_EXACT);
  const exact = await runner.runDedupe({});
  assert.equal(exact.dropped, 0, '默认 exact 模式不处理包含关系');

  const containment = await runner.runDedupe({ aggressive: true });
  assert.equal(containment.mode, MODE_CONTAINMENT);
  assert.equal(containment.dropped, 1, '必须显式指定 containment 才启用包含判定');
}

async function caseDuplicatePlusContainment() {
  const root = tempDir('chain');
  const db = await makeDb(root);
  const base = msgs(2, 'ch');
  writeSession(root, 'id-a1', base, 'id-a1');
  writeSession(root, 'id-a2', base, 'id-a1');                       // 与 a1 完全相同
  writeSession(root, 'id-big', base.concat([{ id: 'ch-3', content: 'more' }]), 'id-big');
  await insert(db, { id: 'id-a1', title: '链式', updated: 5000 });
  await insert(db, { id: 'id-a2', title: '链式', updated: 4000 });
  await insert(db, { id: 'id-big', title: '链式', updated: 1000 });

  const out = await dedupeSessions(db, root, { dryRun: false, mode: MODE_CONTAINMENT });
  assert.equal(out.dropped, 2, '两个副本都应被删');
  for (const d of out.plan.drops) {
    assert.equal(d.keepId, 'id-big', `keepId 必须指向最终存活的会话（${d.id} -> ${d.keepId}）`);
  }
  const d = await deletedMap(db);
  assert.ok(d['id-a1'] && d['id-a2'], '重复副本都删');
  assert.equal(d['id-big'], null, '保留内容最完整的');
}

async function main() {
  try {
    await caseByteIdentical();
    await caseSameSizeDifferentContent();
    await caseCopiesPlusIndependent();
    await caseUuidContainment();
    await caseUuidConflict();
    await caseDisjoint();
    await caseMissingFile();
    await caseMalformedFile();
    await caseFileChangesBetweenPlanAndApply();
    await caseMultipleKeepers();
    await caseBackgroundIsolated();
    await caseArchivedRule();
    await caseDryRunAndIdempotent();
    await caseBackupRollback();
    await caseConfigDefaultsOff();
    await caseDuplicatePlusContainment();
    await caseContainmentExplicit();
    await caseNestedSessionIdIsContent();
    await caseDuplicateMessageIds();
    await caseSidecarArtifacts();
    await caseContainmentOrderMismatch();
    console.log('PASS rehome-dedupe.test.js — 21 类去重安全场景');
  } finally {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

main().catch((error) => {
  console.error('FAIL rehome-dedupe.test.js:', error);
  process.exitCode = 1;
});
