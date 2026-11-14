#requires -Version 5.1
<#
    CI 用：PowerShell 脚本语法 / 编码 / 行尾检查。

    在 PowerShell 5.1 与 7.x 下都必须能跑，因此只使用两者共有的语法。
    不依赖任何模块，不联网，不写文件。

    退出码：0 = 全部通过；1 = 有问题。
#>
[CmdletBinding()]
param(
    [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

# 让中文在 GitHub Actions 日志里正常显示（5.1 默认按控制台代码页输出）。
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    # 某些宿主不允许改，忽略即可
}

$root = (Resolve-Path -LiteralPath $Root).Path
$skip = 'node_modules|\.git'

function Get-TargetFiles {
    param([string]$Pattern)
    @(Get-ChildItem -LiteralPath $root -Filter $Pattern -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch "[\\/]($skip)[\\/]" })
}

$psFiles  = Get-TargetFiles '*.ps1'
$cmdFiles = Get-TargetFiles '*.cmd'

Write-Host ("PowerShell {0} | 根目录 {1}" -f $PSVersionTable.PSVersion.ToString(), $root)
Write-Host ("待检: {0} 个 .ps1, {1} 个 .cmd" -f $psFiles.Count, $cmdFiles.Count)

$issues = 0
$version = $PSVersionTable.PSVersion

# ---- 1. 语法解析 ----
foreach ($f in $psFiles) {
    $tokens = $null
    $errs = $null
    try {
        [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
    } catch {
        $issues++
        Write-Host ("::error file={0}::{1}" -f $f.FullName, $_.Exception.Message)
        continue
    }
    if ($errs -and $errs.Count -gt 0) {
        $issues++
        foreach ($e in $errs) {
            Write-Host ("::error file={0},line={1}::{2}" -f $f.FullName, $e.Extent.StartLineNumber, $e.Message)
        }
    }
}
Write-Host ("[1/3] 语法解析完成，累计问题 {0}" -f $issues)

# ---- 2. 含非 ASCII 的 .ps1 必须带 UTF-8 BOM ----
# 纯 ASCII 脚本不需要 BOM；含中文的必须带，否则 PowerShell 5.1 按 ANSI(936) 解读会乱码。
foreach ($f in $psFiles) {
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $hasNonAscii = $false
    foreach ($b in $bytes) {
        if ($b -gt 127) { $hasNonAscii = $true; break }
    }
    if ($hasNonAscii -and -not $hasBom) {
        $issues++
        Write-Host ("::error file={0}::缺少 UTF-8 BOM（PowerShell 5.1 下中文会乱码）" -f $f.FullName)
    }
}
Write-Host ("[2/3] BOM 检查完成，累计问题 {0}" -f $issues)

# ---- 3. .cmd 必须使用 CRLF ----
# 裸 LF 在 cmd.exe 下会让 goto / for / 多行 if 出问题。
foreach ($f in $cmdFiles) {
    $text = [System.IO.File]::ReadAllText($f.FullName)
    $lone = [regex]::Matches($text, "(?<!`r)`n").Count
    if ($lone -gt 0) {
        $issues++
        Write-Host ("::error file={0}::有 {1} 处裸 LF（.cmd 需要 CRLF）" -f $f.FullName, $lone)
    }
}
Write-Host ("[3/3] CRLF 检查完成，累计问题 {0}" -f $issues)

if ($issues -gt 0) {
    Write-Host ("检查失败：{0} 个问题（PowerShell {1}）" -f $issues, $version)
    exit 1
}

Write-Host ("检查通过：{0} 个 .ps1, {1} 个 .cmd（PowerShell {2}）" -f $psFiles.Count, $cmdFiles.Count, $version)
exit 0
