# WorkDaddy 更新器（离线包 / 本地目录 → 已安装目录）
#
# 安全顺序：读当前状态 → 比对版本 → 暂存到临时目录并逐文件校验 → 备份当前版本
# → 覆盖 → 装后校验 → 静态健康检查 → 写状态。任一步失败都从备份回滚。
#
# 不做的事：不联网下载、不启动守护进程、不碰 WorkBuddy 目录。
# 下载与签名校验属于发布链（阶段 6），本脚本只负责「已经拿到可信包之后怎么安全换上去」。
#
# 退出码：0 成功 / 1 状态或源目录问题 / 2 版本闸门（降级或同版本） / 3 暂存失败
#         / 4 替换失败并已回滚 / 5 健康检查失败并已回滚 / 6 守护进程停不下来
param(
    [string]$SourceDir = '',
    [string]$AppDir = '',
    [string]$DataDir = '',
    [switch]$DryRun,
    [switch]$Force,
    [switch]$Restart,
    [string]$Json = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

if (-not $SourceDir) { $SourceDir = Split-Path -Parent $here }
if (-not $AppDir) { $AppDir = Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy' }
if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA 'WorkDaddy' }
$SourceDir = [IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
$AppDir = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')

$report = [ordered]@{
    schema     = 1
    action     = 'update'
    ok         = $false
    dryRun     = [bool]$DryRun
    fromVersion = ''
    toVersion  = ''
    appDir     = $AppDir
    dataDir    = $DataDir
    stageDir   = ''
    stageRemoved = $false
    service    = [ordered]@{ detected = @(); stopped = @(); startAttempted = $false; startPid = 0 }
    backup     = ''
    rolledBack = $false
    fileCount  = 0
    health     = [ordered]@{}
    warnings   = @()
    error      = ''
    exitCode   = 0
}

function Fail-Update {
    param([string]$Message, [int]$Code)
    $report.error = $Message
    $report.exitCode = $Code
    Write-Line ('错误：' + $Message)
    # 暂存目录是临时产物，失败也要清掉，别在 %TEMP% 里越堆越多
    if ($script:stageDir -and (Test-Path -LiteralPath $script:stageDir)) {
        Remove-Item -LiteralPath $script:stageDir -Recurse -Force -ErrorAction SilentlyContinue
        $report.stageRemoved = -not (Test-Path -LiteralPath $script:stageDir)
    }
    Write-Report -Report $report -JsonPath $Json
    exit $Code
}

Write-Line '=============================================================='
Write-Line ' WorkDaddy 更新'
Write-Line '=============================================================='

$statePath = Join-Path $DataDir 'install-state.json'
$state = Read-JsonFile $statePath
if (-not $state) { Fail-Update ('找不到安装记录：' + $statePath + '；请先用 install-workdaddy.ps1 安装') 1 }
$report.fromVersion = [string]$state.version
if ([string]$state.appDir) { $AppDir = ([string]$state.appDir).TrimEnd('\') }

$toVersion = Get-SourceVersion $SourceDir
if (-not $toVersion) { Fail-Update ('源目录里读不到 DAEMON_VERSION：' + $SourceDir) 1 }
$report.toVersion = $toVersion

if ($toVersion -eq $report.fromVersion -and -not $Force) {
    $report.ok = $true
    $report.exitCode = 0
    $report.warnings += ('已是当前版本 ' + $toVersion + '；要强制重装请加 -Force')
    Write-Line $report.warnings[-1]
    Write-Report -Report $report -JsonPath $Json
    exit 0
}

# 版本比较：按点分段数值比较，只处理 x.y.z；无法解析时保守要求 -Force
function Compare-Ver {
    param([string]$A, [string]$B)
    $pa = $A.Split('.')
    $pb = $B.Split('.')
    $n = [Math]::Max($pa.Count, $pb.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $va = 0; $vb = 0
        if ($i -lt $pa.Count) { [void][int]::TryParse($pa[$i], [ref]$va) }
        if ($i -lt $pb.Count) { [void][int]::TryParse($pb[$i], [ref]$vb) }
        if ($va -lt $vb) { return -1 }
        if ($va -gt $vb) { return 1 }
    }
    return 0
}

$cmp = Compare-Ver $toVersion $report.fromVersion
$report.versionCompare = $cmp
if ($cmp -lt 0 -and -not $Force) {
    Fail-Update ('拒绝降级：当前 ' + $report.fromVersion + '，包内 ' + $toVersion + '。确认要降级请加 -Force') 2
}

$files = Get-InstallFileList $SourceDir
if (-not $files -or $files.Count -lt 20) { Fail-Update ('源目录文件清单异常（' + $files.Count + ' 个）') 1 }

# ---- 1. 暂存 + 校验 ----
$stageDir = Join-Path $env:TEMP ('workdaddy-update-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
$script:stageDir = $stageDir
$report.stageDir = $stageDir
if (-not $DryRun) {
    try {
        New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
        Copy-InstallFiles -SourceDir $SourceDir -AppDir $stageDir -Files $files
        $bad = @()
        foreach ($rel in $files) {
            $h1 = Get-Sha256 (Join-Path $SourceDir $rel)
            $h2 = Get-Sha256 (Join-Path $stageDir $rel)
            if ($h1 -ne $h2) { $bad += $rel }
        }
        if ($bad.Count -gt 0) { Fail-Update ('暂存校验失败（' + $bad.Count + ' 个文件哈希不一致）：' + ($bad -join ',')) 3 }
    } catch {
        Fail-Update ('暂存失败：' + $_.Exception.Message) 3
    }
}

# ---- 2. 备份当前版本 ----
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupDir = Join-Path $DataDir ('backups\app-' + $report.fromVersion + '-preupdate-' + $stamp)
$report.backup = $backupDir
if (-not $DryRun) {
    try {
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        if (Test-Path -LiteralPath (Join-Path $AppDir 'scripts')) {
            Copy-Item -Path (Join-Path $AppDir '*') -Destination $backupDir -Recurse -Force -ErrorAction Stop
        }
    } catch {
        Fail-Update ('备份当前版本失败，已中止：' + $_.Exception.Message) 4
    }
}

# ---- 2.5 停服务 ----
# 只停「命令行里跑的是本安装目录 scripts\daemon.js / watchdog.js」的 node 进程。
# 按路径精确匹配，所以绝不会波及 WorkBuddy 客户端、其它 WorkDaddy 安装、或 CI 里的无关 node。
# 顺序要点：watchdog 会在 daemon 退出 3 秒后把它拉回来，两个都得停，且在替换之前停。
function Get-ServiceProcesses {
    param([string]$Dir)
    $d = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
    $patDaemon = [regex]::Escape($d + '\scripts\daemon.js')
    $patWatch = [regex]::Escape($d + '\scripts\watchdog.js')
    $ids = @()
    $procs = @()
    try { $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue) } catch { $procs = @() }
    foreach ($p in $procs) {
        $cmd = [string]$p.CommandLine
        if (-not $cmd) { continue }
        if ($cmd -match $patDaemon -or $cmd -match $patWatch) { $ids += [int]$p.ProcessId }
    }
    return $ids
}

if (-not $DryRun) {
    $running = @(Get-ServiceProcesses $AppDir)
    $report.service.detected = $running
    if ($running.Count -gt 0) {
        Write-Line ('检测到运行中的 WorkDaddy 进程：' + ($running -join ','))
        foreach ($procId in $running) {
            try {
                Stop-Process -Id $procId -Force -ErrorAction Stop
                $report.service.stopped += $procId
            } catch {
                $report.warnings += ('结束进程 ' + $procId + ' 失败：' + $_.Exception.Message)
            }
        }
        # 等它真的退出：Windows 上 Stop-Process 返回后文件句柄可能还没放
        for ($i = 0; $i -lt 20; $i++) {
            if (@(Get-ServiceProcesses $AppDir).Count -eq 0) { break }
            Start-Sleep -Milliseconds 250
        }
        $left = @(Get-ServiceProcesses $AppDir)
        if ($left.Count -gt 0) {
            Fail-Update ('守护进程停不下来（pid ' + ($left -join ',') + '）；为避免替换到运行中的程序，已中止，未改动任何文件') 6
        }
        Write-Line ('已停止：' + ($report.service.stopped -join ','))
    }
}

# ---- 3. 替换（失败即回滚）----
function Restore-Backup {
    param([string]$From, [string]$To)
    try {
        if (-not (Test-Path -LiteralPath $From)) { return $false }
        Get-ChildItem -LiteralPath $To -Force -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
        Copy-Item -Path (Join-Path $From '*') -Destination $To -Recurse -Force -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

if (-not $DryRun) {
    try {
        Copy-InstallFiles -SourceDir $stageDir -AppDir $AppDir -Files $files
        $bad = @()
        foreach ($rel in $files) {
            if ((Get-Sha256 (Join-Path $AppDir $rel)) -ne (Get-Sha256 (Join-Path $stageDir $rel))) { $bad += $rel }
        }
        if ($bad.Count -gt 0) { throw ('装后校验失败：' + ($bad -join ',')) }
    } catch {
        $why = $_.Exception.Message
        $restored = Restore-Backup -From $backupDir -To $AppDir
        $report.rolledBack = $restored
        if ($restored) { Fail-Update ('替换失败，已回滚到 ' + $report.fromVersion + '：' + $why) 4 }
        Fail-Update ('替换失败且回滚未完成，请手动从 ' + $backupDir + ' 恢复：' + $why) 4
    }
}

# ---- 4. 静态健康检查（不启动守护进程）----
$node = $null
try {
    $managed = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
    if (Test-Path -LiteralPath $managed) {
        $node = Get-ChildItem -LiteralPath $managed -Filter 'node.exe' -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
} catch { $node = $null }
if (-not $node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $node = $cmd.Source } }

$report.health.nodePath = [string]$node
if ($node -and -not $DryRun) {
    $checks = @('daemon.js', 'inject.js', 'lib.js', 'win-launcher.js')
    foreach ($c in $checks) {
        $target = Join-Path $AppDir ('scripts\' + $c)
        if (-not (Test-Path -LiteralPath $target)) { $report.health[$c] = 'missing'; continue }
        # 5.1 里原生命令往 stderr 写东西会触发 NativeCommandError（$ErrorActionPreference='Stop' 时
        # 直接抛终止错误）。node --check 的错误正是写 stderr 的 —— 必须先降级再调用，
        # 否则健康检查失败会变成脚本崩溃，跳过回滚。
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $out = & $node --check $target 2>&1
        $nodeCode = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        if ($nodeCode -ne 0) {
            $report.health[$c] = 'syntax-error'
            $restored = Restore-Backup -From $backupDir -To $AppDir
            $report.rolledBack = $restored
            Fail-Update ('健康检查失败（' + $c + ' 语法错误），已回滚：' + ($out -join ' ')) 5
        }
        $report.health[$c] = 'ok'
    }
} else {
    $report.health.note = '未找到 Node 运行时，跳过语法检查（不影响文件替换结果）'
}

# ---- 5. 写状态 ----
if (-not $DryRun) {
    try {
        $table = Get-InstalledFileTable -AppDir $AppDir -Files $files
        Write-JsonFile -Path $statePath -Value ([ordered]@{
            schema      = 1
            product     = 'WorkDaddy'
            channel     = 'fork'
            version     = $toVersion
            appDir      = $AppDir
            dataDir     = $DataDir
            clientProfile = [string]$state.clientProfile
            installedAt = (Get-Date).ToString('o')
            updatedFrom = $report.fromVersion
            source      = 'installer/update-workdaddy.ps1'
            files       = $table
        })
    } catch {
        Fail-Update ('写安装状态失败：' + $_.Exception.Message) 4
    }
}

# ---- 5.5 重启（仅 -Restart；且只在本来就跑着东西时）----
# 重启失败不回滚：文件已经验证过是好的，回滚只会把可用的新版本换成旧版本。
# 启动靠 launcher.cmd（它会拉起 watchdog 再拉起 daemon），与用户双击快捷方式同一条路径。
if ($Restart -and -not $DryRun) {
    $launcher = Join-Path $AppDir 'scripts\launcher.cmd'
    if (-not (Test-Path -LiteralPath $launcher)) {
        $report.warnings += '找不到 scripts\launcher.cmd，未自动启动；请手动启动 WorkDaddy'
    } else {
        try {
            $p = Start-Process -FilePath $launcher -WorkingDirectory (Join-Path $AppDir 'scripts') -WindowStyle Hidden -PassThru
            $report.service.startAttempted = $true
            $report.service.startPid = [int]$p.Id
            Write-Line ('已重新启动：' + $launcher + '（pid ' + $p.Id + '）')
        } catch {
            $report.warnings += ('自动启动失败：' + $_.Exception.Message + '；请手动启动 WorkDaddy')
        }
    }
}

# ---- 6. 清理暂存目录 ----
# 替换与校验都过了，暂存副本没有保留价值；备份目录才是回滚依据。
if ($script:stageDir -and (Test-Path -LiteralPath $script:stageDir)) {
    Remove-Item -LiteralPath $script:stageDir -Recurse -Force -ErrorAction SilentlyContinue
    $report.stageRemoved = -not (Test-Path -LiteralPath $script:stageDir)
}

$report.fileCount = $files.Count
$report.ok = $true
Write-Line ('更新完成：' + $report.fromVersion + ' → ' + $toVersion)
Write-Line ('回滚备份保留在：' + $backupDir)
Write-Report -Report $report -JsonPath $Json
exit 0
