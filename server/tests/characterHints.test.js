import { describe, expect, it } from "vitest";
import {
  CHARACTER_HINT_IDS,
  CHARACTER_HINT_THRESHOLDS,
  DEBUG_ITEM_TYPES,
  computeCharacterHints,
  estimateRealHours,
  xpScaleOf,
} from "../services/characterHints.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const MIN = 60 * 1000;

// hoursSurvived is in-game hours; with the default 60-minute day, 24 game
// hours are one real hour.
function gameHoursFor(realHours, minutesPerDay = 60) {
  return (realHours * 1440) / minutesPerDay;
}

function perk(id, level, extra = {}) {
  return { id, parent: "Crafting", passive: false, level, boost: 0, multiplier: 1, sandboxMultiplier: 1, ...extra };
}

function fillers(count, level = 0) {
  return Array.from({ length: count }, (_, i) => perk(`Filler${i}`, level));
}

function sheet({ perks = [], realHours = 1, summary = {}, role, rows, xpSandbox } = {}) {
  const s = {
    username: "Kate",
    role: role ?? { name: "none", adminPower: false, canSpawnItems: false },
    summary: { hoursSurvived: gameHoursFor(realHours), minutesPerDay: 60, ...summary },
    skills: { categories: [], perks },
  };
  if (xpSandbox) s.summary.xpSandbox = xpSandbox;
  if (rows) s.inventory = { root: { kind: "container", id: "main", rows }, worn: [], attached: [], equipped: {}, totals: {} };
  return s;
}

function item(fullType, qty = 1, extra = {}) {
  return { kind: "stack", fullType, name: fullType, qty, ...extra };
}

function hints(s, opts = {}) {
  return computeCharacterHints(s, { now: NOW, playerLogs: [], source: "live", ...opts });
}

function hint(s, id, opts) {
  return hints(s, opts).find((h) => h.id === id);
}

function logAt(minutesAgo, action, details) {
  return { action, details, logged_at: new Date(NOW - minutesAgo * MIN).toISOString(), player_name: "Kate" };
}

describe("derived values", () => {
  it("estimates real hours from in-game hours and the day length, defaulting to 60 minutes", () => {
    expect(estimateRealHours({ hoursSurvived: 48, minutesPerDay: 60 })).toBe(2);
    expect(estimateRealHours({ hoursSurvived: 48, minutesPerDay: 120 })).toBe(4);
    expect(estimateRealHours({ hoursSurvived: 48 })).toBe(2);
    expect(estimateRealHours({})).toBeUndefined();
  });

  it("xpScale uses the global multiplier when it's on, else the highest per-skill one, never below 1", () => {
    expect(xpScaleOf(sheet({ xpSandbox: { global: 3, globalToggle: true } }))).toBe(3);
    expect(xpScaleOf(sheet({ xpSandbox: { global: 0.5, globalToggle: true } }))).toBe(1);
    expect(
      xpScaleOf(sheet({ xpSandbox: { global: 3, globalToggle: false }, perks: [perk("A", 1, { sandboxMultiplier: 2.5 })] })),
    ).toBe(2.5);
    expect(xpScaleOf(sheet({ perks: [perk("A", 1, { sandboxMultiplier: 0.2 })] }))).toBe(1);
    expect(xpScaleOf(sheet())).toBe(1);
  });
});

