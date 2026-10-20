import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// Smart sort end to end, through the routes, on Workshop folders on disk:
// the KI5 case (a framework, 30 vehicle mods and a patch, one group kept
// together) and a generated 400-mod server shaped like a real big list
// (libraries, add-ons, patches, translations, maps, multi-mod items, and the
// usual breakage).
const db = await import("../database/init.js");
const { default: router } = await import("../routes/modsSmart.js");
const { _resetSteamKnowledgeForTests } = await import("../services/modSteamKnowledge.js");
const { clearContentProfileCache } = await import("../utils/modContentProfile.js");
const runRoute = createRouteRunner(router);
const ADMIN = { username: "alice", role: "admin" };
const call = (routePath, method, req = {}) => runRoute(routePath, method, { user: ADMIN, query: {}, params: {}, body: {}, ...req });

let fx;

beforeAll(async () => {
  await db.initDatabase();
});

beforeEach(async () => {
  const state = await db.getDb();
  state.data.mod_groups = [];
  state.data.mod_order_rules = [];
  state.data.tracked_mods = [];
  fx = makeServerFixture({ prefix: "mods-smart-e2e-", ini: "Mods=\nWorkshopItems=\n" });
  state.data.servers = [{ ...fx.activeServer, name: "Test", isActive: true }];
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("offline");
  }));
  _resetSteamKnowledgeForTests();
  clearContentProfileCache();
});

afterEach(() => {
  fx.cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const state = await db.getDb();
  state.data.mod_groups = [];
  state.data.mod_order_rules = [];
  state.data.servers = [];
});

