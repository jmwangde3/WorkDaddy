# WorkDaddy 托盘编译（可复现构建入口）
#
# 只用 Windows 自带的 .NET Framework 4.x 编译器（csc.exe），不需要 Visual Studio /
# .NET SDK / NuGet。tray\build.cmd 是给双击用的同一套参数；本脚本多做的事只有三件：
#   1. 把编译器路径、文件版本、完整参数、源码与产物的 SHA-256 写进构建清单；
#   2. 可选的 -Verify：编译完立刻跑 --selftest / --status，结果落进清单；
#   3. 失败用退出码表达，便于 CI 判定。
#
# 参数与 tray\build.cmd 必须保持一致 —— test/tray-build.test.js 会逐项比对。
#
# 退出码：0 成功 / 1 找不到 csc.exe / 2 编译失败 / 3 产物缺失 / 4 -Verify 未通过
param(
    [string]$SourcePath = '',
    [string]$OutputPath = '',
    [string]$ManifestPath = '',
    [switch]$Verify,
    [string]$Json = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')
$repoRoot = Split-Path -Parent $here

if (-not $SourcePath) { $SourcePath = Join-Path $repoRoot 'tray\WorkDaddyTray.cs' }
if (-not $OutputPath) { $OutputPath = Join-Path $repoRoot 'tray\WorkDaddyTray.exe' }
$SourcePath = [IO.Path]::GetFullPath($SourcePath)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (-not $ManifestPath) { $ManifestPath = $OutputPath + '.build.json' }

# 与 tray\build.cmd 完全一致：改一处必须同时改另一处。
$cscArgs = @(
    '/nologo'
    '/target:winexe'
    '/optimize+'
    '/codepage:65001'
    '/r:System.dll'
    '/r:System.Core.dll'
    '/r:System.Windows.Forms.dll'
    '/r:System.Drawing.dll'
    '/r:System.Management.dll'
)

$manifest = [ordered]@{
    schema     = 1
    product    = 'WorkDaddyTray'
    ok         = $false
    builtAt    = (Get-Date).ToString('o')
    compiler   = [ordered]@{ path = ''; fileVersion = ''; productVersion = ''; framework = '' }
    arguments  = @()
    source     = [ordered]@{ path = ''; sha256 = ''; size = 0 }
    output     = [ordered]@{ path = ''; sha256 = ''; size = 0 }
    verify     = [ordered]@{ ran = $false; selftest = ''; status = ''; ok = $false }
    warnings   = @()
    error      = ''
    exitCode   = 0
}

function Get-Sha256Of {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $fs = [IO.File]::OpenRead($Path)
        try { return ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLowerInvariant() }
        finally { $fs.Dispose() }
    } finally { $sha.Dispose() }
}

function Write-Manifest {
    $dir = Split-Path -Parent $ManifestPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($ManifestPath, ($manifest | ConvertTo-Json -Depth 6), $enc)
}

function Fail-Tray {
    param([string]$Message, [int]$Code)
    $manifest.error = $Message
    $manifest.exitCode = $Code
    Write-Manifest
    if ($Json) {
        $enc = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($Json, ($manifest | ConvertTo-Json -Depth 6), $enc)
    }
    [Console]::Error.WriteLine('错误：' + $Message)
    exit $Code
}

Write-Line '=============================================================='
Write-Line ' WorkDaddy 托盘编译'
Write-Line '=============================================================='

if (-not (Test-Path -LiteralPath $SourcePath)) { Fail-Tray ('找不到源码：' + $SourcePath) 1 }

$csc = ''
foreach ($c in @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'))) {
    if (Test-Path -LiteralPath $c) { $csc = $c; break }
}
if (-not $csc) { Fail-Tray '找不到 .NET Framework 4.x 的 csc.exe（需要 Windows 自带的 .NET Framework 4.8）' 1 }

