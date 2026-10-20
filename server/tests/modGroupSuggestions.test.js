import { describe, expect, it } from "vitest";
import {
  MOD_GROUP_SUGGESTION_LIMITS,
  computeGroupSuggestions,
  isSuggestionKey,
  namePrefixWords,
  suggestionKey,
} from "../utils/modGroupSuggestions.js";

// Suggested mod groups, read off the enabled mods and what their mod.info
// says (require=, name, owning Workshop item). Fixtures modelled on real
// Build 42 servers: KI5 vehicles on their library, Brita's weapons on
// Arsenal(26), the Authentic Z family, multi-mod Workshop items, and the
// generic names ("Better ...", "[B42] ...", "The ...") that must not group.

const mod = (id, name, workshopId, require = []) => ({ id, name, workshopId, require });

const MODS = [
  mod("damnlib", "DAMN Library", "3171167894"),
  mod("82jeepJ10", "[KI5] '82 Jeep J10", "2525061240", ["damnlib"]),
  mod("93fordBronco", "[KI5] '93 Ford Bronco", "2525061241", ["damnlib"]),
  mod("90pierceArrow", "KI5 '90 Pierce Arrow", "2525061242", ["damnlib"]),
  mod("ArsenalGunFighter", "Arsenal(26) GunFighter", "2297098490"),
  mod("Brita", "Brita's Weapon Pack", "2460154811", ["ArsenalGunFighter"]),
  mod("Brita_2", "Brita's Armor Pack", "2460154811", ["ArsenalGunFighter"]),
  mod("BritaLaunchers", "Brita's Launchers", "2460154812"),
  mod("AuthenticZCurrent", "Authentic Z - Current", "2335368829"),
  mod("AuthenticZBackpacks+", "Authentic Z - Backpacks+", "2335368829"),
  mod("AuthenticZLite", "Authentic Z - Lite", "2335368830"),
  mod("BetterSorting", "Better Sorting", "2313387159"),
  mod("BetterFlashlights", "Better Flashlights", "2460154813"),
  mod("BetterLockpicking", "Better Lockpicking", "2460154814"),
  mod("TheWorkshop", "The Workshop", "2460154815"),
  mod("TheFactory", "The Factory", "2460154816"),
  mod("TheLastStand", "The Last Stand", "2460154817"),
  mod("ModOptionsB42", "[B42] Mod Options", "2169435993"),
  mod("CommonSenseB42", "[B42] Common Sense", "2875848298"),
  mod("FuelAPIB42", "[B42] Fuel API", "2688538916"),
  mod("2MoreTraits", "2 More Traits", "2460154818"),
  mod("2Slots", "2 Slots", "2460154819"),
  mod("2xLoot", "2x Loot", "2460154820"),
  mod("VFExpansion1", "Vanilla Firearms Expansion", "2200148440"),
  mod("VFETweaks", "VFE Tweaks", "2200148440"),
  mod("VFE_Brita", "VFE - Brita's compatibility", "2200148440"),
  mod("VFE_Arsenal", "VFE - Arsenal compatibility", "2200148440"),
  mod("VFE_NoCraft", "VFE - No ammo crafting", "2200148440"),
];

const ALL = MODS.map((m) => m.id);
const run = (overrides = {}) => computeGroupSuggestions({ enabled: ALL, mods: MODS, ...overrides });
const ofKind = (suggestions, kind) => suggestions.filter((s) => s.kind === kind);
const shape = (s) => ({ kind: s.kind, name: s.name, modIds: s.modIds });

describe("dependency suggestions", () => {
  it("groups a library with the enabled mods that require it: library first, then load order", () => {
    const deps = ofKind(run(), "dependency");
    expect(deps.map(shape)).toEqual([
      { kind: "dependency", name: "DAMN Library", modIds: ["damnlib", "82jeepJ10", "93fordBronco", "90pierceArrow"] },
      { kind: "dependency", name: "Arsenal(26) GunFighter", modIds: ["ArsenalGunFighter", "Brita", "Brita_2"] },
    ]);
    expect(deps[0].reason).toBe("library required by 3 enabled mods");
  });

  it("follows the load order for the dependents", () => {
    const enabled = ["90pierceArrow", "damnlib", "93fordBronco", "82jeepJ10"];
    const [dep] = ofKind(run({ enabled }), "dependency");
    expect(dep.modIds).toEqual(["damnlib", "90pierceArrow", "93fordBronco", "82jeepJ10"]);
  });

  it("needs the library enabled and at least two enabled dependents", () => {
    expect(ofKind(run({ enabled: ALL.filter((id) => id !== "damnlib") }), "dependency").map((s) => s.modIds[0])).toEqual([
      "ArsenalGunFighter",
    ]);
    expect(ofKind(run({ enabled: ALL.filter((id) => id !== "Brita_2") }), "dependency").map((s) => s.modIds[0])).toEqual([
      "damnlib",
    ]);
  });

  it("ignores a mod requiring itself, repeated require= entries and require= of a mod that is not enabled", () => {
    const mods = [
      mod("lib", "Lib", "1"),
      mod("a", "A", "2", ["lib", "lib", "a", "ghost"]),
      mod("b", "B", "3", ["lib"]),
    ];
    const [dep] = computeGroupSuggestions({ enabled: ["lib", "a", "b"], mods });
    expect(dep).toMatchObject({ kind: "dependency", modIds: ["lib", "a", "b"] });
  });

  it("stays between 3 and 60 mods: a library half the server needs is no group", () => {
    const build = (count) => {
      const mods = [mod("lib", "Shared Lib", "1")];
      for (let i = 0; i < count; i++) mods.push(mod(`dep${i}`, `Dependent number ${i}`, String(100 + i), ["lib"]));
      return computeGroupSuggestions({ enabled: mods.map((m) => m.id), mods });
    };
    expect(ofKind(build(59), "dependency")[0].modIds).toHaveLength(60);
    expect(ofKind(build(60), "dependency")).toEqual([]);
    expect(ofKind(build(1), "dependency")).toEqual([]);
  });
});