describe("skillsAheadOfTime", () => {
  // 1 real hour: allowed = 3 * 1 * 1 + 6 = 9 levels above the floor of 3.
  it("stays quiet at exactly the allowance and flags one level past it", () => {
    expect(hint(sheet({ perks: [perk("A", 10), perk("B", 5)] }), "skillsAheadOfTime")).toBeUndefined(); // 7 + 2 = 9
    const h = hint(sheet({ perks: [perk("A", 10), perk("B", 5), perk("C", 4)] }), "skillsAheadOfTime"); // 10
    expect(h).toMatchObject({ weight: "mild", params: { advanced: 10, allowed: 9, hours: 1, xpScale: 1 } });
    expect(h.evidence[0]).toEqual({ kind: "perk", ref: "A", detail: { level: 10, start: 0 } });
  });

  it("is strong only past twice the allowance", () => {
    const eighteen = [perk("A", 10), perk("B", 10), perk("C", 7)]; // 7 + 7 + 4
    expect(hint(sheet({ perks: eighteen }), "skillsAheadOfTime").weight).toBe("mild");
    expect(hint(sheet({ perks: [...eighteen, perk("D", 4)] }), "skillsAheadOfTime").weight).toBe("strong");
  });

  it("counts from the starting level when a profession or trait starts it higher", () => {
    // boost 5: only the 5 levels above it count.
    expect(hint(sheet({ perks: [perk("A", 10, { boost: 5 }), perk("B", 7)] }), "skillsAheadOfTime")).toBeUndefined(); // 5 + 4
  });

  it("counts skill-book levels at half weight", () => {
    const perks = [perk("A", 10, { multiplier: 3 }), perk("B", 10, { multiplier: 3 }), perk("C", 8)];
    // 3.5 + 3.5 + 5 = 12 > 9
    expect(hint(sheet({ perks }), "skillsAheadOfTime").params.advanced).toBe(12);
    const halfOnly = [perk("A", 10, { multiplier: 3 }), perk("B", 10, { multiplier: 3 }), perk("C", 5)];
    expect(hint(sheet({ perks: halfOnly }), "skillsAheadOfTime")).toBeUndefined(); // 3.5 + 3.5 + 2
  });

  it("ignores passive skills", () => {
    const perks = [perk("Fitness", 10, { passive: true }), perk("Strength", 10, { passive: true }), perk("A", 5)];
    expect(hint(sheet({ perks }), "skillsAheadOfTime")).toBeUndefined();
  });

  it("scales the allowance with the XP multiplier", () => {
    const perks = [perk("A", 10), perk("B", 8)]; // 12
    expect(hint(sheet({ perks }), "skillsAheadOfTime")).toBeDefined();
    // xpScale 2: allowed = 3 * 1 * 2 + 6 = 12, not exceeded
    expect(hint(sheet({ perks, xpSandbox: { global: 2, globalToggle: true } }), "skillsAheadOfTime")).toBeUndefined();
    const scaledPerks = perks.map((p) => ({ ...p, sandboxMultiplier: 2 }));
    expect(hint(sheet({ perks: scaledPerks }), "skillsAheadOfTime")).toBeUndefined();
  });

  it("uses the day length: the same in-game hours on a 2-hour day allow twice the play time", () => {
    const perks = [perk("A", 10), perk("B", 8)]; // 12 > 9 on a 1-hour day
    const s = sheet({ perks });
    s.summary = { hoursSurvived: 24, minutesPerDay: 120 }; // 2 real hours: allowed 12
    expect(hint(s, "skillsAheadOfTime")).toBeUndefined();
    s.summary = { hoursSurvived: 24 }; // no day length: 60 minutes assumed, 1 hour
    expect(hint(s, "skillsAheadOfTime")).toBeDefined();
  });

  it("needs play time to say anything", () => {
    const s = sheet({ perks: [perk("A", 10), perk("B", 10), perk("C", 10)] });
    delete s.summary.hoursSurvived;
    expect(hint(s, "skillsAheadOfTime")).toBeUndefined();
  });
});

describe("manyMaxedSkills", () => {
  const maxed = (n, extra) => Array.from({ length: n }, (_, i) => perk(`Max${i}`, 10, extra));

  it("needs three skills at 10 within 40 XP-scaled hours", () => {
    expect(hint(sheet({ perks: [...maxed(2), ...fillers(20)], realHours: 1 }), "manyMaxedSkills")).toBeUndefined();
    expect(hint(sheet({ perks: [...maxed(3), ...fillers(20)], realHours: 39.9 }), "manyMaxedSkills")).toMatchObject({
      weight: "mild",
      params: { maxed: 3, nonPassive: 23 },
    });
    expect(hint(sheet({ perks: [...maxed(3), ...fillers(20)], realHours: 40 }), "manyMaxedSkills")).toBeUndefined();
    // XP scale 2: 20 real hours count as 40
    expect(
      hint(sheet({ perks: [...maxed(3), ...fillers(20)], realHours: 20, xpSandbox: { global: 2, globalToggle: true } }), "manyMaxedSkills"),
    ).toBeUndefined();
  });

  it("is strong from six skills at 10", () => {
    expect(hint(sheet({ perks: [...maxed(5), ...fillers(20)] }), "manyMaxedSkills").weight).toBe("mild");
    expect(hint(sheet({ perks: [...maxed(6), ...fillers(20)] }), "manyMaxedSkills").weight).toBe("strong");
  });

  it("flags 80% of skills at 10 at any play time, as strong", () => {
    expect(hint(sheet({ perks: [...maxed(8), ...fillers(2)], realHours: 5000 }), "manyMaxedSkills")).toMatchObject({
      weight: "strong",
    });
    expect(hint(sheet({ perks: [...maxed(7), ...fillers(3)], realHours: 5000 }), "manyMaxedSkills")).toBeUndefined();
  });

  it("doesn't count skills the character started at 10", () => {
    expect(hint(sheet({ perks: [...maxed(3, { boost: 10 }), ...fillers(20)] }), "manyMaxedSkills")).toBeUndefined();
  });
});

