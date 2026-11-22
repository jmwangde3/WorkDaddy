'use strict';

// `GET /api/accounts` 只回放 accountCreditCache，而唯一写这个缓存的是 `POST /api/credits`
// —— 而它只有注入面板在调。于是「面板没打开过」「刚切到新账号」时，托盘菜单只能显示 `-`，
// 必须等面板拉一次或重启 daemon 才读到数。
//
// 这里做一次有预算的按需补拉：只补缺失/过期的账号，当前账号排最前，并发受限，
// 同一个 uid 在途只发一次。超预算就先让列表接口返回已有缓存，剩下的在后台自己跑完。
// 任何失败都只记日志：列表接口必须仍然 200，字段语义也不能变。
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_BUDGET_MS = 2500;

function createAccountCreditWarmer(deps) {
  const cache = deps.cache;
  const fetchCredits = deps.fetchCredits;
  const readBackup = deps.readBackup;
  const isExpired = deps.isExpired || (() => false);
  const currentUid = deps.currentUid || (() => '');
  const log = deps.log || (() => {});
  const ttlMs = typeof deps.ttlMs === 'number' ? deps.ttlMs : DEFAULT_TTL_MS;
  const concurrency = typeof deps.concurrency === 'number' ? deps.concurrency : DEFAULT_CONCURRENCY;
  const budgetMs = typeof deps.budgetMs === 'number' ? deps.budgetMs : DEFAULT_BUDGET_MS;
  const inFlight = new Map();

  // 单账号补拉。401/过期账号直接放弃：把 null 写进缓存会把菜单从「有余额」变成「-」，
  // 比留着旧值更糟。
  function warmOne(uid) {
    const running = inFlight.get(uid);
    if (running) return running;
    const task = (async () => {
      try {
        const backup = readBackup(uid);
        if (!backup || !backup.token) return;
        const result = await fetchCredits(backup.token, backup.account);
        cache.set(uid, result);
      } catch (error) {
        log('[credits] 补拉 ' + uid + ' 积分失败: ' + (error && error.message));
      } finally {
        inFlight.delete(uid);
      }
    })();
    inFlight.set(uid, task);
    return task;
  }

  async function warm(accounts) {
    const list = Array.isArray(accounts) ? accounts : [];
    const current = String(currentUid() || '');
    const targets = list
      .filter(account => account && account.uid && !isExpired(account) && typeof cache.isStale === 'function' && cache.isStale(account.uid, ttlMs))
      .sort((a, b) => (a.uid === current ? 0 : 1) - (b.uid === current ? 0 : 1));
    if (!targets.length) return 0;

    let cursor = 0;
    let timer = null;
    const worker = async () => {
      while (cursor < targets.length) {
        const account = targets[cursor++];
        await warmOne(account.uid);
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, targets.length); i++) workers.push(worker());
    try {
      await Promise.race([
        Promise.all(workers),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            // 预算只决定「列表接口什么时候返回」，不打断已经在跑的补拉：
            // 托盘下次展开菜单就该看到数，而不是永远缺着。
            log('[credits] 按需补拉超出预算 ' + budgetMs + 'ms，先返回已有缓存，剩余在后台补齐');
            resolve();
          }, budgetMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return targets.length;
  }

  return { warm, warmOne };
}

module.exports = { createAccountCreditWarmer, DEFAULT_TTL_MS, DEFAULT_CONCURRENCY, DEFAULT_BUDGET_MS };
