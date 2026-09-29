# Runs release.ps1's GitHub Release step (the one top-level statement that
# calls `gh @ghArgs`) on its own, with gh and git replaced by stubs, and
# writes what happened to $ResultPath as JSON. Used by
# server/tests/releaseScriptGitHubNotes.test.js.
#
# The step is found in release.ps1's syntax tree, not copied, so the test
# always exercises the code release.ps1 actually runs. Every top-level
# function in release.ps1 is defined first, since the step calls them.
param(
    [Parameter(Mandatory)] [string]$ReleaseScript,
    [Parameter(Mandatory)] [string]$FixtureDir,
    [Parameter(Mandatory)] [ValidateSet("ok", "exit", "throw")] [string]$GhMode,
    [Parameter(Mandatory)] [string]$ResultPath,
    [Parameter(Mandatory)] [string]$NodePath
)

$ErrorActionPreference = "Stop"

$parseTokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ReleaseScript, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "release.ps1 does not parse: $($parseErrors[0])" }
$topLevel = @($ast.EndBlock.Statements)

foreach ($statement in $topLevel) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}

$runsGhWithGhArgs = {
    param($node)
    if ($node -isnot [System.Management.Automation.Language.CommandAst]) { return $false }
    if ($node.GetCommandName() -ne "gh") { return $false }
    foreach ($element in $node.CommandElements) {
        if ($element -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $element.Splatted -and $element.VariablePath.UserPath -eq "ghArgs") { return $true }
    }
    return $false
}
$step = @($topLevel | Where-Object {
    $_ -isnot [System.Management.Automation.Language.FunctionDefinitionAst] -and $null -ne $_.Find($runsGhWithGhArgs, $true)
})
if ($step.Count -ne 1) { throw "Expected one top-level statement in release.ps1 that runs gh @ghArgs, found $($step.Count)" }

# What the steps before STEP 6 leave behind for it.
$RepoDir = $FixtureDir
$GitHubRepo = "example/zomboid-control-panel"
$Version = "1.4.0"
$TagName = "v1.4.0"
$ReleaseTitle = "v1.4.0"
$ReleaseNotes = ""
$SkipGitHub = $false
$DryRun = $false
$releaseCommit = "0123456789abcdef0123456789abcdef01234567"
$changelogFile = Join-Path $FixtureDir "CHANGELOG.md"
$WinExePath = "release\ZomboidControlPanel.exe"
$LinuxBinPath = "release\ZomboidControlPanel"
$WinZipPath = "release\ZomboidControlPanel-windows.zip"
$LinuxTarPath = "release\ZomboidControlPanel-linux.tar.gz"
$ChecksumsPath = "release\checksums.txt"
$githubReleaseFailed = $false

function git {
    $global:LASTEXITCODE = 0
    if ($args -contains "tag") { return "v1.3.8" }
    if ($args -contains "log") { return @("fix: keep the notes out of the command line", "feat: a new thing") }
}

$script:ghCall = $null
function gh {
    $callArgs = @($args | ForEach-Object { [string]$_ })
    $notesAt = [Array]::IndexOf($callArgs, "--notes-file")
    $notesPath = if ($notesAt -ge 0) { $callArgs[$notesAt + 1] } else { $null }
    $script:ghCall = [ordered]@{
        args = $callArgs
        notesFile = $notesPath
        notesFileText = if ($notesPath -and (Test-Path -LiteralPath $notesPath)) { [System.IO.File]::ReadAllText($notesPath) } else { $null }
    }
    switch ($GhMode) {
        "ok" { $global:LASTEXITCODE = 0 }
        "exit" { $global:LASTEXITCODE = 1 }
        # What PowerShell throws when CreateProcess refuses the command line.
        "throw" {
            throw [System.Management.Automation.ApplicationFailedException]::new(
                "Program 'gh.exe' failed to run: The filename or extension is too long")
        }
    }
}

$stepError = $null
$output = @()
try {
    $output = @(. ([scriptblock]::Create($step[0].Extent.Text)) *>&1 | ForEach-Object { "$_" })
} catch {
    $stepError = $_.Exception.Message
}

# Launch a real process with the exact arguments gh got: Windows refuses a
# command line over 32,767 characters before the program even runs.
$launchError = $null
if ($script:ghCall) {
    $noop = Join-Path $FixtureDir "noop.js"
    [System.IO.File]::WriteAllText($noop, "process.exit(0)`n")
    try {
        & $NodePath $noop @($script:ghCall.args) | Out-Null
        if ($LASTEXITCODE -ne 0) { $launchError = "node exited with code $LASTEXITCODE" }
    } catch {
        $launchError = $_.Exception.Message
    }
}

# The command the step printed for a retry, read back the way PowerShell
# would run it when pasted.
$retryArgs = $null
$retryLine = @($output | Where-Object { $_ -match '^\s*gh release create ' }) | Select-Object -First 1
if ($retryLine) {
    $retryAst = [System.Management.Automation.Language.Parser]::ParseInput($retryLine.Trim(), [ref]$null, [ref]$parseErrors)
    $retryCommand = $retryAst.Find({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)
    $retryArgs = @($retryCommand.CommandElements | Select-Object -Skip 1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value } else { $_.Extent.Text }
    })
}

$result = [ordered]@{
    stepError = $stepError
    output = $output
    ghCall = $script:ghCall
    launchError = $launchError
    githubReleaseFailed = [bool]$githubReleaseFailed
    notesFileExistsAfter = [bool]($script:ghCall -and $script:ghCall.notesFile -and (Test-Path -LiteralPath $script:ghCall.notesFile))
    retryArgs = $retryArgs
}
[System.IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
