'use strict';
/**
 * 打包产物检查（阶段 7）
 *
 *   node --test test/package-hygiene.test.js
 *
 * 真跑一次 installer/build-package.ps1，然后检查产出的 zip 里到底装了什么。
 * 「不该出现的东西进了包」是发布链最难事后发现的一类问题：
 * 本机路径配置、测试夹具、迁移文档、日志，只要混进去一个，发出去就撤不回来。
 *
 * 只在 Windows 上执行（打包器是 PowerShell）。产物写在仓库内 tmp/（已 gitignore），
 * 跑完即删，不碰用户目录。
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const repo = path.join(__dirname, '..');
const packager = path.join(repo, 'installer', 'build-package.ps1');
const tmpBase = path.join(repo, 'tmp');
const roots = [];

function tmpRoot(tag) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const d = fs.mkdtempSync(path.join(tmpBase, `pkg-${tag}-`));
  roots.push(d);
  return d;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function test(name, fn) {
  if (!isWin) {
    console.log(`SKIP ${name} (非 Windows)`);
    return;
  }
  fn();
  console.log(`ok - ${name}`);
}

/**
 * 最小 ZIP 中央目录解析：只为了拿条目名，不解析内容。
 * 不引依赖 —— 这个检查要在任何一次 CI 里都能跑，不能因为依赖装不上就跳过。
 */
function zipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, '不是合法 zip：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, '中央目录在第 ' + i + ' 项损坏');
    const flags = buf.readUInt16LE(off + 8);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const raw = buf.subarray(off + 46, off + 46 + nameLen);
    const name = (flags & 0x800) ? raw.toString('utf8') : raw.toString('latin1');
    // .NET Framework 的 ZipFile（PS 5.1 的 Compress-Archive）用反斜杠存条目名，
    // 而 zip 规范要求正斜杠。统一成正斜杠再比对，否则会误判「包里缺文件」。
    names.push(name.split('\\').join('/'));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function main() {
  assert.ok(fs.existsSync(packager), 'installer/build-package.ps1 存在');
  assert.ok(fs.existsSync(path.join(repo, 'installer', 'setup', 'workdaddy.iss')), 'Setup 脚本存在');

  const root = tmpRoot('hygiene');
  const out = path.join(root, 'dist');
  const reportPath = path.join(root, 'report.json');

  const res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', packager,
    '-OutputDirectory', out,
    '-Json', reportPath,
  ], { encoding: 'utf8', timeout: 600000, env: Object.assign({}, process.env, { TEMP: root, TMP: root }) });

  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
  assert.ok(report, '打包器没写报告：' + (res.stderr || ''));
  assert.equal(res.status, 0, '打包失败：' + (report && report.error));
  assert.equal(report.ok, true);
  assert.equal(report.version, '1.3.0');

  const portable = path.join(out, 'WorkDaddy-1.3.0-portable-win-x64.zip');
  const source = path.join(out, 'WorkDaddy-1.3.0-source.zip');
  const sums = path.join(out, 'SHA256SUMS.txt');
  for (const f of [portable, source, sums]) assert.ok(fs.existsSync(f), '缺产物：' + path.basename(f));

  // 报告里的哈希必须与磁盘一致，且 SHA256SUMS.txt 内容与之对得上
  for (const a of report.artifacts) {
    const file = path.join(out, a.path);
    assert.equal(sha256(file), a.sha256, a.path + ' 的哈希与报告不符');
    assert.equal(fs.statSync(file).size, a.size, a.path + ' 的大小与报告不符');
  }
  const sumsText = fs.readFileSync(sums, 'utf8');
  for (const name of ['WorkDaddy-1.3.0-portable-win-x64.zip', 'WorkDaddy-1.3.0-source.zip']) {
    assert.ok(sumsText.includes(sha256(path.join(out, name))), 'SHA256SUMS.txt 缺 ' + name + ' 的哈希');
  }

  // ---- 便携包内容 ----
  const names = zipEntries(portable);
  assert.ok(names.length >= 100, '便携包条目太少：' + names.length);

  const forbidden = names.filter((n) =>
    /^(test|docs|tools|node_modules|\.git|tmp)\//i.test(n) ||
    /(^|\/)workbuddy-exe\.json$/i.test(n) ||
    /\.log$/i.test(n) ||
    /(^|\/)\.private-docs\//i.test(n));
  assert.deepEqual(forbidden, [], '便携包里混进了不该发的东西：' + forbidden.slice(0, 10).join(', '));

  for (const must of [
    'scripts/daemon.js',
    'scripts/inject.js',
    'scripts/lib.js',
    'scripts/win-launcher.js',
    'installer/install-workdaddy.ps1',
    'installer/update-workdaddy.ps1',
    'installer/uninstall-workdaddy.ps1',
    'installer/lib/common.ps1',
    'src/features/integration/fork-routes.js',
    'LICENSE',
    'README.md',
    'package.json',
  ]) {
    assert.ok(names.includes(must), '便携包缺文件：' + must);
  }

  // 安装器必须一起进包：解压后要能直接 install 到本机
  assert.ok(names.some((n) => /^installer\/.+\.ps1$/.test(n)), '便携包里没有安装器');

  // ---- 源码包内容 ----
  const srcNames = zipEntries(source);
  assert.ok(srcNames.every((n) => n.startsWith('WorkDaddy-1.3.0-source/')), '源码包缺少统一前缀');
  for (const must of [
    'WorkDaddy-1.3.0-source/test/run-ci.js',
    'WorkDaddy-1.3.0-source/docs/migration/01-repository-inventory.md',
    'WorkDaddy-1.3.0-source/scripts/daemon.js',
  ]) {
    assert.ok(srcNames.includes(must), '源码包缺文件：' + must);
  }

  // 源码包里工作区私货不能进去（git archive 只打提交，这里是回归保护）
  assert.equal(srcNames.some((n) => /workbuddy-exe\.json$/.test(n)), false, '源码包里带了本机路径配置');
}

function cleanup() {
  // CI 里要留档产物（发版前人工看一眼里面装了什么），设 WD_PKG_KEEP=1 就不删
  if (process.env.WD_PKG_KEEP) return;
  for (const d of roots) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) {}
  }
}

try {
  main();
  console.log('PASS package-hygiene.test.js');
} catch (error) {
  console.error('FAIL package-hygiene.test.js:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}

process.on('exit', cleanup);
