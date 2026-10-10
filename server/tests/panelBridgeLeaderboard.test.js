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

const ALICE_KEY = 'steam:76561198000000001';

// Players come from makePlayer, so a respawn can be a new object with the
// same account (the server lists the dead IsoPlayer until its owner
// respawns, then a new one). Cow is an IsoAnimal: on Build 42 it extends
// IsoPlayer, and the IsoPlayer constructor names it "Bob".
const STUBS = `
Now = 1000
function getTimestampMs() return Now end
getServerName = function() return "TestServer" end
FILES = {}
getFileWriter = function(path)
  local writer = { value = "" }
  function writer:write(text) self.value = self.value .. text end
  function writer:close() FILES[path] = self.value end
  return writer
end
ModData = { stores = {} }
function ModData.getOrCreate(key)
  if not ModData.stores[key] then ModData.stores[key] = { players = {} } end
  return ModData.stores[key]
end

Events.OnCharacterDeath = { Add = function(fn) OnCharacterDeathHandler = fn end }
Events.OnZombieDead = { Add = function(fn) OnZombieDeadHandler = fn end }

PLAYER_OBJECTS = {}
ANIMALS = {}
instanceof = function(obj, class)
  if obj == nil then return false end
  if class == "IsoPlayer" then return PLAYER_OBJECTS[obj] == true end
  if class == "IsoAnimal" then return ANIMALS[obj] == true end
  return false
end

function makePlayer(username, steamId, kills, hours)
  local p = { username = username, steamId = steamId, kills = kills, hours = hours, dead = false }
  function p:getUsername() return self.username end
  function p:getDisplayName() return self.username .. " Survivor" end
  function p:getSteamID() return self.steamId end
  function p:getZombieKills() return self.kills end
  function p:getHoursSurvived() return self.hours end
  function p:isDead() return self.dead end
  function p:getAttackedBy() return self.attacker end
  function p:getPrimaryHandItem() return Weapon end
  function p:getSecondaryHandItem() return nil end
  PLAYER_OBJECTS[p] = true
  return p
end

Alice = makePlayer("Alice", "76561198000000001", 12, 48)
Bob = makePlayer("Bob", "76561198000000002", 5, 24)
Cow = makePlayer("Bob", 0, 0, 10)
ANIMALS[Cow] = true

ZombieAttacker = Alice
Zombie = {}
function Zombie:isZombie() return true end
function Zombie:getAttackedBy() return ZombieAttacker end
Weapon = {}
function Weapon:getDisplayName() return "Axe" end

function setOnline(list)
  CurrentPlayers = list
  function CurrentPlayers:size() return #self end
  function CurrentPlayers:get(i) return self[i + 1] end
end
setOnline({ Alice, Bob })
getOnlinePlayers = function() return CurrentPlayers end
`;

function rowFor(result, username) {
  expect(result.ok).toBe(true);
  return result.data.players.find((player) => player.username === username);
}

// The store's own row, read without going through getLeaderboard (which
// would read the online players itself).
function storeRow(bridge, key) {
  bridge.run(`
local store = PanelBridgeModule.leaderboardStore
STORE_ROW = store and store.players[${JSON.stringify(key)}] or nil
`);
  return bridge.getGlobal('STORE_ROW');
}

