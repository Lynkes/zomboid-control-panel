import { describe, expect, it } from "vitest";
import {
  analyzeModOrder,
  computeEffectiveModOrder,
  computeOrderingConstraints,
  createDependencyRelation,
  findIncompatiblePairs,
  gameVersionIntFromName,
  normaliseModInfoList,
  orderingFieldsFromModInfo,
  parseModInfoForGame,
  pickModVersionFolder,
} from "../utils/modLoadOrder.js";

// The expectations below are what Project Zomboid 42.21 itself did when its
// own classes were run on the same mod.info files (ChooseGameInfo.readModInfo
// and ZomboidFileSystem.loadModAndRequired through a reflection harness), not
// what seemed reasonable. See the notes at the top of utils/modLoadOrder.js.

// A catalog entry the way getModDetailsFromWorkshop builds one.
function mod(id, modInfo = "", name = id) {
  const parsed = parseModInfoForGame(`name=${name}\nid=${id}\n${modInfo}`);
  const ordering = orderingFieldsFromModInfo(parsed);
  return {
    id,
    name,
    require: normaliseModInfoList(parsed.require).ids,
    requireRaw: parsed.require,
    ...ordering,
  };
}

describe("mod.info lists are read exactly like ChooseGameInfo.readModInfoAux", () => {
  it("removes backslashes, splits on ',' only and keeps whitespace", () => {
    const parsed = parseModInfoForGame(
      "name=Mod B\nid=ModB\nrequire=\\ModA, \\ModC\nloadModAfter=\\ModA;\\ModC\nloadModBefore= \\ModD \nincompatible=\\ModE,\\modf\n",
    );
    // Harness output: [ModA][ ModC] / [ModA;ModC] / [ ModD ] / [ModE][modf]
    expect(parsed.require).toEqual(["ModA", " ModC"]);
    expect(parsed.loadModAfter).toEqual(["ModA;ModC"]);
    expect(parsed.loadModBefore).toEqual([" ModD "]);
    expect(parsed.incompatible).toEqual(["ModE", "modf"]);
    expect(parsed.id).toBe("ModB");
  });

  it("an empty require= is one empty entry; empty middle entries stay, trailing ones go", () => {
    expect(parseModInfoForGame("require=\n").require).toEqual([""]);
    expect(parseModInfoForGame("require=\\ModA,,\\ModC\n").require).toEqual(["ModA", "", "ModC"]);
    expect(parseModInfoForGame("loadModAfter=\\ModA,\\ModC,\n").loadModAfter).toEqual(["ModA", "ModC"]);
  });

  it("keys are case-sensitive and must be written key=, the last line wins", () => {
    const parsed = parseModInfoForGame(
      "id=Multi\nrequire=\\ModA\nRequire=\\ModX\nrequire = \\ModY\nrequire=\\ModC\n",
    );
    expect(parsed.require).toEqual(["ModC"]);
  });

  it("id= must start the line and is trimmed; other keys match anywhere", () => {
    const parsed = parseModInfoForGame(" id=Nope\nid= ModC \n  require=\\ModA\n");
    expect(parsed.id).toBe("ModC");
    expect(parsed.require).toEqual(["  ModA"]);
  });

  it("a line holding name= is a name line, whatever else it says", () => {
    expect(parseModInfoForGame("name=x require=\\ModA\n").require).toBeNull();
  });

  it("normalises the lists for the API and reports what the game cannot match", () => {
    const { ids, issues } = normaliseModInfoList(["ModA", " ModC", "", "A;B", "  "], "require");
    expect(ids).toEqual(["ModA", "ModC", "A", "B"]);
    expect(issues.map((i) => i.code)).toEqual(["whitespace", "emptyEntry", "semicolon", "blankEntry"]);
  });
});

describe("version folders follow ZomboidFileSystem.getModVersionDirName", () => {
  it("reads version numbers like the game", () => {
    expect(gameVersionIntFromName("42")).toBe(42000);
    expect(gameVersionIntFromName("42.5")).toBe(42005);
    expect(gameVersionIntFromName("42.13.1")).toBe(42013);
    expect(gameVersionIntFromName("42.x")).toBe(42000);
    expect(gameVersionIntFromName("common")).toBe(0);
  });

  it("picks the newest folder the running game accepts", () => {
    // Harness (game 42.21): 42.30, 42.5 and 43 present -> 42.5.
    expect(pickModVersionFolder(["42.30", "42.5", "43", "common"], 42021)).toBe("42.5");
    expect(pickModVersionFolder(["42", "42.13", "41", "common"])).toBe("42.13");
    expect(pickModVersionFolder(["41", "common", "media"])).toBeNull();
  });
});

