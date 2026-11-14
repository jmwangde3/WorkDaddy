# Setup 真机验证：静默安装 → 检查落盘 → 静默卸载 → 检查数据保留
#
# 这个脚本会真的往「当前用户」的 %LOCALAPPDATA%\Programs\WorkDaddy 装东西，
# 所以必须在一次性机器上跑（CI runner、临时虚拟机）。为防误用，
# 不带 -IAmOnAThrowawayMachine 直接拒绝执行 —— 开发机上永远不要跑它。
#
# 它验证的是 docs/migration/07-ci-release.md 里「Setup 尚未验证」那条：
#   * workdaddy.iss 能被 ISCC 编译（由调用方 build-package.ps1 -Setup 完成）
#   * 装完之后 install-state.json 与程序文件都在
#   * 卸载后程序文件没了，但 %APPDATA%\WorkDaddy 里的用户数据还在
#
# 退出码：0 通过 / 2 没带一次性机器开关 / 3 机器上已有真实安装（拒绝覆盖）
#         / 4 安装失败 / 5 装完后的落盘检查未通过 / 6 卸载失败 / 7 卸载后检查未通过
param(
    [Parameter(Mandatory = $true)][string]$SetupExe,
    [switch]$IAmOnAThrowawayMachine,
    [switch]$KeepInstalled,
    [string]$Json = ''
)

$ErrorActionPreference = 'Stop'

$report = [ordered]@{
    schema      = 1
    action      = 'verify-setup'
    ok          = $false
    setupExe    = ''
    appDir      = ''
    dataDir     = ''
    install     = [ordered]@{ exitCode = -1; stateVersion = ''; files = 0; shortcut = '' }
    uninstall   = [ordered]@{ exitCode = -1; appGone = $false; dataKept = $false; shortcutGone = $false }
    checks      = [ordered]@{}
    error       = ''
    exitCode    = 0
}

function Write-Report2 {
    if (-not $Json) { return }
    $dir = Split-Path -Parent $Json
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Json, ($report | ConvertTo-Json -Depth 6), $enc)
}

function Fail-Setup {
    param([string]$Message, [int]$Code)
    $report.error = $Message
    $report.exitCode = $Code
    Write-Report2
    [Console]::Error.WriteLine('错误：' + $Message)
    exit $Code
}

if (-not $IAmOnAThrowawayMachine) {
    Fail-Setup '拒绝执行：本脚本会真的安装到当前用户目录。请只在一次性机器上带 -IAmOnAThrowawayMachine 运行。' 2
}
if (-not (Test-Path -LiteralPath $SetupExe)) { Fail-Setup ('找不到 Setup：' + $SetupExe) 4 }
$SetupExe = [IO.Path]::GetFullPath($SetupExe)
$report.setupExe = $SetupExe

$appDir = Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy'
$dataDir = Join-Path $env:APPDATA 'WorkDaddy'
$report.appDir = $appDir
$report.dataDir = $dataDir

# 这台机器上不能已经有真实安装：否则一次「验证」会把人家的东西换掉
if (Test-Path -LiteralPath (Join-Path $appDir 'scripts\daemon.js')) {
    Fail-Setup ('这台机器上已存在 WorkDaddy 安装：' + $appDir + '；换一台一次性机器再跑') 3
}

[Console]::WriteLine('--- 静默安装 ---')
$installArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-')
$p = Start-Process -FilePath $SetupExe -ArgumentList $installArgs -Wait -PassThru
$report.install.exitCode = [int]$p.ExitCode
if ($p.ExitCode -ne 0) { Fail-Setup ('Setup 退出码 ' + $p.ExitCode) 4 }

