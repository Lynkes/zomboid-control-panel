import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GH #190, review round (2026-10-02): the real Scheduler.performRestart()
// driven against the real ServerManager.getServerProcessDetails() and the
// real Windows scan (_scanWindowsServerProcesses(), PowerShell mocked) on a
// virtual clock: every sleep moves it, every PowerShell call costs 500 ms,
// and the Win32_Process table each call sees is a function of that clock.
// So the timings below are the code's own, not a hand-written answer list.
// They run on every platform: nothing here reaches the OS.

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => execFileMock(...args) };
});
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: vi.fn().mockResolvedValue(null),
  getServer: vi.fn().mockResolvedValue(null),
  getServers: vi.fn().mockResolvedValue([]),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(),
}));
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn().mockResolvedValue({ handled: false }),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { ServerManager, resetWin32ScanMemoryForTests } = await import(
  "../services/serverManager.js"
);
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");

const OLD_MS = 1790964741863;
const NEW_MS = 1790999999999;
const OTHER_MS = 1790000000000;
const serverCmd = (name) =>
  String.raw`"C:\PZServer\jre64\bin\java.exe" -Djava.awt.headless=true -Xms8g -Xmx8g -cp java/;java/projectzomboid.jar zombie.network.GameServer -statistic 0 -servername ${name}`;
const HEADER = '"ProcessId","CommandLine","StartMs"';
const csvValue = (value) => `"${value.replace(/"/g, '""')}"`;
const row = (pid, cmd, startedMs) =>
  `"${pid}",${cmd === null ? "" : csvValue(cmd)},"${startedMs}"`;
const csv = (rows) => (rows.length > 0 ? `${[HEADER, ...rows].join("\r\n")}\r\n` : "");

// world(t, state) -> the Win32_Process rows a scan at virtual time t sees.
function harness(world) {
  const clock = { t: 0 };
  const state = { quitAt: null, startedAt: null };
  execFileMock.mockImplementation((_file, _args, _opts, callback) => {
    clock.t += 500;
    callback(null, csv(world(clock.t, state)), "");
  });
  const advance = async (ms) => {
    clock.t += ms;
  };

  // This server is "Tower", run directly by the panel (no systemd/Docker).
  const serverManager = new ServerManager();
  serverManager.sleep = advance;
  serverManager.loadConfig = async () => {};
  serverManager.serverName = "Tower";
  serverManager._serverId = 1;
  serverManager.usesManagedServiceLifecycle = () => false;
  serverManager._tryPidFileFastPath = async () => null;
  serverManager._scanDedicatedServerProcesses = () =>
    serverManager._scanWindowsServerProcesses();
  serverManager.startServer = vi.fn(async () => {
    state.startedAt = clock.t;
    return { success: true };
  });
  serverManager.stopServer = vi.fn(async () => ({ success: true }));

  const rconService = {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn(async () => {
      state.quitAt = clock.t;
      return { success: true };
    }),
    connect: vi.fn().mockResolvedValue(),
    setServerStarting: vi.fn(),
  };

  const scheduler = new Scheduler({}, {});
  scheduler.sleep = advance;
  scheduler._backupConfigBeforeRestart = async () => {};
  const restart = () => scheduler.performRestart(0, { rconService, serverManager });
  return { clock, state, serverManager, restart };
}

beforeEach(() => {
  execFileMock.mockReset();
  resetWin32ScanMemoryForTests();
});

afterEach(() => {
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

describe("performRestart() on Windows, waiting for the old server to exit", () => {
  // Review finding: five unknown answers in a row (~10 s) ended the whole
  // wait. An old server the panel can't read at all (started as
  // administrator, or as a service) that took 20 s or more to exit after
  // `quit` was left down although the wait had ~50 s left.
  it.each([25000, 60000])(
    "restarts an old server the panel can't read once it is gone, %i ms after quit",
    async (exitMs) => {
      const h = harness((t, s) => {
        if (s.startedAt != null) return [row(9000, null, NEW_MS)];
        if (s.quitAt == null || t < s.quitAt + exitMs) return [row(7000, null, OLD_MS)];
        return [];
      });

      const result = await h.restart();

      expect(result.success).toBe(true);
      expect(h.serverManager.stopServer).not.toHaveBeenCalled();
      expect(h.serverManager.startServer).toHaveBeenCalledOnce();
      expect(h.state.startedAt).toBeGreaterThanOrEqual(h.state.quitAt + exitMs);
    },
  );

  it("never starts over, or kills, an old server that stays listed with no command line", async () => {
    const h = harness(() => [row(7000, null, OLD_MS)]);

    const result = await h.restart();

    expect(result).toMatchObject({ success: false, code: "SERVER_RESTART_STOP_UNCONFIRMED" });
    expect(h.serverManager.startServer).not.toHaveBeenCalled();
    expect(h.serverManager.stopServer).not.toHaveBeenCalled();
  });

  // Review finding: an unrelated java.exe the panel can never read made
  // every scan unknown, so every restart ended with the server down -- the
  // restart knew the old server's PID before `quit`, and it was gone.
  it("restarts once the old server's PID is gone, next to an unrelated java.exe it can never read", async () => {
    const other = row(6000, null, OTHER_MS);
    const h = harness((t, s) => {
      if (s.startedAt != null) return [other, row(9000, serverCmd("Tower"), NEW_MS)];
      if (s.quitAt == null || t < s.quitAt + 5000) return [other, row(5120, serverCmd("Tower"), OLD_MS)];
      return [other];
    });

    const result = await h.restart();

    expect(result.success).toBe(true);
    expect(h.serverManager.stopServer).not.toHaveBeenCalled();
    expect(h.serverManager.startServer).toHaveBeenCalledOnce();
  });

  it("does not take the old server for gone while it is itself listed with no command line, mid-exit", async () => {
    const other = row(6000, null, OTHER_MS);
    const h = harness((t, s) => {
      if (s.startedAt != null) return [other, row(9000, serverCmd("Tower"), NEW_MS)];
      if (s.quitAt == null || t < s.quitAt + 12000) return [other, row(5120, serverCmd("Tower"), OLD_MS)];
      if (t < s.quitAt + 30000) return [other, row(5120, null, OLD_MS)];
      return [other];
    });

    const result = await h.restart();

    expect(result.success).toBe(true);
    expect(h.state.startedAt).toBeGreaterThanOrEqual(h.state.quitAt + 30000);
  });

  // Review finding: on a host with several servers, a row with no command
  // line was dropped as soon as ANY server was recognized -- so this server
  // read as stopped while its own JVM was still exiting next to another
  // server, and the restart started its replacement over it.
  it("waits for its own exiting JVM on a host where another server keeps running", async () => {
    const otherServer = row(4000, serverCmd("Other"), OTHER_MS);
    const h = harness((t, s) => {
      if (s.startedAt != null) return [otherServer, row(9000, serverCmd("Tower"), NEW_MS)];
      if (s.quitAt == null || t < s.quitAt + 12000) return [otherServer, row(5120, serverCmd("Tower"), OLD_MS)];
      if (t < s.quitAt + 20000) return [otherServer, row(5120, null, OLD_MS)];
      return [otherServer];
    });

    const result = await h.restart();

    expect(result.success).toBe(true);
    expect(h.state.startedAt).toBeGreaterThanOrEqual(h.state.quitAt + 20000);
  });
});
