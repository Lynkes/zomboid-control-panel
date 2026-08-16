<#
.SYNOPSIS
    Build and GitHub release pipeline for Zomboid Control Panel.

.DESCRIPTION
    This script automates the release process, self-contained in this repo
    (no external Dev1/ working copy, no \\garage SMB deploy — that
    infrastructure is retired; live deployment now happens separately via
    Docker on the production host):
    0. Pre-flight checks (uncommitted changes)
    1. Bumps version in package.json — auto-increments if no -Version given
    2. Builds the client (Vite/React)
    3. Builds Windows + Linux binaries (esbuild + pkg) and packages archives
    4. Builds Docker image
    5. Commits and pushes to GitHub
    6. Creates a GitHub Release with Keep a Changelog format notes

.PARAMETER Version
    Explicit version string (e.g., "0.9.0"). If omitted, auto-increments based on -Bump.

.PARAMETER Bump
    Auto-increment type when -Version is not provided. Valid: major, minor, patch (default: patch).

.PARAMETER ReleaseTitle
    Custom release title. Defaults to "v<Version>".

.PARAMETER ReleaseNotes
    Path to a markdown file with release notes. If omitted, auto-generates from commits.

.PARAMETER SkipBuild
    Skip the client and exe build steps (use existing release/ folder).

.PARAMETER SkipGitHub
    Skip git commit/push and GitHub release creation.

.PARAMETER SkipDocker
    Skip building the Docker image.

.PARAMETER DryRun
    Show what would happen without making changes.

.EXAMPLE
    .\release.ps1                                          # Auto-increment patch
    .\release.ps1 -Version "0.9.0"                         # Explicit version
    .\release.ps1 -Bump minor                              # Auto-increment minor
    .\release.ps1 -Version "0.9.0" -SkipDocker             # Skip Docker build
    .\release.ps1 -DryRun                                  # Preview all steps
#>

param(
    [string]$Version = "",

    [ValidateSet("major", "minor", "patch")]
    [string]$Bump = "patch",

    [string]$ReleaseTitle = "",

    [string]$ReleaseNotes = "",

    [switch]$SkipBuild,
    [switch]$SkipGitHub,
    [switch]$SkipDocker,
    [switch]$DryRun
)

# ============================================
# CONFIGURATION - Edit these paths as needed
# ============================================
$RepoDir          = $PSScriptRoot
$GitHubRepo       = "fpsacha/zomboid-control-panel"

$ReleaseDir       = "release"
$WinExePath       = "release\ZomboidControlPanel.exe"
$LinuxBinPath     = "release\ZomboidControlPanel"
$WinZipPath       = "release\ZomboidControlPanel-windows.zip"
$LinuxTarPath     = "release\ZomboidControlPanel-linux.tar.gz"
$ChecksumsPath    = "release\checksums.txt"

# ============================================
# HELPERS
# ============================================
$ErrorActionPreference = "Stop"

function Write-Step($step, $msg) {
    Write-Host ""
    Write-Host "[$step] $msg" -ForegroundColor Cyan
    Write-Host ("-" * 60) -ForegroundColor DarkGray
}

function Write-Ok($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "  SKIP: $msg" -ForegroundColor Yellow }
function Write-Dry($msg)  { Write-Host "  DRY RUN: $msg" -ForegroundColor Magenta }
function Write-Warn($msg) { Write-Host "  WARN: $msg" -ForegroundColor Yellow }

# ============================================
# AUTO-VERSION: Increment from current package.json if no -Version given
# ============================================
if (-not $Version) {
    $pkgContent = Get-Content (Join-Path $RepoDir "package.json") -Raw | ConvertFrom-Json
    $currentVersion = $pkgContent.version
    # Strip any pre-release suffix for numeric parsing
    $numericPart = ($currentVersion -split '-')[0]
    $parts = $numericPart -split '\.'
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    $patch = [int]($parts[2] -replace '[^0-9]', '')

    switch ($Bump) {
        "major" { $major++; $minor = 0; $patch = 0 }
        "minor" { $minor++; $patch = 0 }
        "patch" { $patch++ }
    }
    $Version = "$major.$minor.$patch"
    Write-Host "  Auto-incremented version: $currentVersion -> $Version (bump: $Bump)" -ForegroundColor Magenta
}

