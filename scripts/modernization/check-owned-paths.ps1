param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z][A-Z0-9]*-[0-9]{3}$')]
    [string]$Id,
    [Parameter(Mandatory = $true)]
    [string[]]$AllowedPath
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Normalize([string]$Value) {
    return $Value.Replace('\', '/').TrimStart('./')
}

# DISC-002 / RISK-007. `pwsh -File script.ps1 -AllowedPath a,b` binds the whole comma list as ONE
# string, not an array, so every allowed path was silently discarded and the script still printed
# PASS - passing only via the $initialHandoff fallback below, never via the caller's argument. A
# guard that cannot tell "checked and fine" from "did not check" is worse than no guard, because it
# carries authority. Split on commas so both invocation styles work, and refuse an argument that
# yields nothing usable rather than proceeding with an empty allow-list.
$allowed = @(
    $AllowedPath |
        ForEach-Object { $_ -split ',' } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -ne '' } |
        ForEach-Object { Normalize $_ }
)
if ($allowed.Count -eq 0) {
    throw "-AllowedPath produced no usable entries. Pass at least one path; a silently empty allow-list would make this check meaningless."
}
$trackedChanged = @()
$trackedChanged += & git -C $Root diff --name-only
$trackedChanged += & git -C $Root diff --cached --name-only
$trackedChanged = @($trackedChanged | ForEach-Object { Normalize $_ } | Sort-Object -Unique)
$untracked = @(& git -C $Root ls-files --others --exclude-standard | ForEach-Object { Normalize $_ } | Sort-Object -Unique)
$changed = @($trackedChanged + $untracked | Sort-Object -Unique)

$globalAllowed = @(
    'docs/modernization/STATUS.md',
    'docs/modernization/STATUS_ARCHIVE.md',
    'docs/modernization/WORK_PACKAGES.md',
    'docs/modernization/DECISIONS.md',
    'docs/modernization/RISK_REGISTER.md',
    "docs/modernization/evidence/$Id/"
)
$initialHandoff = @('V2_MODERNIZATION_PLAN.md', 'AGENTS.md', 'docs/modernization/', 'scripts/modernization/')

$unexpected = foreach ($path in $changed) {
    $ok = $false
    foreach ($prefix in @($allowed + $globalAllowed)) {
        if ($path -eq $prefix.TrimEnd('/') -or $path.StartsWith($prefix)) { $ok = $true; break }
    }
    if (-not $ok -and $path -in $untracked) {
        foreach ($prefix in $initialHandoff) {
            if ($path -eq $prefix.TrimEnd('/') -or $path.StartsWith($prefix)) { $ok = $true; break }
        }
    }
    if (-not $ok) { $path }
}

if (@($unexpected).Count -gt 0) {
    Write-Output "FAIL work-package=$Id"
    $unexpected | ForEach-Object { Write-Output "UNOWNED $_" }
    exit 1
}

Write-Output "PASS work-package=$Id changed=$($changed.Count)"
