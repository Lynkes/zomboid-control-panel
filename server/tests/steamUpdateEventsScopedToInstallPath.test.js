import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

// steam-update-events-cross-server-contamination, 2026-09-18: the
// concurrency guard in POST /steam-update is scoped per installPath (see
// steamUpdateConcurrency.test.js), so two operators -- or one operator with
// two servers registered -- can genuinely run an update/verify on two
// DIFFERENT servers at once. steam:start/steam:log/steam:complete used to
// carry no identifier at all, so whichever dialog a client had open
// received BOTH operations' events, and a stray steam:complete for a
// different server's operation could close the open dialog out as that
// server's own success/failure. This proves every steam:* emit from one
// concurrent call carries THAT call's own installPath and never the other
// call's, by mocking child_process.spawn entirely (fixture stdout, no real
// SteamCMD spawned, works on every platform) -- same technique as
// steamUpdateExitZeroErrorLine.test.js.

const getSettingMock = vi.fn(async () => null);
const setSettingMock = vi.fn(async () => {});
const logServerEventMock = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  logServerEvent: (...args) => logServerEventMock(...args),
  setSetting: (...args) => setSettingMock(...args),
  getSetting: (...args) => getSettingMock(...args),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

const scanHostForServerProcesses = vi.fn(async () => ({
  scanFailed: false,
  matched: [],
}));
vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

// Fully fake child process: no real SteamCMD (or anything else) is ever
// spawned. Each spawn() call gets its own EventEmitter so the two
// concurrent operations in this file can be driven independently.
let spawnedProcesses = [];
vi.mock("child_process", async () => {
  const actual = await vi.importActual("child_process");
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      spawnedProcesses.push(child);
      return child;
    }),
  };
});

const { default: router } = await import("../routes/server.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getSteamUpdateHandler() {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/steam-update" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

let root;
let steamcmdPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steamupdate-scope-"));
  steamcmdPath = path.join(root, "steamcmd");
  fs.mkdirSync(steamcmdPath, { recursive: true });
  const exeName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
  fs.writeFileSync(path.join(steamcmdPath, exeName), "");

  getSettingMock.mockReset().mockImplementation(async (key) => {
    if (key === "steamcmdPath") return steamcmdPath;
    return null;
  });
  setSettingMock.mockReset().mockResolvedValue(undefined);
  logServerEventMock.mockReset().mockResolvedValue(undefined);
  spawnedProcesses = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function buildRequest(installPath, io) {
  const serverManager = {
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  };
  const app = {
    get: (key) => (key === "serverManager" ? serverManager : key === "io" ? io : undefined),
  };
  return {
    app,
    body: { steamcmdPath, installPath, branch: "stable" },
  };
}

async function waitForSpawnCount(n) {
  for (let i = 0; i < 100 && spawnedProcesses.length < n; i++) {
    await Promise.resolve();
  }
  return spawnedProcesses;
}

describe("POST /api/server/steam-update: steam:* events are scoped to their own installPath", () => {
  it("tags steam:start, steam:log and steam:complete with the requesting installPath, distinct per concurrent operation", async () => {
    const handler = getSteamUpdateHandler();
    const io = { emit: vi.fn() };
    const installPathA = path.join(root, "install-a");
    const installPathB = path.join(root, "install-b");
    fs.mkdirSync(installPathA, { recursive: true });
    fs.mkdirSync(installPathB, { recursive: true });

    const resA = createResponse();
    const resB = createResponse();

    // Fire both requests before either resolves -- this is the exact shape
    // the concurrency guard already allows (different installPaths), and
    // the shape that used to make one dialog receive the other's events.
    const callA = handler(buildRequest(installPathA, io), resA);
    const callB = handler(buildRequest(installPathB, io), resB);
    const [childA, childB] = await waitForSpawnCount(2);
    expect(childA).toBeTruthy();
    expect(childB).toBeTruthy();

    childA.stdout.emit("data", Buffer.from("Update state (0x5) verifying install, progress: 10.00\n"));
    childB.stdout.emit("data", Buffer.from("Update state (0x5) verifying install, progress: 20.00\n"));
    childA.emit("close", 0);
    childB.emit("close", 0);
    await Promise.all([callA, callB]);

    const startCalls = io.emit.mock.calls.filter((c) => c[0] === "steam:start");
    const logCalls = io.emit.mock.calls.filter((c) => c[0] === "steam:log");
    const completeCalls = io.emit.mock.calls.filter((c) => c[0] === "steam:complete");

    // Every emitted steam:* event must carry SOME installPath -- an
    // undefined one is exactly what let events go unfiltered on the client.
    for (const call of [...startCalls, ...logCalls, ...completeCalls]) {
      expect(call[1].installPath).toBeTruthy();
    }

    // Each operation's own events must name ITS OWN installPath -- never
    // the other operation's.
    expect(startCalls.some((c) => c[1].installPath === installPathA)).toBe(true);
    expect(startCalls.some((c) => c[1].installPath === installPathB)).toBe(true);
    expect(logCalls.some((c) => c[1].text.includes("10.00") && c[1].installPath === installPathA)).toBe(true);
    expect(logCalls.some((c) => c[1].text.includes("20.00") && c[1].installPath === installPathB)).toBe(true);
    // Neither operation's log line is ever tagged with the OTHER path.
    expect(logCalls.some((c) => c[1].text.includes("10.00") && c[1].installPath === installPathB)).toBe(false);
    expect(logCalls.some((c) => c[1].text.includes("20.00") && c[1].installPath === installPathA)).toBe(false);
    expect(completeCalls.filter((c) => c[1].installPath === installPathA)).toHaveLength(1);
    expect(completeCalls.filter((c) => c[1].installPath === installPathB)).toHaveLength(1);
  });
});
