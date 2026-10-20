import { describe, expect, it } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { loadPanelBridge } from "./helpers/panelBridgeLua.js";

// Supply-chain review 2026-10-20: PanelBridge.lua registered an
// OnClientCommand handler for one command, "teleportAck", which any
// connected player can send with any arguments. It stored each one in
// PanelBridge.teleportAcks (up to 200 entries, whatever strings the player
// chose), and nothing ever read that table. The server no longer listens
// for client commands at all; the teleport itself (sendServerCommand to the
// client companion) is unchanged.

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

// Events that keep every handler the file registers, so the test can fire
// them the way the game would.
const EVENT_STUBS = `
HANDLERS = {}
Events = setmetatable({}, { __index = function(events, name)
  local event = { Add = function(fn)
    HANDLERS[name] = HANDLERS[name] or {}
    table.insert(HANDLERS[name], fn)
  end }
  rawset(events, name, event)
  return event
end })
FakePlayer = { getUsername = function() return "griefer" end }
function fireClientCommand(module, command, args)
  for _, fn in ipairs(HANDLERS.OnClientCommand or {}) do
    fn(module, command, FakePlayer, args)
  end
end
`;

describe("PanelBridge.lua: commands sent by game clients", () => {
  it("registers no OnClientCommand handler", () => {
    const bridge = loadPanelBridge(LUA_PATH, EVENT_STUBS, { isServer: true });
    expect(bridge.getGlobal("PanelBridgeModule")).toMatchObject({ MOD_ID: "ZCPB" });
    bridge.run("HANDLER_COUNT = #(HANDLERS.OnClientCommand or {})");
    expect(bridge.getGlobal("HANDLER_COUNT")).toBe(0);
    expect(bridge.getGlobal("HANDLERS")).not.toHaveProperty("OnClientCommand");
  });

  it("ignores a teleportAck from a player: nothing is stored", () => {
    const bridge = loadPanelBridge(LUA_PATH, EVENT_STUBS, { isServer: true });
    bridge.run(`
      for i = 1, 300 do
        fireClientCommand("PanelBridge", "teleportAck", {
          requestId = "forged-" .. i, status = "applied", x = 1, y = 2, z = 0, error = string.rep("x", 1000),
        })
      end
      STORED = PanelBridgeModule.teleportAcks
      ORDER = PanelBridgeModule.teleportAckOrder
      HAS_HANDLER = PanelBridgeModule.onClientCommand ~= nil
    `);
    expect(bridge.getGlobal("STORED")).toBeNull();
    expect(bridge.getGlobal("ORDER")).toBeNull();
    expect(bridge.getGlobal("HAS_HANDLER")).toBe(false);
  });
});
