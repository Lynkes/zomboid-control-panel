import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// SECURITY (2026-10-20): handlers.importPlayerData levelled each perk with
// `for lvl = 1, perkData.level do player:LevelPerk(perk, false) end`, so an
// import file with a level of 1e9 ran a billion LevelPerk calls on the game
// thread and froze the server. Levels are now clamped to the game's 0..10,
// and the item count, condition, uses and deltas to their own ranges. A perk
// entry, perks section, data or options that isn't a table used to stop the
// whole handler with a Lua error.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua');

const STUBS = `
Perks = { Fitness = { id = "Fitness" }, Strength = { id = "Strength" } }

FakeXp = { setLevels = {} }
function FakeXp:setXPToLevel(perk, level) self.setLevels[perk.id] = level end

LEVEL_CALLS = { Fitness = 0, Strength = 0 }
LEVEL0_CALLS = 0
ADDED = 0
SET = {}

FakeItem = {}
function FakeItem:getConditionMax() return 10 end
function FakeItem:getMaxUses() return 20 end
function FakeItem:setCondition(v) table.insert(SET, "condition=" .. tostring(v)) end
function FakeItem:setCurrentUses(v) table.insert(SET, "uses=" .. tostring(v)) end
function FakeItem:setJobDelta(v) table.insert(SET, "jobDelta=" .. tostring(v)) end
function FakeItem:setUseDelta(v) table.insert(SET, "useDelta=" .. tostring(v)) end

FakeInventory = {}
function FakeInventory:AddItem(fullType)
  ADDED = ADDED + 1
  return FakeItem
end

FakePlayer = {}
function FakePlayer:getUsername() return "Fielder" end
function FakePlayer:getXp() return FakeXp end
function FakePlayer:level0(perk) LEVEL0_CALLS = LEVEL0_CALLS + 1 end
function FakePlayer:LevelPerk(perk, removePick)
  LEVEL_CALLS[perk.id] = LEVEL_CALLS[perk.id] + 1
  if LEVEL_CALLS[perk.id] > 1000 then error("runaway LevelPerk loop") end
end
function FakePlayer:getInventory() return FakeInventory end

FakeOnlinePlayers = { FakePlayer }
function FakeOnlinePlayers:size() return 1 end
function FakeOnlinePlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return FakeOnlinePlayers end
`;

function run(data, options) {
  const bridge = loadPanelBridge(LUA_PATH, STUBS);
  const result = bridge.callHandler('importPlayerData', { username: 'Fielder', data, ...(options === undefined ? {} : { options }) });
  return { result, bridge, get: (name) => bridge.getGlobal(name) };
}

describe('PanelBridge.lua importPlayerData clamps what an import file asks for', () => {
  it('a perk level of 1e9 levels the perk 10 times, not a billion', () => {
    const { result, get } = run({ perks: { Fitness: { level: 1e9, xp: 1e12 } } });
    expect(result.ok).toBe(true);
    expect(get('LEVEL_CALLS').Fitness).toBe(10);
    expect(get('FakeXp').setLevels.Fitness).toBe(10);
    expect(result.data.restored.perks).toBe(1);
  });

  it.each([
    [-5, 0],
    [2.7, 2],
    ['7', 7],
    [10, 10],
    [11, 10],
  ])('level %j becomes %j', (level, expected) => {
    const { get } = run({ perks: { Strength: { level } } });
    expect(get('LEVEL_CALLS').Strength).toBe(expected);
    expect(get('FakeXp').setLevels.Strength).toBe(expected);
  });

  it('skips a perk with no number for a level, and keeps going', () => {
    const { result, get } = run({
      perks: { Fitness: { level: 'lots' }, Strength: { level: 3 } },
    });
    expect(result.ok).toBe(true);
    expect(get('LEVEL_CALLS')).toEqual({ Fitness: 0, Strength: 3 });
    expect(result.data.restored.perks).toBe(1);
  });

  it('a perk entry, perks section, data or options that is not a table does not stop the handler', () => {
    const entry = run({ perks: { Fitness: 5, Strength: { level: 4 } } });
    expect(entry.result.ok).toBe(true);
    expect(entry.get('LEVEL_CALLS')).toEqual({ Fitness: 0, Strength: 4 });

    const section = run({ perks: 'Fitness', inventory: [{ fullType: 'Base.Axe' }] });
    expect(section.result.ok).toBe(true);
    expect(section.get('ADDED')).toBe(1);

    const options = run({ perks: { Strength: { level: 1 } } }, 5);
    expect(options.result.ok).toBe(true);
    expect(options.get('LEVEL_CALLS').Strength).toBe(1);

    const data = run('not a table');
    expect(data.result.ok).toBe(false);
  });

  it("clamps an item's count, condition, uses and deltas", () => {
    const { result, get } = run({
      inventory: [
        { fullType: 'Base.Axe', count: 1e9, condition: 1e9, uses: -3, jobDelta: 5, useDelta: -1 },
      ],
    });
    expect(result.ok).toBe(true);
    expect(get('ADDED')).toBe(100);
    const set = Object.values(get('SET'));
    expect(set.slice(0, 4)).toEqual(['condition=10', 'uses=0', 'jobDelta=1', 'useDelta=0']);
  });
});
