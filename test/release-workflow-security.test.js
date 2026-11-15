'use strict';
/**
 * Release workflow 的输入注入防护回归。
 *
 * 分两层：
 *   1. 功能层：直接跑 tools/release-input.js（工作流用的同一份实现），
 *      合法输入通过、非法输入被拒；CLI 与函数两条路径都测。
 *   2. 结构层：解析 .github/workflows/release.yml 的每个 `run:` 块，
 *      断言里面没有 `${{ ... }}` 插值 —— 所有动态值只能走 `env:`。
 *      扫描是通用的（按缩进切块），行号变了也不会失效。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  ReleaseInputError,
  planRelease,
  validateCommit,
  validateTag,
  validateVersion,
} = require('../tools/release-input.js');

const repo = path.join(__dirname, '..');
const workflowPath = path.join(repo, '.github', 'workflows', 'release.yml');
const validatorPath = path.join(repo, 'tools', 'release-input.js');
const workflow = fs.readFileSync(workflowPath, 'utf8');

// ---- YAML 轻解析：只做本次断言需要的两件事 ----

/** 所有 `run:` 块（含单行写法），返回 { line, body }。 */
function collectRunBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[2].trim();
    if (/^[|>][+-]?$/.test(rest)) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() === '') { body.push(''); continue; }
        if (lines[j].match(/^\s*/)[0].length <= indent) break;
        body.push(lines[j]);
      }
      blocks.push({ line: i + 1, body: body.join('\n') });
      i = j - 1;
    } else if (rest) {
      blocks.push({ line: i + 1, body: rest });
    }
  }
  return blocks;
}

