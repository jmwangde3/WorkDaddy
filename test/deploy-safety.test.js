'use strict';
/**
 * deploy.ps1 原子部署回归测试（P1）
 *
 *   node --test test/deploy-safety.test.js
 *
 * 只在 Windows 上执行；所有目标目录都在临时目录内，不碰真实安装。
 * 覆盖：预检零写入、版本号闸门（advisory / strict）、
 *       文件代际闸门（SHA-256：已打补丁 / 原版上游 / 未知代际 / 同大小不同内容）、
 *       本机配置不被覆盖、替换中途失败自动回滚、部署报告生成、
 *       upstream.json 里的补丁哈希与实际文件一致。
 *
 * 测试通过 powershell.exe（Windows PowerShell 5.1）实际执行 deploy.ps1：
 * 也就是说 DryRun、临时目录真实部署、以及失败回滚这三条路径，
 * 都在 5.1 上真跑过，不是只做静态解析。
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const repo = path.join(__dirname, '..');
const deploy = path.join(repo, 'deploy.ps1');
const srcScripts = path.join(repo, 'scripts');
const upstreamJson = path.join(srcScripts, 'upstream.json');
const roots = [];

function tmpRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wd-deploy-${tag}-`));
  roots.push(d);
  return d;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runDeploy(args, env) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', deploy, ...args,
  ], { encoding: 'utf8', timeout: 120000, env: env ? { ...process.env, ...env } : process.env });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** 造一个「已安装 WorkDaddy」的最小目录。默认 daemon.js 与本补丁完全一致（已打补丁）。 */
function makeTarget(tag, opts = {}) {
  const root = tmpRoot(tag);
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const daemonPath = path.join(scripts, 'daemon.js');
  if (opts.pristineContent) {
    fs.writeFileSync(daemonPath, opts.pristineContent);
  } else {
    let daemon = fs.readFileSync(path.join(srcScripts, 'daemon.js'), 'utf8');
    if (opts.version) daemon = daemon.replace(/DAEMON_VERSION = '[^']*'/, `DAEMON_VERSION = '${opts.version}'`);
    fs.writeFileSync(daemonPath, daemon);
  }
  if (opts.exeCfg) {
    fs.writeFileSync(path.join(scripts, 'workbuddy-exe.json'), JSON.stringify({ path: opts.exeCfg }));
  }
  return { root, scripts };
}

/**
 * 合成一份 upstream.json，把 daemon.js 的「上游原版哈希」指向给定内容。
 * deploy.ps1 用 WORKDADDY_UPSTREAM_JSON 读取它 —— 只有测试会设这个变量。
 */
