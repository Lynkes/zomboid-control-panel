import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// #199: on Build 42 the vehicle handlers asked vehicle:getParts() for their
// parts. getParts() returns zombie.vehicles.VehicleParts, which
// LuaManager$Exposer doesn't expose (42.20 and 42.21 jars), so every call on
// it failed with "attempted index: getPartCount of non-table:
// zombie.vehicles.VehicleParts@..." and Repair reported "0 parts", Set Fuel
// "No fuel setter available". The accessors are default methods of
// zombie.vehicles.VehiclePartOwner, which BaseVehicle implements, so they are
// callable on the vehicle itself; vanilla Lua calls them there. The siren
// read had the same problem: LightbarSirenMode isn't exposed either, while
// getLightbarSirenMode() is a VehicleSoundOwner default on the vehicle.
//
// The fixture mirrors that shape with the harness's JavaObject: the vehicle
// is an exposed userdata carrying BaseVehicle's own methods plus those
// interface defaults, and getParts()/getLightbarSirenModeObject() return
// unexposed objects that raise Kahlua's "attempted index" error when indexed.

const source = fileURLToPath(new URL('../../pz-mod/PanelBridge/media/lua/server/PanelBridge.lua', import.meta.url));

const FIXTURE = `
VEH = { id = 1, sirenMode = 0, sirenSticks = true, alarmed = false, trunkLocked = true, repairCalls = 0, engineStarting = false }
TRANSMITS = {}
DOOR_STATE = { locked = true }
BATTERY_ITEM = { uses = 0.2, sticks = true }
PART_STATE = {}
PART_ORDER = {}

local door = JavaObject("zombie.vehicles.VehicleDoor", {
  isLocked = function(self) return DOOR_STATE.locked end,
  setLocked = function(self, locked) DOOR_STATE.locked = locked end,
})

-- DrainableComboItem: the battery's charge is its uses as a 0-1 fraction.
-- setCurrentUsesFloat clamps to 0-1 (javap -c, 42.21).
local function setUses(self, value)
  if BATTERY_ITEM.sticks then BATTERY_ITEM.uses = math.max(0, math.min(1, value)) end
end
BATTERY = JavaObject("zombie.inventory.types.DrainableComboItem", {
  getCurrentUsesFloat = function(self) return BATTERY_ITEM.uses end,
  setCurrentUsesFloat = setUses,
  setUsedDelta = setUses,
  getConditionMax = function(self) return 100 end,
  setCondition = function(self, value) end,
})

-- Every part shares one method set, like one Java class.
local function addPart(id, state)
  state.id = id
  PART_STATE[id] = state
  table.insert(PART_ORDER, id)
  state.object = JavaObject("zombie.vehicles.VehiclePart", {
    getId = function(self) return state.id end,
    getCondition = function(self) return state.condition end,
    -- VehiclePart.setCondition clamps to 0-100.
    setCondition = function(self, value) state.condition = math.max(0, math.min(100, value)) end,
    getInventoryItem = function(self) return state.item end,
    getMechanicSkillInstaller = function(self) return 0 end,
    doInventoryItemStats = function(self, item, skill) end,
    getDoor = function(self) return state.door end,
    getContainerCapacity = function(self) return state.capacity or 0 end,
    getContainerContentAmount = function(self) return state.amount or 0 end,
    setContainerContentAmount = function(self, value) state.amount = math.max(0, math.min(state.capacity or 0, value)) end,
  })
end
addPart("Engine", { condition = 5 })
addPart("DoorFrontLeft", { condition = 40, door = door })
addPart("GasTank", { condition = 70, capacity = 60, amount = 12 })
addPart("Battery", { condition = 90, item = BATTERY })

local function partObject(id)
  local state = id and PART_STATE[id]
  return state and state.object or nil
end

-- Not exposed to Lua: indexing either one raises Kahlua's error.
VEHICLE_PARTS = JavaObject("zombie.vehicles.VehicleParts", nil, { exposed = false })
SIREN_MODE_OBJECT = JavaObject("zombie.vehicles.LightbarSirenMode", nil, { exposed = false })

local function transmit(kind)
  return function(self, part) table.insert(TRANSMITS, kind) end
end

VEHICLE_METHODS = {
  -- BaseVehicle's own methods.
  getId = function(self) return VEH.id end,
  getX = function(self) return 100.5 end,
  getY = function(self) return 200.5 end,
  getZ = function(self) return 0 end,
  getScriptName = function(self) return "Base.91range2" end,
  getVehicleType = function(self) return "91range2" end,
  getCurrentSpeedKmHour = function(self) return 0 end,
  getParts = function(self) return VEHICLE_PARTS end,
  getLightbarSirenModeObject = function(self) return SIREN_MODE_OBJECT end,
  setLightbarSirenMode = function(self, mode) if VEH.sirenSticks then VEH.sirenMode = mode end end,
  isAlarmed = function(self) return VEH.alarmed end,
  setAlarmed = function(self, value) VEH.alarmed = value end,
  isTrunkLocked = function(self) return VEH.trunkLocked end,
  setTrunkLocked = function(self, value) VEH.trunkLocked = value end,
  -- GasTank content / capacity * 100, read through getPartById("GasTank").
  getRemainingFuelPercentage = function(self)
    local tank = PART_STATE.GasTank
    if not tank then return 0 end
    return tank.amount / tank.capacity * 100
  end,
  -- The game's own repair: VehiclePart.repair() on every part sets
  -- condition 100, fills containers and recharges a drainable item.
  repair = function(self)
    VEH.repairCalls = VEH.repairCalls + 1
    for _, id in ipairs(PART_ORDER) do
      local state = PART_STATE[id]
      state.condition = 100
      if state.capacity then state.amount = state.capacity end
      if state.item == BATTERY then BATTERY_ITEM.uses = 1 end
    end
  end,
  updatePartStats = function(self) end,
  updateBulletStats = function(self) end,
  transmitPartCondition = transmit("condition"),
  transmitPartItem = transmit("item"),
  transmitPartModData = transmit("modData"),
  transmitPartUsedDelta = transmit("usedDelta"),
  transmitPartDoor = transmit("door"),
  setHotwired = function(self, value) end,
  setHotwiredBroken = function(self, value) end,
  setKeysInIgnition = function(self, value) end,
  engineDoStarting = function(self) VEH.engineStarting = true end,

  -- VehiclePartOwner defaults (each forwards to getParts() in Java).
  getPartCount = function(self) return #PART_ORDER end,
  getPartByIndex = function(self, index) return partObject(PART_ORDER[index + 1]) end,
  getPartById = function(self, id) return partObject(id) end,
  getBattery = function(self) return partObject("Battery") end,
  getBatteryCharge = function(self)
    local battery = PART_STATE.Battery
    if battery and battery.item then return BATTERY_ITEM.uses end
    return 0
  end,
  -- VehicleSoundOwner default.
  getLightbarSirenMode = function(self) return VEH.sirenMode end,
}
-- IsoMovingObject overrides toString, so there's no @hash to strip.
FakeVehicle = JavaObject("zombie.vehicles.BaseVehicle", VEHICLE_METHODS, { toString = "BaseVehicle{ name:Base.91range2, id:1 }" })

-- A build without the VehiclePartOwner defaults, for the fallback tests.
function dropVehiclePartDefaults()
  for _, name in ipairs({ "getPartCount", "getPartByIndex", "getPartById", "getBattery", "getBatteryCharge" }) do
    VEHICLE_METHODS[name] = nil
  end
end

local vehicles = { FakeVehicle }
VEHICLE_LIST = JavaObject("java.util.HashSet", {
  size = function(self) return #vehicles end,
  iterator = function(self)
    local index = 0
    return JavaObject("java.util.HashMap$KeyIterator", {
      hasNext = function(self) return index < #vehicles end,
      next = function(self) index = index + 1; return vehicles[index] end,
    })
  end,
})
local cell = JavaObject("zombie.iso.IsoCell", { getVehicles = function(self) return VEHICLE_LIST end })
local world = JavaObject("zombie.iso.IsoWorld", { getCell = function(self) return cell end })
getWorld = function() return world end
`;