describe("workshop-item suggestions", () => {
  it("suggests a Workshop item that ships 4 or more enabled mod IDs, in load order", () => {
    const [item] = ofKind(run(), "workshop-item");
    expect(item).toMatchObject({
      kind: "workshop-item",
      modIds: ["VFExpansion1", "VFETweaks", "VFE_Brita", "VFE_Arsenal", "VFE_NoCraft"],
      reason: "5 enabled mods from Workshop item 2200148440",
    });
    // no shared distinctive prefix ("Vanilla" is generic): the first mod's name
    expect(item.name).toBe("Vanilla Firearms Expansion");
  });

  it("takes the Workshop title when the panel knows it", () => {
    const [item] = ofKind(run({ workshopTitles: { 2200148440: "VFE: Vanilla Firearms Expansion" } }), "workshop-item");
    expect(item.name).toBe("VFE: Vanilla Firearms Expansion");
  });

  it("only counts enabled IDs, so 3 enabled of 5 is no suggestion", () => {
    const enabled = ALL.filter((id) => id !== "VFE_Arsenal" && id !== "VFE_NoCraft");
    expect(ofKind(run({ enabled }), "workshop-item")).toEqual([]);
  });
});

describe("prefix suggestions", () => {
  it("groups names that start with the same distinctive word or bracket tag", () => {
    expect(ofKind(run(), "prefix").map(shape)).toEqual([
      { kind: "prefix", name: "VFE", modIds: ["VFETweaks", "VFE_Brita", "VFE_Arsenal", "VFE_NoCraft"] },
      { kind: "prefix", name: "Authentic Z", modIds: ["AuthenticZCurrent", "AuthenticZBackpacks+", "AuthenticZLite"] },
      { kind: "prefix", name: "Brita's", modIds: ["Brita", "Brita_2", "BritaLaunchers"] },
      { kind: "prefix", name: "KI5", modIds: ["82jeepJ10", "93fordBronco", "90pierceArrow"] },
    ]);
  });

  it("never groups generic words, build tags or numbers", () => {
    const names = ofKind(run(), "prefix").map((s) => s.name);
    for (const generic of ["Better", "The", "B42", "Mod", "Common", "2", "2x", "Vanilla"]) {
      expect(names).not.toContain(generic);
    }
  });

  it("needs 3 mods", () => {
    const enabled = ALL.filter((id) => id !== "BritaLaunchers");
    expect(ofKind(run({ enabled }), "prefix").map((s) => s.name)).not.toContain("Brita's");
  });

  it("reads the distinctive words of a name", () => {
    expect(namePrefixWords("[KI5] '82 Jeep J10")).toEqual(["KI5", "82", "Jeep", "J10"]);
    expect(namePrefixWords("[B42] [KI5] Bronco")).toEqual(["KI5", "Bronco"]);
    expect(namePrefixWords("[B42] Fuel API")).toEqual(["Fuel", "API"]);
    expect(namePrefixWords("Authentic Z - Current")).toEqual(["Authentic", "Z", "Current"]);
    expect(namePrefixWords("TMC: True Music")).toEqual(["TMC", "True", "Music"]);
    for (const generic of ["Better Sorting", "The Workshop", "[B42] Mod Options", "2 Slots", "42.13 fixes", "", "   ", null]) {
      expect(namePrefixWords(generic), String(generic)).toBeNull();
    }
  });
});

