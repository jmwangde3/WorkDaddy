<#
    WorkDaddy 补丁一键部署 / 升级后恢复

    作用：把本仓库 scripts 目录下的 12 个补丁文件复制到已安装的 WorkDaddy，
          重新绑定面板按钮，并重启后台服务。

    幂等：可以反复运行，不会重复堆积。
    安全：覆盖前自动备份到 %APPDATA%\WorkDaddy\script-backups\<时间戳>\

    用法：
        .\deploy.ps1              正常部署
        .\deploy.ps1 -NoRestart   只铺文件，不动正在运行的服务
        .\deploy.ps1 -TargetDir "D:\xxx\WorkDaddy\scripts"   指定安装目录
#>
param(
    [switch]$NoRestart,
    [string]$TargetDir
)

$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'

function Say($text, $color) {
    if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}
function Head($text) { Say ''; Say "---- $text" 'Cyan' }

Say ''
Say '==============================================' 'Cyan'
Say '   WorkDaddy 补丁部署' 'Cyan'
Say '==============================================' 'Cyan'

# ---------------------------------------------------------------- 1. 定位安装目录
Head '1/6 查找 WorkDaddy 安装目录'

$dst = $null
if ($TargetDir) {
    $dst = $TargetDir
} else {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy\scripts'),
        (Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy AI\scripts')
    )
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c 'daemon.js')) { $dst = $c; break }
    }
}

if (-not $dst -or -not (Test-Path (Join-Path $dst 'daemon.js'))) {
    Say '[X] 没找到 WorkDaddy 安装目录。' 'Red'
    Say ''
    Say '    请先安装上游 WorkDaddy（不是本仓库）：'
    Say '      https://github.com/babygoton/workdaddy/releases'
    Say '    装完再回来跑这个脚本。'
    Say ''
    Say '    如果装在了别处，用 -TargetDir 指定：'
    Say '      .\deploy.ps1 -TargetDir "D:\你的路径\WorkDaddy\scripts"'
    exit 1
}
Say "    安装目录: $dst" 'Green'

$src = Join-Path $PSScriptRoot 'scripts'
if (-not (Test-Path (Join-Path $src 'daemon.js'))) {
    Say "[X] 仓库里的 scripts 目录找不到: $src" 'Red'
    Say '    请确认 deploy.ps1 和 scripts 文件夹在同一个目录下。'
    exit 1
}
Say "    补丁来源: $src" 'Green'

# ---------------------------------------------------------------- 2. 清单
Head '2/6 校验补丁清单'

$newFiles = @(
    'rehome-sessions.js', 'rehome-watcher.js', 'rehome-audit.js', 'permission-sync.js', 'rehome_sessions.py',
    'bind-rehome-ui.py', 'fix-cdp.cmd', 'setup-rehome.ps1', 'stop-workdaddy.ps1'
)
$patchedFiles = @(
    'daemon.js', 'inject.js', 'lib.js', 'win-launcher.js', 'workbuddy-exe.json'
)
$all = $newFiles + $patchedFiles