function load(extraLua = '') {
  return loadPanelBridge(source, FIXTURE + extraLua, { javaObjects: true });
}

// Lua array globals come back as JS arrays, except an empty one, which comes
// back as {}.
function list(bridge, name) {
  const value = bridge.getGlobal(name);
  return Array.isArray(value) ? value : [];
}

function partField(bridge, id, field) {
  bridge.run(`__PART_FIELD = PART_STATE[${JSON.stringify(id)}].${field}`);
  return bridge.getGlobal('__PART_FIELD');
}

describe('PanelBridge.lua vehicle handlers call the part accessors on the vehicle (#199)', () => {
  it('vehicleRepair runs the game\'s own vehicle:repair() and reads every part back at full condition', () => {
    const bridge = load();
    const result = bridge.callHandler('vehicleRepair', { vehicleId: 1 });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ message: 'Vehicle repaired', vehicleId: 1, parts: 4, partCount: 4, method: 'repair' });
    bridge.run('__REPAIR_CALLS = VEH.repairCalls');
    expect(bridge.getGlobal('__REPAIR_CALLS')).toBe(1);
    expect(partField(bridge, 'Engine', 'condition')).toBe(100);
    expect(list(bridge, 'JAVA_INDEX_ERRORS')).toEqual([]);
  });

  it('vehicleRepair falls back to a part-by-part repair through the vehicle when repair() is unavailable', () => {
    const bridge = load('VEHICLE_METHODS.repair = nil');
    const result = bridge.callHandler('vehicleRepair', { vehicleId: 1 });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ parts: 4, partCount: 4, method: 'parts' });
    expect(partField(bridge, 'Engine', 'condition')).toBe(100);
    expect(partField(bridge, 'DoorFrontLeft', 'condition')).toBe(100);
    expect(list(bridge, 'TRANSMITS')).toContain('condition');
    expect(list(bridge, 'JAVA_INDEX_ERRORS')).toEqual([]);
  });

  it('vehicleRepair\'s fallback still names a vehicle that really has 0 parts', () => {
    const bridge = load('VEHICLE_METHODS.repair = nil\nPART_ORDER = {}');
    const result = bridge.callHandler('vehicleRepair', { vehicleId: 1 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/reports 0 parts/);
  });

  it('vehicleRepair says the part count was unreadable instead of calling it 0 parts', () => {
    const bridge = load(`
VEHICLE_METHODS.repair = function(self) error("java.lang.NullPointerException") end
dropVehiclePartDefaults()
`);
    const result = bridge.callHandler('vehicleRepair', { vehicleId: 1 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/part count couldn't be read/);
    expect(result.err).not.toMatch(/0 parts/);
    // getParts() returned the unexposed VehicleParts; it was never indexed.
    expect(list(bridge, 'JAVA_INDEX_ERRORS')).toEqual([]);
  });

  it('vehicleSetFuel writes the GasTank it gets from vehicle:getPartById and confirms it', () => {
    const bridge = load();
    const result = bridge.callHandler('vehicleSetFuel', { vehicleId: 1, percent: 75 });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ percent: 75, verified: 'confirmed' });
    expect(partField(bridge, 'GasTank', 'amount')).toBe(45);
    expect(list(bridge, 'TRANSMITS')).toContain('modData');
    expect(list(bridge, 'JAVA_INDEX_ERRORS')).toEqual([]);
  });

  it('vehicleSetFuel names a missing GasTank instead of a bare "No fuel setter available"', () => {
    const bridge = load('PART_STATE.GasTank = nil');
    const result = bridge.callHandler('vehicleSetFuel', { vehicleId: 1, percent: 75 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/no GasTank part/);
  });

  it('vehicleSetBattery sets the battery item\'s charge directly and confirms it as a percentage', () => {
    // vanilla VehicleUtils.chargeBattery adds its delta twice (42.21): from
    // 0.8 down to 0.3 it would write -0.2, clamped to 0. The bridge must not
    // depend on it.
    const bridge = load(`
BATTERY_ITEM.uses = 0.8
VehicleUtils = {
  chargeBattery = function(vehicle, delta)
    local charge = BATTERY_ITEM.uses
    charge = math.max(charge + delta, 0.0)
    charge = math.min(charge + delta, 1.0)
    BATTERY_ITEM.uses = math.max(0, charge)
  end,
}
`);
    const result = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 30 });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ charge: 30, verified: 'confirmed' });
    bridge.run('__USES = BATTERY_ITEM.uses');
    expect(bridge.getGlobal('__USES')).toBeCloseTo(0.3, 5);
    expect(list(bridge, 'TRANSMITS')).toContain('usedDelta');
    expect(list(bridge, 'JAVA_INDEX_ERRORS')).toEqual([]);
  });

  it('vehicleSetBattery fails on its read-back when the charge does not stick', () => {
    const bridge = load('BATTERY_ITEM.sticks = false');
    const result = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 90 });

    expect(result.ok).toBe(false);
    // The 0.2 read back is reported as a percentage (Lua prints 20.0).
    expect(result.err).toMatch(/did not take effect \(still 20(\.0)?\)/);
  });

  it('vehicleSetBattery says no battery is installed when the battery part has no item', () => {
    const bridge = load('PART_STATE.Battery.item = nil');
    const result = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 90 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/no battery is installed/);
  });

  it('getVehiclesDetailed reads the battery charge and siren mode through the vehicle', () => {
    const bridge = load('VEH.sirenMode = 2');
    const result = bridge.callHandler('getVehiclesDetailed', {});

    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(1);
    const [vehicle] = result.data.vehicles;
    // The game's own 0-1 fraction, not a percentage.
    expect(vehicle.batteryCharge).toBeCloseTo(0.2, 5);
    expect(vehicle.fuelPct).toBe(20);
    expect(vehicle.sirening).toBe(true);
    expect(vehicle.trunkLocked).toBe(true);
    expect(list(bridge, 'JAVA_INDEX_ERRORS')).toEqual([]);
  });

  it('vehicleSetSiren confirms the mode with vehicle:getLightbarSirenMode()', () => {
    const bridge = load();
    const result = bridge.callHandler('vehicleSetSiren', { vehicleId: 1, mode: 2 });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ mode: 2, verified: 'confirmed' });
    expect(list(bridge, 'JAVA_INDEX_ERRORS')).toEqual([]);

    const stuck = load('VEH.sirenSticks = false');
    const stuckResult = stuck.callHandler('vehicleSetSiren', { vehicleId: 1, mode: 2 });
    expect(stuckResult.ok).toBe(false);
    expect(stuckResult.err).toMatch(/did not take effect/);
  });

  it('vehicleHotwire unlocks the doors and checks the engine through the vehicle', () => {
    const bridge = load();
    const result = bridge.callHandler('vehicleHotwire', { vehicleId: 1 });

    expect(result.ok).toBe(true);
    expect(result.data.actions).toEqual(expect.arrayContaining(['unlocked', 'engineCondRepaired', 'engineDoStarting']));
    bridge.run('__DOOR_LOCKED = DOOR_STATE.locked');
    expect(bridge.getGlobal('__DOOR_LOCKED')).toBe(false);
    expect(partField(bridge, 'Engine', 'condition')).toBe(20);
    expect(list(bridge, 'JAVA_INDEX_ERRORS')).toEqual([]);
  });

  it('vehicleHotwire sends the unlocked door and the engine condition, and calls no method B42 lacks', () => {
    const bridge = load(`
BOGUS_CALLS = {}
VEHICLE_METHODS.transmitVehicle = function(self) table.insert(BOGUS_CALLS, "transmitVehicle") end
VEHICLE_METHODS.updateFlags = function(self) table.insert(BOGUS_CALLS, "updateFlags") end
`);
    const result = bridge.callHandler('vehicleHotwire', { vehicleId: 1 });

    expect(result.ok).toBe(true);
    // Connected players otherwise keep seeing the door locked.
    expect(list(bridge, 'TRANSMITS')).toEqual(expect.arrayContaining(['door', 'condition']));
    expect(list(bridge, 'BOGUS_CALLS')).toEqual([]);
  });

  it('vehicleRepair fails when repair() ran but left no part at full condition', () => {
    const bridge = load('VEHICLE_METHODS.repair = function(self) VEH.repairCalls = VEH.repairCalls + 1 end');
    const result = bridge.callHandler('vehicleRepair', { vehicleId: 1 });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/none of the vehicle's 4 readable part\(s\) is at full condition/);
  });

  it('vehicleSetAlarm arms the alarm and leaves it armed', () => {
    // BaseVehicle.triggerAlarm() sounds the alarm and always sets alarmed
    // back to false (javap -c, 42.21); calling it after setAlarmed(true)
    // left every vehicle disarmed.
    const bridge = load(`
TRIGGERS = 0
VEHICLE_METHODS.triggerAlarm = function(self) TRIGGERS = TRIGGERS + 1; VEH.alarmed = false end
`);
    const result = bridge.callHandler('vehicleSetAlarm', { vehicleId: 1, enabled: true });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ enabled: true, verified: 'confirmed' });
    bridge.run('__ALARMED = VEH.alarmed; __TRIGGERS = TRIGGERS');
    expect(bridge.getGlobal('__ALARMED')).toBe(true);
    expect(bridge.getGlobal('__TRIGGERS')).toBe(0);

    const off = bridge.callHandler('vehicleSetAlarm', { vehicleId: 1, enabled: false });
    expect(off.ok).toBe(true);
    bridge.run('__ALARMED = VEH.alarmed');
    expect(bridge.getGlobal('__ALARMED')).toBe(false);
  });
});

