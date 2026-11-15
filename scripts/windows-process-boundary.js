'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ALLOWED_WORKBUDDY_PROCESS_NAMES = new Set([
  'workbuddy.exe',
  'workbuddyai.exe',
  'codebuddy.exe',
]);

function detectWindowsPrivilege(run = spawnSync) {
  const command = "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
  let result;
  try {
    result = run('powershell', ['-NoProfile', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout: 8000,
    });
  } catch (error) {
    throw new Error(`无法确认 Windows 进程权限: ${error.message}`);
  }
  if (!result || result.error) {
    throw (result && result.error) || new Error('无法确认 Windows 进程权限');
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new Error(`无法确认 Windows 进程权限${detail ? ': ' + detail : ''}`);
  }
  const value = String(result.stdout || '').trim().toLowerCase();
  if (value === 'false') return 'standard';
  if (value === 'true') return 'elevated';
  throw new Error('无法确认 Windows 进程是否为普通用户权限');
}

// Native children inherit the real Windows token. Ask the installed helper to
// verify it (including saved consent for elevated sessions), never an env flag.
function detectNativeWindowsPrivilege(appDir, profile, run = spawnSync) {
  const result = run(path.join(appDir, 'WorkDaddyLauncher.exe'), [
    '--launch-context', '--profile', profile, '--app-dir', appDir,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (!result || result.error || result.status !== 0) {
    throw new Error('无法验证 Windows 启动权限或兼容安装授权，请重新运行安装程序');
  }
  let context;
  try { context = JSON.parse(result.stdout); } catch (_) {
    throw new Error('Windows 启动权限检测返回无效数据');
  }
  if (!context || context.profile !== profile ||
      !['standard', 'elevated'].includes(context.privilege)) {
    throw new Error('Windows 启动权限或客户端身份不匹配');
  }
  return context.privilege;
}

function assertStandardWindowsPrivilege(run = spawnSync) {
  const privilege = detectWindowsPrivilege(run);
  if (privilege !== 'standard') throw new Error('拒绝以管理员或 elevated 权限运行 WorkDaddy');
  return privilege;
}

function validateProcessRecord(row, options = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('CIM process query returned an invalid process record');
  }
  const pid = row.ProcessId;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('CIM process record has an invalid PID');
  const name = typeof row.Name === 'string' ? row.Name.trim() : '';
  if (!name) throw new Error(`CIM process record ${pid} has no Name`);
  const executable = typeof row.ExecutablePath === 'string' ? row.ExecutablePath.trim() : '';
  if (!executable || !path.win32.isAbsolute(executable)) {
    throw new Error(`CIM process record ${pid} has no absolute executable path`);
  }
  if (options.requireCommandLine && (typeof row.CommandLine !== 'string' || !row.CommandLine.trim())) {
    throw new Error(`CIM process record ${pid} has no command line`);
  }
  let nativeArguments;
  if (options.requireNativeArguments) {
    if (row.ArgumentsSource !== 'CommandLineToArgvW' || !Array.isArray(row.Arguments) || !row.Arguments.length) {
      throw new Error(`CIM process record ${pid} has no trusted native Arguments`);
    }
    if (row.Arguments.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new Error(`CIM process record ${pid} has invalid native Arguments`);
    }
    nativeArguments = [...row.Arguments];
  }
  const owner = typeof row.Owner === 'string' ? row.Owner.trim() : '';
  if (options.requireCurrentOwner) {
    if (!owner) throw new Error(`CIM process record ${pid} has no owner`);
    if (row.OwnerIsCurrent !== true) {
      throw new Error(`CIM process record ${pid} is not owned by the current user`);
    }
  }
  return {
    ...row,
    ProcessId: pid,
    Name: name,
    ExecutablePath: executable,
    ...(owner ? { Owner: owner } : {}),
    ...(nativeArguments ? { Arguments: nativeArguments } : {}),
  };
}

// helper 对读不全的进程写一行 WBD-PROCESS-SKIPPED <pid> <KIND> <原因>。
// KIND 取自 PROCESS_DISAPPEARED / TRANSIENT_FIELD_MISSING / ACCESS_DENIED /
// OWNER_UNVERIFIED / PATH_UNVERIFIED / COMMANDLINE_UNVERIFIED / UNKNOWN_ERROR。
// 调用方需要区分「没有进程」和「有进程但没验证成」：后者绝不能拿去当危险决策的输入。
const SKIPPED_PROCESS_MARKER = 'WBD-PROCESS-SKIPPED';
const SKIP_KINDS = new Set([
  'PROCESS_DISAPPEARED', 'TRANSIENT_FIELD_MISSING', 'ACCESS_DENIED',
  'OWNER_UNVERIFIED', 'PATH_UNVERIFIED', 'COMMANDLINE_UNVERIFIED', 'UNKNOWN_ERROR',
]);
function parseSkippedProcesses(stderr) {
  const skipped = [];
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const at = line.indexOf(SKIPPED_PROCESS_MARKER);
    if (at < 0) continue;
    const rest = line.slice(at + SKIPPED_PROCESS_MARKER.length).trim();
    const structured = rest.match(/^(\d+)\s+([A-Z_]+)\s*(.*)$/);
    if (structured && SKIP_KINDS.has(structured[2])) {
      skipped.push({ pid: Number(structured[1]), kind: structured[2], reason: structured[3].trim() });
      continue;
    }
    // 兼容旧格式（只有 pid + 原因）：不猜类型，按未知处理，让调用方失败关闭。
    const pidOnly = (rest.match(/^\d+/) || [''])[0];
    skipped.push({
      pid: pidOnly ? Number(pidOnly) : null,
      kind: 'UNKNOWN_ERROR',
      reason: rest.slice(pidOnly.length).trim(),
    });
  }
  return skipped;
}

