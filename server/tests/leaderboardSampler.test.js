import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PanelBridge up to 1.7.73 reads kills and days only when the panel asks for
// the leaderboard, so a player who played while nobody had the Leaderboard
// page open kept 0 kills (Discord report, ejspinn). The sampler asks every
// 2 minutes while players are online, until the bridge says it sweeps by
// itself (diagnostics.lastSweepAt).

const logged = { warn: [], debug: [], info: [] };
vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    warn: (message) => logged.warn.push(message),
    debug: (message) => logged.debug.push(message),
    info: (message) => logged.info.push(message),
    error: () => {},
  }),
}));

const {
  LEADERBOARD_SAMPLER_INTERVAL_MS,
  getLeaderboardSamplerStatus,
  startLeaderboardSampler,
  stopLeaderboardSampler,
} = await import("../services/leaderboardSampler.js");
const { LEADERBOARD_WARN_INTERVAL_MS, resetLeaderboardWarnThrottle } = await import(
  "../services/leaderboardDiagnostics.js"
);

const OLD_BRIDGE_ANSWER = { success: true, data: { players: [], generatedAt: 1 } };
const SWEEPING_ANSWER = {
  success: true,
  data: { players: [], generatedAt: 1, diagnostics: { bridgeVersion: "1.7.74", lastSweepAt: 1 } },
};

function makeBridge() {
  const bridge = {
    isRunning: true,
    modStatus: { alive: true, version: "1.7.73", players: ["Alice"] },
    isModConnected: () => bridge.modStatus?.alive === true,
    getLeaderboard: vi.fn(async () => OLD_BRIDGE_ANSWER),
  };
  return bridge;
}

let bridge;

beforeEach(() => {
  vi.useFakeTimers();
  logged.warn.length = 0;
  logged.debug.length = 0;
  logged.info.length = 0;
  resetLeaderboardWarnThrottle();
  bridge = makeBridge();
  startLeaderboardSampler(bridge);
});

afterEach(() => {
  stopLeaderboardSampler();
  vi.useRealTimers();
});

describe("leaderboardSampler", () => {
  it("asks every 2 minutes while players are online, naming itself as the source", async () => {
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS - 1);
    expect(bridge.getLeaderboard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.getLeaderboard).toHaveBeenCalledTimes(1);
    expect(bridge.getLeaderboard).toHaveBeenCalledWith({ source: "sampler" });
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS * 2);
    expect(bridge.getLeaderboard).toHaveBeenCalledTimes(3);
  });

  it("does not ask with nobody online, or while the bridge is down", async () => {
    bridge.modStatus.players = [];
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS);
    bridge.modStatus = { alive: false, version: "1.7.73", players: ["Alice"] };
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS);
    bridge.modStatus = { alive: true, version: "1.7.73", players: ["Alice"] };
    bridge.isRunning = false;
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS);
    expect(bridge.getLeaderboard).not.toHaveBeenCalled();
  });

  it("stops asking once the bridge says it sweeps by itself, and picks up for another version", async () => {
    bridge.modStatus.version = "1.7.74";
    bridge.getLeaderboard.mockResolvedValue(SWEEPING_ANSWER);
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS);
    expect(bridge.getLeaderboard).toHaveBeenCalledTimes(1);
    expect(getLeaderboardSamplerStatus()).toEqual(expect.objectContaining({
      running: true, bridgeSweeps: true, bridgeSweepsVersion: "1.7.74",
    }));

    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS * 5);
    expect(bridge.getLeaderboard).toHaveBeenCalledTimes(1);

    // A server switch to an older bridge.
    bridge.modStatus.version = "1.7.73";
    bridge.getLeaderboard.mockResolvedValue(OLD_BRIDGE_ANSWER);
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS);
    expect(bridge.getLeaderboard).toHaveBeenCalledTimes(2);
    expect(getLeaderboardSamplerStatus().bridgeSweeps).toBe(false);
  });

  it("never throws, keeps one read in flight, and warns about failures at most every 10 minutes", async () => {
    bridge.getLeaderboard.mockRejectedValue(new Error("Mod is not responding"));
    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS);
    expect(bridge.getLeaderboard).toHaveBeenCalledTimes(4);
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toMatch(/Leaderboard read for the leaderboard sampler failed: Mod is not responding/);
    expect(logged.debug).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(LEADERBOARD_WARN_INTERVAL_MS);
    expect(logged.warn).toHaveLength(2);

    let release;
    bridge.getLeaderboard.mockReset();
    bridge.getLeaderboard.mockImplementation(() => new Promise((resolve) => (release = () => resolve(OLD_BRIDGE_ANSWER))));
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS * 3);
    expect(bridge.getLeaderboard).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS);
    expect(bridge.getLeaderboard).toHaveBeenCalledTimes(2);
  });

  it("stops when stopped", async () => {
    stopLeaderboardSampler();
    await vi.advanceTimersByTimeAsync(LEADERBOARD_SAMPLER_INTERVAL_MS * 3);
    expect(bridge.getLeaderboard).not.toHaveBeenCalled();
    expect(getLeaderboardSamplerStatus()).toEqual({ running: false });
  });
});
