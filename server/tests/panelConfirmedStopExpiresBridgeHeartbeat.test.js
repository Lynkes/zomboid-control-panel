import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09 Discord report (server "MAZE"): after a panel Stop that really did
// stop the server, the Servers card kept showing "PanelBridge Up" -- and so
// a Stop button -- for minutes, because the mod's last status.json write
// outlived the process. The status watchdog expires that heartbeat on a
// stopped VERDICT, but its verdict ORs the heartbeat back in whenever the
// host signal is not the final word (a scan that fails right after the
// stop, a systemd server the plain scan answered for), so a stop the panel
// has itself just confirmed expires the heartbeat directly -- before it asks
// the watchdog to re-check, so that re-check and the composed status every
// client refetches on its push already read PanelBridge offline. A stop the
// panel has only REQUESTED (RCON quit accepted) must not: the process, and
// its mod, may still be up.

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => ({ id: "maze", isRemote: false })),
}));

const { runManagedLifecycleMock } = vi.hoisted(() => ({
  runManagedLifecycleMock: vi.fn(async () => ({ handled: false })),
}));
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycleMock(...args),
}));

const { default: router } = await import("../routes/server.js");
const { default: panelBridge } = await import("../services/panelBridge.js");

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

// checkServerStatusNow records whether the mod still read as connected at
// the moment the route asked for the re-check.
function makeApp(overrides = {}) {
  const bridgeConnectedAtRecheck = [];
  const values = {
    rconService: {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue({ success: true, response: "Server shutting down" }),
    },
    io: { emit: vi.fn() },
    discordBot: { sendEventNotification: vi.fn().mockResolvedValue() },
    checkServerStatusNow: vi.fn(async (reason) => {
      bridgeConnectedAtRecheck.push({ reason, connected: panelBridge.isModConnected() });
    }),
    ...overrides,
  };
  return { app: { get: (key) => values[key] }, values, bridgeConnectedAtRecheck };
}

let markSpy;

beforeEach(() => {
  runManagedLifecycleMock.mockReset().mockResolvedValue({ handled: false });
  // The mod's last heartbeat: still inside the idle tolerance, reads live.
  panelBridge.modStatus = { alive: true, _wasAlive: true, serverName: "MAZE", playerCount: 0, players: [] };
  markSpy = vi.spyOn(panelBridge, "markServerExited");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  panelBridge.modStatus = null;
});

describe("a stop the panel itself confirmed expires the PanelBridge heartbeat before the watchdog re-check", () => {
  it("POST /stop on a managed systemd unit (the stop systemctl confirmed)", async () => {
    const serverManager = {
      loadConfig: vi.fn().mockResolvedValue(undefined),
      usesManagedServiceLifecycle: vi.fn().mockReturnValue(true),
      stopServer: vi.fn().mockResolvedValue({ success: true, confirmed: true }),
      markServerStopped: vi.fn(),
      lifecycleProvider: "systemd",
    };
    const { app, values, bridgeConnectedAtRecheck } = makeApp({ serverManager });

    await getHandler("/stop", "post")({ app, body: {} }, createResponse());

    expect(values.rconService.quit).not.toHaveBeenCalled();
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(bridgeConnectedAtRecheck).toEqual([{ reason: "managed-stop", connected: false }]);
  });

  it("POST /stop on a Docker container (Docker's stop only returns once it is stopped)", async () => {
    runManagedLifecycleMock.mockResolvedValueOnce({ handled: true, success: true, message: "Container stopping" });
    const { app, bridgeConnectedAtRecheck } = makeApp({ serverManager: { markServerStopped: vi.fn() } });

    await getHandler("/stop", "post")({ app, body: {} }, createResponse());

    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(bridgeConnectedAtRecheck).toEqual([{ reason: "managed-stop", connected: false }]);
  });

  it("POST /force-stop once the kill is confirmed -- and not when it is not", async () => {
    const serverManager = {
      stopServer: vi.fn().mockResolvedValue({ success: true, confirmed: true }),
      markServerStopped: vi.fn(),
    };
    const confirmed = makeApp({ serverManager });

    await getHandler("/force-stop", "post")({ app: confirmed.app, body: {} }, createResponse());

    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(confirmed.bridgeConnectedAtRecheck).toEqual([{ reason: "force-stop", connected: false }]);

    markSpy.mockClear();
    panelBridge.modStatus = { alive: true, _wasAlive: true, serverName: "MAZE", playerCount: 0, players: [] };
    const unconfirmed = makeApp({
      serverManager: {
        stopServer: vi.fn().mockResolvedValue({ success: true, confirmed: false, error: "still running" }),
        markServerStopped: vi.fn(),
      },
    });
    const response = createResponse();

    await getHandler("/force-stop", "post")({ app: unconfirmed.app, body: {} }, response);

    expect(response.status).toHaveBeenCalledWith(502);
    expect(markSpy).not.toHaveBeenCalled();
    expect(panelBridge.isModConnected()).toBe(true);
  });

  it("POST /stop over RCON: not at request time (quit only accepted), then as soon as the monitor's poll sees the process gone", async () => {
    vi.useFakeTimers();
    let exited = false;
    const serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: !exited, scanFailed: false })),
      stopServer: vi.fn(),
      markServerStopped: vi.fn(),
    };
    const { app, bridgeConnectedAtRecheck } = makeApp({ serverManager });

    await getHandler("/stop", "post")({ app, body: {} }, createResponse());

    // PZ is still saving and exiting: the mod may well still be writing.
    expect(markSpy).not.toHaveBeenCalled();
    expect(bridgeConnectedAtRecheck).toEqual([{ reason: "graceful-stop", connected: true }]);

    exited = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(serverManager.stopServer).not.toHaveBeenCalled();
    expect(bridgeConnectedAtRecheck.at(-1)).toEqual({ reason: "graceful-stop-confirmed", connected: false });
  });

  it("POST /stop over RCON that had to escalate to a force stop", async () => {
    vi.useFakeTimers();
    let killed = false;
    const serverManager = {
      getServerProcessDetails: vi.fn(async () => ({ running: !killed, scanFailed: false })),
      stopServer: vi.fn(async () => {
        killed = true;
        return { success: true, confirmed: true };
      }),
      markServerStopped: vi.fn(),
    };
    const { app, bridgeConnectedAtRecheck } = makeApp({ serverManager });

    await getHandler("/stop", "post")({ app, body: {} }, createResponse());
    await vi.advanceTimersByTimeAsync(65_000);

    expect(serverManager.stopServer).toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(bridgeConnectedAtRecheck.at(-1)).toEqual({ reason: "graceful-stop-escalated", connected: false });
  });
});
