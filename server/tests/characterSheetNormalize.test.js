import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it, vi } from "vitest";
import {
  CHARACTER_SHEET_LIMITS,
  fetchCharacterSheet,
  normalizeSheet,
  refreshIntervalsFor,
  sheetFromPlayerDetails,
} from "../services/characterSheet.js";
import { computeCharacterHints } from "../services/characterHints.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "characterSheetB2.json"), "utf8"));

function container(rows, extra = {}) {
  return { kind: "container", fullType: "Base.Bag_Schoolbag", name: "Bag", rows, ...extra };
}

function stack(fullType, extra = {}) {
  return { kind: "stack", fullType, name: fullType, qty: 1, ...extra };
}

describe("normalizeSheet (spec B2 shape)", () => {
  it("keeps every section of a full sheet and drops fields it doesn't know", () => {
    const sheet = normalizeSheet(fixture);
    expect(sheet).not.toHaveProperty("_about");
    expect(sheet.username).toBe("Kate");
    expect(sheet.role).toEqual({ name: "none", adminPower: false, canSpawnItems: false });
    expect(sheet.summary.profession).toEqual({ id: "base:carpenter", label: "Carpenter" });
    expect(sheet.summary.flags.godMode).toBe(false);
    expect(sheet.stats.hunger).toEqual({ value: 0.12, min: 0, max: 1 });
    expect(sheet.health).toEqual({ overall: 92, isInfected: false, numPartsBleeding: 0, isBleeding: false, temperature: 36.9 });
    expect(sheet.skills.categories).toHaveLength(7);
    expect(sheet.skills.perks.find((p) => p.id === "Woodwork")).toMatchObject({ level: 6, boost: 3, multiplier: 3 });
    expect(sheet.traits).toHaveLength(3);
    expect(sheet.inventory.root.rows).toHaveLength(4);
    expect(sheet.inventory.equipped.primary.fullType).toBe("Base.Hammer");
    expect(sheet.cost).toEqual({ ms: 4, walked: 7 });
    // The encoder's [] for an empty sectionErrors table is not an error.
    expect(sheet).not.toHaveProperty("sectionErrors");
  });

  it("turns [] into {} for object fields and leaves absent sections absent", () => {
    const sheet = normalizeSheet({ username: "A", summary: [], stats: [], health: [], skills: [], inventory: [] });
    expect(sheet.summary).toEqual({});
    expect(sheet.stats).toEqual({});
    expect(sheet.health).toEqual({});
    expect(sheet.skills).toEqual({ categories: [], perks: [] });
    expect(sheet.inventory).toEqual({ worn: [], equipped: {}, attached: [], totals: {} });
    expect(sheet).not.toHaveProperty("traits");
    expect(sheet).not.toHaveProperty("role");
  });

  it("drops non-finite and wrongly typed values instead of defaulting them", () => {
    const sheet = normalizeSheet({
      summary: { hoursSurvived: Number.NaN, zombieKills: "12", maxWeight: Infinity, carriedWeight: 3 },
      stats: { hunger: { value: Number.POSITIVE_INFINITY, min: 0, max: 1 }, thirst: { value: 0.2 } },
    });
    expect(sheet.summary).toEqual({ carriedWeight: 3 });
    expect(sheet.stats).toEqual({ thirst: { value: 0.2 } });
  });

  it("caps names at 128 characters and ids at 96", () => {
    const long = "x".repeat(500);
    const sheet = normalizeSheet({
      displayName: long,
      skills: { perks: [{ id: long, name: long, level: 1 }] },
      traits: [{ id: long, label: long }],
    });
    expect(sheet.displayName).toHaveLength(CHARACTER_SHEET_LIMITS.nameMax);
    expect(sheet.skills.perks[0].id).toHaveLength(CHARACTER_SHEET_LIMITS.idMax);
    expect(sheet.skills.perks[0].name).toHaveLength(CHARACTER_SHEET_LIMITS.nameMax);
    expect(sheet.traits[0].id).toHaveLength(CHARACTER_SHEET_LIMITS.idMax);
  });

  it("reads a sparse Lua list that arrived as an object with numeric keys", () => {
    const sheet = normalizeSheet({ traits: { 1: { id: "base:a" }, 3: { id: "base:c" } } });
    expect(sheet.traits.map((t) => t.id)).toEqual(["base:a", "base:c"]);
  });

  it("caps row depth at 4 and marks the container whose contents were cut", () => {
    const deep = container([container([container([container([stack("Base.Nails")])])])]);
    const sheet = normalizeSheet({ inventory: { root: { kind: "container", id: "main", rows: [deep] } } });
    const depth2 = sheet.inventory.root.rows[0];
    const depth3 = depth2.rows[0];
    const depth4 = depth3.rows[0];
    expect(depth4.kind).toBe("container");
    expect(depth4.rows).toEqual([]);
    expect(depth4.truncatedDepth).toBe(true);
  });

  it("caps the inventory at 2000 rows and says so in totals", () => {
    const rows = Array.from({ length: 2100 }, (_, i) => stack(`Base.Item${i}`));
    const sheet = normalizeSheet({ inventory: { root: { kind: "container", id: "main", rows }, totals: {} } });
    expect(sheet.inventory.root.rows).toHaveLength(CHARACTER_SHEET_LIMITS.rowsMax - 1);
    expect(sheet.inventory.totals).toMatchObject({ truncated: true, truncatedReason: "rowLimit" });
  });

  it("keeps only section errors for known sections", () => {
    const sheet = normalizeSheet({ sectionErrors: { skills: "PerkFactory unavailable", "/etc/passwd": "x" } });
    expect(sheet.sectionErrors).toEqual({ skills: "PerkFactory unavailable" });
  });

  it("the fixture produces no hints: an ordinary character", () => {
    const sheet = normalizeSheet(fixture);
    expect(computeCharacterHints(sheet, { now: fixture.generatedAt, playerLogs: [], source: "live" })).toEqual([]);
  });
});