function syntheticUpstream(tag, content) {
  const dir = tmpRoot(tag);
  const file = path.join(dir, 'upstream.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 3,
    deploy: {
      upstreamFileHashes: {
        'daemon.js': {
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          size: Buffer.byteLength(content),
        },
      },
    },
  }, null, 2));
  return file;
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
    // 版本号被改过 → 代际必然是 unknown-generation，这里的 -Force 只是过代际闸门；
    // 版本闸门本身走 advisory，所以仍应放行并明确说明"只是提示"。
    const { scripts } = makeTarget('newer', { version: '9.9.9' });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun', '-Force']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /advisory/i, '必须明确告诉用户这只是提示');
  });

  test('目标版本更新 + -StrictVersionGate 时中止（退出码 2），-Force 不得顺手越过版本闸门', () => {
    // 回归：改过版本号的目标必然要 -Force 才能过代际闸门。若两道闸共用 -Force，
    // -StrictVersionGate 就永远触发不了。版本闸门必须有自己的 -ForceVersion。
    const { scripts } = makeTarget('newer-strict', { version: '9.9.9' });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun', '-StrictVersionGate', '-Force']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /比补丁/);
    assert.match(r.out, /-ForceVersion/, '必须告诉用户越过版本闸门的正确开关');
  });

  test('版本闸门可被 -ForceVersion 显式越过', () => {
    const { scripts } = makeTarget('newer-strict-forceversion', { version: '9.9.9' });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun', '-StrictVersionGate', '-Force', '-ForceVersion']);
    assert.equal(r.code, 0, r.out);
  });

  test('目标是原版上游文件时代际闸门中止（退出码 2）', () => {
    const pristine = "var DAEMON_VERSION = '1.2.22';\n// upstream original\n";
    const up = syntheticUpstream('pristine-meta', pristine);
    const { scripts } = makeTarget('pristine', { pristineContent: pristine });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun'], { WORKDADDY_UPSTREAM_JSON: up });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /原版上游/, '必须说明拦的是「无补丁的上游文件」');
    assert.match(r.out, /SHA-256/);
  });

  test('原版上游文件可被 -Force 越过', () => {
    const pristine = "var DAEMON_VERSION = '1.2.22';\n// upstream original\n";
    const up = syntheticUpstream('pristine-force-meta', pristine);
    const { scripts } = makeTarget('pristine-force', { pristineContent: pristine });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun', '-Force'], { WORKDADDY_UPSTREAM_JSON: up });
    assert.equal(r.code, 0, r.out);
  });

  test('旧代际的原版上游文件同样判为 pristine-upstream（多代际哈希）', () => {
    // 场景：补丁基线是 1.2.20，用户机器上装的是 1.2.22 原版。
    // 主 upstreamFileHashes 只记 1.2.20；1.2.22 的哈希在 upstreamFileHashesByVersion 里。
    // 旧实现只比主哈希 → 会判成「代际不明」；这里要确认它被认出是原版上游。
    const oldGen = "var DAEMON_VERSION = '1.2.20';\n// upstream original older\n";
    const newGen = "var DAEMON_VERSION = '1.2.22';\n// upstream original newer\n";
    const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const dir = tmpRoot('multi-gen-meta');
    const file = path.join(dir, 'upstream.json');
    fs.writeFileSync(file, JSON.stringify({
      schema: 4,
      deploy: {
        upstreamFileHashes: { 'daemon.js': { sha256: sha(oldGen), size: Buffer.byteLength(oldGen) } },
        upstreamFileHashesByVersion: {
          '1.2.20': { 'daemon.js': { sha256: sha(oldGen), size: Buffer.byteLength(oldGen) } },
          '1.2.22': { 'daemon.js': { sha256: sha(newGen), size: Buffer.byteLength(newGen) } },
        },
      },
    }, null, 2));

    const { scripts } = makeTarget('multi-gen', { pristineContent: newGen });
    const r = runDeploy(['-TargetDir', scripts, '-DryRun'], { WORKDADDY_UPSTREAM_JSON: file });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /原版上游/, '1.2.22 原版也必须被认出是没打补丁的上游文件');
    assert.equal(/代际不明/.test(r.out), false, '不得退化成「代际不明」');
  });

  test('同大小不同内容的目标判为未知代际并中止（回归：旧版只比字节数会误判）', () => {
    // 取本补丁版 daemon.js，改一个字符、保持字节长度完全一致。
    const src = fs.readFileSync(path.join(srcScripts, 'daemon.js'));
    const flipped = Buffer.from(src);
    const at = flipped.indexOf(0x41); // 'A'
    assert.ok(at > 0, '前置条件：源码里有可替换的 ASCII 字符');
    flipped[at] = 0x42;               // 'A' -> 'B'，长度不变
    const { scripts } = makeTarget('samesize', { pristineContent: flipped });
    const target = path.join(scripts, 'daemon.js');
    assert.equal(fs.statSync(target).size, src.length, '前置条件：字节数与补丁版完全相同');

    const r = runDeploy(['-TargetDir', scripts, '-DryRun']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /代际不明/, '同大小不同内容必须判为未知代际');
    assert.match(r.out, /SHA-256/);
  });

  test('未知代际可被 -Force 越过', () => {
    const src = fs.readFileSync(path.join(srcScripts, 'daemon.js'));
    const flipped = Buffer.from(src);
    flipped[flipped.indexOf(0x41)] = 0x42;
    const { scripts } = makeTarget('samesize-force', { pristineContent: flipped });
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
    const { scripts } = makeTarget('real', { exeCfg: custom });
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
    const { scripts } = makeTarget('rollback');
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

  test('upstream.json 记录的本地补丁哈希与仓库文件一致（防止元数据过期）', () => {
    const meta = JSON.parse(fs.readFileSync(upstreamJson, 'utf8'));
    const local = meta.deploy.localFileHashes;
    assert.ok(local, 'upstream.json 必须记录本地补丁哈希');
    for (const [name, rec] of Object.entries(local)) {
      const actual = sha256(path.join(srcScripts, name));
      assert.equal(
        rec.sha256,
        actual,
        `${name} 的 SHA-256 与记录不一致：改了补丁文件就要重算 upstream.json。`
        + '另外注意行尾——.gitattributes 强制 eol=lf，若工作副本是 CRLF，'
        + '哈希会与 CI 检出（LF）不同，重跑 git checkout 后再算。',
      );
      assert.equal(rec.size, fs.statSync(path.join(srcScripts, name)).size, `${name} 的字节数与记录不一致`);
    }
  });

  test('upstream.json 的上游哈希为 64 位十六进制且带字节数', () => {
    const meta = JSON.parse(fs.readFileSync(upstreamJson, 'utf8'));
    const up = meta.deploy.upstreamFileHashes;
    assert.ok(up && Object.keys(up).length >= 4);
    for (const [name, rec] of Object.entries(up)) {
      assert.match(rec.sha256, /^[0-9a-f]{64}$/, `${name} 的上游哈希格式不对`);
      assert.ok(rec.size > 0, `${name} 缺少字节数`);
    }
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
