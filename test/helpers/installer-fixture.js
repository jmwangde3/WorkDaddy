'use strict';
/**
 * 安装器测试夹具（installer-lifecycle / installer-transaction 共用）
 *
 * 这些函数的共同前提：**只在仓库内 tmp/ 下工作**。
 * 本机（以及某些被客户端改过 TEMP 的环境）os.tmpdir() 会指向
 * %APPDATA%\WorkDaddy\client-tmp\... —— 那正是真实用户数据目录内部。
 * 安装/更新/卸载测试会成批复制并删除整棵目录树，绝不能跑在那里。
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const installPs1 = path.join(repo, 'installer', 'install-workdaddy.ps1');
const updatePs1 = path.join(repo, 'installer', 'update-workdaddy.ps1');
const uninstallPs1 = path.join(repo, 'installer', 'uninstall-workdaddy.ps1');
const tmpBase = path.join(repo, 'tmp');

const roots = [];
let counter = 0;

function tmpRoot(tag) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const d = fs.mkdtempSync(path.join(tmpBase, `inst-${tag}-`));
  roots.push(d);
  return d;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 同步睡眠：这些测试是自上而下的顺序脚本，等进程真正退出比分段异步更好读。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 进程是否还活着（pid 可能被系统复用，这里只做「刚刚被停掉」这个场景的判定）。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ---- 与 installer/lib/common.ps1 的清单规则保持一致（Fixture 里不含被排除项）----
const INCLUDE_DIRS = ['scripts', 'src', 'schemas', 'examples', 'release', 'tray'];
const INCLUDE_FILES = ['LICENSE', 'README.md', 'README_en.md', 'README_ja.md', 'package.json'];
const EXCLUDE_NAMES = new Set(['.git', '.github', 'node_modules', 'test', 'tools', 'docs', 'tmp', '__pycache__']);

function fileList(dir) {
  const out = [];
  for (const f of INCLUDE_FILES) {
    if (fs.existsSync(path.join(dir, f))) out.push(f);
  }
  for (const d of INCLUDE_DIRS) {
    const root = path.join(dir, d);
    if (!fs.existsSync(root)) continue;
    const walk = (cur) => {
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        const rel = path.relative(dir, full).split(path.sep).join('\\');
        const parts = rel.split('\\');
        if (parts.some((p) => EXCLUDE_NAMES.has(p))) continue;
        if (/\.log$/i.test(rel)) continue;
        out.push(rel);
      }
    };
    walk(root);
  }
  return out;
}

/**
 * 造一个假的发布源目录。文件数必须超过 20（安装器有下限保护），
 * 且 scripts 下四个核心文件必须是合法 JS —— 更新器会用 node --check 做健康检查。
 */
function makeSource(root, version, opts = {}) {
  const dir = path.join(root, 'src-' + version + (opts.tag ? '-' + opts.tag : ''));
  const files = {
    'package.json': JSON.stringify({ name: 'workdaddy', version, private: true }, null, 2) + '\n',
    'LICENSE': 'GNU AFFERO GENERAL PUBLIC LICENSE Version 3\n',
    'README.md': '# WorkDaddy ' + version + '\n',
    'scripts/daemon.js': "'use strict';\nconst DAEMON_VERSION = '" + version + "';\nmodule.exports = { DAEMON_VERSION };\n",
    'scripts/inject.js': "'use strict';\n// inject " + version + '\n',
    'scripts/lib.js': opts.brokenLib
      ? "'use strict';\nconst broken = ;\n"
      : "'use strict';\n// lib " + version + '\n',
    'scripts/win-launcher.js': "'use strict';\n// launcher\n",
    'scripts/launcher.cmd': '@echo off\r\nnode daemon.js\r\n',
    'scripts/launcher-hidden.vbs': 'CreateObject("WScript.Shell").Run "launcher.cmd", 0\r\n',
    'src/features/integration/fork-routes.js': "'use strict';\n",
    'src/features/sessions/takeover/routes.js': "'use strict';\n",
    'release/WorkDaddy.ico': 'ICO',
    'tray/README.txt': 'tray placeholder\n',
  };
  for (let i = 1; i <= 10; i++) {
    const n = String(i).padStart(2, '0');
    files[`scripts/mod-${n}.js`] = "'use strict';\nmodule.exports = " + i + ';\n';
  }
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
  return dir;
}

/** 直接从磁盘模拟一次「已安装」：复制文件 + 写 install-state.json。比跑安装器快，也解耦。 */
function seedInstall(root, opts) {
  const { version, sourceDir, appDir, dataDir } = opts;
  const list = fileList(sourceDir);
  for (const rel of list) {
    writeFile(path.join(appDir, rel), fs.readFileSync(path.join(sourceDir, rel)));
  }
  const table = list.map((rel) => ({
    path: rel,
    sha256: sha256(path.join(appDir, rel)),
    size: fs.statSync(path.join(appDir, rel)).size,
  }));
  const extra = opts.extraFiles || [];
  writeFile(path.join(dataDir, 'install-state.json'), JSON.stringify({
    schema: 1,
    product: 'WorkDaddy',
    channel: 'fork',
    version,
    appDir,
    dataDir,
    clientProfile: 'workbuddy-cn',
    installedAt: new Date().toISOString(),
    source: 'test-fixture',
    shortcut: opts.shortcut || '',
    files: table.concat(extra),
  }, null, 2));
  return { appDir, dataDir, list };
}

/** 跑一个安装器脚本，返回 { code, report }。TEMP/TMP 指到测试根目录，避免污染真实 %TEMP%。 */
function runPs(script, args, tempDir) {
  const out = path.join(tempDir, 'report-' + (counter++) + '.json');
  const res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script,
  ].concat(args, ['-Json', out]), {
    encoding: 'utf8',
    timeout: 120000,
    env: Object.assign({}, process.env, { TEMP: tempDir, TMP: tempDir }),
  });
  let report = null;
  try {
    if (fs.existsSync(out)) report = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (error) {
    throw new Error('报告不是合法 JSON：' + error.message + '\n' + fs.readFileSync(out, 'utf8'));
  }
  return { code: res.status, report, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function cleanup() {
  const failed = [];
  for (const d of roots) {
    // Windows 上刚退出的 powershell.exe 句柄、杀软扫描会短暂占用目录，
    // 直接 rmSync 偶尔 EBUSY/EPERM。交给 Node 自己按 maxRetries 重试。
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      failed.push(d + ' :: ' + error.code + ' :: ' + error.message);
    }
  }
  if (failed.length) {
    // 不抛：清理失败不该把「测试通过」变成失败，但必须留痕，否则会悄悄堆垃圾
    try { console.error('清理失败 ' + failed.length + '/' + roots.length + '：\n' + failed.join('\n')); } catch (_) {}
  }
}

process.on('exit', cleanup);

module.exports = {
  assert,
  repo,
  installPs1,
  updatePs1,
  uninstallPs1,
  tmpRoot,
  sha256,
  sleepSync,
  alive,
  writeFile,
  fileList,
  makeSource,
  seedInstall,
  runPs,
  cleanup,
};
