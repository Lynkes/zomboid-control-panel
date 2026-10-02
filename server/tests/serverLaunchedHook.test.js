import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// GH #189: the mod checker learns about every launch the panel makes through
// lifecycleCoordinator's server-launched hook, so a mod-update restart still
// waiting for players ends when the server is started again (that start
// loaded the updated mods). These tests pin which launches report
// themselves -- only ones that actually happened -- and replay the
// reporter's sequence end to end: an update found with players on, then a
// manual Restart from the dashboard.

const db = vi.hoisted(() => ({ server: null }));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => db.server),
  getServer: vi.fn(async () => db.server),
  getServers: vi.fn(async () => (db.server ? [db.server] : [])),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  logScheduleExecution: vi.fn(async () => {}),
  getScheduledTasks: vi.fn(async () => []),
  updateTaskLastRun: vi.fn(async () => {}),
  getTrackedMods: vi.fn(async () => []),
  isModIgnored: vi.fn(async () => false),
}));

const { ServerManager, managedStartupScriptName } = await import("../services/serverManager.js");
const { runManagedLifecycle } = await import("../services/managedContainer.js");
const { Scheduler } = await import("../services/scheduler.js");
const { ModChecker } = await import("../services/modChecker.js");
const { LinuxServiceLifecycle } = await import("../services/linuxServiceLifecycle.js");
const {
  acquireLifecycleLock,
  currentLaunchSequence,
  notifyServerLaunched,
  setServerLaunchedHook,
} = await import("../services/lifecycleCoordinator.js");
const { logServerEvent } = await import("../database/init.js");

let root;
let launches;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "server-launched-hook-"));
  launches = [];
  db.server = {
    id: "s1",
    name: "One",
    serverName: "servertest",
    installPath: root,
    zomboidDataPath: root,
    isRemote: false,
  };
  // The server's own generated script, which a systemd/openrc-managed start
  // checks for before calling the service manager (GH #167).
  fs.writeFileSync(path.join(root, managedStartupScriptName("servertest")), "");
  setServerLaunchedHook((launch) => {
    launches.push(launch);
  });
});

afterEach(() => {
  setServerLaunchedHook(null);
  vi.restoreAllMocks();
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
  fs.rmSync(root, { recursive: true, force: true });
});

// A systemd-managed server whose unit is `running` until stopped.
function managedServer(state = { running: false }) {
  db.server = { ...db.server, lifecycleProvider: "systemd" };
  const manager = new ServerManager({
    lifecycleFactory: () => ({
      run: async (action) => {
        if (action === "start" && state.running) {
          return { success: true, confirmed: true, alreadyRunning: true };
        }
        state.running = action !== "stop";
        return { success: true, confirmed: true };
      },
    }),
  });
  manager._deletePidFile = () => {};
  return manager;
}

describe("notifyServerLaunched", () => {
  it("never throws and never waits on the hook", () => {
    setServerLaunchedHook(() => {
      throw new Error("boom");
    });
    expect(() => notifyServerLaunched({ id: "s1" }, 1)).not.toThrow();
    setServerLaunchedHook(async () => {
      throw new Error("boom");
    });
    expect(notifyServerLaunched({ id: "s1" }, 1)).toBeUndefined();
  });

  it("ignores a call without a launch number", () => {
    notifyServerLaunched({ id: "s1" }, undefined);
    expect(launches).toEqual([]);
  });
});

describe("serverManager.startServer reports a launch only once it happened", () => {
  it("a start reports the server and a launch number taken when it began", async () => {
    const before = currentLaunchSequence();
    await managedServer().startServer();
    expect(launches).toEqual([{ serverId: "s1", launchSeq: before + 1 }]);
  });

  it("a unit that was already active launched nothing", async () => {
    await managedServer({ running: true }).startServer();
    expect(launches).toEqual([]);
  });

  it("a start refused because the server is already running launched nothing", async () => {
    const manager = new ServerManager();
    manager.getServerProcessDetails = vi.fn(async () => ({ running: true, scanFailed: false }));
    await expect(manager.startServer()).rejects.toThrow(/already running/);
    expect(launches).toEqual([]);
  });

  it("the real systemd lifecycle flags an already-active unit", async () => {
    const lifecycle = new LinuxServiceLifecycle(db.server, "systemd", {
      platform: "linux",
      containerized: false,
      execFile: vi.fn(async () => ({
        code: 0,
        stdout: "LoadState=loaded\nActiveState=active\nEnvironment=ZOMBOID_PANEL_SERVER_ID=s1\n",
        stderr: "",
      })),
    });
    expect(await lifecycle.run("start")).toMatchObject({ success: true, alreadyRunning: true });
  });
});

