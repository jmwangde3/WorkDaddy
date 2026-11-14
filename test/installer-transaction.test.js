'use strict';
/**
 * 安装 / 更新的事务完整性（发布前稳定性）
 *
 *   node --test test/installer-transaction.test.js
 *
 * 这里只测一件事故：**半完成状态**。
 *   * 更新：程序文件已经换成新版本，install-state.json 还是旧版本 ——
 *     卸载会按旧清单删不到新文件，下次更新又拿旧版本做比较。
 *   * 安装：复制到一半失败，目录里半套新文件；或快捷方式已经指向一个不存在的程序。
 *
 * 做法是把脚本自己的故障注入点打开（-InjectFault），在临时目录里真跑 PS 5.1，
 * 然后只信两样东西：磁盘上的字节、-Json 报告。不解析 stdout（CJK 控制台编码不可靠）。
 *
 * 所有路径都在仓库内 tmp/ 下（夹具模块统一管理），桌面用 -DesktopDir 指到临时目录。
 */
const fs = require('fs');
const path = require('path');

const {
  assert, installPs1, updatePs1,
  tmpRoot, sha256, writeFile, makeSource, seedInstall, runPs, cleanup,
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function exists(p) {
  return fs.existsSync(p);
}

function stateOf(dataDir) {
  return readJson(path.join(dataDir, 'install-state.json'));
}

function installerArgs(src, appDir, dataDir, extra) {
  return ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
    '-NoShortcut', '-SkipClientCheck',
    '-LegacyScriptsDir', path.join(dataDir, '..', 'nolegacy')].concat(extra || []);
}

