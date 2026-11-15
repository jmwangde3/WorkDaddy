#!/usr/bin/env node
'use strict';
/**
 * 发布资产校验（只读）。
 *
 * 构建由 installer/build-package.ps1 负责，本脚本只检查「打出来的东西能不能发」：
 *   1. 版本三方一致：package.json、scripts/daemon.js 的 DAEMON_VERSION、产物文件名；
 *   2. 三个正式资产齐全（Setup 用 --require-setup 强制）；
 *   3. 体积合理（拦截 0 字节 / 半截文件）；
 *   4. SHA256SUMS.txt 覆盖目录里每一个资产，且每条哈希当场重算；
 *   5. 目录里没有与本次版本无关的产物（防混进上一轮构建）。
 *
 * 发布流程和 CI 用同一份逻辑，避免 YAML 里再抄一遍校验规则。
 *
 * 用法：
 *   node tools/verify-release-assets.js --dir release\dist
 *   node tools/verify-release-assets.js --dir tmp\dist --require-setup --report tmp\dist\report.json
 * 退出码：0 通过 / 1 校验失败 / 2 参数或环境问题
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.join(__dirname, '..');
const MIN_ASSET_BYTES = 100 * 1024;

function parseArgs(argv) {
  const out = { dir: '', version: '', requireSetup: false, report: '', json: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i] || '';
    else if (a === '--version') out.version = argv[++i] || '';
    else if (a === '--require-setup') out.requireSetup = true;
    else if (a === '--report') out.report = argv[++i] || '';
    else if (a === '--json') out.json = argv[++i] || '';
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

function readRepoVersions() {
  const daemonSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'daemon.js'), 'utf8');
  const daemon = (daemonSrc.match(/DAEMON_VERSION\s*=\s*'([^']+)'/) || [])[1] || '';
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return { daemon, package: String(pkg.version || '') };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verify(opts) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);

  const dir = opts.dir ? path.resolve(opts.dir) : '';
  if (!dir) throw Object.assign(new Error('缺少 --dir'), { code: 2 });
  if (!fs.existsSync(dir)) throw Object.assign(new Error(`目录不存在：${dir}`), { code: 2 });

  const versions = readRepoVersions();
  if (!versions.daemon) fail('scripts/daemon.js 里找不到 DAEMON_VERSION');
  if (versions.daemon && versions.package && versions.daemon !== versions.package) {
    fail(`DAEMON_VERSION 与 package.json 版本不一致：daemon=${versions.daemon} package=${versions.package}`);
  }
  const version = String(opts.version || versions.daemon || versions.package || '');
  if (!version) fail('拿不到版本号');
  if (opts.version && versions.daemon && opts.version !== versions.daemon) {
    fail(`--version 与 DAEMON_VERSION 不一致：${opts.version} / ${versions.daemon}`);
  }

  // 打包报告：确认 build-package 自己认为成功、且工作区干净。
  if (opts.report) {
    const reportPath = path.resolve(opts.report);
    if (!fs.existsSync(reportPath)) {
      fail(`找不到打包报告：${reportPath}`);
    } else {
      let report = null;
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (error) {
        fail(`打包报告不是合法 JSON：${error.message}`);
      }
      if (report) {
        if (report.ok !== true) fail('打包报告 ok != true');
        if (version && report.version !== version) fail(`打包报告版本 ${report.version} 与期望 ${version} 不一致`);
        if (opts.requireSetup && report.setup !== 'built') fail(`Setup 没有编译成功：${report.setup}`);
        if (report.dirty) {
          const detail = Array.isArray(report.dirtyPaths) && report.dirtyPaths.length
            ? `（${report.dirtyPaths.slice(0, 5).join(' | ')}）`
            : '';
          fail(`打包时工作区不干净${detail}：发布资产必须来自干净提交`);
        }
      }
    }
  }

  const required = [
    `WorkDaddy-${version}-portable-win-x64.zip`,
    `WorkDaddy-${version}-source.zip`,
  ];
  if (opts.requireSetup) required.push(`WorkDaddy-${version}-setup.exe`);

  const assets = [];
  for (const name of required) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { fail(`缺资产：${name}`); continue; }
    const size = fs.statSync(file).size;
    if (size < MIN_ASSET_BYTES) fail(`资产体积异常：${name} = ${size} 字节`);
    assets.push({ name, size, sha256: sha256(file) });
  }

  const sumsPath = path.join(dir, 'SHA256SUMS.txt');
  const listed = [];
  if (!fs.existsSync(sumsPath)) {
    fail('没有 SHA256SUMS.txt');
  } else {
    const lines = fs.readFileSync(sumsPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) fail('SHA256SUMS.txt 是空的');
    for (const line of lines) {
      const m = line.match(/^([0-9a-fA-F]{64})\s{1,2}(.+)$/);
      if (!m) { fail(`SHA256SUMS 行格式不对：${line}`); continue; }
      const expect = m[1].toLowerCase();
      const name = m[2].trim();
      listed.push(name);
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) { fail(`SHA256SUMS 列了不存在的文件：${name}`); continue; }
      const actual = sha256(file);
      if (actual !== expect) fail(`哈希不符：${name}（清单 ${expect} / 实算 ${actual}）`);
    }
    // 反向覆盖：目录里每个资产都要在清单里，否则「校验和」可以被绕过。
    const onDisk = fs.readdirSync(dir).filter((n) => n !== 'SHA256SUMS.txt');
    for (const name of onDisk) {
      if (!listed.includes(name)) fail(`资产没被 SHA256SUMS 覆盖：${name}`);
      if (version && !name.startsWith(`WorkDaddy-${version}-`)) {
        fail(`存在与本次版本无关的产物：${name}`);
      }
    }
    if (onDisk.length !== listed.length) {
      warnings.push(`目录里 ${onDisk.length} 个文件，清单 ${listed.length} 条`);
    }
  }

  return {
    ok: errors.length === 0,
    version,
    daemonVersion: versions.daemon,
    packageVersion: versions.package,
    dir,
    requireSetup: opts.requireSetup,
    assets,
    listed,
    errors,
    warnings,
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write('用法：node tools/verify-release-assets.js --dir <dist> [--require-setup] [--report <json>] [--json <out>]\n');
    process.exit(0);
  }

  let result;
  try {
    result = verify(opts);
  } catch (error) {
    process.stderr.write(`发布资产校验无法执行：${error.message}\n`);
    process.exit(error.code === 2 ? 2 : 1);
  }

  for (const a of result.assets) {
    process.stdout.write(`  ✓ ${a.name}  ${a.size} 字节  ${a.sha256}\n`);
  }
  for (const w of result.warnings) process.stdout.write(`  提示：${w}\n`);
  if (!result.ok) {
    for (const e of result.errors) process.stderr.write(`  ✗ ${e}\n`);
    process.stderr.write(`发布资产校验失败：${result.errors.length} 项\n`);
  } else {
    process.stdout.write(`发布资产校验通过：版本 ${result.version}，${result.assets.length} 个资产，哈希逐条重算一致\n`);
  }
  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify(result, null, 2) + '\n', 'utf8');
  }
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { verify, readRepoVersions };
