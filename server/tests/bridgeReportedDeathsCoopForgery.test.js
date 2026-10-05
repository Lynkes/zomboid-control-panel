import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPanelBridge } from "./helpers/panelBridgeLua.js";

// BRIDGE-1 adversary pass (security sweep 2026-10-04). The logs batch
// anchored the *_user.txt death parser to the game's timestamp, assuming a
// name can't contain '.'. That holds for account names only: a co-op
// (split-screen) player's name arrives in ConnectCoopPacket, where the server
// only checks it is non-empty and not already connected -- no
// isValidUserName -- and AllowCoop is on by default. IsoGameCharacter.DoDeath
// then writes "user " + that name + " died at ..." through ZLogger, so a co-op
// name carries complete, timestamped death lines for anyone. GAME_WRITTEN
// below is what the real 42.x ZLogger wrote for such a name (the adversary's
// CoopDeathLineWriter run on the game's own JRE): Bob's real death, then the
// attacker's, which reads as Sacha dying at (100,200,0).
//
// No parsing of that file can tell the lines apart, so deaths now come from
// PanelBridge: the mod reports each dead player from OnCharacterDeath in
// status.json, and while a live bridge does that, the panel ignores the log's
// deaths (services/playerDeathEvents.js). The log stays the fallback when no
// bridge reports deaths.

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { PanelBridge } = await import("../services/panelBridge.js");
const { LogTailer } = await import("../services/logTailer.js");
const { createPlayerDeathRouter } = await import("../services/playerDeathEvents.js");

const LUA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "pz-mod",
  "PanelBridge",
  "media",
  "lua",
  "server",
  "PanelBridge.lua",
);

const GAME_WRITTEN =
  "[04-10-26 22:54:13.571] user Bob died at (10801,9370,0) (non pvp).\r\n" +
  "[04-10-26 22:54:13.572] user q\n[04-10-26 12:00:00.000] user Sacha died at (100,200,0) (non pvp).\nx died at (10800,9365,0) (non pvp).\r\n";
const COOP_NAME = "q\n[04-10-26 12:00:00.000] user Sacha died at (100,200,0) (non pvp).\nx";

let tmpDir = null;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function luaString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

const LUA_STUBS = `
Now = 1759000000000
getTimestampMs = function() return Now end
getServerName = function() return "TestServer" end
FILES = {}
getFileReader = function(path) return nil end
getFileWriter = function(path)
  local writer = { value = "" }
  function writer:write(text) self.value = self.value .. text end
  function writer:close() FILES[path] = self.value end
  return writer
end
CHARACTER_DEATH = nil
Events = {
  OnServerStarted = { Add = function() end },
  OnTickEvenPaused = { Add = function() end },
  OnCharacterDeath = { Add = function(fn) CHARACTER_DEATH = fn end },
}
instanceof = function(obj, class) return type(obj) == "table" and obj.class == class end
ONLINE = {}
function ONLINE:size() return #self end
function ONLINE:get(i) return self[i + 1] end
getOnlinePlayers = function() return ONLINE end

function makePlayer(name, x, y, z)
  local p = { class = "IsoPlayer", name = name, x = x, y = y, z = z }
  function p:getUsername() return self.name end
  function p:getX() return self.x end
  function p:getY() return self.y end
  function p:getZ() return self.z end
  function p:getAttackedBy() return nil end
  return p
end
Zombie = { class = "IsoZombie" }
function Zombie:getUsername() return "zombie" end
`;

function luaStatus(bridge) {
  bridge.run("PanelBridgeModule.updateStatus()");
  const files = bridge.getGlobal("FILES") ?? {};
  return JSON.parse(files["panelbridge/TestServer/status.json.txt"]);
}

describe("PanelBridge reports player deaths from the dead character", () => {
  it("status.json always carries the deaths list, and fills it from OnCharacterDeath", () => {
    const bridge = loadPanelBridge(LUA_PATH, LUA_STUBS);
    expect(luaStatus(bridge).deaths).toEqual([]);

    bridge.run(`
CHARACTER_DEATH(Zombie)
CHARACTER_DEATH(makePlayer("Bob", 10801.6, 9370.2, 0))
CHARACTER_DEATH(makePlayer(${luaString(COOP_NAME)}, 10800.4, 9365.9, 0))
`);
    expect(luaStatus(bridge).deaths).toEqual([
      expect.objectContaining({ seq: 1, username: "Bob", x: 10801, y: 9370, z: 0, pvp: false }),
      expect.objectContaining({ seq: 2, username: COOP_NAME, x: 10800, y: 9365, z: 0, pvp: false }),
    ]);
  });
});

