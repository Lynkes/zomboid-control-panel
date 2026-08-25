import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage found while building the general verify/gate helper
// and its enforcement test: vehicleSetAlarm/SetSiren/SetTrunkLocked/SetFuel/
// SetBattery were listed in the original 96-handler audit as "pcall-checked
// at the call-didn't-throw ceiling, no cheap read-back exists" -- but
// handlers.getVehiclesDetailed was already reading isAlarmed/
// getLightbarSirenMode/isTrunkLocked/getRemainingFuelPercentage/
// getBatteryCharge for its own listing. Same shape as the safehouse/faction
// discovery: the read-back existed all along, just never reused to verify
// a mutation.

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

function vehicleStub({ sticks = true, alarmed = false, sirenMode = 0, trunkLocked = false, fuelPct = 50, batteryCharge = 50 } = {}) {
  return `
FakeVehicle = {
  id = 1,
  alarmed = ${alarmed},
  sirenMode = ${sirenMode},
  trunkLocked = ${trunkLocked},
  fuelPct = ${fuelPct},
  batteryCharge = ${batteryCharge},
  sticks = ${sticks},
}
function FakeVehicle:getId() return self.id end
function FakeVehicle:setAlarmed(v) if self.sticks then self.alarmed = v end end
function FakeVehicle:isAlarmed() return self.alarmed end
function FakeVehicle:triggerAlarm() end
function FakeVehicle:setLightbarSirenMode(v) if self.sticks then self.sirenMode = v end end
function FakeVehicle:getLightbarSirenMode() return self.sirenMode end
function FakeVehicle:setTrunkLocked(v) if self.sticks then self.trunkLocked = v end end
function FakeVehicle:isTrunkLocked() return self.trunkLocked end
function FakeVehicle:getPartById(id) return nil end
function FakeVehicle:setRemainingFuelPercentage(v) if self.sticks then self.fuelPct = v end end
function FakeVehicle:getRemainingFuelPercentage() return self.fuelPct end
function FakeVehicle:getBattery() return nil end
function FakeVehicle:setBatteryCharge(v) if self.sticks then self.batteryCharge = v end end
function FakeVehicle:getBatteryCharge() return self.batteryCharge end

FakeVehicleList = { FakeVehicle }
function FakeVehicleList:size() return 1 end
function FakeVehicleList:get(i) return self[i + 1] end

FakeCell = {}
function FakeCell:getVehicles() return FakeVehicleList end

FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
getWorld = function() return FakeWorld end
`;
}

describe('PanelBridge.lua vehicle setters -- gate on getVehiclesDetailed\'s own getters', () => {
  it('vehicleSetAlarm reports verified=true when isAlarmed confirms it', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetAlarm', { vehicleId: 1, enabled: true });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetAlarm must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false }));
    const result = bridge.callHandler('vehicleSetAlarm', { vehicleId: 1, enabled: true });
    expect(result.ok).toBe(false);
  });

  it('vehicleSetSiren reports verified=true when getLightbarSirenMode confirms it', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetSiren', { vehicleId: 1, mode: 2 });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetSiren must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false }));
    const result = bridge.callHandler('vehicleSetSiren', { vehicleId: 1, mode: 2 });
    expect(result.ok).toBe(false);
  });

  it('vehicleSetTrunkLocked reports verified=true when isTrunkLocked confirms it', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetTrunkLocked', { vehicleId: 1, locked: true });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetTrunkLocked must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false }));
    const result = bridge.callHandler('vehicleSetTrunkLocked', { vehicleId: 1, locked: true });
    expect(result.ok).toBe(false);
  });

  it('vehicleSetFuel reports verified=true when getRemainingFuelPercentage confirms it (within tolerance)', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetFuel', { vehicleId: 1, percent: 80 });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetFuel must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false, fuelPct: 20 }));
    const result = bridge.callHandler('vehicleSetFuel', { vehicleId: 1, percent: 80 });
    expect(result.ok).toBe(false);
  });

  it('vehicleSetBattery reports verified=true when getBatteryCharge confirms it (within tolerance)', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: true }));
    const result = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 90 });
    expect(result.ok).toBe(true);
    expect(result.data.verified).toBe('confirmed');
  });

  it('vehicleSetBattery must NOT report success when the write silently does not stick', () => {
    const bridge = loadPanelBridge(LUA_PATH, vehicleStub({ sticks: false, batteryCharge: 10 }));
    const result = bridge.callHandler('vehicleSetBattery', { vehicleId: 1, charge: 90 });
    expect(result.ok).toBe(false);
  });
});
