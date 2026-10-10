import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const RELEASE_SCRIPT = path.join(repoRoot, "release.ps1");
const FUNCTIONS_HARNESS = path.join(__dirname, "fixtures", "releaseFunctionsHarness.ps1");

// release.ps1 used to:
//  - bump the version files in step 1 and only then, in step 4, find out that
//    Docker was not running ("Docker build failed" after minutes of building);
//  - leave those rewritten files behind when any of steps 1-4 failed, so the
//    next run stopped at "Working tree is dirty";
//  - commit locally without checking that origin/main had not moved while it
//    built, leaving a "Release vX" commit that cannot be pushed;
//  - start a real run with -SkipGitHub from any branch.
// The static tests below read release.ps1 itself; the behaviour tests run its
// own functions, and the whole script against a throwaway clone, in pwsh.

const script = fs.readFileSync(RELEASE_SCRIPT, "utf8").replace(/\r\n/g, "\n");

function indexOfOrFail(needle) {
  const at = script.indexOf(needle);
  expect(at, `release.ps1 should contain: ${needle}`).toBeGreaterThan(-1);
  return at;
}

function bumpFiles() {
  const block = script.match(/\$ReleaseBumpFiles = @\(\n([\s\S]*?)\n\)/);
  expect(block, "release.ps1 should define $ReleaseBumpFiles").not.toBeNull();
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("release.ps1 pre-flight and restore (what the script text guarantees)", () => {
  it("restores every tracked file STEP 1 writes, plus the bridge version lock", () => {
    const step1 = script.slice(indexOfOrFail("# STEP 1: Bump version"), indexOfOrFail("# STEP 2: Build client"));
    const written = [...step1.matchAll(/WriteAllText\(\$(\w+),/g)].map((match) => match[1]);
    // A new write in STEP 1 has to be added here, and to $ReleaseBumpFiles.
    expect([...new Set(written)].sort()).toEqual(
      ["bridgeLuaPath", "bridgeModInfoPath", "clientLockFile", "clientPkgFile", "pkgFile", "rootLockFile"],
    );

    const listed = bumpFiles();
    for (const variable of written) {
      const definition = script.match(new RegExp(`\\$${variable}\\s*=\\s*Join-Path \\$RepoDir "([^"]+)"`));
      expect(definition, `${variable} should be a Join-Path $RepoDir "<file>"`).not.toBeNull();
      expect(listed).toContain(definition[1].replace(/\\/g, "/"));
    }
    expect(step1).toContain("--write-lock");
    expect(listed).toContain("pz-mod/bridge-version.lock.json");
    for (const file of listed) {
      expect(fs.existsSync(path.join(repoRoot, file)), `${file} should exist in the repo`).toBe(true);
    }
  });

  it("refuses to run from another branch before anything is fetched or written", () => {
    const branchCheck = indexOfOrFail("Assert-ReleaseBranch $currentBranch $DryRun");
    expect(branchCheck).toBeGreaterThan(indexOfOrFail("# STEP 0: Pre-flight checks"));
    expect(branchCheck).toBeLessThan(indexOfOrFail("git fetch origin main --quiet"));
    expect(branchCheck).toBeLessThan(indexOfOrFail("WriteAllText($pkgFile"));
    // Only a dry run (which writes nothing) is exempt; -SkipGitHub is not.
    expect(script).toMatch(/function Assert-ReleaseBranch\(\$branch, \$isDryRun\) \{\n {4}if \(\$isDryRun\) \{ return \}\n/);
  });

  it("checks that Docker answers in STEP 0, unless -SkipDocker or -DryRun", () => {
    const call = script.match(/if \(-not \$SkipDocker -and -not \$DryRun\) \{\n {4}Assert-DockerReady\n\}/);
    expect(call).not.toBeNull();
    expect(call.index).toBeGreaterThan(indexOfOrFail("# STEP 0: Pre-flight checks"));
    expect(call.index).toBeLessThan(indexOfOrFail("# STEP 1: Bump version"));

    const body = script.slice(indexOfOrFail("function Assert-DockerReady"), indexOfOrFail("function Restore-ReleaseBumpFiles"));
    expect(body).toContain("docker info");
    expect(body).toContain("-SkipDocker");
    expect(body).toContain("Start Docker");
  });

  it("restores on any way out of steps 1-4, and re-checks origin/main right before STEP 5", () => {
    const tryAt = indexOfOrFail("$releaseStepsDone = $false\ntry {");
    expect(tryAt).toBeLessThan(indexOfOrFail("# STEP 1: Bump version"));

    const recheck = indexOfOrFail("Assert-OriginMainUnchanged $RepoDir $originMainCommit");
    expect(recheck).toBeGreaterThan(indexOfOrFail("# STEP 4: Build Docker image"));
    expect(recheck).toBeLessThan(indexOfOrFail("$releaseStepsDone = $true"));

    const finallyAt = indexOfOrFail("} finally {\n    if (-not $releaseStepsDone");
    expect(finallyAt).toBeGreaterThan(indexOfOrFail("$releaseStepsDone = $true"));
    expect(finallyAt).toBeLessThan(indexOfOrFail("# STEP 5: Git commit and push"));
    const finallyBlock = script.slice(finallyAt, indexOfOrFail("# STEP 5: Git commit and push"));
    expect(finallyBlock).toContain("Restore-ReleaseBumpFiles $RepoDir $ReleaseBumpFiles");
    expect(finallyBlock).toContain("-not $DryRun");
  });
});

function hasPwsh() {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return probe.status === 0;
}

// pwsh only (release.ps1 needs PowerShell 7), and Windows only like the other
// release.ps1 tests: the Docker stand-in below is a .cmd file.
const powershell = process.platform === "win32" && hasPwsh() ? "pwsh" : null;

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function git(cwd, ...args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${run.stdout}\n${run.stderr}`);
  return run.stdout.trim();
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

(powershell ? describe : describe.skip)("release.ps1 functions (run in pwsh)", () => {
  const cleanup = [];

  afterAll(() => {
    for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  });

  function tempDir(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zcp-release-${label}-`));
    cleanup.push(dir);
    return dir;
  }

  function runBody(body) {
    const dir = tempDir("body");
    const bodyPath = path.join(dir, "body.ps1");
    fs.writeFileSync(bodyPath, body);
    const run = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        FUNCTIONS_HARNESS,
        "-ReleaseScript",
        RELEASE_SCRIPT,
        "-BodyPath",
        bodyPath,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 60000 },
    );
    const out = stripAnsi(`${run.stdout}\n${run.stderr}`);
    const results = [...out.matchAll(/^RESULT:(.*)$/gm)].map((match) => match[1].trim());
    return { status: run.status, out, results };
  }

  function initRepo(dir) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "release-test@example.com");
    git(dir, "config", "user.name", "Release Test");
    git(dir, "config", "core.autocrlf", "false");
  }

  it("Assert-ReleaseBranch: main passes, any other branch (or a detached HEAD) throws, a dry run is exempt", () => {
    const { status, results } = runBody(`
foreach ($case in @(@('main', $false), @('feature/x', $false), @('', $false), @('feature/x', $true))) {
    try { Assert-ReleaseBranch $case[0] $case[1]; Write-Output 'RESULT:ok' }
    catch { Write-Output ('RESULT:' + $_.Exception.Message) }
}
`);

    expect(status).toBe(0);
    expect(results).toHaveLength(4);
    expect(results[0]).toBe("ok");
    expect(results[1]).toMatch(/must be run from the main branch; current branch is 'feature\/x'/);
    expect(results[1]).toContain("-DryRun");
    expect(results[2]).toMatch(/must be run from the main branch; current branch is ''/);
    expect(results[3]).toBe("ok");
  });

  it("Assert-DockerReady: throws a message naming docker info and -SkipDocker when the daemon does not answer", () => {
    const { status, results } = runBody(`
function docker { $global:LASTEXITCODE = 1 }
try { Assert-DockerReady; Write-Output 'RESULT:ok' }
catch { Write-Output ('RESULT:' + $_.Exception.Message) }
function docker { $global:LASTEXITCODE = 0 }
try { Assert-DockerReady; Write-Output 'RESULT:ok' }
catch { Write-Output ('RESULT:' + $_.Exception.Message) }
`);

    expect(status).toBe(0);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatch(/'docker info' failed/);
    expect(results[0]).toContain("-SkipDocker");
    expect(results[0]).toContain("Nothing was changed");
    expect(results[1]).toBe("ok");
  });

  it("Restore-ReleaseBumpFiles: puts back listed tracked files that changed, leaves every other file alone", () => {
    const repo = tempDir("restore");
    initRepo(repo);
    fs.mkdirSync(path.join(repo, "client"));
    fs.writeFileSync(path.join(repo, "package.json"), '{"version": "1.0.0"}\n');
    fs.writeFileSync(path.join(repo, "client", "package.json"), '{"version": "1.0.0"}\n');
    fs.writeFileSync(path.join(repo, "notes.txt"), "original\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");

    fs.writeFileSync(path.join(repo, "package.json"), '{"version": "9.9.9"}\n');
    fs.writeFileSync(path.join(repo, "notes.txt"), "edited by hand\n");
    // Listed but never committed: not the bump's to remove.
    fs.mkdirSync(path.join(repo, "pz-mod"));
    fs.writeFileSync(path.join(repo, "pz-mod", "bridge-version.lock.json"), "untracked\n");

    const { status, results } = runBody(`
$restored = @(Restore-ReleaseBumpFiles ${psQuote(repo)} @('package.json', 'client/package.json', 'pz-mod/bridge-version.lock.json'))
Write-Output ('RESULT:' + ($restored -join ','))
`);

    expect(status).toBe(0);
    expect(results).toEqual(["package.json"]);
    expect(fs.readFileSync(path.join(repo, "package.json"), "utf8")).toBe('{"version": "1.0.0"}\n');
    expect(fs.readFileSync(path.join(repo, "notes.txt"), "utf8")).toBe("edited by hand\n");
    expect(fs.readFileSync(path.join(repo, "pz-mod", "bridge-version.lock.json"), "utf8")).toBe("untracked\n");
  });

  describe("Assert-OriginMainUnchanged", () => {
    function setupOrigin() {
      const root = tempDir("origin");
      const origin = path.join(root, "origin.git");
      const work = path.join(root, "work");
      fs.mkdirSync(origin);
      git(origin, "init", "-q", "--bare", "-b", "main");
      fs.mkdirSync(work);
      initRepo(work);
      fs.writeFileSync(path.join(work, "file.txt"), "one\n");
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", "one");
      git(work, "remote", "add", "origin", origin);
      git(work, "push", "-q", "origin", "main");
      return { root, origin, work, head: git(work, "rev-parse", "HEAD") };
    }

    const check = (work, expected) =>
      runBody(`
try { Assert-OriginMainUnchanged ${psQuote(work)} ${psQuote(expected)}; Write-Output 'RESULT:ok' }
catch { Write-Output ('RESULT:' + $_.Exception.Message) }
`);

    it("passes while origin/main is still where the release started", () => {
      const { work, head } = setupOrigin();

      const { status, results } = check(work, head);

      expect(status).toBe(0);
      expect(results).toEqual(["ok"]);
    });

    it("throws, naming both commits, when someone pushed to main meanwhile", () => {
      const { root, origin, work, head } = setupOrigin();
      const other = path.join(root, "other");
      git(root, "clone", "-q", origin, other);
      git(other, "config", "user.email", "other@example.com");
      git(other, "config", "user.name", "Other");
      fs.writeFileSync(path.join(other, "file.txt"), "two\n");
      git(other, "commit", "-q", "-am", "two");
      git(other, "push", "-q", "origin", "main");
      const moved = git(other, "rev-parse", "HEAD");

      const { status, results } = check(work, head);

      expect(status).toBe(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toContain(`moved from ${head} to ${moved}`);
      expect(results[0]).toContain("Nothing was committed or pushed");
      expect(results[0]).toContain("Pull main");
    });
  });
});

