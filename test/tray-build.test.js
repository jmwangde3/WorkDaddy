'use strict';
/**
 * 托盘 EXE 可复现构建与源码对应关系
 *
 *   node --test test/tray-build.test.js
 *
 * 三件事：
 *   1. 用系统自带 csc.exe 把 tray\WorkDaddyTray.cs 现编一份到 tmp，构建清单必须完整
 *      （编译器版本、完整参数、源码与产物哈希）。CI 上这是硬门槛。
 *   2. 现编产物跑 --selftest / --status；仓库里那份已提交的 EXE 也跑一遍，
 *      两次输出归一化后必须一致 —— 这是「二进制与源码对应」的功能证据。
 *   3. 字符串覆盖：源码里的字符串字面量必须都能在 EXE 里找到（正查），
 *      EXE 里的中文界面串必须都来自当前源码（反查）。
 *      正查防「EXE 是旧的、缺新功能」，反查防「EXE 里有源码已删掉的旧 UI」。
 *
 * 不做的事：不做字节比对。.NET Framework 的 csc 会把 MVID 与链接时间戳写进 PE，
 * 同一份源码两次编译也不会字节相同；能证明的是「同一份源码、同一套参数、同一套行为」。
 *
 * 本机安全：--selftest 会临时改写并还原 HKCU\...\Run\WorkDaddyTray，
 * 测试只断言它自己报 restored=True，不主动改注册表。
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const repo = path.join(__dirname, '..');
const sourceCs = path.join(repo, 'tray', 'WorkDaddyTray.cs');
const committedExe = path.join(repo, 'tray', 'WorkDaddyTray.exe');
const buildPs1 = path.join(repo, 'installer', 'build-tray.ps1');
const buildCmd = path.join(repo, 'tray', 'build.cmd');

const roots = [];
function tmpRoot(tag) {
  const base = path.join(repo, 'tmp');
  fs.mkdirSync(base, { recursive: true });
  const d = fs.mkdtempSync(path.join(base, `tray-${tag}-`));
  roots.push(d);
  return d;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  for (const f of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/** 跑托盘：GUI 子系统没有 stdout，结果看 %TEMP%\WorkDaddyTray-cli.txt。 */
function runTray(exe, action, tempDir, extraEnv) {
  const cli = path.join(tempDir, 'WorkDaddyTray-cli.txt');
  try { fs.rmSync(cli, { force: true }); } catch (_) {}
  const env = Object.assign({}, process.env, { TEMP: tempDir, TMP: tempDir }, extraEnv || {});
  const res = spawnSync(exe, [action], { encoding: 'utf8', timeout: 60000, env });
  let text = '';
  if (fs.existsSync(cli)) text = fs.readFileSync(cli, 'utf8');
  return { status: res.status, text: text.trim(), stderr: res.stderr || '' };
}

/**
 * 造一个假的 scripts 目录。
 *
 * 为什么要这么干：托盘用 ResolveScripts() 找脚本目录，候选里既有
 * %LOCALAPPDATA%\Programs\WorkDaddy\scripts，也有「exe 同级的 ../scripts」。
 * 于是同一台机器上，仓库里那份 EXE（在 tray\ 下）会认到仓库自带的 scripts\，
 * 而现编产物（在 tmp\tray-xxx\ 下）认不到 —— 两个二进制的输出差别来自
 * 「它站在哪个目录」，跟源码版本毫无关系。开发机上 %LOCALAPPDATA% 那份
 * 恰好存在，两边都命中第一个候选，这个坑就被盖住了；CI 上没装过，坑就露出来。
 *
 * 用 WORKDADDY_SCRIPTS 钉住同一个目录，比较的才是二进制本身。
 */
