import fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOrchestratedProcess,
  isWindowsPanelSupervisor,
} from "../utils/restartSupervisor.js";

// POST /api/panel/restart with NO staged update: what the process does on its
// way out decides whether the thing that launched it brings it back.
//
// Windows, under Start.bat (PANEL_SUPERVISOR_V=2): Start.bat relaunches on
// exit 75 and treats exit 0 as "the operator stopped the panel" (it prints
// "Panel exited cleanly" and quits). The panel used to spawn a copy of itself
// and exit 0, so the supervisor quit while the new panel inherited
// PANEL_SUPERVISOR_V=2 and believed it was supervised; a later Restart and
// Apply wrote .update-pending and exited 75 with nobody left to apply it.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: { fn: null } }));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { vi: vitest } = await import("vitest");
  const { EventEmitter } = await import("events");
  spawnMock.fn = vitest.fn(() => Object.assign(new EventEmitter(), { unref: () => {} }));
  return { ...actual, default: { ...actual, spawn: spawnMock.fn }, spawn: spawnMock.fn };
});

vi.mock("../services/containerShutdown.js", async (importOriginal) => {
  const { vi: vitest } = await import("vitest");
  return {
    ...(await importOriginal()),
    saveAndStopLocalServers: vitest.fn(async () => ({ attempted: 1, stopped: true })),
  };
});

vi.mock("../services/panelBridge.js", async () => {
  const { EventEmitter } = await import("events");
  const { vi: vitest } = await import("vitest");
  const fake = new EventEmitter();
  fake.isRunning = false;
  fake.stop = vitest.fn();
  return { default: fake };
});

const { app } = await import("../index.js");

