param(
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Docs = Join-Path $Root 'docs\modernization'
$Templates = Join-Path $Docs 'templates'

$Copies = [ordered]@{
    'PROGRAM_README_TEMPLATE.md' = 'README.md'
    'STATUS_TEMPLATE.md' = 'STATUS.md'
    'STATUS_ARCHIVE_TEMPLATE.md' = 'STATUS_ARCHIVE.md'
    'WORK_PACKAGES_LEDGER_TEMPLATE.md' = 'WORK_PACKAGES.md'
    'DECISIONS_INDEX_TEMPLATE.md' = 'DECISIONS.md'
    'RISK_REGISTER_TEMPLATE.md' = 'RISK_REGISTER.md'
    'BASELINE_TEMPLATE.md' = 'BASELINE.md'
    'PROGRAM_ROLLBACK_TEMPLATE.md' = 'ROLLBACK.md'
}

$head = (& git -C $Root rev-parse HEAD).Trim()
$now = (Get-Date).ToUniversalTime().ToString('o')

foreach ($sourceName in $Copies.Keys) {
    $source = Join-Path $Templates $sourceName
    $destination = Join-Path $Docs $Copies[$sourceName]
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Template missing: $sourceName"
    }
    if (Test-Path -LiteralPath $destination) {
        throw "Refusing to overwrite existing program artifact: $destination"
    }
    if ($WhatIf) {
        Write-Output "WOULD_CREATE $destination"
    } else {
        $content = Get-Content -LiteralPath $source -Raw
        if ($sourceName -eq 'STATUS_TEMPLATE.md') {
            $content = $content.Replace('<40-char-sha>', $head)
            $content = $content.Replace('state: "planned"', 'state: "active"')
            $content = $content.Replace('updated_at: "YYYY-MM-DDTHH:MM:SSZ"', "updated_at: `"$now`"")
        }
        if ($sourceName -eq 'WORK_PACKAGES_LEDGER_TEMPLATE.md') {
            $content = $content.Replace('| FND-001 | Baseline | planned |', '| FND-001 | Baseline | active |')
        }
        [System.IO.File]::WriteAllText($destination, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Output "CREATED $destination"
    }
}

Write-Output "RESULT=$(if ($WhatIf) { 'WHATIF' } else { 'PASS' })"
