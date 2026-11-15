'use strict';
/**
 * 托盘真实启动链：StartWd() 到底把什么传给了 watchdog。
 *
 *   node test/tray-launch-chain.test.js
 *
 * 为什么必须这么测：CI 里已有 --selftest / --status，但那两条都不启动任何进程，
 * 证明不了「托盘 → 子进程」这段环境变量传递。这里用真实的托盘二进制、真实的
 * StartWd 路径去拉起一个假的 watchdog.js：它只把 process.env 写进 JSON 就退出，
 * 不连 daemon、不碰 9222、不写任何用户目录。
 *
 * 隔离手段（全部是生产代码里的既有/新增开关）：
 *   WORKDADDY_SCRIPTS      → 临时安装目录
 *   WORKDADDY_TRAY_NODE    → 当前 node（不依赖 ~/.workbuddy 的运行时）
 *   WORKDADDY_TRAY_PORT    → 随机空闲端口（避免本机 47832 上的真实服务把启动短路）
 *   TEMP/TMP               → 临时目录（--start 的结果写在这里）
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');
const trayExe = path.join(repo, 'tray', 'WorkDaddyTray.exe');
const tmpBase = path.join(repo, 'tmp');

const isWin = process.platform === 'win32';
let counter = 0;
const roots = [];

function test(name, fn) {
  if (!isWin) {
    console.log(`SKIP ${name} (非 Windows)`);
    return;
  }
  fn();
  console.log(`ok - ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function tmpRoot(tag) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const dir = path.join(tmpBase, `tray-chain-${tag}-${process.pid}-${counter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// watchdog 的替身：把子进程看到的环境写成 JSON，然后立刻退出。
// 路径按 <root>/app/scripts 布局反推，避免依赖当前工作目录。
const FAKE_WATCHDOG = [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "const out = path.join(__dirname, '..', '..', 'out');",
  "fs.mkdirSync(out, { recursive: true });",
  "fs.writeFileSync(path.join(out, 'env.json'), JSON.stringify({",
  "  profile: process.env.WBSWITCH_PROFILE || null,",
  "  dataDir: process.env.WBSWITCH_DATA_DIR || null,",
  "  argv: process.argv.slice(2),",
  "}, null, 2));",
  'process.exit(0);',
].join('\n');

function freePort() {
  const r = spawnSync(process.execPath, ['-e',
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
  ], { encoding: 'utf8', timeout: 10000 });
  const port = Number(String(r.stdout || '').trim());
  if (!port) throw new Error('无法分配空闲端口：' + (r.stderr || ''));
  return port;
}

function makeInstall(root, opts = {}) {
  const appDir = path.join(root, 'app');
  writeFile(path.join(appDir, 'scripts', 'daemon.js'), "'use strict';\n");
  writeFile(path.join(appDir, 'scripts', 'watchdog.js'), FAKE_WATCHDOG);
  if (opts.binding !== undefined) {
    const value = typeof opts.binding === 'string' ? opts.binding : JSON.stringify(opts.binding, null, 2);
    writeFile(path.join(appDir, 'install-binding.json'), value);
  }
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'appdata'), { recursive: true });
  return appDir;
}

function runStart(root, env) {
  const appDir = path.join(root, 'app');
  const port = freePort();
  const merged = Object.assign({}, process.env, {
    WORKDADDY_SCRIPTS: path.join(appDir, 'scripts'),
    WORKDADDY_TRAY_NODE: process.execPath,
    WORKDADDY_TRAY_PORT: String(port),
    TEMP: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    APPDATA: path.join(root, 'appdata'),
    NODE_OPTIONS: '',
    WBSWITCH_PROFILE: '',
    WBSWITCH_DATA_DIR: '',
  }, env || {});
  const r = spawnSync(trayExe, ['--start'], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env: merged, cwd: root,
  });
  // 等 watchdog 落盘（正常情况 < 1s）
  const envFile = path.join(root, 'out', 'env.json');
  for (let i = 0; i < 50 && !fs.existsSync(envFile); i += 1) sleepSync(100);
  const cliFile = path.join(root, 'tmp', 'WorkDaddyTray-cli.txt');
  return {
    code: r.status,
    cli: fs.existsSync(cliFile) ? fs.readFileSync(cliFile, 'utf8') : '',
    env: fs.existsSync(envFile) ? JSON.parse(fs.readFileSync(envFile, 'utf8')) : null,
    stderr: r.stderr || '',
  };
}

function main() {
  assert(fs.existsSync(trayExe), '托盘二进制不存在：' + trayExe);

  test('默认 profile + 无绑定文件：走默认，绝不凭空造数据目录', () => {
    const root = tmpRoot('default');
    makeInstall(root);
    const r = runStart(root, {});
    assert(r.env, '未拉起 watchdog：' + r.cli + r.stderr);
    assert(r.env.profile === 'workbuddy-cn', '默认 profile 应为 workbuddy-cn，实际 ' + r.env.profile);
    // APPDATA 已指向测试临时目录，那里没有 install-state.json，所以只能是默认值
    assert(r.env.dataDir === null, '没有绑定也没有旧记录时不应传数据目录，实际 ' + r.env.dataDir);
  });

  test('旧记录兼容：只从测试自己的 APPDATA 读，不碰真实用户数据', () => {
    const root = tmpRoot('legacy');
    makeInstall(root);
    writeFile(path.join(root, 'appdata', 'WorkDaddy', 'install-state.json'), JSON.stringify({
      schema: 1, clientProfile: 'codebuddy-intl', dataDir: path.join(root, 'data'), appDir: path.join(root, 'app'),
    }, null, 2));
    const r = runStart(root, {});
    assert(r.env, '未拉起 watchdog：' + r.cli + r.stderr);
    assert(r.env.profile === 'codebuddy-intl', '旧记录应生效，实际 ' + r.env.profile);
    assert(path.resolve(r.env.dataDir).toLowerCase() === path.resolve(path.join(root, 'data')).toLowerCase(),
      '旧记录的数据目录应生效，实际 ' + r.env.dataDir);
  });

  test('绑定文件：profile 与自定义数据目录原样传给 watchdog', () => {
    const root = tmpRoot('binding');
    const appDir = makeInstall(root, {
      binding: {
        schema: 1,
        clientProfile: 'workbuddy-ai',
        dataDir: path.join(root, 'data'),
        appDir: path.join(root, 'app'),
        updatedAt: '2026-11-15T00:00:00Z',
      },
    });
    assert(fs.existsSync(path.join(appDir, 'install-binding.json')));
    const r = runStart(root, {});
    assert(r.env, '未拉起 watchdog：' + r.cli + r.stderr);
    assert(r.env.profile === 'workbuddy-ai', 'profile 应取自绑定文件，实际 ' + r.env.profile);
    assert(path.resolve(r.env.dataDir).toLowerCase() === path.resolve(path.join(root, 'data')).toLowerCase(),
      '数据目录应取自绑定文件，实际 ' + r.env.dataDir);
  });

  test('环境变量覆盖绑定文件：显式值优先', () => {
    const root = tmpRoot('env-wins');
    makeInstall(root, {
      binding: {
        schema: 1,
        clientProfile: 'workbuddy-ai',
        dataDir: path.join(root, 'data'),
        appDir: path.join(root, 'app'),
        updatedAt: '2026-11-15T00:00:00Z',
      },
    });
    const custom = path.join(root, 'env-data');
    fs.mkdirSync(custom, { recursive: true });
    const r = runStart(root, { WBSWITCH_PROFILE: 'codebuddy-cn', WBSWITCH_DATA_DIR: custom });
    assert(r.env, '未拉起 watchdog：' + r.cli + r.stderr);
    assert(r.env.profile === 'codebuddy-cn', '显式 profile 应优先，实际 ' + r.env.profile);
    assert(path.resolve(r.env.dataDir).toLowerCase() === path.resolve(custom).toLowerCase(),
      '显式数据目录应优先，实际 ' + r.env.dataDir);
  });

  test('非法 profile：拒绝启动服务，不拉起 watchdog', () => {
    const root = tmpRoot('bad-profile');
    makeInstall(root);
    const r = runStart(root, { WBSWITCH_PROFILE: 'unknown-profile' });
    assert(r.env === null, '非法 profile 时不得启动 watchdog');
    assert(/start = False/.test(r.cli), '应报告启动失败：' + r.cli);
    assert(/WBSWITCH_PROFILE 非法/.test(r.cli), '应说明原因：' + r.cli);
  });

  test('非法数据目录：C:relative 一律拒绝', () => {
    const root = tmpRoot('bad-datadir');
    makeInstall(root);
    const r = runStart(root, { WBSWITCH_DATA_DIR: 'C:WorkDaddyData' });
    assert(r.env === null, '非法数据目录时不得启动 watchdog');
    assert(/start = False/.test(r.cli), '应报告启动失败：' + r.cli);
    assert(/WBSWITCH_DATA_DIR 不是完整/.test(r.cli), '应说明原因：' + r.cli);
  });

  test('绑定文件损坏：拒绝启动，不静默退回默认 profile', () => {
    const root = tmpRoot('broken-binding');
    makeInstall(root, { binding: '{ "schema": 1, ' });
    const r = runStart(root, {});
    assert(r.env === null, '绑定损坏时不得启动 watchdog');
    assert(/安装绑定文件不可用/.test(r.cli), '应说明绑定不可用：' + r.cli);
  });

  test('绑定文件属于另一个安装：拒绝启动', () => {
    const root = tmpRoot('foreign-binding');
    makeInstall(root, {
      binding: {
        schema: 1,
        clientProfile: 'workbuddy-cn',
        dataDir: path.join(root, 'data'),
        appDir: path.join(root, 'another-install'),
        updatedAt: '2026-11-15T00:00:00Z',
      },
    });
    const r = runStart(root, {});
    assert(r.env === null, '绑定指向别处时不得启动 watchdog');
    assert(/属于另一个安装/.test(r.cli), '应说明归属不符：' + r.cli);
  });

  test('绑定文件 profile 不在白名单：拒绝启动', () => {
    const root = tmpRoot('binding-badprofile');
    makeInstall(root, {
      binding: {
        schema: 1,
        clientProfile: 'workbuddy-cn-xxx',
        dataDir: path.join(root, 'data'),
        appDir: path.join(root, 'app'),
        updatedAt: '2026-11-15T00:00:00Z',
      },
    });
    const r = runStart(root, {});
    assert(r.env === null, '白名单外的 profile 不得启动 watchdog');
    assert(/clientProfile 非法/.test(r.cli), '应说明 profile 非法：' + r.cli);
  });
  test('只设 profile 且与绑定一致：profile 生效，数据目录仍用绑定的', () => {
    const root = tmpRoot('env-profile-only');
    makeInstall(root, {
      binding: {
        schema: 1,
        clientProfile: 'workbuddy-ai',
        dataDir: path.join(root, 'data'),
        appDir: path.join(root, 'app'),
        updatedAt: '2026-11-15T00:00:00Z',
      },
    });
    const r = runStart(root, { WBSWITCH_PROFILE: 'workbuddy-ai' });
    assert(r.env, '未拉起 watchdog：' + r.cli + r.stderr);
    assert(r.env.profile === 'workbuddy-ai');
    assert(path.resolve(r.env.dataDir).toLowerCase() === path.resolve(path.join(root, 'data')).toLowerCase(),
      '数据目录应沿用绑定，实际 ' + r.env.dataDir);
  });

  test('只设 profile 且与绑定冲突：拒绝半覆盖，不启动', () => {
    const root = tmpRoot('env-half-override');
    makeInstall(root, {
      binding: {
        schema: 1,
        clientProfile: 'workbuddy-ai',
        dataDir: path.join(root, 'data'),
        appDir: path.join(root, 'app'),
        updatedAt: '2026-11-15T00:00:00Z',
      },
    });
    const r = runStart(root, { WBSWITCH_PROFILE: 'codebuddy-cn' });
    assert(r.env === null, '半覆盖不得启动 watchdog');
    assert(/冲突/.test(r.cli), '应说明 profile 与绑定冲突：' + r.cli);
  });

  test('只设 DataDir：profile 取绑定，数据目录取显式值', () => {
    const root = tmpRoot('env-datadir-only');
    makeInstall(root, {
      binding: {
        schema: 1,
        clientProfile: 'workbuddy-ai',
        dataDir: path.join(root, 'data'),
        appDir: path.join(root, 'app'),
        updatedAt: '2026-11-15T00:00:00Z',
      },
    });
    const custom = path.join(root, 'explicit-data');
    fs.mkdirSync(custom, { recursive: true });
    const r = runStart(root, { WBSWITCH_DATA_DIR: custom });
    assert(r.env, '未拉起 watchdog：' + r.cli + r.stderr);
    assert(r.env.profile === 'workbuddy-ai', 'profile 应来自绑定，实际 ' + r.env.profile);
    assert(path.resolve(r.env.dataDir).toLowerCase() === path.resolve(custom).toLowerCase(),
      '数据目录应取显式值，实际 ' + r.env.dataDir);
  });

  test('绑定损坏时，完整环境变量也不能绕过 fail-closed', () => {
    const root = tmpRoot('broken-plus-env');
    makeInstall(root, { binding: '{ "schema": 1, ' });
    const r = runStart(root, {
      WBSWITCH_PROFILE: 'workbuddy-cn',
      WBSWITCH_DATA_DIR: path.join(root, 'data'),
    });
    assert(r.env === null, '绑定损坏时任何覆盖都不得启动 watchdog');
    assert(/安装绑定文件不可用/.test(r.cli), '应说明绑定不可用：' + r.cli);
  });
}

try {
  main();
} finally {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  }
}