function getRestartHandler() {
  const layer = app.router.stack.find(
    (l) => l.route?.path === "/api/panel/restart" && l.route.methods.post,
  );
  if (!layer) throw new Error("No POST /api/panel/restart route registered");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

const noStagedUpdate = {
  app: {
    get: (key) =>
      key === "panelUpdateChecker"
        ? {
            isApplying: false,
            getStagedUpdate: () => null,
            isSupervisorAvailable: () => true,
          }
        : undefined,
  },
};

const ENV_KEYS = ["PANEL_SUPERVISOR_V", "PANEL_PRESERVE_GAME_SERVERS", "INVOCATION_ID", "NOTIFY_SOCKET"];
let originalPkg;
let originalPlatform;
let savedEnv;

function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

// Runs the handler and lets its 1 s exit timer (and the async flush inside
// it) finish.
async function restartAndWaitForExit() {
  await getRestartHandler()(noStagedUpdate, makeRes());
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalled());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  originalPkg = process.pkg;
  originalPlatform = process.platform;
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  vi.spyOn(process, "exit").mockImplementation(() => {});
  spawnMock.fn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  process.pkg = originalPkg;
  setPlatform(originalPlatform);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("isWindowsPanelSupervisor", () => {
  it("is Start.bat v2 on Windows only", () => {
    expect(isWindowsPanelSupervisor({ platform: "win32", env: { PANEL_SUPERVISOR_V: "2" } })).toBe(true);
    expect(isWindowsPanelSupervisor({ platform: "win32", env: {} })).toBe(false);
    expect(isWindowsPanelSupervisor({ platform: "win32", env: { PANEL_SUPERVISOR_V: "1" } })).toBe(false);
    expect(isWindowsPanelSupervisor({ platform: "linux", env: { PANEL_SUPERVISOR_V: "2" } })).toBe(false);
  });
});

describe("plain Restart Panel (no staged update)", () => {
  it("exits 75 under Start.bat and does not respawn itself", async () => {
    process.pkg = {};
    setPlatform("win32");
    process.env.PANEL_SUPERVISOR_V = "2";

    await restartAndWaitForExit();

    expect(spawnMock.fn).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(75);
  });

  it("still respawns itself on Windows without a supervisor", async () => {
    process.pkg = {};
    setPlatform("win32");

    await restartAndWaitForExit();

    expect(spawnMock.fn).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("keeps exiting 75 under the Linux supervisor", async () => {
    process.pkg = {};
    setPlatform("linux");
    process.env.PANEL_SUPERVISOR_V = "2";
    process.env.PANEL_PRESERVE_GAME_SERVERS = "1";

    await restartAndWaitForExit();

    expect(spawnMock.fn).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(75);
  });
});

// The Docker image runs `node server/index.js`, so it is never `process.pkg`.
// Orchestrator detection only ran for the packaged exe, so the unpackaged
// panel exited 0 and a container with `restart: on-failure` (or no policy)
// stayed stopped after the Restart button. Exit 1 makes any policy restart it.
describe("plain Restart Panel of an unpackaged panel (the Docker image)", () => {
  it("exits 1 under systemd", async () => {
    process.pkg = undefined;
    setPlatform("linux");
    process.env.INVOCATION_ID = "0123456789abcdef";

    await restartAndWaitForExit();

    expect(spawnMock.fn).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 inside a container", async () => {
    process.pkg = undefined;
    setPlatform("linux");
    // /.dockerenv exists in the container; stand in for it.
    const real = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((target) =>
      target === "/.dockerenv" ? true : real(target),
    );

    await restartAndWaitForExit();

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("still exits 0 when nothing will restart it (a dev run)", async () => {
    process.pkg = undefined;
    setPlatform("linux");

    await restartAndWaitForExit();

    expect(spawnMock.fn).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});

describe("isOrchestratedProcess", () => {
  it("recognises systemd, Docker and Podman", () => {
    const none = () => false;
    expect(isOrchestratedProcess({ env: { INVOCATION_ID: "x" }, existsSync: none })).toBe(true);
    expect(isOrchestratedProcess({ env: { NOTIFY_SOCKET: "/run/systemd/notify" }, existsSync: none })).toBe(true);
    expect(isOrchestratedProcess({ env: {}, existsSync: (p) => p === "/.dockerenv" })).toBe(true);
    expect(isOrchestratedProcess({ env: {}, existsSync: (p) => p === "/run/.containerenv" })).toBe(true);
    expect(isOrchestratedProcess({ env: {}, existsSync: none })).toBe(false);
  });

  it("treats a failing filesystem check as not orchestrated", () => {
    expect(
      isOrchestratedProcess({
        env: {},
        existsSync: () => {
          throw new Error("EACCES");
        },
      }),
    ).toBe(false);
  });
});

// In the all-in-one image the game servers die with the container, and the
// container is what restarts: same as `docker stop`, they are saved and
// quit first (gracefulShutdownContainer.test.js covers the SIGTERM path).
describe("plain Restart Panel in the all-in-one container", () => {
  it("saves and quits the game servers before exiting", async () => {
    const { saveAndStopLocalServers } = await import("../services/containerShutdown.js");
    saveAndStopLocalServers.mockClear();
    process.pkg = undefined;
    setPlatform("linux");
    process.env.INVOCATION_ID = "0123456789abcdef";
    process.env.PANEL_ALL_IN_ONE = "true";
    try {
      await restartAndWaitForExit();
    } finally {
      delete process.env.PANEL_ALL_IN_ONE;
    }

    expect(saveAndStopLocalServers).toHaveBeenCalledTimes(1);
    expect(saveAndStopLocalServers.mock.invocationCallOrder[0]).toBeLessThan(
      process.exit.mock.invocationCallOrder[0],
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("leaves the servers alone everywhere else", async () => {
    const { saveAndStopLocalServers } = await import("../services/containerShutdown.js");
    saveAndStopLocalServers.mockClear();
    process.pkg = undefined;
    setPlatform("linux");
    process.env.INVOCATION_ID = "0123456789abcdef";

    await restartAndWaitForExit();

    expect(saveAndStopLocalServers).not.toHaveBeenCalled();
  });
});
