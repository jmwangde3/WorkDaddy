'use strict';
/**
 * CodeBuddy CN / 国际版的身份识别回归。
 *
 *   node test/codebuddy-identity.test.js
 *
 * 背景：两版都可能用 CodeBuddy.exe（老版本 CN 就是国际版文件名）。只按文件名
 * 筛选运行进程，CN daemon 会认领国际版的进程 —— 之后结束进程、替换文件、
 * 注入面板全都会作用到另一个客户端上。唯一可靠的身份来自安装目录里的
 * resources/app/product.json：
 *     CN   → applicationName = buddycn
 *     国际 → applicationName = buddy
 * 证明不了（缺失/损坏/不匹配）就当作「不是我的」，宁可返回未找到。
 */
const fs = require('fs');
const path = require('path');

const { isCodeBuddyBinary } = require('../scripts/profiles.js');
const { selectRunningProfileBinary } = require('../scripts/windows-process-boundary.js');

const repo = path.join(__dirname, '..');
const tmpBase = path.join(repo, 'tmp');
let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}\n  ${error.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const root = path.join(tmpBase, 'codebuddy-identity-' + process.pid);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

// 造一个安装目录：<dir>/<exeName> + <dir>/resources/app/product.json
function makeInstall(name, exeName, product) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'resources', 'app'), { recursive: true });
  const exe = path.join(dir, exeName);
  fs.writeFileSync(exe, 'MZ');
  if (product !== undefined) {
    fs.writeFileSync(path.join(dir, 'resources', 'app', 'product.json'),
      typeof product === 'string' ? product : JSON.stringify(product));
  }
  return exe;
}

const cnExe = makeInstall('cn', 'CodeBuddy CN.exe', { applicationName: 'buddycn', nameShort: 'CodeBuddy CN' });
const cnLegacyExe = makeInstall('cn-legacy', 'CodeBuddy.exe', { applicationName: 'buddycn' });
const intlExe = makeInstall('intl', 'CodeBuddy.exe', { applicationName: 'buddy' });
const noMetaExe = makeInstall('no-meta', 'CodeBuddy.exe', undefined);
const corruptExe = makeInstall('corrupt', 'CodeBuddy.exe', '{ not json');
const wrongMetaExe = makeInstall('wrong-meta', 'CodeBuddy.exe', { applicationName: 'somethingelse' });

const realpath = (p) => p;
const proc = (pid, exe) => ({
  ProcessId: pid,
  Name: path.win32.basename(exe),
  ExecutablePath: exe,
});

test('CN 安装（CodeBuddy CN.exe + buddycn）：只认 CN', () => {
  assert(isCodeBuddyBinary(cnExe, 'codebuddy-cn') === true, 'CN 应认领自己');
  assert(isCodeBuddyBinary(cnExe, 'codebuddy-intl') === false, '国际版不得认领 CN');
});

test('老版 CN 用国际版文件名（CodeBuddy.exe + buddycn）：靠 product.json 仍认 CN', () => {
  assert(isCodeBuddyBinary(cnLegacyExe, 'codebuddy-cn') === true, '文件名相同但产品是 buddycn');
  assert(isCodeBuddyBinary(cnLegacyExe, 'codebuddy-intl') === false, '文件名相同也不能给国际版');
});

test('国际版（CodeBuddy.exe + buddy）：只认国际版', () => {
  assert(isCodeBuddyBinary(intlExe, 'codebuddy-intl') === true);
  assert(isCodeBuddyBinary(intlExe, 'codebuddy-cn') === false);
});

test('product.json 缺失 / 损坏 / applicationName 不匹配：一律拒绝', () => {
  for (const exe of [noMetaExe, corruptExe, wrongMetaExe]) {
    assert(isCodeBuddyBinary(exe, 'codebuddy-cn') === false, 'CN 不应认领：' + exe);
    assert(isCodeBuddyBinary(exe, 'codebuddy-intl') === false, '国际版不应认领：' + exe);
  }
});

test('CN 与 Intl 同时运行：各自只认领自己那一份', () => {
  const processes = [proc(101, cnExe), proc(102, intlExe)];
  const names = new Set(['codebuddy cn.exe', 'codebuddy.exe']);

  const cn = selectRunningProfileBinary(names, processes, realpath,
    (bin) => isCodeBuddyBinary(bin, 'codebuddy-cn'));
  const intl = selectRunningProfileBinary(names, processes, realpath,
    (bin) => isCodeBuddyBinary(bin, 'codebuddy-intl'));

  assert(path.resolve(cn).toLowerCase() === path.resolve(cnExe).toLowerCase(), 'CN 应选中 ' + cnExe + '，实际 ' + cn);
  assert(path.resolve(intl).toLowerCase() === path.resolve(intlExe).toLowerCase(), '国际版应选中 ' + intlExe + '，实际 ' + intl);
});

test('不带身份校验时同名双进程无法区分：必须报错而不是随便选一个', () => {
  const processes = [proc(101, cnExe), proc(102, intlExe)];
  const names = new Set(['codebuddy cn.exe', 'codebuddy.exe']);
  let message = '';
  try { selectRunningProfileBinary(names, processes, realpath); } catch (error) { message = String(error.message); }
  assert(/多个安装目录/.test(message), '应因无法区分而拒绝：' + message);
});

test('同 profile 两个安装目录：拒绝自动选择', () => {
  const other = makeInstall('cn-second', 'CodeBuddy.exe', { applicationName: 'buddycn' });
  const processes = [proc(201, cnLegacyExe), proc(202, other)];
  const names = new Set(['codebuddy cn.exe', 'codebuddy.exe']);
  let message = '';
  try {
    selectRunningProfileBinary(names, processes, realpath,
      (bin) => isCodeBuddyBinary(bin, 'codebuddy-cn'));
  } catch (error) { message = String(error.message); }
  assert(/多个安装目录/.test(message), '同 profile 多目录必须拒绝：' + message);
});

test('只有兄弟 profile 在运行：返回未找到，不抢别人的进程', () => {
  const names = new Set(['codebuddy cn.exe', 'codebuddy.exe']);
  const cn = selectRunningProfileBinary(names, [proc(102, intlExe)], realpath,
    (bin) => isCodeBuddyBinary(bin, 'codebuddy-cn'));
  assert(cn === null, '国际版进程不该被 CN 认领，实际 ' + cn);
});

fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.error(`FAIL codebuddy-identity.test.js (${failures} 项失败)`);
  process.exit(1);
}
console.log('PASS codebuddy-identity.test.js');