function addMod(ws, id, { lines = [], files = [], name = id } = {}) {
  const dir = fx.writeMod(ws, id, [`name=${name}`, `id=${id}`, ...lines, ""].join("\n"), "42");
  for (const rel of files) {
    const target = path.join(dir, "42", "media", rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${id}:${rel}`);
  }
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the KI5 case", () => {
  it("a framework, 30 vehicles and a patch kept together: one block, framework first, patch after its targets, then nothing to do", async () => {
    addMod("2392709985", "tsarslib", { name: "Tsar's Common Library", files: ["lua/shared/TCL/core.lua", "lua/client/TCL/ui.lua"] });
    const vehicles = [];
    for (let i = 0; i < 30; i++) {
      const id = `KI5_car${i}`;
      vehicles.push(id);
      addMod(String(3000000000 + i), id, {
        name: `KI5 Car ${i}`,
        lines: ["require=tsarslib"],
        files: [`scripts/vehicles/car${i}.txt`, `models_X/car${i}.fbx`, `lua/client/KI5/car${i}.lua`],
      });
    }
    addMod("3100000000", "KI5_patch", {
      name: "KI5 Vehicles - Patch",
      lines: ["require=tsarslib,KI5_car3,KI5_car7"],
      files: ["lua/client/KI5/car3.lua", "lua/client/KI5/car7.lua"],
    });
    for (let i = 0; i < 5; i++) addMod(String(3200000000 + i), `Other${i}`, { files: [`scripts/other${i}.txt`] });

    // A scrambled Mods=: the patch first, the framework late, unrelated mods
    // in between.
    const others = ["Other0", "Other1", "Other2", "Other3", "Other4"];
    const order = ["KI5_patch", "Other0", ...vehicles.slice(0, 10), "Other1", "tsarslib", ...vehicles.slice(10, 20), "Other2", "Other3", ...vehicles.slice(20), "Other4"];
    const items = ["2392709985", ...vehicles.map((_, i) => String(3000000000 + i)), "3100000000", ...others.map((_, i) => String(3200000000 + i))];
    fx.writeIni(`Mods=${order.join(";")}\nWorkshopItems=${items.join(";")}\n`);
    const state = await db.getDb();
    state.data.mod_groups = [
      { id: "ki5", name: "KI5", modIds: ["tsarslib", ...vehicles, "KI5_patch"], keepTogether: true, placement: null, createdAt: "x", updatedAt: "x" },
    ];

    const plan = (await call("/load-order/plan", "post")).getBody();
    const block = plan.order.slice(0, 32);
    expect(block[0]).toBe("tsarslib");
    expect(new Set(block)).toEqual(new Set(["tsarslib", ...vehicles, "KI5_patch"]));
    expect(block.indexOf("KI5_patch")).toBeGreaterThan(block.indexOf("KI5_car7"));
    expect(plan.order.slice(32)).toEqual(others);
    expect(plan.unsatisfied).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.moves.every((m) => !others.includes(m.modId))).toBe(true);
    expect(plan.stats.ms).toBeLessThan(150);

    const insights = (await call("/insights", "get")).getBody();
    expect(insights.mods.tsarslib).toMatchObject({ kind: "library", tier: 0, dependents: 31 });
    expect(insights.mods.KI5_car0.kind).toBe("content");
    expect(insights.mods.KI5_patch).toMatchObject({ kind: "patch", kindConfidence: "high", patchOf: ["KI5_car3", "KI5_car7"] });

    const health = (await call("/health", "get")).getBody();
    const [orderIssue] = health.issues.filter((i) => i.kind === "orderProblems");
    expect(orderIssue).toBeDefined();
    const fixed = await call("/health/fix", "post", { body: { issueId: orderIssue.id, action: "applyPlan" } });
    expect(fixed.getBody().applied).toBe(true);
    expect(fx.iniValue("Mods").split(";")).toEqual(plan.order);
    expect(fixed.getBody().health.issues.filter((i) => i.kind === "orderProblems")).toEqual([]);
    const again = (await call("/load-order/plan", "post")).getBody();
    expect(again.changed).toBe(false);
    expect(again.moves).toEqual([]);
  });
});

describe("a generated 400-mod server", () => {
  it("plans, checks and explains a big list end to end", async () => {
    const random = rng(400);
    const mods = [];
    let item = 4000000000;
    const newItem = () => String(item++);
    const libraries = [];
    for (let i = 0; i < 12; i++) {
      const id = `Lib${i}`;
      libraries.push(id);
      mods.push({ ws: newItem(), id, name: `Library ${i}`, files: [`lua/shared/Lib${i}/api.lua`, `lua/shared/Lib${i}/util.lua`] });
    }
    const contents = [];
    for (let i = 0; i < 300; i++) {
      const id = `Content${i}`;
      contents.push(id);
      const require = random() < 0.7 ? [libraries[Math.floor(random() * libraries.length)]] : [];
      const ws = random() < 0.1 && mods.length > 20 && !mods[mods.length - 1].multi ? mods[mods.length - 1].ws : newItem();
      mods.push({
        ws,
        id,
        name: `Content Pack ${i}`,
        lines: require.length ? [`require=${require.join(",")}`] : [],
        files: [`scripts/content${i}.txt`, `lua/client/Content${i}/main.lua`, `textures/Item_${i}.png`],
      });
    }
    for (let i = 0; i < 30; i++) {
      const target = contents[i * 7];
      mods.push({
        ws: newItem(),
        id: `${target}_Patch`,
        name: `Content Pack ${i * 7} - Patch`,
        lines: [`require=${target}`],
        files: [`lua/client/${target}/main.lua`],
      });
    }
    for (let i = 0; i < 40; i++) {
      const target = contents[i * 5 + 1];
      mods.push({
        ws: newItem(),
        id: `${target}_RU`,
        name: `Content Pack ${i * 5 + 1} RU`,
        lines: [`require=${target}`],
        files: [`lua/shared/Translate/RU/UI_RU.json`, `lua/shared/Translate/RU/Items_RU.json`],
      });
    }
    for (let i = 0; i < 6; i++) {
      mods.push({ ws: newItem(), id: `Map${i}`, name: `Town ${i}`, files: [`maps/Town ${i}/0_0.lotheader`, `maps/Town ${i}/objects.lua`] });
    }
    // The usual breakage: a missing dependency, a require= loop, an empty require=.
    mods.push({ ws: newItem(), id: "NeedsGhost", lines: ["require=GhostLib"], files: ["scripts/g.txt"] });
    mods.push({ ws: newItem(), id: "LoopA", lines: ["require=LoopB"], files: ["scripts/la.txt"] });
    mods.push({ ws: newItem(), id: "LoopB", lines: ["require=LoopA"], files: ["scripts/lb.txt"] });
    mods.push({ ws: newItem(), id: "EmptyReq", lines: ["require="], files: ["scripts/e.txt"] });
    for (const mod of mods) addMod(mod.ws, mod.id, mod);
    expect(mods.length).toBeGreaterThanOrEqual(390);

    const order = [...mods.map((m) => m.id)];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const items = [...new Set(mods.map((m) => m.ws))];
    const mapLine = ["Town 0", "Town 1", "Town 2", "Muldraugh, KY"];
    fx.writeIni(`Mods=${order.join(";")}\nWorkshopItems=${items.join(";")}\nMap=${mapLine.join(";")}\n`);
    const state = await db.getDb();
    state.data.mod_groups = [
      { id: "libs", name: "Libraries", modIds: libraries, placement: "first", keepTogether: false, createdAt: "x", updatedAt: "x" },
      { id: "fixes", name: "Fixes", modIds: mods.filter((m) => m.id.endsWith("_Patch")).map((m) => m.id), placement: "last", createdAt: "x", updatedAt: "x" },
    ];

    let started = performance.now();
    const plan = (await call("/load-order/plan", "post")).getBody();
    const planMs = performance.now() - started;
    expect(plan.order).toHaveLength(order.length);
    expect(plan.stats.ms).toBeLessThan(150);
    const at = new Map(plan.order.map((id, i) => [id, i]));
    for (const mod of mods) {
      for (const line of mod.lines || []) {
        if (!line.startsWith("require=")) continue;
        for (const dep of line.slice(8).split(",").filter(Boolean)) {
          if (!at.has(dep) || dep.startsWith("Loop") || mod.id.startsWith("Loop")) continue;
          expect(at.get(dep), `${dep} before ${mod.id}`).toBeLessThan(at.get(mod.id));
        }
      }
    }
    // Libraries placed first, patches last, translations after what they translate.
    expect(Math.max(...libraries.map((id) => at.get(id)))).toBeLessThan(libraries.length);
    expect(at.get("Content1_RU")).toBeGreaterThan(at.get("Content1"));
    expect(plan.cycles.some((c) => c.gameCrash)).toBe(true);

    started = performance.now();
    const health = (await call("/health", "get")).getBody();
    const healthMs = performance.now() - started;
    const kinds = new Set(health.issues.map((i) => i.kind));
    for (const kind of ["requireLoop", "modInfoBroken", "requiredNotInstalled", "mapNotInMapLine", "orderProblems"]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    expect(health.issues.find((i) => i.kind === "mapNotInMapLine").params.folders).toEqual(expect.arrayContaining([expect.stringMatching(/^Town [345]$/)]));

    started = performance.now();
    const insights = (await call("/insights", "get")).getBody();
    const insightsMs = performance.now() - started;
    expect(insights.mods.Lib0.kind).toBe("library");
    expect(insights.mods.Content1_RU.kind).toBe("translation");
    expect(insights.mods.Content0_Patch).toMatchObject({ kind: "patch", patchOf: ["Content0"] });
    expect(insights.mods.Map0.kind).toBe("map");
    expect(insights.constraints.length).toBeGreaterThan(200);

    // First reads walk every mod folder; a loaded machine is slow, the
    // ceiling is generous. The pure planner itself is held to 150 ms above.
    expect(planMs + healthMs + insightsMs).toBeLessThan(30_000);

    // Applying the plan through the health fix, then nothing is left to move.
    const orderIssue = health.issues.find((i) => i.kind === "orderProblems");
    expect((await call("/health/fix", "post", { body: { issueId: orderIssue.id, action: "applyPlan" } })).getBody().applied).toBe(true);
    const again = (await call("/load-order/plan", "post")).getBody();
    expect(again.changed).toBe(false);
  });
});
