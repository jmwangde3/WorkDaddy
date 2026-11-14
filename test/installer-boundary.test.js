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
