import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

// install-events-cross-install-contamination, 2026-09-18: POST /install's
// concurrency guard (hasActiveSteamOperation) is scoped PER installPath, so
// two operators -- or one operator running two setup wizards in two tabs --
// can genuinely run two DIFFERENT new-server installs at once, the exact
// shape steam-update-events-cross-server-contamination already found and
// fixed for /steam-update's steam:start/steam:log/steam:complete
// (steamUpdateEventsScopedToInstallPath.test.js, same technique mirrored
// here). install:log/install:complete had the identical gap: every
// connected client received every event with no identifier at all, so a
// second wizard's log lines interleaved into the first one's panel, and its
// install:complete could resolve the WRONG wizard as success/failure. This
// proves every install:* emit from one concurrent call carries THAT call's
// own installPath and never the other call's, by mocking child_process.spawn
// entirely -- no real SteamCMD spawned, works on every platform.

const getSettingMock = vi.fn(async () => null);
const setSettingMock = vi.fn(async () => {});
const logServerEventMock = vi.fn(async () => {});
const getActiveServerMock = vi.fn(async () => null);
const getServersMock = vi.fn(async () => []);

vi.mock("../database/init.js", () => ({
  logServerEvent: (...args) => logServerEventMock(...args),
  setSetting: (...args) => setSettingMock(...args),
  getSetting: (...args) => getSettingMock(...args),
  getActiveServer: (...args) => getActiveServerMock(...args),
  getServers: (...args) => getServersMock(...args),
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
// concurrent installs in this file can be driven independently.
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

function getInstallHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/install" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

let root;
let steamcmdPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-install-scope-"));
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
  getActiveServerMock.mockReset().mockResolvedValue(null);
  getServersMock.mockReset().mockResolvedValue([]);
  spawnedProcesses = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function buildRequest(installPath, serverName, io) {
  return {
    app: { get: (key) => (key === "io" ? io : undefined) },
    body: {
      steamcmdPath,
      installPath,
      serverName,
      branch: "public",
      zomboidDataPath: path.join(installPath, "..", `${serverName}_Data`),
    },
  };
}

async function waitForSpawnCount(n) {
  for (let i = 0; i < 100 && spawnedProcesses.length < n; i++) {
    await Promise.resolve();
  }
  return spawnedProcesses;
}

// The install:complete emit happens deep inside steamcmd.on("close", async
// (code) => {...}) -- an EVENT LISTENER, not part of the route handler's own
// returned promise, and (unlike steam-update) its success path does REAL
// async file I/O (writeFileAtomic for the INI/startup scripts), not just
// mocked-Promise microtasks. Awaiting the route handler's own promise (which
// already resolves right after res.json(), well before "close" is even
// emitted below) proves nothing about whether that later chain finished, and
// a plain `await Promise.resolve()` polling loop only drains microtasks --
// it never yields to the event loop's poll/check phases where that real I/O
// actually completes. setImmediate does yield there, once per iteration.
async function waitForCompleteCount(io, n) {
  for (
    let i = 0;
    i < 200 && io.emit.mock.calls.filter((c) => c[0] === "install:complete").length < n;
    i++
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return io.emit.mock.calls.filter((c) => c[0] === "install:complete");
}

describe("POST /api/server/install: install:* events are scoped to their own installPath", () => {
  it("tags install:log and install:complete with the requesting installPath, distinct per concurrent install", async () => {
    const handler = getInstallHandler();
    const io = { emit: vi.fn() };
    const installPathA = path.join(root, "install-a");
    const installPathB = path.join(root, "install-b");
    fs.mkdirSync(installPathA, { recursive: true });
    fs.mkdirSync(installPathB, { recursive: true });
    // A real install leaves this marker on disk -- present so neither
    // install:complete below collects an unrelated INSTALL_MISSING_GAME_FILES
    // warning, which isn't what this test is about.
    fs.writeFileSync(path.join(installPathA, "ProjectZomboid64.json"), "{}");
    fs.writeFileSync(path.join(installPathB, "ProjectZomboid64.json"), "{}");

    const resA = createResponse();
    const resB = createResponse();

    // Fire both requests before either resolves -- this is the exact shape
    // the concurrency guard already allows (different installPaths), and
    // the shape that used to make one wizard receive the other's events.
    const callA = handler(buildRequest(installPathA, "ServerA", io), resA);
    const callB = handler(buildRequest(installPathB, "ServerB", io), resB);
    const [childA, childB] = await waitForSpawnCount(2);
    expect(childA).toBeTruthy();
    expect(childB).toBeTruthy();

    childA.stdout.emit("data", Buffer.from("Update state (0x61) downloading, progress: 10.00 (1 / 10)\n"));
    childB.stdout.emit("data", Buffer.from("Update state (0x61) downloading, progress: 20.00 (2 / 10)\n"));
    childA.emit("close", 0);
    childB.emit("close", 0);
    const completeCalls = await waitForCompleteCount(io, 2);
    await Promise.all([callA, callB]);

    const logCalls = io.emit.mock.calls.filter((c) => c[0] === "install:log");

    // Every emitted install:* event must carry SOME installPath -- an
    // undefined one is exactly what let events go unfiltered on the client.
    for (const call of [...logCalls, ...completeCalls]) {
      expect(call[1].installPath).toBeTruthy();
    }

    // Each install's own events must name ITS OWN installPath -- never the
    // other install's.
    expect(logCalls.some((c) => c[1].text?.includes("10.00") && c[1].installPath === installPathA)).toBe(true);
    expect(logCalls.some((c) => c[1].text?.includes("20.00") && c[1].installPath === installPathB)).toBe(true);
    expect(logCalls.some((c) => c[1].text?.includes("10.00") && c[1].installPath === installPathB)).toBe(false);
    expect(logCalls.some((c) => c[1].text?.includes("20.00") && c[1].installPath === installPathA)).toBe(false);
    expect(completeCalls.filter((c) => c[1].installPath === installPathA)).toHaveLength(1);
    expect(completeCalls.filter((c) => c[1].installPath === installPathB)).toHaveLength(1);
    expect(completeCalls.find((c) => c[1].installPath === installPathA)[1].serverName).toBe("ServerA");
    expect(completeCalls.find((c) => c[1].installPath === installPathB)[1].serverName).toBe("ServerB");
  });
});