function tickAt(bridge, now) {
  bridge.run(`Now = ${now}; PanelBridgeModule.onTick()`);
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

    // A new life the bridge never saw die: the counter went down.
    bridge.run(`Alice.kills = 0; Alice.hours = 1`);
    const newLife = bridge.callHandler('getLeaderboard');
    expect(rowFor(newLife, 'Alice').currentKills).toBe(0);
    expect(rowFor(newLife, 'Alice').allTimeKills).toBe(15);

    bridge.run(`Alice.kills = 3`);
    const afterNewLifeKills = bridge.callHandler('getLeaderboard');
    expect(rowFor(afterNewLifeKills, 'Alice').allTimeKills).toBe(18);

    bridge.run(`setOnline({})`);
    const offline = bridge.callHandler('getLeaderboard');
    expect(rowFor(offline, 'Alice').online).toBe(false);
    expect(rowFor(offline, 'Alice').allTimeKills).toBe(18);
    expect(offline.data.trackingStartedAt).toBe(1000);
  });

  it('records deaths and favorite weapon through native event hooks', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.callHandler('getLeaderboard');
    bridge.run(`OnCharacterDeathHandler(Alice); OnZombieDeadHandler(Zombie)`);

    const result = bridge.callHandler('getLeaderboard');
    const alice = rowFor(result, 'Alice');
    expect(alice.deaths).toBe(1);
    expect(alice.favoriteWeapon).toBe('Axe');
    expect(alice.favoriteWeaponKills).toBe(1);
    // The body is still connected until its owner respawns.
    expect(alice.online).toBe(true);
  });

  it('returns a clean empty result when no players have ever connected', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS + `
setOnline({})
`);
    const result = bridge.callHandler('getLeaderboard');
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(Object.keys(result.data.players)).toHaveLength(0);
  });
});

describe('PanelBridge leaderboard sweep (players nobody is watching)', () => {
  it('reads every online player from the tick once a minute, with no panel read', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    tickAt(bridge, 70000);
    expect(storeRow(bridge, ALICE_KEY)).toEqual(expect.objectContaining({
      currentKills: 12,
      allTimeKills: 12,
      currentDays: 2,
      lastSampledAt: 70000,
      lastSampleSource: 'sweep',
    }));
    expect(storeRow(bridge, 'steam:76561198000000002').allTimeKills).toBe(5);

    bridge.run('Alice.kills = 20');
    tickAt(bridge, 129999);
    expect(storeRow(bridge, ALICE_KEY).allTimeKills).toBe(12);

    tickAt(bridge, 130000);
    expect(storeRow(bridge, ALICE_KEY)).toEqual(expect.objectContaining({
      allTimeKills: 20,
      lastSampledAt: 130000,
    }));

    // What the sweep read goes out with the same tick's flush.
    const files = bridge.getGlobal('FILES');
    const saved = Object.values(files).map((text) => JSON.parse(text))
      .reduce((newest, copy) => (copy.flushSeq > newest.flushSeq ? copy : newest));
    expect(saved.flushSeq).toBe(2);
    expect(saved.players[ALICE_KEY].allTimeKills).toBe(20);
  });

  it('reports the sweep in the getLeaderboard diagnostics', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const before = bridge.callHandler('getLeaderboard');
    expect(before.data.diagnostics).toEqual(expect.objectContaining({
      bridgeVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      sweepIntervalMs: 60000,
      sweepCount: 0,
      loadedFrom: 'new',
    }));
    expect(before.data.diagnostics.lastSweepAt ?? null).toBeNull();

    tickAt(bridge, 5000);
    tickAt(bridge, 65000);
    const after = bridge.callHandler('getLeaderboard', { source: 'page' });
    expect(after.data.diagnostics).toEqual(expect.objectContaining({
      lastSweepAt: 65000,
      sweepCount: 2,
      lastSweepPlayers: 2,
    }));
    expect(rowFor(after, 'Alice')).toEqual(expect.objectContaining({
      lastSampledAt: 65000,
      lastSampleSource: 'page',
      everRead: true,
      awaitingNewLife: false,
    }));
  });

  it('names a read by who asked, and anything unknown "panel"', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    expect(rowFor(bridge.callHandler('getLeaderboard', { source: 'sampler' }), 'Alice').lastSampleSource).toBe('sampler');
    bridge.run('PanelBridgeModule.handlers.getLeaderboard({ source = "<script>" })');
    expect(storeRow(bridge, ALICE_KEY).lastSampleSource).toBe('panel');
    bridge.run('PanelBridgeModule.handlers.getLeaderboard(nil)');
    expect(storeRow(bridge, ALICE_KEY).lastSampleSource).toBe('panel');
  });

  it('a zombie kill reads the killer, so an unwatched player gets their kills', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('Alice.kills = 13; OnZombieDeadHandler(Zombie)');
    expect(storeRow(bridge, ALICE_KEY)).toEqual(expect.objectContaining({
      currentKills: 13,
      allTimeKills: 13,
      currentDays: 2,
      favoriteWeapon: 'Axe',
      lastSampleSource: 'kill',
    }));
  });
});

