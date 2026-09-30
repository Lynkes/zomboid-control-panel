import { describe, expect, it } from "vitest";
import { CHARACTER_SHEET_INVENTORY, loadCharacterSheetBridge } from "./helpers/characterSheetLua.js";
import { CHARACTER_SECTIONS, fetchCharacterSheet, normalizeSheet } from "../services/characterSheet.js";
import { computeCharacterHints } from "../services/characterHints.js";

// The bridge/panel contract for the Character tab (spec §B6): the real
// getCharacterSheet handler (PanelBridge.lua under fengari, over the 42.21-
// shaped stubs) feeds the panel's own normalizeSheet and
// computeCharacterHints. The Lua and Node sides were written apart, against
// §B2; this is where a renamed or dropped field shows up.

const ALL_SECTIONS = [...CHARACTER_SECTIONS];

// A PanelBridge service double whose commands run the Lua handler, resolving
// and rejecting the way PanelBridge#handleResult does ({ success, data } or an
// Error carrying the handler's error string).
function bridgeOver(lua) {
  return {
    isRunning: true,
    isModConnected: () => true,
    sendCommand: async (action, args) => {
      const result = lua.callHandler(action, args);
      if (!result.ok) throw new Error(result.err || "Command failed");
      return { success: true, data: result.data };
    },
    getPlayerDetails: async () => {
      throw new Error("not used: the handler exists");
    },
  };
}

function rawSheet(lua, args) {
  const result = lua.callHandler("getCharacterSheet", args);
  expect(result.ok, result.err).toBe(true);
  return result.data;
}

function keysOf(value) {
  return Object.keys(value ?? {}).sort();
}

function walkRows(row, visit) {
  visit(row);
  for (const child of row.rows ?? []) walkRows(child, visit);
}

