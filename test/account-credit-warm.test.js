'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAccountCreditCache } = require('../scripts/account-credit-cache');
const { createAccountCreditWarmer } = require('../scripts/account-credit-warm');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-credit-warm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cache: createAccountCreditCache(root), file: path.join(root, 'account-credit-cache.json') };
}

function warmer(cache, options) {
  const calls = [];
  const opts = options || {};
  const instance = createAccountCreditWarmer(Object.assign({
    cache,
    fetchCredits: async (token, account) => {
      calls.push({ token, uid: account && account.uid });
      if (opts.delay) await new Promise(resolve => setTimeout(resolve, opts.delay));
      if (opts.fail) throw opts.fail(account);
      return { credits: 100 + calls.length, segments: [], unlimited: false };
    },
    readBackup: uid => ({ token: 'tk-' + uid, account: { uid } }),
    isExpired: () => false,
    currentUid: () => '',
    log: () => {},
  }, opts.extra || {}));
  return { instance, calls };
}

test('只补缺失或过期的账号，当前账号排在最前，补齐后 TTL 内不再补', async t => {
  const { cache } = fixture(t);
  cache.set('fresh', { credits: 5, segments: [] }, Date.now());
  cache.set('old', { credits: 5, segments: [] }, Date.now() - 10 * 60 * 1000);
  const accounts = [{ uid: 'missing' }, { uid: 'fresh' }, { uid: 'old' }];
  const { instance, calls } = warmer(cache, { extra: { currentUid: () => 'old' } });
  const count = await instance.warm(accounts);
  assert.equal(count, 2);
  assert.deepEqual(calls.map(call => call.uid), ['old', 'missing']);
  assert.equal(cache.get('missing').credits, 102);
  assert.equal((await instance.warm(accounts)), 0);
  assert.equal(calls.length, 2);
});

test('并发上限为 2，同一个 uid 在途只发一次', async t => {
  const { cache } = fixture(t);
  let active = 0;
  let peak = 0;
  let total = 0;
  const accounts = Array.from({ length: 6 }, (_, index) => ({ uid: 'u' + index }));
  const { instance } = warmer(cache, {
    extra: {
      fetchCredits: async () => {
        active++;
        total++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 15));
        active--;
        return { credits: 1, segments: [], unlimited: false };
      },
    },
  });
  const [first, second] = await Promise.all([instance.warm(accounts), instance.warm(accounts)]);
  assert.equal(first, 6);
  assert.ok(peak <= 2, 'peak=' + peak);
  // 第二轮撞上第一轮的在途任务：不能重复拉同样的 uid。
  assert.equal(second, 6);
  assert.equal(total, 6, 'each uid must be fetched exactly once');
  assert.equal(active, 0);
});

test('超出预算先返回，剩余账号在后台继续补完', async t => {
  const { cache } = fixture(t);
  const accounts = [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }, { uid: 'd' }];
  let done = 0;
  const { instance } = warmer(cache, {
    extra: {
      budgetMs: 20,
      concurrency: 1,
      fetchCredits: async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        done++;
        return { credits: 1, segments: [], unlimited: false };
      },
    },
  });
  const started = Date.now();
  const count = await instance.warm(accounts);
  assert.equal(count, 4);
  assert.ok(Date.now() - started < 100, 'warm should return right after the budget');
  assert.ok(done < 4, 'not everything can be done inside 20ms');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(done, 4, 'the remaining accounts must still be filled afterwards');
});

test('补拉失败只记日志：旧余额不被清空，也不再重复拉同一秒内的同一账号', async t => {
  const { cache } = fixture(t);
  cache.set('expired', { credits: 42, segments: [] }, Date.now() - 10 * 60 * 1000);
  cache.set('broken', { credits: 7, segments: [] }, Date.now() - 10 * 60 * 1000);
  const logs = [];
  const { instance, calls } = warmer(cache, {
    extra: {
      log: message => logs.push(message),
      fetchCredits: async (token, account) => {
        calls.push(account.uid);
        if (account.uid === 'expired') throw Object.assign(new Error('登录身份过期'), { expired: true });
        throw new Error('gateway 500');
      },
    },
  });
  await instance.warm([{ uid: 'expired' }, { uid: 'broken' }]);
  assert.deepEqual(calls.sort(), ['broken', 'expired']);
  assert.equal(cache.get('expired').credits, 42);
  assert.equal(cache.get('broken').credits, 7);
  assert.equal(logs.length, 2);
  assert.match(logs.join('\n'), /gateway 500/);
});

test('身份已过期的账号直接跳过，不做任何请求', async t => {
  const { cache } = fixture(t);
  const { instance, calls } = warmer(cache, { extra: { isExpired: account => account.uid === 'gone' } });
  assert.equal((await instance.warm([{ uid: 'gone' }])), 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(cache.get('gone'), {});
});

test('备份缺失或没有 token 时静默跳过，不写缓存', async t => {
  const { cache } = fixture(t);
  const { instance } = warmer(cache, {
    extra: { readBackup: uid => (uid === 'no-token' ? { token: '', account: { uid } } : null) },
  });
  assert.equal((await instance.warm([{ uid: 'no-token' }, { uid: 'no-backup' }])), 2);
  assert.deepEqual(cache.get('no-token'), {});
  assert.deepEqual(cache.get('no-backup'), {});
});
