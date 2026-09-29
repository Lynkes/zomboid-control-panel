import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadPanelBridgeClient } from './helpers/panelBridgeLua.js';

const CLIENT_LUA = path.resolve(
  'pz-mod/PanelBridge/media/lua/client/PanelBridgeClient.lua',
);

// The companion only runs in a multiplayer client session (see
// panelBridgeClientCompanionGuard.test.js), so every load here stubs
// isClient() true, as the game does after joining a server.
const TELEPORT_STUBS = `
Events = { OnServerCommand = { Add = function(fn) SERVER_COMMAND_HANDLER = fn end } }
ACKS = {}
sendClientCommand = function(module, command, args)
  table.insert(ACKS, { module = module, command = command, args = args })
end
FakePlayer = { x = 0, y = 0, z = 0 }
function FakePlayer:teleportTo(x, y, z) self.x = x; self.y = y; self.z = z end
function FakePlayer:getX() return self.x end
function FakePlayer:getY() return self.y end
function FakePlayer:getZ() return self.z end
getSpecificPlayer = function(index) return FakePlayer end
`;

describe('PanelBridge client teleport companion', () => {
  it('handles the server command, applies local coordinates, and acknowledges it', async () => {
    const source = await fs.readFile(CLIENT_LUA, 'utf8');

    expect(source).toContain('Events.OnServerCommand.Add(onServerCommand)');
    expect(source).toContain('module == "PanelBridge" and command == "teleport"');
    expect(source).toContain('player:teleportTo(x, y, z)');
    expect(source).toContain('sendClientCommand("PanelBridge", "teleportAck"');
    expect(source).toContain('sendTeleportAck(requestId, "applied"');
  });

  it('teleports the local player and sends an applied teleportAck when isClient() is true', () => {
    const client = loadPanelBridgeClient(CLIENT_LUA, TELEPORT_STUBS, { isServer: false, isClient: true });

    client.run('SERVER_COMMAND_HANDLER("PanelBridge", "teleport", { requestId = "req-1", x = 10500, y = 9800, z = 1 })');

    expect(client.getGlobal('FakePlayer')).toMatchObject({ x: 10500, y: 9800, z: 1 });
    expect(client.getGlobal('ACKS')).toEqual([
      {
        module: 'PanelBridge',
        command: 'teleportAck',
        args: { requestId: 'req-1', status: 'applied', x: 10500, y: 9800, z: 1 },
      },
    ]);
  });

  it('ignores other modules\' server commands', () => {
    const client = loadPanelBridgeClient(CLIENT_LUA, TELEPORT_STUBS, { isServer: false, isClient: true });

    client.run('SERVER_COMMAND_HANDLER("SomeOtherMod", "teleport", { requestId = "req-2", x = 1, y = 2, z = 0 })');

    expect(client.getGlobal('FakePlayer')).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(client.getGlobal('ACKS')).toEqual({});
  });
});
