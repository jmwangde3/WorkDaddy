'use strict';
/**
 * git 的假实现（仅用于 build-package 的故障注入测试，阶段 2）。
 *
 * 通过 WD_GIT_MODE 控制 rev-parse / status 的行为，默认转发给真实 git
 * （路径由 WD_REAL_GIT 指定）。这样「git 查询失败」可以在不破坏任何 .git
 * 目录的前提下被真实触发。
 */
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const mode = String(process.env.WD_GIT_MODE || 'passthrough');

// build-package 会带 `-C <repo>` 前缀，找子命令时跳过它的参数。
let sub = '';
let repoDir = '';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-C') { repoDir = args[i + 1] || ''; i += 1; continue; }
  if (!args[i].startsWith('-')) { sub = args[i]; break; }
}

const FAKE_SHA = '0123456789abcdef0123456789abcdef01234567';

// 顶层目录必须如实回答，否则测试会撞上「顶层不是本仓库」而掩盖真正的失败点。
if (sub === 'rev-parse' && args.includes('--show-toplevel')) {
  process.stdout.write((repoDir || process.cwd()) + '\n');
  process.exit(0);
}
// --show-prefix 在仓库顶层输出空行；这里统一按「是顶层」回答。
if (sub === 'rev-parse' && args.includes('--show-prefix')) {
  process.stdout.write('\n');
  process.exit(0);
}

if (sub === 'rev-parse') {
  if (mode === 'rev-empty') { process.exit(0); }                         // 成功但没有输出
  if (mode === 'rev-bad') { process.stdout.write('not-a-sha\n'); process.exit(0); }
  if (mode === 'rev-fail') {
    process.stderr.write('fatal: not a git repository (simulated)\n');
    process.exit(128);
  }
  if (mode === 'status-fail') { process.stdout.write(FAKE_SHA + '\n'); process.exit(0); }
}
if (sub === 'status' && mode === 'status-fail') {
  process.stderr.write('fatal: this operation must be run in a work tree (simulated)\n');
  process.exit(128);
}

const real = String(process.env.WD_REAL_GIT || 'git');
const r = spawnSync(real, args, { stdio: 'inherit', windowsHide: true });
process.exit(Number.isInteger(r.status) ? r.status : 1);
