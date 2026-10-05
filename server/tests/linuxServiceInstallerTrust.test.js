import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  LINUX_SERVICE_INSTALLER_PATH,
  getRestartAssessment,
} from "../services/panelUpdateChecker.js";

// DOCKER-1 (security sweep 2026-10-04): docs/install/linux.md had root run
// /opt/zomboid-panel/install-linux-service.sh after `chown -R pzuser` of that
// folder, and the panel itself handed out `sudo <panel folder>/install-
// linux-service.sh --enable` as a remediation command. The service account
// (or anything running as it: the panel, its updater, a game server) could
// rewrite the installer, rewrite the unit template it installs (User=root plus
// an ExecStartPre payload), or swap files for symlinks that root then chmod-ed
// and copied: root escalation on the operator's next run.
//
// The installer now installs the unit stored next to it, refuses to run unless
// it, that unit and every folder above them are root-owned and writable only
// by root, and never changes files in the panel folder. The docs and the
// panel's remediation command point at a root-owned copy outside the panel
// folder.

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative) => fs.readFileSync(path.join(REPO, relative), "utf8");
const HARNESS = path.join(REPO, "server/tests/fixtures/linuxServiceInstallerTrust.sh");
const PANEL_DIR = "/opt/zomboid-panel";

describe("Linux service installer trusts only root-owned inputs", () => {
  it("installs the unit stored next to the installer, never the panel folder's copy", () => {
    const installer = read("install-linux-service.sh");
    expect(installer).toContain("UNIT_SOURCE=$SCRIPT_DIR/zomboid-panel.service");
    expect(installer).not.toContain("$INSTALL_DIR/zomboid-panel.service");
  });

  it("never changes files in the service account's folder (chmod/cp/install follow planted symlinks)", () => {
    const installer = read("install-linux-service.sh");
    expect(installer).not.toMatch(/^\s*(chmod|chown|ln|mv|rm)\b/m);
    for (const line of installer.split("\n")) {
      if (/^\s*(cp|install)\b/.test(line)) {
        expect(line).not.toContain("$INSTALL_DIR");
      }
    }
  });

  it("checks ownership and write bits of its own folder chain before using anything in it", () => {
    const installer = read("install-linux-service.sh");
    expect(installer).toContain(`TRUSTED_DIR=${path.posix.dirname(LINUX_SERVICE_INSTALLER_PATH)}`);
    expect(installer).toMatch(/require_root_only "\$dir" dir/);
    expect(installer).toMatch(/require_root_only "\$UNIT_SOURCE" file/);
    expect(installer).toContain('if [ -L "$1" ]');
  });

  it("hands operators the root-owned installer, not the copy in the panel folder", () => {
    const assessment = getRestartAssessment({
      platform: "linux",
      packaged: true,
      environment: { INVOCATION_ID: "service-run" },
      launcherProtected: false,
      exeDir: PANEL_DIR,
    });
    expect(assessment.gameServers).toBe("at-risk");
    expect(assessment.remediationCommand).toBe(`sudo ${LINUX_SERVICE_INSTALLER_PATH} --enable`);
    expect(assessment.remediationCommand).not.toContain(PANEL_DIR);
    expect(LINUX_SERVICE_INSTALLER_PATH.startsWith(`${PANEL_DIR}/`)).toBe(false);
  });

  it("documents the root-owned copy and never has root run the panel folder's installer", () => {
    const doc = read("docs/install/linux.md");
    expect(doc).toContain(`sudo ${LINUX_SERVICE_INSTALLER_PATH} --enable`);
    expect(doc).not.toMatch(
      /^\s*(sudo\s+)?(\.\/|\/opt\/zomboid-panel\/)install-linux-service\.sh/m,
    );
  });

  it("ships a unit that keeps the panel's new files private to the service account", () => {
    expect(read("zomboid-panel.service")).toMatch(/^UMask=0077$/m);
  });
});

// The real thing: the verifier's exploit scenarios run against the real
// installer as root, in a private mount namespace (see the harness header).
// Needs root on Linux, so CI's unprivileged runner skips it; run it by hand
// with `sudo bash server/tests/fixtures/linuxServiceInstallerTrust.sh "$PWD"`.
function hasTool(name) {
  return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}
const CAN_RUN_REAL_INSTALLER =
  process.platform === "linux" &&
  typeof process.getuid === "function" &&
  process.getuid() === 0 &&
  ["unshare", "setpriv", "stat", "install", "cmp", "getent", "sha256sum"].every(hasTool) &&
  fs.existsSync("/etc/systemd/system") &&
  fs.existsSync("/usr/local/lib");

describe("Linux service installer against the verified exploits (root only)", () => {
  it.skipIf(!CAN_RUN_REAL_INSTALLER)(
    "resists unit rewrites, installer rewrites and planted symlinks by the service account",
    () => {
      let output;
      try {
        output = execFileSync("bash", [HARNESS, REPO], {
          encoding: "utf8",
          timeout: 120_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        throw new Error(`installer trust harness failed:\n${error.stdout}${error.stderr}`);
      }
      expect(output).not.toMatch(/^FAIL /m);
      expect(output).toContain("all checks passed");
    },
  );
});
