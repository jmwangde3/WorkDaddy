'use strict';
/**
 * session-dedupe.js — 会话副本判定的安全内核（P0）。
 *
 * 设计原则：**证明不了是副本，就保留。**
 *
 * 判定分四层，任何一层给不出确定结论都返回 unknown，调用方必须跳过该组：
 *
 *   1. 文件层  —— 文件存在、可读、非空、扫描期间大小/mtime/内容哈希未变。
 *   2. 字节层  —— 整文件 SHA-256 相同 = 逐字节相同的副本（最强证据）。
 *   3. 消息层  —— 解析 JSONL，按消息 id（WorkBuddy 写的是 `id` 字段）建 UUID → 规范化内容哈希。
 *                规范化 = **只去掉记录顶层**的 `sessionId` 并按字典序排序键（旧「自动同步」
 *                复制会话时会把每行顶层的 sessionId 改写成新会话 ID，消息 id 与内容不变）。
 *                嵌套层的 `sessionId` 是内容，原样参与哈希 —— 删掉它会掩盖真实差异。
 *                只有 id 集合完全相等且同 id 内容全等，才算内容相同。
 *   4. 包含层  —— 仅显式开启（mode='containment'）时使用：A 的全部消息（含无 id 记录的多重集）
 *                都在 B 里，且同 id 内容无冲突、被包含者不早于容器创建，才认定 A 是 B 的旧副本；
 *                保留内容更完整的 B，绝不按 updated_at 反选。内容冲突、互相不包含、
 *                候选保留者不唯一，一律跳过。
 *
 * 额外的「不猜」判据：
 *   - 文件里有重复消息 UUID            → 整组保留
 *   - 有坏行 / 空文件 / 扫描中变化      → 整组保留
 *   - 存在附属产物（`<id>/`、`<id>.png` 等）→ 整组保留
 *   - 附件引用是相对路径（`images/a.png`）→ 只认逐字节相同，消息层不作证
 *
 * 任何情况下都不物理删除 JSONL 文件；只写 sessions.deleted_at，并写操作日志供回滚。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODE_EXACT = 'exact';
const MODE_CONTAINMENT = 'containment';
const NOT_DELETED = '(deleted_at IS NULL OR deleted_at = -1)';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * 递归规范化为与「会话归属」无关的稳定序列化。
 *
 * **只去掉记录顶层的 `sessionId`。** 旧版自动同步复制会话时改写的是每行顶层的
 * `sessionId`（消息 id 与正文不变）。嵌套层里同名字段是**内容**：工具调用参数、
 * 工具结果、附件描述里都可能携带 `sessionId`，把它一起删掉会让两份真实内容不同
 * 的文件算出同一个哈希 —— 那正是「规范化掩盖真实差异」的误删来源。
 */
function canonicalize(value, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (depth === 0 && key === 'sessionId') continue;
      out[key] = canonicalize(value[key], depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 附件 / 图片等**外部引用**统计。
 *
 * JSONL 里只存引用，二进制不在文件内。如果引用是相对路径（`images/a.png`），
 * 两个会话各自目录下同名文件可能是**不同内容**；此时逐字节相同不代表语义相同，
 * 消息层相等也不代表语义相同 —— 调用方必须退化为「只认字节完全相同」，或者跳过。
 */
const ARTIFACT_KEYS = new Set([
  'attachment', 'attachments', 'image', 'images', 'file', 'files',
  'artifact', 'artifacts', 'media', 'resources', 'uploads',
]);

function isAbsoluteRef(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) ||          // C:\ / C:/
    value.startsWith('\\\\') ||                    // UNC
    value.startsWith('/') ||                       // POSIX
    value.startsWith('~') ||                       // home
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||      // scheme://
    /^data:/i.test(value);                         // inline
}

function scanArtifactRefs(record) {
  const out = { total: 0, relative: 0, samples: [] };
  const walk = (node, inside) => {
    if (typeof node === 'string') {
      if (!inside) return;
      out.total += 1;
      if (!isAbsoluteRef(node)) {
        out.relative += 1;
        if (out.samples.length < 3) out.samples.push(node.slice(0, 120));
      }
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item, inside); return; }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], inside || ARTIFACT_KEYS.has(key));
    }
  };
  walk(record, false);
  return out;
}

