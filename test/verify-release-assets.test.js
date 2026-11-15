'use strict';
/**
 * 发布资产校验器（1.3.1 RC2 阶段 3）。
 *
 * 这里造的是虚拟资产：三个 110KB 文件 + SHA256SUMS + 打包报告，全部在 tmp/ 下，
 * 不下载真实构建产物。重点不是「哈希算得对不对」，而是：
 *   - 没有 Git 证据（字段缺失 / 退出码非 0 / sourceCommit 不对）时必须拒绝；
 *   - 正式发布的目录里多一个文件就必须拒绝；
 *   - 不能靠「只检查 dirty」放行一个来源不明的包。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { verify } = require('../tools/verify-release-assets.js');

const VERSION = '1.3.1';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
const tmpBase = path.join(__dirname, '..', 'tmp');
const roots = [];

function tmpDir(tag) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const d = fs.mkdtempSync(path.join(tmpBase, `verify-assets-${tag}-`));
  roots.push(d);
  return d;
}

test.after(() => {
  for (const d of roots) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch (_) {}
  }
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assetName(kind) {
  if (kind === 'portable') return `WorkDaddy-${VERSION}-portable-win-x64.zip`;
  if (kind === 'source') return `WorkDaddy-${VERSION}-source.zip`;
  return `WorkDaddy-${VERSION}-setup.exe`;
}

function writeAsset(dir, kind, fill) {
  const name = assetName(kind);
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(110 * 1024, fill || kind));
  return name;
}

/**
 * 造一套资产 + 报告。返回值里的 report 已经落盘，路径放在 dist 之外
 * （真实流程也是这么放的，dist 里只允许正式资产）。
 */
function makeCase(tag, opts = {}) {
  const root = tmpDir(tag);
  const dir = path.join(root, 'dist');
  fs.mkdirSync(dir, { recursive: true });
  const kinds = ['portable', 'source'];
  if (opts.setup !== false) kinds.push('setup');
  const lines = [];
  for (const kind of kinds) {
    const name = writeAsset(dir, kind);
    lines.push(`${sha256(path.join(dir, name))}  ${name}`);
  }
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');

  const report = Object.assign({
    ok: true,
    version: VERSION,
    setup: opts.setup === false ? 'not-requested' : 'built',
    dirty: false,
    dirtyPaths: [],
    gitRevParseExitCode: 0,
    gitStatusExitCode: 0,
    sourceCommit: COMMIT,
  }, opts.report || {});
  for (const key of (opts.dropReportKeys || [])) delete report[key];
  const reportPath = path.join(root, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { root, dir, reportPath, report };
}

function run(c, overrides = {}) {
  return verify(Object.assign({
    dir: c.dir,
    version: VERSION,
    requireSetup: true,
    report: c.reportPath,
    expectedCommit: COMMIT,
  }, overrides));
}

function expectFail(result, pattern, label) {
  assert.equal(result.ok, false, `${label} 应被拒绝`);
  assert.ok(result.errors.some((e) => pattern.test(e)),
    `${label} 的错误信息不对：${JSON.stringify(result.errors)}`);
}

test('正式三件套齐全、报告与提交都正确：通过', () => {
  const c = makeCase('ok');
  const r = run(c);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.assets.length, 3);
});

