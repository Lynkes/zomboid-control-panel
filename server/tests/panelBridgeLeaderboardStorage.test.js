// BRIDGE-2: the leaderboard used to live in global ModData keyed by
// steam:<SteamID64>. GlobalModData.receiveRequest (42.21) answers any logged-in
// client's ModData.request(tag) with the whole table, so every player could
// read a SteamID-to-username map (with deaths and last-seen times) of everyone
// who ever played. These tests pin the store to a server-side file in the
// bridge folder, the move of an existing ModData store, and that global
// ModData only ever holds an opaque world id.
import { describe, expect, it } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

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

const LEADERBOARD_FILE = 'panelbridge/TestServer/leaderboard.json.txt';
const LEGACY_KEY = 'PanelBridgeLeaderboard';
const WORLD_KEY = 'PanelBridgeLeaderboardWorld';

function luaString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// prelude: Lua run after the fakes are defined and before the mod loads, to
// seed FILES / ModData.stores the way a previous session left them.
function stubs(prelude = '') {
  return `
Now = 1000000
function getTimestampMs() return Now end
getServerName = function() return "TestServer" end

FILES = {}
FAIL_WRITE = false
getFileReader = function(path)
  local value = FILES[path]
  if value == nil then return nil end
  local reader = { value = value, done = false }
  function reader:readLine()
    if self.done then return nil end
    self.done = true
    return self.value
  end
  function reader:close() end
  return reader
end
getFileWriter = function(path)
  if FAIL_WRITE then return nil end
  local writer = { path = path, value = "" }
  function writer:write(value) self.value = self.value .. value end
  function writer:close() FILES[self.path] = self.value end
  return writer
end

ModData = { stores = {} }
function ModData.getOrCreate(key)
  if not ModData.stores[key] then ModData.stores[key] = {} end
  return ModData.stores[key]
end
function ModData.exists(key) return ModData.stores[key] ~= nil end
function ModData.get(key) return ModData.stores[key] end
function ModData.remove(key)
  local removed = ModData.stores[key]
  ModData.stores[key] = nil
  return removed
end

Events.OnPlayerDeath = { Add = function(fn) OnPlayerDeathHandler = fn end }
Events.OnZombieDead = { Add = function(fn) OnZombieDeadHandler = fn end }

Alice = { kills = 12, hours = 48 }
function Alice:getUsername() return "Alice" end
function Alice:getDisplayName() return "Alice Survivor" end
function Alice:getSteamID() return "76561198000000001" end
function Alice:getZombieKills() return self.kills end
function Alice:getHoursSurvived() return self.hours end
function Alice:getPrimaryHandItem() return Weapon end
function Alice:getSecondaryHandItem() return nil end

Bob = { kills = 5, hours = 24 }
function Bob:getUsername() return "Bob" end
function Bob:getDisplayName() return "Bob Survivor" end
function Bob:getSteamID() return "76561198000000002" end
function Bob:getZombieKills() return self.kills end
function Bob:getHoursSurvived() return self.hours end

Zombie = {}
function Zombie:getAttackedBy() return Alice end
Weapon = {}
function Weapon:getDisplayName() return "Axe" end

function setOnline(list)
  CurrentPlayers = list
  function CurrentPlayers:size() return #self end
  function CurrentPlayers:get(i) return self[i + 1] end
end
setOnline({ Alice, Bob })
getOnlinePlayers = function() return CurrentPlayers end

${prelude}
`;
}

const LEGACY_PRELUDE = `
ModData.stores.${LEGACY_KEY} = {
  version = 1,
  trackingStartedAt = 500,
  players = {
    ["steam:76561198000000009"] = {
      username = "Carol", displayName = "Carol Survivor",
      currentKills = 3, allTimeKills = 40, currentDays = 1, bestDays = 5,
      deaths = 2, favoriteWeapon = "Bat", favoriteWeaponKills = 7,
      weaponKills = { Bat = 7 }, lastSeenAt = 600,
    },
  },
}
`;

// Runs the bridge's tick with only the leaderboard part due: no job, command
// poll or status write.
function tick(bridge, now) {
  bridge.run(`
Now = ${now}
PanelBridgeModule.initialized = true
PanelBridgeModule.processActiveJob = function() end
PanelBridgeModule.lastCheck = Now
PanelBridgeModule.lastStatusUpdate = Now
PanelBridgeModule.onTick()
`);
}

function modDataStores(bridge) {
  bridge.run('MODDATA_STORES = ModData.stores');
  return bridge.getGlobal('MODDATA_STORES') ?? {};
}

function leaderboardFile(bridge) {
  const files = bridge.getGlobal('FILES') ?? {};
  return files[LEADERBOARD_FILE] ? JSON.parse(files[LEADERBOARD_FILE]) : null;
}

function rowFor(result, username) {
  expect(result.ok).toBe(true);
  return result.data.players.find((player) => player.username === username);
}

