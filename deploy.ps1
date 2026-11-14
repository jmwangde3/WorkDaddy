<#
    WorkDaddy 补丁部署 / 升级后恢复（原子化版）

    流程：
      1. 定位安装目录，检查目录可写
      2. 校验补丁清单与源文件哈希
      3. 读取 scripts/upstream.json：
         a) 版本号闸门（默认 advisory，只提示；-StrictVersionGate 才阻断）
            —— 上游版本号只来自提交信息，不足以作为强制判断依据
         b) 文件代际闸门（硬，SHA-256 判定）：
            目标哈希 == 本补丁哈希            → already-patched，可覆盖
            目标哈希 == 上游 1.2.22 原版哈希  → pristine-upstream，默认中止
            两者都不等 / 缺上游哈希           → unknown-generation，默认中止
            只有 -Force 才能越过中止
            —— -Force 只管代际闸门，不顺手拆版本闸门（见 3a）
         c) 客户端版本区间（只在 upstream.json 明确声明区间时检查）
      4. 备份将被修改/新增的文件到 %APPDATA%\WorkDaddy\script-backups\deploy-<时间戳>\
      5. 先复制到临时目录并逐个校验哈希
      6. 全部通过后才替换；任一步失败自动回滚
      7. 生成部署报告 JSON

    本机专用配置 scripts\workbuddy-exe.json **永不覆盖**：
    目标已存在就保留；只有不存在时才从 example 生成一份并提示修改。

    幂等：可以反复运行。
    兼容：Windows PowerShell 5.1 与 PowerShell 7.x（不使用 7.x 专有语法）。

    用法：
        .\deploy.ps1                    正常部署
        .\deploy.ps1 -DryRun            只做预检并输出报告，不写任何文件
        .\deploy.ps1 -NoRestart         只铺文件，不动正在运行的服务
        .\deploy.ps1 -Force             越过文件代际闸门（谨慎，会覆盖未知代际的文件）
        .\deploy.ps1 -TargetDir "D:\xxx\WorkDaddy\scripts"
        .\deploy.ps1 -StrictVersionGate   版本号不匹配也中止（默认只提示）
        .\deploy.ps1 -ForceVersion        显式越过 -StrictVersionGate（与 -Force 分开，避免一次拆掉两道闸）
        .\deploy.ps1 -StrictFileGate      兼容旧参数；代际闸门现已默认硬拦，无需再加
#>
param(
    [switch]$NoRestart,
    [switch]$Force,
    [switch]$ForceVersion,
    [switch]$DryRun,
    [string]$TargetDir,
    [switch]$StrictVersionGate,
    [switch]$StrictFileGate
)

$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'

$script:FailStage = ''
$script:Report = [ordered]@{
    schema       = 1
    startedAt    = (Get-Date).ToString('o')
    dryRun       = [bool]$DryRun
    source       = $PSScriptRoot
    target       = ''
    forkVersion  = ''
    targetVersion= ''
    clientVersion= ''
    files        = @()
    backupDir    = ''
    ok           = $false
    stage        = 'init'
    error        = ''
}

function Say($text, $color) {
    if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}
function Head($text) { Say ''; Say "---- $text" 'Cyan' }
function Fail($stage, $message, $code) {
    $script:Report.stage = $stage
    $script:Report.ok = $false
    $script:Report.error = $message
    Say "[X] $message" 'Red'
    Exit $code
}

Say ''
Say '==============================================' 'Cyan'
Say '   WorkDaddy 补丁部署（原子化）' 'Cyan'
Say '==============================================' 'Cyan'
if ($DryRun) { Say '   模式: 预检（不写任何文件）' 'Yellow' }

# ---------------------------------------------------------------- 1. 定位安装目录
Head '1/7 查找 WorkDaddy 安装目录'

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
    Say ''
    Say '    如果装在了别处，用 -TargetDir 指定：'
    Say '      .\deploy.ps1 -TargetDir "D:\你的路径\WorkDaddy\scripts"'
    Fail 'locate' '安装目录不存在或缺少 daemon.js' 1
}
$script:Report.target = $dst
Say "    安装目录: $dst" 'Green'

