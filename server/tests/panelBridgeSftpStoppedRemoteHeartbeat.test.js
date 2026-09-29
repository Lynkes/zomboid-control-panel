import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A remote (SFTP) server that stopped, crashed or was stopped by its host
// leaves its last status.json on the remote disk, and the SFTP host itself
// usually stays reachable. The transport downloaded that file every sync
// (default 3s) and renamed it over the local copy, so the copy PanelBridge
// judges the heartbeat by got a fresh mtime every few seconds: the stopped
// server read as running (Stop button, PanelBridge Up, Discord online) for
// as long as the host answered, and the stop pin markServerExited() sets was
// released as a "new write" on the very next sync. Real transport and real
// PanelBridge here; only the SFTP client is faked.

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { PanelBridgeSftpTransport, validateSftpBridgeConfig } = await import(
  "../services/panelBridgeSftp.js"
);
const { PanelBridge } = await import("../services/panelBridge.js");

const config = {
  host: "pz.example.net",
  port: 22,
  username: "panelbridge",
  password: "not-a-real-secret",
  bridgePath: "/home/pz/Zomboid/Lua/panelbridge/Remote",
  pollIntervalSeconds: 3,
};

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function statusJson(timestamp, playerCount = 0) {
  return JSON.stringify({
    alive: true,
    version: "1.7.80",
    timestamp,
    serverName: "Remote",
    playerCount,
    players: [],
  });
}

// The remote host: `remote.content` is whatever status.json.txt currently
// holds there. fastGet writes it to the local temporary path, as ssh2 does
// (a fresh file, fresh mtime, the remote mtime not carried over).
function makeSyncedBridge() {
  const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), "pz-sftp-remote-heartbeat-"));
  temporaryDirectories.push(cachePath);
  const remote = { content: statusJson(1_000) };
  const transport = new PanelBridgeSftpTransport();
  transport.config = validateSftpBridgeConfig(config);
  transport.cachePath = cachePath;
  transport.client = {
    exists: vi.fn(async () => "-"),
    stat: vi.fn(async () => ({ size: Buffer.byteLength(remote.content) })),
    fastGet: vi.fn(async (_remotePath, localPath) => {
      fs.writeFileSync(localPath, remote.content);
    }),
  };
  const bridge = new PanelBridge();
  bridge.configure(cachePath, true);
  const statusFile = path.join(cachePath, "status.json.txt");
  const sync = async () => {
    await transport.syncModFile("status.json");
    bridge.checkModStatus();
  };
  // The last write is `ageMs` old: the panel first saw it that long ago.
  const age = (ageMs) => {
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(statusFile, then, then);
  };
  return { bridge, remote, statusFile, sync, age };
}

describe("PanelBridge over SFTP: a status.json the remote game stopped writing ages out", () => {
  it("re-syncing the same remote status.json keeps the local copy's mtime, so the heartbeat goes stale", async () => {
    const { bridge, statusFile, sync, age } = makeSyncedBridge();
    await sync();
    expect(bridge.isModConnected()).toBe(true);

    // The remote game has been gone for ten minutes: past even the idle tolerance.
    age(10 * 60_000);
    const agedMtime = fs.statSync(statusFile).mtimeMs;

    await sync();
    await sync();

    expect(fs.statSync(statusFile).mtimeMs).toBe(agedMtime);
    expect(bridge.isModConnected()).toBe(false);
  });

  it("a new remote write still replaces the local copy and reads as a live mod", async () => {
    const { bridge, remote, statusFile, sync, age } = makeSyncedBridge();
    await sync();
    age(10 * 60_000);
    await sync();
    expect(bridge.isModConnected()).toBe(false);

    remote.content = statusJson(2_000, 1);
    await sync();

    expect(fs.readFileSync(statusFile, "utf8")).toBe(remote.content);
    expect(bridge.isModConnected()).toBe(true);
    expect(bridge.modStatus.playerCount).toBe(1);
  });

  it("the stop pin holds across syncs of the unchanged file and is released only by the next real write", async () => {
    const { bridge, remote, sync } = makeSyncedBridge();
    await sync();
    expect(bridge.isModConnected()).toBe(true);

    bridge.markServerExited();
    await sync();
    await sync();
    expect(bridge.isModConnected()).toBe(false);

    remote.content = statusJson(5_000);
    await sync();
    expect(bridge.isModConnected()).toBe(true);
  });

  it("leaves no temporary download behind when the content was unchanged", async () => {
    const { statusFile, sync } = makeSyncedBridge();
    await sync();
    await sync();

    const leftovers = fs
      .readdirSync(path.dirname(statusFile))
      .filter((name) => name.endsWith(".download"));
    expect(leftovers).toEqual([]);
  });
});
