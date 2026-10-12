import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logServerEvent: vi.fn(async () => ({})) };
});

const { checkServerStatusNow, resetStatusWatchdogBaseline, io } = await import("../index.js");
const { ServerManager } = await import("../services/serverManager.js");
const { DiscordBot } = await import("../services/discordBot.js");

// Switching the active server repoints serverManager/rconService/panelBridge
// at a different server, but the status watchdog's lastKnownRunning/
// lastKnownPhase baselines stayed those of the PREVIOUS server, so the first
// tick afterwards compared server B to server A and posted a false
// "Server Stopped"/"Server Started" to Discord.
describe("status watchdog baseline is reset when the active server changes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays silent on Discord for the first observation after a reset, but still tells clients", async () => {
    const emitSpy = vi.spyOn(io, "emit").mockImplementation(() => {});
    const discordSpy = vi
      .spyOn(DiscordBot.prototype, "sendEventNotification")
      .mockResolvedValue(undefined);
    const scanSpy = vi.spyOn(ServerManager.prototype, "getServerProcessDetails");

    // Server A is running and the watchdog has seen it.
    scanSpy.mockResolvedValue({ running: true, scanFailed: false });
    await checkServerStatusNow("seed");

    // The operator activates server B, which is stopped.
    resetStatusWatchdogBaseline();
    emitSpy.mockClear();
    discordSpy.mockClear();
    scanSpy.mockResolvedValue({ running: false, scanFailed: false });
    await checkServerStatusNow("after-switch");

    expect(discordSpy).not.toHaveBeenCalled();
    // Clients (the sidebar dot has no REST poll) still get one correction.
    expect(emitSpy).toHaveBeenCalledWith("server:status", { running: false, phase: "stopped" });

    // From here on the baseline is server B's: a real transition notifies.
    emitSpy.mockClear();
    scanSpy.mockResolvedValue({ running: true, scanFailed: false });
    await checkServerStatusNow("b-started");
    expect(discordSpy).toHaveBeenCalledWith("serverStart", {});
  });

  it("does not post a false Server Started when the new server is running and the old one was stopped", async () => {
    vi.spyOn(io, "emit").mockImplementation(() => {});
    const discordSpy = vi
      .spyOn(DiscordBot.prototype, "sendEventNotification")
      .mockResolvedValue(undefined);
    const scanSpy = vi.spyOn(ServerManager.prototype, "getServerProcessDetails");

    scanSpy.mockResolvedValue({ running: false, scanFailed: false });
    await checkServerStatusNow("seed-stopped");

    resetStatusWatchdogBaseline();
    discordSpy.mockClear();
    scanSpy.mockResolvedValue({ running: true, scanFailed: false });
    await checkServerStatusNow("after-switch");

    expect(discordSpy).not.toHaveBeenCalled();
  });
});
