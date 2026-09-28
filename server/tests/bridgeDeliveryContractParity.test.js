import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as serverContract from "../services/bridgeDeliveryContract.js";

// The PanelBridge delivery contract lives twice: client/src/lib/
// bridgeDeliveryTypes.ts (what the client renders and validates against)
// and server/services/bridgeDeliveryContract.js (what the server emits).
// Nothing compiles one against the other, so a state, reason or warning
// added on one side only would reach the client as an unknown value -- the
// block rejects the whole status as an unexpected response. This pins the
// two files to the same names, values and order (spec §10.5).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const TS_CONTRACT = path.join(repoRoot, "client", "src", "lib", "bridgeDeliveryTypes.ts");

function parseTsContract(source) {
  const constants = {};
  // `export const NAME = [ 'a', 'b', ... ] as const`
  for (const match of source.matchAll(/export const (\w+) = \[([\s\S]*?)\] as const/g)) {
    const items = [...match[2].matchAll(/'([^']*)'/g)].map((item) => item[1]);
    // Anything between the brackets that isn't a quoted string or a comma
    // (a spread, a computed value) would make this parse lie; refuse it.
    const leftover = match[2].replace(/'[^']*'/g, "").replace(/[\s,]/g, "");
    if (leftover) throw new Error(`${match[1]}: unexpected tokens in the array: ${leftover}`);
    constants[match[1]] = items;
  }
  // `export const NAME = 'value'`
  for (const match of source.matchAll(/export const (\w+) = '([^']*)'\s*$/gm)) {
    constants[match[1]] = match[2];
  }
  return constants;
}

const tsConstants = parseTsContract(fs.readFileSync(TS_CONTRACT, "utf8"));

describe("PanelBridge delivery contract: client types and server mirror", () => {
  it("parses every exported constant out of the TypeScript contract", () => {
    expect(Object.keys(tsConstants).sort()).toEqual([
      "BRIDGE_MOD_ID",
      "CHECKSUM_BLOCKERS",
      "DELIVERY_BLOCK_REASONS",
      "DELIVERY_METHODS",
      "DELIVERY_STATES",
      "DELIVERY_WARNINGS",
      "LOOSE_FILE_KINDS",
    ]);
    // Guards the regex itself: a TS edit that changes the declaration shape
    // must not silently parse to an empty array.
    for (const [name, value] of Object.entries(tsConstants)) {
      if (Array.isArray(value)) expect(value.length, name).toBeGreaterThan(0);
    }
  });

  it("exports the same constant names on both sides", () => {
    expect(Object.keys(serverContract).sort()).toEqual(Object.keys(tsConstants).sort());
  });

  it.each(Object.keys(tsConstants))("%s has the same values in the same order", (name) => {
    const serverValue = serverContract[name];
    const tsValue = tsConstants[name];
    if (Array.isArray(tsValue)) {
      expect([...serverValue]).toEqual(tsValue);
      expect(new Set(tsValue).size, `${name} has duplicates`).toBe(tsValue.length);
    } else {
      expect(serverValue).toBe(tsValue);
    }
  });

  it("freezes the server's arrays so no module can change the contract at runtime", () => {
    for (const [name, value] of Object.entries(serverContract)) {
      if (Array.isArray(value)) expect(Object.isFrozen(value), name).toBe(true);
    }
  });
});

describe("PanelBridge mod id: one value everywhere it is written down", () => {
  // The id is permanent once the Workshop item is published, and a mismatch
  // anywhere means Mods= names a mod nobody ships (every join then fails
  // with ModRequired) or the bridge can't recognise its own delivery.
  const id = tsConstants.BRIDGE_MOD_ID;

  it("published.json carries it", () => {
    const published = JSON.parse(fs.readFileSync(path.join(repoRoot, "pz-mod", "workshop", "published.json"), "utf8"));
    expect(published.modId).toBe(id);
  });

  it("the Workshop mod.info declares it", () => {
    const modInfo = fs.readFileSync(path.join(repoRoot, "pz-mod", "PanelBridge", "mod.info"), "utf8");
    expect(modInfo.split(/\r?\n/).map((line) => line.trim())).toContain(`id=${id}`);
  });

  it("the Lua bridge detects its delivery by it", () => {
    const lua = fs.readFileSync(
      path.join(repoRoot, "pz-mod", "PanelBridge", "media", "lua", "server", "PanelBridge.lua"),
      "utf8",
    );
    expect(lua).toContain(`MOD_ID = "${id}"`);
  });
});