function writeStatus(dir, status, mtimeMs) {
  const file = path.join(dir, "status.json");
  fs.writeFileSync(file, JSON.stringify(status));
  const when = new Date(mtimeMs);
  fs.utimesSync(file, when, when);
}

function liveStatus(extra) {
  return {
    alive: true,
    version: "1.7.73",
    serverName: "TestServer",
    playerCount: 0,
    players: [],
    startedAt: 1759000000000,
    ...extra,
  };
}

function bridgeAt(status) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-deaths-"));
  const bridge = new PanelBridge();
  bridge.configure(tmpDir, true);
  writeStatus(tmpDir, status, Date.now() - 1000);
  bridge.checkModStatus();
  return bridge;
}

function deathsFromUserLog(router) {
  const tailer = new LogTailer();
  tailer.on("playerDeath", router.fromUserLog);
  tailer.processUserLogData(GAME_WRITTEN);
}

describe("the panel takes deaths from the bridge, not the forgeable user log", () => {
  it("premise: the game-written user log still parses as a death for Sacha", () => {
    const tailer = new LogTailer();
    const players = [];
    tailer.on("playerDeath", (death) => players.push(death.player));
    tailer.processUserLogData(GAME_WRITTEN);
    expect(players).toContain("Sacha");
  });

  it("while the bridge reports deaths, the forged user-log line reaches nobody", async () => {
    const bridge = bridgeAt(liveStatus({ deaths: [] }));
    expect(bridge.reportsPlayerDeaths()).toBe(true);
    const delivered = [];
    const router = createPlayerDeathRouter({ bridge, onDeath: (d) => delivered.push(d) });
    bridge.on("playerDeath", router.fromBridge);

    deathsFromUserLog(router);
    // What the bridge reports for the same two deaths.
    writeStatus(
      tmpDir,
      liveStatus({
        deaths: [
          { seq: 1, username: "Bob", x: 10801, y: 9370, z: 0, pvp: false, at: 1 },
          { seq: 2, username: COOP_NAME, x: 10800, y: 9365, z: 0, pvp: false, at: 2 },
        ],
      }),
      Date.now(),
    );
    bridge.checkModStatus();
    await new Promise((resolve) => setImmediate(resolve));

    expect(delivered.map((d) => d.player)).toEqual(["Bob"]);
    expect(delivered[0]).toMatchObject({ x: 10801, y: 9370, z: 0, location: "10801,9370,0" });
  });

  it("deaths already listed when the panel starts watching are not reported again", async () => {
    const bridge = bridgeAt(
      liveStatus({ deaths: [{ seq: 1, username: "Bob", x: 1, y: 2, z: 0, pvp: false, at: 1 }] }),
    );
    const delivered = [];
    bridge.on("playerDeath", (d) => delivered.push(d));
    writeStatus(
      tmpDir,
      liveStatus({
        deaths: [
          { seq: 1, username: "Bob", x: 1, y: 2, z: 0, pvp: false, at: 1 },
          { seq: 2, username: "Carol", x: 3, y: 4, z: 0, pvp: true, at: 2 },
        ],
      }),
      Date.now(),
    );
    bridge.checkModStatus();
    expect(delivered.map((d) => [d.player, d.pvp])).toEqual([["Carol", true]]);
  });

  it("without a bridge that reports deaths, the user log is still the fallback", async () => {
    // An older bridge: no `deaths` in its status.
    const bridge = bridgeAt(liveStatus({}));
    expect(bridge.reportsPlayerDeaths()).toBe(false);
    const delivered = [];
    const router = createPlayerDeathRouter({ bridge, onDeath: (d) => delivered.push(d) });
    deathsFromUserLog(router);
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivered.map((d) => d.player)).toContain("Bob");
  });

  it("the same death from both sources is delivered once", async () => {
    const bridge = bridgeAt(liveStatus({}));
    const delivered = [];
    const router = createPlayerDeathRouter({ bridge, onDeath: (d) => delivered.push(d) });
    const death = { player: "Bob", x: 1, y: 2, z: 0, location: "1,2,0", pvp: false };
    router.fromUserLog(death);
    router.fromBridge({ ...death });
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivered).toHaveLength(1);
  });
});
