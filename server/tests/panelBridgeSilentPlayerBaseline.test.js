import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Bridge player events used to post a Discord join/leave for EVERY online
// player on a panel restart, a bridge restart or a server switch:
// previousPlayers starts empty, so the first alive status read "joined"
// everyone, and stop() ran trackPlayerActivity([]), which "disconnected"
// everyone. The first alive read after start is now a silent baseline and
// stop() closes sessions silently. The sessions themselves are still
// recorded (playtime), only the announcements go away.

const logPlayerAction = vi.fn(async () => {});
const recordPlayerSession = vi.fn(async () => {});
vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    logPlayerAction: (...args) => logPlayerAction(...args),
    recordPlayerSession: (...args) => recordPlayerSession(...args),
  };
});

const { PanelBridge } = await import("../services/panelBridge.js");
const { default: singletonBridge } = await import("../services/panelBridge.js");
await import("../index.js");
const { DiscordBot } = await import("../services/discordBot.js");

let tmpDir = null;

function writeStatus(players) {
  fs.writeFileSync(
    path.join(tmpDir, "status.json"),
    JSON.stringify({
      alive: true,
      version: "1.7.75",
      playerCount: players.length,
      players,
    }),
  );
}

function newBridge() {
  const bridge = new PanelBridge();
  bridge.configure(tmpDir, true);
  const connects = [];
  const disconnects = [];
  bridge.on("playerConnect", (name, info) => connects.push([name, info?.silent]));
  bridge.on("playerDisconnect", (name, info) => disconnects.push([name, info?.silent]));
  return { bridge, connects, disconnects };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-silent-baseline-"));
  logPlayerAction.mockClear();
  recordPlayerSession.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("PanelBridge: the first status read after start is a silent baseline", () => {
  it("marks everyone already online as a silent connect, but still records their sessions", () => {
    const { bridge, connects } = newBridge();
    writeStatus(["Alice", "Bob"]);

    bridge.checkModStatus();

    expect(connects).toEqual([
      ["Alice", true],
      ["Bob", true],
    ]);
    expect(recordPlayerSession).toHaveBeenCalledWith("Alice", "connect");
    expect(recordPlayerSession).toHaveBeenCalledWith("Bob", "connect");
  });

  it("announces real joins and leaves after the baseline", () => {
    const { bridge, connects, disconnects } = newBridge();
    writeStatus(["Alice", "Bob"]);
    bridge.checkModStatus();
    connects.length = 0;

    // Bump the mtime so the status file is re-read.
    writeStatus(["Alice", "Carol"]);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(tmpDir, "status.json"), later, later);
    bridge.checkModStatus();

    expect(connects).toEqual([["Carol", false]]);
    expect(disconnects).toEqual([["Bob", false]]);
  });

  it("stop() closes sessions silently, and the next start is a baseline again", () => {
    const { bridge, connects, disconnects } = newBridge();
    writeStatus(["Alice", "Bob"]);
    bridge.checkModStatus();

    bridge.stop();

    expect(disconnects).toEqual([
      ["Alice", true],
      ["Bob", true],
    ]);
    expect(recordPlayerSession).toHaveBeenCalledWith("Alice", "disconnect");

    connects.length = 0;
    bridge.lastStatusFileCheck = 0;
    bridge.checkModStatus();
    expect(connects).toEqual([
      ["Alice", true],
      ["Bob", true],
    ]);
  });

  it("still announces everyone leaving when the mod goes offline (a real disconnect)", () => {
    const { bridge, disconnects } = newBridge();
    writeStatus(["Alice"]);
    bridge.checkModStatus();
    bridge.consecutiveFailures = bridge.maxConsecutiveFailures - 1;

    bridge.handleStatusFailure("Status file does not exist");

    expect(disconnects).toEqual([["Alice", false]]);
  });
});

describe("Discord join/leave notices ignore silent bridge events", () => {
  it("posts nothing for silent events and posts for real ones", () => {
    const notify = vi
      .spyOn(DiscordBot.prototype, "sendEventNotification")
      .mockResolvedValue(undefined);

    singletonBridge.emit("playerConnect", "Alice", { silent: true });
    singletonBridge.emit("playerDisconnect", "Alice", { silent: true });
    expect(notify).not.toHaveBeenCalled();

    singletonBridge.emit("playerConnect", "Bob", { silent: false });
    singletonBridge.emit("playerDisconnect", "Bob", { silent: false });
    expect(notify).toHaveBeenCalledWith("playerJoin", { player: "Bob" });
    expect(notify).toHaveBeenCalledWith("playerLeave", { player: "Bob" });
  });
});