describe('PanelBridge leaderboard deaths', () => {
  it('counts the dying life to its end, skips the body, and adds the whole next life', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('Alice.kills = 25');
    expect(rowFor(bridge.callHandler('getLeaderboard'), 'Alice').allTimeKills).toBe(25);

    // Three kills nobody read, then the death.
    bridge.run('Alice.kills = 28; Alice.hours = 72; OnCharacterDeathHandler(Alice)');
    expect(storeRow(bridge, ALICE_KEY)).toEqual(expect.objectContaining({
      allTimeKills: 28,
      deaths: 1,
      currentKills: 0,
      currentDays: 0,
      bestDays: 3,
      awaitingNewLife: true,
      lastSampleSource: 'death',
    }));

    // The body stays listed (isDead() not true yet) until the respawn:
    // neither a panel read nor the sweep reads it again.
    const whileDead = bridge.callHandler('getLeaderboard');
    expect(rowFor(whileDead, 'Alice')).toEqual(expect.objectContaining({
      allTimeKills: 28, currentKills: 0, deaths: 1, online: true, awaitingNewLife: true,
    }));
    tickAt(bridge, 100000);
    expect(storeRow(bridge, ALICE_KEY).allTimeKills).toBe(28);

    // The respawn is a new object; its first read adds every kill it has.
    bridge.run(`
AliceAgain = makePlayer("Alice", "76561198000000001", 30, 5)
setOnline({ AliceAgain, Bob })
`);
    const respawned = rowFor(bridge.callHandler('getLeaderboard'), 'Alice');
    expect(respawned).toEqual(expect.objectContaining({
      allTimeKills: 58, currentKills: 30, deaths: 1, awaitingNewLife: false,
    }));
    bridge.run('AliceAgain.kills = 32');
    expect(rowFor(bridge.callHandler('getLeaderboard'), 'Alice').allTimeKills).toBe(60);
  });

  it('counts a repeated death event for the same body once', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.callHandler('getLeaderboard');
    bridge.run('Alice.kills = 28; OnCharacterDeathHandler(Alice); OnCharacterDeathHandler(Alice)');
    expect(storeRow(bridge, ALICE_KEY)).toEqual(expect.objectContaining({ allTimeKills: 28, deaths: 1 }));

    bridge.run(`
AliceAgain = makePlayer("Alice", "76561198000000001", 5, 1)
setOnline({ AliceAgain })
`);
    expect(rowFor(bridge.callHandler('getLeaderboard'), 'Alice').allTimeKills).toBe(33);
  });

  it('lets go of a counted body once its owner has left, and a dead reconnect is still not read', () => {
    // The body was kept until a restart for a player who quit at the death
    // screen and never came back.
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    const keepsBody = () => {
      // Bodies are followed per account, not per SteamID.
      bridge.run(`KEEPS_BODY = PanelBridgeModule.leaderboardDeadPlayers[${JSON.stringify(`${ALICE_KEY}|alice`)}] ~= nil`);
      return bridge.getGlobal('KEEPS_BODY');
    };
    bridge.callHandler('getLeaderboard');
    bridge.run('Alice.kills = 28; OnCharacterDeathHandler(Alice); Alice.dead = true');
    tickAt(bridge, 70000);
    expect(keepsBody()).toBe(true);

    bridge.run('setOnline({ Bob })');
    tickAt(bridge, 140000);
    expect(keepsBody()).toBe(false);

    // A reconnect loads a new IsoPlayer, dead until the respawn.
    bridge.run(`
AliceBack = makePlayer("Alice", "76561198000000001", 0, 0)
AliceBack.dead = true
setOnline({ AliceBack, Bob })
`);
    tickAt(bridge, 210000);
    expect(rowFor(bridge.callHandler('getLeaderboard'), 'Alice')).toEqual(expect.objectContaining({
      allTimeKills: 28, deaths: 1, awaitingNewLife: true, online: true, lastSampleSource: 'death',
    }));

    bridge.run('AliceBack.dead = false; AliceBack.kills = 4');
    expect(rowFor(bridge.callHandler('getLeaderboard'), 'Alice')).toEqual(expect.objectContaining({
      allTimeKills: 32, deaths: 1, awaitingNewLife: false,
    }));
  });

  it('never reads a listed player whose character is dead', () => {
    // The death event never reached the bridge (it loaded late, or the
    // event errored): isDead() alone keeps the body out.
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.callHandler('getLeaderboard');
    bridge.run('Alice.kills = 40; Alice.dead = true');
    tickAt(bridge, 1000);
    const result = bridge.callHandler('getLeaderboard');
    expect(rowFor(result, 'Alice')).toEqual(expect.objectContaining({ allTimeKills: 12, online: true }));
  });
});