// 把「为什么有的进程没验证成」翻译成用户能照做的处置说明。
function describeSkippedProcesses(skipped) {
  const items = Array.isArray(skipped) ? skipped : [];
  if (!items.length) return '';
  const ids = items.map((item) => item.pid || '?').join(',');
  const kindSummary = () => {
    const counts = new Map();
    for (const item of items) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
    return [...counts.entries()].map(([kind, n]) => `${kind}×${n}`).join(',');
  };
  // 全部 ACCESS_DENIED：对端进程完整性级别更高。重试没有意义，得改权限。
  if (items.every((item) => item.kind === 'ACCESS_DENIED')) {
    return `检测到 ${items.length} 个客户端进程，但一个都读不到（PID=${ids}）。` +
      '客户端多半是以管理员权限运行的，而 WorkDaddy 以普通权限运行 —— ' +
      '这种情况下 Windows 不允许读取对方进程信息，也不允许结束它。' +
      '请先完全退出客户端（主窗口和托盘一起），再双击 WorkDaddy 桌面图标，' +
      '由 WorkDaddy 以普通权限重新启动它。';
  }
  // 全部是「瞬时读不到」：可能刚重启，重试有意义。
  const transientKinds = new Set(['TRANSIENT_FIELD_MISSING', 'PATH_UNVERIFIED', 'COMMANDLINE_UNVERIFIED', 'OWNER_UNVERIFIED']);
  if (items.every((item) => transientKinds.has(item.kind))) {
    const first = items.find((item) => item.reason) || {};
    const detail = first.reason ? `；首个原因：${String(first.reason).slice(0, 160)}` : '';
    return `检测到 ${items.length} 个进程，但身份字段暂时读不全（PID=${ids}）${detail}；稍后重试即可。`;
  }
  // 其余组合（含 UNKNOWN_ERROR）：不猜，按失败处理，绝不当作「没有进程」。
  const first = items.find((item) => item.reason) || {};
  const detail = first.reason ? `；首个原因（${first.kind}）：${String(first.reason).slice(0, 160)}` : '';
  return `检测到 ${items.length} 个进程，但无法确认身份（PID=${ids}；分类=${kindSummary()}）${detail}；` +
    '为避免在信息不全时误操作，本次查询按失败处理。';
}

// 「枚举是否完整」是数组上的非枚举属性，任何 .filter()/.map() 都会把它丢掉。
// 这不是纯粹的写法问题：丢掉之后「有进程但没验证成」会退化成「没有进程」，
// 结束进程/替换文件就会拿着半份清单去执行。所有对结果二次筛选的地方都必须
// 用 carryProcessEnumeration() 显式接上，危险操作前再用
// assertCompleteProcessEnumeration() 拦一次。
const ENUMERATION_META_KEYS = ['skipped', 'errors', 'complete'];