# Inno 的 [Run] 步骤不传递子进程退出码，所以结果只能看落盘
$statePath = Join-Path $dataDir 'install-state.json'
if (-not (Test-Path -LiteralPath $statePath)) { Fail-Setup ('装完没有安装记录：' + $statePath) 5 }
if (-not (Test-Path -LiteralPath (Join-Path $appDir 'scripts\daemon.js'))) { Fail-Setup '装完没有 scripts\daemon.js' 5 }
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$report.install.stateVersion = [string]$state.version
$report.install.files = @($state.files).Count
$report.install.shortcut = [string]$state.shortcut
if (-not $report.install.stateVersion) { Fail-Setup '安装记录里没有版本号' 5 }
if ($report.install.files -lt 100) { Fail-Setup ('安装记录条目太少：' + $report.install.files) 5 }

# 逐条核对清单：装完就该和记录一致
$bad = @()
foreach ($row in @($state.files)) {
    $f = Join-Path $appDir ([string]$row.path)
    if (-not (Test-Path -LiteralPath $f)) { $bad += ([string]$row.path + '（缺失）'); continue }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $fs = [IO.File]::OpenRead($f)
        try { $h = ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLowerInvariant() }
        finally { $fs.Dispose() }
    } finally { $sha.Dispose() }
    if ($h -ne [string]$row.sha256) { $bad += ([string]$row.path + '（哈希不符）') }
}
$report.checks.manifestMatches = ($bad.Count -eq 0)
if ($bad.Count -gt 0) { Fail-Setup ('装完的文件与清单不一致，前几条：' + (($bad | Select-Object -First 5) -join '; ')) 5 }

# 用户数据必须还在原位（安装器不该把 %APPDATA%\WorkDaddy 挪走）
$report.checks.dataDirCreated = Test-Path -LiteralPath $dataDir
$report.checks.configExists = Test-Path -LiteralPath (Join-Path $dataDir 'config.json')
if (-not $report.checks.configExists) { Fail-Setup '装完没有生成 config.json' 5 }

if ($KeepInstalled) {
    $report.ok = $true
    $report.exitCode = 0
    Write-Report2
    [Console]::WriteLine('已保留安装（-KeepInstalled）')
    exit 0
}

[Console]::WriteLine('--- 静默卸载 ---')
$unins = @(Get-ChildItem -LiteralPath $appDir -Filter 'unins*.exe' -File -ErrorAction SilentlyContinue)
if ($unins.Count -eq 0) { Fail-Setup ('找不到卸载器：' + $appDir) 6 }
$u = Start-Process -FilePath $unins[0].FullName -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
$report.uninstall.exitCode = [int]$u.ExitCode
if ($u.ExitCode -ne 0) { Fail-Setup ('卸载器退出码 ' + $u.ExitCode) 6 }

# Inno 自己会等 [UninstallRun] 结束；这里再等一小会儿让文件句柄释放
for ($i = 0; $i -lt 10; $i++) {
    if (-not (Test-Path -LiteralPath (Join-Path $appDir 'scripts\daemon.js'))) { break }
    Start-Sleep -Milliseconds 300
}

$report.uninstall.appGone = -not (Test-Path -LiteralPath (Join-Path $appDir 'scripts\daemon.js'))
$report.uninstall.dataKept = (Test-Path -LiteralPath $statePath)
if ($report.install.shortcut) {
    $report.uninstall.shortcutGone = -not (Test-Path -LiteralPath $report.install.shortcut)
} else {
    $report.uninstall.shortcutGone = $true
}

if (-not $report.uninstall.appGone) { Fail-Setup '卸载后程序文件仍在' 7 }
if (-not $report.uninstall.dataKept) { Fail-Setup '卸载把用户数据一起删了（默认必须保留）' 7 }
if (-not $report.uninstall.shortcutGone) { Fail-Setup ('卸载后快捷方式还在：' + $report.install.shortcut) 7 }

$report.ok = $true
$report.exitCode = 0
Write-Report2
[Console]::WriteLine('Setup 验证通过：安装 → 清单一致 → 卸载 → 数据保留')
exit 0