describe("getCharacterSheet output through normalizeSheet", () => {
  it("keeps every field the handler sends, section by section", () => {
    const lua = loadCharacterSheetBridge(CHARACTER_SHEET_INVENTORY);
    const raw = rawSheet(lua, { username: "Alice", sections: ALL_SECTIONS });
    const sheet = normalizeSheet(raw);

    for (const field of ["schema", "generatedAt", "username", "displayName", "forename", "surname"]) {
      expect(sheet[field], field).toEqual(raw[field]);
    }
    expect(sheet.role).toEqual(raw.role);
    expect(sheet.cost).toEqual(raw.cost);
    // An empty sectionErrors arrives as [] and means "no errors".
    expect(raw.sectionErrors).toEqual({});
    expect(sheet).not.toHaveProperty("sectionErrors");

    expect(keysOf(sheet.summary)).toEqual(keysOf(raw.summary));
    expect(sheet.summary).toEqual(raw.summary);

    expect(keysOf(sheet.stats)).toEqual(keysOf(raw.stats));
    expect(sheet.stats).toEqual(raw.stats);
    expect(sheet.health).toMatchObject(raw.health);

    expect(sheet.skills.categories).toEqual(raw.skills.categories);
    expect(sheet.skills.failed).toBe(raw.skills.failed);
    expect(sheet.skills.perks).toHaveLength(raw.skills.perks.length);
    raw.skills.perks.forEach((perk, i) => expect(sheet.skills.perks[i], perk.id).toEqual(perk));

    expect(sheet.traits).toEqual(raw.traits);

    const inv = sheet.inventory;
    expect(inv.totals).toEqual(raw.inventory.totals);
    expect(inv.root).toMatchObject({ kind: "container", itemId: "main" });
    // Every row field the handler emits survives, at every depth.
    const rawRows = [];
    const rows = [];
    walkRows(raw.inventory.root, (row) => rawRows.push(row));
    walkRows(inv.root, (row) => rows.push(row));
    expect(rows).toHaveLength(rawRows.length);
    rawRows.forEach((rawRow, i) => {
      const { rows: rawChildren, ...rawFields } = rawRow;
      const { rows: children, ...fields } = rows[i];
      // Item ids come back as strings.
      const expected = rawFields.itemId === undefined ? rawFields : { ...rawFields, itemId: String(rawFields.itemId) };
      expect(fields, `${rawRow.fullType ?? "main"} row`).toEqual(expected);
      expect(children?.length ?? 0).toBe(rawChildren?.length ?? 0);
    });
  });

  it("turns the worn, attached and equipped summaries into rows that say where each item sits", () => {
    const lua = loadCharacterSheetBridge(CHARACTER_SHEET_INVENTORY);
    const raw = rawSheet(lua, { username: "Alice", sections: ["inventory"] });
    // What the bridge sends: summaries, not rows.
    expect(raw.inventory.attached).toEqual([{ itemId: 2, fullType: "Base.Hammer", name: "Hammer", location: "Belt Left" }]);

    const { inventory } = normalizeSheet(raw);
    expect(inventory.equipped).toEqual({
      primary: { kind: "stack", fullType: "Base.Axe", name: "Axe", equipped: "primary" },
      secondary: { kind: "stack", fullType: "Base.Axe", name: "Axe", equipped: "secondary" },
    });
    expect(inventory.worn).toEqual([
      { kind: "stack", fullType: "Base.Tshirt_DefaultTEXTURE", name: "T-Shirt", worn: true },
      { kind: "stack", fullType: "Base.Bag_Schoolbag", name: "Loot bag", worn: true },
    ]);
    expect(inventory.attached).toEqual([{ kind: "stack", fullType: "Base.Hammer", name: "Hammer", attached: "Belt Left" }]);
  });

  it("reads an empty inventory and a failed section the way the handler encodes them", () => {
    const lua = loadCharacterSheetBridge(`
Alice.inventory = Container({})
Alice.getStats = function() error("no stats") end
Alice.getBodyDamage = function() error("no body") end
`);
    const raw = rawSheet(lua, { username: "Alice", sections: ["stats", "inventory"] });
    const sheet = normalizeSheet(raw);
    expect(sheet.sectionErrors).toEqual(raw.sectionErrors);
    expect(Object.keys(sheet.sectionErrors)).toContain("stats");
    expect(sheet.inventory).toMatchObject({ worn: [], attached: [], equipped: {} });
    expect(sheet.inventory.root).toMatchObject({ kind: "container", itemId: "main", rows: [] });
  });
});

