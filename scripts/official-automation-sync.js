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

function normalizeSpacePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Only explicit schema drift may be downgraded. Locked/I/O failures must abort
// the sync: treating them as "no such column" would silently drop space refs.
function isMissingSchema(error, needle) {
  const message = String((error && error.message) || '').toLowerCase();
  if (!/no such (column|table)/.test(message)) return false;
  return needle ? message.includes(String(needle).toLowerCase()) : true;
}

// 分组是任务身份的一部分：同名同内容但属于不同分组的任务不是同一个任务。
// 跨账号的分组 id 不同，所以用规范化后的分组名做稳定标识，而不是原始 id。
function fingerprint(row, spaceIdentity = '') {
  return crypto.createHash('sha256')
    .update(JSON.stringify([spaceIdentity, ...DEFINITION_COLUMNS.map((column) => columnValue(row, column))]))
    .digest('hex');
}

function spaceIdentityOf(row, index) {
  if (!index) return '';
  const id = row && row.space_id != null ? String(row.space_id).trim() : '';
  if (!id) return '';
  const record = index.get(id);
  return record && record.name ? record.name.toLowerCase() : '';
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
      try {
        // 只读一次：两次调用之间外部设置可能变化，会让本次同步语义前后不一致。
        const raw = options.getMode();
        return SYNC_MODES.has(raw) ? raw : 'move';
      } catch (_) { return 'move'; }
    }
    return SYNC_MODES.has(options.mode) ? options.mode : 'move';
  }

  // 旧版 WorkBuddy 的 automations 表还没有 space_id 列；只有明确的 schema 缺失才降级。
  // 其它错误（库被锁、I/O 失败）不缓存、不吞掉，直接让本次同步失败。
  let spaceColumn = null;
  async function ensureSpaceSupport() {
    if (spaceColumn !== null) return spaceColumn;
    try {
      await db.all('SELECT space_id FROM automations LIMIT 1');
      spaceColumn = true;
    } catch (error) {
      if (!isMissingSchema(error, 'space_id')) throw error;
      spaceColumn = false;
    }
    return spaceColumn;
  }

  async function loadSpaceIndex() {
    if (!(await ensureSpaceSupport())) return null;
    let rows;
    try {
      rows = await db.all('SELECT id, name, primary_folder_path, create_folder_path FROM spaces');
    } catch (error) {
      if (isMissingSchema(error, 'spaces')) return null;
      throw error;
    }
    const index = new Map();
    for (const row of rows) {
      index.set(String(row.id), {
        name: String(row.name || '').trim(),
        paths: [row.primary_folder_path, row.create_folder_path].map(normalizeSpacePath).filter(Boolean),
      });
    }
    return index;
  }

  // 任务转移账号后，分组引用必须改成目标账号自己的同名分组，否则客户端会引用
  // 别的账号的分组行。找不到同名分组就置空，宁可不分组也不跨账号悬空。
  async function resolveSpaceFor(spaceId, targetUid, spaceIndex) {
    if (!spaceId) return '';
    const record = spaceIndex ? spaceIndex.get(String(spaceId)) : null;
    const name = record && record.name ? record.name : '';
    if (!name) return '';
    const rows = await db.all(
      'SELECT id, primary_folder_path, create_folder_path FROM spaces WHERE user_id = ? AND name = ? AND COALESCE(deleted_at, -1) = -1 ORDER BY id ASC',
      [targetUid, name]
    );
    if (!rows.length) return '';
    if (rows.length === 1) return String(rows[0].id).trim();
    // 目标账号存在多个同名分组：只有路径能唯一对上时才绑定，否则宁可不分组，
    // 避免把任务挂到语义不同的分组上。
    const wanted = new Set(record.paths || []);
    if (!wanted.size) return '';
    const matched = rows.filter((row) => [row.primary_folder_path, row.create_folder_path]
      .map(normalizeSpacePath).filter(Boolean).some((value) => wanted.has(value)));
    return matched.length === 1 ? String(matched[0].id).trim() : '';
  }

  // 同一逻辑任务组里，同一个账号出现多条 live 行且定义不同，说明历史 mapping
  // 把两个不同任务连在了一起。此时必须报冲突并保持原样，不能选一条退役其余。
  function componentHasOwnerConflict(members, hashes) {
    const seen = new Map();
    for (const row of members) {
      if (!isLive(row)) continue;
      const list = seen.get(row.owner_user_id) || [];
      list.push(hashes.get(nodeKey(row.owner_user_id, row.id)));
      seen.set(row.owner_user_id, list);
    }
    for (const list of seen.values()) {
      if (list.length > 1 && new Set(list).size > 1) return true;
    }
    return false;
  }

  async function runStatements(statements) {
    if (!statements.length) return;
    if (typeof db.writeTransaction === 'function') {
      await db.writeTransaction(async (tx) => {
        for (const statement of statements) {
          const outcome = tx.run(statement.sql, statement.params);
          // guard 语句带 updated_at 条件：0 行命中说明该行在规划之后被改过，
          // 整笔回滚，交给下一次切号重算，绝不在新内容上做旧决策。
          if (statement.guard && Number(outcome && outcome.changes) === 0) {
            throw new Error('定时任务在同步期间被修改，本次同步已回滚');
          }
        }
      });
      return;
    }
    await db.transaction(statements.map(({ sql, params }) => ({ sql, params })));
  }

  async function reconcile(sourceValue, targetValue) {
    const sourceUid = cleanUid(sourceValue);
    const targetUid = cleanUid(targetValue);
    const mode = resolveMode();
    const result = { mode, copied: 0, updated: 0, moved: 0, removed: 0, skipped: 0, total: 0, conflicts: 0 };
    if (!sourceUid || !targetUid || sourceUid === targetUid) return result;

    const withSpace = await ensureSpaceSupport();
    const spaceIndex = withSpace ? await loadSpaceIndex() : null;
    // Reconcile the union for all saved accounts, including a third account's
    // unique tasks, before the destination renderer reads its task list.
    const savedUids = options.getAccountUids ? await options.getAccountUids() : [];
    const owners = [...new Set([sourceUid, targetUid, ...savedUids.map(cleanUid)].filter(Boolean))];
    const selectColumns = withSpace ? [...AUTOMATION_COLUMNS, 'space_id'] : AUTOMATION_COLUMNS;
    const rows = await db.all(`SELECT ${selectColumns.join(', ')} FROM automations
      WHERE owner_user_id IN (${owners.map(() => '?').join(', ')})`, owners);
    const mapping = readMapping(mappingFile);
    const state = mapping.__syncState || {};
    const snapshots = state.snapshots || {};
    const retired = { ...(state.retired || {}) };
    const nextSnapshots = { ...snapshots };
    const { graph } = mappingGraph(mapping);
    const byNode = new Map(rows.map(row => [nodeKey(row.owner_user_id, row.id), row]));
    const hashes = new Map(rows.map(row => [nodeKey(row.owner_user_id, row.id), fingerprint(row, spaceIdentityOf(row, spaceIndex))]));
    const hashOf = row => hashes.get(nodeKey(row.owner_user_id, row.id));
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
      const groupHashes = new Set(groups[i].filter(isLive).map(hashOf));
      for (let j = i + 1; j < groups.length; j++) {
        if (!groups[j].length || groups[j].some(r => ownersInGroup.has(r.owner_user_id))) continue;
        if (!groups[j].some(r => isLive(r) && groupHashes.has(hashOf(r)))) continue;
        groups[j].forEach(r => { ownersInGroup.add(r.owner_user_id); if (isLive(r)) groupHashes.add(hashOf(r)); });
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
      const transferSql = withSpace
        ? 'UPDATE automations SET owner_user_id = ?, space_id = ? WHERE id = ? AND owner_user_id = ? AND updated_at IS ?'
        : 'UPDATE automations SET owner_user_id = ? WHERE id = ? AND owner_user_id = ? AND updated_at IS ?';
      for (const members of groups) {
        if (!members.length) continue;
        // 历史 mapping 把同账号多个不同定义的任务连在一起时，只报冲突不动数据。
        if (componentHasOwnerConflict(members, hashes)) {
          result.conflicts++;
          continue;
        }
        // 同 copy 模型：一次真实的定义修改压过「只是跑过一次」的更新时间。
        const changed = members.filter((row) => {
          const previous = snapshots[nodeKey(row.owner_user_id, row.id)];
          return previous && previous !== hashOf(row);
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
          nextSnapshots[nodeKey(targetUid, canonical.id)] = hashOf(canonical);
          continue;
        }
        const ownSpace = withSpace && canonical.space_id != null ? String(canonical.space_id).trim() : '';
        const nextSpace = ownSpace ? await resolveSpaceFor(ownSpace, targetUid, spaceIndex) : '';
        statements.push({
          sql: transferSql,
          params: withSpace
            ? [targetUid, nextSpace || null, canonical.id, canonical.owner_user_id, canonical.updated_at ?? null]
            : [targetUid, canonical.id, canonical.owner_user_id, canonical.updated_at ?? null],
          guard: true,
        });
        mapping[taskKey(canonical.owner_user_id, canonical.id, targetUid)] = {
          targetAutomationId: canonical.id,
          sourceUpdatedAt: canonical.updated_at == null ? null : String(canonical.updated_at),
        };
        nextSnapshots[nodeKey(targetUid, canonical.id)] = hashOf(canonical);
        result.moved++;
      }
    }
    if (mode === 'copy') for (const members of groups) {
      if (!members.length) continue;
      // A genuine definition edit beats an unchanged copy whose updated_at
      // merely advanced during execution. On first migration use latest edit.
      const changed = members.filter(row => {
        const previous = snapshots[nodeKey(row.owner_user_id, row.id)];
        return previous && previous !== hashOf(row);
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
        } else if (hashOf(row) !== hashOf(canonical)) {
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
        nextSnapshots[nodeKey(owner, row.id)] = hashOf(canonical);
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
        sql: 'UPDATE automations SET deleted_at = ? WHERE id = ? AND owner_user_id = ? AND updated_at IS ?',
        params: [Date.now(), row.id, row.owner_user_id, row.updated_at ?? null],
        guard: true,
      });
      result.removed++;
    }
    // Persist identities before SQL so a crash or failed mapping write cannot
    // leave an inserted task without a lineage. Only advance edit baselines
    // after the transaction commits. Retired rows are retried after failures.
    // pending 记录让「切号成功但同步失败」有一个可自动恢复的落点。
    mapping.__syncState = {
      snapshots,
      retired,
      pending: statements.length ? { sourceUid, targetUid, at: Date.now() } : null,
    };
    writeMapping(mappingFile, mapping);
    await runStatements(statements);
    mapping.__syncState = { snapshots: nextSnapshots, retired, pending: null };
    writeMapping(mappingFile, mapping);
    return result;
  }

  // Manual/automation switches can both reach this service; serialize them so
  // they cannot generate two IDs from the same pre-sync snapshot.
  let pending = Promise.resolve();
  const sync = function syncOfficialAutomations(sourceUid, targetUid) {
    const run = pending.then(() => reconcile(sourceUid, targetUid));
    pending = run.catch(() => {});
    return run;
  };

  // 上一次同步是否留下未完成的转移（切号成功但同步失败 / 进程中断）。
  sync.pendingSync = function pendingSync() {
    const state = readMapping(mappingFile).__syncState || {};
    const value = state.pending;
    if (!value || !cleanUid(value.sourceUid) || !cleanUid(value.targetUid)) return null;
    return { sourceUid: cleanUid(value.sourceUid), targetUid: cleanUid(value.targetUid), at: Number(value.at) || 0 };
  };

  sync.resume = async function resume() {
    const held = sync.pendingSync();
    if (!held) return { resumed: false };
    const result = await sync(held.sourceUid, held.targetUid);
    return { resumed: true, ...result };
  };

  return sync;
}

module.exports = { AUTOMATION_COLUMNS, cleanUid, createOfficialAutomationSync };
