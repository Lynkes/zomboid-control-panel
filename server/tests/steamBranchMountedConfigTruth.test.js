import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-09-18, continuous-bug-hunt round 11 (card "SteamCMD branch truth"):
// appmanifest_380870.acf can carry "BetaKey" in TWO separate blocks --
// "UserConfig" (the branch the operator last REQUESTED, written the instant
// `-beta X` runs, even before any bytes download) and "MountedConfig" (the
// branch actually mounted/on disk right now). Confirmed against a real
// appmanifest_380870.acf (D:/pz-verify/server/steamapps/) that UserConfig
// appears BEFORE MountedConfig in the file. Both
// UpdateChecker.getInstalledBuildInfo() (services/updateChecker.js) and
// debug.js's buildPzBuildInfo() used to read BetaKey with an unscoped regex
// that matches the FIRST occurrence in the file -- i.e. UserConfig's
// requested branch, not what's actually installed. That "installed.branch"
// value then feeds getLatestBuildInfo()'s branch argument AND
// runAutoUpdate()'s own -beta flag, so right after an operator switches
// branch (before the next update completes, or if it fails partway),
// auto-update would silently query and reinstall the OLD branch while
// believing it was already on the new one -- the update-available UI would
// also misreport which branch is actually running. Fixed by scoping the
// regex to the "MountedConfig" block only, matching
// routes/server.js's own recoverMismatchedSteamBranchManifest(), which
// already got this right.

import { UpdateChecker } from "../services/updateChecker.js";
import { buildPzBuildInfo } from "../routes/debug.js";

function manifestWithMismatchedBranches({ userBranch, mountedBranch, buildId = "24775771" }) {
  // Matches the real field order/order-of-blocks confirmed on disk: UserConfig
  // before MountedConfig, both scoped with their own braces.
  return [
    '"AppState"',
    "{",
    '\t"appid"\t\t"380870"',
    '\t"buildid"\t\t"' + buildId + '"',
    '\t"LastUpdated"\t\t"1787001326"',
    '\t"UserConfig"',
    "\t{",
    '\t\t"BetaKey"\t\t"' + userBranch + '"',
    "\t}",
    '\t"MountedConfig"',
    "\t{",
    '\t\t"BetaKey"\t\t"' + mountedBranch + '"',
    "\t}",
    "}",
    "",
  ].join("\n");
}

describe("appmanifest branch truth: MountedConfig, not UserConfig", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-branch-truth-"));
    fs.mkdirSync(path.join(tmpDir, "steamapps"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(content) {
    fs.writeFileSync(
      path.join(tmpDir, "steamapps", "appmanifest_380870.acf"),
      content,
    );
  }

  it("UpdateChecker.getInstalledBuildInfo() reports the MOUNTED branch, not the requested one, when they diverge", async () => {
    writeManifest(
      manifestWithMismatchedBranches({ userBranch: "unstable", mountedBranch: "public" }),
    );
    const checker = new UpdateChecker({ emit: () => {} }, {});
    const info = await checker.getInstalledBuildInfo(tmpDir);
    expect(info.branch).toBe("public");
    expect(info.buildId).toBe("24775771");
  });

  it("UpdateChecker.getInstalledBuildInfo() still reports the requested branch once it matches what's mounted", async () => {
    writeManifest(
      manifestWithMismatchedBranches({ userBranch: "unstable", mountedBranch: "unstable" }),
    );
    const checker = new UpdateChecker({ emit: () => {} }, {});
    const info = await checker.getInstalledBuildInfo(tmpDir);
    expect(info.branch).toBe("unstable");
  });

  it("debug.js buildPzBuildInfo() reports the MOUNTED branch, not the requested one, when they diverge", async () => {
    writeManifest(
      manifestWithMismatchedBranches({ userBranch: "unstable", mountedBranch: "public" }),
    );
    const info = await buildPzBuildInfo({ installPath: tmpDir });
    expect(info.available).toBe(true);
    expect(info.branch).toBe("public");
  });

  it("falls back to public when MountedConfig has no BetaKey at all (never opted into a beta)", async () => {
    writeManifest(
      [
        '"AppState"',
        "{",
        '\t"appid"\t\t"380870"',
        '\t"buildid"\t\t"24775771"',
        '\t"UserConfig"',
        "\t{",
        "\t}",
        '\t"MountedConfig"',
        "\t{",
        "\t}",
        "}",
        "",
      ].join("\n"),
    );
    const checker = new UpdateChecker({ emit: () => {} }, {});
    const info = await checker.getInstalledBuildInfo(tmpDir);
    expect(info.branch).toBe("public");
  });
});