if (-not $DryRun) {
    try {
        $probe = Join-Path $dst ('.wd-write-test-' + [guid]::NewGuid().ToString('N') + '.tmp')
        Set-Content -Path $probe -Value 'ok' -Encoding ASCII
        Remove-Item $probe -Force
        Say '    目录可写: 是' 'Green'
    } catch {
        Fail 'writable' "目标目录不可写: $($_.Exception.Message)" 1
    }
} else {
    Say '    目录可写: 预检模式跳过写入测试' 'Yellow'
}

$src = Join-Path $PSScriptRoot 'scripts'
if (-not (Test-Path (Join-Path $src 'daemon.js'))) {
    Fail 'source' "仓库里的 scripts 目录找不到: $src" 1
}
Say "    补丁来源: $src" 'Green'

# ---------------------------------------------------------------- 2. 清单与源哈希
Head '2/7 校验补丁清单与源文件'

$newFiles = @(
    'rehome-sessions.js', 'rehome-watcher.js', 'rehome-audit.js', 'session-dedupe.js',
    'session-scope.js', 'permission-sync.js', 'upstream.json', 'rehome_sessions.py',
    'bind-rehome-ui.py', 'fix-cdp.cmd', 'setup-rehome.ps1', 'stop-workdaddy.ps1'
)
$patchedFiles = @(
    'daemon.js', 'inject.js', 'lib.js', 'win-launcher.js'
)
$all = $newFiles + $patchedFiles

