param(
    [switch]$StrictBaseline
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ExpectedSha = '8642dc467938a47ca8aac76fc44fc1875446c88b'
$ExpectedTag = 'v1.1.55'

function Assert-Equal($Actual, $Expected, $Label) {
    if ($Actual -ne $Expected) {
        throw "$Label mismatch. Expected '$Expected', got '$Actual'."
    }
    Write-Output "PASS $Label=$Actual"
}

Push-Location $Root
try {
    $inside = (& git rev-parse --is-inside-work-tree).Trim()
    Assert-Equal $inside 'true' 'git-worktree'

    $head = (& git rev-parse HEAD).Trim()
    $statusPath = Join-Path $Root 'docs\modernization\STATUS.md'
    $isBaseline = $StrictBaseline -or -not (Test-Path -LiteralPath $statusPath)
    if ($isBaseline) {
        Assert-Equal $head $ExpectedSha 'baseline-sha'
        $tag = (& git describe --exact-match --tags HEAD).Trim()
        Assert-Equal $tag $ExpectedTag 'baseline-tag'
        Write-Output 'PASS mode=baseline'
    } else {
        $statusText = Get-Content -LiteralPath $statusPath -Raw
        $match = [regex]::Match($statusText, '(?m)^current_sha:\s*["'']?([0-9a-f]{40})["'']?\s*$')
        if ($match.Success) {
            $statusSha = $match.Groups[1].Value
            & git merge-base --is-ancestor $statusSha $head
            if ($LASTEXITCODE -ne 0) {
                throw "STATUS current_sha $statusSha is not an ancestor of HEAD $head."
            }
            if ($statusSha -eq $head) {
                Write-Output "PASS status-current-sha=$statusSha"
            } else {
                $ahead = (& git rev-list --count "$statusSha..$head").Trim()
                Write-Output "WARN STATUS current_sha is $ahead commit(s) behind HEAD; update STATUS before integration."
            }
        } else {
            Write-Output 'WARN STATUS.md has no concrete current_sha; coordinator must reconcile it before integration.'
        }
        Write-Output 'PASS mode=resume'
    }

    $remotes = @(& git remote)
    if ('v1-source' -notin $remotes) { throw "Required remote 'v1-source' is missing." }
    if ('origin' -in $remotes) { throw "Remote 'origin' must not exist in the local-only fork." }
    Write-Output 'PASS remotes=v1-source-only'

    $status = @(& git status --porcelain)
    if ($isBaseline) {
        $allowed = @('?? AGENTS.md', '?? V2_MODERNIZATION_PLAN.md', '?? docs/', '?? scripts/modernization/')
        $unexpected = @($status | Where-Object {
            $line = $_
            -not ($allowed | Where-Object { $line.StartsWith($_) })
        })
        if ($unexpected.Count -gt 0) {
            throw "Unexpected dirty paths:`n$($unexpected -join "`n")"
        }
        Write-Output "PASS git-status-handoff-only=$($status.Count)"
    } else {
        Write-Output "INFO git-status-entries=$($status.Count)"
    }

    if (Test-Path -LiteralPath (Join-Path $Root 'data\db.json')) {
        throw 'data/db.json must not exist in the modernization fork baseline.'
    }
    Write-Output 'PASS runtime-db-absent'

    $node = (& node --version).Trim()
    $npm = (& npm --version).Trim()
    Write-Output "INFO node=$node"
    Write-Output "INFO npm=$npm"
    Write-Output "INFO root=$Root"
    Write-Output 'RESULT=PASS'
} finally {
    Pop-Location
}
