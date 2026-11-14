// 进程身份字段读不全时的容错与分类边界。
//
// 背景：WorkBuddy 5.11.x 起带 prewarm 进程池，进程会在查询瞬间退出，
// CommandLine / ExecutablePath 随之变空。旧实现把「单条字段不全」当成
// 「整条查询失败」抛出，于是一个瞬时进程就能让列表查询作废 —— 真实表现是
// 安装目录里明明有客户端在跑，launcher 却报 CIM 退出码 1 直接崩掉。
//
// 现在的要求是「分类 + 失败关闭」：
//   - 只有明确确认进程消失（PROCESS_DISAPPEARED）才允许静默跳过；
//   - 其它跳过都带类型（ACCESS_DENIED / PATH_UNVERIFIED / ... / UNKNOWN_ERROR）；
//   - 一条都验证不出来时不返回空数组 —— 那会被当成「客户端没在跑」而误启动；
//   - 单 PID 的精确验证仍然严格抛错（安全边界不能被这次修复削弱）。
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

const MISSING_BOTH = JSON.stringify({
  ProcessId: 999993, ParentProcessId: 1, Name: 'WorkBuddy.exe',
  ExecutablePath: '', CommandLine: null,
});

const MISSING_NAME = JSON.stringify({
  ProcessId: 999994, ParentProcessId: 1, Name: '', ExecutablePath: 'C:\\x\\WorkBuddy.exe',
  CommandLine: '"C:\\x\\WorkBuddy.exe"',
});

test('列表查询：字段读不全的进程被跳过，并带上可解析的类型', { skip: !isWindows && '仅 Windows' }, () => {
  const cases = [
    ['CommandLine 为空', MISSING_COMMANDLINE, 'COMMANDLINE_UNVERIFIED'],
    ['ExecutablePath 为空', MISSING_EXECUTABLE, 'PATH_UNVERIFIED'],
    ['进程名为空', MISSING_NAME, 'NAME_UNVERIFIED'],
  ];
  for (const [label, payload, kind] of cases) {
    const r = callConvert('ConvertTo-WorkDaddyProcessRecordIfPresent', payload);
    assert.equal(r.code, 0, label + ' 不应让脚本以非零码退出：' + r.err);
    assert.match(r.out, /RESULT=null/, label + ' 应被跳过并返回 null，实际：' + r.out);
    assert.equal(/THREW=/.test(r.out), false, label + ' 不应抛错，实际：' + r.out);
    assert.match(r.err, new RegExp('WBD-PROCESS-SKIPPED 9999\\d+ ' + kind), label + ' 应带类型标记，实际：' + r.err);
  }
});

test('列表查询：路径与命令行同时读不到时，不靠猜，实际探测后归类', { skip: !isWindows && '仅 Windows' }, () => {
  // 这个假 PID 在真实系统里不存在，探测应得出「不是权限问题」，于是归为瞬时缺失；
  // 关键是它必须落在一个明确类型上，而不是含糊的 UNKNOWN。
  const r = callConvert('ConvertTo-WorkDaddyProcessRecordIfPresent', MISSING_BOTH);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RESULT=null/, r.out);
  assert.match(r.err, /WBD-PROCESS-SKIPPED 999993 (TRANSIENT_FIELD_MISSING|ACCESS_DENIED)/,
    '两个字段都为空时必须落到明确类型，实际：' + r.err);
});

test('单 PID 精确验证：同样的输入仍然必须抛错，且带类型前缀', { skip: !isWindows && '仅 Windows' }, () => {
  const r = callConvert('ConvertTo-WorkDaddyProcessRecord', MISSING_COMMANDLINE);
  assert.match(r.out, /THREW=/, '严格路径不能因为这次修复变宽松，实际：' + r.out);
  assert.match(r.out, /WBD-COMMANDLINE_UNVERIFIED/, '应指出缺的是命令行，实际：' + r.out);
});

test('解析器：一条都解析不出来时不能返回空数组', () => {
  const stderr = [
    'WBD-PROCESS-SKIPPED 12852 UNKNOWN_ERROR CIM 进程身份字段不完整',
    'WBD-PROCESS-SKIPPED 35616 UNKNOWN_ERROR CIM 进程身份字段不完整',
  ].join('\r\n');

  for (const stdout of ['', '[]']) {
    assert.throws(
      () => boundary.parseCimProcessResult({ status: 0, stdout, stderr }),
      /无法确认身份/,
      'stdout=' + JSON.stringify(stdout) + ' 且有进程被跳过时，必须报错而不是返回空数组'
    );
  }
});

