import { describe, expect, it } from "vitest";
import { CLASSIFICATION_LIMITS, KIND_TIER, MOD_KINDS, classifyMods } from "../utils/modClassification.js";
import { summarizeModFiles } from "../utils/modContentProfile.js";

// What kind of mod each enabled mod is (utils/modClassification.js), from its
// loaded files, its dependents, its mod.info links, Steam tags and its name.

const profile = (paths) => summarizeModFiles(paths);

function classify(mods, extra = {}) {
  const enabled = extra.enabled || mods.map((m) => m.id);
  return classifyMods({ mods, enabled, ...extra });
}

describe("classifyMods: what the files say", () => {
  it("a mod of only Translate files is a translation (tier 4)", () => {
    const result = classify([
      {
        id: "RuTranslation",
        name: "Some Mod RU",
        profile: profile(["lua/shared/Translate/RU/UI_RU.json", "lua/shared/Translate/RU/Items_RU.json", "poster.png"]),
      },
    ]);
    expect(result.get("RuTranslation")).toMatchObject({
      kind: "translation",
      confidence: "high",
      tier: 4,
      reasons: [{ code: "translationFilesOnly", params: { files: 2 } }],
    });
  });

  it("old .txt translations are still a translation, with less confidence", () => {
    const result = classify([{ id: "t", profile: profile(["lua/shared/Translate/FR/UI_FR.txt"]) }]);
    expect(result.get("t")).toMatchObject({ kind: "translation", confidence: "medium" });
  });

  it("a loaded media/maps folder with map data makes a map", () => {
    const result = classify([
      { id: "RavenCreek", profile: profile(["maps/Raven Creek/0_0.lotheader", "maps/Raven Creek/spawnpoints.lua", "scripts/x.txt"]) },
    ]);
    expect(result.get("RavenCreek")).toMatchObject({
      kind: "map",
      confidence: "high",
      tier: 1,
      reasons: [{ code: "mapFolder", params: { folders: ["Raven Creek"] } }],
    });
  });

  it("only Lua overriding files of the mod it requires is a patch of that mod", () => {
    const result = classify([
      { id: "BigMod", name: "Big Mod", profile: profile(["lua/client/BigMod/UI.lua", "lua/shared/BigMod/Defs.lua", "scripts/items.txt"]) },
      { id: "Fixer", name: "Something", require: ["BigMod"], profile: profile(["lua/client/BigMod/UI.lua", "lua/shared/Translate/EN/UI_EN.json"]) },
    ]);
    expect(result.get("Fixer")).toMatchObject({
      kind: "patch",
      confidence: "high",
      tier: 3,
      patchOf: ["BigMod"],
      reasons: [{ code: "overridesRequiredLua", params: { targets: ["BigMod"], files: 1 } }],
    });
    expect(result.get("BigMod")).toMatchObject({ kind: "content", dependents: 1, requiredBy: ["Fixer"] });
  });

  it("scripts make content; Steam content tags raise the confidence", () => {
    const mods = [
      { id: "Guns", workshopId: "1", profile: profile(["scripts/guns.txt", "models_X/gun.fbx"]) },
      { id: "Cars", workshopId: "2", profile: profile(["scripts/cars.txt"]) },
    ];
    const result = classify(mods, { steamTags: { 1: ["Weapons", "Build 42"] } });
    expect(result.get("Guns")).toMatchObject({ kind: "content", confidence: "high" });
    expect(result.get("Cars")).toMatchObject({ kind: "content", confidence: "medium" });
  });
});