function makeScriptsFixture(dir, opts) {
  const withLauncher = !(opts && opts.bare);
  fs.mkdirSync(dir, { recursive: true });
  // daemon.js 是 ResolveScripts 认目录的凭据，必须存在
  fs.writeFileSync(path.join(dir, 'daemon.js'), '// fixture: 只为满足 File.Exists\n');
  if (withLauncher) {
    fs.writeFileSync(path.join(dir, 'launcher.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(dir, 'watchdog.js'), '// fixture\n');
  }
  return dir;
}

/** 去掉随环境变化的行（exe 路径、进程数、端口状态），只留结构。 */
function normalizeCli(text) {
  return text.split(/\r?\n/).map((line) => {
    if (/^exe\s*:/.test(line)) return 'exe       : <path>';
    if (/^wd processes\s*:/.test(line)) return 'wd processes : <n>';
    if (/^processes\s*:/.test(line)) return 'processes : <n>';
    if (/^daemon\s+\d/.test(line)) return 'daemon    : <bool>';
    if (/^cdp\s+\d/.test(line)) return 'cdp       : <bool>';
    if (/^autostart\s*:/.test(line)) return 'autostart : <bool>';
    if (/^wd scripts/.test(line)) return 'wd scripts: <path>';
    return line.trim();
  }).filter(Boolean).join('\n');
}

/**
 * 直接解析 .NET 元数据的 #US（user string）堆，取到精确的字符串字面量。
 *
 * 为什么不用「扫 UTF-16 可打印串」那种土办法：#US 堆里每条是
 * `[压缩长度][UTF-16 数据][1 字节标志]`，长度前缀可能刚好落在某个可打印码位里，
 * 相邻两条就被粘成一条（实测会得到 `圁只启动后台服务…` 这种串），
 * 于是「源码里有、EXE 里找不到」的假失败。按结构解析没有这个问题。
 */
function readCompressedUint(buf, off) {
  const b = buf[off];
  if ((b & 0x80) === 0) return { value: b, next: off + 1 };
  if ((b & 0xc0) === 0x80) return { value: ((b & 0x3f) << 8) | buf[off + 1], next: off + 2 };
  if ((b & 0xe0) === 0xc0) {
    return {
      value: ((b & 0x1f) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3],
      next: off + 4,
    };
  }
  throw new Error('#US 堆里出现非法的压缩长度前缀 @' + off);
}

function userStrings(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  assert.equal(buf.toString('latin1', pe, pe + 4), 'PE\u0000\u0000', '不是 PE 文件：' + file);

  const numSections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dirOff = magic === 0x20b ? opt + 112 : opt + 96;
  const cliRva = buf.readUInt32LE(dirOff + 14 * 8);
  if (!cliRva) throw new Error('没有 CLI 头（不是托管程序集）：' + file);

  const sections = [];
  const secStart = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secStart + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      vsize: buf.readUInt32LE(s + 8),
      rawSize: buf.readUInt32LE(s + 16),
      rawPtr: buf.readUInt32LE(s + 20),
    });
  }
  const rva2off = (rva) => {
    for (const s of sections) {
      const size = Math.max(s.vsize, s.rawSize);
      if (rva >= s.va && rva < s.va + size) return rva - s.va + s.rawPtr;
    }
    throw new Error('RVA 不在任何节里：0x' + rva.toString(16));
  };

  const cli = rva2off(cliRva);
  const mdRva = buf.readUInt32LE(cli + 8);
  const md = rva2off(mdRva);
  assert.equal(buf.readUInt32LE(md), 0x424a5342, '元数据签名不对');
  const verLen = buf.readUInt32LE(md + 12);
  // 对齐是相对元数据根算的，不是相对文件偏移 —— 元数据不一定落在 4 的倍数上
  let p = md + 16 + ((verLen + 3) & ~3);
  const streamCount = buf.readUInt16LE(p + 2);
  p += 4;
  let usOff = -1;
  let usSize = 0;
  for (let i = 0; i < streamCount; i++) {
    const off = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    const nameStart = p + 8;
    let nameEnd = nameStart;
    while (buf[nameEnd] !== 0) nameEnd++;
    const name = buf.toString('latin1', nameStart, nameEnd);
    if (name === '#US') { usOff = md + off; usSize = size; }
    p = nameStart + (((nameEnd - nameStart + 1) + 3) & ~3);
  }
  assert.notEqual(usOff, -1, '元数据里没有 #US 堆');

  const out = new Set();
  let off = usOff;
  const end = usOff + usSize;
  while (off < end) {
    const { value: len, next } = readCompressedUint(buf, off);
    // 堆开头固定有一个 0x00（空字符串占位），后面才是真正的字面量
    if (len === 0) { off = next; continue; }
    const dataLen = len - 1; // 末字节是标志位
    if (dataLen > 0) out.add(buf.toString('utf16le', next, next + dataLen));
    off = next + len;
  }
  return out;
}

