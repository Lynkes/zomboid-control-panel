import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09-28 live Workshop test (PZ 42.21, Windows, Steam-mode dedicated
// server): a manual Start logged "Server detected as running / Waiting for
// RCON to be ready" three times, a second apart, then three "RCON port ...
// is now open!" lines each force-resetting the connection the others were
// opening ("Connection attempt cancelled (force reset occurred)").
//
// POST /start's process poll was setInterval(async ..., 1000) with its
// cleared flag checked only on entry, before the awaited process scan. A
// Windows scan takes longer than 1s, so several ticks were in flight at
// once; each saw running:true and each started waitForRconAfterStart().
// The poll now runs one scan at a time. These tests make the scan slower
// than the old 1s cadence and count the waiters (waitForRconAfterStart()
// calls rconService.loadConfig() once, first thing) and the overlap.

vi.mock("../database/init.js", () => ({
  // No serverName/zomboidDataPath: isFirstBootMissingAdminPassword() stays
  // false without touching the filesystem.
  getActiveServer: vi.fn(async () => ({ id: "native-server", isRemote: false })),
}));

// Not a container: the route takes the native path, serverManager.startServer()
// then the local process poll.
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn(async () => ({ handled: false })),
}));

const { default: router } = await import("../routes/server.js");
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");

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

// A process scan that takes `scanMs` and answers from `answers` in order
// (the last answer repeats). Tracks how many scans are in flight at once.
function slowScan(scanMs, answers) {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const fn = vi.fn(() => {
    const answer = answers[Math.min(stats.calls, answers.length - 1)];
    stats.calls++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    return new Promise((resolve) =>
      setTimeout(() => {
        stats.inFlight--;
        resolve(answer);
      }, scanMs),
    );
  });
  return { fn, stats };
}

function makeApp(getServerProcessDetails) {
  const values = {
    serverManager: {
      startServer: vi.fn(async () => ({ success: true, message: "Server starting" })),
      getServerProcessDetails,
    },
    rconService: {
      serverStarting: false,
      connected: false,
      config: { host: "127.0.0.1", port: 27015 },
      setServerStarting: vi.fn(function (value) {
        this.serverStarting = value;
      }),
      loadConfig: vi.fn(async () => {}),
      checkPortOpen: vi.fn(async () => true),
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

const RUNNING = { running: true, scanFailed: false };
const STOPPED = { running: false, scanFailed: false };
const UNKNOWN = { running: false, scanFailed: true };

function detectedCalls(app) {
  return app._values.checkServerStatusNow.mock.calls.filter(
    ([reason]) => reason === "start-detected",
  ).length;
}

// The route hands its lifecycle lock to the poll; the poll must give it
// back once it ends, or every later start/stop/restart answers 409.
function expectLifecycleLockReleased() {
  const lock = acquireLifecycleLock("test-probe", "native-server");
  expect(lock).toBeTruthy();
  lock?.release();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /start -- exactly one RCON waiter when the process scan is slower than the poll cadence", () => {
  it("starts a single waitForRconAfterStart() when the first scan already sees the server running", async () => {
    const scan = slowScan(2500, [RUNNING]);
    const app = makeApp(scan.fn);
    const response = createResponse();

    await getHandler("/start", "post")({ app }, response);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    await vi.advanceTimersByTimeAsync(10000);

    const { rconService, discordBot } = app._values;
    expect(rconService.loadConfig).toHaveBeenCalledTimes(1);
    expect(rconService.forceResetConnectionState).toHaveBeenCalledTimes(1);
    expect(rconService.connect).toHaveBeenCalledTimes(1);
    expect(discordBot.sendEventNotification).toHaveBeenCalledTimes(1);
    expect(detectedCalls(app)).toBe(1);
    expect(scan.stats.maxInFlight).toBe(1);
    expect(scan.fn).toHaveBeenCalledTimes(1);
    expect(rconService.setServerStarting).toHaveBeenLastCalledWith(false);
    expectLifecycleLockReleased();
  });

  it("never overlaps scans while the server is still coming up, then starts one waiter", async () => {
    const scan = slowScan(2500, [STOPPED, UNKNOWN, STOPPED, RUNNING]);
    const app = makeApp(scan.fn);

    await getHandler("/start", "post")({ app }, createResponse());
    await vi.advanceTimersByTimeAsync(30000);

    expect(app._values.rconService.loadConfig).toHaveBeenCalledTimes(1);
    expect(detectedCalls(app)).toBe(1);
    expect(scan.stats.maxInFlight).toBe(1);
    expect(scan.fn).toHaveBeenCalledTimes(4);
    expectLifecycleLockReleased();
  });

  it("still gives up after about 30s of wall-clock time, one scan at a time", async () => {
    const scan = slowScan(2500, [STOPPED]);
    const app = makeApp(scan.fn);

    await getHandler("/start", "post")({ app }, createResponse());
    const { rconService } = app._values;
    expect(rconService.setServerStarting).toHaveBeenLastCalledWith(true);

    // Not over yet at 25s: the poll still holds the lock and the window.
    await vi.advanceTimersByTimeAsync(25000);
    expect(acquireLifecycleLock("test-probe", "native-server")).toBeNull();
    expect(rconService.setServerStarting).toHaveBeenLastCalledWith(true);

    await vi.advanceTimersByTimeAsync(10000);

    expect(scan.stats.maxInFlight).toBe(1);
    // 1s gap + 2.5s scan per check: a 30s budget holds about nine scans,
    // not the 30 a scan-count budget would stretch to (~105s).
    expect(scan.fn.mock.calls.length).toBeLessThanOrEqual(10);
    expect(detectedCalls(app)).toBe(0);
    expect(rconService.loadConfig).not.toHaveBeenCalled();
    expect(rconService.setServerStarting).toHaveBeenLastCalledWith(false);
    expectLifecycleLockReleased();

    // And nothing keeps polling after the timeout.
    const callsAtTimeout = scan.fn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(scan.fn.mock.calls.length).toBe(callsAtTimeout);
  });
});