/**
 * 会话文件旁边的附属产物（例如 `<id>/`、`<id>.files/`、`<id>.png`）。
 * 这些是磁盘上的真实数据；去重只改 `deleted_at` 不删文件，但一旦判错，
 * 用户看到的是「会话没了、文件还在」。所以**有附属产物就整组保留**。
 */
function inspectSidecars(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, '.jsonl');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) {
    return { present: false, names: [], error: 'sidecar-scan-failed' };
  }
  const names = entries
    .filter((e) => e.name !== path.basename(file))
    .filter((e) => e.name === base || e.name.startsWith(`${base}.`) || e.name.startsWith(`${base}-`))
    .map((e) => e.name);
  return { present: names.length > 0, names: names.slice(0, 8) };
}

function statSafe(file) {
  try {
    const st = fs.statSync(file);
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 扫描一份消息文件，产出可比较的指纹。
 * `sessionId` 只用于字节兜底归一，不参与消息层比较。
 */
function inspectSessionFile(file, options = {}) {
  const info = {
    ok: false,
    file: String(file || ''),
    exists: false,
    readable: false,
    size: 0,
    mtimeMs: 0,
    rawSha: null,
    parsed: false,
    messageCount: 0,
    messages: new Map(),      // id -> 规范化内容哈希
    order: [],                // 带 id 记录在文件里的出现顺序（含重复项）
    unkeyed: new Map(),       // 无 id 记录：内容哈希 -> 出现次数
    duplicateIds: [],
    artifactRefs: 0,          // 附件/图片等外部引用总数
    relativeArtifactRefs: 0,  // 其中相对路径的数量（>0 时禁止消息层判定）
    sidecars: { present: false, names: [] },
    error: null,
    stable: false,
  };
  if (!info.file) { info.error = 'missing-file-path'; return info; }
  const before = statSafe(info.file);
  if (!before.ok) { info.error = before.error; return info; }
  info.exists = true;
  info.size = before.size;
  info.mtimeMs = before.mtimeMs;
  if (!before.size) { info.error = 'empty-file'; return info; }

  let raw;
  try {
    raw = fs.readFileSync(info.file);
    info.readable = true;
  } catch (error) {
    info.error = error.message;
    return info;
  }
  info.rawSha = crypto.createHash('sha256').update(raw).digest('hex');

  const text = raw.toString('utf8');
  const lines = text.split(/\r?\n/);
  let parsedAll = true;
  let sawContent = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      parsedAll = false;
      break;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { parsedAll = false; break; }
    sawContent = true;
    const hash = sha256(JSON.stringify(canonicalize(obj)));
    const id = typeof obj.id === 'string' && obj.id ? obj.id : null;
    if (id) {
      info.order.push(id);
      if (info.messages.has(id)) {
        // 同一文件里重复的消息 id：无法安全判定覆盖关系，退化为不可解析。
        if (!info.duplicateIds.includes(id)) info.duplicateIds.push(id);
      } else {
        info.messages.set(id, hash);
      }
    } else {
      info.unkeyed.set(hash, (info.unkeyed.get(hash) || 0) + 1);
    }
    const refs = scanArtifactRefs(obj);
    info.artifactRefs += refs.total;
    info.relativeArtifactRefs += refs.relative;
  }
  info.parsed = parsedAll && sawContent && info.duplicateIds.length === 0;
  info.messageCount = info.messages.size;
  info.sidecars = inspectSidecars(info.file);

  const after = statSafe(info.file);
  info.stable = after.ok && after.size === before.size && after.mtimeMs === before.mtimeMs;
  if (!info.stable) info.error = 'file-changed-during-scan';
  else if (!parsedAll) info.error = 'malformed-jsonl';
  else if (!sawContent) info.error = 'no-records';
  else if (info.duplicateIds.length) info.error = 'duplicate-message-ids';
  // ok 表示「这份指纹可以拿来做内容层比对」，因此要求 parsed。
  // 逐字节相同的判定不走 ok（见 compareFingerprints），不受这里影响。
  info.ok = info.readable && info.stable && info.parsed && !info.error;
  return info;
}

/** 消息表是 id -> 内容哈希：子集要求键存在且哈希相等。 */
function messagesSubset(a, b) {
  for (const [id, hash] of a) {
    if (!b.has(id) || b.get(id) !== hash) return false;
  }
  return true;
}

function messagesEqual(a, b) {
  return a.size === b.size && messagesSubset(a, b);
}

/** 多重集 A 是否为 B 的子集（含计数），用于无 id 记录。 */
function multisetSubset(a, b) {
  for (const [key, count] of a) {
    if ((b.get(key) || 0) < count) return false;
  }
  return true;
}

/** a 是否为 b 的子序列（保持相对顺序）。用于包含关系的顺序证据。 */
function isSubsequence(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (b[j] === a[i]) i += 1;
  }
  return i === a.length;
}

