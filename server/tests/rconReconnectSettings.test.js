import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings > Connection has an "Auto-reconnect" switch and a "Reconnect
// interval" field. They were saved (PUT /app-settings) and shown back, but
// nothing read them: the RCON loop ran every 60 s whatever was chosen. These
// tests pin that RconService now follows them, including a change made while
// the loop is already running (no restart).

const getActiveServer = vi.fn();
const getServer = vi.fn();
const getSetting = vi.fn();
const logCommand = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServer,
  getSetting,
  logCommand,
}));

const { RconService, normalizeReconnectIntervalSeconds } = await import(
  "../services/rcon.js"
);

function startedService() {
  const service = new RconService();
  service.connect = vi.fn().mockResolvedValue(false);
  service.serverManager = null;
  return service;
}

beforeEach(() => {
  vi.useFakeTimers();
  getActiveServer.mockReset().mockResolvedValue(null);
  getServer.mockReset().mockResolvedValue(null);
  getSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeReconnectIntervalSeconds", () => {
  it("keeps the old 60 s when nothing usable is stored", () => {
    expect(normalizeReconnectIntervalSeconds(undefined)).toBe(60);
    expect(normalizeReconnectIntervalSeconds(null)).toBe(60);
    expect(normalizeReconnectIntervalSeconds("")).toBe(60);
    expect(normalizeReconnectIntervalSeconds("soon")).toBe(60);
  });

  it("clamps to 5-600 seconds and accepts numeric strings", () => {
    expect(normalizeReconnectIntervalSeconds(1)).toBe(5);
    expect(normalizeReconnectIntervalSeconds(0)).toBe(5);
    expect(normalizeReconnectIntervalSeconds(-20)).toBe(5);
    expect(normalizeReconnectIntervalSeconds(9999)).toBe(600);
    expect(normalizeReconnectIntervalSeconds("30")).toBe(30);
    expect(normalizeReconnectIntervalSeconds(12.4)).toBe(12);
  });
});

describe("RconService auto-reconnect settings", () => {
  it("without any saved setting still retries every 60 s", async () => {
    const service = startedService();
    service.startAutoReconnect();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(service.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.connect).toHaveBeenCalledTimes(1);

    service.stopAutoReconnect();
  });

  it("autoReconnect false means the background loop never connects", async () => {
    const service = startedService();
    service.applyReconnectSettings({ autoReconnect: false, reconnectInterval: 10 });
    service.startAutoReconnect();

    expect(service.autoReconnectInterval).toBeNull();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(service.connect).not.toHaveBeenCalled();
    // The stale-connection watchdog never reconnects, so it stays on.
    expect(service.healthCheckInterval).not.toBeNull();

    service.stopAutoReconnect();
  });

  it("uses the saved interval", async () => {
    const service = startedService();
    service.applyReconnectSettings({ autoReconnect: true, reconnectInterval: "15" });
    service.startAutoReconnect();

    await vi.advanceTimersByTimeAsync(14_000);
    expect(service.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.connect).toHaveBeenCalledTimes(2);

    service.stopAutoReconnect();
  });

  it("clamps an interval that is too short or too long", async () => {
    const tooShort = startedService();
    tooShort.applyReconnectSettings({ autoReconnect: true, reconnectInterval: 1 });
    expect(tooShort.autoReconnectDelay).toBe(5_000);

    const tooLong = startedService();
    tooLong.applyReconnectSettings({ autoReconnect: true, reconnectInterval: 100000 });
    expect(tooLong.autoReconnectDelay).toBe(600_000);
  });

  it("applies a change while the loop is running, without a restart", async () => {
    const service = startedService();
    service.startAutoReconnect();

    expect(service.applyReconnectSettings({ autoReconnect: true, reconnectInterval: 10 })).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.connect).toHaveBeenCalledTimes(1);

    // Turning it off stops further attempts...
    expect(service.applyReconnectSettings({ autoReconnect: false, reconnectInterval: 10 })).toBe(true);
    expect(service.autoReconnectInterval).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.connect).toHaveBeenCalledTimes(1);

    // ...and turning it back on resumes them.
    service.applyReconnectSettings({ autoReconnect: true, reconnectInterval: 20 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.connect).toHaveBeenCalledTimes(2);

    // Re-applying the same values is a no-op (the timer is not reset).
    expect(service.applyReconnectSettings({ autoReconnect: true, reconnectInterval: 20 })).toBe(false);

    service.stopAutoReconnect();
  });

  it("a service that never started its loop does not start one when settings are applied", async () => {
    const service = startedService();
    service.applyReconnectSettings({ autoReconnect: true, reconnectInterval: 10 });

    expect(service.autoReconnectInterval).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.connect).not.toHaveBeenCalled();
  });

  it("stopAutoReconnect keeps the loop stopped even if settings change afterwards", async () => {
    const service = startedService();
    service.startAutoReconnect();
    service.stopAutoReconnect();

    service.applyReconnectSettings({ autoReconnect: true, reconnectInterval: 10 });
    expect(service.autoReconnectInterval).toBeNull();
  });

  it("loadReconnectSettings reads the two saved settings", async () => {
    getSetting.mockImplementation(async (key) =>
      ({ autoReconnect: false, reconnectInterval: "45" })[key] ?? null,
    );
    const service = startedService();

    await service.loadReconnectSettings();

    expect(service.autoReconnectEnabled).toBe(false);
    expect(service.autoReconnectDelay).toBe(45_000);
  });

  it("loadReconnectSettings leaves a never-saved install on, every 60 s", async () => {
    const service = startedService();
    await service.loadReconnectSettings();

    expect(service.autoReconnectEnabled).toBe(true);
    expect(service.autoReconnectDelay).toBe(60_000);
  });

  it("a short interval does not repeat the host-wide process scan or overlap slow ticks", async () => {
    const service = startedService();
    let finishScan;
    const checkServerRunning = vi.fn(
      () => new Promise((resolve) => { finishScan = () => resolve(false); }),
    );
    service.serverManager = { checkServerRunning };
    service.applyReconnectSettings({ autoReconnect: true, reconnectInterval: 5 });
    service.startAutoReconnect();

    // First tick starts the scan and is still waiting on it...
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checkServerRunning).toHaveBeenCalledTimes(1);
    // ...so the next ticks do not start a second one.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkServerRunning).toHaveBeenCalledTimes(1);

    finishScan();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.connect).toHaveBeenCalledTimes(1);

    // Within the scan throttle window later ticks still connect, without rescanning.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(service.connect).toHaveBeenCalledTimes(2);
    expect(checkServerRunning).toHaveBeenCalledTimes(1);

    service.stopAutoReconnect();
  });
});
