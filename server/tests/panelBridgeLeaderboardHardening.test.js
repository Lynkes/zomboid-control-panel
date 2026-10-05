// BRIDGE-2 adversary pass (security sweep 2026-10-04) on the leaderboard
// move out of global ModData:
//   - the move only ran on the first zombie death, player death or panel
//     Leaderboard read, so after the upgrade restart (and every restart
//     after it) any player who joined and asked for "PanelBridgeLeaderboard"
//     still got every past player's SteamID beside their name; and when the
//     bridge never initialized, a failed forced write was never retried;
//   - every zombie kill made the whole store due, and it was re-encoded on
//     the server's main thread every 10 seconds (about a second per 2000
//     players);
//   - the file was truncated and rewritten in place, and the lenient JSON
//     decoder accepted a write cut short, so a crash during a flush silently
//     dropped rows and the next flush made the loss permanent.
// Promoted from the adversary's bridge2_upgradeWindow / bridge2_flushCost /
// bridge2_tornFile harnesses.
import { describe, expect, it } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

const LUA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'pz-mod',
  'PanelBridge',
  'media',
  'lua',
  'server',
  'PanelBridge.lua',
);

const COPY_1 = 'panelbridge/TestServer/leaderboard.json.txt';
const COPY_2 = 'panelbridge/TestServer/leaderboard.2.json.txt';
const LEGACY_KEY = 'PanelBridgeLeaderboard';
const WORLD_ID = 'world-1';

const LOOSE_INSTALL = {
  filenameOfClosure: '/pz-server/media/lua/server/PanelBridge.lua',
  activatedMods: [],
};

function luaString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// Enough engine for onServerStarted and onTick to run end to end, plus a
// GlobalModData request handler shaped like 42.21's receiveRequest: get(tag)
// and send the whole table, no creation.
function stubs(prelude = '') {
  return `
Now = 1759000000000
getTimestampMs = function() return Now end
getServerName = function() return "TestServer" end
getWorld = function() return nil end
getSandboxOptions = function() return nil end
getChatSystem = function() return {} end
getGameTime = function() return nil end
FILES = {}
FAIL_WRITE = false
LEADERBOARD_WRITES = 0
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
  if FAIL_WRITE then return nil end
  local writer = { value = "" }
  function writer:write(text) self.value = self.value .. text end
  function writer:close()
    FILES[path] = self.value
    if string.find(path, "leaderboard", 1, true) then LEADERBOARD_WRITES = LEADERBOARD_WRITES + 1 end
  end
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
ModData.stores.PanelBridgeLeaderboardWorld = { id = ${luaString(WORLD_ID)} }
function clientRequest(tag)
  return ModData.stores[tag] ~= nil
end

ZOMBIE_DEAD = nil
Events = {
  OnServerStarted = { Add = function() end },
  OnTickEvenPaused = { Add = function() end },
  OnZombieDead = { Add = function(fn) ZOMBIE_DEAD = fn end },
}

Alice = { kills = 1 }
function Alice:getUsername() return "Alice" end
function Alice:getDisplayName() return "Alice" end
function Alice:getSteamID() return "76561198000000001" end
function Alice:getZombieKills() return self.kills end
function Alice:getHoursSurvived() return 1 end
function Alice:getPrimaryHandItem() return Weapon end
Weapon = {}
function Weapon:getDisplayName() return "Axe" end
Zombie = {}
function Zombie:getAttackedBy() return Alice end
ONLINE = { Alice }
function ONLINE:size() return #self end
function ONLINE:get(i) return self[i + 1] end
getOnlinePlayers = function() return ONLINE end

${prelude}
`;
}

const LEGACY_PRELUDE = `
ModData.stores.${LEGACY_KEY} = {
  version = 1,
  trackingStartedAt = 1700000000000,
  players = {
    ["steam:76561198000000009"] = { username = "Carol", deaths = 2, allTimeKills = 40, lastSeenAt = 1758000000000, weaponKills = {} },
    ["steam:76561198000000010"] = { username = "ServerOwnerAdmin", deaths = 0, allTimeKills = 3, lastSeenAt = 1750000000000, weaponKills = {} },
  },
}
`;

function newestCopy(bridge) {
  const files = bridge.getGlobal('FILES') ?? {};
  const copies = [COPY_1, COPY_2].filter((name) => files[name]).map((name) => JSON.parse(files[name]));
  if (copies.length === 0) return null;
  return copies.reduce((newest, copy) => (copy.flushSeq > newest.flushSeq ? copy : newest));
}

