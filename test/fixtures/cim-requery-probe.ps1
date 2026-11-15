param(
    [string]$Mode = '',
    [string]$AppDir = '',
    [string]$Json = ''
)
# Probe for Get-WorkDaddyProcesses requery semantics (stage 1).
#
# All CIM access is mocked: nothing here touches real processes. The mock below
# shadows the Get-CimInstance cmdlet (function lookup wins over cmdlet), so the
# only thing exercised is the decision logic inside common.ps1.
#
# Modes (second query behaviour; the first query always returns one unreadable row):
#   gone    -> query succeeds, no record   (PID really exited)
#   throw   -> query throws                (cannot confirm anything)
#   still   -> query succeeds, fields empty (still unreadable)
#   daemon  -> query succeeds with a valid daemon command line
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
. (Join-Path $here '..\..\installer\lib\common.ps1')

$script:listQueries = 0
$script:requeries = 0

function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)

    if ($Filter -and $Filter -match 'ProcessId') {
        $script:requeries += 1
        switch ($Mode) {
            'gone'   { return $null }
            'throw'  { throw 'CIM requery failed: simulated provider error 0x80041002' }
            'still'  { return [pscustomobject]@{ ProcessId = 4242; Name = 'node.exe'; CommandLine = $null; ExecutablePath = $null } }
            'daemon' { return [pscustomobject]@{ ProcessId = 4242; Name = 'node.exe'; CommandLine = ('"' + $AppDir + '\scripts\daemon.js"'); ExecutablePath = $null } }
            default  { throw ('unknown mode: ' + $Mode) }
        }
    }

    $script:listQueries += 1
    return [pscustomobject]@{
        ProcessId      = 4242
        Name           = 'node.exe'
        CommandLine    = $null
        ExecutablePath = $null
    }
}

$r = Get-WorkDaddyProcesses -AppDir $AppDir

$out = [ordered]@{
    ok            = [bool]$r.ok
    error         = [string]$r.error
    unreadable    = @($r.unreadable | ForEach-Object { [int]$_ })
    processes     = @($r.processes | ForEach-Object { [ordered]@{ pid = [int]$_.pid; role = [string]$_.role } })
    requeryErrors = @($r.requeryErrors | Where-Object { $_ })
    listQueries   = $script:listQueries
    requeries     = $script:requeries
}

if ($Json) {
    $dir = Split-Path -Parent $Json
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Json, ($out | ConvertTo-Json -Depth 6), $enc)
}
$out | ConvertTo-Json -Depth 6
