import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GH #190 (Windows 10, panel-managed server with a custom startCommand): a
// scheduled restart saved the world, sent `quit`, and then hit ONE process
// scan that came back "unparseable" while the old JVM was exiting. The
// wait-for-stop loop treated that single sample as the final answer, called
// the restart off, and left the server down. The wait now asks again a few
// times; only when every attempt fails does it give up -- and then it still
// never starts a second server over one that may be running.

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
const { readProcessStateWithRetry, SCAN_RETRY_ATTEMPTS } = await import(
  "../utils/processScanRetry.js"
);

const RUNNING = { running: true, matched: [{ pid: "5120", cmd: "java zombie.network.GameServer" }], scanFailed: false };
const STOPPED = { running: false, matched: [], scanFailed: false };
// What getServerProcessDetails() answered for the reporter: the Windows scan
// couldn't read a row and reported the state unknown.
const UNKNOWN = { running: false, matched: [], owned: [], scanFailed: true };

function scripted(...answers) {
  const queue = [...answers];
  const last = answers.at(-1);
  return vi.fn(async () => (queue.length > 0 ? queue.shift() : last));
}

function makeRcon() {
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

function makeServerManager(getServerProcessDetails) {
  return {
    _serverId: 1,
    getServerProcessDetails,
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
  getServer.mockResolvedValue(null);
  getActiveServer.mockResolvedValue(null);
  runManagedLifecycle.mockReset().mockResolvedValue({ handled: false });
  logScheduleExecution.mockReset().mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  getServer.mockReset();
  getActiveServer.mockReset();
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

describe("readProcessStateWithRetry()", () => {
  it("answers with the first sample that isn't a failed scan", async () => {
    const read = scripted(UNKNOWN, null, STOPPED);
    const sleep = vi.fn(async () => {});

    await expect(readProcessStateWithRetry(read, { sleep })).resolves.toBe(STOPPED);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("asks only once when the first sample answers", async () => {
    const read = scripted(RUNNING);
    const sleep = vi.fn(async () => {});

    await expect(readProcessStateWithRetry(read, { sleep })).resolves.toBe(RUNNING);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the bounded attempts, still reporting the state unknown", async () => {
    const read = scripted(UNKNOWN);
    const sleep = vi.fn(async () => {});

    const result = await readProcessStateWithRetry(read, { sleep });

    expect(read).toHaveBeenCalledTimes(SCAN_RETRY_ATTEMPTS);
    expect(result).toMatchObject({ running: false, scanFailed: true });
  });

  it("counts a sample that resolves to nothing as a failed scan", async () => {
    const result = await readProcessStateWithRetry(scripted(undefined), {
      attempts: 2,
      sleep: async () => {},
    });

    expect(result).toEqual({ running: false, scanFailed: true });
  });

  it("starts no attempt past maxElapsedMs", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = vi.fn(async () => {
      now += 20000; // a scan that ran into its own timeout
      return UNKNOWN;
    });

    const result = await readProcessStateWithRetry(read, {
      maxElapsedMs: 30000,
      sleep: async () => {},
    });

    // 0 s: first scan; 21.5 s: second; a third would start past 30 s.
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.scanFailed).toBe(true);
  });

  it("does not swallow a check that throws", async () => {
    const read = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(readProcessStateWithRetry(read, { sleep: async () => {} })).rejects.toThrow("boom");
  });
});

describe("performRestart() waiting for the old server to exit (GH #190)", () => {
  it("completes the restart when one scan fails right after the quit", async () => {
    const scheduler = makeScheduler();
    const rconService = makeRcon();
    // initial check -> running; after quit: unknown once, then stopped.
    const serverManager = makeServerManager(scripted(RUNNING, UNKNOWN, STOPPED));

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    expect(rconService.quit).toHaveBeenCalledOnce();
    expect(serverManager.stopServer).not.toHaveBeenCalled();
    expect(serverManager.startServer).toHaveBeenCalledOnce();
    expect(serverManager.startServer).toHaveBeenCalledWith(
      expect.objectContaining({ skipRunningCheck: true }),
    );
  });

  it("completes the restart when scans fail mid-wait, while the server is still shutting down", async () => {
    const scheduler = makeScheduler();
    const rconService = makeRcon();
    const serverManager = makeServerManager(
      scripted(RUNNING, RUNNING, RUNNING, UNKNOWN, UNKNOWN, STOPPED),
    );

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    // 6 samples up to the stop, then the post-start check.
    expect(serverManager.getServerProcessDetails).toHaveBeenCalledTimes(7);
    expect(serverManager.startServer).toHaveBeenCalledOnce();
  });

  it("gives up safely when detection never answers: the state is unknown and no second server is started", async () => {
    const scheduler = makeScheduler();
    const rconService = makeRcon();
    const serverManager = makeServerManager(scripted(RUNNING, UNKNOWN));

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result).toMatchObject({
      success: false,
      wasRunning: true,
      logged: true,
      code: "SERVER_RESTART_STOP_UNCONFIRMED",
    });
    expect(result.message).toMatch(/could not confirm the old server stopped/i);
    expect(result.message).toMatch(/new server was not started/i);
    // 1 initial check + the bounded retries -- not one, not forever.
    expect(serverManager.getServerProcessDetails).toHaveBeenCalledTimes(1 + SCAN_RETRY_ATTEMPTS);
    expect(serverManager.startServer).not.toHaveBeenCalled();
    // Unknown is not "still running": no kill on a guess either.
    expect(serverManager.stopServer).not.toHaveBeenCalled();
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      false,
      result.message,
      expect.any(Number),
    );
    // A Restart's toast shows it translated.
    expect(codedActionResultFields(result)).toEqual({ code: "SERVER_RESTART_STOP_UNCONFIRMED" });
  });

  it("gives up the same way when detection breaks for good mid-wait", async () => {
    const scheduler = makeScheduler();
    const rconService = makeRcon();
    const serverManager = makeServerManager(scripted(RUNNING, RUNNING, UNKNOWN));

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result).toMatchObject({ success: false, code: "SERVER_RESTART_STOP_UNCONFIRMED" });
    expect(serverManager.getServerProcessDetails).toHaveBeenCalledTimes(2 + SCAN_RETRY_ATTEMPTS);
    expect(serverManager.startServer).not.toHaveBeenCalled();
  });

  it("still refuses outright at its first check when the state is unknown and RCON doesn't answer", async () => {
    // A decision point, not a flow under way: nothing has been stopped yet,
    // so it refuses exactly as before instead of starting a server it can't
    // confirm is down.
    const scheduler = makeScheduler();
    const rconService = {
      ...makeRcon(),
      connected: false,
      execute: vi.fn().mockResolvedValue({ success: false }),
    };
    const serverManager = makeServerManager(scripted(UNKNOWN));

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result).toMatchObject({ success: false, wasRunning: false });
    expect(serverManager.getServerProcessDetails).toHaveBeenCalledOnce();
    expect(serverManager.startServer).not.toHaveBeenCalled();
  });
});