test('非 Setup 模式：两件套也通过（不破坏本地打包）', () => {
  const c = makeCase('no-setup', { setup: false });
  const r = run(c, { requireSetup: false });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('gitStatusExitCode 缺失：拒绝', () => {
  const c = makeCase('status-missing', { dropReportKeys: ['gitStatusExitCode'] });
  expectFail(run(c), /gitStatusExitCode/, 'gitStatusExitCode 缺失');
});

test('gitStatusExitCode 非 0：拒绝', () => {
  const c = makeCase('status-bad', { report: { gitStatusExitCode: 128 } });
  expectFail(run(c), /gitStatusExitCode/, 'gitStatusExitCode=128');
});

test('gitRevParseExitCode 非 0：拒绝', () => {
  const c = makeCase('rev-bad', { report: { gitRevParseExitCode: 1 } });
  expectFail(run(c), /gitRevParseExitCode/, 'gitRevParseExitCode=1');
});

test('sourceCommit 缺失：拒绝', () => {
  const c = makeCase('commit-missing', { dropReportKeys: ['sourceCommit'] });
  expectFail(run(c), /sourceCommit/, 'sourceCommit 缺失');
});

test('sourceCommit 格式非法：拒绝', () => {
  const c = makeCase('commit-bad', { report: { sourceCommit: 'main' } });
  expectFail(run(c), /40 位 SHA/, 'sourceCommit=main');
});

test('sourceCommit 与 expected-commit 不一致：拒绝', () => {
  const c = makeCase('commit-diff', { report: { sourceCommit: OTHER_COMMIT } });
  expectFail(run(c), /不一致/, 'sourceCommit 不同');
});

test('dirty=true：拒绝并带出脏文件', () => {
  const c = makeCase('dirty', { report: { dirty: true, dirtyPaths: [' M scripts/daemon.js'] } });
  const r = run(c);
  expectFail(r, /dirty 不是 false/, 'dirty=true');
  assert.ok(r.errors.some((e) => e.includes('scripts/daemon.js')));
});

test('dirty 字段缺失：不能默认当成干净', () => {
  const c = makeCase('dirty-missing', { dropReportKeys: ['dirty'] });
  expectFail(run(c), /dirty 不是 false/, 'dirty 缺失');
});

test('多出一个同版本 ZIP：拒绝', () => {
  const c = makeCase('extra-zip');
  fs.writeFileSync(path.join(c.dir, `WorkDaddy-${VERSION}-extra.zip`), Buffer.alloc(110 * 1024, 'x'));
  expectFail(run(c), /多余条目/, '多余 zip');
});

test('目录里出现子目录：拒绝', () => {
  const c = makeCase('sub-dir');
  fs.mkdirSync(path.join(c.dir, 'nested'));
  expectFail(run(c), /多余条目/, '子目录');
});

test('SHA256SUMS 重复列出同一文件：拒绝', () => {
  const c = makeCase('dup-sums');
  const sumsPath = path.join(c.dir, 'SHA256SUMS.txt');
  const first = fs.readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean)[0];
  fs.writeFileSync(sumsPath, fs.readFileSync(sumsPath, 'utf8') + first + '\n');
  const r = run(c);
  expectFail(r, /重复列出|条目数/, '重复条目');
});

test('SHA256SUMS 里出现路径穿越名：拒绝', () => {
  const c = makeCase('traversal');
  const sumsPath = path.join(c.dir, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsPath, fs.readFileSync(sumsPath, 'utf8') +
    `${'0'.repeat(64)}  ../evil.zip\n`);
  expectFail(run(c), /可疑文件名/, '路径穿越');
});

test('哈希不匹配：拒绝', () => {
  const c = makeCase('bad-hash');
  const name = assetName('portable');
  fs.writeFileSync(path.join(c.dir, name), Buffer.alloc(110 * 1024, 'tampered'));
  expectFail(run(c), /哈希不符/, '哈希被改');
});

test('缺 Setup 资产但要求 Setup：拒绝', () => {
  const c = makeCase('setup-missing', { setup: false });
  expectFail(run(c, { requireSetup: true }), /缺资产|Setup/, '缺 setup.exe');
});

test('传了 expected-commit 却没有 report：拒绝', () => {
  const c = makeCase('no-report');
  const r = run(c, { report: '' });
  expectFail(r, /必须同时传 --report/, '没有报告');
});

test('expected-commit 不是 40 位 SHA：拒绝', () => {
  const c = makeCase('expected-bad');
  expectFail(run(c, { expectedCommit: 'abc' }), /40 位 SHA/, 'expected-commit 非法');
});
