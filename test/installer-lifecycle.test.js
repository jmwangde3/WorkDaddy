'use strict';
/**
 * 独立安装器 / 更新器 / 卸载器 回归测试（阶段 4）
 *
 *   node --test test/installer-lifecycle.test.js
 *
 * 只在 Windows 上执行。所有 AppDir / DataDir / TEMP 都在临时目录内，
 * 并且一律带 -NoShortcut：绝不碰真实安装目录、真实数据目录、真实桌面快捷方式。
 *
 * 为什么真跑 PowerShell 而不是只做静态解析：
 *   这三个脚本的绝大部分风险在「顺序」上 —— 备份晚于替换、校验失败忘了回滚、
 *   卸载删了不该删的、暂存目录没清。静态读代码看不出这些，只能在临时目录里
 *   用真文件跑一遍，然后检查磁盘上的结果。
 *
 * 断言一律读 -Json 报告与磁盘状态，不解析 stdout：PowerShell 5.1 在 CJK
 * 控制台下的输出编码不可靠（默认 OEM 936），拿它做断言会引入假失败。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  assert, installPs1, updatePs1, uninstallPs1,
  tmpRoot, sha256, sleepSync, alive, writeFile,
  fileList, makeSource, seedInstall, runPs, cleanup,
} = require('./helpers/installer-fixture');

const isWin = process.platform === 'win32';

function test(name, fn) {
  if (!isWin) {
    console.log(`SKIP ${name} (非 Windows)`);
    return;
  }
  fn();
  console.log(`ok - ${name}`);
}

function main() {
  assert.ok(fs.existsSync(installPs1), 'install-workdaddy.ps1 存在');
  assert.ok(fs.existsSync(updatePs1), 'update-workdaddy.ps1 存在');
  assert.ok(fs.existsSync(uninstallPs1), 'uninstall-workdaddy.ps1 存在');

  // ============================ 安装 ============================

  test('全新安装：文件落盘、清单完整、状态与配置生成', () => {
    const root = tmpRoot('fresh');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const r = runPs(installPs1, [
      '-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
      '-NoShortcut', '-SkipClientCheck', '-LegacyScriptsDir', path.join(root, 'nolegacy'),
    ], root);

    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.report.ok, true);
    assert.equal(r.report.version, '1.3.0');
    assert.ok(r.report.fileCount >= 20, '安装文件数应超过下限：' + r.report.fileCount);

    // 每个清单文件都要真的在目标目录且哈希一致
    const list = fileList(src);
    assert.equal(r.report.fileCount, list.length);
    for (const rel of list) {
      const dst = path.join(appDir, rel);
      assert.ok(fs.existsSync(dst), '缺文件：' + rel);
      assert.equal(sha256(dst), sha256(path.join(src, rel)), '哈希不一致：' + rel);
    }

    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'install-state.json'), 'utf8'));
    assert.equal(state.version, '1.3.0');
    assert.equal(state.appDir, appDir);
    assert.equal(state.dataDir, dataDir);
    assert.equal(state.shortcut, '', '-NoShortcut 时不应记录快捷方式');
    assert.equal(state.files.length, list.length);

    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(config.clientProfile, 'workbuddy-cn');
    assert.equal(config.rehome.enabled, false, '默认必须是只读/关闭');
    assert.equal(config.rehome.dedupe, false);
    assert.equal(config.rehome.dedupeMode, 'exact', '默认必须是精确副本');
    assert.equal(config.permission.preferenceGuard, false, '默认不得写偏好');
  });

  test('重复安装（同版本）：同样先备份，成功后再覆盖', () => {
    const root = tmpRoot('repeat');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const base = ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
      '-NoShortcut', '-SkipClientCheck', '-LegacyScriptsDir', path.join(root, 'nolegacy')];

    const first = runPs(installPs1, base, root);
    assert.equal(first.code, 0);
    const second = runPs(installPs1, base, root);
    assert.equal(second.code, 0, second.stdout);
    assert.equal(second.report.ok, true);
    // 同版本重装也可能在复制中途失败，所以必须有可恢复备份（不再按版本差异决定）
    assert.ok(second.report.backup, '同版本重装也应留备份');
    assert.ok(fs.existsSync(second.report.backup), '备份目录必须存在');

    const backups = path.join(dataDir, 'backups');
    const dirs = fs.readdirSync(backups).filter((n) => n.startsWith('app-'));
    assert.equal(dirs.length, 1, '应有一个程序备份：' + dirs.join(','));
    assert.match(dirs[0], /^app-1\.3\.0-\d{8}-\d{6}$/);
    assert.ok(fs.existsSync(path.join(backups, dirs[0], 'scripts', 'daemon.js')));
    // 状态也留一份快照，回滚时用它证明「安装前记录是什么」
    assert.ok(fs.readdirSync(backups).some((n) => /^install-state-1\.3\.0-\d{8}-\d{6}\.json$/.test(n)), '应保留状态快照');
  });

  test('升级安装（旧版本已装）：先备份再覆盖，备份里是旧内容', () => {
    const root = tmpRoot('upgrade');
    const oldSrc = makeSource(root, '1.2.9', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');

    const first = runPs(installPs1, ['-SourceDir', oldSrc, '-AppDir', appDir, '-DataDir', dataDir,
      '-NoShortcut', '-SkipClientCheck', '-LegacyScriptsDir', path.join(root, 'nolegacy')], root);
    assert.equal(first.code, 0);

    const second = runPs(installPs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir,
      '-NoShortcut', '-SkipClientCheck', '-LegacyScriptsDir', path.join(root, 'nolegacy')], root);
    assert.equal(second.code, 0, second.stdout);
    assert.ok(second.report.backup, '升级必须留下备份路径');
    assert.ok(fs.existsSync(second.report.backup), '备份目录必须存在');
    const backed = fs.readFileSync(path.join(second.report.backup, 'scripts', 'daemon.js'), 'utf8');
    assert.match(backed, /1\.2\.9/, '备份里应是旧版本内容');
    const now = fs.readFileSync(path.join(appDir, 'scripts', 'daemon.js'), 'utf8');
    assert.match(now, /1\.3\.0/, '安装目录应是新版本内容');
  });

  test('安装目录不存在：逐级创建成功', () => {
    const root = tmpRoot('deepdir');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'a', 'b', 'c', 'WorkDaddy');
    const dataDir = path.join(root, 'data');
    const r = runPs(installPs1, ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
      '-NoShortcut', '-SkipClientCheck', '-LegacyScriptsDir', path.join(root, 'nolegacy')], root);
    assert.equal(r.code, 0, r.stdout);
    assert.ok(fs.existsSync(path.join(appDir, 'scripts', 'daemon.js')));
  });

  test('源目录无效：exit 1，且不创建任何目标目录', () => {
    const root = tmpRoot('nosrc');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const r = runPs(installPs1, ['-SourceDir', path.join(root, 'missing-src'), '-AppDir', appDir,
      '-DataDir', dataDir, '-NoShortcut', '-SkipClientCheck'], root);
    assert.equal(r.code, 1);
    assert.equal(r.report.ok, false);
    assert.ok(r.report.error, '应给出错误原因');
    assert.equal(fs.existsSync(appDir), false, '源无效时不该创建安装目录');
    assert.equal(fs.existsSync(dataDir), false, '源无效时不该创建数据目录');
  });

  test('目标目录不可写：exit 3（用一个同名文件把父路径堵死）', () => {
    const root = tmpRoot('nowrite');
    const src = makeSource(root, '1.3.0');
    const blocker = path.join(root, 'blocker');
    writeFile(blocker, 'not a directory');
    const r = runPs(installPs1, ['-SourceDir', src, '-AppDir', path.join(blocker, 'app'),
      '-DataDir', path.join(root, 'data'), '-NoShortcut', '-SkipClientCheck'], root);
    assert.equal(r.code, 3, r.stdout);
    assert.equal(r.report.preflight.appDirWritable, false);
  });

  test('数据目录落在安装目录内：exit 2 拒绝', () => {
    const root = tmpRoot('insidedata');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const r = runPs(installPs1, ['-SourceDir', src, '-AppDir', appDir,
      '-DataDir', path.join(appDir, 'data'), '-NoShortcut', '-SkipClientCheck'], root);
    assert.equal(r.code, 2, r.stdout);
  });

  test('用户目录已有配置：不覆盖 config.json', () => {
    const root = tmpRoot('keepconfig');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const mine = { schema: 1, clientProfile: 'custom-profile', autoStart: true, note: '用户自己的配置' };
    writeFile(path.join(dataDir, 'config.json'), JSON.stringify(mine, null, 2));

    const r = runPs(installPs1, ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
      '-NoShortcut', '-SkipClientCheck', '-LegacyScriptsDir', path.join(root, 'nolegacy')], root);
    assert.equal(r.code, 0, r.stdout);
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.deepEqual(after, mine, '已有配置必须原样保留');
  });

  test('已安装旧补丁版：只复制配置与日志，原目录不动', () => {
    const root = tmpRoot('legacy');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const legacy = path.join(root, 'legacy-scripts');
    writeFile(path.join(legacy, 'rehome-sessions.js'), "'use strict';\n");
    writeFile(path.join(legacy, 'rehome-config.json'), JSON.stringify({ enabled: true }));
    writeFile(path.join(legacy, 'dedupe-config.json'), JSON.stringify({ mode: 'exact' }));
    writeFile(path.join(legacy, 'permission-guard.json'), JSON.stringify({ preferenceGuard: true }));
    writeFile(path.join(legacy, 'logs', 'rehome-2026-11-14.log'), 'old log\n');
    writeFile(path.join(legacy, 'backups', 'rehome-state-1.json'), '{"a":1}\n');

    const r = runPs(installPs1, ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
      '-NoShortcut', '-SkipClientCheck', '-LegacyScriptsDir', legacy], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.migration.detected, true);
    assert.ok(r.report.migration.source.toLowerCase().endsWith('legacy-scripts'));

    const imported = r.report.migration.imported.map((x) => x.name);
    for (const want of ['rehome-config.json', 'dedupe-config.json', 'permission-guard.json', 'logs', 'backups']) {
      assert.ok(imported.includes(want), '应导入 ' + want + '，实际：' + imported.join(','));
    }

    // 导入副本落在 DataDir\legacy-import\<stamp> 下
    const importRoot = path.join(dataDir, 'legacy-import');
    const stamps = fs.readdirSync(importRoot);
    assert.equal(stamps.length, 1);
    const dir = path.join(importRoot, stamps[0]);
    assert.ok(fs.existsSync(path.join(dir, 'rehome-config.json')));
    assert.ok(fs.existsSync(path.join(dir, 'logs', 'rehome-2026-11-14.log')));

    // 原目录必须完好
    assert.ok(fs.existsSync(path.join(legacy, 'rehome-config.json')), '旧目录不能被删');
    assert.ok(fs.existsSync(path.join(legacy, 'logs', 'rehome-2026-11-14.log')), '旧日志不能被搬走');
  });

  test('客户端检测与真实环境一致（无客户端时给出提示而不是失败）', () => {
    const root = tmpRoot('client');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const expected = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy AI'),
      path.join(process.env.APPDATA || '', 'WorkBuddy'),
    ].some((p) => p && fs.existsSync(p));

    const r = runPs(installPs1, ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
      '-NoShortcut', '-LegacyScriptsDir', path.join(root, 'nolegacy')], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.preflight.clientDetected, expected, '客户端探测结果应与文件系统一致');
    if (!expected) {
      assert.ok(r.report.warnings.some((w) => /WorkBuddy/.test(w)), '无客户端时应提示');
    } else {
      assert.equal(r.report.preflight.clientPath.toLowerCase().includes('workbuddy'), true);
    }
  });

  test('预检模式（-DryRun）：不写任何文件', () => {
    const root = tmpRoot('dryrun');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const r = runPs(installPs1, ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
      '-NoShortcut', '-SkipClientCheck', '-DryRun', '-LegacyScriptsDir', path.join(root, 'nolegacy')], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.dryRun, true);
    assert.ok(r.report.fileCount >= 20);
    assert.equal(fs.existsSync(appDir), false, 'DryRun 不得创建安装目录');
    assert.equal(fs.existsSync(dataDir), false, 'DryRun 不得创建数据目录');
  });

  // ============================ 更新 ============================

  test('更新：同版本且无 -Force 视为已完成，不改文件', () => {
    const root = tmpRoot('upd-same');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: src, appDir, dataDir });
    const before = sha256(path.join(appDir, 'scripts', 'daemon.js'));

    const r = runPs(updatePs1, ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.ok, true);
    assert.ok(r.report.warnings.some((w) => /已是当前版本/.test(w)));
    assert.equal(sha256(path.join(appDir, 'scripts', 'daemon.js')), before);
  });

  test('更新：拒绝降级 exit 2，-Force 才允许', () => {
    const root = tmpRoot('upd-downgrade');
    const oldSrc = makeSource(root, '1.2.0', { tag: 'old' });
    const curSrc = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: curSrc, appDir, dataDir });

    const blocked = runPs(updatePs1, ['-SourceDir', oldSrc, '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(blocked.code, 2, blocked.stdout);
    assert.equal(blocked.report.versionCompare, -1);
    assert.ok(fs.readFileSync(path.join(appDir, 'scripts', 'daemon.js'), 'utf8').includes('1.3.0'), '拒绝降级时文件不该被动过');

    const forced = runPs(updatePs1, ['-SourceDir', oldSrc, '-AppDir', appDir, '-DataDir', dataDir, '-Force'], root);
    assert.equal(forced.code, 0, forced.stdout);
    assert.ok(fs.readFileSync(path.join(appDir, 'scripts', 'daemon.js'), 'utf8').includes('1.2.0'));
  });

  test('更新：正常升级写状态、留备份、健康检查全 ok、清理暂存', () => {
    const root = tmpRoot('upd-ok');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });
    writeFile(path.join(dataDir, 'logs', 'daemon-2026-11-14.log'), 'user log\n');

    const r = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.ok, true);
    assert.equal(r.report.fromVersion, '1.3.0');
    assert.equal(r.report.toVersion, '1.3.1');
    assert.equal(r.report.rolledBack, false);
    for (const c of ['daemon.js', 'inject.js', 'lib.js', 'win-launcher.js']) {
      assert.equal(r.report.health[c], 'ok', c + ' 健康检查应为 ok');
    }

    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'install-state.json'), 'utf8'));
    assert.equal(state.version, '1.3.1');
    assert.equal(state.updatedFrom, '1.3.0');
    assert.ok(state.files.length >= 20);

    // 备份：一个 app-<旧版本>-preupdate-<时间戳>，里面是旧内容；
    // 同一代际还有一份 install-state 快照（更新事务回滚要用）
    const backupDirs = fs.readdirSync(path.join(dataDir, 'backups')).filter((n) => n.startsWith('app-'));
    assert.equal(backupDirs.length, 1, '应保留一个可恢复版本：' + backupDirs.join(','));
    assert.match(backupDirs[0], /^app-1\.3\.0-preupdate-\d{8}-\d{6}$/);
    const backed = fs.readFileSync(path.join(dataDir, 'backups', backupDirs[0], 'scripts', 'daemon.js'), 'utf8');
    assert.match(backed, /1\.3\.0/);
    assert.ok(
      fs.readdirSync(path.join(dataDir, 'backups')).some((n) => /^install-state-1\.3\.0-\d{8}-\d{6}\.json$/.test(n)),
      '应保留旧状态的快照'
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'install-state.json'), 'utf8')).version, '1.3.1', '状态应提交新版本');

    // 用户数据保留
    assert.equal(fs.readFileSync(path.join(dataDir, 'logs', 'daemon-2026-11-14.log'), 'utf8'), 'user log\n');

    // 暂存目录清理
    assert.equal(r.report.stageRemoved, true, '成功后也要清掉暂存目录');
    assert.equal(fs.existsSync(r.report.stageDir), false);
    const leftovers = fs.readdirSync(root).filter((n) => n.startsWith('workdaddy-update-'));
    assert.deepEqual(leftovers, [], 'TEMP 里不该残留暂存目录');
  });

  test('更新：坏包（lib.js 语法错误）→ 健康检查失败并回滚 exit 5', () => {
    const root = tmpRoot('upd-rollback');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const badSrc = makeSource(root, '1.3.1', { brokenLib: true });
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });
    const libBefore = fs.readFileSync(path.join(appDir, 'scripts', 'lib.js'), 'utf8');
    const daemonBefore = fs.readFileSync(path.join(appDir, 'scripts', 'daemon.js'), 'utf8');

    const r = runPs(updatePs1, ['-SourceDir', badSrc, '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 5, r.stdout);
    assert.equal(r.report.rolledBack, true, '必须回滚');
    assert.equal(r.report.health['lib.js'], 'syntax-error');

    // 回滚后磁盘上必须是旧内容
    assert.equal(fs.readFileSync(path.join(appDir, 'scripts', 'lib.js'), 'utf8'), libBefore);
    assert.equal(fs.readFileSync(path.join(appDir, 'scripts', 'daemon.js'), 'utf8'), daemonBefore);
    // 状态文件仍是旧版本
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'install-state.json'), 'utf8'));
    assert.equal(state.version, '1.3.0');
    // 失败路径也要清暂存
    assert.equal(r.report.stageRemoved, true);
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('workdaddy-update-')), []);
  });

  test('更新：没有安装记录 exit 1；源目录读不到版本 exit 1', () => {
    const root = tmpRoot('upd-nostate');
    const src = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const noState = runPs(updatePs1, ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(noState.code, 1, noState.stdout);
    assert.match(noState.report.error, /找不到安装记录/);

    writeFile(path.join(dataDir, 'install-state.json'), JSON.stringify({ version: '1.3.0', appDir }));
    const noVer = runPs(updatePs1, ['-SourceDir', path.join(root, 'empty'), '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(noVer.code, 1, noVer.stdout);
  });

  test('更新：-DryRun 不改文件、不建备份', () => {    const root = tmpRoot('upd-dry');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });
    const before = sha256(path.join(appDir, 'scripts', 'lib.js'));

    const r = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir, '-DryRun'], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.dryRun, true);
    assert.equal(sha256(path.join(appDir, 'scripts', 'lib.js')), before);
    assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false, 'DryRun 不该建备份');
  });

  test('更新：替换前停掉本安装目录的守护进程（-Restart 才重新拉起）', () => {
    const root = tmpRoot('upd-service');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });

    // 让装好的 daemon.js 常驻，模拟真实守护进程：它的命令行里带着
    // <appDir>\scripts\daemon.js，这正是更新器识别「自己的服务」的唯一依据。
    const daemonPath = path.join(appDir, 'scripts', 'daemon.js');
    fs.appendFileSync(daemonPath, '\nsetInterval(function () {}, 1000);\n');
    const child = spawn(process.execPath, [daemonPath], { stdio: 'ignore' });
    let exited = false;
    child.on('exit', () => { exited = true; });

    try {
      sleepSync(600); // 等 win32 进程表里能查到它
      assert.equal(alive(child.pid), true, '模拟守护进程应已启动');

      const r = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir], root);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.ok(r.report.service.detected.includes(child.pid), '应检测到该 pid：' + JSON.stringify(r.report.service));
      assert.ok(r.report.service.stopped.includes(child.pid), '应停掉该 pid');
      assert.equal(r.report.service.startAttempted, false, '没给 -Restart 就不该自动拉起');

      sleepSync(400);
      assert.equal(alive(child.pid), false, '被停掉的进程不应还活着');
      assert.equal(exited || !alive(child.pid), true);
    } finally {
      try { child.kill(); } catch (_) {}
    }
  });

  test('更新：-Restart 时用 launcher.cmd 重新拉起', () => {
    const root = tmpRoot('upd-restart');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });

    const r = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir, '-Restart'], root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.report.service.startAttempted, true, '应尝试启动：' + JSON.stringify(r.report.service));
    assert.ok(Number(r.report.service.startPid) > 0);
  });

  // ============================ 卸载 ============================

  test('卸载：默认保留用户数据，安装目录清空', () => {
    const root = tmpRoot('un-default');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const seeded = seedInstall(root, { version: '1.3.0', sourceDir: src, appDir, dataDir });
    writeFile(path.join(dataDir, 'config.json'), '{"schema":1}\n');
    writeFile(path.join(dataDir, 'logs', 'a.log'), 'log\n');

    const r = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.ok, true);
    assert.equal(r.report.removed.length, seeded.list.length);
    assert.equal(r.report.dataPurged, false);
    assert.equal(fs.existsSync(appDir), false, '清单内文件删完、目录空了就该移除自身');
    assert.ok(fs.existsSync(path.join(dataDir, 'config.json')), '默认必须保留配置');
    assert.ok(fs.existsSync(path.join(dataDir, 'logs', 'a.log')), '默认必须保留日志');
  });

  test('卸载：只清配置必须双开关，缺一个就 exit 1 且什么都不删', () => {
    const root = tmpRoot('un-purgeless');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: src, appDir, dataDir });

    const r = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir, '-PurgeData'], root);
    assert.equal(r.code, 1, r.stdout);
    assert.equal(fs.existsSync(path.join(appDir, 'scripts', 'daemon.js')), true, '缺确认开关时不得删任何东西');
    assert.ok(fs.existsSync(path.join(dataDir, 'install-state.json')));
  });

  test('卸载：双开关齐全才清空数据目录', () => {
    const root = tmpRoot('un-purge');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: src, appDir, dataDir });
    writeFile(path.join(dataDir, 'config.json'), '{"schema":1}\n');
    writeFile(path.join(dataDir, 'backups', 'app-1.2.9-x', 'daemon.js'), 'old\n');

    const r = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir, '-PurgeData', '-YesPurgeData'], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.dataPurged, true);
    assert.ok(r.report.purgeScope.length >= 4, '报告里要写清清理范围');
    assert.deepEqual(fs.readdirSync(dataDir), [], '数据目录应被清空');
  });

  test('卸载：哈希变化默认跳过 exit 3，-Force 才删', () => {
    const root = tmpRoot('un-hash');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: src, appDir, dataDir });
    writeFile(path.join(appDir, 'scripts', 'lib.js'), "'use strict';\n// 用户改过\n");

    const skipped = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(skipped.code, 3, skipped.stdout);
    assert.equal(skipped.report.ok, false);
    assert.ok(skipped.report.skipped.some((s) => s.reason === 'hash-changed'));
    assert.ok(fs.existsSync(path.join(appDir, 'scripts', 'lib.js')), '默认不得删改过的文件');

    const forced = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir, '-Force'], root);
    assert.equal(forced.code, 0, forced.stdout);
    assert.equal(fs.existsSync(path.join(appDir, 'scripts', 'lib.js')), false);
  });

  test('卸载：安装记录被改成越界路径也不越界删文件', () => {
    const root = tmpRoot('un-escape');
    const outside = path.join(root, 'outside');
    writeFile(path.join(outside, 'evil.txt'), 'must survive\n');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, {
      version: '1.3.0', sourceDir: src, appDir, dataDir,
      extraFiles: [
        { path: '..\\outside\\evil.txt', sha256: sha256(path.join(outside, 'evil.txt')), size: 13 },
        { path: path.join(outside, 'evil.txt'), sha256: sha256(path.join(outside, 'evil.txt')), size: 13 },
      ],
    });

    const r = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir, '-Force'], root);
    assert.equal(r.code, 3, r.stdout);
    const reasons = r.report.skipped.map((s) => s.reason);
    assert.ok(reasons.filter((x) => x === 'outside-appdir').length >= 2, reasons.join(','));
    assert.ok(fs.existsSync(path.join(outside, 'evil.txt')), '越界文件必须留着');
  });

  test('卸载：只删安装记录里的那一条快捷方式', () => {
    const root = tmpRoot('un-lnk');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const mine = path.join(root, 'mine.lnk');
    const other = path.join(root, 'other.lnk');
    writeFile(mine, 'LNK');
    writeFile(other, 'LNK');
    seedInstall(root, { version: '1.3.0', sourceDir: src, appDir, dataDir, shortcut: mine });

    const r = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(fs.existsSync(mine), false, '记录里的快捷方式应删除');
    assert.equal(fs.existsSync(other), true, '没记录的快捷方式绝不能动');
  });

  test('卸载：找不到安装记录 exit 1（不猜着删）', () => {
    const root = tmpRoot('un-nostate');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    writeFile(path.join(appDir, 'scripts', 'daemon.js'), "'use strict';\n");
    fs.mkdirSync(dataDir, { recursive: true });

    const r = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 1, r.stdout);
    assert.ok(fs.existsSync(path.join(appDir, 'scripts', 'daemon.js')), '没有记录就不该删文件');
  });

  test('卸载：-DryRun 只报告不删', () => {
    const root = tmpRoot('un-dry');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const seeded = seedInstall(root, { version: '1.3.0', sourceDir: src, appDir, dataDir });

    const r = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir, '-DryRun'], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.removed.length, seeded.list.length);
    assert.ok(fs.existsSync(path.join(appDir, 'scripts', 'daemon.js')), 'DryRun 不得真删');
  });
}

try {
  main();
  console.log('PASS installer-lifecycle.test.js');
} catch (error) {
  console.error('FAIL installer-lifecycle.test.js:', error);
  process.exitCode = 1;
} finally {
  // 夹具模块自己也挂了 process.on('exit')，这里是「测试结束立刻清」的快路径
  cleanup();
}
