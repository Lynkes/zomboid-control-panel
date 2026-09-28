import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 2026-09 Discord report (Windows native, server "MAZE"): after a panel Stop
// that really did stop the server, the Servers card kept showing
// "PanelBridge Up" -- and therefore a Stop button -- for minutes. The mod's
// only heartbeat is status.json, judged purely by the file's age, with a
// 5-minute tolerance (statusStaleIdleMs) whenever the last write said 0
// players. The last write an exited server made therefore kept reading as a
// live mod for up to five minutes after the process was gone.
// markServerExited() (called by the status watchdog when it sees the server
// stop) pins that exact write as dead until the file changes again.

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { PanelBridge } = await import("../services/panelBridge.js");

let tmpDir = null;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

// A status.json last written `ageMs` ago. 60s is past the 45s window but
// well inside the 5-minute idle window, so with playerCount 0 only the idle
// tolerance is keeping it "alive" -- the exact shape of the report.
function writeStatus(dir, { ageMs, playerCount = 0 } = {}) {
  const file = path.join(dir, "status.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ alive: true, version: "1.7.60", serverName: "MAZE", playerCount, players: [] }),
  );
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(file, mtime, mtime);
}

function makeBridgeWithLiveIdleHeartbeat() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-exit-"));
  const bridge = new PanelBridge();
  bridge.configure(tmpDir, true);
  writeStatus(tmpDir, { ageMs: 60_000 });
  bridge.checkModStatus();
  return bridge;
}

describe("PanelBridge.markServerExited -- a heartbeat cannot outlive its server", () => {
  it("marks the mod offline at once, with one modStatus event, instead of after the idle tolerance", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    // Precondition, i.e. the bug: a 60s-old heartbeat still reads as live.
    expect(bridge.isModConnected()).toBe(true);
    const events = [];
    bridge.on("modStatus", (status) => events.push({ ...status }));

    bridge.markServerExited();

    expect(bridge.isModConnected()).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ alive: false, serverName: "MAZE" });
  });

  it("does not read the same dead write back in on the next status checks, cheap path or full re-read", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    bridge.markServerExited();
    const events = [];
    bridge.on("modStatus", (status) => events.push(status));

    bridge.checkModStatus(); // unchanged mtime: the age-only path
    expect(bridge.isModConnected()).toBe(false);

    bridge.lastStatusFileCheck = 0; // force the full re-read path too
    bridge.checkModStatus();
    expect(bridge.isModConnected()).toBe(false);
    expect(events).toHaveLength(0);
  });

  // Settings > Bridge and the Debug page read getConnectionDiagnostics(),
  // not modStatus: judged by age alone, the dead write still reported a
  // healthy connection that can send commands -- beside a mod status that
  // said offline and a sendCommand() that refuses with "Mod is not
  // responding".
  it("stops reporting the connection healthy in the bridge diagnostics", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    expect(bridge.getConnectionDiagnostics()).toMatchObject({
      healthy: true,
      canSendCommands: true,
      checks: { statusFresh: true },
    });

    bridge.markServerExited();

    const diagnostics = bridge.getConnectionDiagnostics();
    expect(diagnostics.healthy).toBe(false);
    expect(diagnostics.canSendCommands).toBe(false);
    expect(diagnostics.checks.statusFresh).toBe(false);
    // Says what happened, not "Status file is stale (2s old)" -- an age too
    // young for the word, and a question the panel already has the answer to.
    expect(diagnostics.summary).toEqual({
      key: "serverExited",
      text: "The game server has stopped. PanelBridge reconnects when the server starts again.",
    });
    expect(diagnostics.issues.map((issue) => issue.key)).not.toContain("statusFileStale");

    // And healthy again once a started server writes.
    writeStatus(tmpDir, { ageMs: 0 });
    expect(bridge.getConnectionDiagnostics()).toMatchObject({
      healthy: true,
      canSendCommands: true,
      checks: { statusFresh: true },
    });
  });

  it("comes back as soon as a started server writes a new heartbeat", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    bridge.markServerExited();

    writeStatus(tmpDir, { ageMs: 0 });
    bridge.checkModStatus();

    expect(bridge.isModConnected()).toBe(true);
    expect(bridge.exitedServerStatusMtimeMs).toBeNull();
  });

  it("survives a bridge stop/start on the same folder without resurrecting the dead heartbeat", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    bridge.markServerExited();

    bridge.stop();
    bridge.checkModStatus();

    expect(bridge.isModConnected()).toBe(false);
  });

  // A bridge action in the seconds after a stop is refused by the diagnostics
  // gate at once now -- its message has to be readable, not the
  // "[object Object]" the {key, params, text} summary interpolated to.
  it("refuses bridge commands after the stop with the diagnostic's own sentence", async () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    bridge.isRunning = true; // as after start(), without its timers
    bridge.markServerExited();

    await expect(bridge.sendCommand("getWeather")).rejects.toThrow(
      "Bridge file connection is unhealthy: The game server has stopped. PanelBridge reconnects when the server starts again.",
    );
  });

  it("is a quiet no-op when the mod was not connected anyway", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-exit-"));
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    writeStatus(tmpDir, { ageMs: 10 * 60_000 }); // past even the idle window
    bridge.checkModStatus();
    expect(bridge.isModConnected()).toBe(false);
    const events = [];
    bridge.on("modStatus", (status) => events.push(status));

    bridge.markServerExited();

    expect(events).toHaveLength(0);
    expect(bridge.isModConnected()).toBe(false);
  });
});