function normalizeEnumerationMeta(meta = {}) {
  const skipped = (Array.isArray(meta.skipped) ? meta.skipped : []).map((item) => ({
    pid: Number.isSafeInteger(item && item.pid) ? item.pid : null,
    kind: String((item && item.kind) || 'UNKNOWN_ERROR'),
    reason: String((item && item.reason) || ''),
  }));
  return {
    skipped,
    errors: Array.isArray(meta.errors) ? meta.errors : skipped,
    // 没有元信息的普通数组（测试替身、旧调用方）按完整处理；只有明确
    // complete === false 才算不完整。
    complete: !(meta.complete === false),
  };
}

function readProcessEnumeration(rows) {
  const source = Array.isArray(rows) ? rows : null;
  return normalizeEnumerationMeta(source
    ? { skipped: source.skipped, errors: source.errors, complete: source.complete }
    : {});
}

function withProcessEnumeration(rows, meta = {}) {
  if (!Array.isArray(rows)) throw new Error('Process enumeration metadata requires an array');
  const { skipped, errors, complete } = normalizeEnumerationMeta(meta);
  for (const key of ENUMERATION_META_KEYS) {
    Object.defineProperty(rows, key, {
      value: key === 'complete' ? complete : key === 'skipped' ? skipped : errors,
      enumerable: false,
      configurable: true,
    });
  }
  return rows;
}

function carryProcessEnumeration(source, rows) {
  return withProcessEnumeration(rows, readProcessEnumeration(source));
}

function assertCompleteProcessEnumeration(rows, action = '本次操作') {
  const { skipped, complete } = readProcessEnumeration(rows);
  if (complete) return rows;
  const error = new Error(
    `${action}需要完整的进程清单，但这次只验证出其中一部分，无法确认是否还有客户端进程在运行，已中止。` +
    describeSkippedProcesses(skipped)
  );
  error.code = 'PROCESS_ENUMERATION_INCOMPLETE';
  error.skipped = skipped;
  throw error;
}

function parseCimProcessResult(result, options = {}) {
  if (!result || result.error) {
    throw (result && result.error) || new Error('CIM process query did not return a result');
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    if (options.allowTransientNotFound && /(0x80041002|ObjectNotFound|not found)/i.test(detail)) return [];
    throw new Error(`CIM process query exited with status ${result.status}${detail ? ': ' + detail : ''}`);
  }
  const skipped = parseSkippedProcesses(result.stderr);
  const describeSkipped = () => describeSkippedProcesses(skipped);
  const withMetadata = (rows) => withProcessEnumeration(rows, {
    skipped,
    complete: skipped.length === 0,
    errors: skipped.map((item) => ({ pid: item.pid, kind: item.kind, reason: item.reason })),
  });
  const output = String(result.stdout || '').trim();
  if (!output) {
    if (skipped.length) throw new Error(describeSkipped());
    return withMetadata([]);
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`CIM process query returned invalid JSON: ${error.message}`);
  }
  const rows = (Array.isArray(parsed) ? parsed : [parsed])
    .map((row) => validateProcessRecord(row, options))
    .filter(Boolean);
  if (!rows.length && skipped.length) throw new Error(describeSkipped());
  return withMetadata(rows);
}

// 显式结构化枚举（任务书 5.2）。数组 + 隐藏属性的形式对老调用方友好，
// 但要做「结束进程」「替换程序文件」这类决定时，用一个说得清的结构更安全：
// complete=false 的含义是「确实有进程存在，但至少一条没验证成」，
// 它和「没有进程在跑」是两件完全不同的事，绝不能混用。
function enumerateCimProcesses(result, options = {}) {
  const processes = parseCimProcessResult(result, options);
  return {
    processes,
    skipped: processes.skipped || [],
    errors: processes.errors || [],
    complete: processes.complete !== false,
  };
}

function resolveWindowsExecutable(value, realpath = fs.realpathSync.native) {
  const candidate = String(value || '').trim();
  if (!candidate || !path.win32.isAbsolute(candidate)) {
    throw new Error('Windows executable path must be absolute');
  }
  const resolved = String(realpath(candidate) || '').trim();
  if (!resolved || !path.win32.isAbsolute(resolved)) {
    throw new Error('Windows executable path could not be resolved');
  }
  return path.win32.normalize(resolved);
}

