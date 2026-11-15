// 安装/卸载的路径边界。
//
// 卸载器按 install-state.json 里的相对路径拼出绝对路径再删。这份记录是本地
// JSON，可以被改；AppDir 也可能被指到盘根或用户主目录。只比较字符串前缀
// （StartsWith）挡不住这些：
//   - AppDir = C:\Users\me 时，清单里的 \scripts\daemon.js 拼出来确实在它内部；
//   - AppDir 是 junction 时，删的其实是它指向的目录。
// 所以边界必须是「归一化 + 拒绝受保护目录 + 展开重解析点后再判一次」。
//
// 这些用例全部在临时目录里跑，不碰真实安装。
const test = require('node:test');
const fx = require('./helpers/installer-fixture');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { assert } = fx;

// 错误文本优先取 JSON 报告：helper 进程写管道时按控制台代码页（中文机器 936），
// 中文会变乱码；报告文件是 UTF-8，能拿到原文。
function errorText(r) {
  if (r && r.report && r.report.error) return String(r.report.error);
  return String(((r && r.stdout) || '') + ((r && r.stderr) || ''));
}

function runUninstall(args, tempDir) {
  return fx.runPs(fx.uninstallPs1, args, tempDir);
}

test('卸载：AppDir 指向盘根时拒绝', () => {
  const root = fx.tmpRoot('bound-root');
  try {
    const dataDir = path.join(root, 'data');
    fx.writeFile(path.join(dataDir, 'install-state.json'), JSON.stringify({ files: [], appDir: 'C:\\', dataDir }));
    const r = runUninstall(['-AppDir', 'C:\\', '-DataDir', dataDir], root);
    assert.notEqual(r.code, 0, '盘根不能被当成安装目录');
    assert.match(errorText(r), /盘根|受保护|拒绝/, '应给出明确拒绝理由，实际：' + errorText(r));
  } finally { fx.cleanup(root); }
});

test('卸载：AppDir 指向用户主目录时拒绝', () => {
  const root = fx.tmpRoot('bound-home');
  try {
    const dataDir = path.join(root, 'data');
    fx.writeFile(path.join(dataDir, 'install-state.json'), JSON.stringify({ files: [], appDir: os.homedir(), dataDir }));
    const r = runUninstall(['-AppDir', os.homedir(), '-DataDir', dataDir], root);
    assert.notEqual(r.code, 0, '用户主目录不能被当成安装目录');
    assert.match(errorText(r), /受保护|拒绝/, '应给出明确拒绝理由，实际：' + errorText(r));
  } finally { fx.cleanup(root); }
});

test('卸载：AppDir 含路径穿越时拒绝', () => {
  const root = fx.tmpRoot('bound-dotdot');
  try {
    const dataDir = path.join(root, 'data');
    // 注意不能用 path.join：它会把 .. 归一化掉，这里要的就是「原始输入里带 ..」
    const sneaky = path.join(root, 'app') + '\\..\\..\\escape';
    fx.writeFile(path.join(dataDir, 'install-state.json'), JSON.stringify({ files: [], appDir: dataDir, dataDir }));
    const r = runUninstall(['-AppDir', sneaky, '-DataDir', dataDir], root);
    assert.notEqual(r.code, 0, '含 .. 的路径必须拒绝');
    assert.match(errorText(r), /路径穿越|\.\./, '应指出路径穿越，实际：' + errorText(r));
  } finally { fx.cleanup(root); }
});

