'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AUTOMATION_COLUMNS = [
  'id', 'name', 'prompt', 'status', 'schedule_type', 'next_run_at', 'last_run_at',
  'cwds', 'rrule', 'scheduled_at', 'valid_from', 'valid_until', 'model_id',
  'model_is_thinking', 'skills_json', 'push_to_wechat', 'push_to_wecom_bot',
  'owner_user_id', 'owner_status', 'owner_source', 'expert_id', 'expert_marketplace',
  'connector_ids_json', 'permission_mode', 'created_at', 'updated_at', 'deleted_at',
  'wecom_bot_source', 'context_window', 'reasoning_effort', 'workspace_scope',
  'wecom_bot_chat_id',
];

// Older WorkBuddy builds inserted NULL into columns that are NOT NULL in the
// current schema. Reusing the official defaults keeps those historical tasks
// copyable while preserving NULL for genuinely nullable columns.
const AUTOMATION_DEFAULTS = {
  cwds: '[]',
  rrule: '',
  model_is_thinking: 0,
  skills_json: '[]',
  push_to_wechat: 0,
  push_to_wecom_bot: 0,
  owner_status: 'legacy_unassigned',
  connector_ids_json: '[]',
};

function cleanUid(value) {
  const uid = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(uid) ? uid : '';
}

function readMapping(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid mapping');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    // Never silently lose task identities and create untracked copies.
    throw new Error('官方定时任务同步记录无法读取');
  }
}

function writeMapping(file, mapping) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function taskKey(sourceUid, sourceId, targetUid) {
  return `${sourceUid}:${sourceId}:${targetUid}`;
}

function nodeKey(uid, id) {
  return `${uid}:${id}`;
}

// Account ownership and execution history stay local. Only task definitions
// participate in edit detection, so a scheduler tick cannot undo a rename.
const DEFINITION_COLUMNS = AUTOMATION_COLUMNS.filter((column) => ![
  'id', 'owner_user_id', 'owner_status', 'owner_source', 'created_at', 'updated_at',
  'next_run_at', 'last_run_at',
].includes(column));
const SCHEDULE_COLUMNS = ['schedule_type', 'rrule', 'scheduled_at', 'valid_from', 'valid_until', 'status'];

function columnValue(row, column) {
  return row[column] == null ? (AUTOMATION_DEFAULTS[column] ?? null) : row[column];
}

function fingerprint(row) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(DEFINITION_COLUMNS.map((column) => columnValue(row, column))))
    .digest('hex');
}

function taskFreshness(row) {
  const value = row.updated_at ?? row.created_at;
  const number = Number(value);
  return Number.isFinite(number) ? number : (Date.parse(value) || 0);
}

function isLive(row) {
  return row.deleted_at == null && row.status !== 'ARCHIVED';
}

// 两种归属模型：
//   move（默认）同一任务全局只有一行，切号时把 owner_user_id 转给目标账号；
//   copy（旧模型）每个账号各复制一行，切号时保证每个账号都有一份。
// move 解决「一个定时任务每个账号各一条」：任务跟着当前登录账号走，不产生副本。
const SYNC_MODES = new Set(['move', 'copy']);

function mappingGraph(mapping) {
  const graph = new Map();
  const connect = (left, right) => {
    if (!graph.has(left)) graph.set(left, new Set());
    if (!graph.has(right)) graph.set(right, new Set());
    graph.get(left).add(right);
    graph.get(right).add(left);
  };
  Object.entries(mapping || {}).forEach(([key, value]) => {
    const parts = String(key).split(':');
    if (parts.length < 3 || !value || typeof value !== 'object') return;
    const sourceUid = parts.shift();
    const targetUid = parts.pop();
    const sourceId = parts.join(':');
    const targetId = String(value.targetAutomationId || '').trim();
    if (!cleanUid(sourceUid) || !cleanUid(targetUid) || !sourceId || !targetId) return;
    const sourceNode = nodeKey(sourceUid, sourceId);
    const targetNode = nodeKey(targetUid, targetId);
    connect(sourceNode, targetNode);
  });
  return { graph };
}