test('解析器：部分可读时返回可读的那些，并标记枚举不完整', () => {
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
    stderr: 'WBD-PROCESS-SKIPPED 35616 COMMANDLINE_UNVERIFIED 缺少命令行\r\n',
  }, { requireCommandLine: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ProcessId, 12852);
  assert.equal(rows.complete, false, '有进程没验证成时，必须标记为不完整');
  assert.equal(rows.skipped.length, 1);
  assert.equal(rows.skipped[0].kind, 'COMMANDLINE_UNVERIFIED');
});

test('解析器：全部 ACCESS_DENIED 时指出权限问题而不是让人重试', () => {
  const stderr = [
    'WBD-PROCESS-SKIPPED 12852 ACCESS_DENIED CIM 进程身份字段不完整',
    'WBD-PROCESS-SKIPPED 35616 ACCESS_DENIED CIM 进程身份字段不完整',
  ].join('\r\n');
  assert.throws(
    () => boundary.parseCimProcessResult({ status: 0, stdout: '', stderr }),
    (err) => {
      assert.match(err.message, /管理员权限/, '应指出客户端可能是管理员权限运行');
      assert.match(err.message, /完全退出客户端/, '应给出可执行的处置办法');
      assert.equal(/稍后重试/.test(err.message), false, '权限问题不该让人反复重试');
      return true;
    }
  );
});

test('解析器：全部瞬时缺失时给出「稍后重试」', () => {
  const stderr = 'WBD-PROCESS-SKIPPED 12852 TRANSIENT_FIELD_MISSING 进程正在退出\r\n';
  assert.throws(
    () => boundary.parseCimProcessResult({ status: 0, stdout: '', stderr }),
    /稍后重试即可/,
    '瞬时缺失是可以通过重试恢复的，不该按权限问题处置'
  );
});

test('解析器：混合原因时不误报成权限问题', () => {
  const stderr = [
    'WBD-PROCESS-SKIPPED 12852 ACCESS_DENIED CIM 进程身份字段不完整',
    'WBD-PROCESS-SKIPPED 35616 UNKNOWN_ERROR 某种未知失败',
  ].join('\r\n');
  assert.throws(
    () => boundary.parseCimProcessResult({ status: 0, stdout: '', stderr }),
    (err) => {
      assert.equal(/管理员权限/.test(err.message), false, '只要有一条不是 ACCESS_DENIED，就不能断言是权限问题');
      assert.match(err.message, /分类=/, '应把分类统计带出来，便于定位');
      return true;
    }
  );
});

test('解析器：真的没有进程时返回空数组且标记完整', () => {
  const rows = boundary.parseCimProcessResult({ status: 0, stdout: '', stderr: '' });
  assert.deepEqual([...rows], []);
  assert.equal(rows.complete, true);
  assert.deepEqual(rows.skipped, []);
});

test('解析器：没有跳过标记时，普通查询错误仍按原样抛出', () => {
  assert.throws(
    () => boundary.parseCimProcessResult({ status: 1, stdout: '', stderr: 'Access denied' }),
    /exited with status 1/,
    '原有错误路径不能被跳过逻辑吞掉'
  );
});

// 危险决策（结束进程、替换程序文件）读的是这个结构，而不是裸数组。
// 关键语义：processes 为空 + complete=false 意味着「有进程但一个都没验证成」，
// 与「确实没有进程在跑」是两件事，混用会导致误启动或误杀。
test('结构化枚举：部分成功时给出 processes/skipped/complete/errors 四件套', () => {
  const good = {
    ProcessId: 4001,
    Name: 'WorkBuddy.exe',
    ExecutablePath: 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    CommandLine: '"C:\\Program Files\\WorkBuddy\\WorkBuddy.exe"',
    Owner: 'HOST\\tester',
    OwnerIsCurrent: true,
    ArgumentsSource: 'CommandLineToArgvW',
    Arguments: ['C:\\Program Files\\WorkBuddy\\WorkBuddy.exe'],
  };
  const result = boundary.enumerateCimProcesses({
    status: 0,
    stdout: JSON.stringify(good),
    stderr: 'WBD-PROCESS-SKIPPED 4002 ACCESS_DENIED 无法读取进程路径\n',
  }, { requireCommandLine: true, requireCurrentOwner: true, requireNativeArguments: true });
  assert.equal(result.processes.length, 1, '可读的那条要保留');
  assert.equal(result.complete, false, '有跳过就不能算完整枚举');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].kind, 'ACCESS_DENIED');
  assert.deepEqual(result.errors, result.skipped, 'errors 是 skipped 的显式视图');

  const clean = boundary.enumerateCimProcesses({ status: 0, stdout: JSON.stringify(good), stderr: '' }, {
    requireCommandLine: true, requireCurrentOwner: true, requireNativeArguments: true,
  });
  assert.equal(clean.complete, true, '没有任何跳过时才是完整枚举');
  assert.deepEqual(clean.errors, []);
});
