import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServer = vi.fn();
const getActiveServer = vi.fn();
const logServerEvent = vi.fn();

vi.mock("../database/init.js", () => ({
  getServer,
  getActiveServer,
  getServers: vi.fn().mockResolvedValue([]),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  logServerEvent,
}));

const { ServerManager, managedStartupScriptName } = await import(
  "../services/serverManager.js"
);
const {
  getActiveSteamOperations,
  clearActiveSteamOperation,
} = await import("../services/activeSteamOperations.js");

// A real folder holding the server's generated script: the unit runs it,
// and a managed start or restart refuses to call systemctl without it
// (GH #167).
const installPath = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-managed-lifecycle-"));
const namedScript = path.join(installPath, managedStartupScriptName("servertest"));

const profile = {
  id: "managed-1",
  name: "Managed",
  serverName: "servertest",
  installPath,
  lifecycleProvider: "systemd",
  rconHost: "127.0.0.1",
  rconPort: 27015,
};

afterAll(() => {
  fs.rmSync(installPath, { recursive: true, force: true });
});

describe("ServerManager managed Linux lifecycle", () => {
  let lifecycle;
  let manager;

  beforeEach(() => {
    getServer.mockReset().mockResolvedValue(profile);
    getActiveServer.mockReset().mockResolvedValue(profile);
    logServerEvent.mockReset().mockResolvedValue(undefined);
    lifecycle = {
      serviceName: "zomboid-panel-server-managed-1",
      status: vi.fn().mockResolvedValue({ running: true, scanFailed: false }),
      run: vi.fn().mockResolvedValue({
        success: true,
        confirmed: true,
        message: "ok",
      }),
    };
    manager = new ServerManager({ lifecycleFactory: () => lifecycle });
    manager.sleep = vi.fn().mockResolvedValue(undefined);
    fs.writeFileSync(namedScript, "#!/bin/bash\n");
  });

  it("uses the service manager as status authority without returning an owned PID", async () => {
    await manager.reloadConfig(profile.id);

    const status = await manager.getServerProcessDetails();

    expect(lifecycle.status).toHaveBeenCalledOnce();
    expect(status).toMatchObject({
      running: true,
      scanFailed: false,
      provider: "systemd",
      owned: [],
      matched: [],
    });
  });

  it("starts through systemd and never retains a child-process handle", async () => {
    const result = await manager.startServer();

    expect(lifecycle.run).toHaveBeenCalledWith("start");
    expect(result.success).toBe(true);
    expect(manager.serverProcess).toBeNull();
  });

  // Server uptime: the managed start used to keep any start time already
  // recorded (`this.startTime || new Date()`), so a service stopped by hand
  // and started again from the panel before a status poll noticed the stop
  // kept counting from the previous run -- and for OpenRC (no MainPID for
  // the OS to answer about) that record is the only uptime there is.
  it("records a fresh launch time on start instead of keeping a previous run's", async () => {
    const previousRun = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    manager.startTime = previousRun;
    manager._startTimePid = "4242";

    const before = Date.now();
    await manager.startServer();

    expect(manager.startTime.getTime()).toBeGreaterThanOrEqual(before);
    expect(manager._startTimePid).toBeNull();
  });

  // Regression (2026-08-31 services sweep): the SteamCMD guard used to sit
  // AFTER the managed-lifecycle branch's own early return, so it never ran
  // for a systemd/openrc-managed install -- systemctl would start the
  // server while SteamCMD was still writing into the exact same
  // installPath, exactly the "spawn against a mid-write install" crash
  // this guard exists to prevent for the direct-launch path.
  describe("SteamCMD guard also covers the managed-lifecycle start path", () => {
    const normalizedInstallPath = path.normalize(profile.installPath).toLowerCase();

    afterEach(() => {
      clearActiveSteamOperation(normalizedInstallPath);
    });

    it("refuses to systemctl-start while SteamCMD is active for this install path", async () => {
      getActiveSteamOperations().set(normalizedInstallPath, {
        type: "update",
        pid: process.pid,
      });

      await expect(manager.startServer()).rejects.toThrow(
        /steam install or update is currently in progress/i,
      );
      expect(lifecycle.run).not.toHaveBeenCalled();
    });
  });

  it("force-stops through systemd instead of killing host PIDs", async () => {
    manager._killPids = vi.fn();
    manager._genericForceStop = vi.fn();

    const result = await manager.stopServer();

    expect(lifecycle.run).toHaveBeenCalledWith("stop");
    expect(manager._killPids).not.toHaveBeenCalled();
    expect(manager._genericForceStop).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(true);
  });

  it("restarts through systemd after the normal warning and save flow", async () => {
    const rcon = {
      serverMessage: vi.fn().mockResolvedValue({ success: true }),
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn(),
    };

    const result = await manager.restartServer(rcon, 0);

    expect(rcon.save).toHaveBeenCalledOnce();
    expect(rcon.quit).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledWith("restart");
    expect(result.success).toBe(true);
    expect(manager.serverProcess).toBeNull();
  });

  // GH #167: the unit runs start-server_<name>.sh (see
  // linuxServiceLifecycle.js's resolveLaunchTarget()). When it's missing,
  // systemd fails it with exit 127 and Restart=on-failure keeps retrying,
  // which reads as "activating" -- so the panel refuses before systemctl
  // runs instead of reporting that start as a success.
  it("refuses to systemctl-start when the server's generated script is missing", async () => {
    fs.rmSync(namedScript);

    const error = await manager.startServer().then(() => null, (caught) => caught);

    expect(error?.code).toBe("SERVER_START_SCRIPT_MISSING");
    expect(error.params.script).toBe(path.basename(namedScript));
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it("refuses a systemctl restart the same way", async () => {
    fs.rmSync(namedScript);
    const rcon = {
      serverMessage: vi.fn().mockResolvedValue({ success: true }),
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn(),
    };

    const error = await manager.restartServer(rcon, 0).then(() => null, (caught) => caught);

    expect(error?.code).toBe("SERVER_START_SCRIPT_MISSING");
    expect(lifecycle.run).not.toHaveBeenCalled();
  });
});