function componentNodes(graph, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    for (const next of graph.get(node) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function insertStatement(source, targetUid, id) {
  const columns = AUTOMATION_COLUMNS;
  const values = columns.map((column) => {
    if (column === 'id') return id;
    if (column === 'owner_user_id') return targetUid;
    const value = source[column];
    if (value === undefined || value === null) {
      return Object.prototype.hasOwnProperty.call(AUTOMATION_DEFAULTS, column)
        ? AUTOMATION_DEFAULTS[column] : null;
    }
    return value;
  });
  const placeholders = columns.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO automations (${columns.join(', ')}) VALUES (${placeholders})`,
    params: values,
  };
}

function createOfficialAutomationSync(options = {}) {
  const db = options.db;
  const mappingFile = options.mappingFile || path.join(String(options.dataDir || ''), 'official-automation-sync.json');
  const idFactory = options.idFactory || (() => crypto.randomUUID());
  if (!db || typeof db.all !== 'function') throw new TypeError('缺少官方定时任务数据库');

  function resolveMode() {
    if (typeof options.getMode === 'function') {
      try { return SYNC_MODES.has(options.getMode()) ? options.getMode() : 'move'; } catch (_) { return 'move'; }
    }
    return SYNC_MODES.has(options.mode) ? options.mode : 'move';
  }

  // 旧版 WorkBuddy 的 automations 表还没有 space_id 列；missing 时按无分组处理。
  let spaceColumn = null;
  async function hasSpaceColumn() {
    if (spaceColumn !== null) return spaceColumn;
    try { await db.all('SELECT space_id FROM automations LIMIT 1'); spaceColumn = true; }
    catch (_) { spaceColumn = false; }
    return spaceColumn;
  }

  async function readSpaceId(id) {
    if (!(await hasSpaceColumn())) return '';
    try {
      const rows = await db.all('SELECT space_id FROM automations WHERE id = ? LIMIT 1', [id]);
      return rows.length && rows[0].space_id != null ? String(rows[0].space_id).trim() : '';
    } catch (_) { return ''; }
  }

  // 任务转移账号后，分组引用必须改成目标账号自己的同名分组，否则客户端会引用
  // 别的账号的分组行。找不到同名分组就置空，宁可不分组也不跨账号悬空。
  async function resolveSpaceFor(spaceId, targetUid) {
    if (!spaceId) return '';
    try {
      const rows = await db.all('SELECT name FROM spaces WHERE id = ? LIMIT 1', [spaceId]);
      const name = rows.length ? String(rows[0].name || '').trim() : '';
      if (!name) return '';
      const target = await db.all(
        'SELECT id FROM spaces WHERE user_id = ? AND name = ? AND COALESCE(deleted_at, -1) = -1 ORDER BY created_at ASC LIMIT 1',
        [targetUid, name]
      );
      return target.length ? String(target[0].id).trim() : '';
    } catch (_) { return ''; }
  }

  async function reconcile(sourceValue, targetValue) {
    const sourceUid = cleanUid(sourceValue);
    const targetUid = cleanUid(targetValue);
    const mode = resolveMode();
    const result = { mode, copied: 0, updated: 0, moved: 0, removed: 0, skipped: 0, total: 0 };
    if (!sourceUid || !targetUid || sourceUid === targetUid) return result;

    // Reconcile the union for all saved accounts, including a third account's
    // unique tasks, before the destination renderer reads its task list.
    const savedUids = options.getAccountUids ? await options.getAccountUids() : [];
    const owners = [...new Set([sourceUid, targetUid, ...savedUids.map(cleanUid)].filter(Boolean))];
    const rows = await db.all(`SELECT ${AUTOMATION_COLUMNS.join(', ')} FROM automations
      WHERE owner_user_id IN (${owners.map(() => '?').join(', ')})`, owners);
    const mapping = readMapping(mappingFile);
    const state = mapping.__syncState || {};
    const snapshots = state.snapshots || {};
    const retired = { ...(state.retired || {}) };
    const nextSnapshots = { ...snapshots };
    const { graph } = mappingGraph(mapping);
    const byNode = new Map(rows.map(row => [nodeKey(row.owner_user_id, row.id), row]));
    const visited = new Set();
    const groups = [];
    for (const [node] of byNode) {
      if (visited.has(node) || retired[node]) continue;
      const nodes = componentNodes(graph, node);
      nodes.forEach(n => visited.add(n));
      const members = [...nodes].filter(n => byNode.has(n) && !retired[n]).map(n => byNode.get(n));
      if (members.length) groups.push(members);
    }

    // Adopt identical pre-existing copies one-to-one across different owners.
    // Never collapse intentionally separate tasks in the same account, nor
    // once tasks whose scheduled dates differ.
    for (let i = 0; i < groups.length; i++) {
      const ownersInGroup = new Set(groups[i].map(r => r.owner_user_id));
      const hashes = new Set(groups[i].filter(isLive).map(fingerprint));
      for (let j = i + 1; j < groups.length; j++) {
        if (!groups[j].length || groups[j].some(r => ownersInGroup.has(r.owner_user_id))) continue;
        if (!groups[j].some(r => isLive(r) && hashes.has(fingerprint(r)))) continue;
        groups[j].forEach(r => { ownersInGroup.add(r.owner_user_id); if (isLive(r)) hashes.add(fingerprint(r)); });
        groups[i].push(...groups[j]);
        groups[j] = [];
      }
    }

    const statements = [];
    const usedIds = new Set(rows.map(r => r.id));
    const freshnessOrder = (a, b) => taskFreshness(b) - taskFreshness(a) ||
      Number(b.owner_user_id === sourceUid) - Number(a.owner_user_id === sourceUid) ||
      nodeKey(a.owner_user_id, a.id).localeCompare(nodeKey(b.owner_user_id, b.id));
    if (mode === 'move') {
      const withSpace = await hasSpaceColumn();
      const transferSql = withSpace
        ? 'UPDATE automations SET owner_user_id = ?, space_id = ? WHERE id = ? AND owner_user_id = ?'
        : 'UPDATE automations SET owner_user_id = ? WHERE id = ? AND owner_user_id = ?';
      for (const members of groups) {
        if (!members.length) continue;
        // 同 copy 模型：一次真实的定义修改压过「只是跑过一次」的更新时间。
        const changed = members.filter((row) => {
          const previous = snapshots[nodeKey(row.owner_user_id, row.id)];
          return previous && previous !== fingerprint(row);
        });
        const canonical = [...(changed.length ? changed : members)].sort(freshnessOrder)[0];
        // 规范行已删除：删除同步到所有副本，反向切号也不复活。
        if (!isLive(canonical)) {
          for (const row of members) if (isLive(row)) retired[nodeKey(row.owner_user_id, row.id)] = true;
          continue;
        }
        result.total++;
        // 其余副本一律停用（软删除，可恢复）：同一任务全局只留一行。
        for (const row of members) {
          if (row.id === canonical.id || !isLive(row)) continue;
          retired[nodeKey(row.owner_user_id, row.id)] = true;
        }
        if (canonical.owner_user_id === targetUid) {
          result.skipped++;
          nextSnapshots[nodeKey(targetUid, canonical.id)] = fingerprint(canonical);
          continue;
        }
        if (withSpace) {
          const ownSpace = await readSpaceId(canonical.id);
          const nextSpace = ownSpace ? await resolveSpaceFor(ownSpace, targetUid) : '';
          statements.push({ sql: transferSql, params: [targetUid, nextSpace || null, canonical.id, canonical.owner_user_id] });
        } else {
          statements.push({ sql: transferSql, params: [targetUid, canonical.id, canonical.owner_user_id] });
        }
        mapping[taskKey(canonical.owner_user_id, canonical.id, targetUid)] = {
          targetAutomationId: canonical.id,
          sourceUpdatedAt: canonical.updated_at == null ? null : String(canonical.updated_at),
        };
        nextSnapshots[nodeKey(targetUid, canonical.id)] = fingerprint(canonical);
        result.moved++;
      }
    }
    if (mode === 'copy') for (const members of groups) {
      if (!members.length) continue;
      // A genuine definition edit beats an unchanged copy whose updated_at
      // merely advanced during execution. On first migration use latest edit.
      const changed = members.filter(row => {
        const previous = snapshots[nodeKey(row.owner_user_id, row.id)];
        return previous && previous !== fingerprint(row);
      });
      const canonical = [...(changed.length ? changed : members)].sort(freshnessOrder)[0];
      const live = isLive(canonical);
      if (live) result.total++;
      const survivors = [];
      for (const owner of owners) {
        const candidates = members.filter(row => row.owner_user_id === owner).sort(freshnessOrder);
        let row = candidates[0];
        if (!row && !live) continue; // Do not manufacture deleted history.
        if (!row) {
          const id = String(idFactory());
          if (!/^[0-9a-f-]{8,128}$/i.test(id) || usedIds.has(id)) throw new Error('官方定时任务 ID 无效');
          usedIds.add(id);
          statements.push(insertStatement(canonical, owner, id));
          row = { ...canonical, id, owner_user_id: owner };
          result.copied++;
        } else if (fingerprint(row) !== fingerprint(canonical)) {
          const columns = [...DEFINITION_COLUMNS, 'updated_at'];
          // Renames do not overwrite the target's run history. A changed
          // schedule does need its new next occurrence, as in the official edit.
          if (SCHEDULE_COLUMNS.some(c => columnValue(row, c) !== columnValue(canonical, c))) columns.push('next_run_at');
          statements.push({
            sql: `UPDATE automations SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND owner_user_id = ?`,
            params: [...columns.map(c => columnValue(canonical, c)), row.id, owner],
          });
          result.updated++;
        } else if (live) result.skipped++;
        survivors.push(row);
        nextSnapshots[nodeKey(owner, row.id)] = fingerprint(canonical);
        for (const duplicate of candidates.slice(1)) {
          retired[nodeKey(owner, duplicate.id)] = true;
        }
      }
      // Keep historical edges, including missing old IDs, so old A→B→H
      // mappings still identify reverse copies after upgrading or restarting.
      for (const row of survivors) {
        if (row.id === canonical.id) continue;
        mapping[taskKey(canonical.owner_user_id, canonical.id, row.owner_user_id)] = {
          targetAutomationId: row.id,
          sourceUpdatedAt: canonical.updated_at == null ? null : String(canonical.updated_at),
        };
      }
    }

    for (const row of rows) {
      if (!retired[nodeKey(row.owner_user_id, row.id)] || !isLive(row)) continue;
      statements.push({
        sql: 'UPDATE automations SET deleted_at = ? WHERE id = ? AND owner_user_id = ?',
        params: [Date.now(), row.id, row.owner_user_id],
      });
      result.removed++;
    }
    // Persist identities before SQL so a crash or failed mapping write cannot
    // leave an inserted task without a lineage. Only advance edit baselines
    // after the transaction commits. Retired rows are retried after failures.
    mapping.__syncState = { snapshots, retired };
    writeMapping(mappingFile, mapping);
    if (statements.length) await db.transaction(statements);
    mapping.__syncState = { snapshots: nextSnapshots, retired };
    writeMapping(mappingFile, mapping);
    return result;
  }

  // Manual/automation switches can both reach this service; serialize them so
  // they cannot generate two IDs from the same pre-sync snapshot.
  let pending = Promise.resolve();
  return function syncOfficialAutomations(sourceUid, targetUid) {
    const run = pending.then(() => reconcile(sourceUid, targetUid));
    pending = run.catch(() => {});
    return run;
  };
}

module.exports = { AUTOMATION_COLUMNS, cleanUid, createOfficialAutomationSync };
