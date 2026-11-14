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
#         / 7 状态提交失败（程序与状态一起回滚，报告里分开写是否都成功）
#         / 8 上次更新事务未完成（journal 判定不一致，拒绝在未知状态上继续）
param(
    [string]$SourceDir = '',
    [string]$AppDir = '',
    [string]$DataDir = '',
    [switch]$DryRun,
    [switch]$Force,
    [switch]$Restart,
    [string]$Json = '',
    # 仅供故障注入测试：state-write / state-replace / state-restore
    [string]$InjectFault = ''
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
    # 状态提交是更新事务的一部分，逐阶段留证据：写临时文件 → 校验 → 原子替换 → 校验
    state      = [ordered]@{
        previousSaved = ''
        tmpPath       = ''
        validated     = $false
        committed     = $false
        restored      = $false
        note          = ''
    }
    # 回滚结果必须分开报告：程序恢复 ≠ 状态恢复。两者只成一个就是半完成状态。
    rollback   = [ordered]@{
        attempted       = $false
        programRestored = $false
        stateRestored   = $false
        backup          = ''
        note            = ''
    }
    previousJournal = $null
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

# ---- 0.5 上次事务残留检查 ----
# 如果上一次更新崩在「文件已替换、状态未提交」之间，磁盘上会留一份 journal。
# 这里不猜也不自动修：把两侧版本读出来，能判定的清掉，判不定的拒绝继续。
# 目的只有一个 —— 不在「程序是新版本、记录是旧版本」这种未知状态上再做一次替换。
$journalPath = Join-Path $DataDir 'update-journal.json'
$journal = Read-JsonFile $journalPath
if ($journal) {
    $diskVer = [string](Get-SourceVersion $AppDir)
    $jFrom = [string]$journal.from
    $jTo = [string]$journal.to
    $report.previousJournal = [ordered]@{
        from = $jFrom; to = $jTo; diskVersion = $diskVer
        stateVersion = $report.fromVersion; backup = [string]$journal.backup
    }
    if ($diskVer -and $diskVer -eq $jTo -and $report.fromVersion -eq $jTo) {
        Remove-Item -LiteralPath $journalPath -Force -ErrorAction SilentlyContinue
        $report.warnings += ('发现上次更新的残留 journal，但程序与状态都已是 ' + $jTo + '，已清理')
    } elseif ($diskVer -and $diskVer -eq $jFrom -and $report.fromVersion -eq $jFrom) {
        Remove-Item -LiteralPath $journalPath -Force -ErrorAction SilentlyContinue
        $report.warnings += ('发现上次更新的残留 journal，程序与状态都还是 ' + $jFrom + '，已清理')
    } elseif (-not $Force) {
        Fail-Update ('上次更新未完成：程序 ' + $diskVer + ' / 状态 ' + $report.fromVersion + ' / 目标 ' + $jTo + '；备份在 ' + [string]$journal.backup + '。请先让程序与状态一致，或加 -Force 继续') 8
    } else {
        $report.warnings += ('上次更新未完成（程序 ' + $diskVer + ' / 状态 ' + $report.fromVersion + '），-Force 继续')
    }
}

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

# ---- 2. 备份当前版本（程序 + 状态）----
# 状态文件必须在替换任何程序文件之前先留一份：它是回滚时唯一能证明
# 「旧版本到底装了什么」的东西，等写新状态时再备份就来不及了。
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupDir = Join-Path $DataDir ('backups\app-' + $report.fromVersion + '-preupdate-' + $stamp)
$stateBackupPath = Join-Path $DataDir ('backups\install-state-' + $report.fromVersion + '-' + $stamp + '.json')
$report.backup = $backupDir
if (-not $DryRun) {
    try {
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        if (Test-Path -LiteralPath (Join-Path $AppDir 'scripts')) {
            Copy-Item -Path (Join-Path $AppDir '*') -Destination $backupDir -Recurse -Force -ErrorAction Stop
        }
        Copy-Item -LiteralPath $statePath -Destination $stateBackupPath -Force -ErrorAction Stop
        $report.state.previousSaved = $stateBackupPath
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

# ---- 3. 事务辅助：回滚（程序 + 状态分开报告）----
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

function Remove-Journal {
    if ($journalPath -and (Test-Path -LiteralPath $journalPath)) {
        Remove-Item -LiteralPath $journalPath -Force -ErrorAction SilentlyContinue
    }
}

# 新状态在替换前后各校验一次：版本、appDir、文件清单条数与每条 path/sha256。
# 只判「JSON 能解析」不够 —— 空清单的合法 JSON 会让卸载删不干净。
function Test-StatePayload {
    param([string]$Path, [string]$ExpectVersion, [string]$ExpectAppDir, [int]$MinFiles)
    $o = Read-JsonFile $Path
    if (-not $o) { return 'JSON 解析失败' }
    if ([string]$o.version -ne $ExpectVersion) { return ('版本不符：' + [string]$o.version + ' != ' + $ExpectVersion) }
    if ([string]$o.appDir -ne $ExpectAppDir) { return ('appDir 不符：' + [string]$o.appDir) }
    $rows = @($o.files)
    if ($rows.Count -lt $MinFiles) { return ('文件清单条目不足：' + $rows.Count + ' < ' + $MinFiles) }
    foreach ($row in $rows) {
        if (-not ([string]$row.path) -or -not ([string]$row.sha256)) { return '文件清单里有缺 path/sha256 的条目' }
    }
    return ''
}

# 失败即回滚。程序与状态各自恢复、各自记账：只成一个就是半完成状态，
# 报告里必须能直接看出来是哪一半没回来。
function Invoke-UpdateRollback {
    param([string]$Why, [int]$Code)
    $report.rollback.attempted = $true
    $report.rollback.backup = $backupDir

    $progOk = [bool](Restore-Backup -From $backupDir -To $AppDir)
    $report.rollback.programRestored = $progOk

    $stateOk = $false
    if ($InjectFault -eq 'state-restore') {
        # 只注入「回滚时状态恢复失败」：程序恢复照常，状态故意不写回
        $report.rollback.note = '故障注入：状态恢复失败（模拟回滚时状态文件写不回去）'
    } else {
        try {
            $cur = Read-JsonFile $statePath
            if (-not $cur -or ([string]$cur.version -ne $report.fromVersion)) {
                if ($stateBackupPath -and (Test-Path -LiteralPath $stateBackupPath)) {
                    Copy-Item -LiteralPath $stateBackupPath -Destination $statePath -Force -ErrorAction Stop
                }
            }
            $chk = Read-JsonFile $statePath
            $stateOk = [bool]($chk -and ([string]$chk.version -eq $report.fromVersion))
        } catch {
            $stateOk = $false
            $report.rollback.note = '状态恢复异常：' + $_.Exception.Message
        }
    }
    $report.rollback.stateRestored = $stateOk
    if ($stateOk) { $report.state.restored = $true }
    $report.rolledBack = ($progOk -and $stateOk)

    # 两半都回来了才清 journal：否则留着它，下次运行会被 0.5 的残留检查拦住
    $nowVer = ''
    $now = Read-JsonFile $statePath
    if ($now) { $nowVer = [string]$now.version }
    if ($progOk -and $stateOk) { Remove-Journal }

    $parts = @()
    if ($progOk) { $parts += ('程序已恢复到 ' + $report.fromVersion) }
    else { $parts += ('程序恢复失败，需手动从 ' + $backupDir + ' 恢复') }
    if ($stateOk) { $parts += ('安装记录已恢复到 ' + $report.fromVersion) }
    else {
        $parts += ('安装记录未恢复（当前 ' + $nowVer + '，备份在 ' + $stateBackupPath + '）')
        if ($report.rollback.note) { $parts += $report.rollback.note }
    }
    Fail-Update ($Why + '；' + ($parts -join '；')) $Code
}

# ---- 3.5 替前写 journal ----
# 崩溃恢复的唯一线索：这条记录在成功提交状态后才删。留在盘上就代表
# 「可能有过一次未完成的替换」，下次运行会先判定再决定是否继续。
if (-not $DryRun) {
    try {
        Write-JsonFile -Path $journalPath -Value ([ordered]@{
            schema    = 1
            action    = 'update'
            from      = $report.fromVersion
            to        = $toVersion
            backup    = $backupDir
            stage     = $stageDir
            pid       = $PID
            startedAt = (Get-Date).ToString('o')
        })
    } catch {
        Fail-Update ('写更新事务 journal 失败，已中止（程序未改动）：' + $_.Exception.Message) 1
    }
}

# ---- 4. 替换（失败即回滚）----
if (-not $DryRun) {
    try {
        Copy-InstallFiles -SourceDir $stageDir -AppDir $AppDir -Files $files
        $bad = @()
        foreach ($rel in $files) {
            if ((Get-Sha256 (Join-Path $AppDir $rel)) -ne (Get-Sha256 (Join-Path $stageDir $rel))) { $bad += $rel }
        }
        if ($bad.Count -gt 0) { throw ('装后校验失败：' + ($bad -join ',')) }
    } catch {
        Invoke-UpdateRollback -Why ('替换失败：' + $_.Exception.Message) -Code 4
    }
}

# ---- 5. 静态健康检查（不启动守护进程）----
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
            Invoke-UpdateRollback -Why ('健康检查失败（' + $c + ' 语法错误）：' + ($out -join ' ')) -Code 5
        }
        $report.health[$c] = 'ok'
    }
} else {
    $report.health.note = '未找到 Node 运行时，跳过语法检查（不影响文件替换结果）'
}

