import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-09-02, bridge-enforcement: PanelBridge.lua has to be current on disk
// BEFORE the game process spawns -- PZ loads Lua at Java-process startup, so
// a fresher file written afterward is invisible until the next restart.
//
// That used to be done by POST /server/start and /server/restart themselves,
// which left every other start path (scheduled and mod-update restarts,
// Discord, boot auto-start) unsynced (critique B.22). It now lives in the
// before-launch hook (lifecycleCoordinator.setBeforeLaunchHook, wired to
// bridgeDelivery.reconcileBridge in index.js) inside the two functions every
// launch funnels through -- serverManager.startServer() and
// managedContainer.runManagedLifecycle(). So these tests assert both halves:
// the routes no longer write the file themselves, and a /start through the
// REAL runManagedLifecycle still has the file current by the time the
// container is actually started. Every test starts from a genuinely STALE
// file and checks the content AT SPAWN TIME, not afterward.

let activeServer;
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => activeServer),
  getServer: vi.fn(async () => activeServer),
  getServers: vi.fn(async () => (activeServer ? [activeServer] : [])),
  getSetting: vi.fn(async () => null),
}));

const { default: router } = await import("../routes/server.js");
const { resolveSourcePath } = await import("../services/panelBridgeInstaller.js");
const { setDockerClient } = await import("../services/managedContainer.js");
const { setBeforeLaunchHook } = await import("../services/lifecycleCoordinator.js");
const { reconcileBridge } = await import("../services/bridgeDelivery.js");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  // requirePermission is applied inline per-route in server.js, so the real
  // handler is the LAST entry in this route's middleware stack.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function makeStartApp(overrides = {}) {
  const values = {
    serverManager: {
      getServerProcessDetails: vi.fn(async () => ({
        running: false,
        scanFailed: false,
      })),
    },
    rconService: {
      serverStarting: false,
      connected: false,
      config: { host: "127.0.0.1", port: 27015 },
      loadConfig: vi.fn(async () => {}),
      checkPortOpen: vi.fn(async () => true),
      connect: vi.fn(async function () {
        this.connected = true;
      }),
      forceResetConnectionState: vi.fn(),
    },
    io: { emit: vi.fn() },
    discordBot: { sendEventNotification: vi.fn().mockResolvedValue() },
    ...overrides,
  };
  return { get: (key) => values[key], _values: values };
}

// A Docker-managed server (handled: true) sidesteps /start's 30s
// local-process poll entirely -- see dockerStartStatusPush.test.js, same
// reasoning -- while still going through the REAL runManagedLifecycle,
// which is where the before-launch hook lives.
function fakeDockerClient(onStart) {
  return {
    enabled: true,
    available: true,
    inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
    runManagedAction: vi.fn(async (_ref, action) => {
      onStart(action);
      return { success: true, message: "Container starting" };
    }),
  };
}

let tmpDir;
const targetLua = () => path.join(tmpDir, "media", "lua", "server", "PanelBridge.lua");
const bundledContent = () => fs.readFileSync(resolveSourcePath(), "utf8");
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function writeStaleBridge() {
  fs.mkdirSync(path.dirname(targetLua()), { recursive: true });
  fs.writeFileSync(targetLua(), 'local VERSION = "0.0.1"\n');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-autoinstall-route-"));
  // installPath is real so the installer's own fs writes land somewhere
  // disposable; no serverName/zomboidDataPath keeps
  // refreshLaunchTargetBeforeStart()'s ensureRconConfigured() call a
  // harmless no-op.
  activeServer = { id: "s1", name: "Test Server", installPath: tmpDir, isRemote: false, dockerContainerName: "pz" };
  setBeforeLaunchHook((server) => reconcileBridge(server, { reason: "launch" }));
});

afterEach(() => {
  setBeforeLaunchHook(null);
  setDockerClient(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /server/start -- the bridge is current by the time the container starts", () => {
  it("has already overwritten a stale bridge when runManagedLifecycle starts the container", async () => {
    writeStaleBridge();
    let contentAtSpawnTime;
    setDockerClient(fakeDockerClient(() => {
      contentAtSpawnTime = fs.readFileSync(targetLua(), "utf8");
    }));

    const response = createResponse();
    await getHandler("/start", "post")({ app: makeStartApp() }, response);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(contentAtSpawnTime).toBe(bundledContent());
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("leaves an already-current bridge untouched (no needless rewrite on every start)", async () => {
    fs.mkdirSync(path.dirname(targetLua()), { recursive: true });
    fs.writeFileSync(targetLua(), bundledContent());
    const mtimeBefore = fs.statSync(targetLua()).mtimeMs;
    setDockerClient(fakeDockerClient(() => {}));

    await getHandler("/start", "post")({ app: makeStartApp() }, createResponse());
    await flushMicrotasks();

    expect(fs.statSync(targetLua()).mtimeMs).toBe(mtimeBefore);
  });

  it("still starts the server when the bridge install itself fails", async () => {
    // "media" as a plain file forces installBridge()'s directory creation to
    // fail with ENOTDIR -- same shape panelBridgeInstaller.test.js uses.
    fs.writeFileSync(path.join(tmpDir, "media"), "not a directory");
    const started = vi.fn();
    setDockerClient(fakeDockerClient(started));

    const response = createResponse();
    await getHandler("/start", "post")({ app: makeStartApp() }, response);
    await flushMicrotasks();

    expect(started).toHaveBeenCalledWith("start");
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("the route itself no longer writes the file -- only the launch hook does", async () => {
    writeStaleBridge();
    setBeforeLaunchHook(null);
    let contentAtSpawnTime;
    setDockerClient(fakeDockerClient(() => {
      contentAtSpawnTime = fs.readFileSync(targetLua(), "utf8");
    }));

    await getHandler("/start", "post")({ app: makeStartApp() }, createResponse());
    await flushMicrotasks();

    expect(contentAtSpawnTime).toBe('local VERSION = "0.0.1"\n');
  });
});

describe("POST /server/restart -- the route hands the launch to performRestart untouched", () => {
  it("does not write the bridge itself; performRestart's own start runs the hook", async () => {
    writeStaleBridge();
    let contentWhenHandedOff;
    const performRestart = vi.fn(async () => {
      contentWhenHandedOff = fs.readFileSync(targetLua(), "utf8");
      return { success: true, message: "Restarted successfully" };
    });
    const app = {
      get: (key) => (key === "scheduler" ? { performRestart } : key === "io" ? { emit: vi.fn() } : null),
    };
    const response = createResponse();

    await getHandler("/restart", "post")({ body: {}, app }, response);
    await flushMicrotasks();

    expect(performRestart).toHaveBeenCalled();
    expect(contentWhenHandedOff).toBe('local VERSION = "0.0.1"\n');
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