$missing = @()
foreach ($f in $all) {
    if (-not (Test-Path (Join-Path $src $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
    Say '[X] 仓库里缺少这些文件，无法继续：' 'Red'
    foreach ($m in $missing) { Say "      $m" 'Red' }
    Fail 'manifest' ('缺少文件: ' + ($missing -join ', ')) 1
}

$sourceHash = @{}
foreach ($f in $all) {
    $sourceHash[$f] = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $src $f)).Hash
    $script:Report.files += [ordered]@{ name = $f; sha256 = $sourceHash[$f]; action = '' }
}
Say ("    新增文件 {0} 个 + 上游改版 {1} 个 = 共 {2} 个" -f $newFiles.Count, $patchedFiles.Count, $all.Count) 'Green'

# ---------------------------------------------------------------- 3. 版本与代际
Head '3/7 检查上游元数据 / 文件代际'

# 元数据来源：默认读仓库里的 scripts/upstream.json。
# WORKDADDY_UPSTREAM_JSON 只给测试用（可以指向合成元数据），生产路径不允许改。
$upstreamPath = if ($env:WORKDADDY_UPSTREAM_JSON) { $env:WORKDADDY_UPSTREAM_JSON } else { Join-Path $src 'upstream.json' }
$up = $null
$forkVersion = ''
if (Test-Path $upstreamPath) {
    try {
        $up = Get-Content $upstreamPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($up.fork) { $forkVersion = [string]$up.fork.version }
        $script:Report.forkVersion = $forkVersion
        if ($up.upstream) {
            Say ("    上游: v{0} @ {1} ({2})  验证: {3}" -f $up.upstream.version, $up.upstream.commitShort, $up.upstream.commitDate, $up.upstream.verified) 'Green'
        }
        if ($up.fork) {
            Say ("    补丁: {0}   分叉基线: {1} ({2})" -f $forkVersion, $up.fork.baseCommitShort, $up.fork.baseKind) 'Green'
        }
        if ($up.versionGate) {
            Say ("    版本闸门: {0}  {1}" -f $up.versionGate.mode, $up.versionGate.reason) 'Yellow'
        }
    } catch {
        Say "    (upstream.json 读取失败: $($_.Exception.Message))" 'Yellow'
        $up = $null
    }
} else {
    Say '    (缺少 scripts/upstream.json，跳过上游元数据比对)' 'Yellow'
}

$targetDaemon = Join-Path $dst 'daemon.js'
$targetVersion = ''
try {
    $text = Get-Content $targetDaemon -Raw -Encoding UTF8
    $m = [regex]::Match($text, "DAEMON_VERSION\s*=\s*'([^']+)'")
    if ($m.Success) { $targetVersion = $m.Groups[1].Value }
} catch {
    Say "    (读取目标版本失败: $($_.Exception.Message))" 'Yellow'
}
$script:Report.targetVersion = $targetVersion
Say ("    目标版本: {0}" -f ($(if ($targetVersion) { $targetVersion } else { '(未知)' }))) 'Green'

# 3a) 版本号闸门：默认 advisory。
# 上游版本号只来自提交信息，且本 fork 与上游没有 git 祖先关系 —— 拿它硬拦部署
# 就是用不可靠元数据做破坏性判断。只有显式 -StrictVersionGate 才升级为阻断。
$versionAdvisory = $null
if ($targetVersion -and $forkVersion) {
    try {
        $tv = [version]$targetVersion
        $fv = [version]$forkVersion
        if ($tv -gt $fv) {
            $versionAdvisory = ("目标 daemon 版本 {0} 比补丁 {1} 新（覆盖可能降级）" -f $targetVersion, $forkVersion)
        }
    } catch {
        $versionAdvisory = ("版本号无法比较: {0} vs {1}" -f $targetVersion, $forkVersion)
    }
}
if ($versionAdvisory) {
    $script:Report.versionAdvisory = $versionAdvisory
    # 版本闸门与代际闸门各用各的开关：只要目标版本被改过，目标文件哈希必然不等于补丁哈希
    # （DAEMON_VERSION 就在文件头），也就必然要 -Force 才能过代际闸门。若两道闸共用
    # -Force，-StrictVersionGate 就永远不可能触发 —— 等于被代际闸门顺手拆掉。
    if ($StrictVersionGate -and -not $ForceVersion) {
        Fail 'version' ("{0}；-StrictVersionGate 已开启，故中止。确认继续请加 -ForceVersion（-Force 只越过代际闸门）。" -f $versionAdvisory) 2
    }
    Say ("    [!] {0}（advisory，不阻断；如需阻断加 -StrictVersionGate）" -f $versionAdvisory) 'Yellow'
}

# 3b) 文件代际闸门（硬）：依据是 **SHA-256**，不是字节数。
#     字节数只能说明「大小碰巧一样」，不能说明「内容是什么」。同大小不同内容的目标
#     文件在旧实现里会被判成 already-patched 然后被覆盖 —— 那是真的丢数据。
#     现在三种判定全部要求哈希相等：
#       目标哈希 == 本补丁哈希           → already-patched（可覆盖）
#       目标哈希 == 上游原版哈希         → pristine-upstream（默认中止）
#       其余（含缺上游哈希）             → unknown-generation（默认中止）
#     只有 -Force 能越过中止。
$generation = @()
$upHashes = $null
if ($up -and $up.deploy -and $up.deploy.upstreamFileHashes) { $upHashes = $up.deploy.upstreamFileHashes }
$localHashes = $null
if ($up -and $up.deploy -and $up.deploy.localFileHashes) { $localHashes = $up.deploy.localFileHashes }
foreach ($f in $patchedFiles) {
    $tf = Join-Path $dst $f
    if (-not (Test-Path $tf)) { continue }
    $targetItem = Get-Item $tf
    $targetHash = (Get-FileHash -Algorithm SHA256 -Path $tf).Hash
    $ourHash = [string]$sourceHash[$f]
    $upHash = ''
    if ($upHashes) {
        $prop = $upHashes.PSObject.Properties[$f]
        if ($prop -and $prop.Value -and $prop.Value.sha256) { $upHash = [string]$prop.Value.sha256 }
    }
    $recordedLocalHash = ''
    if ($localHashes) {
        $lp = $localHashes.PSObject.Properties[$f]
        if ($lp -and $lp.Value -and $lp.Value.sha256) { $recordedLocalHash = [string]$lp.Value.sha256 }
    }
    $kind = 'unknown-generation'
    $why = 'hash-matches-neither'
    if ($targetHash -eq $ourHash) { $kind = 'already-patched'; $why = 'hash-equals-patch' }
    elseif ($upHash -and $targetHash -eq $upHash) { $kind = 'pristine-upstream'; $why = 'hash-equals-upstream' }
    elseif (-not $upHash) { $why = 'no-upstream-hash-recorded' }
    $generation += [pscustomobject]@{
        name = $f; kind = $kind; why = $why
        targetSize = $targetItem.Length; patchSize = (Get-Item (Join-Path $src $f)).Length
        targetHash = $targetHash; patchHash = $ourHash; upstreamHash = $upHash
        recordedLocalHash = $recordedLocalHash
    }
}
$script:Report.generation = $generation

$pristine = @($generation | Where-Object { $_.kind -eq 'pristine-upstream' })
$unknownGen = @($generation | Where-Object { $_.kind -eq 'unknown-generation' })
if ($pristine.Count -gt 0) {
    $names = ($pristine | ForEach-Object { $_.name }) -join ', '
    if (-not $Force) {
        Fail 'file-generation' ("目标这些文件与上游 1.2.22 原版逐字节一致（SHA-256 相同），是没打过我们补丁的原版上游文件: {0}。直接覆盖会丢掉上游修复。确认要降级请加 -Force。" -f $names) 2
    }
    Say ("    [!] 目标为原版上游文件，已按 -Force 继续: {0}" -f $names) 'Yellow'
}
if ($unknownGen.Count -gt 0) {
    $names = ($unknownGen | ForEach-Object { $_.name }) -join ', '
    if (-not $Force) {
        Fail 'file-generation' ("目标这些文件代际不明（SHA-256 既不等于本补丁版，也不等于上游 1.2.22 原版）: {0}。可能是别的版本打过补丁，直接覆盖无法保证可恢复。确认要继续请加 -Force。" -f $names) 2
    }
    Say ("    [!] 目标文件代际不明，已按 -Force 继续覆盖: {0}" -f $names) 'Yellow'
}
# 记录哈希与仓库实际文件不一致：说明 upstream.json 写在别的补丁版本上（只提示，不影响判定）。
$drift = @($generation | Where-Object { $_.recordedLocalHash -and $_.recordedLocalHash -ne $_.patchHash })
if ($drift.Count -gt 0) {
    $names = ($drift | ForEach-Object { $_.name }) -join ', '
    $script:Report.patchDrift = $names
    Say ("    [!] upstream.json 记录的补丁哈希与当前文件不一致（元数据过期）: {0}" -f $names) 'Yellow'
}
if ($StrictFileGate) {
    Say '    (提示) 代际闸门现已默认硬拦，-StrictFileGate 不再需要。' 'Yellow'
}
Say ("    代际检查: {0} 个文件（SHA-256 判定）" -f $generation.Count) 'Green'

# 3c) 客户端版本：只在明确声明了支持区间时才检查（当前 upstream.json 不声明区间）
$clientVersion = ''
$exeCfg = Join-Path $src 'workbuddy-exe.json'
if (Test-Path $exeCfg) {
    try {
        $cfg = Get-Content $exeCfg -Raw -Encoding UTF8 | ConvertFrom-Json
        $exePath = [string]$cfg.path
        if ($exePath) {
            $manifest = Join-Path (Split-Path $exePath -Parent) 'resources\install-manifest.json'
            if (Test-Path $manifest) {
                $mf = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
                $clientVersion = [string]$mf.appVersion
            }
        }
    } catch { }
}
$script:Report.clientVersion = $clientVersion
if ($clientVersion) {
    Say ("    WorkBuddy 客户端: {0}" -f $clientVersion) 'Green'
    $range = ''
    if ($up -and $up.runtime -and $up.runtime.supportedWorkBuddyRange) { $range = [string]$up.runtime.supportedWorkBuddyRange }
    if ($range) {
        $mm = [regex]::Match($range, '^>=\s*([0-9.]+)\s*<\s*([0-9.]+)$')
        if ($mm.Success) {
            try {
                $cv = [version]$clientVersion
                $lo = [version]$mm.Groups[1].Value
                $hi = [version]$mm.Groups[2].Value
                if ($cv -lt $lo -or $cv -ge $hi) {
                    Say ("    [!] WorkBuddy {0} 不在声明区间 {1} 内" -f $clientVersion, $range) 'Yellow'
                    if ($StrictVersionGate -and -not $Force) {
                        Fail 'client-version' ("WorkBuddy {0} 不在支持范围 {1} 内；-StrictVersionGate 已开启，故中止。" -f $clientVersion, $range) 2
                    }
                }
            } catch { }
        }
    } else {
        Say '    (未声明 supportedWorkBuddyRange，跳过区间检查)' 'Yellow'
    }
} else {
    Say '    (未配置 workbuddy-exe.json 或读不到客户端清单，跳过客户端版本检查)' 'Yellow'
}


# ---------------------------------------------------------------- 4. 备份
Head '4/7 备份将被修改的文件'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $env:APPDATA "WorkDaddy\script-backups\deploy-$stamp"
$script:Report.backupDir = $bak

$existing = @()
foreach ($f in $all) {
    if (Test-Path (Join-Path $dst $f)) { $existing += $f }
}
if ($existing.Count -gt 0) {
    if (-not $DryRun) {
        New-Item -ItemType Directory -Path $bak -Force | Out-Null
        foreach ($f in $existing) {
            Copy-Item (Join-Path $dst $f) (Join-Path $bak $f) -Force
        }
    }
}
Say ("    {0} 个已存在文件{1}" -f $existing.Count, $(if ($DryRun) { '（预检不备份）' } else { " -> $bak" })) 'Green'

# 本机配置永不覆盖
$localExeCfg = Join-Path $dst 'workbuddy-exe.json'
$exampleExeCfg = Join-Path $src 'workbuddy-exe.example.json'
$needLocalExeCfg = -not (Test-Path $localExeCfg)
if ($needLocalExeCfg) {
    Say '    workbuddy-exe.json 不存在：部署后会从 example 生成一份，需要你改成实际路径' 'Yellow'
} else {
    Say '    workbuddy-exe.json 已存在：保持原样，不覆盖' 'Green'
}
if (Test-Path $localExeCfg) {
    try {
        $cfg = Get-Content $localExeCfg -Raw -Encoding UTF8 | ConvertFrom-Json
        $exePath = [string]$cfg.path
        if ($exePath -and -not (Test-Path $exePath)) {
            Say "    [!] 本机配置指向的客户端不存在: $exePath" 'Yellow'
            Say "        编辑 $localExeCfg 改成实际位置" 'Yellow'
        }
    } catch {
        Say '    (workbuddy-exe.json 读取失败，跳过检查)' 'Yellow'
    }
}

# ---------------------------------------------------------------- 5. 暂存并校验
Head '5/7 复制到临时目录并校验哈希'

$stage = Join-Path $env:TEMP ('workdaddy-stage-' + [guid]::NewGuid().ToString('N'))
$verifyFailed = @()
if (-not $DryRun) {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
        foreach ($f in $all) {
            Copy-Item (Join-Path $src $f) (Join-Path $stage $f) -Force
            $h = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $stage $f)).Hash
            if ($h -ne $sourceHash[$f]) { $verifyFailed += $f }
        }
    } catch {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        Fail 'stage' "暂存复制失败: $($_.Exception.Message)" 3
    }
    if ($verifyFailed.Count -gt 0) {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        Fail 'verify' ('暂存文件哈希不一致: ' + ($verifyFailed -join ', ')) 3
    }
    Say ("    {0} 个文件哈希校验通过" -f $all.Count) 'Green'
} else {
    Say ("    预检模式：跳过暂存（源文件 {0} 个已计算哈希）" -f $all.Count) 'Yellow'
}

