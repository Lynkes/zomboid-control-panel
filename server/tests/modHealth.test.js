import { describe, expect, it } from "vitest";
import {
  HEALTH_KINDS,
  canonicalJson,
  computeModHealth,
  findHealthFix,
  healthIssueId,
  isHealthIssueId,
  isWritableModId,
} from "../utils/modHealth.js";
import { analyzeModOrder } from "../utils/modLoadOrder.js";
import { buildLoadOrderConstraints, planLoadOrder } from "../utils/modSmartSort.js";
import { classifyMods } from "../utils/modClassification.js";
import { applyModListFix } from "../services/modIniEdit.js";

// The health check core (utils/modHealth.js) on hand-built inputs, and the
// ini edits its fixes make (services/modIniEdit.js applyModListFix).

function healthFor({ modsLine, catalog, workshopItems = null, ...rest }) {
  const items = workshopItems || [...new Set(catalog.map((m) => m.workshopId))];
  const itemMods = new Map();
  for (const mod of catalog) {
    if (!itemMods.has(mod.workshopId)) itemMods.set(mod.workshopId, []);
    itemMods.get(mod.workshopId).push({ id: mod.id, name: mod.id, b42: mod.b42 !== false });
  }
  return computeModHealth({
    modsLine,
    workshopItems: items,
    maps: ["Muldraugh, KY"],
    catalog: catalog.filter((m) => m.b42 !== false),
    itemMods,
    itemsOnDisk: new Set(items),
    analysis: analyzeModOrder(modsLine, catalog.filter((m) => m.b42 !== false)),
    now: Date.parse("2026-10-20T12:00:00Z"),
    ...rest,
  });
}

