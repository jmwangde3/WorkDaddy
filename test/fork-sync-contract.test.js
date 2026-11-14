'use strict';
/**
 * 同步结构契约（阶段 6）
 *
 *   node --test test/fork-sync-contract.test.js
 *
 * 这个文件不测业务，测的是「下次从上游同步时，哪些结构性承诺不能被合没」。
 * 上游合并最容易出的三类事故，都在这里变成断言：
 *
 *   1. 四个核心文件被上游整文件覆盖 —— 版本常量、Fork 路由分发、上游注记一起消失，
 *      但测试可能因为「新文件语法合法」而全绿。这里盯住几个必须存在的结构性标记。
 *   2. 已经搬进 src/features 的路由被「重新内联」回 daemon.js —— 冲突面积又变回 60+ 行。
 *   3. Fork 模块偷偷 require 上游脚本的内部实现 —— 上游一改名就整片崩，
 *      而且崩的时候看起来像业务 bug 而不是合并事故。
 *
 * 另外把 upstream.json 的基线结论与 git 事实对一次：文档里写的祖先关系必须真成立。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(repo, rel));
}

function git(args) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function test(name, fn) {
  try {
    fn();
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
  console.log(`ok - ${name}`);
}

// ---- 1. 四个核心文件必须还在 Fork 形态 ----

const CORE = ['daemon.js', 'inject.js', 'lib.js', 'win-launcher.js'];

test('四个核心文件都存在且是合法 JS（node --check）', () => {
  for (const name of CORE) {
    const file = path.join(repo, 'scripts', name);
    assert.ok(fs.existsSync(file), '缺核心文件：' + name);
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(res.status, 0, name + ' 语法检查失败：' + (res.stderr || ''));
  }
});

test('daemon.js 保留 Fork 版本号与构建标识', () => {
  const src = read('scripts/daemon.js');
  const m = src.match(/const DAEMON_VERSION = '([^']+)'/);
  assert.ok(m, 'daemon.js 里找不到 DAEMON_VERSION');
  // 版本号必须 ≥ 1.3.0：上游是 1.2.x，被合回 1.2.x 说明整文件被覆盖了
  const [major, minor] = m[1].split('.').map(Number);
  assert.ok(major > 1 || (major === 1 && minor >= 3), '版本号被合回上游了：' + m[1]);

  const build = src.match(/const DAEMON_BUILD_ID = '([^']+)'/);
  assert.ok(build, 'daemon.js 里找不到 DAEMON_BUILD_ID');
  assert.match(build[1], new RegExp('^release-' + m[1].replace(/\./g, '\\.') + '-'), 'BUILD_ID 应与版本号一致：' + build[1]);
});

test('daemon.js 保留上游注记（证明不是整文件覆盖）', () => {
  const src = read('scripts/daemon.js');
  // 这些是上游历史修复的注释标记，任何一个消失都说明有人拿旧版本覆盖了新版本
  for (const marker of ['1.2.69', '1.2.70']) {
    assert.ok(src.includes(marker), 'daemon.js 丢了上游 ' + marker + ' 的注记');
  }
});

// ---- 2. Fork 路由分发仍走模块，而不是内联回 daemon ----

test('daemon.js 仍通过 createForkRoutes 分发，且带 typeof 守卫', () => {
  const src = read('scripts/daemon.js');
  assert.ok(src.includes("require('../src/features/integration/fork-routes.js')"), '丢了 fork-routes 的 require');
  assert.ok(src.includes('createForkRoutes('), '丢了 createForkRoutes 调用');
  assert.ok(src.includes('FORK_NOT_HANDLED'), '丢了 NOT_HANDLED 哨兵比较');
  // 部分上游测试把 handleApi 源码切片后放进 vm 执行，上下文里没有这个函数。
  // 守卫一旦被合掉，那些测试会以 ReferenceError 失败。
  assert.match(src, /typeof handleForkRoutes === 'function'/, 'typeof 守卫被合掉了');
});

test('7 条 rehome 路由不再内联在 daemon.js', () => {
  const src = read('scripts/daemon.js');
  const hits = (src.match(/\/api\/rehome\//g) || []).length;
  assert.equal(hits, 0, 'daemon.js 里又出现了 /api/rehome/ 字面量（' + hits + ' 处），应当留在 src/features');

  const routes = read('src/features/sessions/takeover/routes.js') + read('src/features/sessions/dedupe/routes.js');
  for (const p of ['/api/rehome/status', '/api/rehome/config', '/api/rehome/run',
    '/api/rehome/dedupe', '/api/rehome/dedupe/config', '/api/rehome/dedupe/rollback', '/api/rehome/dedupe/background']) {
    assert.ok(routes.includes(p), 'src/features 里缺路由：' + p);
  }
});

test('Fork 模块只依赖 node 内置模块与相对路径', () => {
  const dir = path.join(repo, 'src', 'features');
  const files = [];
  const walk = (cur) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.name.endsWith('.js')) files.push(full);
    }
  };
  walk(dir);
  assert.ok(files.length >= 4, 'src/features 下模块太少，可能被误删：' + files.length);

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      const rel = path.relative(repo, file);
      // 相对路径：必须落在 src/features 或 node 内置里；不允许 ../../scripts/**
      if (spec.startsWith('.')) {
        assert.ok(!/scripts\//.test(spec), rel + ' 直接 require 了上游脚本：' + spec + '（上游一改名就崩）');
        continue;
      }
      assert.ok(!spec.startsWith('..'), rel + ' 用了越界相对路径：' + spec);
      assert.ok(
        ['path', 'fs', 'url', 'crypto', 'os', 'util', 'http', 'https', 'child_process'].includes(spec.replace(/^node:/, '')),
        rel + ' 依赖了非内置模块：' + spec
      );
    }
  }
});

// ---- 3. 上游基线结论与 git 事实一致 ----

test('upstream.json 的基线结论能被 git 验证', () => {
  const meta = JSON.parse(read('scripts/upstream.json'));
  assert.equal(meta.schema, 4, 'upstream.json schema 应为 4');
  assert.equal(meta.fork.baseIsUpstreamAncestor, true);
  assert.match(meta.fork.baseCommit, /^[0-9a-f]{40}$/);

  const hasUpstream = git(['rev-parse', '--verify', '--quiet', 'upstream/main']);
  if (hasUpstream.status !== 0) {
    console.log('  (skip git 校验：本地没有 upstream/main，先 git fetch upstream)');
    return;
  }

  // baseCommit 是「原始分叉点」，是历史事实，不随合并变化：
  // 它必须同时是 upstream/main 和 HEAD 的祖先。
  for (const ref of ['upstream/main', 'HEAD']) {
    const r = git(['merge-base', '--is-ancestor', meta.fork.baseCommit, ref]);
    assert.equal(r.status, 0, meta.fork.baseCommitShort + ' 不是 ' + ref + ' 的祖先，祖先关系结论失效');
  }

  // 已并入的上游提交也必须真在历史里。这条盯的是「别把合并提交 rebase 掉再骗自己」。
  if (meta.fork.mergedUpstreamCommit) {
    const r = git(['merge-base', '--is-ancestor', meta.fork.mergedUpstreamCommit, 'HEAD']);
    assert.equal(r.status, 0, '记录里已并入的 ' + meta.fork.mergedUpstreamCommit.slice(0, 7) + ' 不在 HEAD 历史里');
  }

  // 当前 merge-base 应当是「已并入的那个上游提交」；上游再往前走时它不该动，
  // 直到我们真的做下一次同步 —— 一旦不等，说明有人绕过流程合了上游。
  const base = git(['merge-base', 'HEAD', 'upstream/main']).stdout.trim();
  assert.equal(base, meta.fork.mergedUpstreamCommit, '当前 merge-base 与记录的已并入提交不一致：' + base);
});

test('代际闸门的哈希台账与磁盘文件一致', () => {
  const meta = JSON.parse(read('scripts/upstream.json'));
  const crypto = require('node:crypto');
  for (const [name, rec] of Object.entries(meta.deploy.localFileHashes || {})) {
    const file = path.join(repo, 'scripts', name);
    assert.ok(fs.existsSync(file), '台账里的文件不存在：' + name);
    const buf = fs.readFileSync(file);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    assert.equal(sha, rec.sha256, name + ' 的 localFileHashes 过期了，改过核心文件就要重算');
    assert.equal(buf.length, rec.size, name + ' 的 size 记录过期');
  }
  // 多代际：至少要覆盖 1.2.20 与 1.2.22 两代，否则老用户升级会被判成「未知代际」
  const gens = Object.keys(meta.deploy.upstreamFileHashesByVersion || {});
  assert.ok(gens.includes('1.2.20') && gens.includes('1.2.22'), '代际表缺版本：' + gens.join(','));
});

// ---- 4. 文档承诺不能悄悄消失 ----

test('同步文档存在且写明冲突规则', () => {
  assert.ok(exists('docs/upstream-tracking.md'), '缺 docs/upstream-tracking.md');
  const doc = read('docs/upstream-tracking.md');
  assert.match(doc, /四个核心文件/, '文档里应写明核心文件的合并规则');
  assert.match(doc, /禁止.*--ours|--ours.*禁止|不用 `--ours`/, '文档里应禁止 ours/theirs 批量');
  assert.match(doc, /不自动合并|不是自动 merge|人工审查/, '文档里应写明不自动合并');
});

test('迁移产物齐全（基线、盘点、导入、安装器）', () => {
  for (const rel of [
    'docs/migration/00-baseline.md',
    'docs/migration/01-repository-inventory.md',
    'docs/migration/01-file-diff.csv',
    'docs/migration/01-feature-matrix.md',
    'docs/migration/01-risk-register.md',
    'docs/migration/02-full-fork-import.md',
    'docs/migration/02-source-provenance.md',
    'docs/migration/04-installer.md',
  ]) {
    assert.ok(exists(rel), '缺迁移产物：' + rel);
  }
});

console.log('PASS fork-sync-contract.test.js');