$vi = (Get-Item -LiteralPath $csc).VersionInfo
$manifest.compiler.path = $csc
$manifest.compiler.fileVersion = [string]$vi.FileVersion
$manifest.compiler.productVersion = [string]$vi.ProductVersion
$manifest.compiler.framework = if ($csc -like '*Framework64*') { 'Framework64' } else { 'Framework' }
$manifest.source.path = $SourcePath
$manifest.source.sha256 = Get-Sha256Of $SourcePath
$manifest.source.size = (Get-Item -LiteralPath $SourcePath).Length
# 参数要逐项 append：`@('/out:' + $Path, $Source)` 在 PowerShell 里会被解析成
# 字符串 + 数组（结果是两项被空格粘成一项），csc 会把两个路径当成一个文件名。
$nativeArgs = @()
$nativeArgs += $cscArgs
$nativeArgs += ('/out:' + $OutputPath)
$nativeArgs += $SourcePath
$manifest.arguments = $nativeArgs
Write-Line ('编译器：' + $csc + ' (' + $vi.FileVersion + ')')

if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
$outDir = Split-Path -Parent $OutputPath
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# 5.1 下原生命令往 stderr 写东西会触发 NativeCommandError（$ErrorActionPreference='Stop'
# 时是终止错误）。csc 的编译错误正是走 stdout/stderr 的，先降级再调用。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$compileOut = & $csc @nativeArgs 2>&1
$compileCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($compileOut) { $compileOut | ForEach-Object { Write-Line ([string]$_) } }

if ($compileCode -ne 0) { Fail-Tray ('编译失败（csc 退出码 ' + $compileCode + '）') 2 }
if (-not (Test-Path -LiteralPath $OutputPath)) { Fail-Tray ('编译成功但产物不存在：' + $OutputPath) 3 }

$manifest.output.path = $OutputPath
$manifest.output.sha256 = Get-Sha256Of $OutputPath
$manifest.output.size = (Get-Item -LiteralPath $OutputPath).Length
Write-Line ('产物：' + $OutputPath + '  ' + $manifest.output.size + ' 字节  ' + $manifest.output.sha256)

if ($Verify) {
    # --selftest 会临时改写并还原 HKCU\...\Run\WorkDaddyTray；--status 只读。
    # 两者都把输出同时写到 %TEMP%\WorkDaddyTray-cli.txt，所以结果不受 GUI 子系统影响。
    $manifest.verify.ran = $true
    $tmpDir = Join-Path $env:TEMP ('workdaddy-tray-verify-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    $prevTemp = $env:TEMP
    $prevTmp = $env:TMP
    $env:TEMP = $tmpDir
    $env:TMP = $tmpDir
    try {
        $cliFile = Join-Path $tmpDir 'WorkDaddyTray-cli.txt'
        $st = ''
        try {
            $p = Start-Process -FilePath $OutputPath -ArgumentList '--selftest' -PassThru -Wait -WindowStyle Hidden
            if (Test-Path -LiteralPath $cliFile) { $st = [IO.File]::ReadAllText($cliFile) }
            $manifest.verify.selftest = $st.Trim()
        } catch {
            $manifest.verify.selftest = 'FAILED: ' + $_.Exception.Message
        }
        if ($st -notmatch 'SELF-TEST OK') { Fail-Tray ('--selftest 未通过：' + ($st -replace "`r?`n", ' | ')) 4 }

        Remove-Item -LiteralPath $cliFile -Force -ErrorAction SilentlyContinue
        $sr = ''
        try {
            $p2 = Start-Process -FilePath $OutputPath -ArgumentList '--status' -PassThru -Wait -WindowStyle Hidden
            if (Test-Path -LiteralPath $cliFile) { $sr = [IO.File]::ReadAllText($cliFile) }
            $manifest.verify.status = $sr.Trim()
        } catch {
            $manifest.verify.status = 'FAILED: ' + $_.Exception.Message
        }
        foreach ($k in @('daemon', 'cdp', 'processes', 'autostart', 'wd scripts')) {
            if ($sr -notmatch [regex]::Escape($k)) { Fail-Tray ('--status 输出缺字段：' + $k) 4 }
        }
        $manifest.verify.ok = $true
    } finally {
        $env:TEMP = $prevTemp
        $env:TMP = $prevTmp
        if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

$manifest.ok = $true
$manifest.exitCode = 0
Write-Manifest
if ($Json) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Json, ($manifest | ConvertTo-Json -Depth 6), $enc)
}
Write-Line ('构建清单：' + $ManifestPath)
exit 0
