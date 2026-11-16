'use strict';
/**
 * 托盘：profile 端口映射 + 绑定文件严格校验 + 端口归属识别。
 *
 *   node test/tray-ports-binding.test.js
 *
 * 四块互相独立，但都只在 Windows 上有意义（托盘是 winexe，`csc.exe` 才有产物）：
 *
 *   1. 端口：四个 profile 各有自己的 UI/CDP 端口。托盘写死 47832/9222 时，
 *      AI / CodeBuddy 的「启动判断、状态、管理页、恢复 CDP」全会打到 CN 上。
 *   2. 绑定：install-binding.json 必须是合法 JSON 整体（数字也必须是 JSON 数字），
 *      schema 严格等于 1，profile 在白名单内，两个目录都是完整绝对路径。
 *   3. 归属：端口开着不等于「我的 daemon 在跑」。同 profile、另一个数据目录的
 *      实例也不能认领 —— dataDir 只在 token 认证通过时才出现在 /api/status 里，
 *      所以「拿不到 dataDir」本身就必须判失败。
 *   4. CDP：以 daemon 的 cdp.connected / cdp.port 为准，不看 TCP 端口开放。
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
const children = [];
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
  if (opts.token !== undefined) {
    writeFile(path.join(dataDir, '.api-token'), opts.token);
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

function writeBinding(ctx, overrides) {
  writeFile(path.join(ctx.appDir, 'install-binding.json'), JSON.stringify(bindingFor(ctx, overrides), null, 2));
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
    encoding: 'utf8', timeout: 40000, windowsHide: true, env: baseEnv(ctx, extraEnv), cwd: ctx.root,
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

// mock daemon：按真实 daemon 的规矩返回 /api/status ——
// dataDir / appDir 只在 x-workdaddy-token 与自己的 token 一致时才出现。
const MOCK_DAEMON = [
  "'use strict';",
  "const http = require('http');",
  "const fs = require('fs');",
  'const cfg = JSON.parse(process.argv[2]);',
  'const server = http.createServer((req, res) => {',
  "  const p = String(req.url || '').split('?')[0];",
  "  if (p === '/api/status') {",
  "    const supplied = String(req.headers['x-workdaddy-token'] || '');",
  '    const authed = Boolean(cfg.token) && supplied === cfg.token;',
  "    res.setHeader('content-type', 'application/json');",
  '    const body = { ok: true, version: "1.3.1", profile: { id: cfg.profile } };',
  '    if (cfg.cdp !== undefined) body.cdp = cfg.cdp;',
  '    if (cfg.client !== undefined) body.client = cfg.client;',
  '    if (authed) {',
  '      if (cfg.omitDataDir !== true) body.dataDir = cfg.dataDir;',
  '      if (cfg.appDir) body.appDir = cfg.appDir;',
  '    }',
  '    res.end(JSON.stringify(body));',
  '    return;',
  '  }',
  "  if (p === '/api/client/relaunch') {",
  "    res.setHeader('content-type', 'application/json');",
  "    res.end(JSON.stringify({ ok: true }));",
  '    return;',
  '  }',
  '  res.statusCode = 404;',
  "  res.end('{}');",
  '});',
  "server.listen(cfg.port, '127.0.0.1', () => fs.writeFileSync(cfg.ready, String(cfg.port)));",
].join('\n');

function startMockDaemon(root, cfg) {
  const script = path.join(root, 'mock-daemon.js');
  const ready = path.join(root, 'mock.ready.' + (counter++));
  writeFile(script, MOCK_DAEMON);
  const child = spawn(process.execPath, [script, JSON.stringify(Object.assign({ ready }, cfg))], {
    stdio: 'ignore', windowsHide: true,
  });
  children.push(child);
  for (let i = 0; i < 60 && !fs.existsSync(ready); i += 1) sleepSync(100);
  if (!fs.existsSync(ready)) {
    try { child.kill(); } catch (_) {}
    throw new Error('mock daemon 未就绪');
  }
  return child;
}

// 只监听、不应答 /api/status 的进程：模拟「端口被别的程序占着」。
function startSquatter(root, port) {
  const script = path.join(root, 'squatter.js');
  writeFile(script, [
    "'use strict';",
    "const net = require('net');",
    'const port = Number(process.argv[2]);',
    "net.createServer((socket) => socket.end('')).listen(port, '127.0.0.1');",
    'setTimeout(() => process.exit(0), 60000);',
  ].join('\n'));
  const child = spawn(process.execPath, [script, String(port)], { stdio: 'ignore', windowsHide: true });
  children.push(child);
  for (let i = 0; i < 60; i += 1) {
    const probe = spawnSync(process.execPath, ['-e',
      "const s=require('net').createConnection({host:'127.0.0.1',port:" + port + "});s.on('connect',()=>{console.log('up');s.destroy()});s.on('error',()=>{})",
    ], { encoding: 'utf8', timeout: 5000 });
    if (String(probe.stdout || '').includes('up')) return child;
    sleepSync(100);
  }
  throw new Error('squatter 未就绪');
}

/** 绑定文件里的 schema 用原始文本写入，用来造非法 JSON 数字。 */
function bindingTextWithSchema(ctx, rawSchema) {
  return '{"schema":' + rawSchema +
    ',"clientProfile":"' + ctx.profile +
    '","dataDir":' + JSON.stringify(ctx.dataDir) +
    ',"appDir":' + JSON.stringify(ctx.appDir) + '}';
}