function sameWindowsPath(a, b) {
  return path.win32.normalize(String(a)).replace(/[\\/]+$/, '').toLowerCase() ===
    path.win32.normalize(String(b)).replace(/[\\/]+$/, '').toLowerCase();
}

function resolveWindowsCommandToken(value, realpath = fs.realpathSync.native) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error('Windows command token path contains leading, trailing, or control whitespace');
  }
  return resolveWindowsExecutable(value, realpath);
}

function buildNativeProcessQuery(helperPath, processSource) {
  const helper = String(helperPath || '');
  const source = String(processSource || '');
  if (!path.win32.isAbsolute(helper) || /[\r\n\0]/.test(helper) || !source.trim()) {
    throw new Error('Native process query requires a trusted absolute helper and source');
  }
  const quotedHelper = helper.replace(/'/g, "''");
  // [Console]::OutputEncoding 必须先钉成 UTF-8：Windows PowerShell 5.1 默认按控制台
  // 代码页（中文机器是 936）写管道，Node 侧按 UTF-8 解码会把 helper 抛出的中文
  // 错误消息变成乱码 —— 排查时看到的是一串问号，等于把诊断信息扔了。
  const prelude = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ';
  return `${prelude}. '${quotedHelper}'; ${source} | ForEach-Object { ConvertTo-WorkDaddyProcessRecordIfPresent -Process $_ } | Where-Object { $null -ne $_ } | ConvertTo-Json -Compress -Depth 4`;
}

function sameWindowsFilePath(a, b) {
  return path.win32.normalize(String(a)).toLowerCase() ===
    path.win32.normalize(String(b)).toLowerCase();
}

function assertSameProcessIdentity(original, current) {
  const requirements = { requireCommandLine: true, requireCurrentOwner: true, requireNativeArguments: true };
  const before = validateProcessRecord(original, requirements);
  const after = validateProcessRecord(current, requirements);
  if (before.ProcessId !== after.ProcessId ||
      before.Name.toLowerCase() !== after.Name.toLowerCase() ||
      !sameWindowsPath(before.ExecutablePath, after.ExecutablePath) ||
      before.CommandLine !== after.CommandLine ||
      before.Arguments.length !== after.Arguments.length ||
      before.Arguments.some((argument, index) => argument !== after.Arguments[index]) ||
      before.Owner.toLowerCase() !== after.Owner.toLowerCase()) {
    throw new Error(`Process identity or owner changed before termination for PID ${before.ProcessId}`);
  }
  return after;
}

function filterVerifiedWindowsProcesses(expectedBinary, processes, realpath = fs.realpathSync.native, allowedProcessNames = null) {
  const expected = resolveWindowsExecutable(expectedBinary, realpath);
  const expectedDir = path.win32.dirname(expected);
  const expectedName = path.win32.basename(expected).toLowerCase();
  const allowedNames = allowedProcessNames
    ? new Set(Array.from(allowedProcessNames, (name) => String(name).toLowerCase()))
    : new Set([expectedName]);
  if (!allowedNames.has(expectedName) || Array.from(allowedNames).some((name) => !/^[^\\/:*?"<>|\0]+\.exe$/i.test(name)) ||
      (!allowedProcessNames && !ALLOWED_WORKBUDDY_PROCESS_NAMES.has(expectedName))) {
    throw new Error('Expected executable is not a WorkBuddy-family binary');
  }
  const verified = [];
  for (const item of Array.isArray(processes) ? processes : []) {
    const process = validateProcessRecord(item);
    const name = process.Name.toLowerCase();
    if (!allowedNames.has(name)) continue;
    let executable;
    try {
      executable = resolveWindowsExecutable(process.ExecutablePath, realpath);
    } catch (error) {
      // A process can disappear between CIM enumeration and realpath.
      if (error && error.code === 'ENOENT') continue;
      throw new Error(`Cannot verify executable path for PID ${process.ProcessId}`);
    }
    if (path.win32.basename(executable).toLowerCase() !== name) {
      throw new Error(`Executable name does not match CIM Name for PID ${process.ProcessId}`);
    }
    if (!sameWindowsPath(path.win32.dirname(executable), expectedDir)) continue;
    verified.push({ ...process, ExecutablePath: executable });
  }
  return verified;
}

function selectVerifiedProcessPids(expectedBinary, processes, realpath = fs.realpathSync.native) {
  return filterVerifiedWindowsProcesses(expectedBinary, processes, realpath)
    .map((process) => process.ProcessId);
}

function selectRunningProfileBinary(profileNames, processes, realpath = fs.realpathSync.native) {
  const names = profileNames instanceof Set ? profileNames : new Set(profileNames || []);
  const binaries = new Map();
  for (const item of Array.isArray(processes) ? processes : []) {
    const process = validateProcessRecord(item);
    const name = process.Name.toLowerCase();
    if (!names.has(name)) continue;
    let executable;
    try { executable = resolveWindowsExecutable(process.ExecutablePath, realpath); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (path.win32.basename(executable).toLowerCase() !== name) {
      throw new Error(`Executable name does not match CIM Name for PID ${process.ProcessId}`);
    }
    binaries.set(executable.toLowerCase(), executable);
  }
  if (binaries.size > 1) throw new Error('检测到当前 profile 在多个安装目录运行，无法安全选择目标');
  return binaries.size ? Array.from(binaries.values())[0] : null;
}

function selectUniqueDiscoveredBinary(profileNames, candidates, realpath = fs.realpathSync.native) {
  const names = profileNames instanceof Set ? profileNames : new Set(profileNames || []);
  const binaries = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    let executable;
    try { executable = resolveWindowsExecutable(candidate, realpath); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!names.has(path.win32.basename(executable).toLowerCase())) continue;
    binaries.set(executable.toLowerCase(), executable);
  }
  if (binaries.size > 1) {
    throw new Error('检测到当前 profile 的多个安装目录；请用 WBSWITCH_WORKBUDDY_BIN 明确指定目标');
  }
  return binaries.size ? Array.from(binaries.values())[0] : null;
}

// Discovery order is a priority order in the callers: explicit profile path,
// registry entries, conventional installs, then bounded scans. Dormant copies
// should not make startup fail when the first valid candidate is unambiguous.
function selectPreferredDiscoveredBinary(profileNames, candidates, realpath = fs.realpathSync.native) {
  const names = profileNames instanceof Set ? profileNames : new Set(profileNames || []);
  const seen = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    let executable;
    try { executable = resolveWindowsExecutable(candidate, realpath); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!names.has(path.win32.basename(executable).toLowerCase())) continue;
    const key = executable.toLowerCase();
    if (!seen.has(key)) seen.set(key, executable);
  }
  return seen.size ? Array.from(seen.values())[0] : null;
}

function filterVerifiedNodeProcesses(expectedNode, expectedScript, processes, realpath = fs.realpathSync.native) {
  let node;
  let script;
  try {
    node = resolveWindowsExecutable(expectedNode, realpath);
    script = resolveWindowsExecutable(expectedScript, realpath);
  } catch (error) {
    // Stale installs and in-flight updates can remove the expected runtime or
    // script after discovery. There is no verified process to return then.
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const verified = [];
  for (const item of Array.isArray(processes) ? processes : []) {
    const process = validateProcessRecord(item, { requireCommandLine: true, requireNativeArguments: true });
    if (process.Name.toLowerCase() !== 'node.exe') continue;
    let executable;
    try { executable = resolveWindowsExecutable(process.ExecutablePath, realpath); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!sameWindowsFilePath(executable, node)) continue;
    const args = process.Arguments;
    let entryIndex = 1;
    let commandNodeMatches = false;
    try {
      commandNodeMatches = args.length > 0 && path.win32.isAbsolute(args[0]) &&
        sameWindowsFilePath(resolveWindowsCommandToken(args[0], realpath), node);
    } catch (_) {}
    if (!commandNodeMatches) continue;
    if (args[entryIndex] === '--experimental-sqlite') entryIndex++;
    const entry = args[entryIndex];
    let scriptMatch = false;
    if (entry && path.win32.isAbsolute(entry)) {
      try { scriptMatch = sameWindowsFilePath(resolveWindowsCommandToken(entry, realpath), script); } catch (_) {}
    }
    if (scriptMatch && args.length === entryIndex + 1) {
      verified.push({ ...process, ExecutablePath: executable });
    }
  }
  return verified;
}

function assertVerifiedNodeProcess(pid, expectedNode, expectedScript, processes, realpath = fs.realpathSync.native) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) throw new Error('Invalid process PID');
  const match = filterVerifiedNodeProcesses(expectedNode, expectedScript, processes, realpath)
    .find((process) => process.ProcessId === numericPid);
  if (!match) throw new Error(`Cannot verify node process identity for PID ${numericPid}`);
  return match;
}

function assertDaemonTerminationIdentity(options) {
  const status = options && options.status;
  if (!status || typeof status !== 'object') throw new Error('daemon status is missing');
  const profileId = status.profile && status.profile.id;
  if (profileId !== options.expectedProfileId) throw new Error('daemon profile mismatch');
  if (status.privilege !== 'standard' && status.privilege !== 'elevated') {
    throw new Error('daemon privilege is invalid');
  }
  if (options.expectedPrivilege && status.privilege !== options.expectedPrivilege) {
    throw new Error(`daemon privilege mismatch: expected ${options.expectedPrivilege}, got ${status.privilege}`);
  }
  const pid = status.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('daemon status PID is invalid');
  const listenerPids = Array.from(new Set((options.listenerPids || []).map(Number)));
  if (listenerPids.length !== 1 || listenerPids[0] !== pid) {
    throw new Error('daemon listener PID does not match status PID');
  }
  return assertVerifiedNodeProcess(
    pid, options.expectedNode, options.expectedScript, options.nodeProcesses, options.realpath
  );
}

function assertDaemonServiceIdentity(options) {
  const process = assertDaemonTerminationIdentity(options);
  const status = options.status;
  if (status.version !== options.expectedVersion) throw new Error('daemon version mismatch');
  if (status.buildId !== options.expectedBuildId) throw new Error('daemon buildId mismatch');
  return process;
}

// A standard process cannot read ExecutablePath/CommandLine for an elevated
// Node process. Reuse (never termination) may instead rely on the per-profile
// API capability token: authenticated /api/status exposes dataDir, which is
// omitted from public status responses. Bind that proof to the exact listener.
function assertAuthenticatedDaemonCapability(options) {
  const status = options && options.status;
  if (!status || typeof status !== 'object' || status.ok !== true) {
    throw new Error('authenticated daemon status is missing');
  }
  if (!status.profile || status.profile.id !== options.expectedProfileId) {
    throw new Error('authenticated daemon profile mismatch');
  }
  if (!options.allowVersionMismatch && status.version !== options.expectedVersion) {
    throw new Error('authenticated daemon version mismatch');
  }
  if (status.privilege !== 'elevated') {
    throw new Error('authenticated daemon is not elevated');
  }
  const pid = status.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('authenticated daemon PID is invalid');
  }
  const listenerPids = Array.from(new Set((options.listenerPids || []).map(Number)));
  if (listenerPids.length !== 1 || listenerPids[0] !== pid) {
    throw new Error('authenticated daemon listener PID does not match status PID');
  }
  if (typeof status.dataDir !== 'string' || !status.dataDir.trim() ||
      !sameWindowsPath(status.dataDir, options.expectedDataDir)) {
    throw new Error('authenticated daemon data directory mismatch');
  }
  return status;
}

module.exports = {
  ALLOWED_WORKBUDDY_PROCESS_NAMES,
  assertAuthenticatedDaemonCapability,
  assertCompleteProcessEnumeration,
  assertDaemonServiceIdentity,
  assertDaemonTerminationIdentity,
  assertSameProcessIdentity,
  carryProcessEnumeration,
  describeSkippedProcesses,
  detectWindowsPrivilege,
  detectNativeWindowsPrivilege,
  assertStandardWindowsPrivilege,
  assertVerifiedNodeProcess,
  buildNativeProcessQuery,
  enumerateCimProcesses,
  filterVerifiedNodeProcesses,
  filterVerifiedWindowsProcesses,
  parseCimProcessResult,
  readProcessEnumeration,
  resolveWindowsExecutable,
  sameWindowsPath,
  selectRunningProfileBinary,
  selectPreferredDiscoveredBinary,
  selectUniqueDiscoveredBinary,
  selectVerifiedProcessPids,
  withProcessEnumeration,
};
