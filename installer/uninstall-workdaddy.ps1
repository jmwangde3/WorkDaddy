# WorkDaddy 卸载器
#
# 只删「本安装器装进去的文件」：以 install-state.json 里的清单为准，逐条比对哈希。
# 哈希不一致说明用户改过或已被别的版本覆盖 → 默认跳过并报告，-Force 才删。
#
# 默认保留：用户配置、日志、备份、导入的旧配置（都在 DataDir）。
# 清理数据必须显式 -PurgeData -YesPurgeData 双开关，且报告里列出删除范围。
#
# 绝不触碰：WorkBuddy 官方安装目录、WorkBuddy 用户数据、旧补丁版目录。
#
# 退出码：0 成功 / 1 参数或状态文件问题 / 3 部分文件删除失败
param(
    [string]$AppDir = '',
    [string]$DataDir = '',
    [switch]$PurgeData,
    [switch]$YesPurgeData,
    [switch]$Force,
    [switch]$DryRun,
    [string]$Json = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

if (-not $AppDir) { $AppDir = Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy' }
if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA 'WorkDaddy' }
# 先留住原始输入：GetFullPath 会把 .. 归一化掉，等检查时就看不出路径穿越了。
$AppDirRaw = [string]$AppDir
$DataDirRaw = [string]$DataDir
$AppDir = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$report = [ordered]@{
    schema    = 1
    action    = 'uninstall'
    ok        = $false
    dryRun    = [bool]$DryRun
    appDir    = $AppDir
    dataDir   = $DataDir
    removed   = @()
    skipped   = @()
    dataPurged = $false
    purgeScope = @()
    error     = ''
    exitCode  = 0
}

function Fail-Uninstall {
    param([string]$Message, [int]$Code)
    $report.error = $Message
    $report.exitCode = $Code
    Write-Line ('错误：' + $Message)
    Write-Report -Report $report -JsonPath $Json
    exit $Code
}

# 动手之前先确认这两个目录不是「删了会出事」的那种。
# 卸载器按清单拼路径删文件，AppDir 一旦被指到盘根或用户主目录，
# 清单里的相对路径就会被拼到那种目录下 —— 拼出来的确实在它内部，
# 所以只靠 StartsWith 是挡不住的。
$guard = Test-SafeRootDir -Path $AppDirRaw -Label 'AppDir'
if ($guard) { Fail-Uninstall $guard 2 }
$guard = Test-SafeRootDir -Path $DataDirRaw -Label 'DataDir'
if ($guard) { Fail-Uninstall $guard 2 }
$overlap = Test-DirOverlap -A $AppDir -B $DataDir
if ($overlap) { Fail-Uninstall ('安装目录与数据目录不能重叠：' + $overlap) 2 }

Write-Line '=============================================================='
Write-Line ' WorkDaddy 卸载'
Write-Line '=============================================================='

$statePath = Join-Path $DataDir 'install-state.json'
$state = Read-JsonFile $statePath
if (-not $state -or -not $state.files) {
    Fail-Uninstall ('找不到安装记录：' + $statePath + '（没有记录就无法保证只删自己的文件；请手动确认目录内容）') 1
}

if ($PurgeData -and -not $YesPurgeData) {
    Fail-Uninstall '要清理用户数据必须同时给 -PurgeData -YesPurgeData：配置、日志、备份、导入的旧配置都会删除，且不可恢复。' 1
}

# 状态文件里的 appDir 优先（用户可能用自定义目录装过）
$recordedApp = [string]$state.appDir
if ($recordedApp) {
    $AppDir = $recordedApp.TrimEnd('\')
    # 安装记录是本地 JSON，可能被改过；覆盖后必须重新过一次边界检查
    $guard = Test-SafeRootDir -Path $AppDir -Label '安装记录里的 AppDir'
    if ($guard) { Fail-Uninstall $guard 2 }
    $overlap = Test-DirOverlap -A $AppDir -B $DataDir
    if ($overlap) { Fail-Uninstall ('安装目录与数据目录不能重叠：' + $overlap) 2 }
}

# 删文件前先停掉本安装的进程（托盘 / watchdog / daemon）。
# 它们握着 AppDir 里的文件句柄，不停就删不掉，最后留下半套残留。
if (-not $DryRun) {
    $stopResult = Stop-WorkDaddyProcesses -AppDir $AppDir
    $report['service'] = [ordered]@{ stopped = @($stopResult.stopped); error = [string]$stopResult.error }
    if (-not $stopResult.ok) {
        Fail-Uninstall ('无法停止运行中的 WorkDaddy 进程：' + $stopResult.error + '；未删除任何文件') 4
    }
    if (@($stopResult.stopped).Count -gt 0) {
        Write-Line ('已停止运行中的进程：' + (@($stopResult.stopped) -join ','))
    }
}

$removed = 0
foreach ($row in $state.files) {
    $rel = [string]$row.path
    # 防御：安装记录是本地 JSON，可能被改过。只允许删除 AppDir 内的相对路径，
    # 出现 ..\ / 绝对路径 / 盘符一律跳过并报告，绝不越界删文件。
    if (-not $rel -or $rel.Contains('..') -or [IO.Path]::IsPathRooted($rel)) {
        $report.skipped += [pscustomobject]@{ path = $rel; reason = 'outside-appdir' }
        continue
    }
    $p = Join-Path $AppDir $rel
    $full = [IO.Path]::GetFullPath($p)
    if (-not $full.StartsWith($AppDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $report.skipped += [pscustomobject]@{ path = $rel; reason = 'outside-appdir' }
        continue
    }
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $nowHash = Get-Sha256 $p
    if (-not $Force -and $nowHash -ne [string]$row.sha256) {
        $report.skipped += [pscustomobject]@{ path = $row.path; reason = 'hash-changed' }
        continue
    }
    if ($DryRun) {
        $report.removed += [pscustomobject]@{ path = $row.path; dryRun = $true }
        $removed += 1
        continue
    }
    try {
        Remove-Item -LiteralPath $p -Force
        $report.removed += [pscustomobject]@{ path = $row.path }
        $removed += 1
    } catch {
        $report.skipped += [pscustomobject]@{ path = $row.path; reason = $_.Exception.Message }
    }
}

if (-not $DryRun) {
    Remove-EmptyDirs -Root $AppDir
    # 安装目录空了就删掉自己建的外壳
    if (Test-Path -LiteralPath $AppDir) {
        $left = @(Get-ChildItem -LiteralPath $AppDir -Force -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) { Remove-Item -LiteralPath $AppDir -Force -ErrorAction SilentlyContinue }
    }
    # 快捷方式只删「安装时记录下来的那一条」。不按名字猜：桌面上的 WorkDaddy.lnk
    # 可能是用户自己建的（指向别的安装、或旧补丁版），删掉就是毁用户环境。
    $recordedLnk = [string]$state.shortcut
    if ($recordedLnk -and (Test-Path -LiteralPath $recordedLnk)) {
        try {
            Remove-Item -LiteralPath $recordedLnk -Force
            $report.removed += [pscustomobject]@{ path = $recordedLnk }
        } catch { }
    }
}

if ($PurgeData) {
    # 清理前最后一道：目录必须仍然安全，且与安装记录登记的完全一致。
    # 这一步是「-PurgeData 只删自己的数据」的兑现方式 —— 记录被改过就拒绝。
    $guard = Test-SafeRootDir -Path $DataDir -Label 'DataDir（清理前复核）'
    if ($guard) { Fail-Uninstall $guard 3 }
    $recordedData = [string]$state.dataDir
    if ($recordedData) {
        $recordedFull = [IO.Path]::GetFullPath($recordedData).TrimEnd('\')
        $targetFull = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
        if (-not $recordedFull.Equals($targetFull, [StringComparison]::OrdinalIgnoreCase)) {
            Fail-Uninstall ('安装记录里的数据目录（' + $recordedFull + '）与当前清理目标（' + $targetFull +
                '）不一致；无法确认归属，拒绝清理') 3
        }
    }
    $report.purgeScope = @(
        '配置 config.json',
        '安装记录 install-state.json',
        '日志 logs\',
        '版本备份 backups\',
        '旧补丁配置导入 legacy-import\'
    )
    if (-not $DryRun) {
        try {
            Get-ChildItem -LiteralPath $DataDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force
            }
            $report.dataPurged = $true
        } catch {
            Fail-Uninstall ('清理数据目录失败：' + $_.Exception.Message) 3
        }
    }
} else {
    Write-Line ('用户数据保留在：' + $DataDir + '（要清理请加 -PurgeData -YesPurgeData）')
}

if ($report.skipped.Count -gt 0) {
    $report.ok = $false
    $report.error = '有文件因哈希变化被跳过（可能被手动改过）：加 -Force 可强制删除'
    $report.exitCode = 3
    Write-Report -Report $report -JsonPath $Json
    Write-Line ('提示：' + $report.error)
    exit 3
}

$report.ok = $true
Write-Line ('卸载完成：删除 ' + $removed + ' 个文件')
Write-Report -Report $report -JsonPath $Json
exit 0
