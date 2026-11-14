'use strict';
/**
 * deploy.ps1 原子部署回归测试（P1）
 *
 *   node --test test/deploy-safety.test.js
 *
 * 只在 Windows 上执行；所有目标目录都在临时目录内，不碰真实安装。
 * 覆盖：预检零写入、版本不匹配中止、目标缺失中止、本机配置不被覆盖、
 *       替换中途失败自动回滚、部署报告生成。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const repo = path.join(__dirname, '..');
const deploy = path.join(repo, 'deploy.ps1');
const srcScripts = path.join(repo, 'scripts');
const roots = [];

function tmpRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wd-deploy-${tag}-`));
  roots.push(d);
  return d;
}

function runDeploy(args) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', deploy, ...args,
  ], { encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** 造一个「已安装 WorkDaddy」的最小目录。 */
function makeTarget(tag, opts = {}) {
  const root = tmpRoot(tag);
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  if (opts.pristineSize) {
    // 模拟「未经我们打过补丁的原版上游文件」：字节数与上游 1.2.22 完全一致。
    const head = "var DAEMON_VERSION = '1.2.22';\n";
    const pad = '//' + 'x'.repeat(Math.max(0, opts.pristineSize - head.length - 3)) + '\n';
    fs.writeFileSync(path.join(scripts, 'daemon.js'), head + pad);
  } else {
    let daemon = fs.readFileSync(path.join(srcScripts, 'daemon.js'), 'utf8');
    if (opts.version) daemon = daemon.replace(/DAEMON_VERSION = '[^']*'/, `DAEMON_VERSION = '${opts.version}'`);
    fs.writeFileSync(path.join(scripts, 'daemon.js'), daemon);
  }
  if (opts.exeCfg) {
    fs.writeFileSync(path.join(scripts, 'workbuddy-exe.json'), JSON.stringify({ path: opts.exeCfg }));
  }
  return { root, scripts };
}

function test(name, fn) {
  if (!isWin) {
    console.log(`SKIP ${name} (非 Windows)`);
    return;
  }
  fn();
  console.log(`ok - ${name}`);
}

function main() {
  assert.ok(fs.existsSync(deploy), 'deploy.ps1 存在');

  test('预检模式不写任何文件', () => {
    const { scripts } = makeTarget('dry');
    const before = fs.readdirSync(scripts).sort();
    const r = runDeploy(['-TargetDir', scripts, '-DryRun']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(fs.readdirSync(scripts).sort(), before, '预检不得新增文件');
    assert.match(r.out, /预检模式/);
  });

  test('目标版本更新时只提示，不阻断（advisory 默认）', () => {
    const { scripts } = makeTarget('newer', { version: '9.9.9' });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /advisory/i, '必须明确告诉用户这只是提示');
  });

  test('目标版本更新 + -StrictVersionGate 时中止（退出码 2）', () => {
    const { scripts } = makeTarget('newer-strict', { version: '9.9.9' });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun', '-StrictVersionGate']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /比补丁/);
  });

  test('目标是原版上游文件时代际闸门中止（退出码 2）', () => {
    // 749088 = 上游 1.2.22 的 daemon.js 实测字节数（upstream.json）
    const { scripts } = makeTarget('pristine', { pristineSize: 749088 });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /原版上游/, '必须说明拦的是「无补丁的更新版上游文件」');
  });

  test('代际闸门可被 -Force 越过', () => {
    const { scripts } = makeTarget('pristine-force', { pristineSize: 749088 });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun', '-Force']);
    assert.equal(r.code, 0, r.out);
  });

  test('目标缺少 daemon.js 时中止（退出码 1）', () => {
    const root = tmpRoot('empty');
    const scripts = path.join(root, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun']);
    assert.equal(r.code, 1, r.out);
  });

  test('真实部署：本机 EXE 配置不被覆盖', () => {
    const custom = 'D:\\MyBuddy\\WorkBuddy.exe';
    const { scripts } = makeTarget('real', { version: '1.2.80', exeCfg: custom });
    const r = runDeploy(['-TargetDir', scripts, '-NoRestart']);
    assert.equal(r.code, 0, r.out);
    const cfg = JSON.parse(fs.readFileSync(path.join(scripts, 'workbuddy-exe.json'), 'utf8'));
    assert.equal(cfg.path, custom, '用户已有 workbuddy-exe.json 必须原样保留');
    for (const f of ['session-dedupe.js', 'session-scope.js', 'permission-sync.js', 'upstream.json']) {
      assert.ok(fs.existsSync(path.join(scripts, f)), `新文件应部署: ${f}`);
    }
    assert.match(r.out, /部署报告/);
  });

  test('替换中途失败自动回滚（退出码 4）', () => {
    const { scripts } = makeTarget('rollback', { version: '1.2.80' });
    const before = fs.readFileSync(path.join(scripts, 'daemon.js'), 'utf8');
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', deploy,
      '-TargetDir', scripts, '-NoRestart',
    ], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, WORKDADDY_DEPLOY_TESTING: '1', WORKDADDY_DEPLOY_FAIL_AFTER: '3' },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(r.status, 4, out);
    assert.match(out, /回滚/);
    const after = fs.readFileSync(path.join(scripts, 'daemon.js'), 'utf8');
    assert.equal(after, before, '失败后 daemon.js 必须恢复为原内容');
    assert.equal(fs.existsSync(path.join(scripts, 'session-dedupe.js')), false, '新建文件应被清理');
  });
}

try {
  main();
  console.log('PASS deploy-safety.test.js');
} catch (error) {
  console.error('FAIL deploy-safety.test.js:', error);
  process.exitCode = 1;
} finally {
  for (const d of roots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
}
