#!/usr/bin/env node
/**
 * 阶段 1 只读盘点：把「上游 / 分叉 / 共同祖先」三棵树逐文件比对，产出可审查的分类表。
 *
 * 用法：
 *   node tools/migration/inventory.js [--base <rev>] [--fork <rev>] [--upstream <rev>] [--out docs/migration]
 *
 * 只读：只调用 `git ls-tree` / `git cat-file` / `git log`，不写仓库（除了 --out 指定的报告）。
 *
 * 分类（以 merge-base 为基准，分别看两侧有没有动过）：
 *   A 两侧都没动            → 直接保留上游实现
 *   B 只有分叉改了          → 保留分叉实现，但要用上游基线校验没被整文件覆盖
 *   C 只有分叉新增          → 保留
 *   D 只有分叉删除          → 保留删除（需说明理由）
 *   E 两侧都改了            → 必须逐文件手工合并
 *   F 只有上游改了 / 新增   → 采纳上游版本
 *   G 无法判定（改名、二进制、来源不明） → 暂停迁移，单独确认
 */
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, ...opts });
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const REV_FORK = arg('fork', 'HEAD');
const REV_UPSTREAM = arg('upstream', 'upstream/main');
const OUT_DIR = path.resolve(ROOT, arg('out', 'docs/migration'));