function main() {
  assert(fs.existsSync(trayExe), '托盘二进制不存在：' + trayExe);

  test('四种 profile 使用各自的 UI 端口与 CDP 端口', () => {
    for (const profile of PROFILES) {
      const ctx = makeInstall('ports-' + profile, profile);
      writeBinding(ctx);
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
      assert(cdpC.split(',').includes(String(CDP_BASE[profile])),
        profile + ' CDP 候选必须包含默认端口，实际 ' + cdpC);
      if (profile === 'codebuddy-cn') assert(cdpC === '9224', 'codebuddy-cn 只应认 9224，实际 ' + cdpC);
      if (profile === 'codebuddy-intl') assert(cdpC === '9225', 'codebuddy-intl 只应认 9225，实际 ' + cdpC);
      if (profile === 'workbuddy-ai') assert(/^9223,9233,/.test(cdpC), 'AI 备用 CDP 应在 9233+，实际 ' + cdpC);
      if (profile === 'workbuddy-cn') assert(/^9222,9226,/.test(cdpC), 'CN 备用 CDP 应在 9226+，实际 ' + cdpC);
    }
  });

  test('绑定文件：合法 JSON 通过校验', () => {
    const ctx = makeInstall('json-ok', 'workbuddy-ai');
    writeBinding(ctx);
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

  test('绑定文件：JSON 数字严格语法（01 / 1. / 1e / +1 / 全角 / 溢出）', () => {
    const ctx = makeInstall('json-number', 'workbuddy-ai');
    const file = path.join(ctx.appDir, 'install-binding.json');

    // 合法的 1 / 1.0 / 1e0 都必须被当作 schema=1 接受
    for (const raw of ['1', '1.0', '1e0', '1E0', '1.0e0', '0.1e1']) {
      writeFile(file, bindingTextWithSchema(ctx, raw));
      const out = runTray(ctx, ['--check-binding', file], {}).cli;
      assert(/binding = ok: profile=workbuddy-ai/.test(out), 'schema=' + raw + ' 应通过：' + out);
    }

    // 非法数字：整份文档必须被拒，错误信息要说清「不是合法 JSON」
    const bad = [
      ['01', /前导零|不是合法 JSON/],
      ['-01', /前导零|不是合法 JSON/],
      ['1.', /小数点后|不是合法 JSON/],
      ['1e', /指数|不是合法 JSON/],
      ['1e+', /指数|不是合法 JSON/],
      ['+1', /不是合法 JSON/],
      ['-', /不是合法 JSON/],
      ['\uFF11', /不是合法 JSON/],          // 全角数字 1
      ['\u0661', /不是合法 JSON/],          // 阿拉伯-印度数字 1
      ['1e400', /不是合法 JSON/],           // double 溢出
      ['1e-400', /不是合法 JSON|schema 必须严格等于 1/],
      ['NaN', /不是合法 JSON/],
      ['Infinity', /不是合法 JSON/],
      ['1 2', /不是合法 JSON/],
      ['--1', /不是合法 JSON/],
    ];
    for (const [raw, pattern] of bad) {
      writeFile(file, bindingTextWithSchema(ctx, raw));
      const out = runTray(ctx, ['--check-binding', file], {}).cli;
      assert(pattern.test(out), 'schema=' + JSON.stringify(raw) + ' 应拒绝，实际：' + out);
    }
  });

  test('DataDir 身份：同 profile 但拿不到 dataDir 一律不算「我的 daemon」', () => {
    const ctx = makeInstall('identity-datadir', 'workbuddy-ai', { token: 'TOKEN_A' });
    writeBinding(ctx);
    const port = freePort();
    const child = startMockDaemon(ctx.root, {
      port, profile: 'workbuddy-ai', dataDir: ctx.dataDir, appDir: ctx.appDir, token: 'TOKEN_A',
    });
    try {
      const ok = runTray(ctx, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
      assert(/daemon\s+: running/.test(ok.cli), '同 profile + 正确 token + 同 dataDir 应 running：' + ok.cli);

      // 同 profile、另一个安装、另一个数据目录、另一个 token → 不能认领
      const other = makeInstall('identity-datadir-b', 'workbuddy-ai', { token: 'TOKEN_B' });
      writeBinding(other);
      const wrongToken = runTray(other, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
      assert(/daemon\s+: stopped/.test(wrongToken.cli),
        'token 不对就拿不到 dataDir，必须判 stopped：' + wrongToken.cli);

      // 没有 token 文件 → 不带 x-workdaddy-token → 同样拿不到 dataDir
      const noToken = makeInstall('identity-datadir-c', 'workbuddy-ai');
      writeBinding(noToken);
      const noTokenOut = runTray(noToken, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
      assert(/daemon\s+: stopped/.test(noTokenOut.cli), '缺 token 必须判 stopped：' + noTokenOut.cli);

      // 同 profile + 正确 token + 不同 dataDir → 拒绝
      const otherDir = makeInstall('identity-datadir-d', 'workbuddy-ai', { token: 'TOKEN_A' });
      writeBinding(otherDir);
      const different = runTray(otherDir, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
      assert(/daemon\s+: stopped/.test(different.cli), 'dataDir 不同必须判 stopped：' + different.cli);

      // 路径大小写不同 → 按 Windows 规则接受。
      // appDir 是安装归属的第二条证据：daemon 报的 appDir 必须就是这一份安装，
      // 所以这里用同一份安装 + 只把绑定里的 dataDir 换大小写。
      const caseCtx = makeInstall('identity-datadir-case', 'workbuddy-ai', { token: 'TOKEN_A' });
      const casePort = freePort();
      const caseDaemon = startMockDaemon(ctx.root, {
        port: casePort, profile: 'workbuddy-ai', dataDir: ctx.dataDir,
        appDir: caseCtx.appDir, token: 'TOKEN_A',
      });
      try {
        writeBinding(caseCtx, { dataDir: ctx.dataDir.toUpperCase() });
        const upper = runTray(caseCtx, ['--status'], { WORKDADDY_TRAY_PORT: String(casePort) });
        assert(/daemon\s+: running/.test(upper.cli), '大小写不同的同一路径应 running：' + upper.cli);
      } finally {
        try { caseDaemon.kill(); } catch (_) {}
      }
    } finally {
      try { child.kill(); } catch (_) {}
    }
  });

  test('DataDir 身份：认证通过但这些字段不对，也要判 stopped', () => {
    const ctx = makeInstall('identity-fields', 'workbuddy-ai', { token: 'TOKEN_A' });
    writeBinding(ctx);
    const port = freePort();

    const cases = [
      // 认证通过但 daemon 不返回 dataDir：身份证据不完整
      [{ omitDataDir: true }, /daemon\s+: stopped/],
      // 空字符串
      [{ dataDir: '' }, /daemon\s+: stopped/],
      // 相对路径
      [{ dataDir: 'data' }, /daemon\s+: stopped/],
      // 类型不是字符串
      [{ dataDir: 123 }, /daemon\s+: stopped/],
      // appDir 指向另一个安装
      [{ appDir: path.join(ctx.root, 'another-install') }, /daemon\s+: stopped/],
    ];
    for (const [override, pattern] of cases) {
      const cfg = Object.assign({
        port, profile: 'workbuddy-ai', dataDir: ctx.dataDir, appDir: ctx.appDir, token: 'TOKEN_A',
      }, override);
      const child = startMockDaemon(ctx.root, cfg);
      try {
        const out = runTray(ctx, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
        assert(pattern.test(out.cli), JSON.stringify(override) + ' 应判 stopped，实际：' + out.cli);
      } finally {
        try { child.kill(); } catch (_) {}
        sleepSync(300);
      }
    }
  });

  test('端口归属：兄弟 profile 的 daemon 不能被认成自己', () => {
    const ctx = makeInstall('identity', 'workbuddy-ai', { token: 'TOKEN_A' });
    writeBinding(ctx);
    const port = freePort();
    const child = startMockDaemon(ctx.root, {
      port, profile: 'workbuddy-cn', dataDir: ctx.dataDir, appDir: ctx.appDir, token: 'TOKEN_A',
    });
    try {
      const r = runTray(ctx, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
      assert(/daemon\s+: stopped/.test(r.cli), '兄弟 profile 的 daemon 不能被当成自己：' + r.cli);
    } finally {
      try { child.kill(); } catch (_) {}
    }
  });

  test('端口被占用时不误判：端口上不是我们的服务就判 stopped', () => {
    const ctx = makeInstall('occupied', 'workbuddy-ai', { token: 'TOKEN_A' });
    writeBinding(ctx);
    const port = freePort();
    startSquatter(ctx.root, port);
    const r = runTray(ctx, ['--status'], { WORKDADDY_TRAY_PORT: String(port) });
    assert(/daemon\s+: stopped/.test(r.cli), '不应答 /api/status 的服务不能被当成 daemon：' + r.cli);
  });

  test('CDP：以 daemon 的 cdp.connected / cdp.port 为准，端口开着不算连上', () => {
    const ctx = makeInstall('cdp', 'workbuddy-ai', { token: 'TOKEN_A' });
    writeBinding(ctx);
    const port = freePort();

    const runWith = (cdp) => {
      const child = startMockDaemon(ctx.root, {
        port, profile: 'workbuddy-ai', dataDir: ctx.dataDir, appDir: ctx.appDir, token: 'TOKEN_A', cdp,
      });
      try {
        return runTray(ctx, ['--status'], { WORKDADDY_TRAY_PORT: String(port) }).cli;
      } finally {
        try { child.kill(); } catch (_) {}
        sleepSync(300);
      }
    };

    // 端口开着（我们的 mock 就在这个端口上）但 daemon 说没连
    let out = runWith({ connected: false, port: null });
    assert(/cdp\s+: disconnected/.test(out), 'connected=false 必须判断开：' + out);

    // 缺失 / 类型错误
    out = runWith({ port: 9223 });
    assert(/cdp\s+: disconnected/.test(out), '缺 connected 必须判断开：' + out);
    out = runWith({ connected: 'true', port: 9223 });
    assert(/cdp\s+: disconnected/.test(out), 'connected 不是布尔必须判断开：' + out);
    out = runWith({ connected: true });
    assert(/cdp\s+: disconnected/.test(out), '缺 port 必须判断开：' + out);
    out = runWith({ connected: true, port: '9223' });
    assert(/cdp\s+: disconnected/.test(out), 'port 不是数字必须判断开：' + out);
    out = runWith({ connected: true, port: 9223.5 });
    assert(/cdp\s+: disconnected/.test(out), 'port 不是整数必须判断开：' + out);
    out = runWith({ connected: true, port: 99999 });
    assert(/cdp\s+: disconnected/.test(out), 'port 越界必须判断开：' + out);
    // 兄弟 profile 的 CDP 端口对当前 profile 不算合法候选
    out = runWith({ connected: true, port: 9222 });
    assert(/cdp\s+: disconnected/.test(out), '别的 profile 的 CDP 端口必须判断开：' + out);

    // 合法连接：备用端口 9233 也要认，并且状态里显示实际端口
    out = runWith({ connected: true, port: 9233 });
    assert(/cdp\s+: connected/.test(out), 'connected=true + 合法备用端口应判连接：' + out);
    assert(/ports\s+: ui=\d+ cdp=9233/.test(out), '状态应显示实际 CDP 端口 9233：' + out);

    // 默认 CDP 端口 9223 被无关程序占着，实际连的是 9233：不能被 9223 骗到
    startSquatter(ctx.root, 9223);
    out = runWith({ connected: true, port: 9233 });
    assert(/cdp\s+: connected/.test(out), '备用端口场景应判连接：' + out);
    assert(!/cdp=9223\b/.test(out), '不能把被占用的默认端口当成实际端口：' + out);
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

  test('管理页与工具提示：跟着当前 profile 的实际 UI 端口，不写死 47832', () => {
    const cs = fs.readFileSync(path.join(repo, 'tray', 'WorkDaddyTray.cs'), 'utf8');
    assert(!/打开 http:\/\/127\.0\.0\.1:47832/.test(cs), 'tooltip 不得写死 47832');
    assert(/private static string OpenPageTip\(\)/.test(cs), '应有统一的 OpenPageTip()');
    assert(/s_open = AddItem\("打开管理页", OpenPageTip\(\)\)/.test(cs), '构建菜单应使用 OpenPageTip()');
    assert(/s_open\.ToolTipText = OpenPageTip\(\);/.test(cs), '状态刷新应同步 tooltip（备用端口会变）');
    assert(/Process\.Start\(DaemonUri \+ "\/"\)/.test(cs), '打开管理页应使用 DaemonUri');
  });

  test('多实例边界：托盘 Mutex 按 profile 隔离，StopWd 只认自己的实例', () => {
    const cs = fs.readFileSync(path.join(repo, 'tray', 'WorkDaddyTray.cs'), 'utf8');
    // B 架构：不同 profile 可以同时运行，所以托盘的 Mutex 也必须按 profile 分。
    // 名字只由白名单里的 profile 拼出来，不接受任意环境变量。
    assert(/Local\\WorkDaddyTraySingleton_" \+ s_profile/.test(cs), '托盘 Mutex 应按 profile 生成');
    assert(!/@"Local\\WorkDaddyTraySingleton"/.test(cs), '不应再使用全局 Mutex 名');
    // StopWd 先做归属校验（profile + appDir + 命令行），再动手。
    assert(/private static string ReadOwnership\(out int watchdogPid, out int daemonPid,\s*out string instanceId/.test(cs),
      'StopWd 应先做归属校验（含 instanceId）');
    assert(/instanceId 不是 32 位十六进制|IsInstanceId/.test(cs),
      '归属校验必须验证 instanceId 是 32 位十六进制');
    assert(/属于另一个安装/.test(cs), 'StopWd 应拒绝停止别的安装的服务');
    assert(/拒绝停止/.test(cs), 'StopWd 应在身份不明时拒绝');
    assert(/dataDir 与本实例不一致/.test(cs), '状态文件的 dataDir 必须与当前绑定一致');
    // 超时兜底不得退化成「按目录枚举 daemon.js」：CN 与 AI 可能共用一个 AppDir。
    assert(/DaemonOwnershipProof/.test(cs), 'StopWd 必须有 daemon 归属证明入口');
    assert(/\.daemon\.lock/.test(cs), '证明必须用到 daemon 自己写的 .daemon.lock');
    assert(!/OwnedDaemonProcesses/.test(cs), '不得再按目录枚举 daemon.js 结束进程');
    const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    assert(/同一 ?Profile/.test(readme), 'README 必须写明同一 profile 单实例');
    assert(/可以同时运行/.test(readme), 'README 必须写明不同 profile 可以同时运行');
  });
}

try {
  main();
} finally {
  for (const child of children) {
    try { child.kill(); } catch (_) {}
  }
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  }
}
if (failures > 0) {
  console.error(`FAIL tray-ports-binding.test.js (${failures} 项失败)`);
  process.exit(1);
}
console.log('PASS tray-ports-binding.test.js');
