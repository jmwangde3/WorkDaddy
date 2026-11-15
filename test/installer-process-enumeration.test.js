'use strict';
/**
 * Get-WorkDaddyProcesses 的二次查询语义（1.3.1 RC2 阶段 1）。
 *
 * 旧写法把「查询异常」和「PID 已消失」当成同一件事：
 *   try { $again = Get-CimInstance ... } catch { }
 *   if (-not $again) { continue }
 * 查询失败时 $again 也是 $null，于是进程被当作不存在 —— 这是 fail-open。
 *
 * 这里用 mock 的 Get-CimInstance（覆盖 cmdlet）跑真实函数，只验证最终返回结构，
 * 不碰真实进程、不依赖本机装了什么。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fx = require('./helpers/installer-fixture');

const probe = path.join(__dirname, 'fixtures', 'cim-requery-probe.ps1');
const isWin = process.platform === 'win32';
const opts = isWin ? {} : { skip: '仅 Windows（CIM / PowerShell）' };

function run(mode) {
  const root = fx.tmpRoot('cim-requery-' + mode);
  const appDir = path.join(root, 'app');
  const r = fx.runPs(probe, ['-Mode', mode, '-AppDir', appDir], root);
  assert.ok(r.report, '探针没有写报告：' + (r.stderr || r.stdout));
  return r.report;
}

test.after(() => fx.cleanup());

test('二次查询成功且 PID 已消失：按「进程不存在」处理，不残留 unreadable', opts, () => {
  const r = run('gone');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.unreadable, []);
  assert.deepEqual(r.processes, []);
  assert.equal(r.requeries, 1, '必须真的复读一次');
});

test('二次查询抛异常：必须保留 unreadable 并失败，不得当成进程消失', opts, () => {
  const r = run('throw');
  assert.equal(r.ok, false, '查询失败时不能给出 ok=true');
  assert.deepEqual(r.unreadable, [4242], '无法确认身份的 PID 必须留在 unreadable 里');
  assert.equal(r.requeryErrors.length, 1, '要带出复读失败的原因');
  assert.match(String(r.requeryErrors[0]), /simulated provider error/);
  assert.match(String(r.error), /读不到身份/, '沿用原有错误结构');
  assert.match(String(r.error), /复读失败原因/, '查询异常要能和「字段仍为空」区分开');
});

test('二次查询成功但字段仍为空：保持失败关闭', opts, () => {
  const r = run('still');
  assert.equal(r.ok, false);
  assert.deepEqual(r.unreadable, [4242]);
  assert.equal(r.processes.length, 0);
});

test('二次查询读到有效 daemon 命令行：正确归属，不再 unreadable', opts, () => {
  const r = run('daemon');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.unreadable, []);
  assert.deepEqual(r.processes, [{ pid: 4242, role: 'daemon' }]);
  assert.equal(r.requeries, 1);
});