function multisetEqual(a, b) {
  if (a.size !== b.size) return false;
  return multisetSubset(a, b);
}

/**
 * 比较两份指纹。
 * 返回 { relation, reason }：
 *   'equal'      确定相同副本
 *   'a-contains' A 是 B 的超集（B 是旧副本）
 *   'a-contained' A 被 B 包含（A 是旧副本）
 *   'conflict'   同 id 内容冲突
 *   'disjoint'   互不包含
 *   'unknown'    证据不足
 */
function compareFingerprints(a, b, options = {}) {
  const allowContainment = options.allowContainment === true;
  if (!a || !b) return { relation: 'unknown', reason: 'missing-fingerprint' };

  // 逐字节相同是最强证据，且不依赖 JSONL 结构解析 —— 即使文件里有重复 UUID、
  // 未知记录类型或无法解析的行，两份完全相同的字节也必然是副本。
  if (a.exists && b.exists && a.rawSha && b.rawSha && a.rawSha === b.rawSha) {
    return { relation: 'equal', reason: 'byte-identical' };
  }
  if (!a.ok || !b.ok) return { relation: 'unknown', reason: allowContainment ? 'not-parsable' : 'not-byte-identical' };

  // 相对路径的外部引用（附件/图片）：同名文件在不同会话目录下可能是不同内容。
  // 无法据此证明「内容相同」，只能退回到逐字节证据 —— 而这一层已经排除了。
  if (a.relativeArtifactRefs > 0 || b.relativeArtifactRefs > 0) {
    return {
      relation: 'unknown',
      reason: `relative-artifact-refs(a=${a.relativeArtifactRefs},b=${b.relativeArtifactRefs})`,
    };
  }

  // 内容层：同 id 必须内容一致，否则冲突直接放弃。
  for (const [id, hash] of a.messages) {
    const other = b.messages.get(id);
    if (other !== undefined && other !== hash) {
      return { relation: 'conflict', reason: `message-content-conflict:${id}` };
    }
  }
  const sameMessages = messagesEqual(a.messages, b.messages);
  const sameUnkeyed = multisetEqual(a.unkeyed, b.unkeyed);
  if (sameMessages && sameUnkeyed) {
    return { relation: 'equal', reason: 'message-content-identical' };
  }
  const aInB = messagesSubset(a.messages, b.messages) && multisetSubset(a.unkeyed, b.unkeyed);
  const bInA = messagesSubset(b.messages, a.messages) && multisetSubset(b.unkeyed, a.unkeyed);
  if (aInB && bInA) return { relation: 'equal', reason: 'message-content-identical' };
  if (!allowContainment) {
    // 包含关系存在但未开启：这是「可能重复但证据不足」，必须显式区别于互不相干。
    if (aInB) return { relation: 'subset', reason: 'a-contained-in-b-but-containment-disabled' };
    if (bInA) return { relation: 'subset', reason: 'b-contained-in-a-but-containment-disabled' };
    return { relation: 'disjoint', reason: 'no-message-overlap' };
  }
  if (aInB) return { relation: 'a-contained', reason: `subset:${a.messages.size}->${b.messages.size}` };
  if (bInA) return { relation: 'a-contains', reason: `superset:${b.messages.size}->${a.messages.size}` };
  return { relation: 'disjoint', reason: 'mutually-incomparable' };
}

