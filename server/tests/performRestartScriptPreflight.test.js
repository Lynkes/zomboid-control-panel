import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GH #167 follow-up: startServer() refuses a named server whose generated
// startup script is missing and can't be written (SERVER_START_SCRIPT_MISSING).
// performRestart() only reached that check in the startServer() AFTER its
// countdown, world save, RCON quit and forced stop -- so a server that was
// running fine (launched by 1.3.8 from the stock script, in a launch folder
// the panel can't write to) was stopped by a scheduled/Dashboard/Discord/
// mod-update restart and then left down. The restart now asks first
// (ServerManager.assertNamedStartupScriptLaunchable()) and is called off
// with SERVER_RESTART_SCRIPT_MISSING while the server is still running.

const getServer = vi.fn();
const getActiveServer = vi.fn();
const logScheduleExecution = vi.fn();
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getServer(...args),
  getServers: vi.fn().mockResolvedValue([]),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(),
}));
const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { ServerManager, managedStartupScriptName } = await import(
  "../services/serverManager.js"
);
const { codedActionResultFields } = await import("../routes/scheduler.js");
const { acquireLifecycleLock } = await import(
  "../services/lifecycleCoordinator.js"
);

function makeRconService() {
  return {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn().mockResolvedValue({ success: true }),
    connect: vi.fn().mockResolvedValue(),
    setServerStarting: vi.fn(),
  };
}

// A real ServerManager for a server that is running, with the stop and the
// start stubbed so nothing is killed or spawned.
function makeRunningServerManager() {
  const serverManager = new ServerManager();
  serverManager.getServerProcessDetails = vi
    .fn()
    .mockResolvedValueOnce({ running: true, scanFailed: false })
    .mockResolvedValue({ running: false, scanFailed: false });
  serverManager.stopServer = vi.fn().mockResolvedValue({ success: true });
  serverManager.startServer = vi.fn().mockResolvedValue({ success: true });
  return serverManager;
}

function useServer(record) {
  getServer.mockResolvedValue(record);
  getActiveServer.mockResolvedValue(record);
}

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-restart-preflight-"));
  runManagedLifecycle.mockReset().mockResolvedValue({ handled: false });
  logScheduleExecution.mockReset().mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  getServer.mockReset();
  getActiveServer.mockReset();
  fs.rmSync(root, { recursive: true, force: true });
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

describe("performRestart() checks the launch script before stopping a running server", () => {
  it("calls the restart off, leaving the server running, when the script is missing and the launch folder can't be written", async () => {
    // A regular file where the launch folder should be: every write into it
    // fails (ENOTDIR/ENOENT), like a folder the panel has no write access to.
    const notAFolder = path.join(root, "install");
    fs.writeFileSync(notAFolder, "");
    useServer({ id: 7, name: "Main", serverName: "servertest", installPath: notAFolder });

    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    const rconService = makeRconService();
    const serverManager = makeRunningServerManager();

    const error = await scheduler
      .performRestart(0, { rconService, serverManager })
      .then(() => null, (caught) => caught);

    expect(error?.code).toBe("SERVER_RESTART_SCRIPT_MISSING");
    expect(error.params).toEqual({
      script: managedStartupScriptName("servertest"),
      fallback: expect.any(String),
    });
    // Nothing that takes the server down ran: no countdown, save or quit,
    // no forced stop, no relaunch.
    expect(rconService.serverMessage).not.toHaveBeenCalled();
    expect(rconService.save).not.toHaveBeenCalled();
    expect(rconService.quit).not.toHaveBeenCalled();
    expect(runManagedLifecycle).not.toHaveBeenCalled();
    expect(serverManager.stopServer).not.toHaveBeenCalled();
    expect(serverManager.startServer).not.toHaveBeenCalled();
    // One Schedule History row, and no restart intent left behind for the
    // next unrelated stop or crash to be read as.
    expect(logScheduleExecution).toHaveBeenCalledOnce();
    expect(logScheduleExecution.mock.calls[0][3]).toBe(false);
    expect(error.alreadyLoggedToScheduleHistory).toBe(true);
    expect(serverManager.stopIntent).toBeNull();
    // A Restart's toast shows it translated.
    expect(codedActionResultFields(error)).toEqual({
      code: "SERVER_RESTART_SCRIPT_MISSING",
      params: error.params,
    });
  });

  it("goes ahead when the script is missing but the launch folder is writable (the relaunch writes it), leaving no probe file behind", async () => {
    useServer({ id: 7, name: "Main", serverName: "servertest", installPath: root });

    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    const rconService = makeRconService();
    const serverManager = makeRunningServerManager();

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    expect(rconService.quit).toHaveBeenCalledOnce();
    expect(serverManager.startServer).toHaveBeenCalledOnce();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("ServerManager.assertNamedStartupScriptLaunchable()", () => {
  const script = managedStartupScriptName("servertest");

  it("passes when the script is already there, even in a folder the panel can't write to (the start runs that copy)", async () => {
    fs.writeFileSync(path.join(root, script), "");
    useServer({ id: 1, serverName: "servertest", installPath: root });
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });

    await expect(
      new ServerManager().assertNamedStartupScriptLaunchable({ serverId: 1 }),
    ).resolves.toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("tries a real write instead of trusting fs.access (Windows ignores folder ACLs there)", async () => {
    useServer({ id: 1, serverName: "servertest", installPath: root });
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });

    const error = await new ServerManager()
      .assertNamedStartupScriptLaunchable({ serverId: 1 })
      .then(() => null, (caught) => caught);

    expect(error?.code).toBe("SERVER_RESTART_SCRIPT_MISSING");
    expect(error.message).toContain(root);
    // The folder stays out of params: responses redact paths.
    expect(Object.values(error.params).join(" ")).not.toContain(root);
  });

  it("does not ask about a server mapped to a Docker container (restarted through Docker)", async () => {
    const notAFolder = path.join(root, "install");
    fs.writeFileSync(notAFolder, "");
    useServer({
      id: 1,
      serverName: "servertest",
      installPath: notAFolder,
      dockerContainerName: "pz",
    });

    await expect(
      new ServerManager().assertNamedStartupScriptLaunchable({ serverId: 1 }),
    ).resolves.toBeUndefined();
  });

  it("does not ask about a direct launch with a custom start command, which never runs the script", async () => {
    const notAFolder = path.join(root, "install");
    fs.writeFileSync(notAFolder, "");
    useServer({
      id: 1,
      serverName: "servertest",
      installPath: notAFolder,
      startCommand: "/opt/pz/run.sh",
    });

    await expect(
      new ServerManager().assertNamedStartupScriptLaunchable({ serverId: 1 }),
    ).resolves.toBeUndefined();
  });

  it("refuses a systemd/OpenRC server whose unit runs a missing script the panel won't write (custom start command set)", async () => {
    useServer({
      id: 1,
      serverName: "servertest",
      installPath: root,
      lifecycleProvider: "systemd",
      startCommand: "/opt/pz/run.sh",
    });

    const error = await new ServerManager()
      .assertNamedStartupScriptLaunchable({ serverId: 1 })
      .then(() => null, (caught) => caught);

    expect(error?.code).toBe("SERVER_RESTART_SCRIPT_MISSING");
  });

  it("does not change which server the manager is pointed at", async () => {
    useServer({ id: 1, serverName: "servertest", installPath: root });
    const manager = new ServerManager();

    await manager.assertNamedStartupScriptLaunchable({ serverId: 1 });

    expect(manager._serverId).toBeNull();
    expect(manager.configLoaded).toBe(false);
    expect(manager._serverRecord).toBeNull();
  });
});