$TagName = "v$Version"
if (-not $ReleaseTitle) { $ReleaseTitle = "$TagName" }

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host " Zomboid Control Panel - Release Pipeline"   -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
Write-Host " Version:  $Version"
Write-Host " Tag:      $TagName"
Write-Host " Title:    $ReleaseTitle"
Write-Host " DryRun:   $DryRun"
Write-Host ""

# ============================================
# STEP 0: Pre-flight checks
# ============================================
Write-Step "0/6" "Pre-flight checks"

Push-Location $RepoDir
try { $gitStatus = git status --porcelain 2>$null } catch { $gitStatus = $null }
$untrackedFiles = @(git ls-files --others --exclude-standard 2>$null)
Pop-Location
if ($gitStatus) {
    Write-Warn "Uncommitted changes detected:"
    $gitStatus | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    Write-Warn "Continuing with uncommitted changes."
} else {
    Write-Ok "No uncommitted changes"
}
if ($untrackedFiles.Count -gt 0) {
    $untrackedFiles | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    throw "Untracked files detected. Stage intentional new source files before releasing; refusing to stage runtime state automatically."
}

# ============================================
# STEP 1: Bump version in package.json
# ============================================
Write-Step "1/6" "Bumping version to $Version"

$pkgFile = Join-Path $RepoDir "package.json"
if (Test-Path $pkgFile) {
    $content = Get-Content $pkgFile -Raw
    $newContent = $content -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`""
    if ($DryRun) {
        Write-Dry "Would update $pkgFile"
    } else {
        # Set-Content intermittently throws "Stream was not readable" in some
        # shells even when the file is writable; direct file I/O is reliable.
        [System.IO.File]::WriteAllText($pkgFile, $newContent, [System.Text.UTF8Encoding]::new($false))
        Write-Ok "Updated $pkgFile"
    }
} else {
    Write-Warning "Package file not found: $pkgFile"
}

# ============================================
# STEP 2: Build client
# ============================================
Write-Step "2/6" "Building client (Vite/React)"

if ($SkipBuild) {
    Write-Skip "Build skipped (-SkipBuild)"
} elseif ($DryRun) {
    Write-Dry "Would run: cd client && npm run build"
} else {
    Push-Location (Join-Path $RepoDir "client")
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Client build failed" }
        Write-Ok "Client built successfully"
    } finally {
        Pop-Location
    }
}

# ============================================
# STEP 3: Build binaries
# ============================================
Write-Step "3/6" "Building Windows + Linux binaries (esbuild + pkg)"

if ($SkipBuild) {
    Write-Skip "Build skipped (-SkipBuild)"
} elseif ($DryRun) {
    Write-Dry "Would run: npm run build:exe:all, then create ZomboidControlPanel-windows.zip"
} else {
    Push-Location $RepoDir
    try {
        npm run build:exe:all
        if ($LASTEXITCODE -ne 0) { throw "Binary build failed" }

        $winExe = Join-Path $RepoDir $WinExePath
        $linuxBin = Join-Path $RepoDir $LinuxBinPath
        $checksums = Join-Path $RepoDir $ChecksumsPath

        if (-not (Test-Path $winExe)) { throw "Windows binary not found at $winExe" }
        if (-not (Test-Path $linuxBin)) { throw "Linux binary not found at $linuxBin" }
        if (-not (Test-Path $checksums)) { throw "Checksums file not found at $checksums" }

        $winSize = [math]::Round((Get-Item $winExe).Length / 1MB, 1)
        $linuxSize = [math]::Round((Get-Item $linuxBin).Length / 1MB, 1)
        Write-Ok "Windows binary built: $winSize MB"
        Write-Ok "Linux binary built: $linuxSize MB"
        Write-Ok "Checksums and manifest generated"

        # Package Windows release archive (full folder with client/dist, pz-mod, scripts etc.)
        # Belt-and-braces: explicitly exclude data/db.json and data/backups so a stray
        # runtime database from local testing can never end up in a public release
        # (issue #5: clobbering users' admin/server config on extract).
        $zipPath = Join-Path $RepoDir $WinZipPath
        if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
        $releaseFolder = Join-Path $RepoDir $ReleaseDir
        $strayDb = Join-Path $releaseFolder "data\db.json"
        if (Test-Path $strayDb) {
            Write-Warn "Removing stray data\db.json from release\ before archiving"
            Remove-Item $strayDb -Force
        }
        $strayBackups = Join-Path $releaseFolder "data\backups"
        if (Test-Path $strayBackups) {
            Write-Warn "Removing stray data\backups\ from release\ before archiving"
            Remove-Item $strayBackups -Recurse -Force
        }
        Compress-Archive -Path "$releaseFolder\*" -DestinationPath $zipPath
        $zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
        Write-Ok "Windows archive created: ZomboidControlPanel-windows.zip ($zipSize MB)"

        # Package Linux release archive (tar.gz to preserve +x permissions)
        $tarPath = Join-Path $RepoDir $LinuxTarPath
        if (Test-Path $tarPath) { Remove-Item $tarPath -Force }
        Push-Location $releaseFolder
        tar -czf $tarPath --exclude="ZomboidControlPanel.exe" --exclude="ZomboidControlPanel-windows.zip" --exclude="ZomboidControlPanel-linux.tar.gz" --exclude="Start.bat" --exclude="data/db.json" --exclude="data/backups" *
        Pop-Location
        $tarSize = [math]::Round((Get-Item $tarPath).Length / 1MB, 1)
        Write-Ok "Linux archive created: ZomboidControlPanel-linux.tar.gz ($tarSize MB)"

        $releaseArtifacts = @(
            @{ platform = "win";   kind = "binary"; file = "ZomboidControlPanel.exe";          path = $winExe },
            @{ platform = "linux"; kind = "binary"; file = "ZomboidControlPanel";              path = $linuxBin },
            @{ platform = "win";   kind = "archive"; file = "ZomboidControlPanel-windows.zip"; path = $zipPath },
            @{ platform = "linux"; kind = "archive"; file = "ZomboidControlPanel-linux.tar.gz"; path = $tarPath },
            @{ platform = "docker"; kind = "compose"; file = "docker-compose.install.yml";     path = (Join-Path $RepoDir "docker-compose.install.yml") },
            @{ platform = "docker"; kind = "dockerfile"; file = "Dockerfile";                  path = (Join-Path $RepoDir "Dockerfile") }
        )

        $checksumLines = @()
        foreach ($artifact in $releaseArtifacts) {
            $hash = (Get-FileHash -Algorithm SHA256 -Path $artifact.path).Hash.ToLowerInvariant()
            $checksumLines += "$hash  $($artifact.file)"
        }
        Set-Content -Path $checksums -Value ($checksumLines -join "`n") -NoNewline
        Add-Content -Path $checksums -Value ""
        Write-Ok "Checksums updated for binaries + archives + Docker files"
    } finally {
        Pop-Location
    }

    # Post-build verification
    $clientDist = Join-Path $RepoDir "client\dist"
    if (-not (Test-Path $clientDist) -or (Get-ChildItem $clientDist -Recurse -File).Count -eq 0) {
        throw "Build verification failed: client/dist/ is empty or missing"
    }
    Write-Ok "Build verification passed (exe + client/dist validated)"
}