test('卸载：安装目录与数据目录重叠时拒绝', () => {
  const root = fx.tmpRoot('bound-overlap');
  try {
    const appDir = path.join(root, 'app');
    const dataDir = path.join(appDir, 'data');
    fx.writeFile(path.join(dataDir, 'install-state.json'), JSON.stringify({ files: [], appDir, dataDir }));
    const r = runUninstall(['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.notEqual(r.code, 0, 'DataDir 在 AppDir 内部时必须拒绝');
    assert.match(errorText(r), /重叠|包含/, '应指出重叠，实际：' + errorText(r));
  } finally { fx.cleanup(root); }
});

test('卸载：安装记录被改成越界 AppDir 时拒绝', () => {
  const root = fx.tmpRoot('bound-record');
  try {
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    fx.writeFile(path.join(appDir, 'scripts', 'daemon.js'), '// x');
    // 记录里把 appDir 改成用户主目录：命令行参数是安全的，但记录不可信
    fx.writeFile(path.join(dataDir, 'install-state.json'), JSON.stringify({
      files: [{ path: 'scripts\\daemon.js', sha256: 'x' }],
      appDir: os.homedir(),
      dataDir,
    }));
    const r = runUninstall(['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.notEqual(r.code, 0, '记录里的越界 AppDir 必须拒绝');
    assert.match(errorText(r), /受保护|拒绝/, '应给出明确拒绝理由，实际：' + errorText(r));
    assert.ok(fs.existsSync(path.join(appDir, 'scripts', 'daemon.js')), '真实安装目录里的文件不能被牵连');
  } finally { fx.cleanup(root); }
});

test('卸载：清理数据时记录里的 dataDir 与实际不一致就拒绝', () => {
  const root = fx.tmpRoot('bound-purge');
  try {
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const otherData = path.join(root, 'other-data');
    fx.writeFile(path.join(appDir, 'scripts', 'daemon.js'), '// x');
    fx.writeFile(path.join(dataDir, 'keep.txt'), 'user data');
    fx.writeFile(path.join(dataDir, 'install-state.json'), JSON.stringify({
      files: [{ path: 'scripts\\daemon.js', sha256: fx.sha256(path.join(appDir, 'scripts', 'daemon.js')) }],
      appDir,
      dataDir: otherData,
    }));
    const r = runUninstall(['-AppDir', appDir, '-DataDir', dataDir, '-PurgeData', '-YesPurgeData'], root);
    assert.notEqual(r.code, 0, '记录与实际数据目录不一致时必须拒绝清理');
    assert.ok(fs.existsSync(path.join(dataDir, 'keep.txt')), '用户数据必须还在');
  } finally { fx.cleanup(root); }
});

test('卸载：正常路径不受边界校验影响，照常删程序留数据', () => {
  const root = fx.tmpRoot('bound-normal');
  try {
    const src = fx.makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    fx.seedInstall(root, { version: '1.3.1', sourceDir: src, appDir, dataDir });
    fx.writeFile(path.join(dataDir, 'config.json'), '{"keep":true}');
    const r = runUninstall(['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, '正常路径不该被拦：' + r.out + r.err);
    assert.ok(fs.existsSync(path.join(dataDir, 'config.json')), '默认必须保留用户数据');
  } finally { fx.cleanup(root); }
});

// ---- -PurgeData 的归属证明 ----
// 清理会清空整个 DataDir。只要「记录里没写 dataDir」就跳过比对直接删，
// 等于把清空哪个目录交给了缺失字段 —— 记录不完整时必须拒绝。
test('卸载：-PurgeData 时记录里没有 dataDir 就拒绝清理', () => {
  const root = fx.tmpRoot('purge-no-datadir');
  try {
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    fx.writeFile(path.join(appDir, 'scripts', 'daemon.js'), '// x');
    fx.writeFile(path.join(dataDir, 'keep.txt'), 'user data');
    fx.writeFile(path.join(dataDir, 'install-state.json'), JSON.stringify({
      files: [{ path: 'scripts\\daemon.js', sha256: fx.sha256(path.join(appDir, 'scripts', 'daemon.js')) }],
      appDir,
      dataDir: '',
    }));
    const r = runUninstall(['-AppDir', appDir, '-DataDir', dataDir, '-PurgeData', '-YesPurgeData'], root);
    assert.notEqual(r.code, 0, '没有归属证明就不能清理');
    assert.match(errorText(r), /dataDir|归属|拒绝/, '应说明缺的是归属证明，实际：' + errorText(r));
    assert.ok(fs.existsSync(path.join(dataDir, 'keep.txt')), '用户数据必须还在');
  } finally { fx.cleanup(root); }
});

// ---- 快捷方式归属 ----
// install-state.json 可以被改成任意路径。只要「路径存在」就 Remove-Item，
// 这份记录就变成了一个任意文件删除入口。
const MK_LNK = [
  'param([string]$Lnk = "", [string]$Target = "", [string]$Arguments = "", [string]$Json = "")',
  '$shell = New-Object -ComObject WScript.Shell',
  '$sc = $shell.CreateShortcut($Lnk)',
  '$sc.TargetPath = $Target',
  'if ($Arguments) { $sc.Arguments = $Arguments }',
  '$sc.Save()',
].join('\r\n');

function makeLnk(root, file, target) {
  const maker = path.join(root, 'mk-lnk.ps1');
  fx.writeFile(maker, MK_LNK);
  fx.runPs(maker, ['-Lnk', file, '-Target', target], root);
  assert.ok(fs.existsSync(file), '前置：快捷方式应已创建 ' + file);
}

test('卸载：记录里的快捷方式指向任意文件时保留，不执行删除', () => {
  const root = fx.tmpRoot('lnk-arbitrary');
  try {
    const src = fx.makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const victim = path.join(root, 'important.txt');
    fx.writeFile(victim, 'do not delete');
    fx.seedInstall(root, { version: '1.3.1', sourceDir: src, appDir, dataDir, shortcut: victim });

    const r = runUninstall(['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, '快捷方式被保留不该让卸载失败：' + r.out + r.err);
    assert.ok(fs.existsSync(victim), '记录里写的路径不是我们建的快捷方式，不能删');
    assert.equal(r.report.shortcut.removed, false);
    assert.match(String(r.report.shortcut.reason), /\.lnk|桌面|开始菜单/, '要说明为什么不删');
  } finally { fx.cleanup(root); }
});

test('卸载：只删目标指向本次安装的桌面快捷方式', () => {
  const root = fx.tmpRoot('lnk-owned');
  try {
    const desktop = path.join(root, 'desktop');
    fs.mkdirSync(desktop, { recursive: true });
    const src = fx.makeSource(root, '1.3.1');

    // 1) 桌面上的 .lnk，但目标是记事本 —— 不是我们建的，必须保留
    const foreign = path.join(desktop, 'WorkDaddy.lnk');
    makeLnk(root, foreign, path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'notepad.exe'));
    const appDirA = path.join(root, 'app-a');
    const dataDirA = path.join(root, 'data-a');
    fx.seedInstall(root, { version: '1.3.1', sourceDir: src, appDir: appDirA, dataDir: dataDirA, shortcut: foreign });
    const a = runUninstall(['-AppDir', appDirA, '-DataDir', dataDirA, '-DesktopDir', desktop], root);
    assert.equal(a.code, 0, a.out + a.err);
    assert.ok(fs.existsSync(foreign), '目标指向别处的快捷方式不能删');
    assert.equal(a.report.shortcut.removed, false);
    assert.match(String(a.report.shortcut.reason), /不是本次安装/);

    // 2) 同一条记录，目标指向本次安装的启动器 —— 正常卸载要能删掉
    const appDirB = path.join(root, 'app-b');
    const dataDirB = path.join(root, 'data-b');
    fx.seedInstall(root, { version: '1.3.1', sourceDir: src, appDir: appDirB, dataDir: dataDirB, shortcut: foreign });
    const own = path.join(desktop, 'WorkDaddy-own.lnk');
    makeLnk(root, own, path.join(appDirB, 'scripts', 'launcher.cmd'));
    const stateFile = path.join(dataDirB, 'install-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.shortcut = own;
    fx.writeFile(stateFile, JSON.stringify(state, null, 2));

    const b = runUninstall(['-AppDir', appDirB, '-DataDir', dataDirB, '-DesktopDir', desktop], root);
    assert.equal(b.code, 0, b.out + b.err);
    assert.equal(b.report.shortcut.removed, true, '自己建的快捷方式要照常删掉');
    assert.equal(fs.existsSync(own), false);
    assert.ok(fs.existsSync(foreign), '不能顺手把别的快捷方式也删了');
  } finally { fx.cleanup(root); }
});

