// 进程身份字段读不全时的容错边界。
//
// 背景：WorkBuddy 5.11.x 起带 prewarm 进程池，进程会在查询瞬间退出，
// CommandLine / ExecutablePath 随之变空。旧实现把「单条字段不全」当成
// 「整条查询失败」抛出，于是一个瞬时进程就能让列表查询作废 —— 真实表现是
// 安装目录里明明有客户端在跑，launcher 却报 CIM 退出码 1 直接崩掉。
//
// 这里钉住三件事：
//   1. 列表查询跳过读不全的进程，但把跳过事实写到 stderr 供上層区分；
//   2. 单 PID 的精确验证仍然严格抛错（安全边界不能被这次修复削弱）；
//   3. 一条都解析不出来时不返回空数组 —— 那会被当成「客户端没在跑」而误启动。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const boundary = require('../scripts/windows-process-boundary.js');
const helperPs1 = path.join(__dirname, '..', 'scripts', 'windows-process-boundary.ps1');

const isWindows = process.platform === 'win32';

function runPs(script) {
  // Windows PowerShell 5.1 默认按控制台代码页（中文机器是 936）写管道输出，
  // 直接当 UTF-8 解码会把错误消息变成乱码。先钉住输出编码再跑。
  const prelude = '[Console]::OutputEncoding = [Text.Encoding]::UTF8\n';
  const res = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', prelude + script], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  return { code: res.status, out: String(res.stdout || ''), err: String(res.stderr || '') };
}

// 用假对象喂给转换函数：不碰真实进程，也不依赖当前机器装了什么。
function callConvert(fnName, recordJson) {
  const script = [
    `. '${helperPs1.replace(/'/g, "''")}'`,
    `$fake = '${recordJson}' | ConvertFrom-Json`,
    `try {`,
    `  $r = ${fnName} -Process $fake`,
    `  if ($null -eq $r) { Write-Output 'RESULT=null' } else { Write-Output ('RESULT=record pid=' + $r.ProcessId) }`,
    `} catch {`,
    `  Write-Output ('THREW=' + $_.Exception.Message)`,
    `}`,
  ].join('\n');
  return runPs(script);
}

const MISSING_COMMANDLINE = JSON.stringify({
  ProcessId: 999991, ParentProcessId: 1, Name: 'WorkBuddy.exe',
  ExecutablePath: 'C:\\x\\WorkBuddy.exe', CommandLine: null,
});

const MISSING_EXECUTABLE = JSON.stringify({
  ProcessId: 999992, ParentProcessId: 1, Name: 'WorkBuddy.exe',
  ExecutablePath: '', CommandLine: '"C:\\x\\WorkBuddy.exe"',
});

test('列表查询：字段读不全的进程被跳过，并留下可解析的标记', { skip: !isWindows && '仅 Windows' }, () => {
  for (const [label, payload] of [['CommandLine 为空', MISSING_COMMANDLINE], ['ExecutablePath 为空', MISSING_EXECUTABLE]]) {
    const r = callConvert('ConvertTo-WorkDaddyProcessRecordIfPresent', payload);
    assert.equal(r.code, 0, label + ' 不应让脚本以非零码退出：' + r.err);
    assert.match(r.out, /RESULT=null/, label + ' 应被跳过并返回 null，实际：' + r.out);
    assert.equal(/THREW=/.test(r.out), false, label + ' 不应抛错，实际：' + r.out);
    assert.match(r.err, /WBD-PROCESS-SKIPPED 99999\d/, label + ' 应在 stderr 留一行跳过标记，实际：' + r.err);
  }
});

test('单 PID 精确验证：同样的输入仍然必须抛错', { skip: !isWindows && '仅 Windows' }, () => {
  const r = callConvert('ConvertTo-WorkDaddyProcessRecord', MISSING_COMMANDLINE);
  assert.match(r.out, /THREW=/, '严格路径不能因为这次修复变宽松，实际：' + r.out);
  assert.match(r.out, /字段不完整/, '错误消息应说明字段不完整，实际：' + r.out);
});

test('解析器：一条都解析不出来时不能返回空数组', () => {
  const stderr = [
    'WBD-PROCESS-SKIPPED 12852 CIM 进程身份字段不完整',
    'WBD-PROCESS-SKIPPED 35616 CIM 进程身份字段不完整',
  ].join('\r\n');

  for (const stdout of ['', '[]']) {
    assert.throws(
      () => boundary.parseCimProcessResult({ status: 0, stdout, stderr }),
      /一个都无法确认身份/,
      'stdout=' + JSON.stringify(stdout) + ' 且有进程被跳过时，必须报错而不是返回空数组'
    );
  }
});

test('解析器：部分可读时返回可读的那些', () => {
  const good = {
    ProcessId: 12852,
    Name: 'WorkBuddy.exe',
    ExecutablePath: 'H:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    CommandLine: '"H:\\Program Files\\WorkBuddy\\WorkBuddy.exe"',
    Owner: 'PC\\user',
    OwnerIsCurrent: true,
    Arguments: ['H:\\Program Files\\WorkBuddy\\WorkBuddy.exe'],
  };
  const rows = boundary.parseCimProcessResult({
    status: 0,
    stdout: JSON.stringify(good),
    stderr: 'WBD-PROCESS-SKIPPED 35616 CIM 进程身份字段不完整\r\n',
  }, { requireCommandLine: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ProcessId, 12852);
});

test('解析器：真的没有进程时返回空数组', () => {
  assert.deepEqual(boundary.parseCimProcessResult({ status: 0, stdout: '', stderr: '' }), []);
});

test('解析器：没有跳过标记时，普通查询错误仍按原样抛出', () => {
  assert.throws(
    () => boundary.parseCimProcessResult({ status: 1, stdout: '', stderr: 'Access denied' }),
    /exited with status 1/,
    '原有错误路径不能被跳过逻辑吞掉'
  );
});