(powershell ? describe : describe.skip)("release.ps1 end to end, in a throwaway clone", () => {
  let base;
  let repo;
  const PANEL_VERSION = "9.9.9";

  // A shallow clone of this checkout with the working-tree release.ps1 laid
  // over it, on main, with a CHANGELOG heading for the version the runs use.
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-release-e2e-"));
    repo = path.join(base, "repo");
    git(base, "clone", "-q", "--depth", "1", "--no-hardlinks", pathToFileURL(repoRoot).href, repo);
    git(repo, "config", "user.email", "release-test@example.com");
    git(repo, "config", "user.name", "Release Test");
    git(repo, "checkout", "-q", "-B", "main");
    fs.copyFileSync(RELEASE_SCRIPT, path.join(repo, "release.ps1"));
    const changelogPath = path.join(repo, "CHANGELOG.md");
    const changelog = fs.readFileSync(changelogPath, "utf8");
    const eol = changelog.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(
      changelogPath,
      changelog.replace(
        "## [Unreleased]",
        ["## [Unreleased]", "", `## [${PANEL_VERSION}] - 2026-01-01`, "", "### Fixed", "", "- A fixture entry."].join(eol),
      ),
    );
    git(repo, "commit", "-q", "-am", "fixture");
    // A Docker whose daemon is not running: `docker info` exits 1.
    fs.mkdirSync(path.join(base, "stopped-docker"));
    fs.writeFileSync(path.join(base, "stopped-docker", "docker.cmd"), "@echo off\r\nexit /b 1\r\n");
  }, 120000);

  afterAll(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  });

  beforeEach(() => {
    git(repo, "checkout", "-q", "-f", "main");
    git(repo, "reset", "-q", "--hard", "HEAD");
  });

  function release(args, { stoppedDocker = false } = {}) {
    const env = { ...process.env };
    if (stoppedDocker) {
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
      env[pathKey] = `${path.join(base, "stopped-docker")}${path.delimiter}${env[pathKey] || ""}`;
    }
    const run = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "release.ps1", ...args],
      { cwd: repo, env, encoding: "utf8", windowsHide: true, timeout: 120000 },
    );
    // PowerShell wraps an error message at the console width and starts each
    // wrapped line with a "|" gutter; undo both so a message reads as written.
    const out = stripAnsi(`${run.stdout}\n${run.stderr}`).replace(/\s+/g, " ").replace(/ \| /g, " ");
    return { status: run.status, out };
  }

  const treeStatus = () => git(repo, "status", "--porcelain");
  const packageJson = () => fs.readFileSync(path.join(repo, "package.json"), "utf8");

  it("puts the version bump back when a later step fails, leaving a clean tree", () => {
    const before = packageJson();

    // No release/ folder was built, so the artifact check after STEP 3 throws
    // -- after STEP 1 has rewritten the version files.
    const { status, out } = release(["-Version", PANEL_VERSION, "-SkipBuild", "-SkipDocker", "-SkipGitHub"]);

    expect(status).not.toBe(0);
    expect(out).toContain(`Bumping version to ${PANEL_VERSION}`);
    expect(out).toContain("Release manifest not found");
    expect(out).toContain("Restored the files the version bump rewrote");
    expect(treeStatus()).toBe("");
    expect(packageJson()).toBe(before);
  }, 120000);

  it("stops in STEP 0, before the bump, when Docker is installed but does not answer", () => {
    const { status, out } = release(["-Version", PANEL_VERSION, "-SkipBuild", "-SkipGitHub"], { stoppedDocker: true });

    expect(status).not.toBe(0);
    expect(out).toContain("'docker info' failed");
    expect(out).toContain("-SkipDocker");
    expect(out).not.toContain("[1/6]");
    expect(treeStatus()).toBe("");
  }, 120000);

  it("refuses to start from another branch, even with -SkipGitHub, before the bump", () => {
    git(repo, "checkout", "-q", "-B", "feature/not-main");

    const { status, out } = release(["-Version", PANEL_VERSION, "-SkipBuild", "-SkipDocker", "-SkipGitHub"]);

    expect(status).not.toBe(0);
    expect(out).toContain("Releases must be run from the main branch; current branch is 'feature/not-main'");
    expect(out).not.toContain("[1/6]");
    expect(treeStatus()).toBe("");
  }, 120000);

  it("still lets a dry run preview a release from another branch, writing nothing", () => {
    git(repo, "checkout", "-q", "-B", "feature/not-main");

    const { status, out } = release(["-Version", PANEL_VERSION, "-SkipBuild", "-SkipDocker", "-DryRun"]);

    expect(status).toBe(0);
    expect(out).toContain("Dry run on branch 'feature/not-main'");
    expect(treeStatus()).toBe("");
  }, 120000);
});
