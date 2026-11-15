'use strict';
/**
 * build-package 的 Git 来源检查（1.3.1 RC2 阶段 2）。
 *
 * 旧的失败路径把「读不到 Git 状态」吞成 $dirty = $false，于是报告里
 * `ok=true` + `dirty=false`，校验器放行一个来源不明的包。这里用两种方式
 * 真实触发失败，都不碰本仓库的 .git：
 *   - 临时 git init 出来的假仓库（干净 / 有改动 / 不是仓库）；
 *   - PATH 前置的 git shim（rev-parse 空输出、非法 SHA、退出码 128、status 128）。
 *
 * 核心断言只有一句：Git 证据不成立时，绝不出现 ok=true 且 dirty=false。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fx = require('./helpers/installer-fixture');

const isWin = process.platform === 'win32';
const opts = isWin ? {} : { skip: '仅 Windows（打包器是 PowerShell）' };
const repoRoot = path.join(__dirname, '..');
const shimDir = path.join(__dirname, 'fixtures', 'git-shim');
const REAL_GIT = (() => {
  const r = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true });
  const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || 'git';
})();

let gitOk = true;
try {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  gitOk = probe.status === 0;
} catch (_) { gitOk = false; }
const gitOpts = (isWin && gitOk) ? {} : { skip: '需要 Windows + git' };

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return r;
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

const VERSION = '1.3.1';

/** 造一个自包含的假仓库：20+ 个安装文件 + 真实 installer 脚本。 */
function makeRepo(root) {
  const src = fx.makeSource(root, VERSION);
  const repo = path.join(root, 'pkg');
  copyTree(src, repo);
  copyTree(path.join(repoRoot, 'installer'), path.join(repo, 'installer'));
  git(repo, ['init', '-q']);
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return repo;
}

function runPackager(repo, root, tag, extraEnv = {}) {
  const out = path.join(root, 'dist-' + tag);
  const json = path.join(root, 'report-' + tag + '.json');
  const env = Object.assign({}, process.env, { TEMP: root, TMP: root }, extraEnv);
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(repo, 'installer', 'build-package.ps1'),
    '-OutputDirectory', out, '-Version', VERSION, '-Json', json,
  ], { encoding: 'utf8', timeout: 300000, env });
  let report = null;
  if (fs.existsSync(json)) {
    try { report = JSON.parse(fs.readFileSync(json, 'utf8')); } catch (_) { report = null; }
  }
  return { code: r.status, report, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function assertNeverCleanOnFailure(r, label) {
  if (r.report && r.report.ok === true && r.report.dirty === false &&
      (r.code !== 0 || r.report.gitRevParseExitCode !== 0 || r.report.gitStatusExitCode !== 0)) {
    assert.fail(`${label}：报告同时给出 ok=true / dirty=false，但 Git 证据不成立`);
  }
  assert.notEqual(r.code, 0, `${label} 必须以非零退出码失败`);
  assert.ok(r.report, `${label} 必须留下失败报告`);
  assert.equal(r.report.ok, false, `${label} 报告不能是 ok=true`);
}

test.after(() => fx.cleanup());

test('干净仓库：Commit 与工作区状态都记进报告', gitOpts, () => {
  const root = fx.tmpRoot('pkgdata-clean');
  const repo = makeRepo(root);
  const r = runPackager(repo, root, 'clean');
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.equal(r.report.ok, true);
  assert.equal(r.report.dirty, false);
  assert.equal(r.report.gitRevParseExitCode, 0);
  assert.equal(r.report.gitStatusExitCode, 0);
  assert.match(String(r.report.sourceCommit), /^[0-9a-f]{40}$/);
  assert.deepEqual(r.report.dirtyPaths, []);
});

test('有未提交改动：打包可以继续，但报告必须是 dirty=true 并列出路径', gitOpts, () => {
  const root = fx.tmpRoot('pkgdata-dirty');
  const repo = makeRepo(root);
  fs.writeFileSync(path.join(repo, 'untracked-note.txt'), 'local change\n');
  const r = runPackager(repo, root, 'dirty');
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.equal(r.report.dirty, true, '有改动时不能报 dirty=false');
  assert.ok(r.report.dirtyPaths.some((p) => p.includes('untracked-note.txt')),
    '要指出是哪个文件脏：' + JSON.stringify(r.report.dirtyPaths));
});

test('不是 Git 仓库（或 Git 顶层在别处）：必须中止', gitOpts, () => {
  const root = fx.tmpRoot('pkgdata-nogit');
  const repo = makeRepo(root);
  fs.renameSync(path.join(repo, '.git'), path.join(repo, '.git-moved'));
  const r = runPackager(repo, root, 'nogit');
  assertNeverCleanOnFailure(r, '非 Git 仓库');
  // tmp/ 在真实仓库里面：git 会向上找到父仓库并返回它的 HEAD。这同样必须拒绝，
  // 否则资产会带上一个不相干的 Commit。
  assert.match(String(r.report.error), /不是 Git 仓库顶层|无法确认源码提交/);
  assert.ok(!/^[0-9a-f]{40}$/.test(String(r.report.sourceCommit)) || r.code !== 0);
});

test('rev-parse 成功但没有输出：必须中止', gitOpts, () => {
  const root = fx.tmpRoot('pkgdata-rev-empty');
  const repo = makeRepo(root);
  const r = runPackager(repo, root, 'rev-empty', {
    PATH: shimDir + ';' + process.env.PATH, WD_GIT_MODE: 'rev-empty', WD_REAL_GIT: REAL_GIT,
  });
  assertNeverCleanOnFailure(r, 'rev-parse 空输出');
  assert.equal(r.report.gitRevParseExitCode, 0, '前置：shim 让 rev-parse 返回 0');
  assert.match(String(r.report.error), /没有输出/);
});

test('rev-parse 返回非法 SHA：必须中止', gitOpts, () => {
  const root = fx.tmpRoot('pkgdata-rev-bad');
  const repo = makeRepo(root);
  const r = runPackager(repo, root, 'rev-bad', {
    PATH: shimDir + ';' + process.env.PATH, WD_GIT_MODE: 'rev-bad', WD_REAL_GIT: REAL_GIT,
  });
  assertNeverCleanOnFailure(r, 'rev-parse 非法 SHA');
  assert.match(String(r.report.error), /40 位 SHA/);
});

test('status 失败：即使 Commit 正常也必须中止', gitOpts, () => {
  const root = fx.tmpRoot('pkgdata-status-fail');
  const repo = makeRepo(root);
  const r = runPackager(repo, root, 'status-fail', {
    PATH: shimDir + ';' + process.env.PATH, WD_GIT_MODE: 'status-fail', WD_REAL_GIT: REAL_GIT,
  });
  assertNeverCleanOnFailure(r, 'git status 失败');
  assert.equal(r.report.gitRevParseExitCode, 0, '前置：Commit 读取成功');
  assert.equal(r.report.gitStatusExitCode, 128);
  assert.match(String(r.report.error), /无法确认工作区状态/);
  assert.equal(r.report.dirty, false, '失败报告里 dirty 仍是默认值，但 ok 必须为 false');
});
