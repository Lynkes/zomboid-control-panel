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
//
// A world that already has the file (from those edits, or begun as a hosted
// game) still undoes any change that reaches SandboxVars.lua alone, so the
// bridge rewrites it, and only it, when the panel says the world has one
// (worldHasSandboxSnapshot). No flag, no save: a world without the file
// never gets one, and an older panel never has it refreshed.

const source = fileURLToPath(new URL('../../pz-mod/PanelBridge/media/lua/server/PanelBridge.lua', import.meta.url));

const STUBS = `
saveCalls = 0
saveFails = nil
saveGame = function()
  saveCalls = saveCalls + 1
  if saveFails then error(saveFails) end
end

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

// restoreUtilities/shutOffUtilities on a world whose hydro power flag
// follows setHydroPowerOn (sticks) or silently stays put (doesn't).
function utilitiesStubs({ sticks = true } = {}) {
  return `
saveCalls = 0
saveGame = function() saveCalls = saveCalls + 1 end
SandboxVars = {}
GameTime = { getInstance = function() return nil end }
getOnlinePlayers = function() return nil end
getSandboxOptions = function() return nil end
getCell = function() return nil end
FakeWorld = { hydroOn = false, sticks = ${sticks} }
function FakeWorld:isHydroPowerOn() return self.hydroOn end
function FakeWorld:setHydroPowerOn(v) if self.sticks then self.hydroOn = v end end
getWorld = function() return FakeWorld end
`;
}

// Lua source with comments removed, so the comments that explain saveGame()
// don't count as calls.
function luaCode(text) {
  return text.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '');
}

describe('PanelBridge.lua never creates map_sand.bin (#197)', () => {
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
    expect(result.data.worldSandboxSaved).toBeUndefined();
  });

  it('takes only a real true as the panel saying the world has the file', () => {
    const bridge = loadPanelBridge(source, STUBS);
    for (const flag of ['true', 1, false]) {
      bridge.callHandler('setSandboxOption', { name: 'ZombieLore.Cognition', value: 2, worldHasSandboxSnapshot: flag });
    }

    expect(bridge.getGlobal('saveCalls')).toBe(0);
  });

  it('saveWorld refuses without calling saveGame() and points to the RCON save', () => {
    const bridge = loadPanelBridge(source, STUBS);
    const result = bridge.callHandler('saveWorld', {});

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/map_sand\.bin/);
    expect(result.err).toMatch(/RCON save/);
    expect(bridge.getGlobal('saveCalls')).toBe(0);
  });

  it('restoreUtilities and shutOffUtilities leave the world save alone', () => {
    const bridge = loadPanelBridge(source, utilitiesStubs());
    const restored = bridge.callHandler('restoreUtilities', { power: true, water: true });
    const shut = bridge.callHandler('shutOffUtilities', { power: true, water: true });

    expect(restored.ok).toBe(true);
    expect(shut.ok).toBe(true);
    expect(restored.data.worldSandboxSaved).toBeUndefined();
    expect(shut.data.worldSandboxSaved).toBeUndefined();
    expect(bridge.getGlobal('saveCalls')).toBe(0);
  });

  it('only refreshWorldSandboxSnapshot calls saveGame(), behind the flag', () => {
    const code = luaCode(fs.readFileSync(source, 'utf8'));
    const calls = [...code.matchAll(/\bsaveGame\s*\(/g)];
    expect(calls).toHaveLength(1);

    const start = code.indexOf('function PanelBridge.refreshWorldSandboxSnapshot(args)');
    const end = code.indexOf('\nend', start);
    expect(start).toBeGreaterThan(-1);
    expect(calls[0].index).toBeGreaterThan(start);
    expect(calls[0].index).toBeLessThan(end);
    expect(code.slice(start, calls[0].index)).toMatch(/args\.worldHasSandboxSnapshot ~= true then\s+return nil/);
  });
});

describe('PanelBridge.lua keeps a live change in a map_sand.bin the world already has (#197)', () => {
  const FLAG = { worldHasSandboxSnapshot: true };

  it('setSandboxOption rewrites it after the live change and says so', () => {
    const bridge = loadPanelBridge(source, STUBS);
    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieLore.Cognition', value: 1, ...FLAG });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ value: 1, verified: 'confirmed', worldSandboxSaved: true });
    expect(result.data.worldSandboxSaveError).toBeUndefined();
    expect(bridge.getGlobal('saveCalls')).toBe(1);
  });

  it('setSandboxOption still applies the live value when the save throws, and reports it', () => {
    const bridge = loadPanelBridge(source, STUBS);
    bridge.run('saveFails = "disk full"');
    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieLore.Cognition', value: 1, ...FLAG });

    expect(result.ok).toBe(true);
    expect(bridge.getGlobal('FakeOption').value).toBe(1);
    expect(result.data.worldSandboxSaved).toBe(false);
    expect(result.data.worldSandboxSaveError).toMatch(/disk full/);
  });

  it('a failed edit leaves the file alone', () => {
    const bridge = loadPanelBridge(source, STUBS);
    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieLore.Cognition', value: 9, ...FLAG });

    expect(result.ok).toBe(false);
    expect(bridge.getGlobal('saveCalls')).toBe(0);
  });

  it('restoreUtilities and shutOffUtilities rewrite it once the change took', () => {
    const bridge = loadPanelBridge(source, utilitiesStubs());
    const restored = bridge.callHandler('restoreUtilities', { power: true, water: true, ...FLAG });
    expect(restored.ok).toBe(true);
    expect(restored.data.worldSandboxSaved).toBe(true);
    expect(bridge.getGlobal('saveCalls')).toBe(1);

    const shut = bridge.callHandler('shutOffUtilities', { power: false, water: true, ...FLAG });
    expect(shut.ok).toBe(true);
    expect(shut.data.worldSandboxSaved).toBe(true);
    expect(bridge.getGlobal('saveCalls')).toBe(2);
  });

  it('restoreUtilities leaves it alone when the power did not come on', () => {
    const bridge = loadPanelBridge(source, utilitiesStubs({ sticks: false }));
    const result = bridge.callHandler('restoreUtilities', { power: true, water: false, ...FLAG });

    expect(result.ok).toBe(false);
    expect(result.data.worldSandboxSaved).toBeUndefined();
    expect(bridge.getGlobal('saveCalls')).toBe(0);
  });

  it("runEventSequence's utilities steps carry the flag", () => {
    const bridge = loadPanelBridge(source, utilitiesStubs());
    const steps = [{ kind: 'utilities', mode: 'off', power: false, water: true }];

    const without = bridge.callHandler('runEventSequence', { steps });
    expect(without.ok).toBe(true);
    expect(bridge.getGlobal('saveCalls')).toBe(0);

    const flagged = bridge.callHandler('runEventSequence', { steps, ...FLAG });
    expect(flagged.ok).toBe(true);
    expect(flagged.data.results[0].data.worldSandboxSaved).toBe(true);
    expect(bridge.getGlobal('saveCalls')).toBe(1);
  });

  // The panel's Save World runs RCON save, then this for a world that
  // already has the file, which is what the bridge's saveWorld did to it.
  it('saveWorld rewrites it when told the world has one', () => {
    const bridge = loadPanelBridge(source, STUBS);
    const result = bridge.callHandler('saveWorld', FLAG);

    expect(result.ok).toBe(true);
    expect(result.data.worldSandboxSaved).toBe(true);
    expect(bridge.getGlobal('saveCalls')).toBe(1);

    bridge.run('saveFails = "disk full"');
    const failed = bridge.callHandler('saveWorld', FLAG);
    expect(failed.ok).toBe(false);
    expect(failed.err).toMatch(/map_sand\.bin.+disk full/);
  });
});
