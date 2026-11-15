# WorkDaddy 独立安装器 —— 公共函数（PowerShell 5.1 兼容，禁止使用 ?: / ?? / && ）
#
# 设计约束：
#   1. 只写 AppDir / DataDir / 桌面快捷方式三处，绝不触碰 WorkBuddy 官方安装目录与数据。
#   2. 所有对外输出用 [Console]::WriteLine，避免 5.1 在 CJK 控制台的宿主异常。
#   3. 失败一律给非零退出码，并把原因写进 -Json 报告，便于 CI 与被调用方解析。
$ErrorActionPreference = 'Stop'

# 环境自愈（防御性，不是已确认的根因）：
# CI 上观测到安装脚本在「算安装记录」那一步静默死掉，痕迹里写着
#   CommandNotFoundException: The term 'Get-FileHash' is not recognized
# 那个子进程是 Inno 起的，父进程是 pwsh 7。本机试过把 PSModulePath 指向
# pwsh 7 的模块目录或指向空目录，Get-FileHash 都还在，所以机制没能完全复现。
# 两手都做：Get-Sha256 不再依赖这个 cmdlet（见下），同时把 $PSHOME\Modules
# 补回模块搜索路径第一位 —— 后者对上面那类「5.1 找不到自己的模块」是有用的。
$psHomeModules = Join-Path $PSHOME 'Modules'
if ($env:PSModulePath -notlike ('*' + $psHomeModules + '*')) {
    if ($env:PSModulePath) { $env:PSModulePath = $psHomeModules + ';' + $env:PSModulePath }
    else { $env:PSModulePath = $psHomeModules }
}

function Write-Line {
    param([object]$Message)
    [Console]::WriteLine([string]$Message)
}

function Get-Sha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    # 用 .NET 直接算，不走 Get-FileHash：
    #   * 少一个模块依赖（见上面的 PSModulePath 说明）；
    #   * FileShare 放宽到 ReadWrite，别的进程正开着这个文件也能算；
    #   * 逐块读，大文件不会一次性进内存。
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try { return ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLowerInvariant() }
        finally { $fs.Dispose() }
    } catch {
        return ''
    } finally {
        $sha.Dispose()
    }
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
# 'dist' 必须在排除列表里：release\dist 是打包器的输出目录。
# 不排除的后果是「把上一次的产物打进这一次的包」——包体凭空变大，
# 而且包里会带一份过期的 SHA256SUMS.txt，哈希对不上自己。
$script:ExcludeNames = @('.git', '.github', 'node_modules', 'test', 'tools', 'docs', 'tmp', '__pycache__', 'dist')

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