function tableColumns(db) {
  return db.all("PRAGMA table_info('sessions')").then((rows) => new Set(rows.map((r) => String(r.name))));
}

/**
 * 生成去重计划。纯只读：不写数据库、不碰文件。
 *
 * options:
 *   scope: 'manual' | 'background'
 *   mode:  'exact' | 'containment'
 */
async function planDedupe(db, dataRoot, options = {}) {
  const scope = options.scope === 'background' ? 'background' : 'manual';
  const mode = options.mode === MODE_CONTAINMENT ? MODE_CONTAINMENT : MODE_EXACT;
  const allowContainment = mode === MODE_CONTAINMENT;
  const idx = buildJsonlIndex(path.join(String(dataRoot || ''), 'projects'));
  const cols = await tableColumns(db);
  const wanted = ['id', 'cwd', 'title', 'created_at', 'updated_at', 'status', 'deleted_at', 'is_background_automation'];
  const select = wanted.filter((c) => cols.has(c));
  const scopeSql = scope === 'background'
    ? `COALESCE(is_background_automation, 0) = 1`
    : `COALESCE(is_background_automation, 0) = 0`;
  const rows = await db.all(
    `SELECT ${select.join(', ')} FROM sessions WHERE ${NOT_DELETED} AND ${scopeSql} ` +
    'ORDER BY cwd, title, updated_at DESC, created_at DESC'
  );

  const groups = new Map();
  let skippedNoFile = 0;
  for (const row of rows) {
    const id = String(row.id || '');
    const file = idx.get(id);
    if (!file) { skippedNoFile += 1; continue; }
    const key = String(row.title || '') + '\u0000' + String(row.cwd || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, file });
  }

  const plan = {
    scope, mode, allowContainment,
    scanned: rows.length,
    groupsConsidered: 0,
    groupsSkipped: 0,
    skippedNoFile,
    drops: [],                 // { id, keepId, reason, evidence }
    keeps: [],                 // id
    details: [],               // 每组判定理由
    fingerprints: new Map(),   // id -> finger（写前复验用）
  };

  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    plan.groupsConsidered += 1;
    const g = judgeGroup(list, allowContainment);
    plan.details.push({
      title: String(list[0].row.title || ''),
      cwd: String(list[0].row.cwd || ''),
      members: list.length,
      decision: g.decision,
      reason: g.reason,
      keep: g.keeps,
      drop: g.drops.map((d) => d.id),
    });
    if (g.decision !== 'drop') { plan.groupsSkipped += 1; continue; }
    for (const [id, fp] of g.fingerprints) plan.fingerprints.set(id, fp);
    plan.keeps.push(...g.keeps);
    plan.drops.push(...g.drops);
  }

  return plan;
}

/**
 * 单组判定。返回 { decision: 'drop'|'keep-all', keeps, drops, reason, fingerprints }。
 */
