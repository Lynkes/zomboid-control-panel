# Defines release.ps1's own top-level functions (and its $ReleaseBumpFiles
# list), then runs the test's script file against them. Used by
# server/tests/releaseScriptPreflightRestore.test.js.
#
# The definitions are taken from release.ps1's syntax tree, not copied, so a
# test always exercises the code release.ps1 actually runs.
param(
    [Parameter(Mandatory)] [string]$ReleaseScript,
    [Parameter(Mandatory)] [string]$BodyPath
)

$ErrorActionPreference = "Stop"

$parseTokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ReleaseScript, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "release.ps1 does not parse: $($parseErrors[0])" }

foreach ($statement in @($ast.EndBlock.Statements)) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($statement.Extent.Text))
    } elseif ($statement -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $statement.Left.Extent.Text -eq '$ReleaseBumpFiles') {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}

. $BodyPath