# 卸载时只删「安装时自己建的那条快捷方式」。
#
# install-state.json 是本地 JSON，可以被改成任意路径 —— 只要路径存在就
# Remove-Item，等于把一个任意文件删除交给了这份记录。所以要求三件事同时成立：
#   1. 确实是一个 .lnk 普通文件（不是目录、不是重解析点）；
#   2. 位置在桌面或开始菜单（用户能自己建快捷方式的地方之外不认）；
#   3. 目标指向本次安装目录内的启动器（直接指向，或 wscript 带 AppDir 参数）。
# 返回空字符串表示可以删；否则返回人类可读的拒绝理由。
function Test-WorkDaddyShortcut {
    param([string]$Path, [string]$AppDir, [string[]]$ExtraRoots = @())
    $raw = [string]$Path
    if ([string]::IsNullOrWhiteSpace($raw)) { return '快捷方式路径为空' }
    if ($raw.Contains('..')) { return '快捷方式路径含 ..：' + $raw }
    if (-not [IO.Path]::IsPathRooted($raw)) { return '快捷方式路径不是绝对路径：' + $raw }
    try { $full = [IO.Path]::GetFullPath($raw) } catch { return '快捷方式路径不合法：' + $raw }
    if ([IO.Path]::GetExtension($full) -ine '.lnk') { return '不是 .lnk 文件：' + $full }
    if (-not (Test-Path -LiteralPath $full)) { return '快捷方式不存在：' + $full }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer) { return '目标是目录，不是快捷方式：' + $full }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return '快捷方式本身是重解析点：' + $full }

    # 位置白名单。用户可以在任何地方放 WorkDaddy.lnk，但不是我们建的就不归我们删。
    $roots = @()
    foreach ($r in @(Get-DesktopDir) + @($ExtraRoots) +
            @([Environment]::GetFolderPath('Programs')) +
            @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu'))) {
        if (-not $r) { continue }
        try { $roots += ([IO.Path]::GetFullPath([string]$r).TrimEnd('\') + '\') } catch { }
    }
    $inAllowed = $false
    foreach ($r in $roots) {
        if ($full.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)) { $inAllowed = $true; break }
    }
    if (-not $inAllowed) { return '快捷方式不在桌面或开始菜单内：' + $full }

    # 目标必须落在本次安装目录内，否则这就是指向别处的快捷方式。
    $appFull = ''
    try { $appFull = [IO.Path]::GetFullPath([string]$AppDir).TrimEnd('\') } catch { return '安装目录不合法，无法校验快捷方式归属' }
    if (-not $appFull) { return '安装目录为空，无法校验快捷方式归属' }
    $appPrefix = $appFull + '\'
    try {
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($full)
        $target = [string]$sc.TargetPath
        $arguments = [string]$sc.Arguments
    } catch {
        return '无法读取快捷方式目标：' + $_.Exception.Message
    }
    if ([string]::IsNullOrWhiteSpace($target)) { return '快捷方式没有目标：' + $full }
    try { $targetFull = [IO.Path]::GetFullPath($target) } catch { return '快捷方式目标不合法：' + $target }
    if ($targetFull.StartsWith($appPrefix, [StringComparison]::OrdinalIgnoreCase)) { return '' }

    # 安装器常把目标设成 wscript.exe + AppDir 内的 vbs；这种情况看参数。
    $targetName = [IO.Path]::GetFileName($targetFull)
    if ($targetName -ieq 'wscript.exe' -and $arguments) {
        $unquoted = $arguments.Replace('"', '')
        if ($unquoted.IndexOf($appPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return '' }
    }
    return ('快捷方式指向的不是本次安装（目标=' + $targetFull + '）')
}

function Write-Report {
    param([object]$Report, [string]$JsonPath)
    if ($JsonPath) {
        Write-JsonFile -Path $JsonPath -Value $Report
        Write-Line ('报告: ' + $JsonPath)
    }
}

# ---- 路径安全边界 ----
# 卸载器/安装器会按记录删文件，记录本身是本地 JSON，可能被改过、也可能被
# junction 指向别处。只比较字符串前缀（StartsWith）挡不住这些情况：
#   C:\Users\me\AppData\Roaming\WorkDaddy\..\.. 归一后就跑出去了；
#   AppDir 若是 junction，删的其实是它指向的目录。
# 这里统一做三件事：归一化、拒绝受保护目录、展开重解析点后再判一次。

function Get-RealPathForSafety {
    param([string]$Path)
    try { $full = [IO.Path]::GetFullPath($Path) } catch { return '' }
    $root = [IO.Path]::GetPathRoot($full)
    if (-not $root) { return $full.TrimEnd('\') }
    $parts = @($full.Substring($root.Length).Split('\') | Where-Object { $_ })
    $cur = $root
    foreach ($part in $parts) {
        $cur = Join-Path $cur $part
        try {
            $item = Get-Item -LiteralPath $cur -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                $target = $item.Target
                if ($target -is [array]) { $target = $target[0] }
                if ($target) {
                    if (-not [IO.Path]::IsPathRooted([string]$target)) {
                        $target = Join-Path (Split-Path -Parent $cur) ([string]$target)
                    }
                    $cur = [IO.Path]::GetFullPath([string]$target)
                }
            }
        } catch { }
    }
    return $cur.TrimEnd('\')
}

# 返回空字符串表示可以操作；否则返回人类可读的拒绝理由。
function Test-SafeRootDir {
    param([string]$Path, [string]$Label = '目录')
    $raw = [string]$Path
    if ([string]::IsNullOrWhiteSpace($raw)) { return ($Label + ' 为空') }
    if ($raw.Contains('..')) { return ($Label + ' 含 .. 路径穿越：' + $raw) }
    if (-not [IO.Path]::IsPathRooted($raw)) { return ($Label + ' 不是绝对路径：' + $raw) }
    try { $full = [IO.Path]::GetFullPath($raw).TrimEnd('\') } catch { return ($Label + ' 不是合法路径：' + $raw) }
    if ($full -match '^[A-Za-z]:$') { return ($Label + ' 是盘根：' + $full) }
    if ($full.Length -lt 4) { return ($Label + ' 层级过浅，拒绝操作：' + $full) }

    # APPDATA / LOCALAPPDATA 的父目录本身就是「用户档案目录」，删它等于毁环境；
    # 用户主目录、Program Files、Windows、ProgramData 同理。
    $protected = @()
    foreach ($name in @('WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramData', 'ProgramFiles')) {
        $v = [Environment]::GetEnvironmentVariable($name)
        if ($v) { $protected += [IO.Path]::GetFullPath($v).TrimEnd('\') }
    }
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($pf86) { $protected += [IO.Path]::GetFullPath($pf86).TrimEnd('\') }
    $appdataParent = Split-Path -Parent ([IO.Path]::GetFullPath($env:APPDATA).TrimEnd('\'))
    if ($appdataParent) { $protected += $appdataParent.TrimEnd('\') }
    $localParent = Split-Path -Parent ([IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\'))
    if ($localParent) { $protected += $localParent.TrimEnd('\') }

    foreach ($p in $protected) {
        if ($p -and $full -eq $p) { return ($Label + ' 指向受保护目录本身，拒绝：' + $full) }
    }

    # 展开重解析点后再判一次：用 junction 把 AppDir 指到受保护目录的情况要挡住
    $real = Get-RealPathForSafety $full
    if ($real -and $real -ne $full) {
        if ($real -match '^[A-Za-z]:$') { return ($Label + ' 经重解析点指向盘根，拒绝：' + $real) }
        foreach ($p in $protected) {
            if ($p -and $real -eq $p) { return ($Label + ' 经重解析点指向受保护目录，拒绝：' + $real) }
        }
    }
    return ''
}

# AppDir 与 DataDir 不能互相包含：卸载时按清单删 AppDir，
# 若 DataDir 在其内部，用户数据会被一起删掉，而状态又写着「数据已保留」。
function Test-DirOverlap {
    param([string]$A, [string]$B)
    if (-not $A -or -not $B) { return '' }
    $a = [IO.Path]::GetFullPath($A).TrimEnd('\')
    $b = [IO.Path]::GetFullPath($B).TrimEnd('\')
    $cmp = [StringComparison]::OrdinalIgnoreCase
    if ($a.Equals($b, $cmp)) { return 'AppDir 与 DataDir 是同一个目录' }
    if ($a.StartsWith($b + '\', $cmp)) { return 'DataDir 包含 AppDir' }
    if ($b.StartsWith($a + '\', $cmp)) { return 'AppDir 包含 DataDir' }
    return ''
}

# ---- 本安装自己的进程 ----
# 以前调用方各写一份，且遇到 CommandLine 读不到就 continue —— 那等于把
# 「读不到」当成「不是我的进程」，于是替换文件时撞上正在运行的托盘/守护进程。
# 现在统一：要么给出确定的进程清单，要么明确失败，绝不静默忽略。

function Get-WorkDaddyProcesses {
    param([string]$AppDir)
    $result = [pscustomobject]@{ ok = $false; processes = @(); unreadable = @(); error = '' }
    if (-not $AppDir) { $result.error = 'AppDir 为空'; return $result }
    $d = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
    $patDaemon = [regex]::Escape($d + '\scripts\daemon.js')
    $patWatch  = [regex]::Escape($d + '\scripts\watchdog.js')
    $patTray   = [regex]::Escape($d + '\tray\WorkDaddyTray.exe')

    $rows = @()
    try {
        $rows = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'WorkDaddyTray.exe'" -ErrorAction Stop)
    } catch {
        $result.error = ('进程枚举失败：' + $_.Exception.Message + '；无法确认服务是否在运行，为避免替换到运行中的程序，已中止')
        return $result
    }

    $found = @()
    $unreadable = @()
    foreach ($p in $rows) {
        $cmd = [string]$p.CommandLine
        $exe = [string]$p.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($cmd) -and [string]::IsNullOrWhiteSpace($exe)) {
            # 名字对得上、身份读不到：可能是本安装的进程（也可能是别人的）。
            # 不猜，直接上报，让调用方 fail closed。
            $unreadable += [int]$p.ProcessId
            continue
        }
        $role = ''
        if ($cmd -match $patWatch) { $role = 'watchdog' }
        elseif ($cmd -match $patDaemon) { $role = 'daemon' }
        elseif ($cmd -match $patTray -or $exe -match $patTray) { $role = 'tray' }
        if ($role) { $found += [pscustomobject]@{ pid = [int]$p.ProcessId; role = $role } }
    }

    if ($unreadable.Count -gt 0) {
        $result.unreadable = $unreadable
        $result.error = ('有 ' + $unreadable.Count + ' 个同名进程读不到身份（PID=' + ($unreadable -join ',') +
            '）；无法确认它们是否属于本安装，为避免替换到运行中的程序，已中止')
        return $result
    }
    $result.ok = $true
    $result.processes = $found
    return $result
}

# 停止本安装的托盘 / watchdog / daemon，并等到文件句柄释放。
function Stop-WorkDaddyProcesses {
    param([string]$AppDir, [int]$WaitMs = 8000)
    $probe = Get-WorkDaddyProcesses -AppDir $AppDir
    if (-not $probe.ok) { return [pscustomobject]@{ ok = $false; stopped = @(); error = $probe.error } }

    $stopped = @()
    foreach ($p in $probe.processes) {
        try {
            Stop-Process -Id $p.pid -Force -ErrorAction Stop
            $stopped += $p.pid
        } catch { }
    }

    $deadline = (Get-Date).AddMilliseconds($WaitMs)
    while ((Get-Date) -lt $deadline) {
        $again = Get-WorkDaddyProcesses -AppDir $AppDir
        if (-not $again.ok) { return [pscustomobject]@{ ok = $false; stopped = $stopped; error = $again.error } }
        if ($again.processes.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    }

    $final = Get-WorkDaddyProcesses -AppDir $AppDir
    if (-not $final.ok) { return [pscustomobject]@{ ok = $false; stopped = $stopped; error = $final.error } }
    if ($final.processes.Count -gt 0) {
        $left = ($final.processes | ForEach-Object { $_.pid + '(' + $_.role + ')' }) -join ','
        return [pscustomobject]@{ ok = $false; stopped = $stopped; error = ('仍有进程未退出：' + $left) }
    }
    return [pscustomobject]@{ ok = $true; stopped = ($stopped | Sort-Object -Unique); error = '' }
}