/** 按 `- name:` 切出每一步的原文，便于断言「这一步的 env 有没有传值」。 */
function collectSteps(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^ {6}- name:\s*(.+?)\s*$/);
    if (m) {
      if (current) steps.push(current);
      current = { name: m[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) steps.push(current);
  return steps.map((s) => ({ name: s.name, chunk: s.lines.join('\n') }));
}

function step(name) {
  const found = collectSteps(workflow).find((s) => s.name === name);
  assert.ok(found, `workflow 里找不到步骤：${name}`);
  return found.chunk;
}

const runBlocks = collectRunBlocks(workflow);

test('workflow 能被解析出 run 块（扫描本身有效）', () => {
  assert.ok(runBlocks.length >= 8, `run 块数量异常：${runBlocks.length}`);
  assert.ok(runBlocks.some((b) => b.body.includes('build-package.ps1')), '没扫到打包步骤');
  assert.ok(runBlocks.some((b) => b.body.includes('gh release')), '没扫到发布步骤');
});

test('所有 run 块都不含 GitHub 表达式插值（防注入核心断言）', () => {
  const offenders = runBlocks
    .filter((b) => b.body.includes('${{'))
    .map((b) => `第 ${b.line} 行起的 run 块：${b.body.split('\n').find((l) => l.includes('${{')).trim()}`);
  assert.deepEqual(offenders, [], `这些 run 块仍在拼接表达式，必须改成 env 传值：\n${offenders.join('\n')}`);
});

test('run 块里不出现外部输入的具体路径（inputs / steps / needs outputs）', () => {
  const patterns = [
    /github\.event\.inputs\./,
    /steps\.[A-Za-z0-9_-]+\.outputs\./,
    /needs\.[A-Za-z0-9_-]+\.outputs\./,
  ];
  const hits = [];
  for (const block of runBlocks) {
    for (const p of patterns) {
      if (p.test(block.body)) hits.push(`第 ${block.line} 行：${block.body.split('\n').find((l) => p.test(l)).trim()}`);
    }
  }
  assert.deepEqual(hits, [], `run 块里仍有直接引用：\n${hits.join('\n')}`);
});

test('输入校验器确实被工作流调用，且先于 git 解析', () => {
  const validateStep = step('严格校验输入（版本 / tag / commit）');
  assert.match(validateStep, /release-input\.js/);
  assert.match(validateStep, /--mode \$env:WD_MODE/);
  assert.match(validateStep, /--github-output \$env:GITHUB_OUTPUT/);

  const order = workflow.indexOf('id: input');
  const target = workflow.indexOf('id: target');
  assert.ok(order > 0 && target > order, '输入校验必须排在目标解析之前');
});

test('合法版本号通过', () => {
  for (const v of ['1.3.1', '1.3.2', '1.3.1-rc.1', '1.3.1-beta', '1.3.1-preview.2', '0.0.1']) {
    assert.equal(validateVersion(v), v);
  }
});

test('非法版本号被拒绝（含 PowerShell 注入串）', () => {
  const bad = [
    '',
    'v1.3.1',
    'V1.3.1',
    '1.3',
    '1.3.1.2',
    '1.3.1/evil',
    '1.3.1;command',
    "1.3.1'",
    '1.3.1"',
    '1.3.1$(whoami)',
    '1.3.1`id`',
    '1.3.1\r\n',
    '1.3.1\nWrite-Output pwned',
    '1.3.1 ',
    ' 1.3.1',
    '1.3.1-',
    '1.3.1-rc..1',
    "1.3.1'; Write-Output pwned; '",
  ];
  for (const v of bad) {
    assert.throws(() => validateVersion(v), ReleaseInputError, `应当拒绝：${JSON.stringify(v)}`);
  }
});

test('commit 必须是完整 40 位十六进制，并规范化成小写', () => {
  const lower = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(validateCommit(lower), lower);
  assert.equal(validateCommit(lower.toUpperCase()), lower);
  for (const bad of ['', 'abc', lower.slice(0, 39), `${lower}0`, `${lower.slice(0, 39)}g`, ` ${lower}`, `${lower}\n`]) {
    assert.throws(() => validateCommit(bad), ReleaseInputError, `应当拒绝：${JSON.stringify(bad)}`);
  }
});

test('tag 与版本同规则，且拒绝 v 前缀与路径分隔符', () => {
  assert.equal(validateTag('1.3.1'), '1.3.1');
  assert.equal(validateTag('1.3.1-rc.1'), '1.3.1-rc.1');
  for (const bad of ['', 'v1.3.1', '1.3', '1.3.1/x', 'refs/tags/1.3.1', '1.3.1;id', '1.3.1 1.3.2']) {
    assert.throws(() => validateTag(bad), ReleaseInputError, `应当拒绝：${JSON.stringify(bad)}`);
  }
});

test('build-only 需要 version + commit，且不需要 tag', () => {
  const commit = 'a'.repeat(40);
  assert.deepEqual(planRelease({ mode: 'build-only', version: '1.3.1', commit }), {
    mode: 'build-only', version: '1.3.1', commit,
  });
  assert.throws(() => planRelease({ mode: 'build-only', version: '', commit }), ReleaseInputError);
  assert.throws(() => planRelease({ mode: 'build-only', version: '1.3.1', commit: '' }), ReleaseInputError);
  assert.throws(() => planRelease({ mode: 'build-only', version: '1.3.1', commit: 'abc' }), ReleaseInputError);
});

test('publish 用 tag 当版本，缺 tag 或 tag 非法都拒绝', () => {
  assert.deepEqual(planRelease({ mode: 'publish', tag: '1.3.1' }), {
    mode: 'publish', version: '1.3.1', tag: '1.3.1',
  });
  assert.throws(() => planRelease({ mode: 'publish', tag: '' }), ReleaseInputError);
  assert.throws(() => planRelease({ mode: 'publish', tag: 'v1.3.1' }), ReleaseInputError);
});

// ---- CLI：工作流跑的就是这条路径 ----

const tmpBase = path.join(repo, 'tmp');
const cliOutputFile = path.join(tmpBase, `release-input-output-${process.pid}.txt`);

function runCli(mode, env) {
  const args = [validatorPath, '--mode', mode];
  const useOutput = Object.prototype.hasOwnProperty.call(env, 'GITHUB_OUTPUT');
  if (useOutput) args.push('--github-output', env.GITHUB_OUTPUT);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, WD_VERSION: '', WD_COMMIT: '', WD_TAG: '', ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('CLI：build-only 合法输入通过并写出 GITHUB_OUTPUT', () => {
  fs.mkdirSync(tmpBase, { recursive: true });
  fs.rmSync(cliOutputFile, { force: true });
  const commit = '0123456789ABCDEF0123456789abcdef01234567';
  const r = runCli('build-only', { WD_VERSION: '1.3.1', WD_COMMIT: commit, GITHUB_OUTPUT: cliOutputFile });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mode=build-only/);
  assert.match(r.stdout, /version=1\.3\.1/);
  const written = fs.readFileSync(cliOutputFile, 'utf8');
  assert.match(written, /version=1\.3\.1/);
  assert.match(written, /commit=0123456789abcdef0123456789abcdef01234567/, '写进 output 的必须是规范化后的小写');
  fs.rmSync(cliOutputFile, { force: true });
});

test('CLI：build-only 缺 commit / 版本非法 / 注入串一律退出码 1', () => {
  const cases = [
    { WD_VERSION: '1.3.1', WD_COMMIT: '' },
    { WD_VERSION: '1.3.1', WD_COMMIT: 'abc' },
    { WD_VERSION: 'v1.3.1', WD_COMMIT: '0'.repeat(40) },
    { WD_VERSION: "1.3.1'; Write-Output pwned; '", WD_COMMIT: '0'.repeat(40) },
    { WD_VERSION: '1.3.1`id`', WD_COMMIT: '0'.repeat(40) },
  ];
  for (const env of cases) {
    const r = runCli('build-only', env);
    assert.equal(r.code, 1, `应当拒绝：${JSON.stringify(env)}（stdout=${r.stdout}）`);
    assert.match(r.stderr, /\[release-input\]/);
  }
});

test('CLI：publish 接受正常 tag，拒绝 v 前缀与空值', () => {
  const ok = runCli('publish', { WD_TAG: '1.3.1-rc.1' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /version=1\.3\.1-rc\.1/);
  for (const env of [{ WD_TAG: '' }, { WD_TAG: 'v1.3.1' }, { WD_TAG: '1.3.1;id' }]) {
    assert.equal(runCli('publish', env).code, 1, `应当拒绝：${JSON.stringify(env)}`);
  }
});

// ---- 结构层：权限与闸门 ----

test('顶层与 build job 只读，publish job 才拿写权限', () => {
  const top = workflow.slice(0, workflow.indexOf('jobs:'));
  assert.match(top, /^permissions:\n {2}contents: read$/m, '顶层必须是 contents: read');
  const buildJob = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  publish:'));
  assert.match(buildJob, /^ {4}permissions:\n {6}contents: read$/m, 'build job 必须只读');
  const publishJob = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publishJob, /^ {4}permissions:\n {6}contents: write$/m, 'publish job 需要写权限');
  assert.doesNotMatch(top, /contents: write/, '顶层不能出现写权限');
});

test('build_only 时 publish job 整体跳过，覆盖发布默认关闭', () => {
  const publishJob = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publishJob, /if: \$\{\{ github\.event\.inputs\.build_only != 'true' \}\}/);
  assert.match(workflow, /allow_overwrite:[\s\S]*?default: 'false'/);
  assert.match(publishJob, /gh release view \$tag/);
  assert.match(publishJob, /if \(-not \$allowOverwrite\)/, '默认必须拒绝覆盖');
  assert.match(publishJob, /ALLOW_OVERWRITE: \$\{\{ env\.WD_ALLOW_OVERWRITE \}\}/);
});