function judgeGroup(list, allowContainment) {
  const items = list.map(({ row, file }) => ({
    id: String(row.id),
    row,
    file,
    fp: inspectSessionFile(file),
  }));
  const fingerprints = new Map(items.map((it) => [it.id, it.fp]));
  const out = (decision, reason, keeps, drops) => ({
    decision, reason, keeps: keeps.map((i) => i.id),
    drops: drops.map((d) => ({ id: d.id, keepId: d.keepId, reason: d.reason, evidence: d.evidence })),
    fingerprints,
  });

  if (items.some((it) => !it.fp.ok)) {
    const bad = items.filter((it) => !it.fp.ok).map((it) => `${it.id}:${it.fp.error || 'unknown'}`);
    return out('keep-all', `unreadable-or-unstable(${bad.join(',')})`, items, []);
  }
  // 附属产物（附件目录、同名图片等）：判错会让人以为会话连同附件一起丢了。整组保留。
  if (items.some((it) => it.fp.sidecars && it.fp.sidecars.present)) {
    const bad = items.filter((it) => it.fp.sidecars && it.fp.sidecars.present)
      .map((it) => `${it.id}:${it.fp.sidecars.names.join('|')}`);
    return out('keep-all', `sidecar-artifacts(${bad.join(',')})`, items, []);
  }

  // ---- 第 1 步：完全相同的副本聚类（字节相同 或 消息内容完全相同）----
  const parent = new Map(items.map((it) => [it.id, it.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const cmp = compareFingerprints(items[i].fp, items[j].fp, { allowContainment: false });
      pairs.push({ a: items[i], b: items[j], cmp });
      if (cmp.relation === 'equal') union(items[i].id, items[j].id);
      if (cmp.relation === 'conflict') {
        return out('keep-all', `content-conflict(${items[i].id},${items[j].id})`, items, []);
      }
    }
  }
  const clusters = new Map();
  for (const it of items) {
    const root = find(it.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(it);
  }

  const exactDrops = [];
  const reps = [];
  const clusterRep = new Map();          // 任一成员 -> 所属簇的代表
  for (const cluster of clusters.values()) {
    cluster.sort((x, y) =>
      (Number(y.row.updated_at || 0) - Number(x.row.updated_at || 0)) ||
      (Number(y.row.created_at || 0) - Number(x.row.created_at || 0)) ||
      String(x.id).localeCompare(String(y.id)));
    const keeper = cluster[0];
    reps.push(keeper);
    for (const it of cluster) clusterRep.set(it.id, keeper.id);
    for (const it of cluster.slice(1)) {
      exactDrops.push({
        id: it.id, repId: keeper.id,
        reason: 'exact-duplicate',
        evidence: it.fp.rawSha && it.fp.rawSha === keeper.fp.rawSha ? 'byte-identical' : 'message-content-identical',
      });
    }
  }

  const finish = (reason, keeps, containmentDrops, noteSuffix) => {
    // 被删的行指向的保留者本身也可能被删（重复副本 + 包含关系叠加）：
    // 沿着「代表 -> 最终保留者」链一路解析，避免 keepId 指向一条也被删的行。
    const chain = new Map(containmentDrops.map((d) => [d.id, d.keepId]));
    const resolve = (id) => {
      let cur = id;
      for (let guard = 0; guard < 64; guard++) {
        if (!chain.has(cur)) return cur;
        cur = chain.get(cur);
      }
      return null;
    };
    const drops = [];
    for (const d of exactDrops) {
      const keepId = resolve(d.repId);
      if (!keepId || keepId === d.id) continue;      // 链异常：宁可少删
      drops.push({ id: d.id, keepId, reason: d.reason, evidence: d.evidence });
    }
    for (const d of containmentDrops) {
      const keepId = resolve(d.keepId);
      if (!keepId || keepId === d.id) continue;
      drops.push({ id: d.id, keepId, reason: d.reason, evidence: d.evidence });
    }
    const suffix = noteSuffix ? `(${noteSuffix})` : '';
    if (!drops.length) return out('keep-all', `no-duplicates${suffix}`, keeps, []);
    return out('drop', `${reason}${suffix}`, keeps, drops);
  };

  if (!allowContainment || reps.length < 2) {
    return finish('exact-duplicates', reps, []);
  }

  // ---- 第 2 步：包含关系（仅在显式开启时）----
  const contains = new Map(reps.map((r) => [r.id, []]));   // B -> [A 被 B 包含]
  const containmentSkipped = [];                            // 证据不足而放弃的包含关系
  for (let i = 0; i < reps.length; i++) {
    for (let j = 0; j < reps.length; j++) {
      if (i === j) continue;
      const a = reps[i];
      const b = reps[j];
      const cmp = compareFingerprints(a.fp, b.fp, { allowContainment: true });
      if (cmp.relation === 'conflict') {
        return out('keep-all', `content-conflict(${a.id},${b.id})`, reps, exactDrops);
      }
      if (cmp.relation !== 'a-contains') continue;          // 'a-contained' 由对称轮处理
      // 顺序校验：被包含的那份，消息 id 序列必须是容器序列的**子序列**。
      // 截断型旧副本一定满足（前缀）；两条独立会话只是撞了相同消息时通常不满足。
      // 时间戳不能拿来判：先创建的那条完全可能是「聊了两句就复制走、原件继续聊」。
      if (!isSubsequence(b.fp.order, a.fp.order)) {
        containmentSkipped.push(`${b.id}!subsequence-of:${a.id}`);
        continue;
      }
      contains.get(a.id).push(b);
    }
  }

  const kept = [];
  const containmentDrops = [];
  for (const rep of reps) {
    const containers = reps.filter((other) => other !== rep && contains.get(other.id).some((x) => x.id === rep.id));
    if (!containers.length) { kept.push(rep); continue; }
    // 候选保留者必须收敛到唯一的最大者，否则放弃该条（不确定就保留）。
    const maximal = containers.filter((c) => !containers.some((other) => other !== c && contains.get(other.id).some((x) => x.id === c.id)));
    if (maximal.length !== 1) {
      kept.push(rep);
      continue;
    }
    containmentDrops.push({
      id: rep.id, keepId: maximal[0].id,
      reason: 'strict-subset',
      evidence: `${rep.fp.messageCount}->${maximal[0].fp.messageCount}`,
    });
  }
  const note = containmentSkipped.length
    ? `skipped-containment=${containmentSkipped.length}:${containmentSkipped.slice(0, 3).join('|')}`
    : '';
  return finish('containment', kept, containmentDrops, note);
}

/** <session-id> -> projects/**\/<id>.jsonl */
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

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 写前复验：所有涉及文件的存在性、大小、哈希必须与计划时一致。
 *  这里只关心「文件有没有变」，不关心 JSONL 是否可解析 —— 逐字节相同的计划成员
 *  即使有重复 UUID 也必须能通过复验。 */
function verifyPlanFiles(plan) {
  for (const [id, fp] of plan.fingerprints) {
    const now = inspectSessionFile(fp.file);
    if (!now.exists || !now.rawSha) return { ok: false, id, reason: now.error || 'unreadable' };
    if (now.size !== fp.size || now.rawSha !== fp.rawSha) return { ok: false, id, reason: 'file-changed' };
  }
  return { ok: true };
}

/**
 * 执行去重计划。写库前做三重复验：
 *   1. 文件未变（大小 + 哈希）；
 *   2. 数据库行仍是计划时的 deleted_at（CAS 更新条件）；
 *   3. 事务内逐条检查 changes，写入不完整就补偿回滚。
 */
async function applyDedupe(db, plan, options = {}) {
  const backupRoot = String(options.backupRoot || '');
  const log = typeof options.log === 'function' ? options.log : () => {};
  const dryRun = options.dryRun === true;
  const result = {
    ok: true, applied: false, dryRun, scope: plan.scope, mode: plan.mode,
    groups: plan.details.filter((d) => d.decision === 'drop').length,
    dropped: plan.drops.length,
    ids: plan.drops.map((d) => d.id),
    keptIds: plan.keeps,
    details: plan.details,
    skippedNoFile: plan.skippedNoFile,
    backup: null, journal: null, aborted: null,
  };
  if (!plan.drops.length) return { ...result, applied: !dryRun, groups: 0 };
  if (dryRun) return result;

  const files = verifyPlanFiles(plan);
  if (!files.ok) {
    log(`[dedupe] 中止：文件在扫描后发生变化 ${files.id} (${files.reason})`);
    return { ...result, ok: false, aborted: 'file-changed', abortedId: files.id, abortedReason: files.reason };
  }
  // 二次静置检查：WorkBuddy 正在写消息时，250ms 内文件还会变。
  // 要求调用方在客户端空闲时手动执行；这里用双次采样把「边写边删」挡在库外。
  if (options.requireStable !== false) {
    await new Promise((r) => setTimeout(r, 250));
    const again = verifyPlanFiles(plan);
    if (!again.ok) {
      log(`[dedupe] 中止：文件仍在写入 ${again.id} (${again.reason})`);
      return { ...result, ok: false, aborted: 'file-unstable', abortedId: again.id, abortedReason: again.reason };
    }
  }

  // 写前再读一次数据库，确认待删行仍是「未删除」状态。
  const dropIds = plan.drops.map((d) => d.id);
  const placeholders = dropIds.map(() => '?').join(',');
  const current = await db.all(`SELECT id, deleted_at FROM sessions WHERE id IN (${placeholders})`, dropIds);
  const currentMap = new Map(current.map((r) => [String(r.id), r.deleted_at]));
  for (const d of plan.drops) {
    if (!currentMap.has(d.id)) {
      return { ...result, ok: false, aborted: 'row-missing', abortedId: d.id };
    }
  }

  const opId = `${plan.scope === 'background' ? 'bg-dedupe' : 'dedupe'}-${stamp()}`;
  if (backupRoot) {
    fs.mkdirSync(backupRoot, { recursive: true });
    const backupPath = path.join(backupRoot, `workbuddy-${opId}.db`);
    await db.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
      throw new Error('备份未生成，已中止写入');
    }
    result.backup = backupPath;
  }

  const now = Date.now();
  const rows = plan.drops.map((d) => ({
    id: d.id,
    before: currentMap.get(d.id) === undefined ? null : currentMap.get(d.id),
    after: now,
    reason: d.reason,
    keepId: d.keepId,
    evidence: d.evidence,
  }));

  const chunks = [];
  for (let i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));
  const statements = chunks.map((chunk) => ({
    sql: `UPDATE sessions SET deleted_at = ? WHERE (${chunk.map(() => '(id = ? AND deleted_at IS ?)').join(' OR ')})`,
    params: [now, ...chunk.flatMap((r) => [r.id, r.before])],
  }));
  const results = await db.transaction(statements);
  const changed = results.reduce((sum, r) => sum + Number((r && r.changes) || 0), 0);
  const expected = rows.length;
  if (changed !== expected) {
    // 有行在计划后被改过：把本次已改的行恢复，保持「要么全做，要么全不做」。
    const restore = rows.map((r) => ({
      sql: 'UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at = ?',
      params: [r.before, r.id, r.after],
    }));
    try { await db.transaction(restore); } catch (error) { log(`[dedupe] 补偿回滚失败: ${error.message}`); }
    return { ...result, ok: false, aborted: 'concurrent-modification', changed, expected };
  }

  const journal = {
    version: 1,
    opId,
    createdAt: now,
    scope: plan.scope,
    mode: plan.mode,
    backup: result.backup,
    groups: plan.details.filter((d) => d.decision === 'drop'),
    rows,
  };
  if (backupRoot) {
    const journalPath = path.join(backupRoot, `${opId}.json`);
    writeJsonAtomic(journalPath, journal);
    result.journal = journalPath;
  }
  log(`[dedupe] 完成 ${opId} groups=${result.groups} dropped=${rows.length}`);
  return { ...result, applied: true, journalData: journal };
}