describe('PanelBridge.lua getParts() fallback (#199)', () => {
  it('never indexes an unexposed VehicleParts when the vehicle lacks the accessors', () => {
    const bridge = load('dropVehiclePartDefaults()');

    const fuel = bridge.callHandler('vehicleSetFuel', { vehicleId: 1, percent: 75 });
    expect(fuel.ok).toBe(false);
    expect(fuel.err).toMatch(/no GasTank part/);

    const battery = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 90 });
    expect(battery.ok).toBe(false);
    expect(battery.err).toMatch(/no battery part/);

    const detailed = bridge.callHandler('getVehiclesDetailed', {});
    expect(detailed.ok).toBe(true);
    expect(detailed.data.vehicles[0].batteryCharge ?? null).toBeNull();

    expect(list(bridge, 'JAVA_INDEX_ERRORS')).toEqual([]);
  });

  it('uses getParts() when the build exposes what it returns', () => {
    const bridge = load(`
dropVehiclePartDefaults()
VEHICLE_PARTS = JavaObject("zombie.vehicles.VehicleParts", {
  getPartById = function(self, id) return PART_STATE[id] and PART_STATE[id].object or nil end,
})
`);
    const result = bridge.callHandler('vehicleSetFuel', { vehicleId: 1, percent: 50 });

    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
    expect(partField(bridge, 'GasTank', 'amount')).toBe(30);
  });
});