describe('PanelBridge leaderboard storage', () => {
  it('keeps SteamIDs and usernames out of world-readable global ModData', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs());
    bridge.callHandler('getLeaderboard');
    bridge.run('OnZombieDeadHandler(Zombie); OnPlayerDeathHandler(Alice)');
    tick(bridge, 2000000);
    const result = bridge.callHandler('getLeaderboard');
    expect(rowFor(result, 'Alice').deaths).toBe(1);

    const stores = modDataStores(bridge);
    const dump = JSON.stringify(stores);
    expect(dump).not.toMatch(/7656119800000000/);
    expect(dump).not.toMatch(/Alice|Bob|Axe/);
    expect(Object.keys(stores)).toEqual([WORLD_KEY]);
    expect(Object.keys(stores[WORLD_KEY])).toEqual(['id']);
  });

  it('saves the leaderboard in the bridge folder and reads it back after a restart', () => {
    const first = loadPanelBridge(LUA_PATH, stubs());
    first.callHandler('getLeaderboard');
    first.run('OnZombieDeadHandler(Zombie); OnPlayerDeathHandler(Alice)');
    tick(first, 2000000);

    const saved = leaderboardFile(first);
    const worldId = modDataStores(first)[WORLD_KEY].id;
    expect(saved.worldId).toBe(worldId);
    expect(saved.players['steam:76561198000000001']).toEqual(expect.objectContaining({
      username: 'Alice', allTimeKills: 12, deaths: 1, favoriteWeapon: 'Axe',
    }));

    const files = first.getGlobal('FILES');
    const second = loadPanelBridge(LUA_PATH, stubs(`
FILES[${luaString(LEADERBOARD_FILE)}] = ${luaString(files[LEADERBOARD_FILE])}
ModData.stores.${WORLD_KEY} = { id = ${luaString(worldId)} }
setOnline({})
`));
    const after = second.callHandler('getLeaderboard');
    const alice = rowFor(after, 'Alice');
    expect(alice).toEqual(expect.objectContaining({
      id: 'steam:76561198000000001',
      online: false,
      allTimeKills: 12,
      deaths: 1,
      favoriteWeapon: 'Axe',
      favoriteWeaponKills: 1,
    }));
    expect(rowFor(after, 'Bob').allTimeKills).toBe(5);
    expect(after.data.trackingStartedAt).toBe(1000000);
  });

  it('writes changes at most once per flush interval', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs());
    bridge.callHandler('getLeaderboard');
    tick(bridge, 2000000);
    expect(leaderboardFile(bridge).players['steam:76561198000000001'].allTimeKills).toBe(12);

    bridge.run('Alice.kills = 20');
    bridge.callHandler('getLeaderboard');
    tick(bridge, 2005000);
    expect(leaderboardFile(bridge).players['steam:76561198000000001'].allTimeKills).toBe(12);

    tick(bridge, 2010000);
    expect(leaderboardFile(bridge).players['steam:76561198000000001'].allTimeKills).toBe(20);
  });

  it('moves a ModData leaderboard from an older bridge into the file and removes the table', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs(LEGACY_PRELUDE));
    const result = bridge.callHandler('getLeaderboard');

    expect(rowFor(result, 'Carol')).toEqual(expect.objectContaining({
      id: 'steam:76561198000000009',
      online: false,
      allTimeKills: 40,
      deaths: 2,
      favoriteWeapon: 'Bat',
      favoriteWeaponKills: 7,
    }));
    expect(rowFor(result, 'Alice').online).toBe(true);
    expect(result.data.trackingStartedAt).toBe(500);

    const stores = modDataStores(bridge);
    expect(stores[LEGACY_KEY]).toBeUndefined();
    expect(JSON.stringify(stores)).not.toMatch(/7656119800000000|Carol/);

    const saved = leaderboardFile(bridge);
    expect(saved.players['steam:76561198000000009']).toEqual(expect.objectContaining({
      username: 'Carol', allTimeKills: 40, weaponKills: { Bat: 7 },
    }));
    expect(saved.trackingStartedAt).toBe(500);
  });

  it('keeps the old table untouched while the file cannot be written, then finishes the move', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs(`${LEGACY_PRELUDE}\nFAIL_WRITE = true`));
    const result = bridge.callHandler('getLeaderboard');
    expect(rowFor(result, 'Carol').allTimeKills).toBe(40);

    // Nothing is lost, and nothing new is added to the world-readable table.
    let legacy = modDataStores(bridge)[LEGACY_KEY];
    expect(Object.keys(legacy.players)).toEqual(['steam:76561198000000009']);
    expect(leaderboardFile(bridge)).toBeNull();

    bridge.run('FAIL_WRITE = false');
    tick(bridge, 2000000);
    legacy = modDataStores(bridge)[LEGACY_KEY];
    expect(legacy).toBeUndefined();
    expect(Object.keys(leaderboardFile(bridge).players).sort()).toEqual([
      'steam:76561198000000001',
      'steam:76561198000000002',
      'steam:76561198000000009',
    ]);
  });

  it('starts a new leaderboard when the file belongs to a wiped world', () => {
    const oldFile = JSON.stringify({
      version: 2,
      worldId: 'old-world',
      trackingStartedAt: 10,
      players: { 'steam:76561198000000004': { username: 'Dave', allTimeKills: 99 } },
    });
    const bridge = loadPanelBridge(LUA_PATH, stubs(`FILES[${luaString(LEADERBOARD_FILE)}] = ${luaString(oldFile)}`));
    const result = bridge.callHandler('getLeaderboard');
    expect(rowFor(result, 'Dave')).toBeUndefined();
    expect(result.data.trackingStartedAt).toBe(1000000);

    tick(bridge, 2000000);
    const saved = leaderboardFile(bridge);
    expect(saved.worldId).toBe(modDataStores(bridge)[WORLD_KEY].id);
    expect(saved.worldId).not.toBe('old-world');
    expect(saved.players['steam:76561198000000004']).toBeUndefined();
  });
});
