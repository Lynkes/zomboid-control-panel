import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

const CLIENT_LUA = path.resolve(
  'pz-mod/PanelBridge/media/lua/client/PanelBridgeClient.lua',
);

describe('PanelBridge client teleport companion', () => {
  it('handles the server command, applies local coordinates, and acknowledges it', async () => {
    const source = await fs.readFile(CLIENT_LUA, 'utf8');

    expect(source).toContain('Events.OnServerCommand.Add(onServerCommand)');
    expect(source).toContain('module == "PanelBridge" and command == "teleport"');
    expect(source).toContain('player:teleportTo(x, y, z)');
    expect(source).toContain('sendClientCommand("PanelBridge", "teleportAck"');
    expect(source).toContain('sendTeleportAck(requestId, "applied"');
  });
});