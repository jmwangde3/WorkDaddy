# WorkDaddy 独立安装器
#
# 与旧 deploy.ps1 的区别：deploy.ps1 是「把补丁覆盖到 WorkBuddy 安装目录」，
# 本脚本是「把 WorkDaddy 装到自己的目录，通过 CDP 与官方客户端交互」。
# 两者互不替代：旧补丁版用户先用本脚本迁移配置，再决定是否卸载旧补丁。
#
# 流程：预检 → 识别旧补丁版并导入配置 → 备份旧版本 → 复制 → 校验 → 初始化数据目录 → 快捷方式 → 报告
#
# 退出码：0 成功 / 1 源目录无效 / 2 预检未通过 / 3 目标目录不可写 / 4 复制失败 / 5 校验失败 / 6 数据目录初始化失败
param(
    [string]$SourceDir = '',
    [string]$AppDir = '',
    [string]$DataDir = '',
    [string]$ClientProfile = 'workbuddy-cn',
    [string]$LegacyScriptsDir = '',
    [switch]$DryRun,
    [switch]$NoShortcut,
    [switch]$SkipClientCheck,
    [switch]$Force,
    [string]$Json = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

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

# ---- 3. 已有安装：备份后覆盖 ----
$statePath = Join-Path $DataDir 'install-state.json'
$oldState = Read-JsonFile $statePath
if ($oldState -and (Test-Path -LiteralPath (Join-Path $AppDir 'scripts\daemon.js'))) {
    $oldVersion = [string]$oldState.version
    if ($oldVersion -and $oldVersion -ne $version) {
        $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
        $backupDir = Join-Path $DataDir ('backups\app-' + $oldVersion + '-' + $stamp)
        if (-not $DryRun) {
            try {
                New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
                Copy-Item -Path (Join-Path $AppDir '*') -Destination $backupDir -Recurse -Force -ErrorAction Stop
                $report.backup = $backupDir
                Write-Line ('已备份旧版本 ' + $oldVersion + ' → ' + $backupDir)
                # 只保留最近 2 个备份
                $all = @(Get-ChildItem -LiteralPath (Join-Path $DataDir 'backups') -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -like 'app-*' } | Sort-Object Name -Descending)
                if ($all.Count -gt 2) {
                    for ($i = 2; $i -lt $all.Count; $i++) { Remove-Item -LiteralPath $all[$i].FullName -Recurse -Force -ErrorAction SilentlyContinue }
                }
            } catch {
                Fail-Install ('备份旧版本失败，已中止以免无法回滚：' + $_.Exception.Message) 4
            }
        } else {
            $report.backup = '(dry-run: ' + $backupDir + ')'
        }
    }
}

# ---- 4. 复制 ----
if ($DryRun) {
    Write-Line ('预检模式：将安装 ' + $files.Count + ' 个文件到 ' + $AppDir)
} else {
    try {
        Copy-InstallFiles -SourceDir $SourceDir -AppDir $AppDir -Files $files
    } catch {
        Fail-Install ('复制失败：' + $_.Exception.Message) 4
    }
}

# ---- 5. 校验 ----
if (-not $DryRun) {
    $bad = @()
    foreach ($rel in $files) {
        $srcHash = Get-Sha256 (Join-Path $SourceDir $rel)
        $dstHash = Get-Sha256 (Join-Path $AppDir $rel)
        if (-not $dstHash) { $bad += ($rel + '（缺失）'); continue }
        if ($srcHash -ne $dstHash) { $bad += ($rel + '（哈希不一致）') }
    }
    if ($bad.Count -gt 0) {
        Fail-Install ('装后校验失败：' + ($bad -join '; ')) 5
    }
}
$report.fileCount = $files.Count

# ---- 6. 快捷方式（先做，路径要写进安装记录，卸载时只认这一条）----
# 只在「用户没有同名快捷方式」时创建；已存在就不动 —— 那是用户自己的东西。
$shortcutPath = ''
if (-not $NoShortcut -and -not $DryRun) {
    $desktop = Get-DesktopDir
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
            if ($okLnk) { $shortcutPath = $lnk; $report.shortcut = $lnk }
            else { $report.warnings += '创建桌面快捷方式失败（不影响安装）' }
        }
    } else {
        $report.warnings += '未创建快捷方式：缺少 launcher.cmd 或找不到桌面目录'
    }
}

# ---- 7. 数据目录初始化（不覆盖已有配置）----
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
        $table = Get-InstalledFileTable -AppDir $AppDir -Files $files
        Write-JsonFile -Path $statePath -Value ([ordered]@{
            schema      = 1
            product     = 'WorkDaddy'
            channel     = 'fork'
            version     = $version
            appDir      = $AppDir
            dataDir     = $DataDir
            clientProfile = $ClientProfile
            installedAt = (Get-Date).ToString('o')
            source      = 'installer/install-workdaddy.ps1'
            shortcut    = $shortcutPath
            files       = $table
        })
    } catch {
        Fail-Install ('数据目录初始化失败：' + $_.Exception.Message) 6
    }
}

# ---- 8. 收尾 ----
if (-not $report.preflight.clientDetected) {
    $report.warnings += '未检测到 WorkBuddy 官方客户端：WorkDaddy 已安装，但需要先安装并登录客户端才能接管账号。'
}
$report.ok = $true
Write-Line ('安装完成：' + $version + ' → ' + $AppDir)
Write-Line ('数据目录：' + $DataDir)
foreach ($w in $report.warnings) { Write-Line ('提示：' + $w) }
Write-Report -Report $report -JsonPath $Json
exit 0