test('tag 必须先过 check-ref-format，再 rev-parse 取提交', () => {
  const chunk = step('解析并校验目标（tag / commit）');
  const refCheck = chunk.indexOf('git check-ref-format');
  const resolve = chunk.indexOf('git rev-parse --verify');
  assert.ok(refCheck > 0, '缺 git check-ref-format');
  assert.ok(resolve > refCheck, 'rev-parse 必须在 ref 格式校验之后');
  assert.match(chunk, /refs\/tags\/\$tag\^\{commit\}/);
});

test('打包与资产校验步骤通过 env 取版本与提交，不拼字符串', () => {
  const pack = step('打包（便携版 + 源码包 + Setup）');
  assert.match(pack, /TARGET_VERSION: \$\{\{ steps\.target\.outputs\.version \}\}/);
  assert.match(pack, /-Version \$env:TARGET_VERSION/);

  const verify = step('校验资产（来源 + 白名单 + 哈希）');
  assert.match(verify, /TARGET_VERSION: \$\{\{ steps\.target\.outputs\.version \}\}/);
  assert.match(verify, /TARGET_COMMIT: \$\{\{ steps\.target\.outputs\.commit \}\}/);
  assert.match(verify, /--version \$env:TARGET_VERSION/);
  assert.match(verify, /--expected-commit \$env:TARGET_COMMIT/);

  const versionCheck = step('版本一致性（版本 = DAEMON_VERSION = package.json）');
  assert.match(versionCheck, /TARGET_VERSION: \$\{\{ steps\.target\.outputs\.version \}\}/);
  assert.match(versionCheck, /\$version = \$env:TARGET_VERSION/);
});
