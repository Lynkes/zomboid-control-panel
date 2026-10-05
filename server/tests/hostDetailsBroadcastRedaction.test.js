import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";

// Security sweep 2026-10-05, H4: events every signed-in socket receives, and
// routes every role reads, carried raw err.message text that quotes host
// folders: server:updateCheckFailed and server:autoUpdateComplete (the
// SteamCMD and install folders), mods:restart_failed and
// scheduler:action_result (a failed start's install folder), the panel
// update status's lastError (the staged binary's folder), and GET
// /api/servers/status's detectionError (the scan's tool or a folder). Each is
// path-redacted now; the panel log keeps the full text.

const settings = new Map();
const db = vi.hoisted(() => ({ active: { id: "s1", name: "One", installPath: "/srv/pz/install" } }));

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => settings.get(key) ?? null),
  setSetting: vi.fn(async (key, value) => {
    settings.set(key, value);
  }),
  getActiveServer: vi.fn(async () => db.active),
  getServer: vi.fn(async () => db.active),
  getServers: vi.fn(async () => []),
  getTrackedMods: vi.fn(async () => []),
  updateModTimestamp: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  addTrackedMod: vi.fn(async () => {}),
  isModIgnored: vi.fn(async () => false),
  markModsChecked: vi.fn(async () => {}),
  getRoleByName: vi.fn(async () => null),
}));

const scanHostForServerProcesses = vi.fn();
vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

const { UpdateChecker } = await import("../services/updateChecker.js");
const { ModChecker } = await import("../services/modChecker.js");
const { emitActionResult } = await import("../routes/scheduler.js");
const { redactUpdateStatus } = await import("../services/panelUpdateChecker.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");

const BS = String.fromCharCode(92);
// A Windows install folder with spaces, the shape the old patterns cut short.
const INSTALL = ["C:", "Program Files (x86)", "Steam", "steamapps", "common", "Project Zomboid Dedicated Server"].join(BS);
// A folder name that only appears if a path got through.
const MARKER = `zcp-h4-${process.pid}`;

function expectNoHostPath(value) {
  const text = JSON.stringify(value);
  expect(text).not.toContain("Program Files");
  expect(text).not.toContain("Dedicated Server");
  expect(text).not.toContain(MARKER);
  expect(text).not.toContain("/srv/pz");
}

beforeEach(() => {
  settings.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  const stray = acquireLifecycleLock("test-cleanup");
  if (stray) stray.release();
});

describe("server update checker", () => {
  it("server:updateCheckFailed and GET /update-check/status carry a redacted lastError", async () => {
    settings.set("steamcmdPath", "/srv/pz/steamcmd");
    settings.set("serverPath", INSTALL);
    const io = { emit: vi.fn() };
    const checker = new UpdateChecker(io, {});
    checker.getInstalledBuildInfo = async () => {
      throw new Error(`EACCES: permission denied, open '${INSTALL}${BS}steamapps${BS}appmanifest_380870.acf'`);
    };

    expect(await checker.checkForUpdates(true)).toBeNull();

    const [, payload] = io.emit.mock.calls.find(([event]) => event === "server:updateCheckFailed");
    expect(payload.lastError).toContain("EACCES: permission denied");
    expectNoHostPath(payload);
    expectNoHostPath((await checker.getStatus()).lastError);
  });

  it("server:autoUpdateComplete carries a redacted error", async () => {
    const steamcmdDir = path.join(os.tmpdir(), MARKER, "steamcmd");
    settings.set("serverAutoUpdate", true);
    settings.set("steamcmdPath", steamcmdDir);
    const io = { emit: vi.fn() };
    const checker = new UpdateChecker(io, {
      rconService: { connected: true },
      serverManager: { getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })) },
    });

    await expect(
      checker.runAutoUpdate({ installed: { buildId: "1", branch: "public" }, latest: { buildId: "2" } }),
    ).rejects.toThrow(/SteamCMD not found/);

    const [, payload] = io.emit.mock.calls.find(([event]) => event === "server:autoUpdateComplete");
    expect(payload).toMatchObject({ success: false });
    expect(payload.error).toContain("SteamCMD not found at [path]");
    expectNoHostPath(payload);
  });
});

describe("mods:restart_failed", () => {
  it("carries a redacted message when the restart reports a failure", async () => {
    const checker = new ModChecker();
    checker.delayIfPlayersOnline = false;
    checker.restartWarningMinutes = 1;
    checker.scheduler = {
      rconService: {
        connected: true,
        getPlayers: vi.fn(async () => ({ success: true, players: [] })),
        serverMessage: vi.fn(async () => ({ success: true })),
      },
      restartWarning: { locale: "en" },
      performRestart: vi.fn(async () => ({
        success: false,
        message: `Start script missing from ${INSTALL}${BS}start-server.bat`,
      })),
      cancelRestart: vi.fn(),
    };
    checker.serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false, matched: [] })),
      resolveStartTime: vi.fn(async () => null),
    };
    checker.io = { emit: vi.fn() };

    await checker.handleModUpdate([{ workshopId: "2001", name: "Better Sorting" }]);

    const call = checker.io.emit.mock.calls.find(([event]) => event === "mods:restart_failed");
    expect(call).toBeTruthy();
    expect(call[1].error).toContain("Start script missing from [path]");
    expectNoHostPath(call[1]);
  });
});

describe("scheduler:action_result", () => {
  it("is path-redacted for every caller", () => {
    const io = { emit: vi.fn() };
    emitActionResult(io, {
      kind: "restart",
      success: false,
      message: `Could not start: ${INSTALL}${BS}ProjectZomboid64.json is missing`,
    });
    const [event, payload] = io.emit.mock.calls[0];
    expect(event).toBe("scheduler:action_result");
    expect(payload).toMatchObject({ kind: "restart", success: false, message: "Could not start: [path] is missing" });
  });
});

describe("panel update status for roles without panel.settings", () => {
  it("redacts lastError", () => {
    const status = {
      updateAvailable: true,
      lastError: `EPERM: operation not permitted, rename '${path.join(os.tmpdir(), MARKER, "panel.exe.partial")}'`,
    };
    const redacted = redactUpdateStatus(status);
    expect(redacted.lastError).toBe("EPERM: operation not permitted, rename '[path]'");
    expect(status.lastError).toContain(MARKER);
  });
});

describe("GET /api/servers/status", () => {
  it("redacts a failed scan's error", async () => {
    scanHostForServerProcesses.mockResolvedValue({
      scanFailed: true,
      matched: [],
      error: `spawn ${INSTALL}${BS}tools${BS}scan.exe ENOENT`,
    });
    const layer = serversRouter.stack.find((entry) => entry.route?.path === "/status" && entry.route.methods.get);
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    await layer.route.stack[0].handle({ app: { get: () => ({ isRunning: false }) } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.detectionError).toBe("spawn [path] ENOENT");
    expectNoHostPath(body);
  });
});