# ============================================
# STEP 4: Build Docker image
# ============================================
Write-Step "4/6" "Building Docker image"

if ($SkipDocker) {
    Write-Skip "Docker build skipped (-SkipDocker)"
} elseif ($DryRun) {
    Write-Dry "Would run: docker build -t zomboid-panel:$TagName"
} else {
    $dockerAvailable = Get-Command docker -ErrorAction SilentlyContinue
    if ($dockerAvailable) {
        Push-Location $RepoDir
        try {
            docker build -t "zomboid-panel:$TagName" -t "zomboid-panel:latest" .
            if ($LASTEXITCODE -ne 0) { throw "Docker build failed" }
            Write-Ok "Docker image built: zomboid-panel:$TagName"
        } finally {
            Pop-Location
        }
    } else {
        Write-Warn "Docker not found on PATH — skipping Docker build"
    }
}

# ============================================
# STEP 5: Git commit and push
# ============================================
Write-Step "5/6" "Committing and pushing to GitHub"

if ($SkipGitHub) {
    Write-Skip "GitHub push skipped (-SkipGitHub)"
} elseif ($DryRun) {
    Write-Dry "Would commit and push to $GitHubRepo"
} else {
    Push-Location $RepoDir
    try {
        git add -u

        # Check if there are changes to commit
        $status = git status --porcelain
        if ($status) {
            git commit -m "Release $TagName"
            if ($LASTEXITCODE -ne 0) { throw "Git commit failed" }

            git push
            if ($LASTEXITCODE -ne 0) { throw "Git push failed" }

            Write-Ok "Committed and pushed to GitHub"
        } else {
            Write-Ok "No changes to commit (already up to date)"
        }
    } finally {
        Pop-Location
    }
}

