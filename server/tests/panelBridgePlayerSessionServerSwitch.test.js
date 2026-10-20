import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Switching servers activates the new server (setActiveServer) BEFORE the
// active-server reload stops the bridge, and PanelBridge.stop() closes every
// tracked player's session. Those calls used to look the server up at write
// time, so the old server's players were "disconnected" on the NEW server:
// their real session on the old server never closed (playtime lost), and the
// new server got rows (and offline-roster entries) for players who never
// joined it. The bridge now pins the server when it starts.
//
// Real database module (per-file temp data root, see
// vitest.perFileDataDir.setup.mjs) and the real PanelBridge.

const { getDb, setActiveServer, getPlayerLogs } = await import("../database/init.js");
const { PanelBridge } = await import("../services/panelBridge.js");

const SERVER_A = "switch-test-a";
const SERVER_B = "switch-test-b";

let bridgeDir;
let bridge;

beforeAll(async () => {
  const db = await getDb();
  db.data.servers.push(
    { id: SERVER_A, name: "Server A", serverName: "servertesta", isActive: true },
    { id: SERVER_B, name: "Server B", serverName: "servertestb", isActive: false },
  );
  bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-bridge-switch-"));
});

afterEach(async () => {
  if (bridge?.isRunning) bridge.stop();
  bridge = null;
  await setActiveServer(SERVER_A);
  const db = await getDb();
  db.data.player_stats = [];
  db.data.player_logs = [];
});

async function startBridgeOnActiveServer() {
  bridge = new PanelBridge();
  bridge.configure(bridgeDir, true);
  bridge.start();
  await settle();
}

async function statsFor(name) {
  const db = await getDb();
  return db.data.player_stats.filter((s) => s.player_name === name);
}

async function settle() {
  // The session writes are fire-and-forget promises.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("PanelBridge: player sessions stay on the server they belong to across a server switch", () => {
  it("closes the old server's open session when the bridge stops after the switch", async () => {
    await startBridgeOnActiveServer();
    bridge.trackPlayerActivity(["Bob"]);
    await settle();
    const [opened] = await statsFor("Bob");
    expect(opened.server_id).toBe(SERVER_A);
    expect(opened.last_session_start).not.toBeNull();

    // The switch: activate B first, then the reload stops the bridge.
    await setActiveServer(SERVER_B);
    bridge.stop();
    await settle();

    const rows = await statsFor("Bob");
    expect(rows).toHaveLength(1);
    expect(rows[0].server_id).toBe(SERVER_A);
    expect(rows[0].last_session_start).toBeNull();
    expect(rows[0].sessions).toHaveLength(1);

    const logs = await getPlayerLogs("Bob");
    expect(logs.map((l) => [l.action, l.server_id])).toEqual([
      ["disconnect", SERVER_A],
      ["connect", SERVER_A],
    ]);
  });

  it("records a join seen in the old server's folder during the switch on the old server", async () => {
    await startBridgeOnActiveServer();
    await setActiveServer(SERVER_B);

    // A status read between the activation and the bridge restart still
    // reads the old server's bridge folder.
    bridge.trackPlayerActivity(["Carol"]);
    await settle();
    bridge.stop();
    await settle();

    const rows = await statsFor("Carol");
    expect(rows.map((r) => r.server_id)).toEqual([SERVER_A]);
    expect(rows[0].last_session_start).toBeNull();
  });

  it("a bridge started after the switch tracks the new server", async () => {
    await setActiveServer(SERVER_B);
    bridge = new PanelBridge();
    bridge.configure(bridgeDir, true);
    bridge.start();
    await settle();

    bridge.trackPlayerActivity(["Dave"]);
    await settle();
    bridge.stop();
    await settle();

    const rows = await statsFor("Dave");
    expect(rows.map((r) => r.server_id)).toEqual([SERVER_B]);
    expect(rows[0].sessions).toHaveLength(1);
  });
});
