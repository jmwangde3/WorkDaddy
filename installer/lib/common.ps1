# WorkDaddy 独立安装器 —— 公共函数（PowerShell 5.1 兼容，禁止使用 ?: / ?? / && ）
#
# 设计约束：
#   1. 只写 AppDir / DataDir / 桌面快捷方式三处，绝不触碰 WorkBuddy 官方安装目录与数据。
#   2. 所有对外输出用 [Console]::WriteLine，避免 5.1 在 CJK 控制台的宿主异常。
#   3. 失败一律给非零退出码，并把原因写进 -Json 报告，便于 CI 与被调用方解析。
$ErrorActionPreference = 'Stop'

function Write-Line {
    param([object]$Message)
    [Console]::WriteLine([string]$Message)
}

function Get-Sha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Write-JsonFile {
    param([string]$Path, [object]$Value)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $json = $Value | ConvertTo-Json -Depth 8
    # 5.1 的 Out-File 默认 UTF-16 且带 BOM；这里明确写 UTF-8 无 BOM，
    # 让 Node 侧 JSON.parse 不用处理 BOM。
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $json, $enc)
}

function Get-SourceVersion {
    param([string]$SourceDir)
    $daemon = Join-Path $SourceDir 'scripts\daemon.js'
    if (-not (Test-Path -LiteralPath $daemon)) { return $null }
    $text = Get-Content -LiteralPath $daemon -Raw -Encoding UTF8
    $m = [regex]::Match($text, "const DAEMON_VERSION = '([^']+)'")
    if (-not $m.Success) { return $null }
    return $m.Groups[1].Value
}

function Test-SafeTargetDir {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full -match '^[A-Za-z]:$') { return '拒绝安装到盘根目录' }
    $win = [IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\')
    if ($full.StartsWith($win + '\', [StringComparison]::OrdinalIgnoreCase)) { return '拒绝安装到 Windows 目录' }
    if ($full.StartsWith($win, [StringComparison]::OrdinalIgnoreCase)) { return '拒绝安装到 Windows 目录' }
    return ''
}

function Get-DirSizeMb {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if (-not $sum) { return 0 }
    return [math]::Round($sum / 1MB, 1)
}

function Get-FreeSpaceMb {
    param([string]$Path)
    $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path))
    try {
        $d = New-Object System.IO.DriveInfo($root)
        return [math]::Round($d.AvailableFreeSpace / 1MB, 1)
    } catch {
        return -1
    }
}

# 安装清单：只带运行时需要的目录与文件，不带开发/CI/迁移资产。
$script:IncludeDirs = @('scripts', 'src', 'schemas', 'examples', 'release', 'tray')
$script:IncludeFiles = @('LICENSE', 'README.md', 'README_en.md', 'README_ja.md', 'package.json')
$script:ExcludeNames = @('.git', '.github', 'node_modules', 'test', 'tools', 'docs', 'tmp', '__pycache__')

function Get-InstallFileList {
    param([string]$SourceDir)
    $files = @()
    foreach ($f in $script:IncludeFiles) {
        $p = Join-Path $SourceDir $f
        if (Test-Path -LiteralPath $p) { $files += $f }
    }
    foreach ($d in $script:IncludeDirs) {
        $root = Join-Path $SourceDir $d
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -File) {
            $rel = $item.FullName.Substring($SourceDir.Length).TrimStart('\')
            $skip = $false
            foreach ($part in $rel.Split('\')) {
                if ($script:ExcludeNames -contains $part) { $skip = $true; break }
            }
            if ($rel -match '\.log$') { $skip = $true }
            if (-not $skip) { $files += $rel }
        }
    }
    return $files
}

function Copy-InstallFiles {
    param([string]$SourceDir, [string]$AppDir, [string[]]$Files)
    foreach ($rel in $Files) {
        $src = Join-Path $SourceDir $rel
        $dst = Join-Path $AppDir $rel
        $dstDir = Split-Path -Parent $dst
        if ($dstDir -and -not (Test-Path -LiteralPath $dstDir)) {
            New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
        }
        Copy-Item -LiteralPath $src -Destination $dst -Force
    }
}

function Get-InstalledFileTable {
    param([string]$AppDir, [string[]]$Files)
    $rows = @()
    foreach ($rel in $Files) {
        $p = Join-Path $AppDir $rel
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $rows += [pscustomobject]@{ path = $rel; sha256 = (Get-Sha256 $p); size = (Get-Item -LiteralPath $p).Length }
    }
    return $rows
}

function Remove-EmptyDirs {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $dirs = Get-ChildItem -LiteralPath $Root -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending
    foreach ($d in $dirs) {
        $count = (Get-ChildItem -LiteralPath $d.FullName -Force | Measure-Object).Count
        if ($count -eq 0) { Remove-Item -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue }
    }
}

function New-Shortcut {
    param([string]$LnkPath, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$IconPath)
    try {
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($LnkPath)
        $sc.TargetPath = $Target
        if ($Arguments) { $sc.Arguments = $Arguments }
        if ($WorkDir) { $sc.WorkingDirectory = $WorkDir }
        if ($IconPath -and (Test-Path -LiteralPath $IconPath)) { $sc.IconLocation = $IconPath }
        $sc.Save()
        return $true
    } catch {
        return $false
    }
}

function Get-DesktopDir {
    # 只认当前用户的桌面，不写公共桌面（那需要管理员权限）。
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ($desktop -and (Test-Path -LiteralPath $desktop)) { return $desktop }
    return ''
}

function Write-Report {
    param([object]$Report, [string]$JsonPath)
    if ($JsonPath) {
        Write-JsonFile -Path $JsonPath -Value $Report
        Write-Line ('报告: ' + $JsonPath)
    }
}