describe("keys, exclusions and order", () => {
  it("keys a suggestion by its kind and member set, whatever the order", () => {
    expect(suggestionKey("prefix", ["b", "a"])).toBe(suggestionKey("prefix", ["a", "b"]));
    expect(suggestionKey("prefix", ["a", "b"])).not.toBe(suggestionKey("dependency", ["a", "b"]));
    expect(suggestionKey("prefix", ["a", "b"])).not.toBe(suggestionKey("prefix", ["a", "b", "c"]));
    expect(isSuggestionKey(suggestionKey("workshop-item", ["a"]))).toBe(true);
    for (const bad of ["", "prefix-xyz", "other-0123456789abcdef", "prefix-0123456789ABCDEF", 5, null]) {
      expect(isSuggestionKey(bad)).toBe(false);
    }
    for (const s of run()) expect(s.key).toBe(suggestionKey(s.kind, s.modIds));
  });

  it("leaves out a member set an existing group already holds (equal or smaller), not a bigger one", () => {
    const groups = [
      { modIds: ["damnlib", "82jeepJ10", "93fordBronco", "90pierceArrow", "extra"] },
      { modIds: ["Brita", "Brita_2"] },
    ];
    const keys = run({ groups }).map((s) => s.modIds[0]);
    expect(keys).not.toContain("damnlib");
    expect(keys).not.toContain("82jeepJ10"); // the KI5 prefix set is inside that group too
    expect(keys).toContain("ArsenalGunFighter"); // its set is bigger than the Brita group
  });

  it("does not combine two groups to cover a suggestion", () => {
    const groups = [{ modIds: ["damnlib", "82jeepJ10"] }, { modIds: ["93fordBronco", "90pierceArrow"] }];
    expect(ofKind(run({ groups }), "dependency").map((s) => s.modIds[0])).toContain("damnlib");
  });

  it("leaves out dismissed keys", () => {
    const first = run();
    const dismissed = [first[0].key];
    const after = run({ dismissed });
    expect(after.map((s) => s.key)).not.toContain(first[0].key);
    expect(after).toHaveLength(first.length - 1);
  });

  it("answers one suggestion per member set, preferring dependency, then workshop-item", () => {
    const mods = [
      mod("lib", "Pack Lib", "9"),
      mod("p1", "Pack One", "9", ["lib"]),
      mod("p2", "Pack Two", "9", ["lib"]),
      mod("p3", "Pack Three", "9", ["lib"]),
    ];
    const suggestions = computeGroupSuggestions({ enabled: ["lib", "p1", "p2", "p3"], mods });
    expect(suggestions.map((s) => s.kind)).toEqual(["dependency"]);
    // dismissing it does not bring the same set back under another kind
    expect(computeGroupSuggestions({ enabled: ["lib", "p1", "p2", "p3"], mods, dismissed: [suggestions[0].key] })).toEqual([]);
  });

  it("orders by kind, then size, and is the same on every run", () => {
    const suggestions = run();
    expect(suggestions.map((s) => s.kind)).toEqual([
      "dependency",
      "dependency",
      "workshop-item",
      "prefix",
      "prefix",
      "prefix",
      "prefix",
    ]);
    expect(run()).toEqual(suggestions);
    expect(run({ mods: [...MODS].reverse() })).toEqual(suggestions);
  });

  it("handles no mods, nothing enabled and malformed input", () => {
    expect(computeGroupSuggestions({ enabled: [], mods: [] })).toEqual([]);
    expect(computeGroupSuggestions({ enabled: undefined, mods: undefined, groups: undefined, dismissed: undefined })).toEqual([]);
    expect(computeGroupSuggestions({ enabled: ["a", 5, null], mods: [null, { id: 5 }, mod("a", undefined, "1")] })).toEqual([]);
  });

  it("keeps suggested names within the group name limit", () => {
    const long = "Zyx".repeat(30);
    const mods = [1, 2, 3].map((i) => mod(`m${i}`, `${long} part ${i}`, String(i)));
    const [s] = computeGroupSuggestions({ enabled: mods.map((m) => m.id), mods });
    expect(s.name.length).toBeLessThanOrEqual(60);
  });
});

describe("a big server", () => {
  // 600 enabled mods: 40 authors with 8 prefixed mods each (some on a shared
  // library), 30 multi-mod Workshop items and generic names for the rest.
  function bigServer() {
    const mods = [];
    for (let a = 0; a < 40; a++) {
      mods.push(mod(`lib${a}`, `Author${a} Library`, `1${a}`));
      for (let i = 0; i < 7; i++) {
        mods.push(mod(`a${a}m${i}`, `[Author${a}] Mod ${i}`, `2${a}${i}`, i % 2 ? [`lib${a}`, "ModOptions"] : ["ModOptions"]));
      }
    }
    for (let w = 0; w < 30; w++) {
      for (let i = 0; i < 5; i++) mods.push(mod(`w${w}m${i}`, `Better Thing ${w}-${i}`, `3${w}`));
    }
    while (mods.length < 600) mods.push(mod(`g${mods.length}`, `The Generic ${mods.length}`, `4${mods.length}`));
    mods.push(mod("ModOptions", "Mod Options", "5"));
    return mods;
  }

  it("answers well under a second, capped and deterministic", () => {
    const mods = bigServer();
    const enabled = mods.map((m) => m.id);
    const started = performance.now();
    const suggestions = computeGroupSuggestions({ enabled, mods });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(250);
    expect(suggestions).toHaveLength(MOD_GROUP_SUGGESTION_LIMITS.maxSuggestions);
    expect(computeGroupSuggestions({ enabled, mods })).toEqual(suggestions);
    // ModOptions is required by 280 mods: far over 60, so no group
    expect(suggestions.some((s) => s.modIds[0] === "ModOptions")).toBe(false);
  });
});
