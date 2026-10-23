import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A 1.5.0 support bundle: every Windows process scan failed, a scheduled
// restart sent `quit`, the server stopped, and the restart gave up ("could
// not confirm the old server stopped") -- the server stayed down. When the
// scan still can't answer, the restart now asks for other proof
// (serverManager.checkStoppedEvidence(): RCON port refused + the console
// log's shutdown lines) and starts the server only on it.

const logScheduleExecution = vi.fn();
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: vi.fn().mockResolvedValue(null),
  getServer: vi.fn().mockResolvedValue(null),
  getServers: vi.fn().mockResolvedValue([]),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(),
}));
const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");

const RUNNING = { running: true, matched: [{ pid: "5120", cmd: "java zombie.network.GameServer" }], scanFailed: false };
const UNKNOWN = { running: false, matched: [], owned: [], scanFailed: true };

function scripted(...answers) {
  const queue = [...answers];
  const last = answers.at(-1);
  return vi.fn(async () => (queue.length > 0 ? queue.shift() : last));
}

function makeRcon(overrides = {}) {
  return {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn().mockResolvedValue({ success: true }),
    connect: vi.fn().mockResolvedValue(),
    setServerStarting: vi.fn(),
    ...overrides,
  };
}

function makeServerManager(getServerProcessDetails, evidence) {
  return {
    _serverId: 1,
    getServerProcessDetails,
    checkStoppedEvidence: vi.fn(async () => evidence),
    stopServer: vi.fn().mockResolvedValue({ success: true }),
    startServer: vi.fn().mockResolvedValue({ success: true }),
  };
}

function makeScheduler() {
  const scheduler = new Scheduler({}, {});
  scheduler.sleep = vi.fn(async () => {});
  return scheduler;
}

beforeEach(() => {
  runManagedLifecycle.mockReset().mockResolvedValue({ handled: false });
  logScheduleExecution.mockReset().mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

describe("performRestart() when process detection never answers", () => {
  it("starts the new server when the evidence says the old one stopped", async () => {
    const scheduler = makeScheduler();
    const rconService = makeRcon();
    const serverManager = makeServerManager(scripted(RUNNING, UNKNOWN), {
      stopped: true,
      reason: 'the RCON port refuses connections and the game\'s console log ends with "Shutdown handling finished"',
    });

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    // Shutdown lines only: no "quiet since our quit" input.
    expect(serverManager.checkStoppedEvidence).toHaveBeenCalledOnce();
    expect(serverManager.checkStoppedEvidence.mock.calls[0][0]).not.toHaveProperty("quitSentAt");
    expect(serverManager.stopServer).not.toHaveBeenCalled();
    expect(serverManager.startServer).toHaveBeenCalledOnce();
    expect(serverManager.startServer).toHaveBeenCalledWith(expect.objectContaining({ skipRunningCheck: true }));
  });

  it("still gives up, starting and killing nothing, when the evidence doesn't say stopped", async () => {
    const scheduler = makeScheduler();
    const rconService = makeRcon();
    const serverManager = makeServerManager(scripted(RUNNING, UNKNOWN), {
      stopped: false,
      reason: "the RCON port refuses connections, but the game's console log does not show the server stopped",
    });

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result).toMatchObject({ success: false, code: "SERVER_RESTART_STOP_UNCONFIRMED" });
    expect(serverManager.checkStoppedEvidence).toHaveBeenCalledOnce();
    expect(serverManager.startServer).not.toHaveBeenCalled();
    expect(serverManager.stopServer).not.toHaveBeenCalled();
  });

  it("counts the start done when the process the panel launched is running, though scans still fail", async () => {
    const run = async (serverProcess) => {
      const scheduler = makeScheduler();
      // RCON only comes up once the new server has started (the wait for
      // it after the start), so the start itself is confirmed some other way.
      const rconService = makeRcon({ connected: false });
      const serverManager = makeServerManager(scripted(RUNNING, UNKNOWN), { stopped: true, reason: "test" });
      let started = false;
      serverManager.startServer = vi.fn(async () => {
        started = true;
        return { success: true };
      });
      rconService.connect = vi.fn(async () => {
        if (started) rconService.connected = true;
      });
      serverManager.serverProcess = serverProcess;
      return scheduler.performRestart(0, { rconService, serverManager });
    };

    await expect(run({ exitCode: null, signalCode: null })).resolves.toMatchObject({ success: true });
    await expect(run({ exitCode: 1, signalCode: null })).resolves.toMatchObject({ success: false });
  });

  it("starts a server found down at the first check when the evidence says stopped", async () => {
    const scheduler = makeScheduler();
    const rconService = makeRcon({ connected: false, execute: vi.fn().mockResolvedValue({ success: false }) });
    const serverManager = makeServerManager(scripted(UNKNOWN), { stopped: true, reason: "test" });
    serverManager.serverProcess = { exitCode: null, signalCode: null };

    await scheduler.performRestart(0, { rconService, serverManager });

    expect(serverManager.checkStoppedEvidence).toHaveBeenCalledOnce();
    // Through the normal start, which runs its own guard again.
    expect(serverManager.startServer).toHaveBeenCalledOnce();
    expect(serverManager.startServer).not.toHaveBeenCalledWith(expect.objectContaining({ skipRunningCheck: true }));
    // Confirmed by the launched process while scans still fail.
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      true,
      "Server was offline - started successfully",
      expect.any(Number),
      // The restart's own server (performRestart()'s pinnedServerId).
      expect.any(Object),
    );
  });
});