/**
 * 按操作日志回滚软删除。
 * 只回滚「当前 deleted_at 仍等于本次写入值」的行；之后被别处改过的行原样保留。
 */
async function rollbackDedupe(db, journal, options = {}) {
  const dryRun = options.dryRun === true;
  const rows = Array.isArray(journal && journal.rows) ? journal.rows : [];
  const report = { ok: true, total: rows.length, restored: 0, skipped: [], dryRun };
  for (const row of rows) {
    const current = await db.all('SELECT deleted_at FROM sessions WHERE id = ?', [row.id]);
    if (!current.length) { report.skipped.push({ id: row.id, reason: 'row-missing' }); continue; }
    if (current[0].deleted_at !== row.after) {
      report.skipped.push({ id: row.id, reason: 'changed-since-operation', current: current[0].deleted_at });
      continue;
    }
    if (!dryRun) {
      const r = await db.run('UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at = ?', [row.before, row.id, row.after]);
      if (!r || Number(r.changes) !== 1) { report.skipped.push({ id: row.id, reason: 'write-race' }); continue; }
    }
    report.restored += 1;
  }
  report.ok = report.skipped.length === 0;
  return report;
}

module.exports = {
  MODE_EXACT,
  MODE_CONTAINMENT,
  NOT_DELETED,
  canonicalize,
  scanArtifactRefs,
  inspectSidecars,
  isAbsoluteRef,
  isSubsequence,
  inspectSessionFile,
  compareFingerprints,
  buildJsonlIndex,
  planDedupe,
  judgeGroup,
  applyDedupe,
  verifyPlanFiles,
  rollbackDedupe,
  writeJsonAtomic,
  stamp,
};