const revBase = (() => {
  const explicit = arg('base', null);
  if (explicit) return explicit;
  try {
    return git(['merge-base', REV_FORK, REV_UPSTREAM], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

/** rev -> Map(path -> {mode, sha, size, binary}) */
function treeOf(rev) {
  if (!rev) return new Map();
  const raw = git(['ls-tree', '-r', '-l', rev], { encoding: 'utf8' });
  const map = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    // <mode> SP <type> SP <sha> SP* <size> TAB <path>
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\s+(\d+|-)\t(.*)$/.exec(line);
    if (!m) continue;
    const [, mode, type, sha, size, p] = m;
    if (type !== 'blob') continue;
    map.set(p, { mode, sha, size: size === '-' ? null : Number(size), binary: false });
  }
  return map;
}

function blobInfo(sha) {
  const buf = git(['cat-file', 'blob', sha]);
  const binary = buf.includes(0);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, binary };
}

function short(rev) {
  try {
    return git(['rev-parse', '--short=7', rev], { encoding: 'utf8' }).trim();
  } catch {
    return rev;
  }
}

function describeRev(rev) {
  if (!rev) return { rev: null, short: null, date: null, subject: null };
  const meta = git(['log', '-1', '--format=%H%x00%ad%x00%s', '--date=short', rev], { encoding: 'utf8' })
    .trim()
    .split('\0');
  return { rev: meta[0], short: meta[0].slice(0, 7), date: meta[1], subject: meta[2] };
}

/** 这条路径在分叉侧被哪些提交动过（只取分叉自己的提交）。 */
function forkCommitsFor(p) {
  try {
    const raw = git(['log', '--format=%h %s', `${revBase}..${REV_FORK}`, '--', p], { encoding: 'utf8' });
    return raw.trim() ? raw.trim().split('\n') : [];
  } catch {
    return [];
  }
}

function upstreamCommitsFor(p) {
  try {
    const raw = git(['log', '--format=%h %s', `${revBase}..${REV_UPSTREAM}`, '--', p], { encoding: 'utf8' });
    return raw.trim() ? raw.trim().split('\n') : [];
  } catch {
    return [];
  }
}

/** 核心运行时文件：整文件覆盖会直接改变线上行为，风险最高。 */
const CORE = new Set([
  'scripts/daemon.js',
  'scripts/inject.js',
  'scripts/lib.js',
  'scripts/win-launcher.js',
  'scripts/session-pin-sync.js',
  'scripts/renderer-api-bridge.js',
  'scripts/workbuddy-compat.js',
  'scripts/cdp-targets.js',
  'scripts/session-dedupe.js',
  'scripts/session-scope.js',
  'scripts/rehome-sessions.js',
  'scripts/rehome-watcher.js',
  'scripts/rehome-audit.js',
  'scripts/permission-sync.js',
  'scripts/upstream.json',
  'deploy.ps1',
  'deploy.cmd',
  'package.json',
]);

const DATA_DANGER = new Set([
  'scripts/session-dedupe.js',
  'scripts/session-scope.js',
  'scripts/rehome-sessions.js',
  'scripts/rehome-watcher.js',
  'scripts/rehome-audit.js',
  'scripts/permission-sync.js',
]);

const INSTALLER = /(^installer\/)|(^scripts\/(install|uninstall|Install|Uninstall|build-win|apply-update|make-setup|launcher|Start-|Stop-))|(^deploy\.)/;

function classify(base, fork, up, p) {
  const b = base.get(p);
  const f = fork.get(p);
  const u = up.get(p);
  const same = (x, y) => x && y && x.sha === y.sha;

  if (b) {
    if (f && u) {
      if (same(f, u)) return 'A';
      const forkChanged = !same(f, b);
      const upChanged = !same(u, b);
      if (forkChanged && upChanged) return 'E';
      if (forkChanged) return 'B';
      if (upChanged) return 'F';
      return 'A';
    }
    if (f && !u) return 'D'; // 分叉保留、上游删了
    if (!f && u) return 'F'; // 上游保留、分叉删了（罕见，按上游处理前需确认）
    return 'D';
  }
  // 基线里没有
  if (f && u) return same(f, u) ? 'A' : 'G'; // 两侧各自新增同一路径但内容不同
  if (f) return 'C';
  if (u) return 'F';
  return 'G';
}

function methodOf(kind, p) {
  switch (kind) {
    case 'A':
      return 'keep-upstream';
    case 'B':
      return 'keep-fork';
    case 'C':
      return 'keep-fork';
    case 'D':
      return 'keep-fork-deletion';
    case 'E':
      return 'manual-merge';
    case 'F':
      return 'take-upstream';
    default:
      return 'hold-for-review';
  }
}

function riskOf(kind, p, binary) {
  if (kind === 'G') return 'unknown';
  if (CORE.has(p) || DATA_DANGER.has(p)) return 'high';
  if (kind === 'E') return 'high';
  if (binary) return 'medium';
  if (INSTALLER.test(p)) return 'high';
  if (/^test\//.test(p)) return 'low';
  if (/^(docs\/|.*\.md$)/.test(p)) return 'low';
  if (/^\.github\//.test(p)) return 'medium';
  return 'medium';
}

function testRequirement(kind, p) {
  if (/^test\//.test(p)) return kind === 'E' ? '合并后重跑该测试文件，并确认基线未扩大' : '保留原测试';
  if (DATA_DANGER.has(p)) return '必须补会话序列顺序 / 写入范围阻断的回归测试';
  if (p === 'deploy.ps1' || p === 'scripts/upstream.json') return '部署安全测试（含代际闸门与回滚）';
  if (p === 'scripts/daemon.js' || p === 'scripts/inject.js') return '守护进程启动 / UI 注入冒烟测试';
  if (INSTALLER.test(p)) return '安装器测试（临时目录）';
  if (/\.(cs)$/.test(p)) return '托盘构建与启动冒烟测试';
  if (kind === 'E') return '合并后全量回归';
  return '沿用现有测试';
}

function depsOf(p) {
  // 只做静态提示：谁 require/引用了这个文件，用来判断改动波及面。
  const base = path.basename(p);
  if (/^scripts\//.test(p)) return 'daemon/inject 运行时';
  if (/^test\//.test(p)) return 'node:test';
  if (/^tray\//.test(p)) return 'Windows .NET + CDP';
  if (/^\.github\//.test(p)) return 'GitHub Actions';
  if (/^docs\//.test(p) || /\.md$/.test(p)) return '—';
  return '—';
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main() {
  const base = treeOf(revBase);
  const fork = treeOf(REV_FORK);
  const up = treeOf(REV_UPSTREAM);
  const allPaths = Array.from(new Set([...base.keys(), ...fork.keys(), ...up.keys()])).sort();

  const rows = [];
  for (const p of allPaths) {
    const kind = classify(base, fork, up, p);
    const f = fork.get(p);
    const u = up.get(p);
    const b = base.get(p);
    const fInfo = f ? blobInfo(f.sha) : null;
    const uInfo = u ? blobInfo(u.sha) : null;
    const binary = Boolean((fInfo && fInfo.binary) || (uInfo && uInfo.binary));
    const deltaBytes = fInfo && uInfo ? fInfo.size - uInfo.size : (fInfo ? fInfo.size : (uInfo ? -uInfo.size : 0));
    const forkTouched = kind === 'B' || kind === 'C' || kind === 'E' || kind === 'D' ? forkCommitsFor(p) : [];
    const upTouched = kind === 'E' || kind === 'F' ? upstreamCommitsFor(p) : [];
    rows.push({
      path: p,
      kind,
      base: b ? b.sha.slice(0, 7) : '',
      baseSize: b ? b.size : null,
      upstream: u ? u.sha.slice(0, 7) : '',
      upstreamSize: uInfo ? uInfo.size : null,
      upstreamSha256: uInfo ? uInfo.sha256 : '',
      fork: f ? f.sha.slice(0, 7) : '',
      forkSize: fInfo ? fInfo.size : null,
      forkSha256: fInfo ? fInfo.sha256 : '',
      deltaBytes,
      modifiedFunctionally: kind === 'E' || kind === 'B' || kind === 'C' ? 'yes' : kind === 'A' ? 'no' : 'unknown',
      deps: depsOf(p),
      method: methodOf(kind, p),
      test: testRequirement(kind, p),
      risk: riskOf(kind, p, binary),
      binary,
      forkTouched,
      upTouched,
    });
  }

  const counts = rows.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {});
  const riskCounts = rows.reduce((acc, r) => ((acc[r.risk] = (acc[r.risk] || 0) + 1), acc), {});
  const meta = {
    generatedAt: new Date().toISOString(),
    base: describeRev(revBase),
    fork: describeRev(REV_FORK),
    upstream: describeRev(REV_UPSTREAM),
    counts,
    riskCounts,
    totals: { base: base.size, fork: fork.size, upstream: up.size, union: allPaths.length },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const header = [
    'relative_path',
    'class',
    'base_sha',
    'base_size',
    'upstream_sha',
    'upstream_size',
    'upstream_sha256',
    'fork_sha',
    'fork_size',
    'fork_sha256',
    'delta_bytes_fork_minus_upstream',
    'functional_change',
    'depends_on',
    'migration_method',
    'test_requirement',
    'risk',
    'binary',
    'fork_commits',
    'upstream_commits',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.path,
        r.kind,
        r.base,
        r.baseSize,
        r.upstream,
        r.upstreamSize,
        r.upstreamSha256,
        r.fork,
        r.forkSize,
        r.forkSha256,
        r.deltaBytes,
        r.modifiedFunctionally,
        r.deps,
        r.method,
        r.test,
        r.risk,
        r.binary ? 'yes' : 'no',
        r.forkTouched.join(' | '),
        r.upTouched.join(' | '),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  fs.writeFileSync(path.join(OUT_DIR, '01-file-diff.csv'), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(
    path.join(OUT_DIR, '01-inventory.json'),
    JSON.stringify({ meta, rows: rows.map(({ forkTouched, upTouched, ...rest }) => rest) }, null, 2) + '\n',
    'utf8'
  );

  console.log(JSON.stringify(meta, null, 2));
  console.log(`\nCSV: ${path.join(OUT_DIR, '01-file-diff.csv')}`);
  const conflicts = rows.filter((r) => r.kind === 'E' || r.kind === 'G');
  console.log(`需手工合并 ${counts.E || 0} 个；无法判定 ${counts.G || 0} 个`);
  for (const c of conflicts) console.log(`  [${c.kind}] ${c.path}  (risk=${c.risk})`);
}

main();