describe('PanelBridge leaderboard and animals', () => {
  it('an animal death adds no row and no status.json death', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('OnCharacterDeathHandler(Cow)');
    bridge.run('DEATH_COUNT = #PanelBridgeModule.recentDeaths');
    expect(bridge.getGlobal('DEATH_COUNT')).toBe(0);
    const result = bridge.callHandler('getLeaderboard');
    expect(result.data.players.map((player) => player.id).sort()).toEqual([ALICE_KEY, 'steam:76561198000000002']);
    expect(rowFor(result, 'Bob').deaths).toBe(0);
  });

  it('an animal that kills a zombie, or is listed online, gets no row', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('ZombieAttacker = Cow; OnZombieDeadHandler(Zombie); setOnline({ Alice, Cow })');
    const result = bridge.callHandler('getLeaderboard');
    expect(result.data.players.map((player) => player.id)).toEqual([ALICE_KEY]);
  });

  it('a player an animal kills is not a PvP death', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('Alice.attacker = Cow; OnCharacterDeathHandler(Alice); Bob.attacker = Alice; OnCharacterDeathHandler(Bob)');
    bridge.run('DEATHS = PanelBridgeModule.recentDeaths');
    expect(bridge.getGlobal('DEATHS').map(({ username, pvp }) => ({ username, pvp }))).toEqual([
      { username: 'Alice', pvp: false },
      { username: 'Bob', pvp: true },
    ]);
  });
});

// A SteamID is not one account: split-screen guests report the host's, alts
// can share a Steam account, and two SteamID64s can collapse to the same
// double. The row keeps one kill baseline, so two names on it used to add the
// difference of their kill counters to all-time kills on every switch.
const ALT_KEY = `${ALICE_KEY}|alicealt`;
const GUEST_KEY = `${ALICE_KEY}|guest`;

function rowById(result, id) {
  expect(result.ok).toBe(true);
  return result.data.players.find((player) => player.id === id);
}

// A store a previous session left in the bridge folder (what the sweep loads).
const SAVED_STORE_FILE = 'panelbridge/TestServer/leaderboard.json.txt';
function savedStoreStubs(players) {
  const store = { version: 2, worldId: 'saved-world', trackingStartedAt: 500, flushSeq: 1, players, complete: true };
  return `${STUBS}
ModData.stores.PanelBridgeLeaderboardWorld = { id = "saved-world" }
FILES[${JSON.stringify(SAVED_STORE_FILE)}] = [==[${JSON.stringify(store)}]==]
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
`;
}