# ============================================
# STEP 6: Create GitHub Release with archives
# ============================================
Write-Step "6/6" "Creating GitHub Release $TagName"

if ($SkipGitHub) {
    Write-Skip "GitHub release skipped (-SkipGitHub)"
} elseif ($DryRun) {
    Write-Dry "Would create release $TagName on $GitHubRepo with all build artifacts"
} else {
    # Both raw binaries (.exe and the Linux ELF) are uploaded separately so the
    # in-app auto-updater can pull them directly — it refuses archives by design.
    # release-manifest.json is intentionally NOT published: nothing reads it at
    # runtime, it was pure noise for anyone doing a manual install.
    $assetPaths = @(
        (Join-Path $RepoDir $WinZipPath),
        (Join-Path $RepoDir $LinuxTarPath),
        (Join-Path $RepoDir $WinExePath),
        (Join-Path $RepoDir $LinuxBinPath),
        (Join-Path $RepoDir $ChecksumsPath),
        (Join-Path $RepoDir "docker-compose.install.yml"),
        (Join-Path $RepoDir "Dockerfile")
    )

    foreach ($asset in $assetPaths) {
        if (-not (Test-Path $asset)) {
            throw "Required release asset missing: $asset"
        }
    }

    # Build gh release command
    $ghArgs = @(
        "release", "create", $TagName,
        "--repo", $GitHubRepo,
        "--title", $ReleaseTitle,
        "--latest"
    )

    # Add release notes
    if ($ReleaseNotes -and (Test-Path $ReleaseNotes)) {
        $ghArgs += "--notes-file"
        $ghArgs += $ReleaseNotes
    } else {
        # Auto-generate Keep a Changelog format from commit messages
        $lastTag = git -C $RepoDir tag --sort=-creatordate | Select-Object -First 1
        if ($lastTag -and $lastTag -ne $TagName) {
            $log = git -C $RepoDir log "$lastTag..HEAD" --format="%s" --no-merges 2>$null

            # Categorize commits by prefix
            $added = @()
            $fixed = @()
            $changed = @()
            $removed = @()
            $deprecated = @()
            $security = @()
            $breaking = @()
            $skipped = @("docs:", "chore:", "style:")

            if ($log) {
                foreach ($line in $log) {
                    $msg = $line.Trim()
                    # Skip docs/chore/style commits
                    $skip = $false
                    foreach ($prefix in $skipped) {
                        if ($msg -match "^${prefix}") { $skip = $true; break }
                    }
                    if ($skip) { continue }

                    # Strip prefix and categorize
                    if ($msg -match "^breaking:\s*(.+)") { $breaking += $Matches[1] }
                    elseif ($msg -match "^feat:\s*(.+)")     { $added += $Matches[1] }
                    elseif ($msg -match "^add:\s*(.+)")      { $added += $Matches[1] }
                    elseif ($msg -match "^fix:\s*(.+)")      { $fixed += $Matches[1] }
                    elseif ($msg -match "^security:\s*(.+)") { $security += $Matches[1] }
                    elseif ($msg -match "^remove:\s*(.+)")   { $removed += $Matches[1] }
                    elseif ($msg -match "^deprecate:\s*(.+)"){ $deprecated += $Matches[1] }
                    elseif ($msg -match "^change:\s*(.+)")   { $changed += $Matches[1] }
                    elseif ($msg -match "^refactor:\s*(.+)") { $changed += $Matches[1] }
                    elseif ($msg -match "^perf:\s*(.+)")     { $changed += $Matches[1] }
                    else { $changed += $msg }
                }
            }

            # Build Keep a Changelog format
            $autoNotes = "## $ReleaseTitle`n"
            if ($breaking.Count -gt 0) {
                $autoNotes += "`n### BREAKING CHANGES`n"
                foreach ($item in $breaking) { $autoNotes += "- $item`n" }
            }
            if ($added.Count -gt 0) {
                $autoNotes += "`n### Added`n"
                foreach ($item in $added) { $autoNotes += "- $item`n" }
            }
            if ($changed.Count -gt 0) {
                $autoNotes += "`n### Changed`n"
                foreach ($item in $changed) { $autoNotes += "- $item`n" }
            }
            if ($fixed.Count -gt 0) {
                $autoNotes += "`n### Fixed`n"
                foreach ($item in $fixed) { $autoNotes += "- $item`n" }
            }
            if ($removed.Count -gt 0) {
                $autoNotes += "`n### Removed`n"
                foreach ($item in $removed) { $autoNotes += "- $item`n" }
            }
            if ($deprecated.Count -gt 0) {
                $autoNotes += "`n### Deprecated`n"
                foreach ($item in $deprecated) { $autoNotes += "- $item`n" }
            }
            if ($security.Count -gt 0) {
                $autoNotes += "`n### Security`n"
                foreach ($item in $security) { $autoNotes += "- $item`n" }
            }
            $autoNotes += "`n---`n"
            $autoNotes += "`n### Downloads`n"
            $autoNotes += "- **ZomboidControlPanel-windows.zip** \u2014 Windows full package (extract and run Start.bat)`n"
            $autoNotes += "- **ZomboidControlPanel-linux.tar.gz** \u2014 Linux full package (extract and run ./start.sh)`n"
            $autoNotes += "- **checksums.txt** \u2014 SHA256 verification hashes`n"
            $ghArgs += "--notes"
            $ghArgs += $autoNotes
        } else {
            $ghArgs += "--generate-notes"
        }
    }

    # Add release assets
    $ghArgs += $assetPaths

    & gh @ghArgs

    if ($LASTEXITCODE -ne 0) {
        Write-Warning "GitHub release creation failed. You can retry with:"
        Write-Host "  gh release create $TagName --repo $GitHubRepo --title `"$ReleaseTitle`" --prerelease <asset paths>" -ForegroundColor Yellow
    } else {
        Write-Ok "GitHub Release $TagName created with all assets uploaded"
    }
}

# ============================================
# DONE
# ============================================
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host " Release $TagName complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host " Checklist:" -ForegroundColor White
Write-Host "   [x] Pre-flight checks passed" -ForegroundColor Green
if (-not $SkipBuild)  { Write-Host "   [x] Client built" -ForegroundColor Green }
if (-not $SkipBuild)  { Write-Host "   [x] Windows + Linux binaries created" -ForegroundColor Green }
if (-not $SkipBuild)  { Write-Host "   [x] Windows + Linux archives packaged" -ForegroundColor Green }
if (-not $SkipDocker) { Write-Host "   [x] Docker image built" -ForegroundColor Green }
if (-not $SkipGitHub) { Write-Host "   [x] Pushed to GitHub" -ForegroundColor Green }
if (-not $SkipGitHub) { Write-Host "   [x] GitHub Release created (Keep a Changelog format)" -ForegroundColor Green }
Write-Host ""
Write-Host " Note: live deployment to production (Docker on the game host) is" -ForegroundColor DarkGray
Write-Host " a separate manual step, not part of this script." -ForegroundColor DarkGray
Write-Host ""
