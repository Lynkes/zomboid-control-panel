import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09-01 Discord report (user Deide): panel and PZ in SEPARATE
// containers on the same host -> Discord always says Offline. Traced to
// discordBot.js reading serverManager.getServerProcessDetails().running
// ALONE for 6 separate "is the server up" call sites, with no RCON/bridge
// fallback -- the same OR-of-every-signal logic index.js's watchdog and
// routes/serverStatus.js's dashboard badge already use (isServerObservedRunning),
// but that logic used to live ONLY as a closure inside index.js
// (getObservedServerRunning), unreachable from discordBot.js without a
// circular import. resolveObservedServerRunning() is that logic pulled out
// to a leaf module both callers can import.
//
// THE TEST THAT MATTERS (a test only checking "the right process gets
// scanned" would pass on the old code too): the local scan succeeds and
// finds nothing (scanFailed: false, running: false) -- exactly what a
// split-container deployment's scan looks like, no error, just nothing to
// see from this container -- while RCON (or the bridge) is genuinely
// connected. The verdict must be "running", not the old code's "offline".

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({ getActiveServer }));

const fakeBridge = { isModConnected: vi.fn(() => false) };
vi.mock("../services/panelBridge.js", () => ({ default: fakeBridge }));

const resolveDockerHostSignal = vi.fn();
vi.mock("../services/managedContainer.js", () => ({ resolveDockerHostSignal }));

const { resolveObservedServerRunning } = await import("../utils/serverStatus.js");

function fakeServerManager(details) {
  return { getServerProcessDetails: vi.fn(async () => details) };
}

describe("resolveObservedServerRunning -- split-container / cross-container RCON", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    fakeBridge.isModConnected.mockReset().mockReturnValue(false);
    resolveDockerHostSignal.mockReset();
  });

  it("reports RUNNING when the local scan finds nothing but RCON is connected (remote provider) -- the exact split-container shape", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", isRemote: true });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });
    const rconService = { connected: true };

    expect(await resolveObservedServerRunning(serverManager, rconService)).toBe(true);
  });

  it("reports RUNNING off the bridge alone when RCON is also disconnected", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", isRemote: true });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });
    fakeBridge.isModConnected.mockReturnValue(true);

    expect(await resolveObservedServerRunning(serverManager, { connected: false })).toBe(true);
  });

  it("reports UNKNOWN (null), not a confident offline, when the scan itself failed and nothing else confirms it", async () => {
    getActiveServer.mockResolvedValue({ id: "s1" });
    const serverManager = fakeServerManager({ running: false, scanFailed: true });
    const rconService = { connected: false };

    expect(await resolveObservedServerRunning(serverManager, rconService)).toBeNull();
  });

  it("still reports OFFLINE (false) when every signal genuinely agrees the server is down", async () => {
    getActiveServer.mockResolvedValue({ id: "s1" });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });
    const rconService = { connected: false };

    expect(await resolveObservedServerRunning(serverManager, rconService)).toBe(false);
  });

  it("reports RUNNING for a docker-managed server whose local scan can't see it but the container is up", async () => {
    getActiveServer.mockResolvedValue({
      id: "s1",
      provider: "docker-managed",
      dockerContainerName: "pz",
    });
    resolveDockerHostSignal.mockResolvedValue({ running: true, scanFailed: false });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });

    expect(
      await resolveObservedServerRunning(serverManager, { connected: false }),
    ).toBe(true);
    // Docker branch never consults the local scan at all -- it can't see this topology.
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
  });

  // The watchdog's verdict and the composed-status badges share one
  // definition of "which host signal wins" (serverStatusModel.js's
  // isHostSignalAuthoritative): a completed native scan, or a managed
  // systemd/openrc unit's own confirmed state, beats a PanelBridge heartbeat
  // that outlived its process.
  it("reports OFFLINE for a native server whose completed scan finds no process, even while a stale PanelBridge heartbeat still reads connected", async () => {
    getActiveServer.mockResolvedValue({ id: "s1" });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });
    fakeBridge.isModConnected.mockReturnValue(true);

    expect(await resolveObservedServerRunning(serverManager, { connected: false })).toBe(false);
  });

  it("reports OFFLINE for a managed systemd/openrc unit whose own state reads stopped, even while a stale PanelBridge heartbeat still reads connected", async () => {
    fakeBridge.isModConnected.mockReturnValue(true);
    for (const lifecycleProvider of ["systemd", "openrc"]) {
      getActiveServer.mockResolvedValue({ id: "s1", lifecycleProvider });
      // getServerProcessDetails()'s managed branch stamps the provider.
      const serverManager = fakeServerManager({ running: false, scanFailed: false, provider: lifecycleProvider });

      expect(await resolveObservedServerRunning(serverManager, { connected: false })).toBe(false);
    }
  });

  it("still lets PanelBridge vouch for a systemd server when the plain process scan, not the unit, answered", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", lifecycleProvider: "systemd" });
    const serverManager = fakeServerManager({ running: false, scanFailed: false });
    fakeBridge.isModConnected.mockReturnValue(true);

    expect(await resolveObservedServerRunning(serverManager, { connected: false })).toBe(true);
  });

  it("does not call a managed unit stopped when its state could not be confirmed", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", lifecycleProvider: "systemd" });
    const serverManager = fakeServerManager({ running: false, scanFailed: true, provider: "systemd" });

    expect(await resolveObservedServerRunning(serverManager, { connected: false })).toBeNull();
    fakeBridge.isModConnected.mockReturnValue(true);
    expect(await resolveObservedServerRunning(serverManager, { connected: false })).toBe(true);
  });

  it("reports RUNNING for a remote-sftp server via RCON alone (no local process to scan)", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", isRemote: true });
    const serverManager = fakeServerManager({ running: true, scanFailed: false });

    expect(
      await resolveObservedServerRunning(serverManager, { connected: true }),
    ).toBe(true);
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
  });
});