# ---------------------------------------------------------------- 6. 替换（失败回滚）
Head '6/7 替换文件'

if ($DryRun) {
    foreach ($item in $script:Report.files) {
        $item.action = $(if ($existing -contains $item.name) { 'would-overwrite' } else { 'would-create' })
    }
    Say '    预检模式：不替换任何文件' 'Yellow'
} else {
    $replaced = @()
    $created = @()
    # 故障注入：仅供自动化测试验证回滚路径（正常部署不会设置这个变量）。
    $failAfter = -1
    if ($env:WORKDADDY_DEPLOY_TESTING -eq '1' -and $env:WORKDADDY_DEPLOY_FAIL_AFTER) {
        $failAfter = [int]$env:WORKDADDY_DEPLOY_FAIL_AFTER
    }
    $index = 0
    try {
        foreach ($f in $all) {
            if ($failAfter -ge 0 -and $index -ge $failAfter) {
                throw "injected failure at $f (test only)"
            }
            $index = $index + 1
            $target = Join-Path $dst $f
            $isNew = -not (Test-Path $target)
            Copy-Item (Join-Path $stage $f) $target -Force
            if ($isNew) { $created += $f } else { $replaced += $f }
            foreach ($item in $script:Report.files) {
                if ($item.name -eq $f) { $item.action = $(if ($isNew) { 'created' } else { 'overwritten' }) }
            }
        }
        Say ("    已替换 {0} 个文件（新增 {1}）" -f $all.Count, $created.Count) 'Green'
    } catch {
        $err = $_.Exception.Message
        Say "[X] 替换失败，开始回滚: $err" 'Red'
        foreach ($f in $replaced) {
            $from = Join-Path $bak $f
            if (Test-Path $from) {
                try { Copy-Item $from (Join-Path $dst $f) -Force } catch { Say "    回滚失败: $f" 'Red' }
            }
        }
        foreach ($f in $created) {
            try { Remove-Item (Join-Path $dst $f) -Force -ErrorAction SilentlyContinue } catch { }
        }
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        Fail 'replace' ("替换失败并已回滚: " + $err) 4
    }

    # 本机配置：只补缺，不覆盖
    if ($needLocalExeCfg -and (Test-Path $exampleExeCfg)) {
        Copy-Item $exampleExeCfg $localExeCfg -Force
        Say '    已生成 workbuddy-exe.json（示例值），请改成实际客户端路径' 'Yellow'
    }

    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 7. 绑定 UI + 重启
Head '7/7 绑定面板按钮 / 重启服务'

if ($DryRun) {
    Say '    预检模式：跳过 UI 绑定与重启' 'Yellow'
} else {
    $pyExe = $null
    foreach ($name in @('py', 'python')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { $pyExe = $cmd.Source; break }
    }
    if (-not $pyExe) {
        Say '[!] 没找到 Python，跳过 UI 绑定。' 'Yellow'
        Say '    影响：面板按钮文案仍是上游原版（叫「自动同步所有会话」）。' 'Yellow'
        Say '    功能本身不受影响，接管照常工作。' 'Yellow'
    } else {
        Say "    使用 Python: $pyExe" 'Green'
        & $pyExe (Join-Path $dst 'bind-rehome-ui.py')
        if ($LASTEXITCODE -eq 0) {
            Say '    面板按钮已绑定到接管模式' 'Green'
        } else {
            Say "[!] 绑定脚本返回 $LASTEXITCODE（功能不受影响）" 'Yellow'
        }
    }

    if ($NoRestart) {
        Say '    已按要求跳过重启（-NoRestart）' 'Yellow'
    } else {
        $daemons = @(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -eq 'node.exe' -and $_.CommandLine -match 'WorkDaddy[\\/]scripts[\\/]daemon\.js'
        })
        if ($daemons.Count -eq 0) {
            Say '    后台服务当前没运行，不用重启。' 'Yellow'
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
            if ($ok) { Say '    服务已恢复，端口 47832 在监听' 'Green' }
            else { Say '[!] 20 秒内没等到 47832 恢复，检查 daemon.log' 'Yellow' }
        }
    }
}

