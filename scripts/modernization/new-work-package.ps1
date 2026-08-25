param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z][A-Z0-9]*-[0-9]{3}$')]
    [string]$Id,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Docs = Join-Path $Root 'docs\modernization'
$Templates = Join-Path $Docs 'templates'
$Evidence = Join-Path $Docs "evidence\$Id"

if (Test-Path -LiteralPath $Evidence) {
    throw "Evidence folder already exists: $Evidence"
}

$Copies = [ordered]@{
    'WORK_PACKAGE_TEMPLATE.md' = 'WORK_PACKAGE.md'
    'EVIDENCE_SUMMARY_TEMPLATE.md' = 'SUMMARY.md'
    'COMMANDS_TEMPLATE.md' = 'COMMANDS.md'
    'DIFF_SCOPE_TEMPLATE.md' = 'DIFF_SCOPE.md'
    'ROLLBACK_MANIFEST_TEMPLATE.md' = 'ROLLBACK.md'
    'PROVENANCE_TEMPLATE.md' = 'PROVENANCE.md'
    'VERIFICATION_TEMPLATE.md' = 'VERIFICATION.md'
}

$OptionalCopies = [ordered]@{
    'ADR_TEMPLATE.md' = 'ADR_DRAFT.md'
    'PHASE_REVIEW_CHECKLIST.md' = 'PHASE_REVIEW.md'
    'DECISION_REQUEST_TEMPLATE.md' = 'DECISION_REQUEST.md'
    'CAPABILITY_MATRIX_TEMPLATE.md' = 'CAPABILITY_MATRIX_DRAFT.md'
    'FIXTURE_MANIFEST_TEMPLATE.md' = 'FIXTURE_MANIFEST.md'
    'API_CONTRACT_RECORD_TEMPLATE.md' = 'API_CONTRACT_RECORD.md'
}

if ($WhatIf) {
    Write-Output "WOULD_CREATE $Evidence"
} else {
    New-Item -ItemType Directory -Path $Evidence | Out-Null
}

foreach ($sourceName in $Copies.Keys) {
    $source = Join-Path $Templates $sourceName
    $destination = Join-Path $Evidence $Copies[$sourceName]
    $content = (Get-Content -LiteralPath $source -Raw).Replace('<WP-ID>', $Id)
    if ($WhatIf) {
        Write-Output "WOULD_CREATE $destination"
    } else {
        [System.IO.File]::WriteAllText($destination, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Output "CREATED $destination"
    }
}

Write-Output 'OPTIONAL_TEMPLATES (copy only when required by package):'
foreach ($sourceName in $OptionalCopies.Keys) {
    Write-Output "  $sourceName -> $($OptionalCopies[$sourceName])"
}

$resultsPath = Join-Path $Evidence 'RESULTS.json'
Write-Output "REQUIRED_AT_COMPLETION $resultsPath"

Write-Output "RESULT=$(if ($WhatIf) { 'WHATIF' } else { 'PASS' })"