describe("skillJump", () => {
  function delta(perks, minutesAgo = 30, source = "login") {
    return { since: new Date(NOW - minutesAgo * MIN).toISOString(), source, perks };
  }
  const s = sheet({
    realHours: 500,
    perks: [perk("Axe", 6), perk("Cooking", 8), perk("Fitness", 7, { passive: true }), ...fillers(5)],
  });

  it("flags one skill gaining 3 levels to 6 or more, strong", () => {
    const h = hint(s, "skillJump", { skillDelta: delta([{ id: "Axe", fromLevel: 3, toLevel: 6 }]) });
    expect(h).toMatchObject({ weight: "strong", params: { total: 3, minutes: 30, source: "login" } });
    expect(h.evidence).toEqual([{ kind: "perk", ref: "Axe", detail: { from: 3, to: 6 } }]);
  });

  it("stays quiet below 3 levels or below level 6", () => {
    expect(hint(s, "skillJump", { skillDelta: delta([{ id: "Axe", fromLevel: 2, toLevel: 5 }]) })).toBeUndefined();
    expect(hint(s, "skillJump", { skillDelta: delta([{ id: "Cooking", fromLevel: 6, toLevel: 8 }]) })).toBeUndefined();
  });

  it("flags a passive skill gaining 2 levels", () => {
    expect(hint(s, "skillJump", { skillDelta: delta([{ id: "Fitness", fromLevel: 5, toLevel: 7 }]) }).weight).toBe("strong");
    expect(hint(s, "skillJump", { skillDelta: delta([{ id: "Fitness", fromLevel: 6, toLevel: 7 }]) })).toBeUndefined();
  });

  it("flags 6 levels in total across skills as mild", () => {
    const six = [
      { id: "Filler0", fromLevel: 0, toLevel: 2 },
      { id: "Filler1", fromLevel: 0, toLevel: 2 },
      { id: "Filler2", fromLevel: 0, toLevel: 2 },
    ];
    expect(hint(s, "skillJump", { skillDelta: delta(six) })).toMatchObject({ weight: "mild", params: { total: 6 } });
    expect(hint(s, "skillJump", { skillDelta: delta(six.slice(0, 2).concat([{ id: "Filler2", fromLevel: 0, toLevel: 1 }])) })).toBeUndefined();
  });

  it("only looks back 60 minutes, and only at live data", () => {
    const jump = [{ id: "Axe", fromLevel: 3, toLevel: 6 }];
    expect(hint(s, "skillJump", { skillDelta: delta(jump, 60) })).toBeDefined();
    expect(hint(s, "skillJump", { skillDelta: delta(jump, 61) })).toBeUndefined();
    expect(hint(s, "skillJump", { skillDelta: delta(jump), source: "cached" })).toBeUndefined();
    expect(hint(s, "skillJump", { skillDelta: null })).toBeUndefined();
  });

  it("is explained by an add_xp for that skill inside the window", () => {
    const jump = delta([{ id: "Axe", fromLevel: 3, toLevel: 6 }]);
    const explained = hint(s, "skillJump", { skillDelta: jump, playerLogs: [logAt(10, "add_xp", "Axe=5000")] });
    expect(explained.explainedBy).toEqual([
      { action: "add_xp", at: new Date(NOW - 10 * MIN).toISOString(), details: "Axe=5000" },
    ]);
    // Before the window, or for another skill: not an explanation.
    expect(hint(s, "skillJump", { skillDelta: jump, playerLogs: [logAt(45, "add_xp", "Axe=5000")] }).explainedBy).toBeUndefined();
    expect(hint(s, "skillJump", { skillDelta: jump, playerLogs: [logAt(10, "add_xp", "Cooking=5000")] }).explainedBy).toBeUndefined();
  });
});