describe("getCharacterSheet output through computeCharacterHints", () => {
  const NOW = 1_800_000_000_000;

  it("flags the debug item once, and nothing else for an ordinary character", () => {
    const lua = loadCharacterSheetBridge(CHARACTER_SHEET_INVENTORY);
    const sheet = normalizeSheet(rawSheet(lua, { username: "Alice", sections: ALL_SECTIONS }));
    const hints = computeCharacterHints(sheet, { now: NOW, source: "live", playerLogs: [] });
    expect(hints.map((h) => h.id)).toEqual(["debugItems"]);
    expect(hints[0]).toMatchObject({ weight: "strong", staff: false, source: "live" });
    expect(hints[0].evidence).toEqual([expect.objectContaining({ kind: "item", ref: "Base.TestMug" })]);
  });

  it("one opened box of nails is 100 nails, not an unusual quantity", () => {
    // B42 gives every Nails object getCount() 5 (the script's count).
    const lua = loadCharacterSheetBridge(`
local nails = {}
for i = 1, 100 do nails[i] = Item("Base.Nails", { count = 5, name = "Nails" }) end
Alice.inventory = Container(nails)
`);
    const sheet = normalizeSheet(rawSheet(lua, { username: "Alice", sections: ["summary", "inventory"] }));
    expect(sheet.inventory.totals.itemCount).toBe(100);
    const hints = computeCharacterHints(sheet, { now: NOW, source: "live", playerLogs: [] });
    expect(hints.map((h) => h.id)).not.toContain("unusualQuantity");
  });

  it("reads the book multiplier and the sandbox XP settings the handler sends", () => {
    // Axe at 10 with a skill book (multiplier 2) counts half: 3.5 levels
    // ahead, plus Carpentry's 7, against 3 x 1.27 h + 6 allowed.
    const lua = loadCharacterSheetBridge(`Alice.levels.Axe = 10`);
    const sheet = normalizeSheet(rawSheet(lua, { username: "Alice" }));
    const ahead = computeCharacterHints(sheet, { now: NOW, source: "live" }).find((h) => h.id === "skillsAheadOfTime");
    expect(ahead).toBeTruthy();

    // With the global XP multiplier off, the per-skill sandbox multiplier
    // (Axe 2.5) widens the allowance enough.
    const scaled = loadCharacterSheetBridge(`
Alice.levels.Axe = 10
SandboxVars.MultiplierConfig.GlobalToggle = false
`);
    const scaledSheet = normalizeSheet(rawSheet(scaled, { username: "Alice" }));
    expect(computeCharacterHints(scaledSheet, { now: NOW, source: "live" }).some((h) => h.id === "skillsAheadOfTime")).toBe(false);
  });

  it("uses the role the handler reads: flags on a regular account are strong, on staff they're expected", () => {
    const regular = loadCharacterSheetBridge(`Alice.opts.godMode = true`);
    const regularHints = computeCharacterHints(normalizeSheet(rawSheet(regular, { username: "Alice", sections: ["summary"] })), {
      now: NOW,
    });
    expect(regularHints.find((h) => h.id === "powersOnRegularAccount")).toMatchObject({ weight: "strong", staff: false });

    const staff = loadCharacterSheetBridge(`
Alice.opts.godMode = true
Alice.role = { name = "admin", adminPower = true, spawn = true }
`);
    const staffSheet = normalizeSheet(rawSheet(staff, { username: "Alice", sections: ["summary", "inventory"] }));
    expect(staffSheet.role).toEqual({ name: "admin", adminPower: true, canSpawnItems: true });
    const staffHints = computeCharacterHints(staffSheet, { now: NOW });
    expect(staffHints.some((h) => h.id === "powersOnRegularAccount")).toBe(false);
    expect(staffHints.every((h) => h.staff === true && h.weight === "mild")).toBe(true);
  });
});

describe("getCharacterSheet errors through fetchCharacterSheet", () => {
  it("maps the handler's own lookup errors to the availability states", async () => {
    const lua = loadCharacterSheetBridge();
    const live = await fetchCharacterSheet(bridgeOver(lua), "alice", {});
    expect(live.availability).toBe("live");
    expect(live.sheet.username).toBe("Alice");

    const missing = await fetchCharacterSheet(bridgeOver(lua), "nobody", {});
    expect(missing).toEqual({ availability: "playerOffline", sheet: null });

    const noList = loadCharacterSheetBridge(`getOnlinePlayers = function() return nil end`);
    expect(await fetchCharacterSheet(bridgeOver(noList), "alice", {})).toEqual({ availability: "bridgeOffline", sheet: null });
  });

  it("sends only arguments the handler understands", async () => {
    const lua = loadCharacterSheetBridge(CHARACTER_SHEET_INVENTORY);
    const calls = [];
    const bridge = bridgeOver(lua);
    const send = bridge.sendCommand;
    bridge.sendCommand = async (action, args) => {
      calls.push(args);
      return send(action, args);
    };
    const result = await fetchCharacterSheet(bridge, "Alice", { sections: ["inventory"], fresh: true, maxItems: 50 });
    expect(result.availability).toBe("live");
    expect(calls[0]).toEqual({ username: "Alice", sections: ["inventory"], fresh: true, maxItems: 50 });
    expect(result.sheet.inventory.totals).toMatchObject({ maxItems: 50 });
    expect(result.sheet).not.toHaveProperty("skills");
  });
});
