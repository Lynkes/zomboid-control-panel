import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The before-launch hook is how PanelBridge delivery reaches EVERY start and
// restart -- dashboard, scheduled, mod-update, Discord, boot auto-start,
// post-update -- instead of only the two HTTP routes that used to install the
// bridge (critique B.22). It lives in the two functions every launch funnels
// through: serverManager.startServer() and managedContainer.
// runManagedLifecycle(). These tests pin where it runs and that it can never
// stop a launch.

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
}));

const { ServerManager, managedStartupScriptName } = await import("../services/serverManager.js");
const { runManagedLifecycle } = await import("../services/managedContainer.js");
const { Scheduler } = await import("../services/scheduler.js");
const { setBeforeLaunchHook, runBeforeLaunchHook, acquireLifecycleLock } = await import(
  "../services/lifecycleCoordinator.js"
);
const { getActiveSteamOperations } = await import("../services/activeSteamOperations.js");

let root;
let order;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-launch-hook-"));
  order = [];
  db.server = { id: "s1", name: "One", serverName: "servertest", installPath: root, zomboidDataPath: root, isRemote: false };
  // The server's own generated script, which a systemd/openrc-managed start
  // checks for before calling the service manager (GH #167). No refresher is
  // wired here to write it.
  fs.writeFileSync(path.join(root, managedStartupScriptName("servertest")), "");
  setBeforeLaunchHook(async (server) => {
    order.push(`hook:${server?.id}`);
  });
});

afterEach(() => {
  setBeforeLaunchHook(null);
  getActiveSteamOperations().clear();
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runBeforeLaunchHook", () => {
  it("is a no-op without a hook or a server", async () => {
    setBeforeLaunchHook(null);
    expect(await runBeforeLaunchHook(db.server)).toBeNull();
    setBeforeLaunchHook(() => order.push("x"));
    expect(await runBeforeLaunchHook(null)).toBeNull();
    expect(order).toEqual([]);
  });

  it("swallows a throwing or rejecting hook", async () => {
    setBeforeLaunchHook(() => {
      throw new Error("boom");
    });
    await expect(runBeforeLaunchHook(db.server)).resolves.toBeNull();
    setBeforeLaunchHook(async () => {
      throw new Error("boom");
    });
    await expect(runBeforeLaunchHook(db.server)).resolves.toBeNull();
  });
});

describe("serverManager.startServer", () => {
  it("runs the hook after the SteamCMD guard: a start refused for an in-flight SteamCMD write never reaches it", async () => {
    getActiveSteamOperations().set(path.normalize(root).toLowerCase(), { type: "update" });
    const manager = new ServerManager();
    await expect(manager.startServer()).rejects.toThrow(/Steam install or update/);
    expect(order).toEqual([]);
  });

  it("runs the hook before the native launch path's own process check", async () => {
    const manager = new ServerManager();
    manager.getServerProcessDetails = vi.fn(async () => {
      order.push("processCheck");
      return { running: true, scanFailed: false };
    });
    await expect(manager.startServer()).rejects.toThrow(/already running/);
    expect(order).toEqual(["hook:s1", "processCheck"]);
  });

  it("runs the hook before a systemd/openrc-managed start", async () => {
    db.server = { ...db.server, lifecycleProvider: "systemd" };
    const manager = new ServerManager({
      lifecycleFactory: () => ({
        run: async (action) => {
          order.push(`managed:${action}`);
          return { success: true };
        },
      }),
    });
    manager._deletePidFile = () => {};
    await manager.startServer();
    expect(order).toEqual(["hook:s1", "managed:start"]);
  });

  it("a throwing hook never blocks the start", async () => {
    setBeforeLaunchHook(async () => {
      order.push("hook");
      throw new Error("reconcile exploded");
    });
    db.server = { ...db.server, lifecycleProvider: "systemd" };
    const manager = new ServerManager({
      lifecycleFactory: () => ({ run: async (action) => (order.push(`managed:${action}`), { success: true }) }),
    });
    manager._deletePidFile = () => {};
    await expect(manager.startServer()).resolves.toMatchObject({ success: true });
    expect(order).toEqual(["hook", "managed:start"]);
  });
});

describe("managedContainer.runManagedLifecycle", () => {
  function dockerClient() {
    return {
      enabled: true,
      available: true,
      inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
      runManagedAction: vi.fn(async (_ref, action) => {
        order.push(`docker:${action}`);
        return { success: true };
      }),
    };
  }

  beforeEach(() => {
    db.server = { ...db.server, dockerContainerName: "pz" };
  });

  it.each(["start", "restart"])("runs the hook right before docker %s", async (action) => {
    await runManagedLifecycle(action, { serverId: "s1", dockerClient: dockerClient() });
    expect(order).toEqual(["hook:s1", `docker:${action}`]);
  });

  it("does not run it for stop", async () => {
    const client = dockerClient();
    client.inspectManagedContainer = vi.fn(async () => ({ State: { Running: true } }));
    await runManagedLifecycle("stop", { serverId: "s1", dockerClient: client });
    expect(order).toEqual(["docker:stop"]);
  });

  it("a failing server lookup doesn't block the container start", async () => {
    const { getServer } = await import("../database/init.js");
    const client = dockerClient();
    getServer.mockResolvedValueOnce(db.server).mockResolvedValueOnce(db.server).mockRejectedValueOnce(new Error("db"));
    await runManagedLifecycle("start", { serverId: "s1", dockerClient: client });
    expect(order).toEqual(["docker:start"]);
  });
});

describe("a scheduled restart reaches the hook (performRestart -> startServer)", () => {
  it("runs the hook for an unattended restart of a stopped server", async () => {
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    const manager = new ServerManager();
    let checks = 0;
    // First read: performRestart sees the server stopped and starts it.
    // Second read: startServer()'s own pre-spawn check -- report it running
    // so the test never spawns a real process.
    manager.getServerProcessDetails = vi.fn(async () => {
      checks += 1;
      return { running: checks > 1, scanFailed: false };
    });
    const rconService = { connected: false, execute: vi.fn(async () => ({ success: false })) };
    // The start itself is refused by that second check ("already running"),
    // which performRestart reports however it reports it -- the hook has
    // already run by then, which is what this test is about.
    await scheduler.performRestart(0, { rconService, serverManager: manager }).catch(() => {});
    expect(order[0]).toBe("hook:s1");
    expect(checks).toBe(2);
  });
});
