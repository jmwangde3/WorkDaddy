#requires -Version 5.1
<#
  stop-workdaddy.ps1 — 干净停止 WorkDaddy（保留全部账号/会话数据）

  背景：WorkDaddy 是 watchdog.js + daemon.js 两个 Node 后台进程，没有托盘图标、
        也没有 /api/shutdown 路由。watchdog 持有回环单实例锁（47932），
        一旦 daemon 退出就 3 秒后自动拉起，所以只结束 daemon 是关不掉的。

  用法：
    powershell -ExecutionPolicy Bypass -File .\scripts\stop-workdaddy.ps1 -Status
    powershell -ExecutionPolicy Bypass -File .\scripts\stop-workdaddy.ps1 -DryRun
    powershell -ExecutionPolicy Bypass -File .\scripts\stop-workdaddy.ps1

  停止后重新启动：双击桌面 WorkDaddy.lnk，或运行 scripts\launcher.cmd
#>
[CmdletBinding()]
param(
  [switch]$Status,
  [switch]$DryRun
)

$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'SilentlyContinue'

$DAEMON_PORT  = 47832   # workbuddy-cn daemon HTTP
$WATCHDOG_PORT = 47932  # workbuddy-cn watchdog 单实例锁

function Get-WdProcess {
  $list = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -match 'WorkDaddy[\\/]scripts[\\/](watchdog|daemon)\.js'
  }
  foreach ($p in $list) {
    $role = if ($p.CommandLine -match 'watchdog\.js') { 'watchdog' } else { 'daemon' }
    [pscustomobject]@{
      Role        = $role
      ProcessId   = $p.ProcessId
      ParentId    = $p.ParentProcessId
      CommandLine = $p.CommandLine
    }
  }
}

function Get-PortOwner([int]$port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($c) { ($c.OwningProcess | Select-Object -Unique) -join ',' } else { '' }
}

function Show-Status {
  $procs = @(Get-WdProcess)
  Write-Output '=== WorkDaddy 进程 ==='
  if ($procs.Count -eq 0) {
    Write-Output '  (无 — WorkDaddy 未运行)'
  } else {
    $procs | Sort-Object Role | Format-Table Role,ProcessId,ParentId -AutoSize | Out-String | Write-Output
  }
  Write-Output '=== 端口 ==='
  Write-Output ("  daemon   {0} : {1}" -f $DAEMON_PORT,  (Get-PortOwner $DAEMON_PORT))
  Write-Output ("  watchdog {0} : {1}" -f $WATCHDOG_PORT, (Get-PortOwner $WATCHDOG_PORT))
  Write-Output '=== CDP（WorkBuddy 调试端口，不属于 WorkDaddy）==='
  Write-Output ("  9222 : {0}" -f (Get-PortOwner 9222))
}

if ($Status) { Show-Status; exit 0 }

Write-Output '停止 WorkDaddy（数据全部保留）...'
if ($DryRun) { Write-Output '  [DRY-RUN] 只显示将要结束的进程，不实际写入' }

# 先停 watchdog（防止它再拉起新的 daemon），再停 daemon。
# Stop-Process 是 TerminateProcess，不会触发 Node 的 SIGTERM handler，
# 所以 watchdog 被杀后不会替我们收掉 daemon —— 两个都必须显式结束。
for ($round = 1; $round -le 5; $round++) {
  $procs = @(Get-WdProcess)
  if ($procs.Count -eq 0) { break }

  foreach ($role in @('watchdog', 'daemon')) {
    foreach ($p in @($procs | Where-Object { $_.Role -eq $role })) {
      if ($DryRun) {
        Write-Output ("  [DRY-RUN] 将结束 {0} PID={1}" -f $p.Role, $p.ProcessId)
      } else {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Output ("  已结束 {0} PID={1}" -f $p.Role, $p.ProcessId)
      }
    }
  }

  if ($DryRun) { break }
  Start-Sleep -Milliseconds 500
}

if (-not $DryRun) {
  Start-Sleep -Milliseconds 800
  $left = @(Get-WdProcess)
  if ($left.Count -gt 0) {
    Write-Output '  仍有残留进程，按 PID 强制结束：'
    foreach ($p in $left) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Output ("    {0} PID={1}" -f $p.Role, $p.ProcessId)
    }
    Start-Sleep -Milliseconds 600
  }
}

Write-Output ''
Show-Status
Write-Output '=== 说明 ==='
Write-Output '  * 数据目录 %APPDATA%\WorkDaddy 与 workbuddy.db 均未改动'
Write-Output '  * 停止后「接管会话归属」监听随 daemon 一起停止，切账号不再自动同步'
Write-Output '  * 重新启动：双击桌面 WorkDaddy.lnk，或运行 scripts\launcher.cmd'
Write-Output '  * 彻底卸载（含删程序文件）：scripts\uninstall-win.cmd（会要求确认）'
