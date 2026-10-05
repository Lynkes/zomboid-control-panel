import { describe, it, expect } from "vitest";
import fs from "fs";
import { fileURLToPath } from "url";
import { resolveAllCallSites } from "../../scripts/lib/engine-signature-core.mjs";

// GitHub #199: a 2026-08-30 hand audit ran `javap -p BaseVehicle`, which lists
// only the class's own methods, concluded getPartCount/getPartById/getBattery/
// getBatteryCharge/getLightbarSirenMode weren't on the vehicle, and moved the
// bridge onto vehicle:getParts() -- a VehicleParts object Lua can't call into.
// They are default methods of BaseVehicle's interfaces (VehiclePartOwner,
// VehicleSoundOwner). The engine-signature checker doesn't have that blind
// spot: gen-engine-signatures.mjs merges every superinterface's javap output
// into the class, so the committed manifest lists the defaults on BaseVehicle.
// This pins that, against the manifest check-engine-signatures.mjs reads,
// with the same classProvider it uses.

const manifestPath = fileURLToPath(new URL("../../scripts/engine-signatures.manifest.json", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function classProvider(className, methodName) {
  const info = manifest.classes[className];
  if (!info) return null;
  const sigs = info.methods[methodName];
  if (!sigs || sigs.length === 0) return { exists: false };
  return { exists: true, returnClass: sigs[0].returnClass, elementClass: sigs[0].elementClass };
}

const DEFAULTS_ON_THE_VEHICLE = [
  "getPartCount",
  "getPartByIndex",
  "getPartById",
  "getBattery",
  "getBatteryCharge",
  "getLightbarSirenMode",
];

describe("engine-signature manifest -- interface default methods count as present", () => {
  it("records BaseVehicle's interfaces, so their default methods are merged into it", () => {
    const vehicle = manifest.classes["zombie.vehicles.BaseVehicle"];
    expect(vehicle.declaredSuperclasses).toEqual(
      expect.arrayContaining(["zombie.vehicles.VehiclePartOwner", "zombie.vehicleSound.VehicleSoundOwner"]),
    );
    for (const name of DEFAULTS_ON_THE_VEHICLE) {
      expect(vehicle.methods[name], `BaseVehicle.${name}`).toBeTruthy();
    }
  });

  it("resolves the part accessors on a BaseVehicle receiver as present, and still flags real absences", () => {
    const src = `
local function f()
    local player = getPlayerByUsername("someone")
    local vehicle = player:getVehicle()
    vehicle:getPartCount()
    vehicle:getPartByIndex(0)
    PanelBridge.tryGet(vehicle, "getPartById", "GasTank")
    PanelBridge.invoke(vehicle, "getBattery")
    vehicle:getBatteryCharge()
    vehicle:getLightbarSirenMode()
    vehicle:repair()
    PanelBridge.invoke(vehicle, "setRemainingFuelPercentage", 50)
    PanelBridge.invoke(vehicle, "setBatteryCharge", 50)
end
`;
    const { callSites } = resolveAllCallSites(src, classProvider);
    const byMethod = new Map(callSites.map((site) => [site.methodName, site]));

    for (const name of [...DEFAULTS_ON_THE_VEHICLE, "repair"]) {
      const site = byMethod.get(name);
      expect(site?.receiverType, name).toBe("zombie.vehicles.BaseVehicle");
      expect(site.methodInfo?.exists, name).toBe(true);
    }
    // Absent from BaseVehicle and every interface it implements: still caught.
    for (const name of ["setRemainingFuelPercentage", "setBatteryCharge"]) {
      const site = byMethod.get(name);
      expect(site?.receiverType, name).toBe("zombie.vehicles.BaseVehicle");
      expect(site.methodInfo, name).toEqual({ exists: false });
    }
  });
});
