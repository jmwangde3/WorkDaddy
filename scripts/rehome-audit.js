'use strict';
/**
 * rehome-audit.js — 接管模式只读体检：切号前先看「会不会复活」。
 *
 * 只回答两个问题，不改任何东西（DatabaseSync 以 readOnly 打开，不碰消息文件）：
 *   1) 库里还有没有「同一条会话存在两份活副本」——只有这种才会出现
 *      「a 删了、b 还在、切回 a 又冒出来」；
 *   2) 有没有「软删之后又被写入」的行——那是删除没生效、下次会被整条搬走的信号。
 *
 * 用法：
 *   node rehome-audit.js                # 人类可读
 *   node rehome-audit.js --json         # 机器可读，给别的 agent / 自动化用
 *   node rehome-audit.js --db=D:\path\workbuddy.db
 *   node rehome-audit.js --files        # 额外统计回收站里还留着消息文件的行数
 *
 * 退出码：0 = 无风险；2 = 发现风险（可直接接计划任务做巡检）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** 客户端「未删除」的两种编码：local = NULL，cloud = -1。 */
const NOT_DELETED = '(deleted_at IS NULL OR deleted_at = -1)';

function argValue(prefix) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

function resolveDbPath() {
  const explicit = argValue('--db=');
  if (explicit) return explicit;
  if (process.env.WORKBUDDY_DB) return process.env.WORKBUDDY_DB;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.workbuddy', 'workbuddy.db'),
    path.join(home, '.workbuddy-ai', 'workbuddy.db'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function openReadOnly(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return {
    all(sql, params = []) { return db.prepare(sql).all(...params).map((r) => ({ ...r })); },
    close() { try { db.close(); } catch (_) {} },
  };
}

/** <session-id> -> projects/**\/<id>.jsonl，只用于「回收站还占多少文件」这项统计。 */
function buildJsonlIndex(projectsRoot) {
  const idx = new Map();
  if (!projectsRoot || !fs.existsSync(projectsRoot)) return idx;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) idx.set(e.name.slice(0, -6), p);
    }
  };
  walk(projectsRoot, 0);
  return idx;
}

