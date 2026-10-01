import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-10-01 incident (42.21, Unraid): a server whose game thread had died
// refused every pre-restart save ("RCON connection closed"). performRestart()
// called the restart off -- correctly, quitting after a failed save loses
// everything since the last one -- but its message was English-only and gave
// no way forward. It now returns SERVER_RESTART_SAVE_FAILED with the reason,
// which a Restart's toast shows translated and pointing at Force stop. It
// still never stops the server itself.

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
const { ServerManager } = await import("../services/serverManager.js");
const { codedActionResultFields } = await import("../routes/scheduler.js");
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");

function makeStuckServerRcon() {
  return {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: false, error: "RCON connection closed" }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn().mockResolvedValue({ success: true }),
    connect: vi.fn().mockResolvedValue(),
    setServerStarting: vi.fn(),
  };
}

function makeRunningServerManager() {
  const serverManager = new ServerManager();
  serverManager.getServerProcessDetails = vi
    .fn()
    .mockResolvedValue({ running: true, scanFailed: false });
  serverManager.stopServer = vi.fn().mockResolvedValue({ success: true });
  serverManager.startServer = vi.fn().mockResolvedValue({ success: true });
  return serverManager;
}

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-restart-save-failed-"));
  const record = { id: 7, name: "Tower", serverName: "Tower", installPath: root };
  getServer.mockResolvedValue(record);
  getActiveServer.mockResolvedValue(record);
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

describe("performRestart() when the pre-restart save fails", () => {
  it("calls the restart off with SERVER_RESTART_SAVE_FAILED and never stops the server itself", async () => {
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    const rconService = makeStuckServerRcon();
    const serverManager = makeRunningServerManager();

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result).toMatchObject({
      success: false,
      wasRunning: true,
      logged: true,
      code: "SERVER_RESTART_SAVE_FAILED",
      params: { reason: "RCON connection closed" },
    });
    // Schedule History keeps the plain English line it always had.
    expect(result.message).toBe("Save failed; restart cancelled: RCON connection closed");
    expect(rconService.quit).not.toHaveBeenCalled();
    expect(serverManager.stopServer).not.toHaveBeenCalled();
    expect(serverManager.startServer).not.toHaveBeenCalled();
    expect(codedActionResultFields(result)).toEqual({
      code: "SERVER_RESTART_SAVE_FAILED",
      params: { reason: "RCON connection closed" },
    });
  });

  it("a scheduled restart task's \"Run now\" keeps the code, with one Schedule History row", async () => {
    const rconService = makeStuckServerRcon();
    const serverManager = makeRunningServerManager();
    serverManager._serverId = 7;
    const scheduler = new Scheduler(rconService, serverManager);
    scheduler.sleep = async () => {};

    const result = await scheduler.runTaskNow({ id: 40, name: "Nightly restart", command: "restart" });

    expect(result).toMatchObject({
      success: false,
      code: "SERVER_RESTART_SAVE_FAILED",
      params: { reason: "RCON connection closed" },
    });
    expect(logScheduleExecution).toHaveBeenCalledTimes(1);
    expect(rconService.quit).not.toHaveBeenCalled();
  });
});
