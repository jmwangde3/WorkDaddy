'use strict';
/**
 * 托盘：profile 端口映射 + 绑定文件严格校验 + 端口归属识别。
 *
 *   node test/tray-ports-binding.test.js
 *
 * 三块互相独立，但都只在 Windows 上有意义（托盘是 winexe，`csc.exe` 才有产物）：
 *
 *   1. 端口：四个 profile 各有自己的 UI/CDP 端口。托盘写死 47832/9222 时，
 *      AI / CodeBuddy 的「启动判断、状态、管理页、恢复 CDP」全会打到 CN 上。
 *   2. 绑定：install-binding.json 必须是合法 JSON 整体，schema 严格等于 1，
 *      profile 在白名单内，两个目录都是完整绝对路径。正则取字段骗不过截断、
 *      尾部垃圾和重复键。
 *   3. 归属：端口开着不等于「我的 daemon 在跑」—— 必须 /api/status 的 profile
 *      对得上。这里用独立进程的 mock daemon，不启动真实客户端与服务。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');
const trayExe = path.join(repo, 'tray', 'WorkDaddyTray.exe');
const tmpBase = path.join(repo, 'tmp');

const isWin = process.platform === 'win32';
let counter = 0;
const roots = [];
let failures = 0;

function test(name, fn) {
  if (!isWin) {
    console.log(`SKIP ${name} (非 Windows)`);
    return;
  }
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}\n  ${error.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function tmpRoot(tag) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const dir = path.join(tmpBase, `tray-port-${tag}-${process.pid}-${counter++}`);
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

const PROFILES = ['workbuddy-cn', 'workbuddy-ai', 'codebuddy-cn', 'codebuddy-intl'];
const UI_BASE = { 'workbuddy-cn': 47832, 'workbuddy-ai': 47833, 'codebuddy-cn': 47834, 'codebuddy-intl': 47835 };
const CDP_BASE = { 'workbuddy-cn': 9222, 'workbuddy-ai': 9223, 'codebuddy-cn': 9224, 'codebuddy-intl': 9225 };

function makeInstall(tag, profile, opts = {}) {
  const root = tmpRoot(tag);
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  writeFile(path.join(appDir, 'scripts', 'daemon.js'), "'use strict';\n");
  writeFile(path.join(appDir, 'scripts', 'watchdog.js'), "'use strict';\n");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'appdata'), { recursive: true });
  if (opts.binding !== undefined) {
    const value = typeof opts.binding === 'string' ? opts.binding : JSON.stringify(opts.binding, null, 2);
    writeFile(path.join(appDir, 'install-binding.json'), value);
  }
  return { root, appDir, dataDir, profile };
}

function bindingFor(ctx, overrides = {}) {
  return Object.assign({
    schema: 1,
    clientProfile: ctx.profile,
    dataDir: ctx.dataDir,
    appDir: ctx.appDir,
    updatedAt: '2026-11-15T00:00:00Z',
  }, overrides);
}

function baseEnv(ctx, extra) {
  return Object.assign({}, process.env, {
    WORKDADDY_SCRIPTS: path.join(ctx.appDir, 'scripts'),
    WORKDADDY_TRAY_NODE: process.execPath,
    TEMP: path.join(ctx.root, 'tmp'),
    TMP: path.join(ctx.root, 'tmp'),
    APPDATA: path.join(ctx.root, 'appdata'),
    NODE_OPTIONS: '',
    WBSWITCH_PROFILE: '',
    WBSWITCH_DATA_DIR: '',
  }, extra || {});
}

function readCli(ctx) {
  const file = path.join(ctx.root, 'tmp', 'WorkDaddyTray-cli.txt');
  for (let i = 0; i < 40 && !fs.existsSync(file); i += 1) sleepSync(100);
  if (!fs.existsSync(file)) return '';
  for (let i = 0; i < 20; i += 1) {
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { sleepSync(50); }
  }
  return '';
}

function runTray(ctx, args, extraEnv) {
  // 先删掉上一次的输出，避免读到陈旧内容（同一 ctx 会被多次调用）
  try { fs.rmSync(path.join(ctx.root, 'tmp', 'WorkDaddyTray-cli.txt'), { force: true }); } catch (_) {}
  const r = spawnSync(trayExe, args, {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env: baseEnv(ctx, extraEnv), cwd: ctx.root,
  });
  return { code: r.status, stderr: r.stderr || '', cli: readCli(ctx) };
}

function freePort() {
  const r = spawnSync(process.execPath, ['-e',
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
  ], { encoding: 'utf8', timeout: 10000 });
  const port = Number(String(r.stdout || '').trim());
  if (!port) throw new Error('无法分配空闲端口：' + (r.stderr || ''));
  return port;
}

const MOCK_DAEMON = [
  "'use strict';",
  "const http = require('http');",
  "const fs = require('fs');",
  'const port = Number(process.argv[2]);',
  'const profile = process.argv[3] || "";',
  'const dataDir = process.argv[4] || "";',
  'const ready = process.argv[5];',
  'const server = http.createServer((req, res) => {',
  "  const p = String(req.url || '').split('?')[0];",
  "  if (p === '/api/status') {",
  "    res.setHeader('content-type', 'application/json');",
  '    res.end(JSON.stringify({ ok: true, version: "1.3.1", profile: { id: profile }, dataDir: dataDir }));',
  '    return;',
  '  }',
  '  res.statusCode = 404;',
  "  res.end('{}');",
  '});',
  "server.listen(port, '127.0.0.1', () => fs.writeFileSync(ready, String(port)));",
].join('\n');

function startMockDaemon(root, port, profile, dataDir) {
  const script = path.join(root, 'mock-daemon.js');
  const ready = path.join(root, 'mock.ready');
  writeFile(script, MOCK_DAEMON);
  const child = spawn(process.execPath, [script, String(port), profile, dataDir || '', ready], {
    stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 60 && !fs.existsSync(ready); i += 1) sleepSync(100);
  if (!fs.existsSync(ready)) {
    try { child.kill(); } catch (_) {}
    throw new Error('mock daemon 未就绪');
  }
  return child;
}

function main() {
  assert(fs.existsSync(trayExe), '托盘二进制不存在：' + trayExe);

  test('四种 profile 使用各自的 UI 端口与 CDP 端口', () => {
    for (const profile of PROFILES) {
      const ctx = makeInstall('ports-' + profile, profile);
      writeFile(path.join(ctx.appDir, 'install-binding.json'), JSON.stringify(bindingFor(ctx), null, 2));
      const r = runTray(ctx, ['--ports'], {});
      assert(/ui\s+: (\d+)/.test(r.cli), '缺 ui 行：' + r.cli);
      const ui = Number(r.cli.match(/ui\s+: (\d+)/)[1]);
      const cdp = Number(r.cli.match(/cdp\s+: (\d+)/)[1]);
      const uiC = r.cli.match(/uiCandidates: ([0-9,]+)/)[1];
      const cdpC = r.cli.match(/cdpCandidates: ([0-9,]+)/)[1];
      const base = UI_BASE[profile];
      assert(ui === base, profile + ' UI 端口应为 ' + base + '，实际 ' + ui);
      assert(uiC === [base, base - 30000, base - 20000, base - 10000].join(','),
        profile + ' UI 候选应为与 ui-port.js 同序的四档，实际 ' + uiC);
      assert(cdp === CDP_BASE[profile], profile + ' CDP 端口应为 ' + CDP_BASE[profile] + '，实际 ' + cdp);
      if (profile === 'codebuddy-cn') assert(cdpC === '9224', 'codebuddy-cn 只应认 9224，实际 ' + cdpC);
      if (profile === 'codebuddy-intl') assert(cdpC === '9225', 'codebuddy-intl 只应认 9225，实际 ' + cdpC);
      if (profile === 'workbuddy-ai') assert(/^9223,9233,/.test(cdpC), 'AI 备用 CDP 应在 9233+，实际 ' + cdpC);
      if (profile === 'workbuddy-cn') assert(/^9222,9226,/.test(cdpC), 'CN 备用 CDP 应在 9226+，实际 ' + cdpC);
    }
  });

  test('绑定文件：合法 JSON 通过校验', () => {
    const ctx = makeInstall('json-ok', 'workbuddy-ai');
    writeFile(path.join(ctx.appDir, 'install-binding.json'), JSON.stringify(bindingFor(ctx), null, 2));
    const r = runTray(ctx, ['--check-binding', path.join(ctx.appDir, 'install-binding.json')], {});
    assert(/binding = ok: profile=workbuddy-ai/.test(r.cli), '应通过：' + r.cli);
  });

  test('绑定文件：截断 / 尾部垃圾 / 重复键 一律拒绝', () => {
    const ctx = makeInstall('json-bad', 'workbuddy-ai');
    const file = path.join(ctx.appDir, 'install-binding.json');
    const good = JSON.stringify(bindingFor(ctx));

    writeFile(file, good.slice(0, good.length - 5));
    assert(/binding = error: 不是合法 JSON/.test(runTray(ctx, ['--check-binding', file], {}).cli), '截断应拒绝');

    writeFile(file, good + ' trailing');
    assert(/binding = error: 不是合法 JSON/.test(runTray(ctx, ['--check-binding', file], {}).cli), '尾部垃圾应拒绝');

    const dup = good.replace('{', '{"clientProfile":"workbuddy-cn",');
    writeFile(file, dup);
    const dupOut = runTray(ctx, ['--check-binding', file], {}).cli;
    assert(/不是合法 JSON：.*重复的键/.test(dupOut), '重复键应拒绝：' + dupOut);
  });

  test('绑定文件：schema / 字段 / 路径逐项校验', () => {
    const ctx = makeInstall('json-fields', 'workbuddy-ai');
    const file = path.join(ctx.appDir, 'install-binding.json');
    const cases = [
      [bindingFor(ctx, { schema: 2 }), /schema 必须严格等于 1/],
      [bindingFor(ctx, { schema: '1' }), /schema 必须严格等于 1/],
      [(() => { const b = bindingFor(ctx); delete b.schema; return b; })(), /schema 缺失/],
      [(() => { const b = bindingFor(ctx); delete b.appDir; return b; })(), /appDir 缺失/],
      [bindingFor(ctx, { appDir: 'app' }), /appDir 不是完整绝对路径/],
      [bindingFor(ctx, { appDir: 'C:app' }), /appDir 不是完整绝对路径/],
      [bindingFor(ctx, { dataDir: 'C:data' }), /dataDir 不是完整绝对路径/],
      [bindingFor(ctx, { dataDir: '' }), /dataDir 缺失|不是完整绝对路径/],
      [bindingFor(ctx, { clientProfile: 'workbuddy-cn-xxx' }), /clientProfile 非法/],
      [bindingFor(ctx, { appDir: path.join(ctx.root, 'other-install') }), /属于另一个安装/],
    ];
    for (const [payload, pattern] of cases) {
      writeFile(file, JSON.stringify(payload, null, 2));
      const out = runTray(ctx, ['--check-binding', file], {}).cli;
      assert(pattern.test(out), '应拒绝 ' + JSON.stringify(payload) + '，实际：' + out);
    }
  });

  test('端口归属：mock daemon 的 profile 与绑定时才算运行中', () => {
    const ctx = makeInstall('identity', 'workbuddy-ai');
    writeFile(path.join(ctx.appDir, 'install-binding.json'), JSON.stringify(bindingFor(ctx), null, 2));
    const port = freePort();
    const child = startMockDaemon(ctx.root, port, 'workbuddy-ai', ctx.dataDir);
    try {
      const same = runTray(ctx, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
      assert(/daemon\s+: running/.test(same.cli), '同 profile 应判定为运行中：' + same.cli);

      // 同一个端口、同一个 daemon，但托盘绑定的是另一个 profile：必须判为未运行
      const other = makeInstall('identity-other', 'codebuddy-cn');
      writeFile(path.join(other.appDir, 'install-binding.json'), JSON.stringify(bindingFor(other), null, 2));
      const mismatch = runTray(other, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
      assert(/daemon\s+: stopped/.test(mismatch.cli),
        '兄弟 profile 的 daemon 不能被认成自己已启动：' + mismatch.cli);
    } finally {
      try { child.kill(); } catch (_) {}
    }
  });

  test('端口被占用时不误判：启动判断走的是 /api/status 身份，不是端口', () => {
    const ctx = makeInstall('occupied', 'workbuddy-ai');
    writeFile(path.join(ctx.appDir, 'install-binding.json'), JSON.stringify(bindingFor(ctx), null, 2));
    const port = freePort();
    // 端口上跑的是「别人的 daemon」：有响应，但 profile 不是我们的
    const squatter = startMockDaemon(ctx.root, port, 'workbuddy-cn', '');
    try {
      const r = runTray(ctx, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
      assert(/daemon\s+: stopped/.test(r.cli), '兄弟 profile 的 daemon 不能被当成自己：' + r.cli);
    } finally {
      try { squatter.kill(); } catch (_) {}
    }
  });

  test('APPDATA 隔离：旧记录只从测试自己的 APPDATA 读', () => {
    const ctx = makeInstall('appdata', 'workbuddy-cn');
    // 没有绑定文件 → 走旧记录；旧记录放在测试的 APPDATA 下
    const legacyDir = path.join(ctx.root, 'appdata', 'WorkDaddy');
    writeFile(path.join(legacyDir, 'install-state.json'), JSON.stringify({
      schema: 1, clientProfile: 'codebuddy-intl', dataDir: ctx.dataDir, appDir: ctx.appDir,
    }, null, 2));
    const r = runTray(ctx, ['--status'], {});
    assert(/profile=codebuddy-intl/.test(r.cli), '应从测试 APPDATA 读到旧记录：' + r.cli);
    assert(/source=install-state\.json/.test(r.cli), '来源应为 install-state.json：' + r.cli);
  });

  test('多实例边界：单运行实例（全局 Mutex + 与安装目录无关的进程匹配）', () => {
    const cs = fs.readFileSync(path.join(repo, 'tray', 'WorkDaddyTray.cs'), 'utf8');
    // 这两条一起构成「A：多份安装但只允许一个运行实例」。改任何一条都等于改成 B，
    // 必须先补并发隔离测试（StopWd 按安装目录过滤、端口互不干扰），不能只改这里。
    assert(cs.includes('Local\\WorkDaddyTraySingleton'), '托盘应使用全局单实例 Mutex');
    assert(cs.includes('WorkDaddy[\\\\/]scripts[\\\\/](watchdog|daemon)'),
      'StopWd 的进程匹配应覆盖任意安装目录（切换实例时旧服务必须被停掉）');
    const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    assert(/单运行实例/.test(readme), 'README 必须写明单运行实例限制');
  });
}

try {
  main();
} finally {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  }
}
if (failures > 0) {
  console.error(`FAIL tray-ports-binding.test.js (${failures} 项失败)`);
  process.exit(1);
}
console.log('PASS tray-ports-binding.test.js');