describe("classifyMods: dependents, names and tags", () => {
  it("a mod three enabled mods require is a library; framework when Steam or its name says so", () => {
    const deps = (target) => ["a", "b", "c"].map((id) => ({ id: `${target}_${id}`, require: [target] }));
    const result = classify([
      { id: "lib1", workshopId: "10" },
      ...deps("lib1"),
      { id: "core2", workshopId: "20" },
      ...deps("core2"),
    ], { steamTags: new Map([["20", ["Framework"]]]) });
    expect(result.get("lib1")).toMatchObject({ kind: "library", confidence: "high", tier: 0, dependents: 3 });
    expect(result.get("lib1").reasons).toEqual([{ code: "manyDependents", params: { count: 3 } }]);
    expect(result.get("core2")).toMatchObject({ kind: "framework", tier: 0 });
  });

  it("counts only enabled dependents", () => {
    const result = classify(
      [{ id: "lib" }, { id: "a", require: ["lib"] }, { id: "b", require: ["lib"] }, { id: "c", require: ["lib"] }],
      { enabled: ["lib", "a", "b"] },
    );
    expect(result.get("lib").dependents).toBe(2);
    expect(result.has("c")).toBe(false);
  });

  it("names a patch: '<X> - Patch' and 'for <X>' are high, a patch word plus require= is medium", () => {
    const result = classify([
      { id: "BritaWeapons", name: "Brita's Weapon Pack" },
      { id: "BritaPatch", name: "Brita's Weapon Pack - Patch", require: ["BritaWeapons"] },
      { id: "Compat", name: "Compatibility for Brita's Weapon Pack", loadAfter: ["BritaWeapons"] },
      { id: "Hydro", name: "Hydrocraft" },
      { id: "FurnitureAddon", name: "More Furniture Addon", require: ["Hydro"] },
    ]);
    expect(result.get("BritaPatch")).toMatchObject({ kind: "patch", confidence: "high", patchOf: ["BritaWeapons"] });
    expect(result.get("BritaPatch").reasons[0].code).toBe("namedForTarget");
    expect(result.get("Compat")).toMatchObject({ kind: "patch", confidence: "high", patchOf: ["BritaWeapons"] });
    expect(result.get("FurnitureAddon")).toMatchObject({ kind: "patch", confidence: "medium", patchOf: ["Hydro"] });
    expect(result.get("FurnitureAddon").reasons[0].code).toBe("patchNamed");
  });

  it("does not take a mod that merely requires another for its patch", () => {
    const result = classify([
      { id: "tsarslib", name: "Tsar's Common Library" },
      { id: "93chevyK5", name: "'93 Chevrolet K5 Blazer", require: ["tsarslib"], profile: profile(["scripts/vehicles/k5.txt", "models_X/k5.fbx"]) },
    ]);
    expect(result.get("93chevyK5").kind).toBe("content");
  });

  it("reads Steam tags: Interface -> ui, QoL without content files -> tweak, Map without files -> map (low)", () => {
    const result = classify(
      [
        { id: "ui", workshopId: "1" },
        { id: "qol", workshopId: "2", profile: profile(["lua/client/qol.lua"]) },
        { id: "map", workshopId: "3" },
        { id: "tr", workshopId: "4" },
      ],
      { steamTags: { 1: ["Interface"], 2: ["QoL"], 3: ["Map"], 4: ["Language/Translation"] } },
    );
    expect(result.get("ui")).toMatchObject({ kind: "ui", confidence: "medium" });
    expect(result.get("qol")).toMatchObject({ kind: "tweak", confidence: "medium" });
    expect(result.get("map")).toMatchObject({ kind: "map", confidence: "low" });
    expect(result.get("tr")).toMatchObject({ kind: "translation", confidence: "low" });
  });

  it("library names: lib/library/framework/api/utils alone; core/base/common only with dependents", () => {
    const result = classify([
      { id: "MyLib", name: "My Lib" },
      { id: "CoreStuff", name: "Core Stuff" },
      { id: "BaseThing" },
      { id: "user", require: ["BaseThing"] },
    ]);
    expect(result.get("MyLib")).toMatchObject({ kind: "library", confidence: "low" });
    expect(result.get("CoreStuff").kind).not.toBe("library");
    expect(result.get("BaseThing")).toMatchObject({ kind: "library", confidence: "medium" });
  });

  it("a name-only patch guess is a low-confidence patch", () => {
    const result = classify([{ id: "A" }, { id: "B" }], { namePatches: [{ before: "A", after: "B" }] });
    expect(result.get("B")).toMatchObject({ kind: "patch", confidence: "low", patchOf: ["A"] });
  });

  it("small client Lua with a UI name is ui; a small Lua-only mod is a tweak; nothing at all is unknown", () => {
    const result = classify([
      { id: "BetterHud", name: "Better HUD", profile: profile(["lua/client/hud.lua", "ui/icon_hud.png"]) },
      { id: "Small", profile: profile(["lua/server/a.lua", "lua/server/b.lua"]) },
      { id: "Nothing" },
    ]);
    expect(result.get("BetterHud")).toMatchObject({ kind: "ui", confidence: "low" });
    expect(result.get("Small")).toMatchObject({ kind: "tweak", confidence: "low" });
    expect(result.get("Nothing")).toMatchObject({ kind: "unknown", confidence: "low", tier: 2 });
  });

  it("every kind has a tier and only known kinds come out", () => {
    for (const kind of MOD_KINDS) expect(KIND_TIER[kind]).toEqual(expect.any(Number));
    expect(KIND_TIER).toMatchObject({ library: 0, framework: 0, map: 1, content: 1, ui: 2, unknown: 2, patch: 3, tweak: 3, translation: 4 });
  });
});