# ---------------------------------------------------------------- 报告
$script:Report.ok = $true
$script:Report.stage = 'done'
$script:Report.finishedAt = (Get-Date).ToString('o')

if (-not $DryRun) {
    $reportPath = Join-Path $env:APPDATA "WorkDaddy\deploy-report-$stamp.json"
    try {
        New-Item -ItemType Directory -Path (Split-Path $reportPath -Parent) -Force | Out-Null
        $script:Report | ConvertTo-Json -Depth 6 | Set-Content -Path $reportPath -Encoding UTF8
        Say ''
        Say "部署报告: $reportPath" 'Green'
    } catch {
        Say "    (报告写入失败: $($_.Exception.Message))" 'Yellow'
    }
}

Say ''
Say '==============================================' 'Cyan'
Say '   完成' 'Cyan'
Say '==============================================' 'Cyan'
if (-not $DryRun) {
    Say ''
    Say '下一步：'
    Say '  1. 双击托盘 exe（仓库 tray\WorkDaddyTray.exe）'
    Say '  2. 右键图标 -> 启动 WorkDaddy'
    Say '  3. 需要右下角机器人按钮时，再点「恢复 CDP」'
    Say ''
    Say "出问题看日志：$env:APPDATA\WorkDaddy\daemon.log"
    Say "想回滚：把 $bak 里的文件盖回去，再重启 daemon"
}
Say ''
Exit 0
