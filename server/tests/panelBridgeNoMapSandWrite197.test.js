import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// #197: on a dedicated server the Lua global saveGame() runs GameWindow.save,
// the single-player save path. It writes <save>/map_sand.bin, a copy of every
// sandbox option, and SandboxOptions.load() applies that copy over
// SandboxVars.lua on every start (javap on 42.21, confirmed on a live 42.21
// server). A vanilla dedicated server never writes the file. setSandboxOption
// called saveGame() after every live edit and saveWorld called it on request,
// so one panel edit froze the whole sandbox into the world and every later
// SandboxVars.lua or in-game admin change was undone at the next restart.

const source = fileURLToPath(new URL('../../pz-mod/PanelBridge/media/lua/server/PanelBridge.lua', import.meta.url));

const STUBS = `
saveCalls = 0
saveGame = function() saveCalls = saveCalls + 1 end

FakeOption = { value = 3 }
function FakeOption:getName() return "ZombieLore.Cognition" end
function FakeOption:getClass() return "class zombie.SandboxOptions$EnumSandboxOption" end
function FakeOption:getNumValues() return 4 end
function FakeOption:getValue() return self.value end
function FakeOption:setValue(value) self.value = value end
FakeSandbox = {}
function FakeSandbox:getNumOptions() return 1 end
function FakeSandbox:getOptionByIndex(i) if i == 0 then return FakeOption end end
syncCalls = 0
function FakeSandbox:toLua() syncCalls = syncCalls + 1 end
getSandboxOptions = function() return FakeSandbox end
getWorld = function() return {} end
`;

// Lua source with comments removed, so the comments that explain why
// saveGame() is gone don't count as calls.
function luaCode(text) {
  return text.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '');
}

describe('PanelBridge.lua never writes map_sand.bin (#197)', () => {
  it('setSandboxOption changes the live value without calling saveGame()', () => {
    const bridge = loadPanelBridge(source, STUBS);
    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieLore.Cognition', value: 1 });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ name: 'ZombieLore.Cognition', value: 1, verified: 'confirmed' });
    expect(bridge.getGlobal('syncCalls')).toBe(1);
    expect(bridge.getGlobal('saveCalls')).toBe(0);
    // No world save, so nothing to report: a panel reads a missing field as
    // "no warning" (ServerConfig.tsx isWorldSaveFailure).
    expect(result.data.persisted).toBeUndefined();
    expect(result.data.saveError).toBeUndefined();
  });

  it('saveWorld refuses without calling saveGame() and points to the RCON save', () => {
    const bridge = loadPanelBridge(source, STUBS);
    const result = bridge.callHandler('saveWorld', {});

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/map_sand\.bin/);
    expect(result.err).toMatch(/RCON save/);
    expect(bridge.getGlobal('saveCalls')).toBe(0);
  });

  it('no code in the bridge calls saveGame()', () => {
    const code = luaCode(fs.readFileSync(source, 'utf8'));
    expect(code).not.toMatch(/\bsaveGame\s*\(/);
  });
});
