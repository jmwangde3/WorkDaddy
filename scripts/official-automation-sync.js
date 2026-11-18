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

function normalizeSpaceName(value) {
  return String(value || '').trim().toLowerCase();
}

// Only explicit schema drift may be downgraded. Locked/I-O failures must abort
// the sync: treating them as "no such column" would silently drop space refs.
function isMissingSchema(error, needle) {
  const message = String((error && error.message) || '').toLowerCase();
  if (!/no such (column|table)/.test(message)) return false;
  return needle ? message.includes(String(needle).toLowerCase()) : false;
}

// 1.3.7 及更早版本写下的快照用的是纯定义哈希。升级不能让它整体失效，
// 否则「所有副本都像改过」，canonical 会退化成「谁 updated_at 最新谁赢」，
// 恰好破坏排除 updated_at 的初衷。保留旧算法只用于识别未修改的历史行。
function legacyFingerprint(row) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(DEFINITION_COLUMNS.map((column) => columnValue(row, column))))
    .digest('hex');
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
  const record = index.byId ? index.byId.get(id) : index.get(id);
  return record && record.name ? normalizeSpaceName(record.name) : '';
}

// 跨账号分组身份 = 规范化名称；同账号内重名时，路径用于消歧（与 resolveSpaceFor 同口径）。
// 两条任务的「分组身份是否相同」按这个约定判定，供吸附与迁移冲突共用。
function spaceSignature(row, index) {
  if (!index) return { name: '', paths: [] };
  const id = row && row.space_id != null ? String(row.space_id).trim() : '';
  if (!id) return { name: '', paths: [] };
  const record = index.byId ? index.byId.get(id) : index.get(id);
  if (!record || !record.name) return { name: '', paths: [] };
  return { name: normalizeSpaceName(record.name), paths: record.paths || [] };
}

