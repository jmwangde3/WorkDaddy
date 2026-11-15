'use strict';
/**
 * Profile 白名单与路径校验的一致性回归。
 *
 *   node test/profile-whitelist.test.js
 *
 * 三处各有一份白名单：scripts/profiles.js（JS）、tray/WorkDaddyTray.cs（C#）、
 * installer/lib/common.ps1（PowerShell）。跨语言没法共享常量，所以用测试锁住
 * 「三份必须完全相同」—— 少一个客户端，托盘就会把它当非法值拒绝启动；
 * 多一个不存在的 id，daemon 就会去接管一个不存在的客户端。
 *
 * 路径判据同理：C:relative / \relative / relative 都不是完整绝对路径。
 * Path.IsPathRooted（C#）、path.isAbsolute 都会放过 C:foo，不能当校验用。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');
const { PROFILE_IDS, isValidProfileId, isFullWindowsPath, getProfile } = require('../scripts/profiles.js');

const isWin = process.platform === 'win32';
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

function read(rel) {
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

function sorted(list) {
  return [...new Set(list)].sort();
}

function sameSet(a, b) {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

test('profiles.js 只暴露四个客户端 profile', () => {
  assert(sameSet(PROFILE_IDS, ['workbuddy-cn', 'workbuddy-ai', 'codebuddy-cn', 'codebuddy-intl']),
    'PROFILE_IDS 不符：' + PROFILE_IDS.join(','));
  for (const id of PROFILE_IDS) assert(isValidProfileId(id), '合法 id 被判非法：' + id);
  for (const bogus of ['unknown-profile', 'test-profile', 'workbuddy-cn-xxx', '', null, 'WorkBuddy CN']) {
    assert(!isValidProfileId(bogus), '非法 id 被放行：' + bogus);
  }
});

test('getProfile 对未知 profile 报错，不静默映射到 CN', () => {
  let message = '';
  try { getProfile('unknown-profile'); } catch (error) { message = String(error.message); }
  assert(message, '未知 profile 必须抛错');
  assert(/未知客户端 profile/.test(message), '错误信息应明确指出非法 profile：' + message);
  // 显式合法值必须仍然可用
  assert(getProfile('codebuddy-intl').id === 'codebuddy-intl');
});

test('托盘（C#）白名单与 profiles.js 完全一致', () => {
  const cs = read('tray/WorkDaddyTray.cs');
  const block = cs.match(/string\[\]\s*ProfileIds\s*=\s*\{([\s\S]*?)\};/);
  assert(block, '托盘里找不到 ProfileIds 白名单');
  const ids = [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert(sameSet(ids, PROFILE_IDS), '托盘白名单与 profiles.js 不一致：' + ids.join(','));
  // 旧实现用「形如 id」的正则，会把 workbuddy-cn-xxx 放行
  assert(!/Regex\.IsMatch\(profile \?\? "", @"\^\[a-z0-9\]/.test(cs),
    '托盘不得再用「形如 id」的正则代替白名单');
});

test('安装器（PowerShell）白名单与 profiles.js 完全一致，且用 ValidateSet 拒绝非法值', () => {
  const ps = read('installer/lib/common.ps1');
  const block = ps.match(/\$script:ProfileIds\s*=\s*@\(([\s\S]*?)\)/);
  assert(block, 'common.ps1 里找不到 ProfileIds 白名单');
  const ids = [...block[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert(sameSet(ids, PROFILE_IDS), 'PowerShell 白名单与 profiles.js 不一致：' + ids.join(','));

  const installer = read('installer/install-workdaddy.ps1');
  const vs = installer.match(/\[ValidateSet\(([^)]*)\)\][\s\S]{0,80}\$ClientProfile/);
  assert(vs, '安装器的 -ClientProfile 必须有 ValidateSet');
  const set = [...vs[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert(sameSet(set, PROFILE_IDS), 'ValidateSet 与白名单不一致：' + set.join(','));
});

test('isFullWindowsPath：接受完整绝对路径，拒绝盘符/根相对路径', () => {
  const accept = ['C:\\WorkDaddyData', 'E:\\WorkDaddyData', 'c:/data', '\\\\server\\share\\wd'];
  const reject = ['C:WorkDaddyData', 'C:relative\\data', '\\relative', 'relative\\data', 'data', '', '  ', 'tmp/x'];
  for (const value of accept) assert(isFullWindowsPath(value), '应接受：' + JSON.stringify(value));
  for (const value of reject) assert(!isFullWindowsPath(value), '应拒绝：' + JSON.stringify(value));
});

// PowerShell 侧同一张表：判据必须逐条一致，否则「安装器放行、托盘拒绝」这种组合
// 会把用户卡在「装得上但起不来」。
const PS_PROBE = [
  'param([string]$Json = "")',
  '. "' + path.join(repo, 'installer', 'lib', 'common.ps1').replace(/"/g, '`"') + '"',
  "$cases = @('C:\\WorkDaddyData','E:\\WorkDaddyData','c:/data','\\\\server\\share\\wd','C:WorkDaddyData','C:relative\\data','\\relative','relative\\data','data','','  ','tmp/x')",
  '$rows = @()',
  'foreach ($c in $cases) {',
  '  $rows += [pscustomobject]@{',
  '    value = $c',
  '    full  = [bool](Test-FullWindowsPath $c)',
  '    dataOk = ([string](Test-DataDirSafe -DataDir $c -AppDir "C:\\Programs\\WorkDaddy") -eq "")',
  '  }',
  '}',
  '$txt = ($rows | ConvertTo-Json -Compress)',
  '[IO.File]::WriteAllText($Json, $txt, (New-Object System.Text.UTF8Encoding($false)))',
].join('\r\n');

if (!isWin) {
  console.log('SKIP PowerShell 路径判据一致性 (非 Windows)');
} else {
  test('PowerShell 与 JS 的路径判据逐条一致', () => {
    const outDir = path.join(repo, 'tmp');
    fs.mkdirSync(outDir, { recursive: true });
    const probe = path.join(outDir, 'profile-whitelist-probe.ps1');
    const out = path.join(outDir, 'profile-whitelist-probe.json');
    // 探针里有中文路径，必须带 BOM：PS 5.1 会按 ANSI/GBK 解码无 BOM 的 .ps1，
    // 路径被解码坏了连 dot-source 都失败（错误还只出现在 stderr）。
    fs.writeFileSync(probe, '\uFEFF' + PS_PROBE);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', probe, '-Json', out], { encoding: 'utf8', timeout: 60000 });
    assert(fs.existsSync(out), 'PowerShell 探针没有产出：' + (r.stderr || r.stdout));
    const rows = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
    for (const row of rows) {
      assert(row.full === isFullWindowsPath(row.value),
        '判据不一致：' + JSON.stringify(row.value) + ' JS=' + isFullWindowsPath(row.value) + ' PS=' + row.full);
    }
  });
}

if (failures > 0) {
  console.error(`FAIL profile-whitelist.test.js (${failures} 项失败)`);
  process.exit(1);
}
console.log('PASS profile-whitelist.test.js');
