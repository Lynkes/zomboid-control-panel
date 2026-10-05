import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_SERVICE_INSTALLER_PATH,
  PanelUpdateChecker,
  linuxServiceReinstallGuidance,
} from "../services/panelUpdateChecker.js";

// DOCKER-1 residual (security sweep 2026-10-04, adversary pass): the
// installer and docs were fixed to run only a root-owned copy of
// install-linux-service.sh, but the self-updater's activation-FAILURE log in
// server/index.js still said `Run: sudo /opt/zomboid-panel/install-linux-
// service.sh --enable` -- a file the service account can rewrite. The
// service account can also force that branch: a directory planted at
// <panel folder>/start.sh.new makes activateStagedLinuxLauncherFiles() throw
// on the next update's startup ack. Root following the panel's own advice
// then ran the account's payload. The success line and the README shipped in
// the panel folder also pointed operators at the panel folder's copy.
//
// Promoted from the adversary's activationFailureGuidance.mjs: it runs the
// real activation against a planted directory and renders index.js's real
// catch-block template, extracted from the source.

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative) => fs.readFileSync(path.join(REPO, relative), "utf8");
const PANEL_DIR = "/opt/zomboid-panel";

let scratch = null;
afterEach(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function rootCommandsIn(line) {
  return [...line.matchAll(/sudo\s+(\S+)/g)].map((m) => m[1]);
}

describe("the panel never tells root to run the panel folder's installer", () => {
  it("guidance names only the root-owned installer, never the panel folder's copy", () => {
    const line = linuxServiceReinstallGuidance(PANEL_DIR);
    expect(rootCommandsIn(line)).toEqual([LINUX_SERVICE_INSTALLER_PATH]);
    expect(line).toContain(`never from ${PANEL_DIR}`);
    expect(line).toContain("release's archive");
  });

  it("index.js builds no sudo command from the panel's own folder", () => {
    const source = read("server/index.js");
    expect(source).not.toContain('path.join(linuxExeDir, "install-linux-service.sh")');
    expect(source).not.toMatch(/sudo \$\{[^}]*(exeDir|ExeDir)[^}]*\}/);
    expect(source).not.toMatch(/re-run install-linux-service\.sh/);
  });

  it("a forced activation failure logs guidance that keeps root out of the panel folder", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-linux-guidance-"));
    const exeDir = path.join(scratch, "zomboid-panel");
    fs.mkdirSync(exeDir, { recursive: true });

    // What a legitimate update leaves staged...
    const stageDir = PanelUpdateChecker.getLinuxLauncherStageDir(exeDir);
    fs.mkdirSync(stageDir, { recursive: true });
    for (const { name } of PanelUpdateChecker.LINUX_LAUNCHER_FILES) {
      fs.writeFileSync(path.join(stageDir, name), `staged ${name}\n`);
    }
    // ...and the service account's nudge: a directory where activation
    // removes a file, so fs.rmSync(..., { force: true }) throws.
    fs.mkdirSync(path.join(exeDir, "start.sh.new", "x"), { recursive: true });

    let activateErr = null;
    try {
      PanelUpdateChecker.prototype.activateStagedLinuxLauncherFiles.call({}, exeDir);
    } catch (error) {
      activateErr = error;
    }
    expect(activateErr).toBeInstanceOf(Error);

    // The exact template index.js logs in that catch block.
    const source = read("server/index.js");
    const match = source.match(
      /catch \(activateErr\) \{[\s\S]*?log\.error\(\s*(`[^`]*`)\s*\+\s*(`[^`]*`)\s*,?\s*\);/,
    );
    expect(match).not.toBeNull();
    const render = new Function(
      "path",
      "linuxExeDir",
      "activateErr",
      "linuxServiceReinstallGuidance",
      `return ${match[1]} + ${match[2]};`,
    );
    const line = render(path.posix, PANEL_DIR, activateErr, linuxServiceReinstallGuidance);

    expect(rootCommandsIn(line)).toEqual([LINUX_SERVICE_INSTALLER_PATH]);
    expect(line).not.toContain(`sudo ${PANEL_DIR}/`);
  });

  it("the README shipped inside the panel folder says not to run the installer from there", () => {
    const build = read("build.js");
    const readmeLine = build
      .split(/\r?\n/)
      .find((line) => line.startsWith("- install-linux-service.sh"));
    expect(readmeLine).toBeDefined();
    expect(readmeLine).toContain("root-owned folder");
    expect(readmeLine).toContain("never from this folder");
    expect(readmeLine).not.toMatch(/run with --enable/);
  });
});
