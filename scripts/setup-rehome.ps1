<#
.SYNOPSIS
  One-time setup for WorkDaddy rehome mode.

.DESCRIPTION
  Shares the two remaining per-account state files across all local WorkBuddy
  accounts with NTFS hard links:

    <uuid>/startup-route.json              -> one shared "last opened conversation"
    user-<uuid>-personal/MEMORY.md         -> one shared user-level memory

  Everything else is already global (skills, mcp, plugins, rules, settings,
  workspace files, message JSONL, artifacts). No copying, no daemon, no sync.

  Run this ONCE while WorkBuddy / WorkDaddy are fully closed (including tray).
  Re-run any time to repair links that a client broke with atomic replacement.

.PARAMETER DryRun
  Report what would change without writing anything.

.PARAMETER DataRoot
  WorkBuddy data root. Defaults to %USERPROFILE%\.workbuddy (domestic / cn).
  For the international build use %USERPROFILE%\.workbuddy-ai.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-rehome.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File scripts\setup-rehome.ps1
#>
param(
    [switch]$DryRun,
    [string]$DataRoot = (Join-Path $env:USERPROFILE '.workbuddy')
)

$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $DataRoot)) {
    throw "WorkBuddy data root not found: $DataRoot"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

function Get-HardLinkPaths([string]$Path) {
    $out = @()
    try {
        $out = @(fsutil hardlink list $Path 2>$null |
            ForEach-Object { $_.Trim().ToLowerInvariant() } |
            Where-Object { $_ })
    } catch { }
    return $out
}

function Set-HardLinkGroup {
    param(
        [string]$Label,
        [string[]]$Paths,
        [switch]$PickLargest
    )

    $existing = @($Paths | Where-Object { Test-Path -LiteralPath $_ })
    if ($existing.Count -lt 2) {
        Write-Host "[$Label] skip: only $($existing.Count) file(s) present"
        return
    }

    $master = $existing[0]
    if ($PickLargest) {
        $master = ($existing | Sort-Object { (Get-Item -LiteralPath $_).Length } -Descending)[0]
    }

    $norm = @($existing | ForEach-Object { (Resolve-Path -LiteralPath $_).Path.ToLowerInvariant() })
    $links = Get-HardLinkPaths $master
    $already = $true
    foreach ($p in $norm) { if ($links -notcontains $p) { $already = $false; break } }

    if ($already) {
        Write-Host "[$Label] already shared via hard link, skip"
        return
    }
    if ($DryRun) {
        Write-Host "[$Label] DRY-RUN: would link $($existing.Count - 1) file(s) to $master"
        return
    }

    foreach ($p in $existing) {
        if ($p -eq $master) { continue }
        Copy-Item -LiteralPath $p -Destination ($p + '.bak-' + $stamp) -Force
        Remove-Item -LiteralPath $p -Force
        New-Item -ItemType HardLink -Path $p -Target $master | Out-Null
    }
    $after = Get-HardLinkPaths $master
    Write-Host "[$Label] linked. master = $master ; total hard-link paths = $($after.Count)"
}

# ---- startup-route.json : one shared "last opened conversation" pointer ----
$accountDirs = @(Get-ChildItem -LiteralPath $DataRoot -Directory |
    Where-Object { $_.Name -match $uuidPattern } | Sort-Object Name)
$routePaths = @($accountDirs | ForEach-Object { Join-Path $_.FullName 'startup-route.json' } |
    Where-Object { Test-Path -LiteralPath $_ })
Write-Host "Found $($accountDirs.Count) account dir(s), $($routePaths.Count) startup-route file(s)"
Set-HardLinkGroup -Label 'startup-route' -Paths $routePaths

# ---- MEMORY.md : one shared user-level long-term memory ----
$personalDirs = @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'user-*-personal' |
    Sort-Object Name)
$memoryPaths = @($personalDirs | ForEach-Object { Join-Path $_.FullName 'MEMORY.md' } |
    Where-Object { Test-Path -LiteralPath $_ })
Write-Host "Found $($personalDirs.Count) personal dir(s), $($memoryPaths.Count) MEMORY.md file(s)"

$hashes = @($memoryPaths | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm MD5).Hash } | Sort-Object -Unique)
if ($hashes.Count -gt 1) {
    Write-Host "[MEMORY] WARNING: files differ ($($hashes.Count) distinct hashes). Backups are kept; largest file becomes master."
}
Set-HardLinkGroup -Label 'MEMORY.md' -Paths $memoryPaths -PickLargest

Write-Host ''
Write-Host 'Verify manually:'
Write-Host ('  fsutil hardlink list "' + ($routePaths[0]) + '"')
Write-Host ('  fsutil hardlink list "' + ($memoryPaths[0]) + '"')
if ($DryRun) { Write-Host 'DRY-RUN: nothing was written.' }