describe("computeEffectiveModOrder models ZomboidFileSystem.loadMods", () => {
  const catalog = [
    mod("ModA"),
    mod("ModC", "require=\\ModA\n"),
    mod("Multi", "require=\\ModA\nrequire=\\ModC\n"),
    mod("CaseMod", "require=\\moda\n"),
    mod("Spaced", "require=\\ModA, \\ModC\n"),
    mod("EmptyReq", "require=\n"),
    mod("MidEmpty", "require=\\ModA,,\\ModC\n"),
    mod("CycA", "require=\\CycB\n"),
    mod("CycB", "require=\\CycA\n"),
    mod("NeedsSpaced", "require=\\Spaced\n"),
  ];

  it("loads requirements first, even ones missing from Mods=", () => {
    // Harness: "ModC;Multi" -> [ModA, ModC, Multi]
    const { order, notLoaded } = computeEffectiveModOrder(["ModC", "Multi"], catalog);
    expect(order).toEqual(["ModA", "ModC", "Multi"]);
    expect(notLoaded).toEqual([]);
  });

  it("skips a mod whose require= entry the game cannot match", () => {
    const { order, notLoaded } = computeEffectiveModOrder(
      ["CaseMod", "Spaced", "EmptyReq", "MidEmpty", "ModA"],
      catalog,
    );
    // Harness: CaseMod, EmptyReq and MidEmpty are unavailable; " ModC" is
    // looked up untrimmed after ModA was loaded.
    expect(order).toEqual(["ModA"]);
    expect(notLoaded.map((n) => n.modId)).toEqual(["CaseMod", "Spaced", "EmptyReq", "MidEmpty"]);
    expect(notLoaded.find((n) => n.modId === "Spaced").missing).toBe(" ModC");
  });

  it("a mod requiring a mod that cannot load is not loaded either", () => {
    const { order, notLoaded } = computeEffectiveModOrder(["NeedsSpaced"], catalog);
    expect(order).toEqual(["ModA"]);
    expect(notLoaded).toEqual([
      expect.objectContaining({ modId: "NeedsSpaced", missing: " ModC", via: "Spaced" }),
    ]);
  });

  it("reports a require= cycle (the game overflows its stack on it)", () => {
    const { order, warnings, notLoaded } = computeEffectiveModOrder(["CycA", "CycB", "ModA"], catalog);
    expect(order).toEqual(["ModA"]);
    expect(notLoaded.map((n) => n.cause)).toEqual(["requireCycle", "requireCycle"]);
    expect(warnings.filter((w) => w.code === "requireCycle")).toHaveLength(1);
  });

  it("keeps an id it cannot see, skips examplemod and repeats", () => {
    const { order, warnings } = computeEffectiveModOrder(["Local", "examplemod", "ModA", "ModA"], catalog);
    expect(order).toEqual(["Local", "ModA"]);
    expect(warnings).toEqual([{ code: "modNotFound", severity: "info", modId: "Local" }]);
  });
});

