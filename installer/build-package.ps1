# WorkDaddy 打包器：便携版 ZIP / 源码包 /（可选）Setup
#
# 只做「把已经验证过的东西装进压缩包」，不编译原生代码、不改版本号、不发布。
# 发布动作（打 tag、建 Release、上传）属于人工流程，见 docs/upstream-tracking.md。
#
# 产物（默认 release\dist\）：
#   WorkDaddy-<版本>-portable-win-x64.zip   解压即用；内含 installer\ 可装到本机
#   WorkDaddy-<版本>-source.zip             当前提交的完整源码
#   SHA256SUMS.txt                          上面两个包的哈希
#   WorkDaddy-<版本>-setup.exe              仅在 -Setup 且找到 ISCC.exe 时产出
#
# 退出码：0 成功 / 1 源目录或参数问题 / 2 打包失败 / 3 Setup 编译失败
param(
    [string]$Version = '',
    [string]$OutputDirectory = '',
    [switch]$Setup,
    [string]$IsccPath = '',
    [string]$Json = ''
)

$ErrorActionPreference = 'Stop'
# Compress-Archive 在 5.1 下会往控制台刷进度条，一个包几千行。必须关掉。
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

$repoRoot = Split-Path -Parent $here
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'release\dist' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)

$report = [ordered]@{
    schema    = 1
    action    = 'package'
    ok        = $false
    version   = ''
    sourceCommit = ''
    dirty     = $false
    outDir    = $OutputDirectory
    artifacts = @()
    setup     = 'not-requested'
    warnings  = @()
    error     = ''
    exitCode  = 0
}

function Fail-Package {
    param([string]$Message, [int]$Code)
    $report.error = $Message
    $report.exitCode = $Code
    Write-Line ('错误：' + $Message)
    Write-Report -Report $report -JsonPath $Json
    exit $Code
}

Write-Line '=============================================================='
Write-Line ' WorkDaddy 打包'
Write-Line '=============================================================='

if (-not $Version) { $Version = Get-SourceVersion $repoRoot }
if (-not $Version) { Fail-Package '读不到 scripts\daemon.js 里的 DAEMON_VERSION，请用 -Version 指定' 1 }
if ($Version -notmatch '^\d+\.\d+\.\d+') { Fail-Package ('版本号格式不对：' + $Version) 1 }
$report.version = $Version

# 打包时额外排除：这些都是「本机才知道的东西」，进包就是泄露
$packageExclude = @('workbuddy-exe.json')

$files = @()
foreach ($rel in (Get-InstallFileList $repoRoot)) {
    $name = Split-Path -Leaf $rel
    if ($packageExclude -contains $name) { continue }
    $files += $rel
}
if ($files.Count -lt 20) { Fail-Package ('安装清单异常（' + $files.Count + ' 个文件）') 1 }

