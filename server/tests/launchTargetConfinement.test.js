import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// RCE-STARTCMD (security sweep 2026-10-04): a server's launch target -- its
// custom start command, or an installPath/serverPath naming a .bat/.sh/.exe
// launcher -- is a program the panel runs on the host, as its own account,
// at the next start. validateStartCommand()'s metacharacter blocklist let
// `powershell.exe -enc <base64>` through, and a technician could save that
// (servers.manage) and press Start (server.control), so a non-admin role
// had RCE. The fix confines the launch target to the server's own install
// folder, rejects system programs and command interpreters, and re-checks
// at launch so a value stored before the fix (or written another way) still
// can't run. This file covers the pure confinement decision and the
// re-check inside startServer(); launchTargetAdminOnly.test.js covers the
// route gate and the 403/400 split.
//
// Mocks only database/init.js (loadConfig()'s data source) and the logger;
// fs and the confinement logic run for real, so the re-check test is a
// genuine refusal, not a simulated one. startServer() is driven only down
// the refusal path -- it throws before any spawn -- so nothing is launched.

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { ServerManager, findLaunchTargetRefusal, launchTargetOf } = await import(
  "../services/serverManager.js"
);
const { ErrorCode } = await import("../utils/errorCodes.js");

const isWindows = process.platform === "win32";

let installDir;
let outsideDir;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-launch-confine-"));
  installDir = path.join(root, "pz-install");
  outsideDir = path.join(root, "elsewhere");
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
});

afterEach(() => {
  getActiveServer.mockReset();
});

describe("findLaunchTargetRefusal() -- confinement decision (RCE-STARTCMD)", () => {
  it("allows a launcher script inside the install folder", () => {
    const launcher = path.join(installDir, isWindows ? "run.bat" : "run.sh");
    fs.writeFileSync(launcher, "");
    expect(
      findLaunchTargetRefusal({ installDir, launcherPath: launcher }),
    ).toBeNull();
    // A relative start command resolved against the install folder is fine too.
    expect(
      findLaunchTargetRefusal({
        installDir,
        startCommand: isWindows ? "run.bat -servername X" : "./run.sh -servername X",
      }),
    ).toBeNull();
  });

  it("refuses the EXEC-1 payload: a command interpreter with a base64 arg", () => {
    // The exact shape the blocklist let through -- no blocked metacharacter.
    const pwsh = isWindows
      ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      : "/bin/sh";
    const refusal = findLaunchTargetRefusal({
      installDir,
      startCommand: `${pwsh} -enc ${Buffer.from("x").toString("base64")}`,
    });
    expect(refusal).not.toBeNull();
    expect(refusal.program).toBe(path.basename(pwsh));
  });

  it("refuses a start command whose program is an absolute path outside the install folder", () => {
    const outside = path.join(outsideDir, isWindows ? "outside.bat" : "outside.sh");
    fs.writeFileSync(outside, "");
    const refusal = findLaunchTargetRefusal({ installDir, startCommand: outside });
    expect(refusal).not.toBeNull();
    expect(refusal.program).toBe(path.basename(outside));
  });

  it("refuses a relative start command that climbs out with ..", () => {
    const refusal = findLaunchTargetRefusal({
      installDir,
      startCommand: isWindows ? "..\\elsewhere\\evil.bat" : "../elsewhere/evil.sh",
    });
    expect(refusal).not.toBeNull();
  });

  it("refuses a start-command target reached through a symlinked folder that leads out", () => {
    // realpath must resolve the whole chain, not just lexically normalize.
    const linkDir = path.join(installDir, "link");
    try {
      fs.symlinkSync(outsideDir, linkDir, "junction");
    } catch {
      return; // symlink/junction not permitted in this environment -- skip
    }
    const evil = path.join(outsideDir, isWindows ? "evil.bat" : "evil.sh");
    fs.writeFileSync(evil, "");
    const refusal = findLaunchTargetRefusal({
      installDir,
      startCommand: path.join(linkDir, isWindows ? "evil.bat" : "evil.sh"),
    });
    expect(refusal).not.toBeNull();
  });

  it("allows a custom launcher outside any managed folder (supported mode) but still rejects a system-program one", () => {
    // Launchers are not folder-confined -- a serverPath/installPath launcher
    // is the operator's own script and admin-only to set.
    const launcher = path.join(outsideDir, isWindows ? "ops.bat" : "ops.sh");
    fs.writeFileSync(launcher, "");
    expect(findLaunchTargetRefusal({ installDir, launcherPath: launcher })).toBeNull();
    // ...but a launcher that is itself a system program is refused.
    const sys = isWindows
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "calc.exe")
      : "/usr/bin/whoami";
    const refusal = findLaunchTargetRefusal({
      installDir: path.dirname(sys),
      launcherPath: sys,
    });
    expect(refusal).not.toBeNull();
  });

  it("does nothing for a managed server (no start command, no launcher)", () => {
    expect(findLaunchTargetRefusal({ installDir })).toBeNull();
    expect(findLaunchTargetRefusal({})).toBeNull();
  });

  it("launchTargetOf() reads the folder, command and launcher from a record", () => {
    expect(launchTargetOf({ installPath: installDir })).toMatchObject({
      installDir,
      launcherPath: null,
    });
    const launcher = path.join(installDir, isWindows ? "run.bat" : "run.sh");
    expect(launchTargetOf({ serverPath: launcher })).toMatchObject({
      installDir,
      launcherPath: launcher,
    });
  });
});

describe("startServer() re-checks the launch target at launch (EXEC-1)", () => {
  it("refuses a stored interpreter start command without spawning anything", async () => {
    const pwsh = isWindows
      ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      : "/bin/sh";
    // The record a technician could have stored directly, bypassing the
    // route gate entirely -- the re-check is the backstop.
    getActiveServer.mockResolvedValue({
      id: "s1",
      serverName: "Pwned",
      installPath: installDir,
      startCommand: `${pwsh} -enc ${Buffer.from("payload").toString("base64")}`,
    });

    const manager = new ServerManager();
    await expect(
      manager.startServer({ skipRunningCheck: true }),
    ).rejects.toMatchObject({ code: ErrorCode.SERVER_LAUNCH_TARGET_REFUSED });
    // Nothing was launched.
    expect(manager.serverProcess).toBeNull();
    expect(manager.isRunning).toBe(false);
  });

  it("refuses a stored start command whose program is outside the install folder", async () => {
    const outside = path.join(outsideDir, isWindows ? "escape.bat" : "escape.sh");
    fs.writeFileSync(outside, isWindows ? "@echo off\n" : "#!/bin/sh\nsleep 30\n");
    getActiveServer.mockResolvedValue({
      id: "s2",
      serverName: "Escaped",
      installPath: installDir,
      // An absolute start-command program in a different folder -- FILES-1's
      // "legitimate but outside" case; the panel refuses rather than runs it.
      startCommand: outside,
    });

    const manager = new ServerManager();
    await expect(
      manager.startServer({ skipRunningCheck: true }),
    ).rejects.toMatchObject({ code: ErrorCode.SERVER_LAUNCH_TARGET_REFUSED });
    expect(manager.serverProcess).toBeNull();
  });
});
