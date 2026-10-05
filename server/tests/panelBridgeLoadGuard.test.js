// PanelBridge.lua ships in the Steam Workshop item too, and every player's
// game loads and RUNS each active mod's media/lua/server (42.20
// GameLoadingState.enter -> LuaManager.LoadDirBase("server"), outside any
// GameClient.client check). The file's first statement therefore has to stop
// the chunk everywhere except on a dedicated server: before it, nothing may
// register an event handler or touch a file. isServer() is GameServer.server,
// which GameServer.main sets in its first few instructions, long before
// doMinimumInit loads Lua; it is false on MP clients and in single player,
// where isClient() is false as well (so `if isClient()` would not do).
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { firstLuaStatement, loadPanelBridge } from "./helpers/panelBridgeLua.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "pz-mod",
  "PanelBridge",
  "media",
  "lua",
  "server",
  "PanelBridge.lua",
);

const SERVER_GUARD = "if not (isServer and isServer()) then return end";

// Counts every load-time side effect a stopped chunk must not have.
const SIDE_EFFECT_STUBS = `
FILE_OPENS = 0
PRINTS = 0
getFileWriter = function() FILE_OPENS = FILE_OPENS + 1; return nil end
getFileReader = function() FILE_OPENS = FILE_OPENS + 1; return nil end
print = function() PRINTS = PRINTS + 1 end
`;

// luaToJs turns an empty Lua table into {}, a filled sequence into an array.
function asList(value) {
  if (Array.isArray(value)) return value;
  return Object.values(value ?? {});
}

describe("PanelBridge.lua load guard", () => {
  it("returns nil and registers nothing when isServer() is false (MP client or single player)", () => {
    const bridge = loadPanelBridge(LUA_PATH, SIDE_EFFECT_STUBS, { isServer: false, countEvents: true });

    expect(bridge.getGlobal("PanelBridgeModule")).toBeNull();
    expect(asList(bridge.getGlobal("EVENT_ADDS"))).toEqual([]);
    expect(bridge.getGlobal("FILE_OPENS")).toBe(0);
    expect(bridge.getGlobal("PRINTS")).toBe(0);
  });

  it("also stops, without an error, when the isServer global is missing", () => {
    const bridge = loadPanelBridge(LUA_PATH, SIDE_EFFECT_STUBS, { isServer: null, countEvents: true });

    expect(bridge.getGlobal("PanelBridgeModule")).toBeNull();
    expect(asList(bridge.getGlobal("EVENT_ADDS"))).toEqual([]);
    expect(bridge.getGlobal("FILE_OPENS")).toBe(0);
  });

  it("still loads and registers its events on a dedicated server", () => {
    const bridge = loadPanelBridge(LUA_PATH, SIDE_EFFECT_STUBS, { isServer: true, countEvents: true });

    const module = bridge.getGlobal("PanelBridgeModule");
    expect(module).toMatchObject({ MOD_ID: "ZCPB", PROTOCOL_VERSION: "queue-v1" });
    expect(asList(bridge.getGlobal("EVENT_ADDS")).sort()).toEqual([
      "OnCharacterDeath",
      "OnClientCommand",
      "OnServerStarted",
      "OnTickEvenPaused",
      "OnZombieDead",
    ]);
    // Loading alone never writes: the first file access is OnServerStarted's.
    expect(bridge.getGlobal("FILE_OPENS")).toBe(0);
  });

  it("keeps the guard as the file's first executable statement", () => {
    const source = fs.readFileSync(LUA_PATH, "utf8");

    expect(firstLuaStatement(source)).toBe(SERVER_GUARD);
  });
});