/** 字面量是否出现在文件里：#US 堆（ldstr）或元数据 #Strings（UTF-8，如 DllImport 模块名）。 */
function hasLiteral(file, set, s) {
  if (set.has(s)) return true;
  // #Strings 堆是 UTF-8；DllImport("kernel32.dll") 这类名字只在那里
  return fs.readFileSync(file).includes(Buffer.from(s, 'utf8'));
}

/** 解析 C# 字符串字面量（普通串 + 逐字串），按 C# 规则反转义。 */
function sourceLiterals(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  const push = (raw, verbatim) => {
    let s = raw;
    if (verbatim) {
      s = s.split('""').join('"');
    } else {
      s = s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, e) => {
        if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
        return { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', '0': '\0' }[e] || e;
      });
    }
    if (s.trim().length >= 2) out.add(s);
  };
  // 逐字串 @"..."（内部用 "" 表示一个引号）
  for (const m of src.matchAll(/@"((?:[^"]|"")*)"/g)) push(m[1], true);
  const withoutVerbatim = src.replace(/@"(?:[^"]|"")*"/g, '@""');
  for (const m of withoutVerbatim.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) push(m[1], false);
  return out;
}

function test(name, fn) {
  if (!isWin) { console.log(`SKIP ${name} (非 Windows)`); return; }
  fn();
  console.log(`ok - ${name}`);
}

