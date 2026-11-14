'use strict';
/**
 * session-pin-sync.js — 会话置顶（pin）跨账号同步的候选实现（P2，默认不启用）。
 *
 * 借鉴上游 babygoton/workdaddy 的 session-pin-sync.js，但做了三点收敛：
 *   1. 只保存**会话 ID**，绝不保存会话内容、账号凭据或昵称；
 *   2. 只做「补上目标账号缺少的 pin」，**永不取消**目标账号已有的 pin；
 *   3. 交付前重新校验映射与账号上下文；映射失效的条目直接跳过（不猜、不重试到天荒地老）。
 *
 * 与上游的差异：本 fork 的 rehome 是「同一行改 user_id」，会话 ID 在账号之间不变，
 * 所以默认 resolve 是恒等映射（sourceId === targetId）。若将来改成复制式迁移，
 * 传入自己的 resolve(sourceUid, targetUid, ids) 即可。
 *
 * 重要：pin 状态在云端（本地 sessions 表没有 pin 字段），真正落盘只能通过渲染层的
 * `window.wb.conversations.pin()`。因此本模块只提供队列与幂等控制，**是否接线由
 * 调用方决定**；daemon 默认不加载它。
 */
const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;

/** 只接受形如 UUID / 短 id 的安全字符，杜绝把任意字符串塞进渲染层调用。 */
function cleanIds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  return [...new Set(list.filter((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)))];
}

function createSessionPinSync(options = {}) {
  const file = String(options.file || '');
  const read = typeof options.read === 'function' ? options.read : async () => null;
  const apply = typeof options.apply === 'function' ? options.apply : async () => false;
  const resolve = typeof options.resolve === 'function'
    ? options.resolve
    : async (_source, _target, ids) => ids.map((id) => ({ sourceId: id, targetId: id }));
  const log = typeof options.log === 'function' ? options.log : () => {};

  let state = { version: STATE_VERSION, snapshots: {}, pending: {}, delivered: {}, unpinned: {} };
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && saved.version === STATE_VERSION) {
        state = {
          version: STATE_VERSION,
          snapshots: saved.snapshots || {},
          pending: saved.pending || {},
          delivered: saved.delivered || {},
          unpinned: saved.unpinned || {},
        };
      }
    } catch (_) {}
  }

  let tail = Promise.resolve();
  const serial = (fn) => {
    const task = tail.then(fn);
    tail = task.catch(() => {});
    return task;
  };

  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  const key = (source, target, sourceId, targetId) => JSON.stringify([source, target, sourceId, targetId]);

  /**
   * 记录源账号当前的 pin 快照。
   * 官方取消 pin 后，未交付的副本与已交付记录一起失效，允许将来重新 pin 再同步。
   */
  async function capture(uid) {
    if (!uid) return false;
    const ids = await read(uid);
    if (!Array.isArray(ids)) return false;
    const pins = cleanIds(ids);
    state.snapshots[uid] = pins;
    for (const target of Object.keys(state.pending)) {
      state.pending[target] = state.pending[target].filter(
        (item) => item.source !== uid || pins.includes(item.sourceId)
      );
    }
    for (const id of Object.keys(state.delivered)) {
      let parsed = null;
      try { parsed = JSON.parse(id); } catch (_) { continue; }
      const [source, , sourceId] = parsed;
      if (source === uid && !pins.includes(sourceId)) delete state.delivered[id];
    }
    save();
    return true;
  }

  /** 把目标账号待交付的 pin 补上；映射失效的条目直接丢弃。 */
  async function flush(uid) {
    if (!uid) return false;
    const pending = state.pending[uid] || [];
    if (!pending.length) return false;
    const valid = [];
    for (const source of new Set(pending.map((item) => item.source))) {
      const group = pending.filter((item) => item.source === source);
      let mappings = [];
      try {
        mappings = await resolve(source, uid, group.map((item) => item.sourceId));
      } catch (error) {
        log(`[pin] 映射解析失败 ${source}->${uid}: ${error.message}`);
        continue;
      }
      for (const item of group) {
        const hit = (mappings || []).find((m) => m && m.sourceId === item.sourceId && m.targetId === item.targetId);
        if (hit) valid.push(item);
      }
    }
    const ordered = pending.filter((item) => valid.includes(item));
    if (!ordered.length) {
      delete state.pending[uid];
      save();
      return false;
    }
    const targetIds = cleanIds(ordered.map((item) => item.targetId));
    let ok = false;
    try {
      ok = await apply(uid, targetIds);
    } catch (error) {
      log(`[pin] 写入失败 ${uid}: ${error.message}`);
      ok = false;
    }
    if (!ok) return false;                 // 保留 pending，下次再试
    for (const item of ordered) state.delivered[key(item.source, uid, item.sourceId, item.targetId)] = true;
    // 目标账号的已知 pin 集合补上本次写入的 id：快速 A→B→C 轮换时 B 的渲染层
    // 可能还没挂载，没有 capture(B) 可依赖；这里用「我们确实写入过的 id」兜底。
    const known = state.snapshots[uid] || [];
    for (const id of targetIds) if (!known.includes(id)) known.push(id);
    state.snapshots[uid] = known;
    delete state.pending[uid];
    save();
    log(`[pin] 已补 ${ordered.length} 条置顶 -> ${uid}`);
    return true;
  }

  /** 源账号 → 目标账号：把源账号的 pin 排进目标账号的交付队列并立即尝试。 */
  function sync(source, target) {
    return serial(async () => {
      if (!source || !target || source === target) return false;
      const ids = cleanIds([
        ...(state.pending[source] || []).map((item) => item.targetId),
        ...(state.snapshots[source] || []),
      ]);
      if (!ids.length) return false;
      let mappings = [];
      try {
        mappings = await resolve(source, target, ids);
      } catch (error) {
        log(`[pin] 映射解析失败 ${source}->${target}: ${error.message}`);
        return false;
      }
      const queue = state.pending[target] || [];
      for (const sourceId of ids) {
        const hit = (mappings || []).find((m) => m && m.sourceId === sourceId);
        const targetId = hit && hit.targetId;
        if (!cleanIds([targetId]).length) continue;
        // rehome 的常态是同一行改归属：targetId === sourceId 是合法映射。
        if (state.delivered[key(source, target, sourceId, targetId)]) continue;
        if (queue.some((item) => item.source === source && item.sourceId === sourceId && item.targetId === targetId)) continue;
        queue.push({ source, sourceId, targetId });
      }
      if (!queue.length) return false;
      state.pending[target] = queue;
      save();
      return flush(target);
    });
  }

  function status() {
    return {
      version: STATE_VERSION,
      snapshots: Object.fromEntries(Object.entries(state.snapshots).map(([uid, ids]) => [uid, ids.length])),
      pending: Object.fromEntries(Object.entries(state.pending).map(([uid, list]) => [uid, list.length])),
      delivered: Object.keys(state.delivered).length,
      file,
    };
  }

  return { capture: (uid) => serial(() => capture(uid)), flush: (uid) => serial(() => flush(uid)), sync, status };
}

