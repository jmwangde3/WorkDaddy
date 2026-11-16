'use strict';

/**
 * 本地 API 认证边界（任务书 8.2）。
 *
 * 这里不启动完整 daemon —— 它会去连真实 WorkBuddy、真实账号，测试里不该有这种副作用。
 * 改为从 daemon.js 原文切出认证相关的三个函数，注入一枚假 token 后直接验证判定结果：
 * 判定逻辑就是这几行，切出来测等于测它本身。
 *
 * 「真实 daemon 上跑一遍」在交付报告里单独记录，不作为自动化断言。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const daemonSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'daemon.js'), 'utf8');

const FAKE_TOKEN = 'f'.repeat(64);

function loadAuthHelpers({ customTarget = false, apiHost = 'https://api.workbuddy.cn' } = {}) {
  const start = daemonSource.indexOf('const PUBLIC_API_PATHS = new Set([');
  const end = daemonSource.indexOf('function isAllowedDevtoolsOrigin');
  assert.ok(start > 0 && end > start, 'daemon.js 里的认证段落结构变了，需要同步这个测试');
  const code = daemonSource.slice(start, end);
  const factory = new Function(
    'crypto', 'API_TOKEN', 'PROFILE',
    `${code}\nreturn { isApiRequestAuthorized, isAllowedApiOrigin, PUBLIC_API_PATHS };`
  );
  return factory(crypto, FAKE_TOKEN, { customTarget, apiHost });
}

const helpers = loadAuthHelpers();

function request(headers = {}) {
  return { headers };
}

test('relaunch 不在免认证名单，但允许「没有浏览器痕迹」的本机启动器', () => {
  assert.equal(helpers.PUBLIC_API_PATHS.has('/api/client/relaunch'), false,
    '/api/client/relaunch 有副作用，不能留在免认证名单里');

  // 已安装的 WorkDaddyTray.exe 只发一个空 POST：没有 token，也没有 Origin / Referer /
  // Sec-Fetch-*。不放行它，「恢复 CDP」永远是「请求失败」。
  assert.equal(helpers.isApiRequestAuthorized(request({}), '/api/client/relaunch'), true,
    '本机启动器（无任何浏览器头）必须放行');
});

test('带任何浏览器痕迹的 relaunch 一律拒绝', () => {
  const browserish = [
    { origin: 'null' },
    { referer: 'http://127.0.0.1:47832/' },
    { 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-mode': 'cors' },
    { 'sec-fetch-dest': 'empty' },
  ];
  for (const headers of browserish) {
    assert.equal(helpers.isApiRequestAuthorized(request(headers), '/api/client/relaunch'), false,
      '浏览器痕迹必须拒绝：' + JSON.stringify(headers));
  }
});

test('错误 token 被拒绝，正确 token 通过', () => {
  const wrong = helpers.isApiRequestAuthorized(
    request({ 'x-workdaddy-token': 'a'.repeat(64) }), '/api/client/relaunch');
  assert.equal(wrong, false, '错误 token 必须拒绝');

  // 长度不同也要拒绝（timingSafeEqual 会抛，所以先比长度）
  const shortToken = helpers.isApiRequestAuthorized(
    request({ 'x-workdaddy-token': 'abc' }), '/api/client/relaunch');
  assert.equal(shortToken, false, '长度不符的 token 必须拒绝');

  const right = helpers.isApiRequestAuthorized(
    request({ 'x-workdaddy-token': FAKE_TOKEN }), '/api/client/relaunch');
  assert.equal(right, true, '正确 token 应通过');
});

// 任务书原文：不允许通过 null Origin 绕过认证。
// null 是 file:// 与 sandboxed iframe 的 Origin 值，任何本机网页都能造出来。
test('Origin: null 不能绕过认证', () => {
  const bypass = helpers.isApiRequestAuthorized(
    request({ origin: 'null' }), '/api/client/relaunch');
  assert.equal(bypass, false, 'Origin: null 且无 token 必须拒绝');

  const withToken = helpers.isApiRequestAuthorized(
    request({ origin: 'null', 'x-workdaddy-token': FAKE_TOKEN }), '/api/client/relaunch');
  assert.equal(withToken, true, 'Origin: null 但带了正确 token 应通过（功能不能因此断掉）');
});

test('外部网站 Origin 被拒绝，即使 token 正确', () => {
  for (const origin of ['https://evil.example.com', 'http://attacker.test']) {
    const allowed = helpers.isApiRequestAuthorized(
      request({ origin, 'x-workdaddy-token': FAKE_TOKEN }), '/api/client/relaunch');
    assert.equal(allowed, false, `外部 Origin 必须拒绝：${origin}`);
  }
});

test('loopback 与官方域名 Origin 允许', () => {
  for (const origin of ['http://127.0.0.1:47832', 'http://localhost:3000', 'https://workbuddy.cn']) {
    const allowed = helpers.isApiRequestAuthorized(
      request({ origin, 'x-workdaddy-token': FAKE_TOKEN }), '/api/client/relaunch');
    assert.equal(allowed, true, `应允许：${origin}`);
  }
});

// 只读路径继续免认证，否则本地 CLI / 状态页自检全都要先拿 token，属于退化。
test('只读路径仍然免认证，但 Origin 校验照旧', () => {
  for (const p of ['/api/status', '/api/about', '/api/update-check']) {
    assert.equal(helpers.isApiRequestAuthorized(request({}), p), true, `无 Origin 时应放行：${p}`);
  }
  const blocked = helpers.isApiRequestAuthorized(request({ origin: 'https://evil.example.com' }), '/api/status');
  assert.equal(blocked, false, '外部 Origin 连只读路径也不能放行');
});

// 状态页要把 token 嵌进 HTML 才能调 relaunch；确认它确实嵌了，而不是写死空串。
test('状态页的 relaunch 按钮带上 token', () => {
  assert.match(daemonSource, /fetch\("\/api\/client\/relaunch",\{method:"POST",headers:\{"x-workdaddy-token":"' \+ API_TOKEN \+ '"\}\}\)/,
    '状态页调用 relaunch 时必须带 x-workdaddy-token');
});

// fix-cdp.cmd 是另一条调用路径，同样要带 token，且要能读到 token 文件。
test('fix-cdp.cmd 从 .api-token 读取并带上 token', () => {
  const cmd = fs.readFileSync(path.join(repoRoot, 'scripts', 'fix-cdp.cmd'), 'utf8');
  assert.match(cmd, /\.api-token/, '必须从 .api-token 读 token');
  assert.match(cmd, /x-workdaddy-token:\s*%WD_TOKEN%/, 'curl 必须带 x-workdaddy-token 头');
  assert.doesNotMatch(cmd, /curl\.exe -s -X POST %DAEMON%\/api\/client\/relaunch/,
    '不能保留不带 token 的裸调用');
});