# ---- 6. 状态提交（更新事务的最后一环）----
# 顺序：建 payload → 写临时文件 → 校验临时文件 → 原子替换 → 校验落盘文件。
# 任何一步失败都走同一套回滚：程序回旧版本、状态回旧版本，不留半完成。
if (-not $DryRun) {
    $stateTmp = Join-Path $DataDir ('.install-state.tmp-' + $stamp + '.json')
    $report.state.tmpPath = $stateTmp
    try {
        $table = Get-InstalledFileTable -AppDir $AppDir -Files $files
        $payload = [ordered]@{
            schema        = 1
            product       = 'WorkDaddy'
            channel       = 'fork'
            version       = $toVersion
            appDir        = $AppDir
            dataDir       = $DataDir
            clientProfile = [string]$state.clientProfile
            installedAt   = (Get-Date).ToString('o')
            updatedFrom   = $report.fromVersion
            source        = 'installer/update-workdaddy.ps1'
            files         = $table
        }

        if ($InjectFault -eq 'state-write') { throw '故障注入：状态文件无法写入（模拟磁盘/权限问题）' }
        Write-JsonFile -Path $stateTmp -Value $payload

        $err = Test-StatePayload -Path $stateTmp -ExpectVersion $toVersion -ExpectAppDir $AppDir -MinFiles $files.Count
        if ($err) { throw ('新状态校验失败：' + $err) }
        $report.state.validated = $true

        if ($InjectFault -eq 'state-replace') { throw '故障注入：状态文件替换失败（模拟文件被占用）' }
        if (Test-Path -LiteralPath $statePath) {
            # 同卷原子替换：旧文件先落到 .bak，再把临时文件就位。
            # 目标被删掉时 File.Replace 会抛，退回 Move-Item（仍然是同卷 rename）。
            [IO.File]::Replace($stateTmp, $statePath, ($statePath + '.bak'), $true)
        } else {
            Move-Item -LiteralPath $stateTmp -Destination $statePath -Force
        }

        $err = Test-StatePayload -Path $statePath -ExpectVersion $toVersion -ExpectAppDir $AppDir -MinFiles $files.Count
        if ($err) { throw ('提交后校验失败：' + $err) }
        $report.state.committed = $true
        # 只用于「状态恢复失败」这一种故障注入：提交成功后再抛，
        # 让回滚必须同时处理「程序已回旧、状态是新」的两侧不一致。
        if ($InjectFault -eq 'state-restore') { throw '故障注入：状态提交后校验失败' }
    } catch {
        if (Test-Path -LiteralPath $stateTmp) { Remove-Item -LiteralPath $stateTmp -Force -ErrorAction SilentlyContinue }
        Invoke-UpdateRollback -Why ($_.Exception.Message) -Code 7
    }
    if (Test-Path -LiteralPath ($statePath + '.bak')) {
        Remove-Item -LiteralPath ($statePath + '.bak') -Force -ErrorAction SilentlyContinue
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

# ---- 7. 收尾：事务已提交，清 journal 与暂存 ----
# journal 必须在状态提交之后才删：删早了就失去崩溃恢复线索，
# 删晚了下次运行会误判「上次没做完」。
Remove-Journal
# 替换与校验都过了，暂存副本没有保留价值；备份目录才是回滚依据。
if ($script:stageDir -and (Test-Path -LiteralPath $script:stageDir)) {
    Remove-Item -LiteralPath $script:stageDir -Recurse -Force -ErrorAction SilentlyContinue
    $report.stageRemoved = -not (Test-Path -LiteralPath $script:stageDir)
}

$report.fileCount = $files.Count
$report.ok = $true
Write-Line ('更新完成：' + $report.fromVersion + ' → ' + $toVersion)
Write-Line ('安装记录已提交：' + $statePath)
Write-Line ('回滚备份保留在：' + $backupDir)
Write-Report -Report $report -JsonPath $Json
exit 0
