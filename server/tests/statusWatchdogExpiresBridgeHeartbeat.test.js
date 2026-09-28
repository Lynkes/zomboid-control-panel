import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09 Discord report (Windows native, server "MAZE"): a panel Stop really
// stopped the server, but the Servers card showed "Process Down", "RCON
// Down", "PanelBridge Up" and a Stop button for minutes, and the Dashboard
// took as long to offer Start. The PanelBridge heartbeat (status.json's age,
// tolerated for 5 minutes when the last write said 0 players) outlived the
// process. The watchdog is what first knows the process is gone, so it now
// expires that heartbeat (PanelBridge.markServerExited()) -- and does so
// BEFORE it pushes server:status, because every page refetches the composed
// host/RCON/PanelBridge status on that push and must already read
// PanelBridge offline when it does.
//
// Module-level watchdog state (lastKnownRunning) carries across the tests in
// this file, in order -- each test says what state it starts from.

const getActiveServer = vi.fn(async () => ({ id: 1, name: "MAZE", isRemote: false }));
const logServerEventMock = vi.fn(async () => ({}));
vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getActiveServer, logServerEvent: logServerEventMock };
});

const { checkServerStatusNow, io } = await import("../index.js");
const { ServerManager } = await import("../services/serverManager.js");
const { DiscordBot } = await import("../services/discordBot.js");
const { default: panelBridge } = await import("../services/panelBridge.js");

let emitSpy;
let markSpy;
let scanSpy;

beforeEach(() => {
  emitSpy = vi.spyOn(io, "emit").mockImplementation(() => {});
  markSpy = vi.spyOn(panelBridge, "markServerExited");
  scanSpy = vi.spyOn(ServerManager.prototype, "getServerProcessDetails");
  vi.spyOn(DiscordBot.prototype, "sendEventNotification").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  panelBridge.modStatus = null;
});

describe("status watchdog -- a stopped server's PanelBridge heartbeat is expired, not left to age out", () => {
  it("expires it on the first observation when that observation is already 'stopped' (panel restarted after a quiet stop), once", async () => {
    // Fresh module state: nothing observed yet.
    scanSpy.mockResolvedValue({ running: false, scanFailed: false });

    await checkServerStatusNow("boot");
    expect(markSpy).toHaveBeenCalledTimes(1);
    // First observation: nothing to correct on clients, so no push.
    expect(emitSpy).not.toHaveBeenCalledWith("server:status", expect.anything());

    // Still stopped on the next ticks: not re-expired every 10s (a live mod
    // the scan can't attribute would otherwise be knocked offline forever).
    await checkServerStatusNow("watchdog");
    await checkServerStatusNow("watchdog");
    expect(markSpy).toHaveBeenCalledTimes(1);
  });

  it("does not touch the heartbeat while the server is running", async () => {
    // Starts from: stopped (previous test).
    scanSpy.mockResolvedValue({ running: true, scanFailed: false });

    await checkServerStatusNow("start-detected");
    await checkServerStatusNow("watchdog");

    expect(markSpy).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith("server:status", expect.objectContaining({ running: true }));
  });

  it("on running -> stopped, sends PanelBridge's own offline event first, then the server:status push", async () => {
    // Starts from: running (previous test). The mod's last heartbeat is
    // still fresh enough to read as connected -- the reported state.
    panelBridge.modStatus = { alive: true, _wasAlive: true, version: "1.7.60", serverName: "MAZE", playerCount: 0, players: [] };
    expect(panelBridge.isModConnected()).toBe(true);
    scanSpy.mockResolvedValue({ running: false, scanFailed: false });

    await checkServerStatusNow("graceful-stop-confirmed");

    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(panelBridge.isModConnected()).toBe(false);
    const events = emitSpy.mock.calls.map(([event, payload]) => ({ event, payload }));
    const bridgeIndex = events.findIndex((e) => e.event === "panelBridge:modStatus");
    const statusIndex = events.findIndex((e) => e.event === "server:status");
    expect(events[bridgeIndex].payload).toMatchObject({ alive: false, serverName: "MAZE" });
    expect(events[statusIndex].payload).toEqual({ running: false, phase: "stopped" });
    expect(bridgeIndex).toBeGreaterThanOrEqual(0);
    expect(bridgeIndex).toBeLessThan(statusIndex);
    expect(markSpy.mock.invocationCallOrder[0]).toBeLessThan(
      emitSpy.mock.invocationCallOrder[statusIndex],
    );
  });

  it("leaves the heartbeat alone when the scan cannot tell (unknown is not stopped)", async () => {
    // Starts from: stopped. Re-seed running so an unknown tick follows a
    // known running state.
    scanSpy.mockResolvedValue({ running: true, scanFailed: false });
    await checkServerStatusNow("start-detected");
    markSpy.mockClear();

    scanSpy.mockResolvedValue({ running: false, scanFailed: true });
    await checkServerStatusNow("scan-hiccup");

    expect(markSpy).not.toHaveBeenCalled();
  });
});