function audit(dbPath, opts = {}) {
  const db = openReadOnly(dbPath);
  const dataRoot = path.dirname(dbPath);          // ~/.workbuddy/workbuddy.db -> ~/.workbuddy
  const jsonlIndex = buildJsonlIndex(path.join(dataRoot, 'projects'));
  const sizeOf = (id) => {
    const p = jsonlIndex.get(String(id));
    if (!p) return -1;
    try { return fs.statSync(p).size; } catch (_) { return -1; }
  };
  try {
    const totals = db.all(
      `SELECT COUNT(*) AS all_rows,
              SUM(CASE WHEN ${NOT_DELETED} THEN 1 ELSE 0 END) AS alive,
              SUM(CASE WHEN ${NOT_DELETED} THEN 0 ELSE 1 END) AS deleted,
              SUM(CASE WHEN status = 'archived' AND ${NOT_DELETED} THEN 1 ELSE 0 END) AS archived
         FROM sessions`
    )[0] || {};

    const byUid = db.all(
      `SELECT user_id AS uid,
              SUM(CASE WHEN ${NOT_DELETED} THEN 1 ELSE 0 END) AS alive,
              SUM(CASE WHEN ${NOT_DELETED} THEN 0 ELSE 1 END) AS deleted
         FROM sessions GROUP BY user_id ORDER BY alive DESC, deleted DESC`
    );

    // 下一次切号会搬哪些行：接管口径 = 除回收站外全部。
    const takeoverRows = db.all(
      `SELECT user_id AS uid, COUNT(*) AS n FROM sessions WHERE ${NOT_DELETED} GROUP BY user_id`
    );

    // 双活副本：同 title + cwd 且活着的行 >= 2。这是「删一条另一条还在」的唯一形态。
    const aliveGroups = db.all(
      `SELECT COALESCE(title,'') AS title, COALESCE(cwd,'') AS cwd,
              SUM(CASE WHEN ${NOT_DELETED} THEN 1 ELSE 0 END) AS alive,
              COUNT(*) AS total
         FROM sessions
        GROUP BY COALESCE(title,''), COALESCE(cwd,'')
       HAVING alive >= 2
        ORDER BY alive DESC, total DESC`
    );
    // 同标题同目录的活会话按「消息文件字节数是否完全相同」再分两类：
    //   copies = true  → 是真的复制副本（删一条，另一条还在，形态上就是「复活」）
    //   copies = false → 同名但内容不同的独立会话（例如自动化任务每天各一份）
    const sameTitleGroups = aliveGroups.map((g) => {
      const rows = db.all(
        `SELECT id, user_id, updated_at, transport, COALESCE(is_background_automation,0) AS bg
           FROM sessions
          WHERE COALESCE(title,'') = ? AND COALESCE(cwd,'') = ? AND ${NOT_DELETED}
          ORDER BY updated_at DESC`,
        [g.title, g.cwd]
      ).map((r) => ({
        id: r.id,
        uid: r.user_id,
        updatedAt: r.updated_at,
        transport: r.transport,
        background: !!r.bg,
        size: sizeOf(r.id),
      }));
      const sizes = rows.map((r) => r.size).filter((s) => s > 0);
      return {
        title: g.title,
        cwd: g.cwd,
        alive: Number(g.alive || 0),
        total: Number(g.total || 0),
        background: rows.every((r) => r.background),
        copies: sizes.some((s, i) => sizes.indexOf(s) !== i),
        ids: rows,
      };
    });
    const copyGroups = sameTitleGroups.filter((g) => g.copies);

    // 软删之后又被写入：说明删除没被客户端当成终态，下次切号会整条搬走。
    const postDeleteActivity = db.all(
      `SELECT id, COALESCE(title,'') AS title, deleted_at, updated_at, last_activity_at
         FROM sessions
        WHERE deleted_at IS NOT NULL AND deleted_at <> -1
          AND (COALESCE(updated_at,0) > deleted_at OR COALESCE(last_activity_at,0) > deleted_at)
        ORDER BY deleted_at DESC`
    );

    // 云端会话的删除由服务端决定，本地软删不等于服务端已删；这一项只作提示。
    const cloudAlive = db.all(
      `SELECT id, COALESCE(title,'') AS title, user_id FROM sessions
        WHERE transport = 'cloud' AND ${NOT_DELETED}`
    );

    let recycleFiles = null;
    if (opts.files) {
      const deletedIds = db.all(`SELECT id FROM sessions WHERE NOT ${NOT_DELETED}`).map((r) => r.id);
      recycleFiles = deletedIds.filter((id) => jsonlIndex.has(String(id))).length;
    }

    const reasons = [];
    if (copyGroups.length) reasons.push(`${copyGroups.length} 组会话存在字节相同的双活副本（删一条另一条仍在）`);
    if (postDeleteActivity.length) reasons.push(`${postDeleteActivity.length} 条已删会话在删除后仍有写入`);

    return {
      dbPath,
      generatedAt: Date.now(),
      totals: {
        all: Number(totals.all_rows || 0),
        alive: Number(totals.alive || 0),
        deleted: Number(totals.deleted || 0),
        archived: Number(totals.archived || 0),
      },
      byUid: byUid.map((r) => ({ uid: String(r.uid || ''), alive: Number(r.alive || 0), deleted: Number(r.deleted || 0) })),
      takeover: {
        rows: takeoverRows.reduce((s, r) => s + Number(r.n || 0), 0),
        owners: takeoverRows.map((r) => ({ uid: String(r.uid || ''), n: Number(r.n || 0) })),
      },
      sameTitleGroups,
      copyGroups,
      postDeleteActivity: postDeleteActivity.map((r) => ({
        id: r.id, title: r.title, deletedAt: r.deleted_at, updatedAt: r.updated_at, lastActivityAt: r.last_activity_at,
      })),
      cloudAlive: cloudAlive.map((r) => ({ id: r.id, title: r.title, uid: r.user_id })),
      recycleFiles,
      verdict: { risk: reasons.length > 0, reasons },
    };
  } finally {
    db.close();
  }
}

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function print(report) {
  const t = report.totals;
  const line = (s = '') => process.stdout.write(s + '\n');
  line(`库：${report.dbPath}`);
  line(`会话 ${t.all} 条｜未删除 ${t.alive}（其中归档 ${t.archived}）｜回收站 ${t.deleted}`);
  line('');
  line('按账号归属：');
  for (const r of report.byUid) line(`  ${r.uid || '(空)'}  未删除 ${r.alive}  已删除 ${r.deleted}`);
  line('');
  line(`下一次切号会搬走 ${report.takeover.rows} 条未删除会话` +
    (report.takeover.owners.length ? `（来自 ${report.takeover.owners.map((o) => o.uid.slice(0, 8) + ':' + o.n).join(', ')}）` : ''));
  line('');
  if (report.copyGroups.length) {
    line(`[风险] 字节相同的双活副本 ${report.copyGroups.length} 组——删掉其中一条，另一条仍会被搬到当前账号：`);
    for (const g of report.copyGroups.slice(0, 10)) {
      line(`  ${g.alive}/${g.total} 活  ${g.title.slice(0, 40)}  @ ${g.cwd || '-'}${g.background ? '  [后台任务]' : ''}`);
      for (const i of g.ids.slice(0, 6)) {
        line(`      ${i.id.slice(0, 8)}  uid=${String(i.uid).slice(0, 8)}  ${i.transport}  ${fmtTime(i.updatedAt)}  ${i.size >= 0 ? i.size + ' B' : '无消息文件'}`);
      }
    }
  } else {
    line('[OK] 字节相同的双活副本 0 组：库内每条会话只有一份有效记录，删除后不会被另一份顶回来。');
  }
  const sameOnly = report.sameTitleGroups.filter((g) => !g.copies);
  if (sameOnly.length) {
    line(`[信息] 另有 ${sameOnly.length} 组同名同目录的独立会话（消息文件大小不同，不是副本）：`);
    for (const g of sameOnly.slice(0, 5)) line(`      ${g.alive}/${g.total} 活  ${g.title.slice(0, 40)}`);
  }
  line('');
  if (report.postDeleteActivity.length) {
    line(`[风险] ${report.postDeleteActivity.length} 条已删会话在删除后仍有写入（可能是删除未生效）：`);
    for (const r of report.postDeleteActivity.slice(0, 10)) {
      line(`  ${r.id.slice(0, 8)}  ${r.title.slice(0, 36)}  删于 ${fmtTime(r.deletedAt)}  更新于 ${fmtTime(r.updatedAt)}`);
    }
  } else {
    line('[OK] 已删会话 0 条在删除后被写入：删除是终态。');
  }
  line('');
  if (report.cloudAlive.length) {
    line(`[提示] ${report.cloudAlive.length} 条云端会话（transport=cloud）：本地软删不代表服务端已删，`);
    line('       若服务端仍保留，客户端重新拉列表时可能落回一条新行——这属于客户端行为，不是接管搬回来的。');
  }
  if (report.recycleFiles !== null) {
    line(`[信息] 回收站行里仍有 ${report.recycleFiles} 条对应的消息文件（磁盘占用，不影响列表）。`);
  }
  line('');
  line(report.verdict.risk
    ? `结论：有风险 —— ${report.verdict.reasons.join('；')}`
    : '结论：无复活风险。');
}

function main() {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`找不到会话库：${dbPath}\n用 --db=... 指定，或先启动一次 WorkBuddy。\n`);
    process.exit(1);
  }
  const report = audit(dbPath, { files: process.argv.includes('--files') });
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else print(report);
  process.exit(report.verdict.risk ? 2 : 0);
}

if (require.main === module) main();

module.exports = { audit, resolveDbPath, NOT_DELETED };
