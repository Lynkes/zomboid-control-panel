import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const ITERATOR_COLLECTIONS = `
local function iteratorCollection(items)
  local collection = { items = items }
  function collection:size() return #self.items end
  function collection:iterator()
    local values = self.items
    local iterator = { index = 0 }
    function iterator:hasNext() return self.index < #values end
    function iterator:next()
      self.index = self.index + 1
      return values[self.index]
    end
    return iterator
  end
  return collection
end

FakeSafehouse = { id = "sh1", title = "Cabin" }
function FakeSafehouse:getId() return self.id end
function FakeSafehouse:getTitle() return self.title end
function FakeSafehouse:getPlayers()
  return iteratorCollection({ "Alice", "Bob" })
end
function FakeSafehouse:getOwner() return "Alice" end
function FakeSafehouse:getX() return 10 end
function FakeSafehouse:getY() return 20 end
function FakeSafehouse:getW() return 5 end
function FakeSafehouse:getH() return 6 end
function FakeSafehouse:getPlayerConnected() return 1 end
function FakeSafehouse:getLastVisited() return 0 end
SafeHouse = { getSafehouseList = function() return iteratorCollection({ FakeSafehouse }) end }

FakeFaction = { name = "Survivors", owner = "Alice", tag = "SURV" }
function FakeFaction:getName() return self.name end
function FakeFaction:getOwner() return self.owner end
function FakeFaction:getTag() return self.tag end
function FakeFaction:getPlayers() return iteratorCollection({ "Alice", "Bob" }) end
Faction = { getFactions = function() return iteratorCollection({ FakeFaction }) end }
`;

const ITERATOR_CATALOGS = `
local function iteratorCollection(items)
  local collection = { items = items }
  function collection:size() return #self.items end
  function collection:iterator()
    local values = self.items
    local iterator = { index = 0 }
    function iterator:hasNext() return self.index < #values end
    function iterator:next()
      self.index = self.index + 1
      return values[self.index]
    end
    return iterator
  end
  return collection
end

FakeItem = {}
function FakeItem:getFullName() return "Base.Hammer" end
function FakeItem:getDisplayName() return "Hammer" end
function FakeItem:getDisplayCategory() return "Tools" end
function FakeItem:getActualWeight() return 1.5 end

FakeVehicleScript = {}
function FakeVehicleScript:getFullName() return "Base.Car" end
function FakeVehicleScript:getName() return "Car" end
function FakeVehicleScript:getMass() return 900 end
function FakeVehicleScript:getPassengerCount() return 4 end

FakeScriptManager = {}
function FakeScriptManager:getAllItems() return iteratorCollection({ FakeItem }) end
function FakeScriptManager:getAllVehicleScripts() return iteratorCollection({ FakeVehicleScript }) end
ScriptManager = { instance = FakeScriptManager }
`;

const ITERATOR_ZOMBIES = `
local function iteratorCollection(items)
  local collection = { items = items }
  function collection:size() return #self.items end
  function collection:iterator()
    local values = self.items
    local iterator = { index = 0 }
    function iterator:hasNext() return self.index < #values end
    function iterator:next()
      self.index = self.index + 1
      return values[self.index]
    end
    return iterator
  end
  return collection
end

FakePlayer = { username = "Alice" }
function FakePlayer:getUsername() return self.username end
function FakePlayer:getX() return 0 end
function FakePlayer:getY() return 0 end
function FakePlayer:getZ() return 0 end

FakeNearZombie = { x = 3, y = 4, z = 0, removed = false }
function FakeNearZombie:getX() return self.x end
function FakeNearZombie:getY() return self.y end
function FakeNearZombie:getZ() return self.z end
function FakeNearZombie:removeFromSquare() self.removed = true end
function FakeNearZombie:removeFromWorld() end

FakeFarZombie = { x = 100, y = 100, z = 0, removed = false }
function FakeFarZombie:getX() return self.x end
function FakeFarZombie:getY() return self.y end
function FakeFarZombie:getZ() return self.z end
function FakeFarZombie:removeFromSquare() self.removed = true end
function FakeFarZombie:removeFromWorld() end

FakeZombieList = iteratorCollection({ FakeNearZombie, FakeFarZombie })
FakeCell = {}
function FakeCell:getZombieList() return FakeZombieList end
FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
FakeWorld = FakeWorld
getWorld = function() return FakeWorld end
getOnlinePlayers = function() return iteratorCollection({ FakePlayer }) end
`;

describe('PanelBridge.lua safehouse/faction collection traversal', () => {
  it('reads iterator-only safehouse and nested player collections', () => {
    const bridge = loadPanelBridge(LUA_PATH, ITERATOR_COLLECTIONS);
    const result = bridge.callHandler('getSafehouses', {});

    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(1);
    expect(result.data.safehouses[0].players).toEqual(['Alice', 'Bob']);
  });

  it('reads iterator-only faction and nested player collections', () => {
    const bridge = loadPanelBridge(LUA_PATH, ITERATOR_COLLECTIONS);
    const result = bridge.callHandler('getFactions', {});

    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(1);
    expect(result.data.factions[0].players).toEqual(['Alice', 'Bob']);
  });

  it('reads iterator-only item and vehicle script catalogs', () => {
    const bridge = loadPanelBridge(LUA_PATH, ITERATOR_CATALOGS);

    const items = bridge.callHandler('getItemCatalog', {});
    const vehicles = bridge.callHandler('getVehicleCatalog', {});

    expect(items.ok).toBe(true);
    expect(items.data.count).toBe(1);
    expect(items.data.items[0].id).toBe('Base.Hammer');
    expect(vehicles.ok).toBe(true);
    expect(vehicles.data.count).toBe(1);
    expect(vehicles.data.vehicles[0].id).toBe('Base.Car');
    expect(vehicles.data.vehicles[0].seats).toBe(4);
  });

  it('counts and clears iterator-only zombie collections', () => {
    const bridge = loadPanelBridge(LUA_PATH, ITERATOR_ZOMBIES);

    const count = bridge.callHandler('getZombieCount', {});
    const cleared = bridge.callHandler('clearZombiesNearPlayer', {
      username: 'Alice',
      radius: 10,
    });

    expect(count.ok).toBe(true);
    expect(count.data.zombieCount).toBe(2);
    expect(cleared.ok).toBe(true);
    expect(cleared.data.removed).toBe(1);
    expect(bridge.getGlobal('FakeNearZombie').removed).toBe(true);
    expect(bridge.getGlobal('FakeFarZombie').removed).toBe(false);
  });
});