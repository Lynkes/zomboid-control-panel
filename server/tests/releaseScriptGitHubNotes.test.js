import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const RELEASE_SCRIPT = path.join(repoRoot, "release.ps1");
const HARNESS = path.join(__dirname, "fixtures", "releaseGitHubStepHarness.ps1");

// release.ps1 step 6 used to hand gh the whole CHANGELOG section inline
// (`--notes <text>`). Windows caps a command line at 32,767 characters, and
// 1.4.0's section alone is about 28K, so a few more bullets would stop gh from
// starting at all -- after step 5 had already pushed main -- and the launch
// error, thrown under ErrorActionPreference=Stop, skipped the retry hint.
// The harness runs release.ps1's own step 6 (found in its syntax tree) with
// gh and git stubbed, then starts a real process with the arguments gh got.

// pwsh only: Windows PowerShell 5.1 reads release.ps1's UTF-8 em dashes as
// ANSI and can't parse the script at all, so releases already need pwsh 7.
function hasPwsh() {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return probe.status === 0;
}

const powershell = process.platform === "win32" && hasPwsh() ? "pwsh" : null;

// Well past the Windows limit, with the characters that would break naive
// quoting: double quotes, $, backticks.
function longSection() {
  const bullet =
    '- **A long "quoted" change with $dollar and `backtick` text.** ' +
    "It keeps going for a while so the section grows the way 1.4.0's did. ".repeat(4);
  const bullets = [];
  let length = 0;
  while (length < 40000) {
    bullets.push(bullet);
    length += bullet.length + 1;
  }
  return `### Added\n\n${bullets.join("\n")}`;
}

function changelog({ withSection }) {
  const section = withSection ? `## [1.4.0] - 2026-09-28\n\n${longSection()}\n\n` : "";
  return (
    "# Changelog\n\n## [Unreleased]\n\n_No unreleased changes._\n\n" +
    section +
    "## [1.3.8] - 2026-09-01\n\n### Fixed\n\n- An older fix.\n"
  );
}

(powershell ? describe : describe.skip)("release.ps1 GitHub Release step", () => {
  const cleanup = [];

  afterEach(() => {
    for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
  });

  function runStep({ ghMode, withSection = true }) {
    // A space and an apostrophe in every asset path, so the printed retry
    // command has to quote them the way PowerShell reads them back.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp release's step6-"));
    cleanup.push(fixtureDir);
    fs.mkdirSync(path.join(fixtureDir, "release"));
    for (const asset of [
      "release/ZomboidControlPanel.exe",
      "release/ZomboidControlPanel",
      "release/ZomboidControlPanel-windows.zip",
      "release/ZomboidControlPanel-linux.tar.gz",
      "release/checksums.txt",
      "release/zomboid-panel-extension.zip",
      "docker-compose.install.yml",
      "Dockerfile",
    ]) {
      fs.writeFileSync(path.join(fixtureDir, asset), "x");
    }
    fs.writeFileSync(path.join(fixtureDir, "CHANGELOG.md"), changelog({ withSection }));
    const resultPath = path.join(fixtureDir, "result.json");

    const run = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        HARNESS,
        "-ReleaseScript",
        RELEASE_SCRIPT,
        "-FixtureDir",
        fixtureDir,
        "-GhMode",
        ghMode,
        "-ResultPath",
        resultPath,
        "-NodePath",
        process.execPath,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 60000 },
    );
    if (!fs.existsSync(resultPath)) {
      throw new Error(`harness wrote no result (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
    }
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const notesFile = result.ghCall?.notesFile;
    if (notesFile && notesFile.startsWith(os.tmpdir())) cleanup.push(notesFile);
    return result;
  }

  it("hands gh the CHANGELOG section as a file, so gh can start however long the section is", () => {
    const result = runStep({ ghMode: "ok" });

    expect(result.stepError).toBeNull();
    const args = result.ghCall.args;
    expect(args).not.toContain("--notes");
    expect(args).toContain("--notes-file");
    expect(Math.max(...args.map((arg) => arg.length))).toBeLessThan(1024);
    expect(result.launchError).toBeNull();

    const notes = result.ghCall.notesFileText.replace(/\r\n/g, "\n");
    expect(notes.startsWith(`## v1.4.0\n\n${longSection()}\n\n---\n`)).toBe(true);
    expect(notes).toContain("- **checksums.txt** — SHA256 verification hashes");
    expect(notes).toContain(
      "**Full Changelog**: https://github.com/example/zomboid-control-panel/compare/v1.3.8...v1.4.0",
    );

    expect(result.githubReleaseFailed).toBe(false);
    // The generated notes file is removed once the release exists.
    expect(result.notesFileExistsAfter).toBe(false);
  });

  it("passes the commit-log notes as a file too when CHANGELOG has no section for the version", () => {
    const result = runStep({ ghMode: "ok", withSection: false });

    expect(result.stepError).toBeNull();
    expect(result.ghCall.args).not.toContain("--notes");
    expect(result.ghCall.args).toContain("--notes-file");
    const notes = result.ghCall.notesFileText.replace(/\r\n/g, "\n");
    expect(notes).toContain("### Fixed\n- keep the notes out of the command line\n");
    expect(notes).toContain("### Added\n- a new thing\n");
  });

  it.each([
    ["cannot start", "throw"],
    ["exits with an error", "exit"],
  ])("when gh %s, prints the exact command that finishes the release and keeps its notes", (_label, ghMode) => {
    const result = runStep({ ghMode });

    expect(result.stepError).toBeNull();
    expect(result.githubReleaseFailed).toBe(true);
    expect(result.notesFileExistsAfter).toBe(true);
    // Pasted into PowerShell, the printed line runs gh with the same
    // arguments, --latest, --target and the notes file included.
    expect(result.retryArgs).toEqual(result.ghCall.args);
  });
});
