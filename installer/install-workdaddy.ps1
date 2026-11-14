# WorkDaddy 独立安装器
#
# 与旧 deploy.ps1 的区别：deploy.ps1 是「把补丁覆盖到 WorkBuddy 安装目录」，
# 本脚本是「把 WorkDaddy 装到自己的目录，通过 CDP 与官方客户端交互」。
# 两者互不替代：旧补丁版用户先用本脚本迁移配置，再决定是否卸载旧补丁。
#
# 流程：预检 → 识别旧补丁版并导入配置 → 备份旧版本 → 复制 → 校验 → 数据目录 → 快捷方式 → 状态提交 → 报告
#
# 事务边界（失败时磁盘上是什么状态）：
#   * 已有安装：替换前整目录备份 + 旧状态备份；任一步失败都回滚到备份，
#     报告里分开写「程序是否恢复」「状态是否恢复」。
#   * 全新安装：只删本次清单内的文件，再删空目录；用户自己的文件和整个数据目录不动。
#   * 快捷方式：只删本次创建的那一条（路径先记进内存，提交失败就删掉）。
#
# 退出码：0 成功 / 1 源目录无效 / 2 预检未通过 / 3 目标目录不可写 / 4 复制失败（已回滚）
#         / 5 校验失败（已回滚）/ 6 数据目录初始化失败 / 7 状态提交失败（已回滚）
param(
    [string]$SourceDir = '',
    [string]$AppDir = '',
    [string]$DataDir = '',
    [string]$ClientProfile = 'workbuddy-cn',
    [string]$LegacyScriptsDir = '',
    # 仅测试用：把桌面目录指到临时目录，避免测试碰真实桌面
    [string]$DesktopDir = '',
    [switch]$DryRun,
    [switch]$NoShortcut,
    [switch]$SkipClientCheck,
    [switch]$Force,
    [string]$Json = '',
    # 仅诊断用：把「走到哪一步」逐行追加到这个文件。
    # 用途是查「脚本没有留下任何报告就消失了」这类问题 —— 报告只在成功和已处理的
    # 失败路径上写，进程被外部杀掉或直接崩掉时什么都不会留下，只能靠这个痕迹。
    [string]$Trace = '',
    # 仅供故障注入测试：copy-mid / verify / state-write
    [string]$InjectFault = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

$script:tracePath = $Trace
function Write-Stage {
    param([string]$Name)
    if (-not $script:tracePath) { return }
    try {
        $line = (Get-Date).ToString('HH:mm:ss.fff') + ' ' + $Name + "`r`n"
        $dir = Split-Path -Parent $script:tracePath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        [IO.File]::AppendAllText($script:tracePath, $line, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}
# 兜底：任何没被本地 try/catch 接住的终止性错误都记一笔再退出，
# 免得又变成「什么都没留下」。
trap {
    Write-Stage ('UNHANDLED ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)
    Write-Line ('未捕获的错误：' + $_.Exception.Message)
    try { Write-Report -Report $report -JsonPath $Json } catch { }
    exit 9
}

Write-Stage 'start'

$report = [ordered]@{
    schema         = 1
    action         = 'install'
    ok             = $false
    dryRun         = [bool]$DryRun
    startedAt      = (Get-Date).ToString('o')
    sourceDir      = ''
    appDir         = ''
    dataDir        = ''
    version        = ''
    clientProfile  = $ClientProfile
    preflight      = [ordered]@{}
    migration      = $null
    backup         = $null
    # 安装事务：成功的判据是「清单文件全在 + 校验全过 + 状态提交成功」，
    # 失败时这里能看出回滚到了哪一步。
    rollback       = [ordered]@{
        attempted       = $false
        programRestored = $false
        stateRestored   = $false
        cleaned         = $false
        shortcutRemoved = $false
        note            = ''
    }
    state          = [ordered]@{ previousSaved = ''; tmpPath = ''; validated = $false; committed = $false }
    fileCount      = 0
    warnings       = @()
    error          = ''
    exitCode       = 0
}

function Fail-Install {
    param([string]$Message, [int]$Code)
    $report.error = $Message
    $report.exitCode = $Code
    Write-Line ('错误：' + $Message)
    Write-Report -Report $report -JsonPath $Json
    exit $Code
}

Write-Line '=============================================================='
Write-Line ' WorkDaddy 独立安装'
Write-Line '=============================================================='

# ---- 0. 解析默认路径 ----
if (-not $SourceDir) { $SourceDir = Split-Path -Parent $here }
if (-not $AppDir) { $AppDir = Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy' }
if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA 'WorkDaddy' }
$SourceDir = [IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
$AppDir = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$report.sourceDir = $SourceDir
$report.appDir = $AppDir
$report.dataDir = $DataDir

# 数据目录不得落在程序目录内（否则更新会覆盖用户配置）
if ($DataDir.StartsWith($AppDir + '\', [StringComparison]::OrdinalIgnoreCase) -or $DataDir -eq $AppDir) {
    Fail-Install '数据目录不能位于安装目录内：更新会覆盖用户配置。请改用 %APPDATA%\WorkDaddy。' 2
}

$unsafe = Test-SafeTargetDir $AppDir
if ($unsafe) { Fail-Install ($unsafe + '：' + $AppDir) 3 }
$unsafe = Test-SafeTargetDir $DataDir
if ($unsafe) { Fail-Install ($unsafe + '：' + $DataDir) 3 }

$version = Get-SourceVersion $SourceDir
if (-not $version) { Fail-Install ('源目录里找不到 scripts\daemon.js 或读不到 DAEMON_VERSION：' + $SourceDir) 1 }
$report.version = $version

$files = Get-InstallFileList $SourceDir
if (-not $files -or $files.Count -lt 20) { Fail-Install ('源目录文件清单异常（' + $files.Count + ' 个），拒绝安装') 1 }

# ---- 1. 预检 ----
Write-Stage 'preflight'
$osv = [Environment]::OSVersion.Version
$report.preflight.windowsVersion = $osv.ToString()
$report.preflight.windowsOk = ($osv.Major -ge 10)
if (-not $report.preflight.windowsOk) {
    $report.preflight.windowsNote = 'WorkDaddy 依赖 Windows 10 及以上（ConPTY / .NET Framework 4.8）'
}

$clientCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy'),
    (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy AI'),
    (Join-Path $env:APPDATA 'WorkBuddy')
)
$clientFound = $null
foreach ($c in $clientCandidates) {
    if (Test-Path -LiteralPath $c) { $clientFound = $c; break }
}
$report.preflight.clientDetected = [bool]$clientFound
$report.preflight.clientPath = [string]$clientFound
$proc = @()
try { $proc = @(Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue) } catch { $proc = @() }
$report.preflight.clientRunning = ($proc.Count -gt 0)
if ($SkipClientCheck) {
    $report.preflight.clientDetected = $true
    $report.preflight.clientPath = '(已跳过检测)'
}

$nodeBin = $null
try {
    $managed = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
    if (Test-Path -LiteralPath $managed) {
        $nodeBin = Get-ChildItem -LiteralPath $managed -Filter 'node.exe' -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
} catch { $nodeBin = $null }
if (-not $nodeBin) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeBin = $cmd.Source }
}
$report.preflight.nodePath = [string]$nodeBin
$report.preflight.nodeOk = [bool]$nodeBin
if (-not $nodeBin) {
    $report.warnings += '未找到 Node 运行时：launcher 会在启动时再找一次；找不到则无法启动守护进程。'
}

$needMb = [math]::Round(((Get-ChildItem -LiteralPath $SourceDir -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum) / 1MB * 1.2, 1)
$freeMb = Get-FreeSpaceMb $AppDir
$report.preflight.requiredMb = $needMb
$report.preflight.freeMb = $freeMb
$report.preflight.diskOk = ($freeMb -lt 0) -or ($freeMb -gt ($needMb + 50))
if (-not $report.preflight.diskOk) {
    Fail-Install ('磁盘空间不足：需要约 ' + $needMb + ' MB，可用 ' + $freeMb + ' MB') 2
}

# 记录「安装前 AppDir 是否存在」：新安装失败时只有本次新建的空目录才删，
# 用户原本就有的目录即使被清空也留着（里面可能有他自己的东西）。
$appDirExistedBefore = Test-Path -LiteralPath $AppDir
$writable = $true
if (-not $DryRun) {
    try {
        if (-not (Test-Path -LiteralPath $AppDir)) { New-Item -ItemType Directory -Force -Path $AppDir | Out-Null }
        $probe = Join-Path $AppDir '.wd-write-probe'
        [IO.File]::WriteAllText($probe, 'probe')
        Remove-Item -LiteralPath $probe -Force
    } catch {
        $writable = $false
    }
} else {
    $writable = $true
}
$report.preflight.appDirWritable = $writable
if (-not $writable) { Fail-Install ('安装目录不可写：' + $AppDir) 3 }

if (-not $report.preflight.windowsOk) { Fail-Install '预检未通过：Windows 版本过低' 2 }

# ---- 2. 旧补丁版识别与配置导入 ----
Write-Stage 'migrate'
$legacyHit = $null
if ($LegacyScriptsDir) {
    if (Test-Path -LiteralPath $LegacyScriptsDir) { $legacyHit = [IO.Path]::GetFullPath($LegacyScriptsDir).TrimEnd('\') }
} else {
    $guesses = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\resources\app\scripts'),
        (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\scripts'),
        (Join-Path $env:PROGRAMFILES 'WorkBuddy\resources\app\scripts')
    )
    foreach ($g in $guesses) {
        if (Test-Path -LiteralPath $g) {
            if (Test-Path -LiteralPath (Join-Path $g 'rehome-sessions.js')) { $legacyHit = $g; break }
        }
    }
}

$migration = [ordered]@{ detected = $false; source = ''; imported = @(); skipped = @() }
if ($legacyHit) {
    $migration.detected = $true
    $migration.source = $legacyHit
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $importDir = Join-Path $DataDir ('legacy-import\' + $stamp)
    $want = @('workbuddy-exe.json', 'rehome-config.json', 'rehome-state.json', 'dedupe-config.json', 'permission-guard.json', 'session-dedupe-journal.json')
    foreach ($name in $want) {
        $p = Join-Path $legacyHit $name
        if (-not (Test-Path -LiteralPath $p)) { continue }
        if ($DryRun) {
            $migration.imported += [pscustomobject]@{ name = $name; to = $importDir; dryRun = $true }
            continue
        }
        try {
            if (-not (Test-Path -LiteralPath $importDir)) { New-Item -ItemType Directory -Force -Path $importDir | Out-Null }
            Copy-Item -LiteralPath $p -Destination (Join-Path $importDir $name) -Force
            $migration.imported += [pscustomobject]@{ name = $name; to = (Join-Path $importDir $name) }
        } catch {
            $migration.skipped += [pscustomobject]@{ name = $name; reason = $_.Exception.Message }
        }
    }
    # 旧版日志与备份目录：只复制，不动原目录
    foreach ($dirName in @('backups', 'logs')) {
        $d = Join-Path $legacyHit $dirName
        if (-not (Test-Path -LiteralPath $d)) { continue }
        if ($DryRun) { $migration.skipped += [pscustomobject]@{ name = $dirName; reason = 'dry-run' }; continue }
        try {
            $to = Join-Path $importDir $dirName
            New-Item -ItemType Directory -Force -Path $to | Out-Null
            Copy-Item -Path (Join-Path $d '*') -Destination $to -Recurse -Force -ErrorAction SilentlyContinue
            $migration.imported += [pscustomobject]@{ name = $dirName; to = $to }
        } catch {
            $migration.skipped += [pscustomobject]@{ name = $dirName; reason = $_.Exception.Message }
        }
    }
    $report.warnings += '检测到旧补丁版安装：配置已复制导入，原目录未改动。确认新版本可用后再自行清理旧补丁。'
}
$report.migration = $migration

# ---- 3. 已有安装：先备份（程序 + 状态）----
Write-Stage 'backup'
# 任何已有安装都备份，不再只备份「版本不同」的情况：同版本重装一样可能在
# 复制中途失败，没有备份就只剩一堆半新半旧的文件，那是最难收拾的状态。
$statePath = Join-Path $DataDir 'install-state.json'
$oldState = Read-JsonFile $statePath
$existingInstall = Test-Path -LiteralPath (Join-Path $AppDir 'scripts\daemon.js')
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupDir = ''
$stateBackupPath = ''
if ($existingInstall) {
    $oldVersion = [string]$oldState.version
    if (-not $oldVersion) { $oldVersion = 'unknown' }
    $backupDir = Join-Path $DataDir ('backups\app-' + $oldVersion + '-' + $stamp)
    $stateBackupPath = Join-Path $DataDir ('backups\install-state-' + $oldVersion + '-' + $stamp + '.json')
    if (-not $DryRun) {
        try {
            New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
            Copy-Item -Path (Join-Path $AppDir '*') -Destination $backupDir -Recurse -Force -ErrorAction Stop
            if (Test-Path -LiteralPath $statePath) {
                Copy-Item -LiteralPath $statePath -Destination $stateBackupPath -Force -ErrorAction Stop
                $report.state.previousSaved = $stateBackupPath
            }
            $report.backup = $backupDir
            Write-Line ('已备份当前安装 ' + $oldVersion + ' → ' + $backupDir)
            # 只保留最近 2 个程序备份；同代的 install-state 快照一并清掉
            $all = @(Get-ChildItem -LiteralPath (Join-Path $DataDir 'backups') -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'app-*' } | Sort-Object Name -Descending)
            if ($all.Count -gt 2) {
                for ($i = 2; $i -lt $all.Count; $i++) { Remove-Item -LiteralPath $all[$i].FullName -Recurse -Force -ErrorAction SilentlyContinue }
            }
            $snaps = @(Get-ChildItem -LiteralPath (Join-Path $DataDir 'backups') -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'install-state-*.json' } | Sort-Object Name -Descending)
            if ($snaps.Count -gt 2) {
                for ($i = 2; $i -lt $snaps.Count; $i++) { Remove-Item -LiteralPath $snaps[$i].FullName -Force -ErrorAction SilentlyContinue }
            }
        } catch {
            Fail-Install ('备份当前安装失败，已中止以免无法回滚：' + $_.Exception.Message) 4
        }
    } else {
        $report.backup = '(dry-run: ' + $backupDir + ')'
    }
}

# ---- 3.5 事务辅助 ----
function Restore-AppBackup {
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

function Test-InstallStatePayload {
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

# 安装失败时的收尾。两条路径必须区分清楚：
#   * 已有安装 → 从备份恢复程序与状态；备份不可用就明确报「未恢复」。
#   * 新安装   → 只删本次清单内的文件；用户自己的文件和数据目录一律不动。
function Invoke-InstallRollback {
    param([string]$Why, [int]$Code)
    $report.rollback.attempted = $true

    # 快捷方式先撤：它指向的程序马上要被删/回滚，留着就是死链
    if ($script:createdShortcut) {
        try {
            Remove-Item -LiteralPath $script:createdShortcut -Force -ErrorAction Stop
            $report.rollback.shortcutRemoved = $true
        } catch {
            $report.rollback.note = '快捷方式删除失败：' + $_.Exception.Message
        }
    }

    if ($existingInstall -and $backupDir) {
        $report.rollback.programRestored = [bool](Restore-AppBackup -From $backupDir -To $AppDir)
        if (-not $report.rollback.programRestored) {
            $report.rollback.note = '程序恢复失败，需手动从 ' + $backupDir + ' 恢复'
        }
    } else {
        $removed = 0
        $failed = 0
        foreach ($rel in $files) {
            $p = Join-Path $AppDir $rel
            if (-not (Test-Path -LiteralPath $p)) { continue }
            try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop; $removed++ }
            catch { $failed++ }
        }
        Remove-EmptyDirs $AppDir
        # 只有本次新建、且已经清空的目录才删；用户原本就有的目录留着
        if (-not $appDirExistedBefore -and (Test-Path -LiteralPath $AppDir)) {
            $left = @(Get-ChildItem -LiteralPath $AppDir -Force -ErrorAction SilentlyContinue)
            if ($left.Count -eq 0) { Remove-Item -LiteralPath $AppDir -Force -ErrorAction SilentlyContinue }
        }
        $report.rollback.cleaned = ($failed -eq 0)
        $report.rollback.programRestored = ($failed -eq 0)
        if (-not $report.rollback.note) {
            $report.rollback.note = '新安装失败：已清理本次复制的 ' + $removed + ' 个文件（用户数据未动）'
        }
    }

    # 状态一律以「磁盘上的版本」为准判定，而不是假设自己没写过
    $expected = ''
    if ($oldState -and [string]$oldState.version) { $expected = [string]$oldState.version }
    $stateOk = $false
    try {
        $cur = Read-JsonFile $statePath
        if ($expected) {
            if (-not $cur -or ([string]$cur.version -ne $expected)) {
                if ($stateBackupPath -and (Test-Path -LiteralPath $stateBackupPath)) {
                    Copy-Item -LiteralPath $stateBackupPath -Destination $statePath -Force -ErrorAction Stop
                    $cur = Read-JsonFile $statePath
                }
            }
            $stateOk = [bool]($cur -and ([string]$cur.version -eq $expected))
        } else {
            # 本次之前没有安装记录：回滚后也不该凭空多出一条
            $stateOk = -not (Test-Path -LiteralPath $statePath)
        }
    } catch {
        $stateOk = $false
        $report.rollback.note = '状态检查异常：' + $_.Exception.Message
    }
    $report.rollback.stateRestored = $stateOk

    $parts = @()
    if ($existingInstall) {
        if ($report.rollback.programRestored) { $parts += ('程序已恢复到 ' + [string]$oldState.version) }
        else { $parts += ('程序恢复失败，备份在 ' + $backupDir) }
    } else {
        if ($report.rollback.cleaned) { $parts += '本次复制的程序文件已清理' }
        else { $parts += '部分程序文件未能清理，需手动删除' }
    }
    if ($stateOk) { $parts += '安装记录与安装前一致' }
    else { $parts += ('安装记录不一致（期望 ' + $expected + '），请从 ' + $stateBackupPath + ' 恢复') }
    Fail-Install ($Why + '；' + ($parts -join '；')) $Code
}

# ---- 4. 复制 ----
Write-Stage 'copy'
if ($DryRun) {
    Write-Line ('预检模式：将安装 ' + $files.Count + ' 个文件到 ' + $AppDir)
} else {
    try {
        if ($InjectFault -eq 'copy-mid') {
            # 5 个文件之后失败：足够留下半套文件，用来验证清理逻辑
            $n = 0
            foreach ($rel in $files) {
                if ($n -ge 5) { throw ('故障注入：复制到第 ' + ($n + 1) + ' 个文件时失败') }
                Copy-InstallFiles -SourceDir $SourceDir -AppDir $AppDir -Files @($rel)
                $n++
            }
        } else {
            Copy-InstallFiles -SourceDir $SourceDir -AppDir $AppDir -Files $files
        }
    } catch {
        Invoke-InstallRollback -Why ('复制失败：' + $_.Exception.Message) -Code 4
    }
}

# ---- 5. 校验 ----
Write-Stage 'verify'
if (-not $DryRun) {
    if ($InjectFault -eq 'verify') {
        # 模拟「复制没报错但落盘字节不对」：改掉一个清单文件让哈希比对失败
        Set-Content -LiteralPath (Join-Path $AppDir 'scripts\lib.js') -Value 'corrupted by fault injection' -Encoding UTF8 -Force
    }
    $bad = @()
    foreach ($rel in $files) {
        $srcHash = Get-Sha256 (Join-Path $SourceDir $rel)
        $dstHash = Get-Sha256 (Join-Path $AppDir $rel)
        if (-not $dstHash) { $bad += ($rel + '（缺失）'); continue }
        if ($srcHash -ne $dstHash) { $bad += ($rel + '（哈希不一致）') }
    }
    if ($bad.Count -gt 0) {
        Invoke-InstallRollback -Why ('装后校验失败：' + ($bad -join '; ')) -Code 5
    }
}
$report.fileCount = $files.Count

# ---- 6. 快捷方式（先做，路径要写进安装记录，卸载时只认这一条）----
Write-Stage 'shortcut'
# 只在「用户没有同名快捷方式」时创建；已存在就不动 —— 那是用户自己的东西。
$shortcutPath = ''
$script:createdShortcut = ''
if (-not $NoShortcut -and -not $DryRun) {
    $desktop = ''
    if ($DesktopDir) {
        # 测试注入：绝不允许测试在真实桌面上留下东西
        if (-not (Test-Path -LiteralPath $DesktopDir)) { New-Item -ItemType Directory -Force -Path $DesktopDir | Out-Null }
        $desktop = [IO.Path]::GetFullPath($DesktopDir).TrimEnd('\')
    } else {
        $desktop = Get-DesktopDir
    }
    $launcher = Join-Path $AppDir 'scripts\launcher.cmd'
    $launcherVbs = Join-Path $AppDir 'scripts\launcher-hidden.vbs'
    if ($desktop -and (Test-Path -LiteralPath $launcher)) {
        $lnk = Join-Path $desktop 'WorkDaddy.lnk'
        if (Test-Path -LiteralPath $lnk) {
            $report.warnings += ('桌面已有同名快捷方式，未覆盖：' + $lnk)
        } else {
            $icon = Join-Path $AppDir 'release\WorkDaddy.ico'
            $okLnk = $false
            if (Test-Path -LiteralPath $launcherVbs) {
                $okLnk = New-Shortcut -LnkPath $lnk -Target (Join-Path $env:WINDIR 'System32\wscript.exe') -Arguments ('//nologo "' + $launcherVbs + '"') -WorkDir (Join-Path $AppDir 'scripts') -IconPath $icon
            } else {
                $okLnk = New-Shortcut -LnkPath $lnk -Target $launcher -Arguments '' -WorkDir (Join-Path $AppDir 'scripts') -IconPath $icon
            }
            if ($okLnk) { $shortcutPath = $lnk; $script:createdShortcut = $lnk; $report.shortcut = $lnk }
            else { $report.warnings += '创建桌面快捷方式失败（不影响安装）' }
        }
    } else {
        $report.warnings += '未创建快捷方式：缺少 launcher.cmd 或找不到桌面目录'
    }
}

# ---- 7. 数据目录初始化 + 状态提交 ----
Write-Stage 'datadir'
$configPath = Join-Path $DataDir 'config.json'
if (-not $DryRun) {
    try {
        if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }
        if (-not (Test-Path -LiteralPath $configPath)) {
            Write-JsonFile -Path $configPath -Value ([ordered]@{
                schema       = 1
                clientProfile = $ClientProfile
                autoStart    = $false
                rehome       = [ordered]@{ enabled = $false; dedupe = $false; dedupeMode = 'exact'; allowBackground = $false }
                permission   = [ordered]@{ preferenceGuard = $false; configRepair = $false; autoApprove = $false }
            })
        }
    } catch {
        Invoke-InstallRollback -Why ('数据目录初始化失败：' + $_.Exception.Message) -Code 6
    }

    # 状态提交：写临时文件 → 校验 → 原子替换 → 再校验。
    # 直接写目标文件的话，写到一半失败会留下一个「能解析但清单不全」的记录，
    # 卸载时按它删就会漏文件。
    $stateTmp = Join-Path $DataDir ('.install-state.tmp-' + $stamp + '.json')
    $report.state.tmpPath = $stateTmp
    try {
        Write-Stage ('state:hashing ' + $files.Count + ' files')
        $table = Get-InstalledFileTable -AppDir $AppDir -Files $files
        $payload = [ordered]@{
            schema        = 1
            product       = 'WorkDaddy'
            channel       = 'fork'
            version       = $version
            appDir        = $AppDir
            dataDir       = $DataDir
            clientProfile = $ClientProfile
            installedAt   = (Get-Date).ToString('o')
            source        = 'installer/install-workdaddy.ps1'
            shortcut      = $shortcutPath
            files         = $table
        }
        if ($InjectFault -eq 'state-write') { throw '故障注入：状态文件无法写入（模拟磁盘/权限问题）' }
        Write-Stage 'state:write-tmp'
        Write-JsonFile -Path $stateTmp -Value $payload
        $err = Test-InstallStatePayload -Path $stateTmp -ExpectVersion $version -ExpectAppDir $AppDir -MinFiles $files.Count
        if ($err) { throw ('新状态校验失败：' + $err) }
        Write-Stage 'state:validated'
        $report.state.validated = $true

        if (Test-Path -LiteralPath $statePath) {
            [IO.File]::Replace($stateTmp, $statePath, ($statePath + '.bak'), $true)
        } else {
            Move-Item -LiteralPath $stateTmp -Destination $statePath -Force
        }
        $err = Test-InstallStatePayload -Path $statePath -ExpectVersion $version -ExpectAppDir $AppDir -MinFiles $files.Count
        if ($err) { throw ('提交后校验失败：' + $err) }
        Write-Stage 'state:committed'
        $report.state.committed = $true
    } catch {
        if (Test-Path -LiteralPath $stateTmp) { Remove-Item -LiteralPath $stateTmp -Force -ErrorAction SilentlyContinue }
        Invoke-InstallRollback -Why ('状态提交失败：' + $_.Exception.Message) -Code 7
    }
    if (Test-Path -LiteralPath ($statePath + '.bak')) {
        Remove-Item -LiteralPath ($statePath + '.bak') -Force -ErrorAction SilentlyContinue
    }
}

# ---- 8. 收尾 ----
Write-Stage 'finalize'
if (-not $report.preflight.clientDetected) {
    $report.warnings += '未检测到 WorkBuddy 官方客户端：WorkDaddy 已安装，但需要先安装并登录客户端才能接管账号。'
}
$report.ok = $true
Write-Line ('安装完成：' + $version + ' → ' + $AppDir)
Write-Line ('数据目录：' + $DataDir)
foreach ($w in $report.warnings) { Write-Line ('提示：' + $w) }
Write-Report -Report $report -JsonPath $Json
Write-Stage 'done'
# 成功时把痕迹清掉：它只是诊断用的，不该在用户数据目录里留垃圾
if ($script:tracePath -and (Test-Path -LiteralPath $script:tracePath)) {
    Remove-Item -LiteralPath $script:tracePath -Force -ErrorAction SilentlyContinue
}
exit 0
