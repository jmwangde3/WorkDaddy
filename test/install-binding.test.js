'use strict';
/**
 * 安装实例绑定（install-binding.json）回归测试。
 *
 *   node test/install-binding.test.js
 *
 * 背景：install-state.json 落在 DataDir 里，而 DataDir 允许自定义
 * （install-workdaddy.ps1 -DataDir E:\WorkDaddyData）。托盘过去按
 * %APPDATA%\WorkDaddy\install-state.json 这个固定路径读，于是：
 *   - 自定义 DataDir 的实例，托盘读到的是另一份安装、或者什么都没有；
 *   - profile / DataDir 双双错位，daemon 被送进错误的数据目录。
 * 现在每份安装在自己目录里生成 install-binding.json，托盘按「自己受控的
 * scripts 目录 → 上一级」推回 AppDir 再读，永远读的是这一份。
 *
 * 断言只读 -Json 报告与磁盘状态，不解析 stdout（PS 5.1 CJK 代码页不可靠）。
 */
const fs = require('fs');
const path = require('path');
const {
  assert, installPs1, updatePs1, uninstallPs1,
  tmpRoot, makeSource, runPs, writeFile, seedInstall,
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

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function baseArgs(src, appDir, dataDir) {
  return ['-SourceDir', src, '-AppDir', appDir, '-DataDir', dataDir,
    '-NoShortcut', '-SkipClientCheck', '-LegacyScriptsDir', path.join(path.dirname(appDir), 'nolegacy')];
}

function main() {
  test('默认安装：绑定文件写在安装目录，指向默认数据目录', () => {
    const root = tmpRoot('bind-default');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const r = runPs(installPs1, baseArgs(src, appDir, dataDir), root);

    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.report.binding.written, true, '报告应记录绑定已写');
    const bindPath = path.join(appDir, 'install-binding.json');
    assert.equal(r.report.binding.path, bindPath, '绑定文件必须在安装目录内');
    assert.ok(fs.existsSync(bindPath), '绑定文件应存在');

    const bind = readJson(bindPath);
    assert.equal(bind.schema, 1);
    assert.equal(bind.clientProfile, 'workbuddy-cn');
    assert.equal(path.resolve(bind.dataDir).toLowerCase(), path.resolve(dataDir).toLowerCase());
    assert.equal(path.resolve(bind.appDir).toLowerCase(), path.resolve(appDir).toLowerCase());
    assert.ok(bind.updatedAt, 'updatedAt 必须有值');
    assert.ok(!fs.existsSync(bindPath + '.bak'), '成功提交后不该留下 .bak');

    // 与安装记录必须一致：两份记录描述的是同一件事
    const state = readJson(path.join(dataDir, 'install-state.json'));
    assert.equal(state.clientProfile, bind.clientProfile);
    assert.equal(path.resolve(state.dataDir).toLowerCase(), path.resolve(bind.dataDir).toLowerCase());
  });

  test('自定义 profile + 自定义数据目录：绑定跟的是这一份安装', () => {
    const root = tmpRoot('bind-custom');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'custom-data');
    const r = runPs(installPs1, baseArgs(src, appDir, dataDir).concat(['-ClientProfile', 'codebuddy-intl']), root);

    assert.equal(r.code, 0, r.stdout + r.stderr);
    const bind = readJson(path.join(appDir, 'install-binding.json'));
    assert.equal(bind.clientProfile, 'codebuddy-intl');
    assert.equal(path.resolve(bind.dataDir).toLowerCase(), path.resolve(dataDir).toLowerCase());
    // 自定义数据目录时 install-state.json 在那边，%APPDATA% 里不该冒出副本
    assert.ok(fs.existsSync(path.join(dataDir, 'install-state.json')));
  });

  test('非法 profile：参数绑定阶段就拒绝，什么都不装', () => {
    const root = tmpRoot('bind-badprofile');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    for (const bogus of ['unknown-profile', 'workbuddy-cn-xxx', 'test-profile']) {
      const r = runPs(installPs1, baseArgs(src, appDir, dataDir).concat(['-ClientProfile', bogus]), root);
      assert.notEqual(r.code, 0, '非法 profile 必须失败：' + bogus);
      assert.equal(fs.existsSync(appDir), false, '拒绝安装时不该创建安装目录：' + bogus);
      assert.equal(fs.existsSync(dataDir), false, '拒绝安装时不该创建数据目录：' + bogus);
    }
  });

  test('非法数据目录：C:relative / relative / \\rooted 一律 exit 2', () => {
    const root = tmpRoot('bind-baddir');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    for (const bogus of ['C:WorkDaddyData', 'relative\\data', '\\rooted-data']) {
      const r = runPs(installPs1, baseArgs(src, appDir, bogus), root);
      assert.equal(r.code, 2, '非法数据目录必须 exit 2：' + bogus + ' / ' + r.stdout + r.stderr);
      assert.equal(fs.existsSync(appDir), false, '拒绝安装时不该创建安装目录');
    }
  });

  test('数据目录 = 安装目录 或在其内部：exit 2', () => {
    const root = tmpRoot('bind-overlap');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    for (const dataDir of [appDir, path.join(appDir, 'data')]) {
      const r = runPs(installPs1, baseArgs(src, appDir, dataDir), root);
      assert.equal(r.code, 2, '重叠的数据目录必须拒绝：' + dataDir);
    }
  });

  test('绑定写入后事务失败：回滚要删掉绑定文件', () => {
    const root = tmpRoot('bind-rollback');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const r = runPs(installPs1, baseArgs(src, appDir, dataDir).concat(['-InjectFault', 'binding-commit']), root);

    assert.notEqual(r.code, 0, '注入故障时必须失败');
    assert.equal(r.report.ok, false);
    const bindPath = path.join(appDir, 'install-binding.json');
    assert.equal(fs.existsSync(bindPath), false, '回滚后不能留下绑定文件');
    assert.equal(r.report.binding.removed, true, '报告应记录绑定已撤回');
    // 数据目录是用户数据，回滚不动它（里面只有本次新建的 config.json）
    assert.equal(fs.existsSync(path.join(appDir, 'scripts')), false, '程序文件应已清理');
  });

  test('更新：绑定保留 profile 与数据目录，不自作主张改回默认', () => {
    const root = tmpRoot('bind-update');
    const oldSrc = makeSource(root, '1.2.9', { tag: 'old' });
    const newSrc = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'custom-data');

    const first = runPs(installPs1, baseArgs(oldSrc, appDir, dataDir).concat(['-ClientProfile', 'workbuddy-ai']), root);
    assert.equal(first.code, 0, first.stdout);
    const before = readJson(path.join(appDir, 'install-binding.json'));

    const second = runPs(updatePs1, ['-SourceDir', newSrc, '-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.equal(second.report.binding.written, true, '更新应刷新绑定');

    const after = readJson(path.join(appDir, 'install-binding.json'));
    assert.equal(after.clientProfile, 'workbuddy-ai', '更新不得改 profile');
    assert.equal(path.resolve(after.dataDir).toLowerCase(), path.resolve(before.dataDir).toLowerCase(),
      '更新不得改数据目录');
    assert.equal(path.resolve(after.appDir).toLowerCase(), path.resolve(appDir).toLowerCase());
  });

  test('卸载：删自己的绑定；指向别的安装的绑定留着并说明原因', () => {
    const root = tmpRoot('bind-uninstall');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    const inst = runPs(installPs1, baseArgs(src, appDir, dataDir), root);
    assert.equal(inst.code, 0, inst.stdout);

    const r = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.binding.removed, true, '自己写的那份应删除');
    assert.equal(fs.existsSync(path.join(appDir, 'install-binding.json')), false);

    // 伪造一份「属于另一个安装」的绑定：appDir 指向别处，必须保留
    const root2 = tmpRoot('bind-foreign');
    const src2 = makeSource(root2, '1.3.0');
    const appDir2 = path.join(root2, 'app');
    const dataDir2 = path.join(root2, 'data');
    assert.equal(runPs(installPs1, baseArgs(src2, appDir2, dataDir2), root2).code, 0);
    const foreign = path.join(appDir2, 'install-binding.json');
    writeFile(foreign, JSON.stringify({
      schema: 1, clientProfile: 'workbuddy-cn',
      dataDir: dataDir2, appDir: path.join(root2, 'another-install'),
      updatedAt: '2026-01-01T00:00:00Z',
    }, null, 2));
    const r2 = runPs(uninstallPs1, ['-AppDir', appDir2, '-DataDir', dataDir2], root2);
    assert.equal(r2.code, 0, r2.stdout);
    assert.equal(r2.report.binding.removed, false);
    assert.match(String(r2.report.binding.reason), /另一个安装/);
    assert.ok(fs.existsSync(foreign), '别处的绑定不能删');
  });

  test('绑定文件损坏：安装记录仍然能卸载，且不删坏文件', () => {
    const root = tmpRoot('bind-broken');
    const src = makeSource(root, '1.3.0');
    const appDir = path.join(root, 'app');
    const dataDir = path.join(root, 'data');
    assert.equal(runPs(installPs1, baseArgs(src, appDir, dataDir), root).code, 0);
    const bindPath = path.join(appDir, 'install-binding.json');
    writeFile(bindPath, '{ not json');

    const r = runPs(uninstallPs1, ['-AppDir', appDir, '-DataDir', dataDir], root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.binding.removed, false);
    assert.ok(fs.existsSync(bindPath), '解析不了的绑定不删，交给人工确认');
  });
}

main();