function main() {
  assert.ok(fs.existsSync(sourceCs), '托盘源码存在');
  assert.ok(fs.existsSync(buildPs1), '构建脚本存在');
  assert.ok(fs.existsSync(buildCmd), '双击构建脚本存在');
  assert.ok(fs.existsSync(committedExe), '仓库里的 EXE 未被删除（本轮决策：CI 稳定前保留）');

  const csc = findCsc();
  if (!csc) {
    console.log('SKIP 托盘编译：本机没有 .NET Framework 4.x 的 csc.exe');
    console.log('SKIP 托盘行为对比：需要先能编译');
    test('托盘：构建参数在 build.cmd 与 build-tray.ps1 之间一致', () => {
      const cmdText = fs.readFileSync(buildCmd, 'utf8');
      const psText = fs.readFileSync(buildPs1, 'utf8');
      for (const flag of ['/nologo', '/target:winexe', '/optimize+', '/codepage:65001',
        '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll',
        '/r:System.Drawing.dll', '/r:System.Management.dll']) {
        assert.ok(cmdText.includes(flag), 'build.cmd 缺参数 ' + flag);
        assert.ok(psText.includes(flag), 'build-tray.ps1 缺参数 ' + flag);
      }
    });
    return;
  }

  // ==================== 1. 现编一份 ====================

  const root = tmpRoot('build');
  const outExe = path.join(root, 'WorkDaddyTray.exe');
  const manifestPath = path.join(root, 'build.json');
  const res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', buildPs1,
    '-SourcePath', sourceCs,
    '-OutputPath', outExe,
    '-ManifestPath', manifestPath,
    '-Verify',
    '-Json', path.join(root, 'report.json'),
  ], { encoding: 'utf8', timeout: 300000, env: Object.assign({}, process.env, { TEMP: root, TMP: root }) });

  assert.equal(res.status, 0, '托盘编译失败：' + (res.stdout || '') + (res.stderr || ''));
  assert.ok(fs.existsSync(outExe), '编译产物不存在');
  assert.ok(fs.existsSync(manifestPath), '构建清单不存在');

  test('托盘：构建清单记录编译器版本与完整参数', () => {
    const m = readJson(manifestPath);
    assert.equal(m.schema, 1);
    assert.equal(m.ok, true);
    assert.match(m.compiler.path, /csc\.exe$/i);
    assert.match(m.compiler.framework, /^Framework(64)?$/);
    assert.match(m.compiler.fileVersion, /^\d+\.\d+/);
    assert.ok(m.arguments.some((a) => a === '/target:winexe'));
    assert.ok(m.arguments.some((a) => a === '/codepage:65001'));
    assert.ok(m.arguments.some((a) => a === '/out:' + outExe));
    assert.equal(m.source.sha256, sha256(sourceCs), '源码哈希与磁盘不符');
    assert.equal(m.output.sha256, sha256(outExe), '产物哈希与磁盘不符');
    assert.equal(m.output.size, fs.statSync(outExe).size);
    // 六个引用必须齐 —— 少一个会在某些机器上编译失败
    assert.equal(m.arguments.filter((a) => a.startsWith('/r:')).length, 5);
  });

  test('托盘：--selftest 通过且自动启动项被还原', () => {
    const r = runTray(outExe, '--selftest', root);
    assert.match(r.text, /=== WorkDaddyTray\.exe self-test ===/);
    assert.match(r.text, /launcher\s*: exists=(True|False)/);
    assert.match(r.text, /watchdog\s*: exists=(True|False)/);
    // 最后一行打印的是「测试结束时的自启动状态」，不是布尔判断结果：
    // 开发机上本来开着（was=True → restored=True），CI 上本来没开（was=False → restored=False）。
    // 真正的不变量是「结束时 == 开始时」，不是「一定为 True」。
    const m = r.text.match(/autostart RT : was=(\w+) on=(\w+) mid=(\w+) off=(\w+) end=(\w+) restored=(\w+)/);
    assert.ok(m, '--selftest 缺 autostart RT 结果行：' + r.text);
    assert.equal(m[2], 'True', 'on 应写入成功');
    assert.equal(m[3], 'True', 'mid 应读到刚写入的值');
    // off 是 DeleteValue 的返回值，即便删成功也可能报 False（键本来就不存在时），
    // 所以不把它当承诺；真正要看的「关掉之后读回是关的」。
    assert.equal(m[5], 'False', 'end 应读到已删除');
    assert.equal(m[6], m[1], '自启动项必须还原到测试前的值');
    assert.match(r.text, /SELF-TEST OK/);
  });

  test('托盘：--status 五个字段齐全', () => {
    const r = runTray(outExe, '--status', root);
    for (const k of ['daemon', 'cdp', 'processes', 'autostart', 'wd scripts']) {
      assert.ok(new RegExp('^' + k, 'm').test(r.text), '--status 缺 ' + k + '：' + r.text);
    }
  });

  // ==================== 2. 与已提交的 EXE 对比 ====================

  test('托盘：仓库 EXE 与现编产物的 CLI 行为一致', () => {
    // 两个二进制必须看着同一个 scripts 目录，否则比的是「谁站在哪个目录」
    const full = makeScriptsFixture(path.join(root, 'fx-full'));
    const envFull = { WORKDADDY_SCRIPTS: full };

    const freshSelf = normalizeCli(runTray(outExe, '--selftest', root, envFull).text);
    const repoSelf = normalizeCli(runTray(committedExe, '--selftest', root, envFull).text);
    assert.equal(repoSelf, freshSelf, '仓库 EXE 的 --selftest 输出与现编产物不一致（二进制可能对应旧源码）');

    // 确认真的是「看着同一个目录」在比，而不是碰巧两边都看错到同一个地方
    const freshRaw = runTray(outExe, '--selftest', root, envFull).text;
    const repoRaw = runTray(committedExe, '--selftest', root, envFull).text;
    assert.ok(freshRaw.includes('wd scripts : ' + full), '现编产物没用 WORKDADDY_SCRIPTS 指定的目录：' + freshRaw);
    assert.ok(repoRaw.includes('wd scripts : ' + full), '仓库 EXE 没用 WORKDADDY_SCRIPTS 指定的目录：' + repoRaw);

    const freshStatus = normalizeCli(runTray(outExe, '--status', root, envFull).text);
    const repoStatus = normalizeCli(runTray(committedExe, '--status', root, envFull).text);
    assert.equal(repoStatus, freshStatus, '仓库 EXE 的 --status 输出与现编产物不一致');

    // 光「两边一样」不够：两边一样地看错目录也是一样的。钉死这个分支的真实取值。
    assert.match(freshSelf, /^launcher\s*: exists=True$/m, '有 launcher.cmd 时应报 True');
    assert.match(freshSelf, /^watchdog\s*: exists=True$/m, '有 watchdog.js 时应报 True');

    // 反过来再验一遍「目录里没有就是 False」，两条分支都落到断言上
    const bare = makeScriptsFixture(path.join(root, 'fx-bare'), { bare: true });
    const envBare = { WORKDADDY_SCRIPTS: bare };
    const bareFresh = normalizeCli(runTray(outExe, '--selftest', root, envBare).text);
    const bareRepo = normalizeCli(runTray(committedExe, '--selftest', root, envBare).text);
    assert.equal(bareRepo, bareFresh, '空 scripts 目录下两个 EXE 的行为仍应一致');
    assert.match(bareFresh, /^launcher\s*: exists=False$/m, '没有 launcher.cmd 时应报 False');
    assert.match(bareFresh, /^watchdog\s*: exists=False$/m, '没有 watchdog.js 时应报 False');
  });

  test('托盘：源码字面量全部能在两个 EXE 里找到（正查）', () => {
    const lits = [...sourceLiterals(sourceCs)];
    assert.ok(lits.length >= 80, '解析出的字面量太少，解析器可能坏了：' + lits.length);
    const fresh = userStrings(outExe);
    const repoStrs = userStrings(committedExe);
    // 被别的字面量包含的短串不单独要求：C# 编译器会把 const 拼接折成一个整串
    // （例如 "http://" + Host + ":" + Port），那个片段就不会单独进 #US 堆。
    const standalone = lits.filter((s) => !lits.some((o) => o !== s && o.includes(s)));
    const missingFresh = standalone.filter((s) => !hasLiteral(outExe, fresh, s));
    const missingRepo = standalone.filter((s) => !hasLiteral(committedExe, repoStrs, s));
    assert.deepEqual(missingFresh.slice(0, 10), [], '现编产物缺源码字面量（编译器/编码问题）');
    assert.deepEqual(missingRepo.slice(0, 10), [], '仓库 EXE 缺当前源码里的字面量：' + missingRepo.slice(0, 10).join(' | '));
  });

  test('托盘：EXE 里的中文界面串都来自当前源码（反查）', () => {
    const lits = [...sourceLiterals(sourceCs)];
    const known = (s) => lits.some((l) => l === s || l.includes(s) || s.includes(l));
    const stale = [];
    for (const exe of [outExe, committedExe]) {
      for (const s of userStrings(exe)) {
        if (!/[\u4e00-\u9fff]/.test(s)) continue;
        if (s.length < 3) continue;
        if (!known(s)) stale.push(path.basename(exe) + ' :: ' + s.slice(0, 60));
      }
    }
    assert.deepEqual(stale.slice(0, 10), [], 'EXE 里有当前源码已不存在的中文串：' + stale.slice(0, 10).join(' | '));
  });

  test('托盘：仓库 EXE 不是空壳，且与源码同代（体积与时间戳）', () => {
    const exeSize = fs.statSync(committedExe).size;
    const csSize = fs.statSync(sourceCs).size;
    assert.ok(exeSize > 8000, 'EXE 太小，可能是占位文件：' + exeSize);
    assert.ok(exeSize > csSize * 0.4, 'EXE 体积与源码规模不匹配：exe=' + exeSize + ' cs=' + csSize);
    const freshSize = fs.statSync(outExe).size;
    const delta = Math.abs(exeSize - freshSize) / freshSize;
    assert.ok(delta < 0.15, '仓库 EXE 与现编产物体积差 ' + (delta * 100).toFixed(1) + '%（超过 15% 说明源码改过但没重新编译）');
  });
}

try {
  main();
  console.log('PASS tray-build.test.js');
} catch (error) {
  console.error('FAIL tray-build.test.js:', error);
  process.exitCode = 1;
} finally {
  for (const d of roots) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) {}
  }
}
