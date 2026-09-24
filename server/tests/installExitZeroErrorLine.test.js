import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { setSetting } from "../database/init.js";

// install-wizard-hunt, 2026-09-18: POST /install trusted `code === 0` alone
// as proof the install actually succeeded, unlike POST /steam-update's own
// steamCmdReportedError check (steamcmd-success-truth round, same night) --
// SteamCMD is well documented to exit 0 even when +app_update failed
// partway (a disk-full write failure mid-download, a rejected/incomplete
// download, a config-resolution failure), printing one or more "ERROR!"-
// prefixed lines (or "Missing configuration") above an otherwise-clean
// exit. hasPzInstallMarker() alone cannot catch this: the small launcher/
// metadata marker files it checks for can already exist on disk before a
// disk-full write failure hits the large game data files. Same
// child_process.spawn-mocking technique as installWarningsAndWatchdog.test.js.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
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

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeIoCapturingComplete() {
  let resolveComplete;
  const completePromise = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const io = {
    emit: vi.fn((event, payload) => {
      if (event === "install:complete") resolveComplete(payload);
    }),
  };
  return { io, completePromise };
}

describe("POST /api/server/install -- exit code 0 is not trusted alone", () => {
  let tmpRoot;
  let installPath;
  let zomboidDataPath;
  let steamcmdPath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-exit0-"));
    installPath = path.join(tmpRoot, "server");
    zomboidDataPath = path.join(tmpRoot, "data");
    steamcmdPath = path.join(tmpRoot, "steamcmd");
    fs.mkdirSync(installPath, { recursive: true });
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    fs.mkdirSync(steamcmdPath, { recursive: true });
    const steamcmdExeName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
    fs.writeFileSync(path.join(steamcmdPath, steamcmdExeName), "");
    // A real install leaves this marker on disk early -- present here so
    // INSTALL_MISSING_GAME_FILES never fires and each test below is only
    // ever proving the ERROR!-in-output check, not mixing in that sibling
    // warning.
    fs.writeFileSync(path.join(installPath, "ProjectZomboid64.json"), "{}");

    spawnMock.mockReset();
    vi.mocked(setSetting).mockReset();
    vi.mocked(setSetting).mockImplementation(async () => {});
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function baseBody(overrides = {}) {
    return {
      steamcmdPath,
      installPath,
      serverName: "TestServer",
      branch: "public",
      zomboidDataPath,
      adminPassword: "adminpw",
      rconPort: 27015,
      serverPort: 16261,
      minMemory: 2,
      maxMemory: 4,
      ...overrides,
    };
  }

  it("reports failure when SteamCMD exits 0 but printed an ERROR! line (e.g. disk full mid-download)", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    // Deferred via queueMicrotask, same as installWarningsAndWatchdog.test.js's
    // spawnMock -- spawn() itself is called synchronously deep inside the
    // route handler, with several awaits (steamcmdPath resolution, writable-
    // dir checks) before it, so emitting on fakeProc synchronously right
    // after calling the handler below would fire before the handler's own
    // stdout/close listeners are attached and be lost. Queuing the emits
    // instead guarantees they run only after spawn() returns AND this
    // route's own listeners are attached (both synchronous, same tick).
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        fakeProc.stdout.emit(
          "data",
          Buffer.from(
            "Update state (0x61) downloading, progress: 50.00 (500 / 1000)\n" +
              "ERROR! Disk write failure\n",
          ),
        );
        fakeProc.emit("close", 0);
      });
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(false);
    expect(payload.progressCode).toBe("INSTALL_STEAMCMD_REPORTED_ERROR");
    expect(payload.message).toMatch(/exited cleanly.*but reported an error/i);
  });

  it("reports failure when SteamCMD exits 0 but printed 'Missing configuration'", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        fakeProc.stdout.emit("data", Buffer.from("Missing configuration \"install\"\n"));
        fakeProc.emit("close", 0);
      });
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(false);
    expect(payload.progressCode).toBe("INSTALL_STEAMCMD_REPORTED_ERROR");
  });

  it("still reports success for a genuinely clean exit 0 with no error lines (no false failure from the fix)", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        fakeProc.stdout.emit("data", Buffer.from("Success! App '380870' fully installed.\n"));
        fakeProc.emit("close", 0);
      });
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
  });
});