$stage = Join-Path $env:TEMP ('workdaddy-pkg-' + $Version + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
try {
    Write-Line ('暂存目录：' + $stage)
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-InstallFiles -SourceDir $repoRoot -AppDir $stage -Files $files

    # 安装器一起进包：解压后可以直接 install-workdaddy.ps1 装到本机
    $instDst = Join-Path $stage 'installer'
    New-Item -ItemType Directory -Force -Path $instDst | Out-Null
    Copy-Item -Path (Join-Path $here '*') -Destination $instDst -Recurse -Force

    $installNote = @(
        'WorkDaddy 便携版 ' + $Version,
        '',
        '一、直接运行（不改动本机任何目录）',
        '   双击 scripts\launcher.cmd',
        '',
        '二、安装到本机（推荐，可更新可卸载）',
        '   powershell -ExecutionPolicy Bypass -File installer\install-workdaddy.ps1',
        '   默认装到 %LOCALAPPDATA%\Programs\WorkDaddy，数据在 %APPDATA%\WorkDaddy',
        '',
        '三、卸载',
        '   powershell -ExecutionPolicy Bypass -File installer\uninstall-workdaddy.ps1',
        '',
        '本包是个人改版（fork），与 WorkBuddy 官方客户端不是同一产品：',
        '它通过 CDP 与本机已安装的 WorkBuddy 交互，不修改客户端安装目录。',
        '许可证：AGPL-3.0（见 LICENSE）。'
    ) -join "`r`n"
    $noteEnc = New-Object System.Text.UTF8Encoding($true)
    [IO.File]::WriteAllText((Join-Path $stage '安装说明.txt'), $installNote, $noteEnc)

    if (-not (Test-Path -LiteralPath $OutputDirectory)) { New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null }

    $portable = Join-Path $OutputDirectory ('WorkDaddy-' + $Version + '-portable-win-x64.zip')
    if (Test-Path -LiteralPath $portable) { Remove-Item -LiteralPath $portable -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $portable -CompressionLevel Optimal
    if (-not (Test-Path -LiteralPath $portable)) { Fail-Package '便携包没有生成' 2 }
} catch {
    Fail-Package ('打包失败：' + $_.Exception.Message) 2
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---- 源码包：用 git archive，保证和提交一致 ----
$sourceZip = Join-Path $OutputDirectory ('WorkDaddy-' + $Version + '-source.zip')
$commit = ''
$dirty = $false
try {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $commit = ((& git -C $repoRoot rev-parse HEAD) 2>&1 | Out-String).Trim()
    $status = ((& git -C $repoRoot status --porcelain) 2>&1 | Out-String).Trim()
    $ErrorActionPreference = $prevEap
    $dirty = [bool]$status
} catch { $dirty = $false }
$report.sourceCommit = $commit
$report.dirty = $dirty
if ($dirty) { $report.warnings += '工作区有未提交改动：源码包内容来自最后一次提交，不包含这些改动' }

if (Test-Path -LiteralPath $sourceZip) { Remove-Item -LiteralPath $sourceZip -Force }
# 参数要拼成单个字符串再传：`--prefix=(表达式)` 在 5.1 下不会被求值，会原样交给 git
$prefixArg = '--prefix=WorkDaddy-' + $Version + '-source/'
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& git -C $repoRoot archive --format=zip $prefixArg -o $sourceZip HEAD 2>&1 | Out-Null
$gitCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($gitCode -ne 0 -or -not (Test-Path -LiteralPath $sourceZip)) { Fail-Package ('源码包生成失败（git archive，退出码 ' + $gitCode + '）') 2 }

# ---- 哈希清单 ----
$lines = @()
foreach ($p in @($portable, $sourceZip)) {
    $h = Get-Sha256 $p
    $size = (Get-Item -LiteralPath $p).Length
    $report.artifacts += [pscustomobject]@{ path = (Split-Path -Leaf $p); sha256 = $h; size = $size }
    $lines += ($h + '  ' + (Split-Path -Leaf $p))
}
$sums = Join-Path $OutputDirectory 'SHA256SUMS.txt'
$enc = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($sums, (($lines -join "`r`n") + "`r`n"), $enc)
$report.artifacts += [pscustomobject]@{ path = 'SHA256SUMS.txt'; sha256 = (Get-Sha256 $sums); size = (Get-Item -LiteralPath $sums).Length }

# ---- 可选：编译 Setup ----
if ($Setup) {
    $iscc = $IsccPath
    if (-not $iscc) {
        foreach ($c in @(
                (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
                (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'))) {
            if ($c -and (Test-Path -LiteralPath $c)) { $iscc = $c; break }
        }
    }
    if (-not $iscc -or -not (Test-Path -LiteralPath $iscc)) {
        # 没有 ISCC 不算失败：便携包与源码包已经是可用产物
        $report.setup = 'skipped-no-iscc'
        $report.warnings += '未找到 ISCC.exe（Inno Setup 6），跳过 Setup 编译；便携包与源码包不受影响'
        Write-Line $report.warnings[-1]
    } else {
        $iss = Join-Path $here 'setup\workdaddy.iss'
        if (-not (Test-Path -LiteralPath $iss)) { Fail-Package ('缺 Setup 脚本：' + $iss) 3 }
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & $iscc ('/DAppVersion=' + $Version) ('/DRepoRoot=' + $repoRoot) ('/DOutDir=' + $OutputDirectory) $iss 2>&1 | ForEach-Object { Write-Line $_ }
        $isccCode = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        if ($isccCode -ne 0) {
            $report.setup = 'failed'
            Fail-Package ('Setup 编译失败（ISCC 退出码 ' + $isccCode + '）') 3
        }
        $setupExe = Join-Path $OutputDirectory ('WorkDaddy-' + $Version + '-setup.exe')
        if (-not (Test-Path -LiteralPath $setupExe)) { $report.setup = 'failed'; Fail-Package 'ISCC 成功但没找到 setup.exe' 3 }
        $h = Get-Sha256 $setupExe
        $report.artifacts += [pscustomobject]@{ path = (Split-Path -Leaf $setupExe); sha256 = $h; size = (Get-Item -LiteralPath $setupExe).Length }
        [IO.File]::AppendAllText($sums, ($h + '  ' + (Split-Path -Leaf $setupExe) + "`r`n"), $enc)
        $report.setup = 'built'
    }
}

$report.ok = $true
Write-Line ''
foreach ($a in $report.artifacts) { Write-Line ('  ' + $a.path + '  ' + $a.size + ' 字节  ' + $a.sha256) }
Write-Line ('输出目录：' + $OutputDirectory)
foreach ($w in $report.warnings) { Write-Line ('提示：' + $w) }
Write-Report -Report $report -JsonPath $Json
exit 0