// Review round 4: the pin above had no way back to "running" except the
// mod's next write, and the mod's first write only comes from
// onServerStarted, after the world has loaded -- minutes on Build 42, and
// never when the mod broke on an update or left the mod list. So after any
// stop the panel saw, Settings > Bridge and the Events page said "The game
// server has stopped" through the whole world load, and forever beside a
// server that came back without a working PanelBridge -- while the Dashboard
// said Starting/Online. markServerRunning() (the watchdog's running verdict,
// a restart's verified start) ends that claim; the dead write stays dead.
describe("PanelBridge.markServerRunning -- a running server is not described as stopped", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says how long the running server's mod has been silent instead of 'stopped', for as long as it stays silent", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    bridge.markServerExited();
    expect(bridge.getConnectionDiagnostics().summary.key).toBe("serverExited");

    vi.useFakeTimers({ toFake: ["Date"] });
    bridge.markServerRunning();
    // The server runs on; the mod never writes (a broken PanelBridge).
    vi.setSystemTime(Date.now() + 20 * 60_000);

    const diagnostics = bridge.getConnectionDiagnostics();
    expect(diagnostics.summary).toEqual({
      key: "bridgeSilentSinceStart",
      params: { age: "20m" },
      text: "The game server started 20m ago, but PanelBridge has not reported yet. It reports once the world has loaded; if it stays silent, check that PanelBridge is in the server's active mod list.",
    });
    expect(diagnostics.issues.map((issue) => issue.key)).not.toContain("serverExited");
    // Still not a live connection: nothing the mod wrote is newer than the exit.
    expect(diagnostics.canSendCommands).toBe(false);
    expect(diagnostics.checks.statusFresh).toBe(false);
  });

  it("keeps the exited write dead: neither status-check path reads it back in as a live mod", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    bridge.markServerExited();
    bridge.markServerRunning();
    const events = [];
    bridge.on("modStatus", (status) => events.push(status));

    bridge.checkModStatus(); // unchanged mtime: the age-only path
    bridge.lastStatusFileCheck = 0; // and the full re-read path
    bridge.checkModStatus();

    expect(bridge.isModConnected()).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("keeps the first sighting's time across repeated running ticks", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    bridge.markServerExited();
    vi.useFakeTimers({ toFake: ["Date"] });
    bridge.markServerRunning();
    vi.setSystemTime(Date.now() + 3 * 60_000);
    bridge.markServerRunning(); // the watchdog's next running tick

    expect(bridge.getConnectionDiagnostics().summary.params).toEqual({ age: "3m" });
  });

  it("goes back to 'stopped' when the server stops again before its mod ever wrote", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    bridge.markServerExited();
    bridge.markServerRunning();

    bridge.markServerExited();

    expect(bridge.getConnectionDiagnostics().summary.key).toBe("serverExited");
  });

  it("is healthy again once the started server writes, and the next stop starts over", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();
    bridge.markServerExited();
    bridge.markServerRunning();

    writeStatus(tmpDir, { ageMs: 0 });
    bridge.checkModStatus();
    expect(bridge.isModConnected()).toBe(true);
    expect(bridge.getConnectionDiagnostics().summary.key).toBe("healthy");
    expect(bridge.serverRunningAgainSinceMs).toBeNull();

    bridge.markServerExited();
    expect(bridge.getConnectionDiagnostics().summary.key).toBe("serverExited");
  });

  it("does nothing when no exited write is pinned", () => {
    const bridge = makeBridgeWithLiveIdleHeartbeat();

    bridge.markServerRunning();

    expect(bridge.serverRunningAgainSinceMs).toBeNull();
    expect(bridge.isModConnected()).toBe(true);
    expect(bridge.getConnectionDiagnostics().summary.key).toBe("healthy");
  });
});
