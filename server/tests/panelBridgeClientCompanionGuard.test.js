// PanelBridgeClient.lua reaches every player through the Steam Workshop item,
// including single player and the main menu, where there is no server to
// send it a teleport. Its first statement stops it unless isClient() is true,
// which it only is after joining a server: ConnectionManager.doServerConnect
// sets GameClient.client before ConnectToServerState reloads mod Lua with
// Core.ResetLua(..., "ConnectedToServer") (42.20). The dedicated server
// hashes media/lua/client for the Lua checksum but never runs it.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { firstLuaStatement, loadPanelBridgeClient } from "./helpers/panelBridgeLua.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_LUA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "pz-mod",
  "PanelBridge",
  "media",
  "lua",
  "client",
  "PanelBridgeClient.lua",
);

const CLIENT_GUARD = "if not (isClient and isClient()) then return end";

const CLIENT_STUBS = `
CLIENT_COMMANDS = 0
sendClientCommand = function() CLIENT_COMMANDS = CLIENT_COMMANDS + 1 end
`;

function asList(value) {
  if (Array.isArray(value)) return value;
  return Object.values(value ?? {});
}

describe("PanelBridgeClient.lua load guard", () => {
  it("registers no OnServerCommand handler when isClient() is false (single player, main menu)", () => {
    const client = loadPanelBridgeClient(CLIENT_LUA_PATH, CLIENT_STUBS, {
      isServer: false,
      isClient: false,
      countEvents: true,
    });

    expect(asList(client.getGlobal("EVENT_ADDS"))).toEqual([]);
    expect(client.getGlobal("CLIENT_COMMANDS")).toBe(0);
  });

  it("registers nothing when the isClient global is missing", () => {
    const client = loadPanelBridgeClient(CLIENT_LUA_PATH, CLIENT_STUBS, { isServer: false, countEvents: true });

    expect(client.getGlobal("isClient")).toBeNull();
    expect(asList(client.getGlobal("EVENT_ADDS"))).toEqual([]);
  });

  it("registers its OnServerCommand handler in a multiplayer client session", () => {
    const client = loadPanelBridgeClient(CLIENT_LUA_PATH, CLIENT_STUBS, {
      isServer: false,
      isClient: true,
      countEvents: true,
    });

    expect(asList(client.getGlobal("EVENT_ADDS"))).toEqual(["OnServerCommand"]);
  });

  it("keeps the guard as the file's first executable statement", () => {
    const source = fs.readFileSync(CLIENT_LUA_PATH, "utf8");

    expect(firstLuaStatement(source)).toBe(CLIENT_GUARD);
  });
});