function legacyRequestable(bridge) {
  bridge.run(`LEAK = clientRequest("${LEGACY_KEY}")`);
  return bridge.getGlobal('LEAK');
}

describe('PanelBridge leaderboard move and saving', () => {
  it('moves the old world-readable table out when the server starts, before anyone joins', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs(LEGACY_PRELUDE), LOOSE_INSTALL);
    bridge.run('PanelBridgeModule.onServerStarted()');

    expect(legacyRequestable(bridge)).toBe(false);
    expect(Object.keys(newestCopy(bridge).players).sort()).toEqual([
      'steam:76561198000000009',
      'steam:76561198000000010',
    ]);
  });

  it('keeps retrying the move from the tick even when the bridge did not come up', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs(`${LEGACY_PRELUDE}\nFAIL_WRITE = true`), LOOSE_INSTALL);
    bridge.run('PanelBridgeModule.onServerStarted(); INIT = PanelBridgeModule.initialized == true');
    expect(bridge.getGlobal('INIT')).toBe(false);
    expect(legacyRequestable(bridge)).toBe(true);

    bridge.run(`
FAIL_WRITE = false
for i = 1, 13 do
  Now = Now + 5000
  PanelBridgeModule.onTick()
end
`);
    expect(legacyRequestable(bridge)).toBe(false);
    expect(newestCopy(bridge).players['steam:76561198000000010'].username).toBe('ServerOwnerAdmin');
  });

  it('a kill every two seconds writes the file at most once a minute', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs(), LOOSE_INSTALL);
    bridge.run(`
PanelBridgeModule.onServerStarted()
LEADERBOARD_WRITES = 0
for i = 1, 30 do
  Now = Now + 2000
  ZOMBIE_DEAD(Zombie)
  PanelBridgeModule.onTick()
end
`);
    expect(bridge.getGlobal('LEADERBOARD_WRITES')).toBeLessThanOrEqual(1);

    // The kills since that write reach the file at the next one.
    bridge.run('Now = Now + 61000; PanelBridgeModule.onTick()');
    expect(newestCopy(bridge).players['steam:76561198000000001'].weaponKills).toEqual({ Axe: 30 });
  });

  it('rows that changed between flushes are saved with their new values', () => {
    const bridge = loadPanelBridge(LUA_PATH, stubs(LEGACY_PRELUDE), LOOSE_INSTALL);
    bridge.run(`
PanelBridgeModule.onServerStarted()
for round = 1, 3 do
  ZOMBIE_DEAD(Zombie)
  Now = Now + 61000
  PanelBridgeModule.onTick()
end
`);
    const saved = newestCopy(bridge);
    expect(saved.players['steam:76561198000000001'].weaponKills).toEqual({ Axe: 3 });
    expect(saved.players['steam:76561198000000009'].allTimeKills).toBe(40);
  });

  it('a newer copy cut short is ignored, and the last complete copy is kept', () => {
    const complete = {
      version: 2,
      worldId: WORLD_ID,
      trackingStartedAt: 5,
      flushSeq: 2,
      players: {
        'steam:1': { username: 'A', allTimeKills: 1, weaponKills: {} },
        'steam:2': { username: 'B', allTimeKills: 2, weaponKills: {} },
        'steam:3': { username: 'C', allTimeKills: 3, deaths: 4, weaponKills: {} },
      },
      complete: true,
    };
    const newer = JSON.stringify({ ...complete, flushSeq: 3 });
    // A crash part-way through writing row C.
    const torn = newer.slice(0, newer.indexOf('"allTimeKills":3'));
    const bridge = loadPanelBridge(
      LUA_PATH,
      stubs(`
FILES[${luaString(COPY_1)}] = ${luaString(torn)}
FILES[${luaString(COPY_2)}] = ${luaString(JSON.stringify(complete))}
`),
      LOOSE_INSTALL,
    );
    const result = bridge.callHandler('getLeaderboard');
    expect(result.ok).toBe(true);
    const c = result.data.players.find((p) => p.username === 'C');
    expect(c).toEqual(expect.objectContaining({ allTimeKills: 3, deaths: 4 }));

    // The next flush replaces the cut-short copy, never the complete one.
    bridge.run('Now = Now + 61000; PanelBridgeModule.flushLeaderboard()');
    const files = bridge.getGlobal('FILES');
    expect(JSON.parse(files[COPY_2])).toEqual(complete);
    expect(JSON.parse(files[COPY_1]).players['steam:3']).toEqual(
      expect.objectContaining({ allTimeKills: 3, deaths: 4 }),
    );
  });
});