describe("managedContainer.runManagedLifecycle reports a container (re)start", () => {
  function dockerClient({ running = false, answer = { success: true } } = {}) {
    return {
      enabled: true,
      available: true,
      inspectManagedContainer: vi.fn(async () => ({ State: { Running: running } })),
      runManagedAction: vi.fn(async () => answer),
    };
  }

  beforeEach(() => {
    db.server = { ...db.server, dockerContainerName: "pz" };
  });

  it.each(["start", "restart"])("docker %s", async (action) => {
    await runManagedLifecycle(action, { serverId: "s1", dockerClient: dockerClient() });
    expect(launches).toHaveLength(1);
    expect(launches[0].serverId).toBe("s1");
  });

  it("not a container that was already running, nor Docker's 'already in that state'", async () => {
    await runManagedLifecycle("start", { serverId: "s1", dockerClient: dockerClient({ running: true }) });
    await runManagedLifecycle("start", {
      serverId: "s1",
      dockerClient: dockerClient({ answer: { success: true, unchanged: true } }),
    });
    expect(launches).toEqual([]);
  });

  it("not a failed start, nor a stop", async () => {
    await runManagedLifecycle("start", {
      serverId: "s1",
      dockerClient: dockerClient({ answer: { success: false, error: "nope" } }),
    });
    await runManagedLifecycle("stop", { serverId: "s1", dockerClient: dockerClient({ running: true }) });
    expect(launches).toEqual([]);
  });
});

describe("GH #189 end to end: a manual Restart cancels the mod-update restart waiting for players", () => {
  it("update found with players on, then Restart from the dashboard: no second restart", async () => {
    const realSetInterval = globalThis.setInterval;
    const ticks = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, ms, ...args) => {
      if (ms !== 120000) return realSetInterval(callback, ms, ...args);
      ticks.push(callback);
      return 189;
    });
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    // The mod checker, with the reporter's settings, wired the way
    // server/index.js wires it.
    const checker = new ModChecker();
    checker.delayIfPlayersOnline = true;
    checker.maxDelayMinutes = 120;
    checker.restartWarningMinutes = 5;
    const modScheduler = {
      rconService: {
        connected: true,
        getPlayers: vi.fn(async () => ({ success: true, players: ["a", "b"] })),
        serverMessage: vi.fn(async () => ({ success: true })),
      },
      performRestart: vi.fn(async () => ({ success: true })),
    };
    checker.scheduler = modScheduler;
    checker.serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })),
      resolveStartTime: vi.fn(async () => new Date(Date.now() - 3600000)),
    };
    setServerLaunchedHook((launch) => checker.noteServerLaunched(launch));

    await checker.handleModUpdate([{ workshopId: "2001", name: "Better Sorting" }]);
    expect(checker.pendingRestart).toBe(true);
    expect(ticks).toHaveLength(1);

    // The dashboard's Restart: scheduler.performRestart(warning, "Manual
    // restart") against a running systemd-managed server.
    const state = { running: true };
    const manager = managedServer(state);
    manager.getServerProcessDetails = vi.fn(async () => ({
      running: state.running,
      scanFailed: false,
    }));
    const rconService = {
      connected: true,
      execute: vi.fn(async () => ({ success: true })),
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => {
        state.running = false;
        return { success: true };
      }),
      serverMessage: vi.fn(async () => ({ success: true })),
      setServerStarting: vi.fn(),
    };
    const scheduler = new Scheduler(rconService, manager);
    scheduler.sleep = async () => {};

    const result = await scheduler.performRestart(0, { label: "Manual restart" });
    expect(result).toMatchObject({ success: true });
    expect(state.running).toBe(true);

    await vi.waitFor(() => expect(checker.pendingRestart).toBe(false));
    expect(logServerEvent).toHaveBeenCalledWith(
      "mod_update_restart_cancelled",
      expect.stringContaining("already runs the updated mods"),
    );

    // The players leave later; the old waiting loop does nothing.
    modScheduler.rconService.getPlayers = vi.fn(async () => ({ success: true, players: [] }));
    await ticks[0]();
    expect(modScheduler.performRestart).not.toHaveBeenCalled();
  });
});