// 名称不同必然不是同一个分组；名称相同但双方都写了目录且完全不重合，说明是两个
// 恰好同名的不同分组 —— 这时合并/转移会动到用户两条独立的任务，必须 fail-closed。
function spaceIdentityConflicts(left, right) {
  if (left.name !== right.name) return true;
  if (!left.name) return false;
  if (!left.paths.length || !right.paths.length) return false;
  return !left.paths.some(value => right.paths.includes(value));
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
    if (key === '__syncState') return;
    const parts = String(key).split(':');
    if (parts.length < 3 || !value || typeof value !== 'object') return;
    const sourceUid = parts.shift();
    const targetUid = parts.pop();
    const sourceId = parts.join(':');
    const targetId = String(value.targetAutomationId || '').trim();
    if (!cleanUid(sourceUid) || !cleanUid(targetUid) || !sourceId || !targetId) return;
    connect(nodeKey(sourceUid, sourceId), nodeKey(targetUid, targetId));
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

function insertStatement(source, targetUid, id, columns) {
  const values = columns.map((column) => {
    if (column === 'id') return id;
    if (column === 'owner_user_id') return targetUid;
    const value = column === 'space_id' ? source.__spaceTarget : source[column];
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
  async function detectSpaceColumn(read) {
    if (spaceColumn !== null) return spaceColumn;
    try {
      await read('SELECT space_id FROM automations LIMIT 1');
      spaceColumn = true;
    } catch (error) {
      if (!isMissingSchema(error, 'space_id')) throw error;
      spaceColumn = false;
    }
    return spaceColumn;
  }

  // 分组表一次性读成内存索引：事务里不再反复 SELECT spaces，缩短 BEGIN IMMEDIATE
  // 的持锁时间。索引同时保留 id→记录 与 owner→候选行 两份视图。
  async function loadSpaceIndex(read) {
    let rows;
    try {
      rows = await read('SELECT id, name, primary_folder_path, create_folder_path, user_id FROM spaces WHERE COALESCE(deleted_at, -1) = -1 ORDER BY id ASC');
    } catch (error) {
      if (isMissingSchema(error, 'spaces')) return null;
      throw error;
    }
    const byId = new Map();
    const byOwner = new Map();
    for (const row of rows || []) {
      const record = {
        id: String(row.id).trim(),
        name: String(row.name || '').trim(),
        paths: [row.primary_folder_path, row.create_folder_path].map(normalizeSpacePath).filter(Boolean),
      };
      byId.set(record.id, record);
      const owner = String(row.user_id || '').trim();
      if (!owner) continue;
      const list = byOwner.get(owner) || [];
      list.push(record);
      byOwner.set(owner, list);
    }
    return { byId, byOwner };
  }

  // 任务转移账号后，分组引用必须改成目标账号自己的同名分组，否则客户端会引用
  // 别的账号的分组行。找不到同名分组就置空，宁可不分组也不跨账号悬空。
  // 纯内存查询：候选行来自一次性预取的 byOwner 索引。
  function resolveSpaceFor(spaceId, targetUid, spaceIndex) {
    if (!spaceId || !spaceIndex) return '';
    const record = spaceIndex.byId.get(String(spaceId).trim());
    const name = record && record.name ? record.name : '';
    if (!name) return '';
    // 名称比较与 fingerprint 口径一致（都走 normalizeSpaceName），避免一边忽略大小写
    // 一边精确匹配，出现「认为是同一个分组却找不到」的自相矛盾。
    const wantedName = normalizeSpaceName(name);
    const candidates = (spaceIndex.byOwner.get(String(targetUid)) || [])
      .filter((row) => normalizeSpaceName(row.name) === wantedName);
    if (!candidates.length) return '';
    if (candidates.length === 1) return candidates[0].id;
    // 目标账号存在多个同名分组：只有路径能唯一对上时才绑定，否则宁可不分组。
    const wantedPaths = new Set(record.paths || []);
    if (!wantedPaths.size) return '';
    const matched = candidates.filter((row) => row.paths.some((value) => wantedPaths.has(value)));
    return matched.length === 1 ? matched[0].id : '';
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

  // 1.3.7 的旧快照不含分组，升级时「旧定义哈希命中」只能证明定义字段没变，
  // 不能证明分组身份一致。若历史 mapping 已经把「定义相同、分组不同」的两个
  // 跨账号任务连在一起，v1 兼容会把它们全部判成未修改，move 就会误并、
  // 甚至软删掉其中一条。这种情形必须报冲突并原样保留，交给人工消歧。
  function componentHasCrossOwnerGroupDrift(members, legacyOf, signatures) {
    const live = members.filter(isLive);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const left = live[i];
        const right = live[j];
        if (left.owner_user_id === right.owner_user_id) continue;
        const leftId = nodeKey(left.owner_user_id, left.id);
        const rightId = nodeKey(right.owner_user_id, right.id);
        // 定义本来就不同：不是「同一定义被拆到两个分组」，交给正常判定。
        if (legacyOf.get(leftId) !== legacyOf.get(rightId)) continue;
        if (spaceIdentityConflicts(signatures.get(leftId), signatures.get(rightId))) return true;
      }
    }
    return false;
  }

  // 纯规划：所有数据库读取都通过 read（事务内是 tx.all），不写库、不写文件。
  async function planSync(read, context) {
    const { sourceUid, targetUid, mode, mapping } = context;
    const withSpace = await detectSpaceColumn(read);
    // 分组索引与账号列表由 reconcile 在事务外预取：这两项不在同步语义的
    // 一致性边界内，放进写事务只会无谓地拉长 BEGIN IMMEDIATE 的持锁时间。
    const spaceIndex = withSpace ? (context.spaceIndex || null) : null;
    // 有 space_id 列却读不到分组表：无法判断目标账号的分组，继续执行会把
    // space_id 写成空值，等于悄悄清掉用户的分组归属。宁可整次失败。
    if (withSpace && !spaceIndex) {
      throw new Error('无法读取分组表，已放弃定时任务同步以避免清空分组引用');
    }
    const savedUids = Array.isArray(context.savedUids) ? context.savedUids : [];
    const owners = [...new Set([sourceUid, targetUid, ...savedUids.map(cleanUid)].filter(Boolean))];
    const selectColumns = withSpace ? [...AUTOMATION_COLUMNS, 'space_id'] : AUTOMATION_COLUMNS;
    const rows = await read(`SELECT ${selectColumns.join(', ')} FROM automations
      WHERE owner_user_id IN (${owners.map(() => '?').join(', ')})`, owners);

    const state = (mapping && mapping.__syncState) || {};
    const snapshots = state.snapshots || {};
    const retired = { ...(state.retired || {}) };
    const nextSnapshots = { ...snapshots };
    const nextRetired = { ...retired };
    const lineage = {};
    const { graph } = mappingGraph(mapping);
    const byNode = new Map(rows.map(row => [nodeKey(row.owner_user_id, row.id), row]));
    const identities = new Map(rows.map(row => [nodeKey(row.owner_user_id, row.id), spaceIdentityOf(row, spaceIndex)]));
    const signatures = new Map(rows.map(row => [nodeKey(row.owner_user_id, row.id), spaceSignature(row, spaceIndex)]));
    const hashOf = new Map(rows.map(row => [nodeKey(row.owner_user_id, row.id), fingerprint(row, identities.get(nodeKey(row.owner_user_id, row.id)))]));
    const legacyOf = new Map(rows.map(row => [nodeKey(row.owner_user_id, row.id), legacyFingerprint(row)]));
    // 旧快照既可能是 v1（纯定义），也可能是 v2；两者都算「未修改」，
    // 让升级本身不被当成一次全量编辑，快照会在成功后统一改写为 v2。
    const unchanged = (row) => {
      const key = nodeKey(row.owner_user_id, row.id);
      const previous = snapshots[key];
      if (!previous) return false;
      return previous === hashOf.get(key) || previous === legacyOf.get(key);
    };

    const visited = new Set();
    const groups = [];
    for (const [node] of byNode) {
      if (visited.has(node) || retired[node]) continue;
      const nodes = componentNodes(graph, node);
      nodes.forEach(n => visited.add(n));
      const members = [...nodes].filter(n => byNode.has(n) && !retired[n]).map(n => byNode.get(n));
      if (members.length) groups.push(members);
    }

    // 两条 live 行是否只是「恰好同名」：定义相同但分组身份冲突。
    const spaceSplit = (candidate, group) => group.some(other => {
      if (!isLive(other)) return false;
      const left = nodeKey(other.owner_user_id, other.id);
      const right = nodeKey(candidate.owner_user_id, candidate.id);
      if (legacyOf.get(left) !== legacyOf.get(right)) return false;
      return spaceIdentityConflicts(signatures.get(left), signatures.get(right));
    });

    // Adopt identical pre-existing copies one-to-one across different owners.
    // Never collapse intentionally separate tasks in the same account, nor
    // once tasks whose scheduled dates differ. 分组身份已进入 fingerprint，
    // 因此不同分组的同名任务不会在这里被吸附。
    for (let i = 0; i < groups.length; i++) {
      const ownersInGroup = new Set(groups[i].map(r => r.owner_user_id));
      const groupHashes = new Set(groups[i].filter(isLive).map(r => hashOf.get(nodeKey(r.owner_user_id, r.id))));
      for (let j = i + 1; j < groups.length; j++) {
        if (!groups[j].length || groups[j].some(r => ownersInGroup.has(r.owner_user_id))) continue;
        // 同名不同路径的两个分组属于不同任务：不吸附，也不在后续 move 里合并。
        if (groups[j].some(r => isLive(r) && groupHashes.has(hashOf.get(nodeKey(r.owner_user_id, r.id))) && spaceSplit(r, groups[i]))) continue;
        if (!groups[j].some(r => isLive(r) && groupHashes.has(hashOf.get(nodeKey(r.owner_user_id, r.id))))) continue;
        groups[j].forEach(r => {
          ownersInGroup.add(r.owner_user_id);
          if (isLive(r)) groupHashes.add(hashOf.get(nodeKey(r.owner_user_id, r.id)));
        });
        groups[i].push(...groups[j]);
        groups[j] = [];
      }
    }

    const stats = { copied: 0, updated: 0, moved: 0, removed: 0, skipped: 0, total: 0, conflicts: 0 };
    const statements = [];
    // 即将写入的分组引用：id -> 期望的归属账号。分组索引是事务外预取的，
    // 提交前必须确认这些分组仍然存活且确实属于该账号，否则会写出悬空引用。
    const spaceWrites = new Map();
    const usedIds = new Set(rows.map(r => r.id));
    const freshnessOrder = (a, b) => taskFreshness(b) - taskFreshness(a) ||
      Number(b.owner_user_id === sourceUid) - Number(a.owner_user_id === sourceUid) ||
      nodeKey(a.owner_user_id, a.id).localeCompare(nodeKey(b.owner_user_id, b.id));
    let inserts = 0;

    if (mode === 'move') {
      const transferSql = withSpace
        ? 'UPDATE automations SET owner_user_id = ?, space_id = ? WHERE id = ? AND owner_user_id = ? AND updated_at IS ?'
        : 'UPDATE automations SET owner_user_id = ? WHERE id = ? AND owner_user_id = ? AND updated_at IS ?';
      for (const members of groups) {
        if (!members.length) continue;
        if (componentHasOwnerConflict(members, hashOf)) {
          stats.conflicts++;
          continue;
        }
        // 旧 mapping 已把「定义相同、分组不同」的跨账号任务连在一起：v1 兼容
        // 会把它们都判成未修改，继续执行就会误并/误删。原样保留并报冲突。
        if (componentHasCrossOwnerGroupDrift(members, legacyOf, signatures)) {
          stats.conflicts++;
          continue;
        }
        // 同 copy 模型：一次真实的定义修改压过「只是跑过一次」的更新时间。
        const changed = members.filter((row) => snapshots[nodeKey(row.owner_user_id, row.id)] && !unchanged(row));
        const canonical = [...(changed.length ? changed : members)].sort(freshnessOrder)[0];
        // 规范行已删除：删除同步到所有副本，反向切号也不复活。
        if (!isLive(canonical)) {
          for (const row of members) if (isLive(row)) nextRetired[nodeKey(row.owner_user_id, row.id)] = true;
          continue;
        }
        stats.total++;
        // 其余副本一律停用（软删除，可恢复）：同一任务全局只留一行。
        for (const row of members) {
          if (row.id === canonical.id || !isLive(row)) continue;
          nextRetired[nodeKey(row.owner_user_id, row.id)] = true;
        }
        const canonicalKey = nodeKey(canonical.owner_user_id, canonical.id);
        if (canonical.owner_user_id === targetUid) {
          stats.skipped++;
          nextSnapshots[canonicalKey] = hashOf.get(canonicalKey);
          continue;
        }
        const ownSpace = withSpace && canonical.space_id != null ? String(canonical.space_id).trim() : '';
        const nextSpace = ownSpace ? resolveSpaceFor(ownSpace, targetUid, spaceIndex) : '';
        if (nextSpace) spaceWrites.set(nextSpace, targetUid);
        statements.push({
          sql: transferSql,
          params: withSpace
            ? [targetUid, nextSpace || null, canonical.id, canonical.owner_user_id, canonical.updated_at ?? null]
            : [targetUid, canonical.id, canonical.owner_user_id, canonical.updated_at ?? null],
          guard: true,
        });
        lineage[taskKey(canonical.owner_user_id, canonical.id, targetUid)] = {
          targetAutomationId: canonical.id,
          sourceUpdatedAt: canonical.updated_at == null ? null : String(canonical.updated_at),
        };
        nextSnapshots[nodeKey(targetUid, canonical.id)] = hashOf.get(canonicalKey);
        stats.moved++;
      }
    }

    if (mode === 'copy') for (const members of groups) {
      if (!members.length) continue;
      // A genuine definition edit beats an unchanged copy whose updated_at
      // merely advanced during execution. On first migration use latest edit.
      const changed = members.filter(row => snapshots[nodeKey(row.owner_user_id, row.id)] && !unchanged(row));
      const canonical = [...(changed.length ? changed : members)].sort(freshnessOrder)[0];
      const live = isLive(canonical);
      if (live) stats.total++;
      const canonicalHash = hashOf.get(nodeKey(canonical.owner_user_id, canonical.id));
      const insertColumns = withSpace ? [...AUTOMATION_COLUMNS, 'space_id'] : AUTOMATION_COLUMNS;
      const survivors = [];
      for (const owner of owners) {
        const candidates = members.filter(row => row.owner_user_id === owner).sort(freshnessOrder);
        let row = candidates[0];
        if (!row && !live) continue; // Do not manufacture deleted history.
        // copy 模式的副本是另一账号里的独立行，分组必须换成该账号自己的同名分组。
        const ownerSpace = withSpace && canonical.space_id != null && String(canonical.space_id).trim()
          ? resolveSpaceFor(String(canonical.space_id).trim(), owner, spaceIndex)
          : null;
        // fingerprint 用的是规范化分组名，不是分组 id：B 账号的副本若引用了 A 账号
        // 的同名分组，两边哈希相等，只比哈希会跳过 UPDATE，让跨账号悬空引用留下来。
        const spaceChanged = withSpace && ownerSpace !== null
          && String(row ? (row.space_id || '') : '') !== String(ownerSpace || '');
        if (ownerSpace) spaceWrites.set(ownerSpace, owner);
        if (!row) {
          const id = String(idFactory());
          if (!/^[0-9a-f-]{8,128}$/i.test(id) || usedIds.has(id)) throw new Error('官方定时任务 ID 无效');
          usedIds.add(id);
          statements.push(insertStatement({ ...canonical, __spaceTarget: ownerSpace || null }, owner, id, insertColumns));
          row = { ...canonical, id, owner_user_id: owner };
          stats.copied++;
          inserts++;
        } else if (hashOf.get(nodeKey(row.owner_user_id, row.id)) !== canonicalHash || spaceChanged) {
          const columns = [...DEFINITION_COLUMNS, 'updated_at'];
          // Renames do not overwrite the target's run history. A changed
          // schedule does need its new next occurrence, as in the official edit.
          if (SCHEDULE_COLUMNS.some(c => columnValue(row, c) !== columnValue(canonical, c))) columns.push('next_run_at');
          const params = columns.map(c => columnValue(canonical, c));
          if (withSpace) { columns.push('space_id'); params.push(ownerSpace || null); }
          statements.push({
            sql: `UPDATE automations SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND owner_user_id = ?`,
            params: [...params, row.id, owner],
          });
          stats.updated++;
        } else if (live) stats.skipped++;
        survivors.push(row);
        nextSnapshots[nodeKey(owner, row.id)] = canonicalHash;
        for (const duplicate of candidates.slice(1)) {
          nextRetired[nodeKey(owner, duplicate.id)] = true;
        }
      }
      // Keep historical edges, including missing old IDs, so old A→B→H
      // mappings still identify reverse copies after upgrading or restarting.
      for (const row of survivors) {
        if (row.id === canonical.id) continue;
        lineage[taskKey(canonical.owner_user_id, canonical.id, row.owner_user_id)] = {
          targetAutomationId: row.id,
          sourceUpdatedAt: canonical.updated_at == null ? null : String(canonical.updated_at),
        };
      }
    }

    for (const row of rows) {
      if (!nextRetired[nodeKey(row.owner_user_id, row.id)] || !isLive(row)) continue;
      statements.push({
        sql: 'UPDATE automations SET deleted_at = ? WHERE id = ? AND owner_user_id = ? AND updated_at IS ?',
        params: [Date.now(), row.id, row.owner_user_id, row.updated_at ?? null],
        guard: true,
      });
      stats.removed++;
    }

    // 分组索引是事务外预取的，提交前在这里复核一次：预取之后分组若被删除、
    // 软删或改属，写进去就是跨账号悬空引用。发现变化整笔回滚，下一轮重新取。
    if (withSpace && spaceWrites.size) {
      const ids = [...spaceWrites.keys()];
      const found = await read(
        `SELECT id, user_id FROM spaces WHERE id IN (${ids.map(() => '?').join(', ')}) AND COALESCE(deleted_at, -1) = -1`,
        ids
      );
      const alive = new Map(found.map(row => [String(row.id), String(row.user_id || '')]));
      for (const [id, owner] of spaceWrites) {
        if (alive.get(id) !== String(owner)) {
          throw new Error('分组在同步期间被删除或改属，本次同步已回滚');
        }
      }
    }

    return { stats, statements, lineage, snapshots: nextSnapshots, retired: nextRetired, inserts, mode };
  }

  // 待恢复意图上限。队列按 FIFO 处理，满载时拒绝新增而不是静默丢弃最旧记录：
  // 静默丢弃会让「切号已经完成、任务却没跟过来」变成无人知晓的状态。
  const PENDING_LIMIT = 32;

  function readPendingList() {
    const state = readMapping(mappingFile).__syncState || {};
    return Array.isArray(state.pending) ? state.pending : [];
  }

  function normalizePending(item) {
    if (!item) return null;
    const sourceUid = cleanUid(item.sourceUid);
    const targetUid = cleanUid(item.targetUid);
    if (!sourceUid || !targetUid || sourceUid === targetUid) return null;
    return {
      sourceUid,
      targetUid,
      mode: SYNC_MODES.has(item.mode) ? item.mode : 'move',
      at: Number(item.at) || 0,
    };
  }

  // 事务外预取：账号列表与分组索引不在「读取与写入同一快照」的一致性边界内，
  // 放进 BEGIN IMMEDIATE 只会延长持锁时间（第三轮复审 P2-3）。每次同步只取一次。
  function makePrefetchCache() {
    let promise = null;
    return function getPrefetch() {
      if (!promise) {
        promise = (async () => {
          const savedUids = options.getAccountUids ? await options.getAccountUids() : [];
          // 分组表读不到就不能安全重映射：继续执行会把 space_id 写成空，
          // 等价于悄悄清掉用户的分组归属。这里 fail-closed。
          const spaceIndex = await loadSpaceIndex((sql, params) => db.all(sql, params));
          return { savedUids, spaceIndex };
        })();
      }
      return promise;
    };
  }

  // 把一条「待恢复意图」写进队列。重试时必须沿用原始 at：否则每次失败都会把
  // 该条推到队尾，FIFO 顺序被反复打乱，早晚出现「新意图先跑、旧意图后跑」。
  function writePendingIntent(sourceUid, targetUid, mode, options = {}) {
    const mapping = readMapping(mappingFile);
    const state = mapping.__syncState || {};
    const normalized = (Array.isArray(state.pending) ? state.pending : []).map(normalizePending).filter(Boolean);
    const existing = normalized.find(item => item.sourceUid === sourceUid && item.targetUid === targetUid);
    const rest = normalized.filter(item => !(item.sourceUid === sourceUid && item.targetUid === targetUid));
    if (rest.length >= PENDING_LIMIT) {
      throw new Error(`定时任务待恢复队列已满（${PENDING_LIMIT} 条），请先完成现有恢复`);
    }
    const at = options.keepAt && existing ? existing.at : Date.now();
    rest.push({ sourceUid, targetUid, mode, at });
    rest.sort((a, b) => a.at - b.at);
    mapping.__syncState = { ...state, pending: rest };
    writeMapping(mappingFile, mapping);
    return rest;
  }

  async function reconcile(sourceValue, targetValue, modeValue, getPrefetch, intent) {
    const sourceUid = cleanUid(sourceValue);
    const targetUid = cleanUid(targetValue);
    const mode = SYNC_MODES.has(modeValue) ? modeValue : resolveMode();
    const result = { mode, copied: 0, updated: 0, moved: 0, removed: 0, skipped: 0, total: 0, conflicts: 0 };
    if (!sourceUid || !targetUid || sourceUid === targetUid) return result;

    // 能力检查必须在写 pending 之前：否则不支持事务的后端会留下一条永远没人能
    // 处理的欠账，恢复流程每次都会失败重试，永远清不掉。
    const supportsTx = typeof db.writeTransaction === 'function';
    if (!supportsTx) {
      throw new Error('当前数据库后端不支持事务内读取，已拒绝定时任务同步');
    }

    // 阶段 A：先落盘恢复意图，再做任何数据库读取。这样「读取阶段就失败」
    // 也留下记录，restart 后能续做，不会把问题永久留给用户。
    // 重试沿用原始 at（见 writePendingIntent），FIFO 顺序才稳定。
    writePendingIntent(sourceUid, targetUid, mode, { keepAt: !!(intent && intent.keepAt) });
    const mapping = readMapping(mappingFile);
    const state = mapping.__syncState || {};
    const pending = Array.isArray(state.pending) ? state.pending : [];

    // 预取发生在 pending 落盘之后：读取阶段即使被锁，也不丢恢复记录。
    const prefetched = typeof getPrefetch === 'function'
      ? await getPrefetch()
      : { savedUids: [], spaceIndex: null };

    // 阶段 B：读取 + 判定 + 写入。node:sqlite 下三者同处一个 BEGIN IMMEDIATE，
    // 规划所依赖的数据在提交前不会被外部改动。
    const plan = await db.writeTransaction(async (tx) => {
      const read = (sql, params) => tx.all(sql, params);
      const built = await planSync(read, {
        sourceUid,
        targetUid,
        mode,
        mapping,
        savedUids: prefetched.savedUids,
        spaceIndex: prefetched.spaceIndex,
      });
      // copy 模式会插入新行：先把 lineage 落盘，崩溃后也不会出现没有身份的新副本。
      if (built.inserts > 0) {
        writeMapping(mappingFile, { ...mapping, ...built.lineage, __syncState: { ...state, pending } });
      }
      for (const statement of built.statements) {
        const outcome = tx.run(statement.sql, statement.params);
        if (statement.guard && Number(outcome && outcome.changes) === 0) {
          throw new Error('定时任务在同步期间被修改，本次同步已回滚');
        }
      }
      return built;
    });

    // 阶段 C：SQLite 提交成功后才写回 snapshots / retired / lineage。
    // 回滚时这些状态完全没动过，所以下一轮会重新读取、重新判定，
    // 不会拿上一轮的 retired 标记去删用户刚改过的内容。
    const latest = readMapping(mappingFile);
    Object.assign(latest, plan.lineage);
    const latestState = latest.__syncState || {};
    latest.__syncState = {
      ...latestState,
      snapshots: plan.snapshots,
      retired: plan.retired,
      pending: (Array.isArray(latestState.pending) ? latestState.pending : [])
        .filter(item => !(item && item.sourceUid === sourceUid && item.targetUid === targetUid)),
    };
    writeMapping(mappingFile, latest);
    Object.assign(result, plan.stats);
    return result;
  }

  // 队列里的旧意图必须早于本次调用完成：否则「新 move 已成功、旧 copy 又反向
  // 执行」会把刚收敛的副本重新造出来（第三轮复审 P1）。drain 在串行链内部
  // 直接调 reconcile，不经过 sync()，避免重入自己造成死锁。
  // 返回 { done, pending }：pending 是处理完后仍然排在该目标账号队列里的条数，
  // 调用方必须据此判断「是否真的清空了」，不能只看 done。
  async function drainPending(targetUid, skip, getPrefetch) {
    const isSkipped = item => !!(skip && item.sourceUid === skip.sourceUid && item.targetUid === skip.targetUid);
    const queue = readPendingList()
      .map(normalizePending)
      .filter(Boolean)
      .filter(item => item.targetUid === targetUid)
      .filter(item => !isSkipped(item))
      .sort((a, b) => a.at - b.at);
    let done = 0;
    for (const item of queue) {
      try {
        await reconcile(item.sourceUid, item.targetUid, item.mode, getPrefetch, { keepAt: true });
        done++;
      } catch (error) {
        // 旧意图失败不阻断「队列里其它旧意图」的重试机会，但调用方不能在此基础上
        // 继续执行新同步：那正是「新操作成功、旧操作随后反悔」的入口。
        if (typeof options.log === 'function') {
          options.log(`[automation-sync] 待恢复意图 ${item.sourceUid}->${item.targetUid} (${item.mode}) 失败: ${error.message}`);
        }
        break;
      }
    }
    const pending = readPendingList()
      .map(normalizePending)
      .filter(Boolean)
      .filter(item => item.targetUid === targetUid)
      .filter(item => !isSkipped(item))
      .length;
    return { done, pending };
  }

  // Manual/automation switches can both reach this service; serialize them so
  // they cannot generate two IDs from the same pre-sync snapshot.
  let tail = Promise.resolve();
  const sync = function syncOfficialAutomations(sourceUid, targetUid, mode) {
    const run = tail.then(async () => {
      const source = cleanUid(sourceUid);
      const target = cleanUid(targetUid);
      const resolved = SYNC_MODES.has(mode) ? mode : resolveMode();
      if (!source || !target || source === target) {
        return { mode: resolved, copied: 0, updated: 0, moved: 0, removed: 0, skipped: 0, total: 0, conflicts: 0 };
      }
      const getPrefetch = makePrefetchCache();
      // 先清该目标的旧意图（各自按记录里的原始 mode），再执行本次调用：
      // 最终状态由最新的用户意图决定，旧语义不会在新结果上反悔。
      const drained = await drainPending(target, { sourceUid: source, targetUid: target }, getPrefetch);
      if (drained.pending > 0) {
        // 旧账没还完：把本次意图排到队尾（保留 mode），交给恢复流程按顺序处理。
        // 此时若继续执行，旧 copy 可能在新 move 成功后又跑一遍，把刚收敛的副本
        // 重新造出来 —— 正是本轮要消除的路径。
        writePendingIntent(source, target, resolved);
        return {
          mode: resolved,
          copied: 0, updated: 0, moved: 0, removed: 0, skipped: 0, total: 0, conflicts: 0,
          drained: drained.done,
          deferred: true,
          pending: sync.pendingList(target).length,
        };
      }
      const result = await reconcile(source, target, resolved, getPrefetch);
      if (drained.done) result.drained = drained.done;
      return result;
    });
    tail = run.catch(() => {});
    return run;
  };

  // 未完成的转移意图（切号成功但同步失败 / 进程中断）。无参数时返回队首
  // （最早的一条），保证调用方的处理顺序与写入顺序一致。
  sync.pendingSync = function pendingSync(targetUid) {
    const wanted = cleanUid(targetUid);
    const queue = readPendingList().map(normalizePending).filter(Boolean).sort((a, b) => a.at - b.at);
    const match = wanted ? queue.find(item => item.targetUid === wanted) : queue[0];
    return match || null;
  };

  sync.pendingList = function pendingList(targetUid) {
    const wanted = cleanUid(targetUid);
    return readPendingList()
      .map(normalizePending)
      .filter(Boolean)
      .filter(item => !wanted || item.targetUid === wanted)
      .sort((a, b) => a.at - b.at);
  };

  // 按记录里的原始 mode 恢复。一次把该目标账号的待恢复意图全部做完（FIFO）：
  // 只处理一条会留下「恢复了一半」的中间状态，后续判定也会基于半成品。
  sync.resume = async function resume(targetUid) {
    const wanted = cleanUid(targetUid);
    if (!wanted) return { resumed: false, drained: 0, pending: 0 };
    if (!sync.pendingList(wanted).length) return { resumed: false, drained: 0, pending: 0 };
    const run = tail.then(async () => {
      const getPrefetch = makePrefetchCache();
      const drained = await drainPending(wanted, null, getPrefetch);
      return { resumed: drained.done > 0, drained: drained.done, pending: drained.pending };
    });
    tail = run.catch(() => {});
    return run;
  };

  return sync;
}

module.exports = { AUTOMATION_COLUMNS, cleanUid, createOfficialAutomationSync, fingerprint, legacyFingerprint };