describe("computeModHealth", () => {
  it("is quiet on a healthy list", () => {
    const body = healthFor({ modsLine: ["A", "B"], catalog: [{ id: "A", workshopId: "1" }, { id: "B", workshopId: "2", require: ["A"] }] });
    expect(body).toEqual({ checkedAt: "2026-10-20T12:00:00.000Z", counts: { critical: 0, warning: 0, info: 0 }, issues: [] });
  });

  it("gives every issue a stable id from its kind and subjects", () => {
    const input = { modsLine: ["Ghost", "A"], catalog: [{ id: "A", workshopId: "1" }] };
    const first = healthFor(input).issues[0];
    const second = healthFor(input).issues[0];
    expect(first.id).toBe(second.id);
    expect(isHealthIssueId(first.id)).toBe(true);
    expect(first.id).toBe(healthIssueId("notInstalled", ["m:Ghost"]));
    expect(healthIssueId("x", ["b", "a"])).toBe(healthIssueId("x", ["a", "b", "a"]));
  });

  it("never offers to remove PanelBridge's own mod, or an id it could not write back", () => {
    const body = healthFor({
      modsLine: ["PanelBridge", "A", "B"],
      catalog: [
        { id: "PanelBridge", workshopId: "9", incompatible: ["A"] },
        { id: "A", workshopId: "1" },
        { id: "B", workshopId: "2", incompatible: ["A"] },
      ],
      bridge: { modId: "PanelBridge", workshopId: "9" },
    });
    for (const issue of body.issues) {
      for (const fix of issue.fixes) expect(fix.params.modIds || []).not.toContain("PanelBridge");
    }
    expect(isWritableModId("a;b")).toBe(false);
    expect(isWritableModId(" a")).toBe(false);
    expect(isWritableModId("a\\b")).toBe(false);
    expect(isWritableModId("Mod With Spaces")).toBe(true);
  });

  it("does not call an item required by an item in use unused", () => {
    const body = healthFor({
      modsLine: ["A"],
      catalog: [{ id: "A", workshopId: "1" }, { id: "Lib", workshopId: "2" }],
      steamRequires: new Map([["1", [{ workshopId: "2", title: "Lib" }]]]),
    });
    expect(body.issues.filter((i) => i.kind === "unusedWorkshopItem")).toEqual([]);
  });

  it("names a case mismatch and offers no fix for it", () => {
    const body = healthFor({ modsLine: ["A"], catalog: [{ id: "A", workshopId: "1", require: ["lib"] }, { id: "Lib", workshopId: "2" }] });
    const [issue] = body.issues.filter((i) => i.kind === "requiredNotInstalled");
    expect(issue.params).toMatchObject({ missing: "lib", caseMatch: "Lib" });
    expect(issue.fixes).toEqual([]);
  });

  it("offers the Steam required items of the requiring item when no download ships the missing mod", () => {
    const body = healthFor({
      modsLine: ["A"],
      catalog: [{ id: "A", workshopId: "1", require: ["Framework"] }],
      steamRequires: new Map([["1", [{ workshopId: "77", title: "Framework" }]]]),
    });
    const [issue] = body.issues.filter((i) => i.kind === "requiredNotInstalled");
    expect(issue.fixes).toEqual([{ action: "addWorkshopItems", params: { workshopIds: ["77"] }, label: "Add Workshop item 77" }]);
    // The same item is not offered a second time as a missing Required item.
    expect(body.issues.filter((i) => i.kind === "requiredWorkshopItemMissing")).toEqual([]);
  });

  it("sorts issues critical first and counts them", () => {
    const body = healthFor({
      modsLine: ["Ghost", "A", "B"],
      catalog: [{ id: "A", workshopId: "1", require: ["B"] }, { id: "B", workshopId: "2", require: ["A"] }],
    });
    expect(body.issues.map((i) => i.severity)).toEqual(["critical", "warning"]);
    expect(body.counts).toEqual({ critical: 1, warning: 1, info: 0 });
    for (const issue of body.issues) expect(HEALTH_KINDS).toContain(issue.kind);
  });

  it("survives hostile input", () => {
    const body = computeModHealth({
      modsLine: ["a;b", "", "x\ny"],
      workshopItems: ["../etc", "1"],
      maps: ["", "Bad;Map"],
      catalog: [null, { id: 5 }, { id: "x\ny", workshopId: "1", profile: { mapFolders: ["Bad\nMap", "ok"] } }],
      analysis: { effectiveModOrder: ["x\ny"], orderWarnings: [{ code: "modNotFound", modId: "a;b" }, { code: "requireCycle", modId: "q" }] },
    });
    expect(body.issues.length).toBeGreaterThan(0);
    for (const issue of body.issues) {
      for (const fix of issue.fixes) {
        for (const id of fix.params.modIds || []) expect(isWritableModId(id)).toBe(true);
        for (const folder of fix.params.folders || []) expect(folder).not.toMatch(/[\n;=]/);
      }
    }
  });
});

describe("findHealthFix", () => {
  const health = {
    issues: [
      {
        id: "requireLoop-0123456789abcdef",
        fixes: [
          { action: "removeMods", params: { modIds: ["A"] } },
          { action: "removeMods", params: { modIds: ["B"] } },
        ],
      },
    ],
  };
  it("matches by id, action and, when needed, params", () => {
    expect(findHealthFix(health, "nope", "removeMods")).toEqual({ error: "gone" });
    expect(findHealthFix(health, "requireLoop-0123456789abcdef", "addMods")).toEqual({ error: "fix" });
    expect(findHealthFix(health, "requireLoop-0123456789abcdef", "removeMods")).toEqual({ error: "fix" });
    expect(findHealthFix(health, "requireLoop-0123456789abcdef", "removeMods", { modIds: ["B"] }).fix.params).toEqual({ modIds: ["B"] });
    expect(findHealthFix(health, "requireLoop-0123456789abcdef", "removeMods", { modIds: ["C"] })).toEqual({ error: "fix" });
  });
  it("compares params whatever the key order", () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe(canonicalJson({ a: null, b: [1, { c: 2, d: 1 }] }));
  });
});