describe("item hints", () => {
  it("flags a debug item as strong", () => {
    const h = hint(sheet({ rows: [item("Base.TestMug")] }), "debugItems");
    expect(h).toMatchObject({ weight: "strong", params: { types: 1, units: 1 } });
    expect(h.evidence).toEqual([{ kind: "item", ref: "Base.TestMug", detail: { qty: 1, name: "Base.TestMug" } }]);
    expect(hint(sheet({ rows: [item("Base.Mug")] }), "debugItems")).toBeUndefined();
  });

  it("covers every listed debug type, including inside containers", () => {
    for (const fullType of DEBUG_ITEM_TYPES) {
      const rows = [{ kind: "container", fullType: "Base.Bag_Schoolbag", rows: [item(fullType)] }];
      expect(hint(sheet({ rows }), "debugItems"), fullType).toBeDefined();
    }
  });

  it("a panel Give item in this life explains the debug item, up to the quantity it gave", () => {
    const given = [logAt(30, "add_item", "Base.TestMug x1")];
    const explained = hint(sheet({ rows: [item("Base.TestMug")] }), "debugItems", { playerLogs: given });
    expect(explained.explainedBy).toHaveLength(1);
    expect(explained.evidence[0].detail).toMatchObject({ qty: 1, given: 1, givenAt: new Date(NOW - 30 * MIN).toISOString() });
    const partly = hint(sheet({ rows: [item("Base.TestMug", 2)] }), "debugItems", { playerLogs: given });
    expect(partly.explainedBy).toBeUndefined();
    expect(partly.evidence[0].detail).toMatchObject({ qty: 2, given: 1 });
  });

  it("a Give item from before this life doesn't explain anything", () => {
    // 1 real hour lived; the log is 2 hours old.
    const h = hint(sheet({ rows: [item("Base.TestMug")] }), "debugItems", { playerLogs: [logAt(120, "add_item", "Base.TestMug x1")] });
    expect(h.explainedBy).toBeUndefined();
    // Unless the store knows the life started earlier.
    const widened = hint(sheet({ rows: [item("Base.TestMug")] }), "debugItems", {
      playerLogs: [logAt(120, "add_item", "Base.TestMug x1")],
      lifeStartedAt: NOW - 180 * MIN,
    });
    expect(widened.explainedBy).toHaveLength(1);
  });

  it("flags hidden items that aren't worn, and obsolete items, as mild", () => {
    expect(hint(sheet({ rows: [item("Base.Secret", 1, { hidden: true })] }), "hiddenItems")).toMatchObject({ weight: "mild" });
    expect(hint(sheet({ rows: [item("Base.Shirt", 1, { hidden: true, worn: true })] }), "hiddenItems")).toBeUndefined();
    expect(hint(sheet({ rows: [item("Base.Old", 1, { obsolete: true })] }), "obsoleteItems")).toMatchObject({ weight: "mild" });
    expect(hint(sheet({ rows: [item("Base.Old", 1, { obsolete: false })] }), "obsoleteItems")).toBeUndefined();
  });

  it("flags 500 or more of one type, summed across stacks and containers", () => {
    expect(hint(sheet({ rows: [item("Base.Nails", 499)] }), "unusualQuantity")).toBeUndefined();
    const rows = [item("Base.Nails", 300), { kind: "container", fullType: "Base.Bag", rows: [item("Base.Nails", 200)] }];
    expect(hint(sheet({ rows }), "unusualQuantity")).toMatchObject({ weight: "mild", params: { threshold: 500, types: 1 } });
  });

  it("a Give item explains the quantity only when what's left is under 500", () => {
    const logs = [logAt(20, "add_item", "Base.Nails x100"), logAt(10, "add_item", "Base.Nails x100")];
    expect(hint(sheet({ rows: [item("Base.Nails", 600)] }), "unusualQuantity", { playerLogs: logs }).explainedBy).toHaveLength(2);
    expect(hint(sheet({ rows: [item("Base.Nails", 700)] }), "unusualQuantity", { playerLogs: logs }).explainedBy).toBeUndefined();
  });
});

