'use strict';

// daemon 绑定的三条回归：
//   1. CDP 归属判定除了 WBSWITCH_PROFILE，还必须认「页面来自本 profile 已验证的
//      客户端安装目录」这条路径证据 —— 托盘 / 快捷方式启动的 daemon 环境里没有
//      那个变量，只靠它就等于永远认不了自己的页面。
//   2. 权限探测失败必须退化为 unknown，不能把整个服务拦在启动之外。
//   3. 托盘启动后台服务时必须显式传 profile / 数据目录（托盘由 explorer 拉起，
//      环境里没有 WBSWITCH_*）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PROFILES } = require('../scripts/profiles.js');
const { isTargetForProfile, selectPageTarget, fileTargetInsideDir } = require('../scripts/cdp-targets.js');
const { resolveWindowsPrivilege } = require('../scripts/windows-process-boundary.js');

const REPO = path.join(__dirname, '..');
const CN = PROFILES['workbuddy-cn'];
const AI = PROFILES['workbuddy-ai'];

// 实测现场：客户端装在非默认盘（H:\Program Files\WorkBuddy），页面 URL 落在该目录。
const PAGE_ON_H = 'file:///H:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html?locale=zh-CN';
const ROOT_ON_H = 'H:\\Program Files\\WorkBuddy';

function withoutBoundProfile(fn) {
  const prev = process.env.WBSWITCH_PROFILE;
  delete process.env.WBSWITCH_PROFILE;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.WBSWITCH_PROFILE;
    else process.env.WBSWITCH_PROFILE = prev;
  }
}

test('路径证据：未绑定 profile 时，页面落在已验证安装目录内仍归属成立', () => {
  const page = { type: 'page', url: PAGE_ON_H, title: 'WorkBuddy' };
  withoutBoundProfile(() => {
    // 没有证据 → 保持旧语义（拒绝裸标题）
    assert.equal(isTargetForProfile(page, CN), false);
    // 有安装目录证据 → 认领
    assert.equal(isTargetForProfile(page, CN, { installRoot: ROOT_ON_H }), true);
    assert.equal(selectPageTarget([page], CN, { installRoot: ROOT_ON_H }), page);
  });
});

test('路径证据：兄弟 profile 的安装目录互不认领', () => {
  const aiPage = { type: 'page', url: 'file:///E:/WorkBuddyAI/resources/app.asar/renderer/index.html', title: 'WorkBuddy' };
  const cnPage = { type: 'page', url: 'file:///E:/WorkBuddy/resources/app.asar/renderer/index.html', title: 'WorkBuddy' };
  withoutBoundProfile(() => {
    assert.equal(isTargetForProfile(aiPage, CN, { installRoot: 'E:\\WorkBuddy' }), false);
    assert.equal(isTargetForProfile(cnPage, AI, { installRoot: 'E:\\WorkBuddyAI' }), false);
    assert.equal(isTargetForProfile(cnPage, CN, { installRoot: 'E:\\WorkBuddy' }), true);
  });
});

test('路径证据只接受绝对目录，且不跨形态比较', () => {
  // 相对目录 / 空串不算证据
  assert.equal(fileTargetInsideDir(PAGE_ON_H, 'WorkBuddy'), false);
  assert.equal(fileTargetInsideDir(PAGE_ON_H, ''), false);
  assert.equal(fileTargetInsideDir(PAGE_ON_H, '..\\WorkBuddy'), false);
  // Windows 目录与 POSIX 页面不互相匹配
  assert.equal(fileTargetInsideDir('file:///opt/WorkBuddy/resources/app.asar/index.html', ROOT_ON_H), false);
  // 带主机的 file URL（网络共享）不算证据
  assert.equal(fileTargetInsideDir('file://server/share/WorkBuddy/resources/app.asar/index.html', ROOT_ON_H), false);
  // 非 file 页面不受影响
  assert.equal(fileTargetInsideDir('https://workbuddy.cn/chat', ROOT_ON_H), false);
});

test('路径证据：大小写与斜杠形态不影响判定', () => {
  assert.equal(fileTargetInsideDir(PAGE_ON_H, 'h:/program files/workbuddy'), true);
  assert.equal(fileTargetInsideDir(PAGE_ON_H, 'H:\\Program Files\\WorkBuddy\\'), true);
  // 前缀相同但不是子目录（WorkBuddyX）不能算命中
  assert.equal(fileTargetInsideDir('file:///H:/Program Files/WorkBuddyX/resources/app.asar/i.html', ROOT_ON_H), false);
});

