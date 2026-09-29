import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// The Events page's time-speed slider (client/src/pages/Events.tsx) reads the
// game speed back from getGameTime's `multiplier` field, and the bridge resets
// a fast-forwarded clock to 1x when the server starts. Both must read the same
// value RCON's setTimeSpeed writes.
//
// zombie.GameTime has two different "multipliers" (javap, 42.20):
//   - The raw `multiplier` field is the game speed. SetTimeSpeedCommand
//     writes it with setMultiplier(float), a plain putfield; the world save
//     keeps it; getTrueMultiplier() reads it back (times perObjectMultiplier,
//     which is only moved inside the engine's moving-object update loop and
//     is 1 on OnTick and OnServerStarted). Vanilla pairs the same two methods
//     for the debug panel's game-speed slider (ISGameDebugPanel.lua).
//   - getMultiplier() is the per-frame time step: the raw field times
//     fpsMultiplier, multiplierBias, perObjectMultiplier, the slow-motion
//     factor and a constant 0.8f. It reads about 0.8 at normal speed.
// The bridge used to read getMultiplier(), so the slider showed 0.8x at normal
// speed and a live 42.20.4 server logged "Reset time speed from
// 0.800000011920929x to 1x" on every start.
//
// FakeGameTime models both: `raw` is the field, getMultiplier() returns
// raw * 0.8f (fpsMultiplier, bias and slow motion at 1).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'pz-mod',
  'PanelBridge',
  'media',
  'lua',
  'server',
  'PanelBridge.lua',
);

const GAME_TIME_STUBS = `
FakeGameTime = { raw = 1 }
GET_MULTIPLIER_CALLS = 0
SET_MULTIPLIER_ARGS = {}
function FakeGameTime:getTimeOfDay() return 12.5 end
function FakeGameTime:getYear() return 1993 end
function FakeGameTime:getMonth() return 6 end
function FakeGameTime:getDay() return 15 end
function FakeGameTime:getWorldAgeHours() return 100 end
function FakeGameTime:getNightsSurvived() return 4 end
function FakeGameTime:getTrueMultiplier() return self.raw end
function FakeGameTime:getMultiplier()
  GET_MULTIPLIER_CALLS = GET_MULTIPLIER_CALLS + 1
  return self.raw * 0.800000011920929
end
function FakeGameTime:setMultiplier(value)
  table.insert(SET_MULTIPLIER_ARGS, value)
  self.raw = value
end
getGameTime = function() return FakeGameTime end
`;

// A build without getTrueMultiplier (42.20 has it), or a Kahlua binding that throws for it.
const NO_TRUE_MULTIPLIER = [
  ['missing', 'FakeGameTime.getTrueMultiplier = nil'],
  ['throwing', 'function FakeGameTime:getTrueMultiplier() error("getTrueMultiplier failed") end'],
];

function loadWithSpeed(raw, extraLua = '') {
  const bridge = loadPanelBridge(LUA_PATH, GAME_TIME_STUBS);
  bridge.run(`FakeGameTime.raw = ${raw}`);
  if (extraLua) bridge.run(extraLua);
  return bridge;
}

describe('PanelBridge.lua getGameTime multiplier: the time-speed slider read-back', () => {
  it('reads 1 at normal speed, not the ~0.8 per-frame getMultiplier()', () => {
    const result = loadWithSpeed(1).callHandler('getGameTime', {});

    expect(result.ok).toBe(true);
    expect(result.data.multiplier).toBe(1);
    // Every other field this handler returns must still be intact.
    expect(result.data.year).toBe(1993);
    expect(result.data.nightsSurvived).toBe(4);
  });

  it.each([5, 10, 24, 2.5])('reads %s after RCON setTimeSpeed sets that speed', (speed) => {
    const result = loadWithSpeed(speed).callHandler('getGameTime', {});

    expect(result.ok).toBe(true);
    expect(result.data.multiplier).toBe(speed);
  });

  it.each(NO_TRUE_MULTIPLIER)('falls back to 1 when getTrueMultiplier is %s, never the per-frame value', (_label, lua) => {
    const bridge = loadWithSpeed(10, lua);

    const result = bridge.callHandler('getGameTime', {});

    expect(result.ok).toBe(true);
    expect(result.data.multiplier).toBe(1);
    expect(bridge.getGlobal('GET_MULTIPLIER_CALLS')).toBe(0);
  });
});