/* ---- 渲染层片段：只通过公开 SDK，且每一步都复核账号上下文 ---- */

/** 读取当前账号的 pin 列表；账号上下文不匹配返回 null。 */
async function readPinsInRenderer(expected) {
  const wb = window.wb;
  if (!wb || !wb.account || !wb.account.profile || !wb.conversations || !wb.conversations.listPinned) return null;
  const matches = (p) => p
    && String(p.uid || '') === String((expected || {}).uid || '')
    && String(p.type || '') === String((expected || {}).type || '')
    && String(p.enterpriseId || '') === String((expected || {}).enterpriseId || '');
  if (!matches(await wb.account.profile())) return null;
  const items = await wb.conversations.listPinned();
  if (!Array.isArray(items) || !matches(await wb.account.profile())) return null;
  return items.map((item) => item.id).filter((id) => typeof id === 'string');
}

/** 只补缺少的 pin，不取消目标账号已有的 pin；顺序按源账号的原始顺序。 */
async function applyPinsInRenderer(expected, ids) {
  const wb = window.wb;
  const c = wb && wb.conversations;
  if (!wb || !wb.account || !wb.account.profile || !c || !c.listPinned || !c.pin) return false;
  const matches = (p) => p
    && String(p.uid || '') === String((expected || {}).uid || '')
    && String(p.type || '') === String((expected || {}).type || '')
    && String(p.enterpriseId || '') === String((expected || {}).enterpriseId || '');
  if (!matches(await wb.account.profile())) return false;
  const before = await c.listPinned();
  if (!Array.isArray(before)) return false;
  const existing = new Set(before.map((item) => item.id));
  for (const id of ids.slice().reverse()) {
    if (existing.has(id)) continue;
    if (!matches(await wb.account.profile())) return false;
    const result = await c.pin(id);
    if (result && result.errorCode) return false;
  }
  if (!matches(await wb.account.profile())) return false;
  const after = await c.listPinned();
  return Array.isArray(after) && ids.every((id) => after.some((item) => item.id === id));
}

module.exports = { createSessionPinSync, readPinsInRenderer, applyPinsInRenderer, cleanIds, STATE_VERSION };
