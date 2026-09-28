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