describe('PanelBridge leaderboard accounts that share a SteamID', () => {
  it('gives a second account on one SteamID its own row, so switching adds nothing', () => {
    const bridge = loadPanelBridge(LUA_PATH, `${STUBS}
Alice.kills = 500
AliceAlt = makePlayer("AliceAlt", "76561198000000001", 20, 10)
setOnline({ Alice })
`);
    bridge.callHandler('getLeaderboard');
    for (let round = 0; round < 3; round += 1) {
      bridge.run('setOnline({ AliceAlt })');
      bridge.callHandler('getLeaderboard');
      bridge.run('setOnline({ Alice })');
      bridge.callHandler('getLeaderboard');
    }

    const result = bridge.callHandler('getLeaderboard');
    expect(result.data.players.map((player) => player.id).sort()).toEqual([ALICE_KEY, ALT_KEY]);
    expect(rowById(result, ALICE_KEY)).toEqual(expect.objectContaining({
      username: 'Alice', allTimeKills: 500, currentKills: 500, online: true,
    }));
    expect(rowById(result, ALT_KEY)).toEqual(expect.objectContaining({
      username: 'AliceAlt', allTimeKills: 20, currentKills: 20, online: false,
    }));
    expect(rowById(result, ALICE_KEY).aliases ?? null).toBeNull();
    expect(rowById(result, ALT_KEY).aliases ?? null).toBeNull();

    // Each account's own kills still count, on its own row.
    bridge.run('Alice.kills = 503; AliceAlt.kills = 24; setOnline({ Alice, AliceAlt })');
    const later = bridge.callHandler('getLeaderboard');
    expect(rowById(later, ALICE_KEY).allTimeKills).toBe(503);
    expect(rowById(later, ALT_KEY).allTimeKills).toBe(24);
  });

  it('keeps a co-op host and guest apart, with no gain from the sweep', () => {
    const bridge = loadPanelBridge(LUA_PATH, `${STUBS}
Alice.kills = 100
Guest = makePlayer("Guest", "76561198000000001", 5, 1)
setOnline({ Alice, Guest })
`);
    tickAt(bridge, 70000);
    for (const now of [130000, 190000, 250000]) tickAt(bridge, now);
    expect(storeRow(bridge, ALICE_KEY)).toEqual(expect.objectContaining({
      username: 'Alice', currentKills: 100, allTimeKills: 100,
    }));
    expect(storeRow(bridge, GUEST_KEY)).toEqual(expect.objectContaining({
      username: 'Guest', currentKills: 5, allTimeKills: 5,
    }));

    // Kills each account really makes land on its own row.
    bridge.run('Alice.kills = 103; Guest.kills = 6');
    tickAt(bridge, 310000);
    expect(storeRow(bridge, ALICE_KEY).allTimeKills).toBe(103);
    expect(storeRow(bridge, GUEST_KEY).allTimeKills).toBe(6);

    // And so do a kill's weapon and a death.
    bridge.run('ZombieAttacker = Guest; Guest.kills = 7; OnZombieDeadHandler(Zombie)');
    bridge.run('Guest.kills = 9; OnCharacterDeathHandler(Guest)');
    expect(storeRow(bridge, GUEST_KEY)).toEqual(expect.objectContaining({
      allTimeKills: 9, deaths: 1, favoriteWeapon: 'Axe', favoriteWeaponKills: 1, awaitingNewLife: true,
    }));
    expect(storeRow(bridge, ALICE_KEY)).toEqual(expect.objectContaining({
      allTimeKills: 103, deaths: 0, favoriteWeaponKills: 0,
    }));

    // The guest's body is still connected until the respawn: its own row shows online.
    const whileDead = bridge.callHandler('getLeaderboard');
    expect(rowById(whileDead, GUEST_KEY)).toEqual(expect.objectContaining({ online: true, deaths: 1, allTimeKills: 9 }));
    expect(rowById(whileDead, ALICE_KEY)).toEqual(expect.objectContaining({ online: true, allTimeKills: 103 }));
  });

  it('keeps a row that already merged names under its key and starts the other names apart', () => {
    // Saved by 1.7.74 or older after Alice and AliceAlt shared the row: the
    // totals are the merged pile and the name is the last one seen.
    const merged = {
      username: 'AliceAlt', displayName: 'AliceAlt Survivor',
      currentKills: 20, allTimeKills: 530, currentDays: 0.4, bestDays: 2,
      deaths: 2, favoriteWeaponKills: 0, weaponKills: {},
      lastObservedKills: 20, aliases: ['alice'], lastSeenAt: 900,
    };
    const bridge = loadPanelBridge(LUA_PATH, `${savedStoreStubs({ [ALICE_KEY]: merged })}
Alice.kills = 500
AliceAlt = makePlayer("AliceAlt", "76561198000000001", 20, 10)
setOnline({ AliceAlt })
`);
    // The name the row holds carries on with it, with no jump.
    let result = bridge.callHandler('getLeaderboard');
    expect(result.data.diagnostics.loadedFrom).not.toBe('new');
    expect(rowById(result, ALICE_KEY)).toEqual(expect.objectContaining({
      username: 'AliceAlt', allTimeKills: 530, deaths: 2, aliases: ['alice'], online: true,
    }));

    // The other name gets a row of its own; the merged row is not touched by it.
    for (let round = 0; round < 3; round += 1) {
      bridge.run('setOnline({ Alice })');
      result = bridge.callHandler('getLeaderboard');
      bridge.run('setOnline({ AliceAlt })');
      result = bridge.callHandler('getLeaderboard');
    }
    expect(result.data.players.map((player) => player.id).sort()).toEqual([ALICE_KEY, `${ALICE_KEY}|alice`]);
    expect(rowById(result, ALICE_KEY)).toEqual(expect.objectContaining({
      username: 'AliceAlt', allTimeKills: 530, currentKills: 20, aliases: ['alice'],
    }));
    expect(rowById(result, `${ALICE_KEY}|alice`)).toEqual(expect.objectContaining({
      username: 'Alice', allTimeKills: 500, currentKills: 500, online: false,
    }));

    // The sweep finds both, and a dead body is matched to the row it belongs to.
    bridge.run('setOnline({ Alice, AliceAlt })');
    tickAt(bridge, 70000);
    expect(storeRow(bridge, ALICE_KEY).allTimeKills).toBe(530);
    expect(storeRow(bridge, `${ALICE_KEY}|alice`).allTimeKills).toBe(500);
    bridge.run('OnCharacterDeathHandler(Alice)');
    const whileDead = bridge.callHandler('getLeaderboard');
    expect(rowById(whileDead, `${ALICE_KEY}|alice`)).toEqual(expect.objectContaining({ deaths: 1, online: true }));
    expect(rowById(whileDead, ALICE_KEY)).toEqual(expect.objectContaining({ deaths: 2, online: true }));
  });

  it('keeps one row for one account across relogs, respawns and a change of case', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.callHandler('getLeaderboard');
    bridge.run('setOnline({ Bob })');
    bridge.callHandler('getLeaderboard');

    // Back as a new object (a reconnect), with kills made elsewhere.
    bridge.run(`
AliceAgain = makePlayer("Alice", "76561198000000001", 20, 60)
setOnline({ AliceAgain, Bob })
`);
    let result = bridge.callHandler('getLeaderboard');
    expect(result.data.players.map((player) => player.id).sort()).toEqual([ALICE_KEY, 'steam:76561198000000002']);
    expect(rowById(result, ALICE_KEY)).toEqual(expect.objectContaining({
      username: 'Alice', allTimeKills: 20, currentKills: 20, online: true,
    }));
    expect(rowById(result, ALICE_KEY).aliases ?? null).toBeNull();

    // A name typed in another case is the same account.
    bridge.run('AliceAgain.username = "ALICE"; AliceAgain.kills = 22');
    result = bridge.callHandler('getLeaderboard');
    expect(result.data.players.map((player) => player.id).sort()).toEqual([ALICE_KEY, 'steam:76561198000000002']);
    expect(rowById(result, ALICE_KEY)).toEqual(expect.objectContaining({ username: 'ALICE', allTimeKills: 22 }));
  });

  it('keeps accounts without a SteamID apart by name, as before', () => {
    const bridge = loadPanelBridge(LUA_PATH, `${STUBS}
Dan = makePlayer("Dan", "0", 4, 1)
Eve = makePlayer("Eve", "0", 9, 1)
setOnline({ Dan, Eve })
`);
    const result = bridge.callHandler('getLeaderboard');
    expect(result.data.players.map((player) => player.id).sort()).toEqual(['name:dan', 'name:eve']);
    expect(rowById(result, 'name:dan').allTimeKills).toBe(4);
    expect(rowById(result, 'name:eve').allTimeKills).toBe(9);
  });
});