describe("overCapacity and powers", () => {
  it("flags carrying more than twice the weight limit", () => {
    expect(hint(sheet({ summary: { carriedWeight: 30, maxWeight: 15 } }), "overCapacity")).toBeUndefined();
    expect(hint(sheet({ summary: { carriedWeight: 30.1, maxWeight: 15 } }), "overCapacity")).toMatchObject({
      weight: "strong",
      params: { carried: 30.1, max: 15, factor: 2 },
    });
    expect(hint(sheet({ summary: { carriedWeight: 30, maxWeight: 0 } }), "overCapacity")).toBeUndefined();
  });

  it("flags powers on a regular account", () => {
    const h = hint(sheet({ summary: { flags: { godMode: true, noClip: true, invisible: false } } }), "powersOnRegularAccount");
    expect(h).toMatchObject({ weight: "strong", params: { count: 2 } });
    expect(h.evidence).toEqual([
      { kind: "flag", ref: "godMode" },
      { kind: "flag", ref: "noClip" },
    ]);
    expect(hint(sheet({ summary: { flags: { godMode: false } } }), "powersOnRegularAccount")).toBeUndefined();
  });
});

describe("staff and spawn roles", () => {
  const staffRole = { name: "admin", adminPower: true, canSpawnItems: true };
  const busy = () =>
    sheet({
      role: staffRole,
      summary: { flags: { godMode: true }, carriedWeight: 40, maxWeight: 15 },
      rows: [item("Base.TestMug")],
    });

  it("staff: powers are expected, everything else drops to mild and is labelled", () => {
    const list = hints(busy());
    expect(list.find((h) => h.id === "powersOnRegularAccount")).toBeUndefined();
    expect(list.map((h) => h.id)).toEqual(["debugItems", "overCapacity"]);
    for (const h of list) expect(h).toMatchObject({ weight: "mild", staff: true });
  });

  it("staff means role.adminPower, not the role's name", () => {
    const s = busy();
    s.role = { name: "admin", adminPower: false, canSpawnItems: false };
    expect(hint(s, "powersOnRegularAccount")).toMatchObject({ weight: "strong", staff: false });
    const custom = busy();
    custom.role = { name: "helper", adminPower: true };
    expect(hint(custom, "powersOnRegularAccount")).toBeUndefined();
  });

  it("a role that can spawn items softens only the item hints", () => {
    const s = sheet({
      role: { name: "gm", adminPower: false, canSpawnItems: true },
      summary: { carriedWeight: 40, maxWeight: 15 },
      rows: [item("Base.TestMug"), item("Base.Nails", 600), item("Base.Old", 1, { hidden: true })],
    });
    const list = hints(s);
    for (const id of ["debugItems", "unusualQuantity", "hiddenItems"]) {
      expect(list.find((h) => h.id === id)).toMatchObject({ weight: "mild", params: { canSpawnItems: true } });
    }
    expect(list.find((h) => h.id === "overCapacity")).toMatchObject({ weight: "strong", staff: false });
  });
});

describe("ordering and shape", () => {
  it("sorts strong, then mild, then explained, and stamps source", () => {
    const s = sheet({
      summary: { carriedWeight: 40, maxWeight: 15 },
      rows: [item("Base.TestMug"), item("Base.Old", 1, { obsolete: true }), item("Base.Nails", 600)],
    });
    const list = hints(s, { playerLogs: [logAt(5, "add_item", "Base.Nails x200")], source: "cached" });
    expect(list.map((h) => [h.id, h.weight, Boolean(h.explainedBy)])).toEqual([
      ["debugItems", "strong", false],
      ["overCapacity", "strong", false],
      ["obsoleteItems", "mild", false],
      ["unusualQuantity", "mild", true],
    ]);
    for (const h of list) expect(h.source).toBe("cached");
  });

  it("returns nothing for no sheet", () => {
    expect(computeCharacterHints(null)).toEqual([]);
  });

  it("thresholds are the documented ones", () => {
    expect(CHARACTER_HINT_THRESHOLDS).toMatchObject({ advancedLevelFloor: 3, unusualQuantity: 500, overCapacityFactor: 2, jumpWindowMinutes: 60 });
    expect(Object.isFrozen(CHARACTER_HINT_THRESHOLDS)).toBe(true);
  });
});