describe("sheetFromPlayerDetails (old bridge fallback)", () => {
  it("maps getPlayerDetails to summary, value-only stats and health", () => {
    const sheet = sheetFromPlayerDetails({
      username: "Kate",
      accessLevel: "admin",
      x: 1,
      y: 2,
      z: 0,
      isAlive: true,
      stats: { hunger: 0.4, endurance: 0.9 },
      health: { overallBodyHealth: 80, isInfected: false, isBleeding: true, temperature: 37 },
    });
    expect(sheet.role).toEqual({ name: "admin" });
    expect(sheet.summary).toEqual({ isAlive: true, x: 1, y: 2, z: 0 });
    expect(sheet.stats).toEqual({ hunger: { value: 0.4 }, endurance: { value: 0.9 } });
    expect(sheet.health).toEqual({ overall: 80, isInfected: false, isBleeding: true, temperature: 37 });
    expect(sheet).not.toHaveProperty("skills");
  });
});

describe("fetchCharacterSheet", () => {
  function bridgeWith(sendCommand, extra = {}) {
    return {
      isRunning: true,
      isModConnected: () => true,
      sendCommand: vi.fn(sendCommand),
      getPlayerDetails: vi.fn(),
      ...extra,
    };
  }

  it("is bridgeOffline without asking when the bridge is down", async () => {
    const bridge = bridgeWith(async () => ({}), { isModConnected: () => false });
    expect(await fetchCharacterSheet(bridge, "Kate")).toEqual({ availability: "bridgeOffline", sheet: null });
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it("sends the default sections and returns a normalized live sheet", async () => {
    const bridge = bridgeWith(async () => ({ success: true, data: fixture }));
    const result = await fetchCharacterSheet(bridge, "Kate");
    expect(bridge.sendCommand).toHaveBeenCalledWith("getCharacterSheet", {
      username: "Kate",
      sections: ["summary", "stats", "skills", "traits"],
    });
    expect(result.availability).toBe("live");
    expect(result.sheet.username).toBe("Kate");
  });

  it("passes fresh and maxItems through", async () => {
    const bridge = bridgeWith(async () => ({ success: true, data: {} }));
    await fetchCharacterSheet(bridge, "Kate", { sections: ["inventory"], fresh: true, maxItems: 200 });
    expect(bridge.sendCommand).toHaveBeenCalledWith("getCharacterSheet", {
      username: "Kate",
      sections: ["inventory"],
      fresh: true,
      maxItems: 200,
    });
  });

  it.each([
    ["Player not found: Kate", "playerOffline"],
    ["Command timeout: getCharacterSheet (no response from mod)", "timeout"],
    ["Online player list unavailable", "bridgeOffline"],
    ["Bridge not running", "bridgeOffline"],
  ])("maps %j to %s", async (message, availability) => {
    const bridge = bridgeWith(async () => {
      throw new Error(message);
    });
    expect(await fetchCharacterSheet(bridge, "Kate")).toEqual({ availability, sheet: null });
  });

  it("falls back to getPlayerDetails on an old bridge and reports partial", async () => {
    const bridge = bridgeWith(async () => {
      throw new Error("Unknown command: getCharacterSheet");
    });
    bridge.getPlayerDetails.mockResolvedValue({ success: true, data: { username: "Kate", stats: { hunger: 0.1 } } });
    const result = await fetchCharacterSheet(bridge, "Kate");
    expect(result.availability).toBe("partial");
    expect(result.sheet.stats).toEqual({ hunger: { value: 0.1 } });
  });

  it("an old bridge that can't find the player is playerOffline", async () => {
    const bridge = bridgeWith(async () => {
      throw new Error("Unknown command: getCharacterSheet");
    });
    bridge.getPlayerDetails.mockRejectedValue(new Error("Player not found: Kate"));
    expect(await fetchCharacterSheet(bridge, "Kate")).toEqual({ availability: "playerOffline", sheet: null });
  });

  it("slows the poll down over SFTP", () => {
    expect(refreshIntervalsFor({ isRunning: true, sftpTransport: null })).toEqual({
      refreshAfterMs: 10000,
      inventoryRefreshAfterMs: 30000,
      transport: "local",
    });
    expect(refreshIntervalsFor({ isRunning: true, sftpTransport: {} })).toEqual({
      refreshAfterMs: 30000,
      inventoryRefreshAfterMs: 60000,
      transport: "sftp",
    });
    expect(refreshIntervalsFor({ isRunning: false }).transport).toBeNull();
  });
});