describe("ServerManager stop confirmation after a kill (GH #190)", () => {
  it("confirms the stop when one scan fails as the killed process exits", async () => {
    const manager = new ServerManager();
    manager.sleep = vi.fn(async () => {});
    manager.getServerProcessDetails = scripted(UNKNOWN, STOPPED);

    await expect(manager._confirmProcessStopped()).resolves.toBe(true);
    expect(manager.getServerProcessDetails).toHaveBeenCalledTimes(2);
  });

  it("still reports the stop unconfirmed when detection never answers", async () => {
    const manager = new ServerManager();
    manager.sleep = vi.fn(async () => {});
    manager.getServerProcessDetails = scripted(UNKNOWN);

    await expect(manager._confirmProcessStopped()).resolves.toBe(false);
    expect(manager.getServerProcessDetails).toHaveBeenCalledTimes(SCAN_RETRY_ATTEMPTS);
  });

  it("still reports a process that is really there as not stopped, without retrying it", async () => {
    const manager = new ServerManager();
    manager.sleep = vi.fn(async () => {});
    manager.getServerProcessDetails = scripted(RUNNING);

    await expect(manager._confirmProcessStopped()).resolves.toBe(false);
    expect(manager.getServerProcessDetails).toHaveBeenCalledOnce();
  });

  it("restartServer() rides out one failed scan after the quit", async () => {
    const manager = new ServerManager();
    manager.sleep = vi.fn(async () => {});
    manager.loadConfig = vi.fn(async () => {});
    manager.usesManagedServiceLifecycle = () => false;
    manager.isJvmExecutableBusy = () => false;
    manager.getServerProcessDetails = scripted(UNKNOWN, STOPPED);
    manager.startServer = vi.fn().mockResolvedValue({ success: true });
    const rconService = {
      serverMessage: async () => ({ success: true }),
      save: async () => ({ success: true }),
      quit: async () => ({ success: true }),
    };

    await expect(manager.restartServer(rconService, 0)).resolves.toMatchObject({ success: true });
    expect(manager.startServer).toHaveBeenCalledWith({ skipRunningCheck: true });
  });
});
