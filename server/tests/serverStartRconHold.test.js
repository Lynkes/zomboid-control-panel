import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /start held the one process-wide lifecycle lock until the server's
// RCON answered -- 1-3 minutes of a Project Zomboid boot -- so no other
// server could be started or stopped meanwhile. Once the process is up, the
// wait now holds this server only (lifecycleCoordinator.js's
// holdServerUntilRcon). Same harness as serverStartSingleRconWaiter.test.js:
// the native path, with the process scan and RCON stubbed.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({ id: "native-server", isRemote: false })),
}));

vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn(async () => ({ handled: false })),
}));

const { default: router } = await import("../routes/server.js");
const { acquireLifecycleLock, getLifecycleState, lifecycleInProgressResponse } = await import(
  "../services/lifecycleCoordinator.js"
);

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// The process is up from the first scan; the RCON port opens when `rcon.open`
// is set.
function makeApp(rcon) {
  const values = {
    serverManager: {
      startServer: vi.fn(async () => ({ success: true, message: "Server starting" })),
      getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })),
    },
    rconService: {
      serverStarting: false,
      connected: false,
      config: { host: "127.0.0.1", port: 27015 },
      setServerStarting: vi.fn(function (value) {
        this.serverStarting = value;
      }),
      loadConfig: vi.fn(async () => {}),
      checkPortOpen: vi.fn(async () => rcon.open),
      connect: vi.fn(async function () {
        this.connected = true;
      }),
      forceResetConnectionState: vi.fn(),
    },
    io: { emit: vi.fn() },
    discordBot: { sendEventNotification: vi.fn().mockResolvedValue() },
    checkServerStatusNow: vi.fn(async () => {}),
  };
  return { get: (key) => values[key], _values: values };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /start -- the wait for RCON holds the started server only", () => {
  it("lets the other servers start and stop while it waits, and frees this one once RCON answers", async () => {
    const rcon = { open: false };
    const app = makeApp(rcon);

    await getHandler("/start", "post")({ app }, createResponse());
    // The process scan sees it running; the RCON port is still closed.
    await vi.advanceTimersByTimeAsync(20000);
    expect(app._values.rconService.checkPortOpen).toHaveBeenCalled();

    expect(getLifecycleState()).toMatchObject({
      lock: null,
      servers: [{ operation: "start", serverId: "native-server", phase: "waiting-for-rcon" }],
    });

    const other = acquireLifecycleLock("start", "other-server");
    expect(other).toBeTruthy();
    other.release();

    expect(acquireLifecycleLock("stop", "native-server")).toBeNull();
    expect(lifecycleInProgressResponse().holder).toMatchObject({
      operation: "start",
      serverId: "native-server",
      phase: "waiting-for-rcon",
    });

    rcon.open = true;
    await vi.advanceTimersByTimeAsync(20000);
    expect(app._values.rconService.connect).toHaveBeenCalled();
    expect(getLifecycleState()).toEqual({ lock: null, servers: [] });
    const stop = acquireLifecycleLock("stop", "native-server");
    expect(stop).toBeTruthy();
    stop.release();
  });

  it("holds every server until the process is up: the launch itself stays panel-wide", async () => {
    const rcon = { open: false };
    const app = makeApp(rcon);
    let resolveStart;
    app._values.serverManager.startServer.mockImplementation(
      () => new Promise((resolve) => { resolveStart = resolve; }),
    );

    const started = getHandler("/start", "post")({ app }, createResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(acquireLifecycleLock("start", "other-server")).toBeNull();
    expect(getLifecycleState().lock).toMatchObject({ operation: "start", serverId: "native-server" });

    resolveStart({ success: true, message: "Server starting" });
    await started;
    rcon.open = true;
    await vi.advanceTimersByTimeAsync(20000);
    expect(getLifecycleState()).toEqual({ lock: null, servers: [] });
  });
});
