$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$RequiredFiles = @(
    'V2_MODERNIZATION_PLAN.md',
    'AGENTS.md',
    'docs\modernization\INTEGRATION_PROCEDURE.md',
    'docs\modernization\WORKTREE_LIFECYCLE.md',
    'docs\modernization\CONFLICT_RESOLUTION.md',
    'scripts\modernization\bootstrap-plan.ps1',
    'scripts\modernization\validate-handoff.ps1',
    'scripts\modernization\initialize-program.ps1',
    'scripts\modernization\new-work-package.ps1',
    'scripts\modernization\create-worktree.ps1',
    'scripts\modernization\copy-package-template.ps1',
    'scripts\modernization\check-owned-paths.ps1',
    'scripts\modernization\validate-evidence.mjs',
    'scripts\modernization\measure-baseline.mjs',
    'docs\modernization\templates\RESULTS.schema.json',
    'docs\modernization\templates\PERF.schema.json',
    'docs\modernization\templates\ADR_TEMPLATE.md',
    'docs\modernization\templates\STATUS_TEMPLATE.md',
    'docs\modernization\templates\WORK_PACKAGE_TEMPLATE.md',
    'docs\modernization\templates\RISK_REGISTER_TEMPLATE.md',
    'docs\modernization\templates\ROLLBACK_MANIFEST_TEMPLATE.md',
    'docs\modernization\templates\VERIFICATION_TEMPLATE.md',
    'docs\modernization\templates\FIXTURE_MANIFEST_TEMPLATE.md',
    'docs\modernization\templates\API_CONTRACT_RECORD_TEMPLATE.md',
    'docs\modernization\templates\PHASE_REVIEW_CHECKLIST.md',
    'docs\modernization\templates\DECISION_REQUEST_TEMPLATE.md',
    'docs\modernization\templates\PROVENANCE_TEMPLATE.md',
    'docs\modernization\templates\CAPABILITY_MATRIX_TEMPLATE.md',
    'docs\modernization\templates\COMMANDS_TEMPLATE.md',
    'docs\modernization\templates\DIFF_SCOPE_TEMPLATE.md',
    'docs\modernization\templates\DECISIONS_INDEX_TEMPLATE.md',
    'docs\modernization\templates\WORK_PACKAGES_LEDGER_TEMPLATE.md',
    'docs\modernization\templates\BASELINE_TEMPLATE.md',
    'docs\modernization\templates\EVIDENCE_SUMMARY_TEMPLATE.md',
    'docs\modernization\templates\STATUS_ARCHIVE_TEMPLATE.md',
    'docs\modernization\templates\PROGRAM_README_TEMPLATE.md',
    'docs\modernization\templates\PROGRAM_ROLLBACK_TEMPLATE.md'
)

$RequiredHeadings = @(
    'Plan Control', 'Mission', 'Product Contract', 'Target Shape', 'Build Boundary',
    'Authority Matrix', 'Phased Program', 'Autonomous Agent Execution Specification',
    'Dependency Graph', 'Work-Package Catalog', 'API Contract Parity Specification',
    'Lifecycle Operation Specification', 'SQLite Technical Specification',
    'Connector and Agent Specification', 'Authentication and OIDC Specification',
    'Locale Infrastructure Specification', 'Security and Threat-Model Requirements',
    'Compatibility Test Matrix', 'End-to-End V1 Workflow Parity Matrix',
    'Release and Packaging Compatibility', 'Fault-Injection Matrix',
    'Definition of Done for Any Work Package', 'Stop Conditions',
    'Bootstrap Prompt for the Coordinator Agent', 'First Work Item'
)

Push-Location $Root
try {
    foreach ($relative in $RequiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) {
            throw "Required handoff file missing: $relative"
        }
    }
    Write-Output "PASS required-files=$($RequiredFiles.Count)"

    foreach ($jsonFile in @(
        'docs\modernization\templates\RESULTS.schema.json',
        'docs\modernization\templates\PERF.schema.json'
    )) {
        Get-Content -LiteralPath $jsonFile -Raw | ConvertFrom-Json | Out-Null
    }
    Write-Output 'PASS json-schemas-parse'

    $plan = Get-Content -LiteralPath 'V2_MODERNIZATION_PLAN.md' -Raw
    foreach ($heading in $RequiredHeadings) {
        $escaped = [regex]::Escape($heading)
        $count = [regex]::Matches($plan, "(?im)^## $escaped\r?$").Count
        if ($count -ne 1) { throw "Heading '$heading' count is $count; expected 1." }
    }
    Write-Output "PASS headings=$($RequiredHeadings.Count)"

    $ids = [regex]::Matches($plan, '(?m)^\|\s*([A-Z][A-Z0-9]*-[0-9]{3})\s*\|') |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
    if ($ids.Count -ne 30) { throw "Catalog work-package count is $($ids.Count); expected 30." }
    Write-Output 'PASS work-packages=30'

    foreach ($edge in @(
        'DB002 --> LIF003', 'LIF003 --> CUT002', 'DB004 --> CUT006',
        'DB004 --> CUT007', 'DB004 --> CUT008', 'CON002 --> I18N001'
    )) {
        if (-not $plan.Contains($edge)) { throw "Required DAG edge missing: $edge" }
    }
    Write-Output 'PASS critical-dag-edges'

    if ($plan.Contains('data/panel-modern.sqlite')) {
        throw 'Executable-relative SQLite path reappeared in plan.'
    }
    Write-Output 'PASS durable-data-path-rule'

    & git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'git diff --check failed.' }
    Write-Output 'PASS git-diff-check'

    $statusPath = Join-Path $Root 'docs\modernization\STATUS.md'
    $trackedChanges = @(& git status --porcelain --untracked-files=no)
    if (-not (Test-Path -LiteralPath $statusPath) -and $trackedChanges.Count -gt 0) {
        throw "Tracked source changes exist before Phase 0 initialized STATUS.md:`n$($trackedChanges -join "`n")"
    }
    if (Test-Path -LiteralPath $statusPath) {
        Write-Output "INFO resume-tracked-changes=$($trackedChanges.Count)"
    } else {
        Write-Output 'PASS no-tracked-source-changes'
    }
    Write-Output 'RESULT=PASS'
} finally {
    Pop-Location
}