describe('PanelBridge.lua getTimeSpeed', () => {
  it.each([1, 10, 2.5])('reads the raw speed %s', (speed) => {
    const result = loadWithSpeed(speed).callHandler('getTimeSpeed', {});

    expect(result).toMatchObject({ ok: true, data: { multiplier: speed } });
  });

  it.each(NO_TRUE_MULTIPLIER)('falls back to 1 when getTrueMultiplier is %s, never the per-frame value', (_label, lua) => {
    const bridge = loadWithSpeed(10, lua);

    const result = bridge.callHandler('getTimeSpeed', {});

    expect(result).toMatchObject({ ok: true, data: { multiplier: 1 } });
    expect(bridge.getGlobal('GET_MULTIPLIER_CALLS')).toBe(0);
  });
});

// Enough of the engine for PanelBridge.onServerStarted to run end to end
// (the same pattern as panelBridgeDeliveryDetection.test.js): writes land in
// FILES, console lines in PRINTED.
const STARTUP_STUBS = `
FILES = {}
PRINTED = {}
print = function(line) table.insert(PRINTED, tostring(line)) end
getTimestampMs = function() return 1759000000000 end
getServerName = function() return "TestServer" end
getOnlinePlayers = function() return nil end
getWorld = function() return nil end
getSandboxOptions = function() return nil end
getChatSystem = function() return {} end
getFileReader = function(path)
  local value = FILES[path]
  if value == nil then return nil end
  local reader = { done = false }
  function reader:readLine()
    if self.done then return nil end
    self.done = true
    return value
  end
  function reader:close() end
  return reader
end
getFileWriter = function(path)
  local writer = { value = "" }
  function writer:write(text) self.value = self.value .. text end
  function writer:close() FILES[path] = self.value end
  return writer
end
`;

const LOOSE_INSTALL = {
  filenameOfClosure: '/pz-server/media/lua/server/PanelBridge.lua',
  activatedMods: [],
};

function startServer(raw, extraLua = '') {
  const bridge = loadPanelBridge(LUA_PATH, STARTUP_STUBS + GAME_TIME_STUBS, LOOSE_INSTALL);
  bridge.run(`FakeGameTime.raw = ${raw}`);
  if (extraLua) bridge.run(extraLua);
  bridge.run('PanelBridgeModule.onServerStarted()');

  const setArgs = bridge.getGlobal('SET_MULTIPLIER_ARGS');
  return {
    printed: bridge.getGlobal('PRINTED'),
    // An empty Lua table comes back as {}.
    setMultiplierArgs: Array.isArray(setArgs) ? setArgs : [],
    speedAfter: bridge.getGlobal('FakeGameTime').raw,
  };
}

const resetLines = (printed) => printed.filter((line) => line.includes('Reset time speed'));

describe('PanelBridge.onServerStarted time-speed reset', () => {
  it('leaves a normal-speed clock alone and logs nothing', () => {
    const { printed, setMultiplierArgs, speedAfter } = startServer(1);

    expect(printed).toContain('[PanelBridge] Loaded from: loose');
    expect(setMultiplierArgs).toEqual([]);
    expect(resetLines(printed)).toEqual([]);
    expect(speedAfter).toBe(1);
  });

  it('resets a fast-forwarded clock saved with the world and logs the real speed', () => {
    const { printed, setMultiplierArgs, speedAfter } = startServer(10);

    expect(setMultiplierArgs).toEqual([1]);
    expect(resetLines(printed)).toEqual([
      expect.stringMatching(/^\[PanelBridge\] Reset time speed from 10(\.0)?x to 1x$/),
    ]);
    expect(speedAfter).toBe(1);
  });

  it.each(NO_TRUE_MULTIPLIER)('leaves the clock alone when getTrueMultiplier is %s', (_label, lua) => {
    const { printed, setMultiplierArgs, speedAfter } = startServer(10, lua);

    expect(setMultiplierArgs).toEqual([]);
    expect(resetLines(printed)).toEqual([]);
    expect(speedAfter).toBe(10);
    expect(printed).toContain('[PanelBridge] Ready at: panelbridge/TestServer/');
  });
});
