param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z][A-Z0-9]*-[0-9]{3}$')]
    [string]$Id,
    [Parameter(Mandatory = $true)]
    [ValidateSet('ADR','PhaseReview','DecisionRequest','CapabilityMatrix','FixtureManifest','ApiContract')]
    [string]$Template
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Templates = Join-Path $Root 'docs\modernization\templates'
$Evidence = Join-Path $Root "docs\modernization\evidence\$Id"

if (-not (Test-Path -LiteralPath $Evidence -PathType Container)) {
    throw "Package evidence folder does not exist: $Evidence"
}

$Map = @{
    ADR = @('ADR_TEMPLATE.md', 'ADR_DRAFT.md')
    PhaseReview = @('PHASE_REVIEW_CHECKLIST.md', 'PHASE_REVIEW.md')
    DecisionRequest = @('DECISION_REQUEST_TEMPLATE.md', 'DECISION_REQUEST.md')
    CapabilityMatrix = @('CAPABILITY_MATRIX_TEMPLATE.md', 'CAPABILITY_MATRIX_DRAFT.md')
    FixtureManifest = @('FIXTURE_MANIFEST_TEMPLATE.md', 'FIXTURE_MANIFEST.md')
    ApiContract = @('API_CONTRACT_RECORD_TEMPLATE.md', 'API_CONTRACT_RECORD.md')
}

$source = Join-Path $Templates $Map[$Template][0]
$destination = Join-Path $Evidence $Map[$Template][1]
if (Test-Path -LiteralPath $destination) { throw "Refusing overwrite: $destination" }
$content = (Get-Content -LiteralPath $source -Raw).Replace('<WP-ID>', $Id)
[System.IO.File]::WriteAllText($destination, $content, [System.Text.UTF8Encoding]::new($false))
Write-Output "CREATED $destination"
Write-Output 'RESULT=PASS'