function main() {
  for (const p of [installPs1, updatePs1]) assert.ok(exists(p), '脚本存在：' + p);

  // ==================== 更新事务 ====================

  test('更新：状态文件无法写入 → 程序与状态一起回滚，exit 7', () => {
    const root = tmpRoot('tx-state-write');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });
    const daemonBefore = sha256(path.join(appDir, 'scripts', 'daemon.js'));

    const r = runPs(updatePs1, [
      '-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir,
      '-InjectFault', 'state-write',
    ], root);

    assert.equal(r.code, 7, r.stdout + r.stderr);
    assert.equal(r.report.ok, false);
    assert.match(r.report.error, /状态文件无法写入/);
    // 两半分开报告，且都成功
    assert.equal(r.report.rollback.attempted, true);
    assert.equal(r.report.rollback.programRestored, true);
    assert.equal(r.report.rollback.stateRestored, true);
    assert.equal(r.report.rolledBack, true);
    // 磁盘：程序旧字节、状态旧版本
    assert.equal(sha256(path.join(appDir, 'scripts', 'daemon.js')), daemonBefore);
    assert.match(fs.readFileSync(path.join(appDir, 'scripts', 'daemon.js'), 'utf8'), /1\.3\.0/);
    assert.equal(stateOf(dataDir).version, '1.3.0');
    // 事务痕迹：journal 清掉、临时状态不残留、暂存目录清掉
    assert.equal(exists(path.join(dataDir, 'update-journal.json')), false, 'journal 应清掉');
    assert.deepEqual(fs.readdirSync(dataDir).filter((n) => n.startsWith('.install-state.tmp-')), []);
    assert.equal(r.report.stageRemoved, true);
  });

  test('更新：状态文件替换失败 → 同样回滚 exit 7', () => {
    const root = tmpRoot('tx-state-replace');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });
    const daemonBefore = sha256(path.join(appDir, 'scripts', 'daemon.js'));

    const r = runPs(updatePs1, [
      '-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir,
      '-InjectFault', 'state-replace',
    ], root);

    assert.equal(r.code, 7, r.stdout + r.stderr);
    assert.match(r.report.error, /状态文件替换失败/);
    assert.equal(r.report.rollback.programRestored, true);
    assert.equal(r.report.rollback.stateRestored, true);
    assert.equal(sha256(path.join(appDir, 'scripts', 'daemon.js')), daemonBefore);
    assert.equal(stateOf(dataDir).version, '1.3.0');
    assert.equal(exists(path.join(dataDir, 'update-journal.json')), false);
  });

  test('更新：状态文件真的只读（不用注入）→ 回滚 exit 7', () => {
    const root = tmpRoot('tx-state-readonly');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });
    const statePath = path.join(dataDir, 'install-state.json');
    const daemonBefore = sha256(path.join(appDir, 'scripts', 'daemon.js'));

    fs.chmodSync(statePath, 0o444); // Windows 上就是只读属性
    try {
      const r = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir], root);
      assert.equal(r.code, 7, r.stdout + r.stderr);
      assert.equal(r.report.rollback.programRestored, true, '程序必须恢复');
      assert.equal(r.report.rollback.stateRestored, true, '旧状态没被改动，读回应与旧版本一致');
      assert.equal(sha256(path.join(appDir, 'scripts', 'daemon.js')), daemonBefore);
      assert.equal(stateOf(dataDir).version, '1.3.0');
    } finally {
      fs.chmodSync(statePath, 0o666); // 否则清理会失败
    }
  });

  test('更新：回滚时状态恢复失败 → 两半分开报告，且下次拒绝在未知状态上继续', () => {
    const root = tmpRoot('tx-state-restore');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });

    const r = runPs(updatePs1, [
      '-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir,
      '-InjectFault', 'state-restore',
    ], root);

    assert.equal(r.code, 7, r.stdout + r.stderr);
    assert.match(r.report.error, /状态恢复失败/);
    // 关键：程序恢复成功、状态恢复失败，必须分别可见
    assert.equal(r.report.rollback.programRestored, true);
    assert.equal(r.report.rollback.stateRestored, false);
    assert.equal(r.report.rolledBack, false, '只恢复了一半就不能报「已回滚」');
    // 磁盘就是这个不一致现场：程序 1.3.0、状态 1.3.1
    assert.match(fs.readFileSync(path.join(appDir, 'scripts', 'daemon.js'), 'utf8'), /1\.3\.0/);
    assert.equal(stateOf(dataDir).version, '1.3.1');
    // journal 留着，作为下一次运行的拦截依据
    assert.equal(exists(path.join(dataDir, 'update-journal.json')), true, '半完成状态必须留 journal');

    // 之后不带 -Force 的更新必须拒绝（exit 8），并且不碰文件
    const daemonNow = sha256(path.join(appDir, 'scripts', 'daemon.js'));
    const blocked = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(blocked.code, 8, blocked.stdout + blocked.stderr);
    assert.match(blocked.report.error, /上次更新未完成/);
    assert.equal(sha256(path.join(appDir, 'scripts', 'daemon.js')), daemonNow, '拒绝时不得改动文件');
    assert.equal(stateOf(dataDir).version, '1.3.1');

    // -Force 允许继续：重装同一个 1.3.1，把两侧拉回一致
    const forced = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir, '-Force'], root);
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
    assert.match(fs.readFileSync(path.join(appDir, 'scripts', 'daemon.js'), 'utf8'), /1\.3\.1/);
    assert.equal(stateOf(dataDir).version, '1.3.1');
    assert.equal(exists(path.join(dataDir, 'update-journal.json')), false, '成功后 journal 应清掉');
  });

  test('更新：上次崩在替换之前（journal 残留但两侧都是旧版本）→ 自动清理并继续', () => {
    const root = tmpRoot('tx-journal-stale');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });
    writeFile(path.join(dataDir, 'update-journal.json'), JSON.stringify({
      schema: 1, action: 'update', from: '1.3.0', to: '1.3.1',
      backup: path.join(dataDir, 'backups', 'app-1.3.0-preupdate-x'), stage: '', pid: 1,
    }));

    const r = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.report.warnings.some((w) => /残留 journal/.test(w)), '应提示清理了 journal');
    assert.equal(stateOf(dataDir).version, '1.3.1');
    assert.equal(exists(path.join(dataDir, 'update-journal.json')), false);
  });

  test('更新：成功路径清 journal、留状态快照、状态清单可解析', () => {
    const root = tmpRoot('tx-ok');
    const oldSrc = makeSource(root, '1.3.0', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.1');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    seedInstall(root, { version: '1.3.0', sourceDir: oldSrc, appDir, dataDir });

    const r = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.report.state.validated, true);
    assert.equal(r.report.state.committed, true);
    assert.equal(exists(path.join(dataDir, 'update-journal.json')), false);

    const state = stateOf(dataDir);
    assert.equal(state.version, '1.3.1');
    assert.ok(state.files.length >= 20);
    for (const row of state.files) {
      assert.equal(sha256(path.join(appDir, row.path)), row.sha256, '清单哈希与磁盘不符：' + row.path);
    }
    const snapshots = fs.readdirSync(path.join(dataDir, 'backups'))
      .filter((n) => /^install-state-1\.3\.0-\d{8}-\d{6}\.json$/.test(n));
    assert.equal(snapshots.length, 1, '应保留一份旧状态快照');
    assert.equal(readJson(path.join(dataDir, 'backups', snapshots[0])).version, '1.3.0');
  });

  // ==================== 安装事务 ====================

  test('安装：全新安装复制中途失败 → 清理本次文件，不留目录与状态', () => {
    const root = tmpRoot('tx-inst-copy');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');

    const r = runPs(installPs1, installerArgs(src, appDir, dataDir, ['-InjectFault', 'copy-mid']), root);
    assert.equal(r.code, 4, r.stdout + r.stderr);
    assert.equal(r.report.ok, false);
    assert.match(r.report.error, /复制失败/);
    assert.equal(r.report.rollback.attempted, true);
    assert.equal(r.report.rollback.cleaned, true);
    assert.equal(exists(appDir), false, '本次新建且清空的安装目录应删掉');
    assert.equal(exists(dataDir), false, '还没走到数据目录初始化，数据目录不该出现');
  });

  test('安装：新安装失败不删用户自己的文件与目录', () => {
    const root = tmpRoot('tx-inst-userfile');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    writeFile(path.join(appDir, 'my-notes.txt'), '用户自己的东西\n');

    const r = runPs(installPs1, installerArgs(src, appDir, dataDir, ['-InjectFault', 'copy-mid']), root);
    assert.equal(r.code, 4, r.stdout + r.stderr);
    assert.equal(exists(path.join(appDir, 'my-notes.txt')), true, '用户文件必须留着');
    assert.equal(exists(path.join(appDir, 'scripts', 'daemon.js')), false, '本次复制的文件要清掉');
    assert.equal(exists(path.join(dataDir, 'install-state.json')), false);
  });

  test('安装：同版本重装中途失败 → 回滚到备份，状态不变', () => {
    const root = tmpRoot('tx-inst-repeat');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const first = runPs(installPs1, installerArgs(src, appDir, dataDir), root);
    assert.equal(first.code, 0, first.stdout);
    const before = sha256(path.join(appDir, 'scripts', 'daemon.js'));
    const stateBefore = fs.readFileSync(path.join(dataDir, 'install-state.json'), 'utf8');

    const r = runPs(installPs1, installerArgs(src, appDir, dataDir, ['-InjectFault', 'copy-mid']), root);
    assert.equal(r.code, 4, r.stdout + r.stderr);
    assert.equal(r.report.rollback.programRestored, true);
    assert.equal(r.report.rollback.stateRestored, true);
    assert.ok(r.report.backup, '重装也必须先备份');
    assert.ok(exists(r.report.backup));
    assert.equal(sha256(path.join(appDir, 'scripts', 'daemon.js')), before);
    assert.equal(fs.readFileSync(path.join(dataDir, 'install-state.json'), 'utf8'), stateBefore, '状态文件应原样');
  });

  test('安装：升级中途失败 → 程序回到旧版本', () => {
    const root = tmpRoot('tx-inst-upgrade');
    const oldSrc = makeSource(root, '1.2.9', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    assert.equal(runPs(installPs1, installerArgs(oldSrc, appDir, dataDir), root).code, 0);

    const r = runPs(installPs1, installerArgs(newSrc, appDir, dataDir, ['-InjectFault', 'copy-mid']), root);
    assert.equal(r.code, 4, r.stdout + r.stderr);
    assert.equal(r.report.rollback.programRestored, true);
    assert.match(fs.readFileSync(path.join(appDir, 'scripts', 'daemon.js'), 'utf8'), /1\.2\.9/);
    assert.equal(stateOf(dataDir).version, '1.2.9');
  });

  test('安装：SHA-256 校验失败 → 全新安装清理 exit 5', () => {
    const root = tmpRoot('tx-inst-verify-new');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');

    const r = runPs(installPs1, installerArgs(src, appDir, dataDir, ['-InjectFault', 'verify']), root);
    assert.equal(r.code, 5, r.stdout + r.stderr);
    assert.match(r.report.error, /装后校验失败/);
    assert.equal(r.report.rollback.cleaned, true);
    assert.equal(exists(appDir), false);
    assert.equal(exists(path.join(dataDir, 'install-state.json')), false);
  });

  test('安装：已有安装校验失败 → 回滚到备份 exit 5', () => {
    const root = tmpRoot('tx-inst-verify-old');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    assert.equal(runPs(installPs1, installerArgs(src, appDir, dataDir), root).code, 0);
    const before = sha256(path.join(appDir, 'scripts', 'lib.js'));

    const r = runPs(installPs1, installerArgs(src, appDir, dataDir, ['-InjectFault', 'verify']), root);
    assert.equal(r.code, 5, r.stdout + r.stderr);
    assert.equal(r.report.rollback.programRestored, true);
    assert.equal(sha256(path.join(appDir, 'scripts', 'lib.js')), before);
    assert.equal(stateOf(dataDir).version, '1.3.0');
  });

  test('安装：快捷方式已建但安装记录失败 → 快捷方式随回滚删除 exit 7', () => {
    const root = tmpRoot('tx-inst-shortcut');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const desktop = path.join(root, 'desktop');
    const lnk = path.join(desktop, 'WorkDaddy.lnk');

    const r = runPs(installPs1, [
      '-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
      '-DesktopDir', desktop, '-SkipClientCheck',
      '-LegacyScriptsDir', path.join(root, 'nolegacy'),
      '-InjectFault', 'state-write',
    ], root);

    assert.equal(r.code, 7, r.stdout + r.stderr);
    assert.match(r.report.error, /状态文件无法写入/);
    assert.equal(r.report.rollback.shortcutRemoved, true, '回滚必须撤掉刚建的快捷方式');
    assert.equal(exists(lnk), false, '快捷方式不该留下死链');
    assert.equal(exists(path.join(appDir, 'scripts', 'daemon.js')), false, '程序文件应清理');
    assert.equal(exists(path.join(dataDir, 'install-state.json')), false, '不该留下安装记录');
    // config.json 属于用户数据，留在盘上是可接受的（下次安装会复用）
    assert.equal(exists(path.join(dataDir, 'config.json')), true);
  });

  test('安装：状态提交成功后的记录与磁盘逐条一致', () => {
    const root = tmpRoot('tx-inst-ok');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const r = runPs(installPs1, installerArgs(src, appDir, dataDir), root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.report.state.validated, true);
    assert.equal(r.report.state.committed, true);
    const state = stateOf(dataDir);
    for (const row of state.files) {
      assert.equal(sha256(path.join(appDir, row.path)), row.sha256, '清单哈希与磁盘不符：' + row.path);
    }
    assert.deepEqual(fs.readdirSync(dataDir).filter((n) => n.startsWith('.install-state.tmp-')), []);
  });

  // ---- 阶段痕迹：只为「脚本什么都没留下就消失了」这类失败准备 ----
  // 报告只在成功和「已经处理过的失败」路径上写。进程被外部杀掉、或直接崩掉时，
  // 什么都不会留下 —— CI 上 Setup 装到一半无声失败就是这么被发现的。

  test('安装：成功时不留阶段痕迹，失败时留下且能看出停在哪一步', () => {
    const root = tmpRoot('tx-trace');

    // 成功：痕迹是临时诊断物，不该留在用户数据目录里
    const srcOk = makeSource(root, '1.3.0');
    const traceOk = path.join(root, 'trace-ok.log');
    const ok = runPs(installPs1, installerArgs(srcOk, path.join(root, 'app-ok'), path.join(root, 'data-ok'))
      .concat(['-Trace', traceOk]), root);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(fs.existsSync(traceOk), false, '成功后不该留下阶段痕迹');

    // 失败：痕迹必须还在，且最后一行要指向失败的那一步
    const srcBad = makeSource(root, '1.3.0');
    const traceBad = path.join(root, 'trace-bad.log');
    const bad = runPs(installPs1, installerArgs(srcBad, path.join(root, 'app-bad'), path.join(root, 'data-bad'))
      .concat(['-Trace', traceBad, '-InjectFault', 'state-write']), root);
    assert.equal(bad.code, 7, bad.stdout + bad.stderr);
    assert.equal(fs.existsSync(traceBad), true, '失败后必须留下阶段痕迹');
    const lines = fs.readFileSync(traceBad, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length >= 5, '痕迹太短：' + lines.join(' / '));
    assert.match(lines[0], /^\d\d:\d\d:\d\d\.\d\d\d start$/);
    // 状态写入失败发生在 copy/verify/shortcut/datadir 之后
    const stages = lines.map((l) => l.replace(/^\S+ /, ''));
    for (const need of ['preflight', 'copy', 'verify', 'datadir']) {
      assert.ok(stages.includes(need), '痕迹缺阶段 ' + need + '：' + stages.join('/'));
    }
    assert.ok(/^state:hashing /.test(stages[stages.length - 1]),
      '最后一步应停在状态提交，实际：' + stages[stages.length - 1]);
  });

  test('安装：Get-Sha256 不依赖 PowerShell 模块，且与 Node 算出的一致', () => {
    // 这条依赖真的把 CI 弄红过：Inno 起的那个子进程里 Get-FileHash 不存在
    // （CommandNotFoundException），安装走到「算安装记录」时静默死掉，
    // 程序文件已经落盘、记录没写、回滚也没跑 —— 正是最难查的半安装状态。
    const { spawnSync } = require('child_process');
    const { repo } = require('./helpers/installer-fixture');
    const commonPs1 = path.join(repo, 'installer', 'lib', 'common.ps1');
    const src = fs.readFileSync(commonPs1, 'utf8');
    // 只看代码行：注释里提到这个 cmdlet 是解释为什么不用它，不算依赖
    const code = src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.equal(/Get-FileHash/.test(code), false,
      'common.ps1 不能依赖 Get-FileHash：它属于要自动加载的模块，某些会话里没有');

    const root = tmpRoot('tx-hash');
    const target = path.join(root, 'sample.bin');
    fs.writeFileSync(target, Buffer.from('WorkDaddy hash probe\n'.repeat(97), 'utf8'));
    const probe = path.join(root, 'probe.ps1');
    fs.writeFileSync(probe, [
      'param([string]$Target, [string]$Common)',
      '. $Common',
      'Write-Output (Get-Sha256 $Target)',
      '',
    ].join('\r\n'), 'utf8');

    const res = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', probe, '-Target', target, '-Common', commonPs1,
    ], { encoding: 'utf8', timeout: 120000 });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.replace(/^\uFEFF/, '').trim().toLowerCase(), sha256(target),
      'PS 侧的 SHA-256 与 Node 算出来的不一致');
  });
}

try {
  main();
  console.log('PASS installer-transaction.test.js');
} catch (error) {
  console.error('FAIL installer-transaction.test.js:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}