describe("classifyMods: the KI5 case", () => {
  it("a framework, 30 vehicle mods and a patch", () => {
    const vehicles = Array.from({ length: 30 }, (_, i) => ({
      id: `KI5_vehicle_${i}`,
      name: `KI5 Vehicle ${i}`,
      workshopId: String(3000 + i),
      require: ["tsarslib"],
      profile: profile([`scripts/vehicles/v${i}.txt`, `models_X/v${i}.fbx`, `lua/client/Vehicles/v${i}_ui.lua`]),
    }));
    const patch = {
      id: "KI5_patch",
      name: "KI5 Vehicles - Patch",
      workshopId: "4000",
      require: ["tsarslib", "KI5_vehicle_3", "KI5_vehicle_7"],
      profile: profile(["lua/client/Vehicles/v3_ui.lua", "lua/client/Vehicles/v7_ui.lua"]),
    };
    const mods = [{ id: "tsarslib", name: "Tsar's Common Library", workshopId: "2392709985" }, ...vehicles, patch];
    const result = classify(mods, { steamTags: { 2392709985: ["Framework", "Build 42"], 3000: ["Vehicles"] } });
    expect(result.get("tsarslib")).toMatchObject({ kind: "framework", confidence: "high", tier: 0, dependents: 31 });
    for (const v of vehicles) expect(result.get(v.id).kind).toBe("content");
    expect(result.get("KI5_patch")).toMatchObject({
      kind: "patch",
      confidence: "high",
      patchOf: ["KI5_vehicle_3", "KI5_vehicle_7"],
    });
  });
});

describe("hostile input", () => {
  it("survives junk, prototype ids, huge lists and odd names", () => {
    const mods = [
      null,
      { id: 5 },
      { id: "__proto__", name: "x".repeat(10_000), require: "not-a-list" },
      { id: "constructor", require: Array.from({ length: 10_000 }, (_, i) => `r${i}`), profile: { files: 0, translation: 0, mapFolders: [] } },
      { id: "日本語の翻訳", name: "日本語の翻訳" },
    ];
    const result = classifyMods({ mods, enabled: ["__proto__", "constructor", "日本語の翻訳", "ghost", 7] });
    expect([...result.keys()]).toEqual(["__proto__", "constructor", "日本語の翻訳", "ghost"]);
    expect(result.get("constructor").requires).toHaveLength(CLASSIFICATION_LIMITS.maxListEntries);
    expect(result.get("ghost").kind).toBe("unknown");
    expect(result.get("日本語の翻訳").kind).toBe("translation");
  });

  it("classifies 3000 mods quickly", () => {
    const mods = Array.from({ length: 3000 }, (_, i) => ({ id: `m${i}`, name: `Mod ${i}`, require: i > 0 ? [`m${i % 50}`] : [] }));
    const started = performance.now();
    const result = classify(mods);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.get("m1").kind).toBe("library");
  });
});