$missing = @()
foreach ($f in $all) {
    if (-not (Test-Path (Join-Path $src $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
    Say '[X] 仓库里缺少这些文件，无法继续：' 'Red'
    foreach ($m in $missing) { Say "      $m" 'Red' }
    exit 1
}
Say ("    新增文件 {0} 个 + 上游改版 {1} 个 = 共 {2} 个" -f $newFiles.Count, $patchedFiles.Count, $all.Count) 'Green'

# ---------------------------------------------------------------- 3. 备份
Head '3/6 备份将被覆盖的文件'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $env:APPDATA "WorkDaddy\script-backups\deploy-$stamp"
New-Item -ItemType Directory -Path $bak -Force | Out-Null

$backedUp = 0
foreach ($f in $all) {
    $target = Join-Path $dst $f
    if (Test-Path $target) {
        Copy-Item $target (Join-Path $bak $f) -Force
        $backedUp++
    }
}
Say "    已备份 $backedUp 个已有文件 -> $bak" 'Green'

# ---------------------------------------------------------------- 4. 复制
Head '4/6 复制补丁文件'

$copied = 0
foreach ($f in $all) {
    Copy-Item (Join-Path $src $f) (Join-Path $dst $f) -Force
    $copied++
}
Say "    已复制 $copied 个文件" 'Green'

# workbuddy-exe.json 是本机专用配置，检查它指向的客户端是否真实存在
$exeCfg = Join-Path $dst 'workbuddy-exe.json'
if (Test-Path $exeCfg) {
    try {
        $cfg = Get-Content $exeCfg -Raw -Encoding UTF8 | ConvertFrom-Json
        $exePath = $null
        foreach ($prop in $cfg.PSObject.Properties) {
            if ($prop.Value -is [string] -and $prop.Value -match '\.exe$') { $exePath = $prop.Value; break }
        }
        if ($exePath) {
            if (Test-Path $exePath) {
                Say "    客户端路径 OK: $exePath" 'Green'
            } else {
                Say '[!] 客户端路径不存在，需要改：' 'Yellow'
                Say "      $exePath" 'Yellow'
                Say "      编辑 $exeCfg" 'Yellow'
                Say '      把路径改成你电脑上 WorkBuddy.exe 的实际位置。' 'Yellow'
            }
        }
    } catch {
        Say '    (workbuddy-exe.json 读取失败，跳过检查)' 'Yellow'
    }
}

# ---------------------------------------------------------------- 5. 绑定面板 UI
Head '5/6 绑定面板按钮'

$pyExe = $null
foreach ($name in @('py', 'python')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $pyExe = $cmd.Source; break }
}

if (-not $pyExe) {
    Say '[!] 没找到 Python，跳过这一步。' 'Yellow'
    Say '    影响：面板上的按钮文案还是上游原版（叫「自动同步所有会话」）。' 'Yellow'
    Say '    功能本身不受影响，接管照常工作。' 'Yellow'
    Say '    想修正就装个 Python 再跑一次本脚本。' 'Yellow'
} else {
    Say "    使用 Python: $pyExe" 'Green'
    & $pyExe (Join-Path $dst 'bind-rehome-ui.py')
    if ($LASTEXITCODE -eq 0) {
        Say '    面板按钮已绑定到接管模式' 'Green'
    } else {
        Say "[!] 绑定脚本返回 $LASTEXITCODE，面板文案可能没更新（功能不受影响）" 'Yellow'
    }
}

# ---------------------------------------------------------------- 6. 重启服务
Head '6/6 重启后台服务'

if ($NoRestart) {
    Say '    已按要求跳过重启（-NoRestart）' 'Yellow'
} else {
    $daemons = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -match 'WorkDaddy[\\/]scripts[\\/]daemon\.js'
    })

    if ($daemons.Count -eq 0) {
        Say '    后台服务当前没运行，不用重启。' 'Yellow'
        Say '    启动方式：双击托盘 exe，右键 -> 启动 WorkDaddy' 'Yellow'
    } else {
        foreach ($d in $daemons) {
            Say "    停止旧 daemon (pid=$($d.ProcessId))" 'Green'
            Stop-Process -Id $d.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Say '    等待 watchdog 自动拉起新 daemon...'
        $ok = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Seconds 1
            if (Get-NetTCPConnection -LocalPort 47832 -State Listen -ErrorAction SilentlyContinue) {
                $ok = $true; break
            }
        }
        if ($ok) {
            Say '    服务已恢复，端口 47832 在监听' 'Green'
        } else {
            Say '[!] 20 秒内没等到 47832 恢复。' 'Yellow'
            Say '    检查 %APPDATA%\WorkDaddy\daemon.log 末尾的报错。' 'Yellow'
        }
    }
}

# ---------------------------------------------------------------- 完成
Say ''
Say '==============================================' 'Cyan'
Say '   完成' 'Cyan'
Say '==============================================' 'Cyan'
Say ''
Say '下一步：'
Say '  1. 双击托盘 exe（仓库 tray\WorkDaddyTray.exe）'
Say '  2. 右键图标 -> 启动 WorkDaddy  （灰色圆点变绿）'
Say '  3. 需要右下角机器人按钮时，再点「恢复 CDP」'
Say ''
Say "出问题看日志：$env:APPDATA\WorkDaddy\daemon.log"
Say "想回滚：把 $bak 里的文件盖回去，再重启 daemon"
Say ''