test('强身份信号优先：路径证据不能覆盖明确的兄弟 profile', () => {
  const INTL = PROFILES['codebuddy-intl'];
  // 证据目录取成了父目录（安装根解析异常、共用父目录）时，旧实现会把它当成
  // 「我自己的安装目录」，于是兄弟客户端的页面也被认领 —— 接着就会去清理对方
  // 注入好的组件。顺序必须是：先看强身份信号，明确属于别人就立刻拒绝。
  const cbPage = { type: 'page', url: 'file:///Applications/CodeBuddy.app/Contents/Resources/app.asar/renderer/agentManager.html', title: 'CodeBuddy' };
  const aiPage = { type: 'page', url: 'file:///Applications/WorkBuddy%20AI.app/Contents/Resources/app.asar/renderer/index.html', title: 'WorkBuddy' };
  const cnPage = { type: 'page', url: 'file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html', title: 'WorkBuddy' };
  withoutBoundProfile(() => {
    assert.equal(isTargetForProfile(cbPage, CN, { installRoot: '/Applications' }), false,
      'CodeBuddy 的页面不能被 CN 认领');
    assert.equal(isTargetForProfile(aiPage, CN, { installRoot: '/Applications' }), false,
      'AI 的页面不能被 CN 认领');
    assert.equal(isTargetForProfile(cnPage, CN, { installRoot: '/Applications' }), true,
      '自己的页面仍要认领（不能因为收紧顺序而误拒）');
    assert.equal(isTargetForProfile(cbPage, INTL, { installRoot: '/Applications' }), true,
      'CodeBuddy 的页面应归国际版');
  });
});

test('权限探测：第一条成功即返回，不重复探测', () => {
  let secondCalled = false;
  const result = resolveWindowsPrivilege([
    () => 'standard',
    () => { secondCalled = true; return 'elevated'; },
  ]);
  assert.deepEqual(result, { privilege: 'standard', errors: [] });
  assert.equal(secondCalled, false);
});

test('权限探测：第一条失败时回落到第二条', () => {
  const result = resolveWindowsPrivilege([
    () => { throw new Error('无法确认 Windows 进程权限: spawn powershell EPERM'); },
    () => 'elevated',
  ]);
  assert.equal(result.privilege, 'elevated');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /powershell/);
});

test('权限探测：两条都失败退化为 unknown 并保留原因', () => {
  const result = resolveWindowsPrivilege([
    () => { throw new Error('powershell 被策略阻止'); },
    () => { throw new Error('启动器缺失'); },
  ]);
  assert.equal(result.privilege, 'unknown');
  assert.deepEqual(result.errors, ['powershell 被策略阻止', '启动器缺失']);
});

test('权限探测：无效返回值按失败处理，不当作权限结论', () => {
  const result = resolveWindowsPrivilege([() => '', () => 'root', () => 'standard']);
  assert.equal(result.privilege, 'standard');
  assert.equal(result.errors.length, 2);
  assert.equal(resolveWindowsPrivilege([() => 'admin']).privilege, 'unknown');
  assert.equal(resolveWindowsPrivilege([]).privilege, 'unknown');
});

test('托盘启动服务时显式传绑定，不靠继承', () => {
  const cs = fs.readFileSync(path.join(REPO, 'tray', 'WorkDaddyTray.cs'), 'utf8');
  // 解析函数存在且在 Main 里被调用（--status 也要能看到）
  assert.match(cs, /private static void ResolveLaunchBinding\(\)/);
  assert.match(cs, /s_watchdog = Path\.Combine\(s_scripts, "watchdog\.js"\);\s*\n\s*ResolveLaunchBinding\(\);/);
  // 绑定真正写进子进程环境
  assert.match(cs, /Environment\.SetEnvironmentVariable\("WBSWITCH_PROFILE"/);
  assert.match(cs, /Environment\.SetEnvironmentVariable\("WBSWITCH_DATA_DIR"/);
  // 不能用 ProcessStartInfo.EnvironmentVariables：.NET Framework 里它是大小写不敏感的
  // StringDictionary，环境同时含 HTTPS_PROXY / https_proxy 时一访问就抛异常。
  assert.equal(/psi\.EnvironmentVariables\[/.test(cs), false);
  // 绑定值来自 install-state.json
  assert.match(cs, /JsonStringField\(text, "clientProfile"\)/);
  assert.match(cs, /JsonStringField\(text, "dataDir"\)/);
});

test('daemon 的归属判定都带上路径证据', () => {
  const daemon = fs.readFileSync(path.join(REPO, 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /function cdpProfileEvidence\(\)/);
  const calls = daemon.match(/isTargetForProfile\([^)]*cdpProfileEvidence\(\)/g) || [];
  const selects = daemon.match(/selectPageTarget\([^)]*cdpProfileEvidence\(\)/g) || [];
  assert.ok(calls.length >= 2, `isTargetForProfile 带证据的调用点不足：${calls.length}`);
  assert.ok(selects.length >= 2, `selectPageTarget 带证据的调用点不足：${selects.length}`);
  // 证据来自真实解析链，不是环境变量
  assert.match(daemon, /function workBuddyInstallRoot\(\)[\s\S]{0,600}resolveWorkBuddyBinary\(\)/);
});
