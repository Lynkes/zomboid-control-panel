param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z][A-Z0-9]*-[0-9]{3}$')]
    [string]$Id,
    [string]$BaseSha = 'HEAD'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Branch = 'modern/' + $Id.ToLowerInvariant()
$Worktree = "D:\Projects\ZCP-Modernized-worktrees\$Id"

foreach ($required in @('AGENTS.md', 'V2_MODERNIZATION_PLAN.md', 'scripts/modernization/bootstrap-plan.ps1')) {
    & git -C $Root ls-files --error-unmatch $required *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Handoff file is not tracked: $required. Obtain user approval for the local handoff checkpoint before creating worktrees."
    }
}

$plan = Get-Content -LiteralPath (Join-Path $Root 'V2_MODERNIZATION_PLAN.md') -Raw
if (-not [regex]::IsMatch($plan, "(?m)^\|\s*$([regex]::Escape($Id))\s*\|")) {
    throw "Unknown work-package ID: $Id"
}
if (Test-Path -LiteralPath $Worktree) { throw "Worktree path already exists: $Worktree" }
& git -C $Root show-ref --verify --quiet "refs/heads/$Branch"
if ($LASTEXITCODE -eq 0) { throw "Branch already exists: $Branch" }

$resolvedBase = (& git -C $Root rev-parse $BaseSha).Trim()
New-Item -ItemType Directory -Force (Split-Path $Worktree -Parent) | Out-Null
& git -C $Root worktree add -b $Branch $Worktree $resolvedBase
if ($LASTEXITCODE -ne 0) { throw "git worktree add failed for $Id" }

Write-Output "CREATED worktree=$Worktree"
Write-Output "CREATED branch=$Branch"
Write-Output "BASE sha=$resolvedBase"
Write-Output 'RESULT=PASS'