describe("applyModListFix", () => {
  const ini = "Mods=\\A;B;C\nWorkshopItems=1;2\nMap=Town;Muldraugh, KY\n";
  it("removes and adds mods, keeping the entries that stay as written", () => {
    expect(applyModListFix(ini, { action: "removeMods", params: { modIds: ["B"] } }).content).toContain("Mods=\\A;C\n");
    expect(applyModListFix(ini, { action: "addMods", params: { modIds: ["D", "A", "bad;id"], before: "C" } }).content).toContain(
      "Mods=\\A;B;D;C\n",
    );
    expect(applyModListFix(ini, { action: "addMods", params: { modIds: ["E"], before: "Gone" } }).content).toContain("Mods=\\A;B;C;E\n");
  });
  it("adds and removes Workshop items, and their mods", () => {
    const added = applyModListFix(ini, { action: "addWorkshopItems", params: { workshopIds: ["3", "1", "x"], modIds: ["Z"], before: "A" } });
    expect(added.content).toContain("WorkshopItems=1;2;3\n");
    expect(added.content).toContain("Mods=Z;\\A;B;C\n");
    expect(applyModListFix(ini, { action: "removeWorkshopItems", params: { workshopIds: ["1"] } }).content).toContain("WorkshopItems=2\n");
  });
  it("puts a map in front of Map= and removes one, keeping the vanilla map", () => {
    expect(applyModListFix(ini, { action: "addMapFolders", params: { folders: ["New", "Bad\nX"] } }).content).toContain("Map=New;Town;Muldraugh, KY\n");
    expect(applyModListFix(ini, { action: "removeMapFolders", params: { folders: ["town"] } }).content).toContain("Map=Muldraugh, KY\n");
    expect(applyModListFix("Map=Only\n", { action: "removeMapFolders", params: { folders: ["Only"] } }).content).toBe("Map=Muldraugh, KY\n");
  });
  it("reorders Mods= to a plan, keeping every entry", () => {
    const result = applyModListFix(ini, { action: "applyPlan", params: {} }, { order: ["C", "A"] });
    expect(result.content).toContain("Mods=C;\\A;B\n");
    expect(applyModListFix(ini, { action: "applyPlan", params: {} }, { order: ["A", "B", "C"] }).changed).toBe(false);
  });
  it("does nothing for an unknown action", () => {
    expect(applyModListFix(ini, { action: "rewrite", params: {} })).toEqual({ content: ini, changed: false });
  });
});

describe("performance", () => {
  it("checks 600 mods (plan included) in under 300 ms", () => {
    const catalog = [];
    for (let i = 0; i < 600; i++) {
      const require = [];
      if (i % 10 !== 0) require.push(`mod${i - (i % 10)}`);
      if (i % 37 === 5) require.push(`missing${i}`);
      catalog.push({
        id: `mod${i}`,
        name: `Mod ${i}`,
        workshopId: String(100000 + Math.floor(i / 2)),
        require,
        loadAfter: i % 13 === 0 && i > 0 ? [`mod${i - 1}`] : [],
        incompatible: i === 77 ? ["mod78"] : [],
        profile: { files: 10, translation: 0, translationJson: 0, lua: 5, luaPaths: [], mapFolders: i === 300 ? ["Big Town"] : [], scripts: 5, models: 0, textures: 0, audio: 0, clothing: 0, ui: 0, luaClient: 5 },
      });
    }
    const modsLine = catalog.map((m) => m.id).reverse();
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const analysis = analyzeModOrder(modsLine, catalog);
      const classification = classifyMods({ mods: catalog, enabled: analysis.effectiveModOrder });
      const built = buildLoadOrderConstraints({ order: modsLine, mods: catalog, classification });
      const plan = planLoadOrder({ order: modsLine, ...built, classification });
      const body = healthFor({ modsLine, catalog, plan, planChangesLoading: true });
      best = Math.min(best, performance.now() - started);
      expect(body.counts.critical).toBeGreaterThan(0);
      expect(body.issues.some((i) => i.kind === "orderProblems")).toBe(true);
    }
    expect(best).toBeLessThan(300);
  });
});
