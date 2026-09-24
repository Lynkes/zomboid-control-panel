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

const STUBS = `
Now = 1000
function getTimestampMs() return Now end
ModData = { stores = {} }
function ModData.getOrCreate(key)
  if not ModData.stores[key] then ModData.stores[key] = { players = {} } end
  return ModData.stores[key]
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
function Zombie:isZombie() return true end
function Zombie:getAttackedBy() return Alice end
Weapon = {}
function Weapon:getDisplayName() return "Axe" end

CurrentPlayers = { Alice, Bob }
function CurrentPlayers:size() return #self end
function CurrentPlayers:get(i) return self[i + 1] end
getOnlinePlayers = function() return CurrentPlayers end
`;

function rowFor(result, username) {
  expect(result.ok).toBe(true);
  return result.data.players.find((player) => player.username === username);
}

describe('PanelBridge leaderboard telemetry', () => {
  it('reconciles current-life metrics and persists all-time rows across offline reads', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const first = bridge.callHandler('getLeaderboard');
    const alice = rowFor(first, 'Alice');

    expect(alice.displayName).toBe('Alice Survivor');
    expect(alice.currentKills).toBe(12);
    expect(alice.allTimeKills).toBe(12);
    expect(alice.currentDays).toBe(2);
    expect(alice.bestDays).toBe(2);
    expect(alice.online).toBe(true);

    bridge.run(`Alice.kills = 15; Alice.hours = 72; Bob.kills = 8`);
    const second = bridge.callHandler('getLeaderboard');
    expect(rowFor(second, 'Alice').currentKills).toBe(15);
    expect(rowFor(second, 'Alice').allTimeKills).toBe(15);
    expect(rowFor(second, 'Alice').bestDays).toBe(3);
    expect(rowFor(second, 'Bob').allTimeKills).toBe(8);

    bridge.run(`Alice.kills = 0; Alice.hours = 1`);
    const newLife = bridge.callHandler('getLeaderboard');
    expect(rowFor(newLife, 'Alice').currentKills).toBe(0);
    expect(rowFor(newLife, 'Alice').allTimeKills).toBe(15);

    bridge.run(`Alice.kills = 3`);
    const afterNewLifeKills = bridge.callHandler('getLeaderboard');
    expect(rowFor(afterNewLifeKills, 'Alice').allTimeKills).toBe(18);

    bridge.run(`
  CurrentPlayers = {}
  function CurrentPlayers:size() return 0 end
  function CurrentPlayers:get(i) return nil end
  `);
    const offline = bridge.callHandler('getLeaderboard');
    expect(rowFor(offline, 'Alice').online).toBe(false);
    expect(rowFor(offline, 'Alice').allTimeKills).toBe(18);
    expect(offline.data.trackingStartedAt).toBe(1000);
  });

  it('records deaths and favorite weapon through native event hooks', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.callHandler('getLeaderboard');
    bridge.run(`OnPlayerDeathHandler(Alice); OnZombieDeadHandler(Zombie)`);

    const result = bridge.callHandler('getLeaderboard');
    const alice = rowFor(result, 'Alice');
    expect(alice.deaths).toBe(1);
    expect(alice.favoriteWeapon).toBe('Axe');
    expect(alice.favoriteWeaponKills).toBe(1);
  });

  it('returns a clean empty result when no players have ever connected', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS + `
CurrentPlayers = {}
function CurrentPlayers:size() return 0 end
function CurrentPlayers:get(i) return nil end
`);
    const result = bridge.callHandler('getLeaderboard');
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(Object.keys(result.data.players)).toHaveLength(0);
  });
});