describe("analyzeModOrder", () => {
  it("explains the order the server will really use", () => {
    const catalog = [
      mod("Lib"),
      mod("Core", "require=\\Lib\n"),
      mod("Addon", "require=\\Core\nloadModAfter=\\Late\n"),
      mod("Late", "loadModBefore=\\Core\n"),
      mod("Bad", "require=\\lib\n"),
      mod("Hater", "incompatible=\\Late\n"),
      mod("Odd", "loadModAfter=\\Lib, \\Core\n"),
    ];
    const { effectiveModOrder, orderWarnings } = analyzeModOrder(
      ["Addon", "Late", "Core", "Bad", "Hater", "Odd"],
      catalog,
    );
    expect(effectiveModOrder).toEqual(["Lib", "Core", "Addon", "Late", "Hater", "Odd"]);
    const codes = orderWarnings.map((w) => `${w.code}:${w.modId}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "requireAutoLoaded:Core", // Lib is not in Mods=
        "requireReordered:Addon", // Mods= lists Addon before Core
        "loadAfterViolated:Addon", // Late loads after Addon
        "loadBeforeViolated:Late", // Core loads before Late
        "requireNotFound:Bad",
        "declaredIncompatible:Late",
        "modInfoListIssue:Odd",
      ]),
    );
    expect(orderWarnings.find((w) => w.code === "requireNotFound")).toMatchObject({
      missing: "lib",
      caseMatch: "Lib",
      severity: "high",
    });
  });

  it("names the malformed require= entry that keeps a mod from loading", () => {
    const { orderWarnings } = analyzeModOrder(["Spaced"], [mod("ModA"), mod("ModC"), mod("Spaced", "require=\\ModA, \\ModC\n")]);
    expect(orderWarnings).toContainEqual({
      code: "requireEntryInvalid",
      severity: "high",
      modId: "Spaced",
      entry: " ModC",
      issue: "whitespace",
    });
  });
});

describe("computeOrderingConstraints", () => {
  it("turns require=, loadModAfter= and loadModBefore= into edges between known mods", () => {
    const edges = computeOrderingConstraints([
      mod("A"),
      mod("B", "require=\\A\nloadModAfter=\\A,\\Unknown\n"),
      mod("C", "loadModBefore=\\B\n"),
    ]);
    expect(edges).toEqual([
      { before: "A", after: "B", reason: "require", reasons: ["require", "loadAfter"], declaredBy: "B" },
      { before: "C", after: "B", reason: "loadBefore", declaredBy: "C" },
    ]);
  });

  it("adds a soft patch edge from names only when nothing is declared", () => {
    const edges = computeOrderingConstraints([
      mod("BetterSorting", "", "Better Sorting"),
      mod("BetterSorting_ArmorPatch", "", "Better Sorting - Armor Patch"),
      mod("SortingTools"),
    ]);
    expect(edges).toEqual([
      { before: "BetterSorting", after: "BetterSorting_ArmorPatch", reason: "patch", declaredBy: "BetterSorting_ArmorPatch" },
    ]);
    const declared = computeOrderingConstraints([
      mod("BetterSorting"),
      mod("BetterSorting_ArmorPatch", "loadModBefore=\\BetterSorting\n"),
    ]);
    expect(declared.map((e) => e.reason)).toEqual(["loadBefore"]);
  });

  it("keeps the current conflict winner only for otherwise unrelated pairs", () => {
    const edges = computeOrderingConstraints([mod("A"), mod("B", "require=\\A\n"), mod("C")], {
      conflictWinners: [
        { winner: "A", loser: "B" },
        { winner: "C", loser: "A" },
      ],
    });
    expect(edges).toContainEqual({ before: "A", after: "B", reason: "require", declaredBy: "B" });
    expect(edges).toContainEqual({ before: "A", after: "C", reason: "conflictWinner" });
    expect(edges.some((e) => e.before === "B" && e.after === "A")).toBe(false);
  });
});

describe("hostile mod.info lists", () => {
  it("a huge require=/loadModAfter= list is capped and analysed fast", () => {
    const list = Array.from({ length: 200_000 }, (_, i) => `\\Mod${i}`).join(",");
    const hostile = mod("Hostile", `require=${list}\nloadModAfter=${list}\nincompatible=${list}\n`);
    expect(hostile.requireRaw.length).toBeLessThan(10_000); // 64 KB of mod.info
    const catalog = [hostile, ...Array.from({ length: 400 }, (_, i) => mod(`Mod${i}`, i > 0 ? `require=\\Mod${i - 1}\n` : ""))];
    const t = performance.now();
    const result = analyzeModOrder(["Hostile", ...catalog.map((m) => m.id)], catalog);
    createDependencyRelation(catalog)("Hostile", "Mod0");
    expect(performance.now() - t).toBeLessThan(3000);
    expect(result.effectiveModOrder).toContain("Mod399");
  });
});

describe("dependency relation and incompatible pairs", () => {
  it("follows declarations transitively", () => {
    const dependsOn = createDependencyRelation([
      mod("A"),
      mod("B", "require=\\A\n"),
      mod("C", "loadModAfter=\\B\n"),
      mod("D", "loadModBefore=\\A\n"),
    ]);
    expect(dependsOn("C", "A")).toBe(true);
    expect(dependsOn("A", "D")).toBe(true);
    expect(dependsOn("A", "C")).toBe(false);
  });

  it("treats incompatible= as symmetric, between loaded mods only", () => {
    const catalog = [mod("A", "incompatible=\\B,\\Z\n"), mod("B"), mod("Z")];
    expect(findIncompatiblePairs(["B", "A"], catalog)).toEqual([{ a: "B", b: "A", declaredBy: "A" }]);
  });
});
