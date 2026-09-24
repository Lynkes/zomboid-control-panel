import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

// continuous-bug-hunt, 2026-09-18 (steamcmd-success-truth round): SteamCMD
// is well documented to exit 0 even when +app_update actually failed
// partway (a rejected/incomplete download, a corrupted manifest, a
// config-resolution failure) -- it just prints one or more "ERROR!"-
// prefixed lines (or "Missing configuration" for the config case) above an
// otherwise-clean exit. POST /steam-update used to trust `code === 0`
// alone, unlike POST /install's own hasPzInstallMarker() check for the
// identical "exit 0 lies" class. This proves the fix by mocking
// child_process.spawn entirely (fixture stdout, no real SteamCMD, no real
// process spawned at all -- works on every platform, unlike the real-
// shell-script fixture steamUpdateConcurrency.test.js uses, which is
// skipIf(win32) for exactly the reason its own comment states).

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
// spawned. The test controls stdout content and the exit code directly by
// calling the emitted helpers below, on every platform.
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
let installPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steamupdate-exit0-"));
  steamcmdPath = path.join(root, "steamcmd");
  installPath = path.join(root, "install");
  fs.mkdirSync(steamcmdPath, { recursive: true });
  fs.mkdirSync(installPath, { recursive: true });
  // getSteamCmdExe() resolves this exact path via fs.existsSync -- spawn()
  // itself is mocked above and never actually runs it, so content/mode
  // don't matter, only that it exists so the auto-download self-heal path
  // never triggers.
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

function buildRequest() {
  const serverManager = {
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  };
  const io = { emit: vi.fn() };
  const app = {
    get: (key) => (key === "serverManager" ? serverManager : key === "io" ? io : undefined),
  };
  return {
    req: {
      app,
      body: { steamcmdPath, installPath, branch: "stable" },
    },
    io,
  };
}

async function waitForSpawn() {
  for (let i = 0; i < 50 && spawnedProcesses.length === 0; i++) {
    await Promise.resolve();
  }
  return spawnedProcesses[0];
}

describe("POST /api/server/steam-update: exit code 0 is not trusted alone", () => {
  it("reports failure when SteamCMD exits 0 but printed an ERROR! line", async () => {
    const handler = getSteamUpdateHandler();
    const { req, io } = buildRequest();
    const res = createResponse();

    const callPromise = handler(req, res);
    const child = await waitForSpawn();

    child.stdout.emit(
      "data",
      Buffer.from(
        "Update state (0x5) verifying install, progress: 50.00\n" +
          "ERROR! Failed to install app '380870' (No subscription)\n",
      ),
    );
    child.emit("close", 0);
    await callPromise;

    const completeCall = io.emit.mock.calls.find((c) => c[0] === "steam:complete");
    expect(completeCall).toBeTruthy();
    const payload = completeCall[1];
    expect(payload.success).toBe(false);
    expect(payload.message).toMatch(/exited cleanly.*but reported an error/i);
  });

  it("reports failure when SteamCMD exits 0 but printed 'Missing configuration'", async () => {
    const handler = getSteamUpdateHandler();
    const { req, io } = buildRequest();
    const res = createResponse();

    const callPromise = handler(req, res);
    const child = await waitForSpawn();

    child.stdout.emit("data", Buffer.from("Missing configuration \"install\"\n"));
    child.emit("close", 0);
    await callPromise;

    const completeCall = io.emit.mock.calls.find((c) => c[0] === "steam:complete");
    expect(completeCall[1].success).toBe(false);
  });

  it("still reports success for a genuinely clean exit 0 with no error lines (no false failure from the fix)", async () => {
    const handler = getSteamUpdateHandler();
    const { req, io } = buildRequest();
    const res = createResponse();

    const callPromise = handler(req, res);
    const child = await waitForSpawn();

    child.stdout.emit(
      "data",
      Buffer.from("Success! App '380870' fully installed.\n"),
    );
    child.emit("close", 0);
    await callPromise;

    const completeCall = io.emit.mock.calls.find((c) => c[0] === "steam:complete");
    expect(completeCall[1].success).toBe(true);
  });
});
