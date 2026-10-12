import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWindowsPanelSupervisor } from "../utils/restartSupervisor.js";

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
