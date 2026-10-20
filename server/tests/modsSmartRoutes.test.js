import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// The smart load-order routes (routes/modsSmart.js): order rules, the plan,
// the health check and its fixes, and the insights. Real, unmocked database,
// real ini and Workshop folders on disk, Steam answered from a seeded cache
// (fetch is stubbed: no network).
const db = await import("../database/init.js");
const { default: router } = await import("../routes/modsSmart.js");
const { getDataPaths } = await import("../utils/paths.js");
const { _resetSteamKnowledgeForTests } = await import("../services/modSteamKnowledge.js");
const { clearContentProfileCache } = await import("../utils/modContentProfile.js");
const runRoute = createRouteRunner(router);

const ADMIN = { username: "alice", role: "admin" };
let fx;

beforeAll(async () => {
  await db.initDatabase();
});

beforeEach(async () => {
  const state = await db.getDb();
  state.data.mod_groups = [];
  state.data.mod_order_rules = [];
  state.data.tracked_mods = [];
  fx = makeServerFixture({ prefix: "mods-smart-", ini: "Mods=\nWorkshopItems=\n" });
  state.data.servers = [{ ...fx.activeServer, name: "Test", isActive: true }];
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("offline");
  }));
  fs.rmSync(path.join(getDataPaths().dataDir, "mod-steam-meta.json"), { force: true });
  _resetSteamKnowledgeForTests();
  clearContentProfileCache();
});

afterEach(() => {
  fx.cleanup();
  vi.unstubAllGlobals();
  _resetSteamKnowledgeForTests();
});

afterAll(async () => {
  const state = await db.getDb();
  state.data.mod_groups = [];
  state.data.mod_order_rules = [];
  state.data.servers = [];
  state.data.tracked_mods = [];
});

const call = (routePath, method, req = {}) => runRoute(routePath, method, { user: ADMIN, query: {}, params: {}, body: {}, ...req });

/**
 * A mod in Workshop item `ws`: mod.info in `infoDir` (Build 42: "42"; "" is
 * the B41 root layout), `lines` added to it, `files` (paths inside the mod
 * folder) written too.
 */
function addMod(ws, id, { lines = [], files = {}, infoDir = "42", name = id } = {}) {
  const dir = fx.writeMod(ws, id, [`name=${name}`, `id=${id}`, ...lines, ""].join("\n"), infoDir);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function seedSteam(items) {
  const now = Date.now();
  const file = path.join(getDataPaths().dataDir, "mod-steam-meta.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema: 1,
      items: items.map((item) => ({
        workshopId: item.workshopId,
        title: item.title || null,
        tags: item.tags || [],
        modIdOrder: item.modIdOrder || [],
        requires: item.requires || [],
        requiresSource: "api",
        detailsAt: now,
        requiresAt: now,
        failedAt: null,
        usedAt: now,
      })),
    }),
  );
  _resetSteamKnowledgeForTests();
}

const issuesOf = (body, kind) => body.issues.filter((i) => i.kind === kind);

describe("order rules", () => {
  it("adds, lists, finds the duplicate, and deletes a rule", async () => {
    const created = await call("/order-rules", "post", { body: { before: "A", after: "B", note: "B's textures", source: "conflictResolve" } });
    expect(created.getStatusCode()).toBe(201);
    const { rule } = created.getBody();
    expect(rule).toMatchObject({ before: "A", after: "B", note: "B's textures", source: "conflictResolve", createdBy: "alice" });
    expect(rule.id).toEqual(expect.any(String));
    expect(rule.createdAt).toEqual(expect.any(String));

    const again = await call("/order-rules", "post", { body: { before: "A", after: "B" } });
    expect(again.getStatusCode()).toBe(200);
    expect(again.getBody()).toMatchObject({ existing: true, rule: { id: rule.id } });

    expect((await call("/order-rules", "get")).getBody()).toEqual({ rules: [rule], max: 2000 });
    expect((await call("/order-rules/:id", "delete", { params: { id: rule.id } })).getBody()).toEqual({ success: true });
    const gone = await call("/order-rules/:id", "delete", { params: { id: rule.id } });
    expect(gone.getStatusCode()).toBe(404);
    expect(gone.getBody().code).toBe("MODS_ORDER_RULE_NOT_FOUND");
  });

  it("refuses an invalid rule, naming the field", async () => {
    for (const [body, field] of [
      [{ before: "A", after: "A" }, "self"],
      [{ before: "A;B", after: "C" }, "before"],
      [{ before: "A", after: "" }, "after"],
      [{ before: "A", after: "B", source: "x" }, "source"],
      [{ before: "A", after: "B", note: 1 }, "note"],
      [{ before: "A", after: "B", replaceOpposite: "yes" }, "replaceOpposite"],
    ]) {
      const res = await call("/order-rules", "post", { body });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "MODS_ORDER_RULE_INVALID", params: { field } });
    }
  });

  it("refuses a loop with other rules or with require=, and can replace the opposite rule", async () => {
    addMod("100", "Lib");
    addMod("101", "User", { lines: ["require=Lib"] });
    fx.writeIni("Mods=Lib;User\nWorkshopItems=100;101\n");
    const viaRequire = await call("/order-rules", "post", { body: { before: "User", after: "Lib" } });
    expect(viaRequire.getStatusCode()).toBe(409);
    expect(viaRequire.getBody()).toMatchObject({
      code: "MODS_ORDER_RULE_CYCLE",
      params: { count: 2 },
      details: { cycle: ["User", "Lib", "User"] },
    });

    const first = (await call("/order-rules", "post", { body: { before: "X", after: "Y" } })).getBody().rule;
    const loop = await call("/order-rules", "post", { body: { before: "Y", after: "X" } });
    expect(loop.getStatusCode()).toBe(409);
    const replaced = await call("/order-rules", "post", { body: { before: "Y", after: "X", replaceOpposite: true, source: "conflictResolve" } });
    expect(replaced.getStatusCode()).toBe(201);
    expect(replaced.getBody().replaced).toEqual([first.id]);
    expect((await call("/order-rules", "get")).getBody().rules.map((r) => `${r.before}>${r.after}`)).toEqual(["Y>X"]);
  });

  it("keeps at most 2000 rules", async () => {
    const state = await db.getDb();
    state.data.mod_order_rules = Array.from({ length: 2000 }, (_, i) => ({ id: `r${i}`, before: `a${i}`, after: `b${i}`, source: "manual" }));
    const res = await call("/order-rules", "post", { body: { before: "new1", after: "new2" } });
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "MODS_ORDER_RULE_LIMIT", params: { max: 2000 } });
  });
});

describe("POST /load-order/plan", () => {
  beforeEach(() => {
    addMod("100", "Lib", { files: { "42/media/lua/shared/lib.lua": "x" } });
    addMod("101", "User", { lines: ["require=Lib"], files: { "42/media/scripts/user.txt": "x" } });
    addMod("102", "Other", { files: { "42/media/scripts/other.txt": "x" } });
    fx.writeIni("Mods=User;Other;\\Lib\nWorkshopItems=100;101;102\n");
  });

  it("plans the saved order by default and writes nothing", async () => {
    const res = await call("/load-order/plan", "post", { body: {} });
    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.order).toEqual(["Lib", "User", "Other"]);
    expect(body.changed).toBe(true);
    expect(body.moves).toEqual([
      { modId: "Lib", from: 2, to: 0, reasons: [{ code: "require", params: { relation: "before", other: "User" } }], confidence: "high" },
    ]);
    expect(body.explanations.User).toContainEqual({ code: "require", params: { relation: "after", other: "Lib" } });
    expect(body).toMatchObject({ satisfied: 1, unsatisfied: [], cycles: [], warnings: [], winnersChanged: [] });
    expect(body.steamStatus).toMatchObject({ known: 0, total: 3 });
    expect(fx.backups()).toEqual([]);
    expect(fx.iniValue("Mods")).toBe("User;Other;\\Lib");
  });

  it("plans a given order, with rules, groups and their placement, tiered when asked", async () => {
    const state = await db.getDb();
    state.data.mod_order_rules = [{ id: "r1", before: "Other", after: "User", source: "manual" }];
    state.data.mod_groups = [{ id: "g1", name: "Late", modIds: ["Lib"], placement: "last", createdAt: "x", updatedAt: "x" }];
    const res = await call("/load-order/plan", "post", { body: { order: ["Other", "Lib", "User"] } });
    const body = res.getBody();
    // Lib must stay before User (require=), User after Other (rule).
    expect(body.order).toEqual(["Other", "Lib", "User"]);
    expect(body.explanations.User).toContainEqual({ code: "rule", params: { relation: "after", other: "Other", ruleId: "r1" } });
    const tiered = (await call("/load-order/plan", "post", { body: { mode: "tiered", groups: false } })).getBody();
    expect(tiered.stats.soft).toBe(3);
    expect(tiered.order.indexOf("Lib")).toBeLessThan(tiered.order.indexOf("User"));
  });

  it("refuses a malformed body, naming the field", async () => {
    for (const [body, field] of [
      [{ order: "Lib" }, "order"],
      [{ order: ["ok", "bad;id"] }, "order"],
      [{ order: Array.from({ length: 2001 }, (_, i) => `m${i}`) }, "order"],
      [{ mode: "fast" }, "mode"],
      [{ groups: "no" }, "groups"],
      [{ conflictPairs: [["a"]] }, "conflictPairs"],
      [{ conflictPairs: "x" }, "conflictPairs"],
    ]) {
      const res = await call("/load-order/plan", "post", { body });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "MODS_PLAN_INVALID", params: { field } });
    }
  });

  it("keeps the winner of a conflict pair it is given", async () => {
    const body = (await call("/load-order/plan", "post", { body: { order: ["User", "Other", "Lib"], conflictPairs: [["Other", "Lib"]] } })).getBody();
    expect(body.order).toEqual(["Other", "Lib", "User"]);
    expect(body.winnersChanged).toEqual([]);
  });
});

describe("GET /health and POST /health/fix", () => {
  async function health() {
    const res = await call("/health", "get");
    expect(res.getStatusCode()).toBe(200);
    return res.getBody();
  }
  async function fix(issue, action, params) {
    return call("/health/fix", "post", { body: { issueId: issue.id, action, ...(params !== undefined ? { params } : {}) } });
  }

  it("finds a required mod in no installed item, and adds the downloaded item that ships it", async () => {
    addMod("200", "User", { lines: ["require=Lib"] });
    addMod("201", "Lib"); // downloaded, not in WorkshopItems=
    fx.writeIni("Mods=User\nWorkshopItems=200\n");
    const body = await health();
    const [issue] = issuesOf(body, "requiredNotInstalled");
    expect(issue).toMatchObject({
      severity: "critical",
      modIds: ["User"],
      params: { missing: "Lib", requiredBy: ["User"], affected: ["User"] },
      fixes: [{ action: "addWorkshopItems", params: { workshopIds: ["201"], modIds: ["Lib"], before: "User" } }],
    });
    expect(body.counts.critical).toBeGreaterThanOrEqual(1);

    const res = await fix(issue, "addWorkshopItems");
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().applied).toBe(true);
    expect(fx.iniValue("WorkshopItems")).toBe("200;201");
    expect(fx.iniValue("Mods")).toBe("Lib;User");
    expect(fx.backups()).toHaveLength(1);
    expect(issuesOf(res.getBody().health, "requiredNotInstalled")).toEqual([]);

    const stale = await fix(issue, "addWorkshopItems");
    expect(stale.getStatusCode()).toBe(404);
    expect(stale.getBody().code).toBe("MODS_HEALTH_ISSUE_GONE");
  });

  it("reports a mod.info that keeps a mod from loading (no automatic fix)", async () => {
    addMod("300", "Broken", { lines: ["require="] });
    fx.writeIni("Mods=Broken\nWorkshopItems=300\n");
    const [issue] = issuesOf(await health(), "modInfoBroken");
    expect(issue).toMatchObject({
      severity: "critical",
      modIds: ["Broken"],
      params: { modId: "Broken", field: "require", entry: "", issue: "emptyEntry" },
      fixes: [],
    });
  });

  it("reports a require= loop with one disable fix per listed mod in it", async () => {
    addMod("400", "A", { lines: ["require=B"] });
    addMod("401", "B", { lines: ["require=A"] });
    fx.writeIni("Mods=A;B\nWorkshopItems=400;401\n");
    const [issue] = issuesOf(await health(), "requireLoop");
    expect(issue.severity).toBe("critical");
    expect(issue.fixes.map((f) => f.params.modIds)).toEqual([["A"], ["B"]]);
    const res = await fix(issue, "removeMods", { modIds: ["B"] });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe("A");
  });

  it("only applies a fix the issue offers", async () => {
    addMod("400", "A", { lines: ["require=B"] });
    addMod("401", "B", { lines: ["require=A"] });
    fx.writeIni("Mods=A;B\nWorkshopItems=400;401\n");
    const [issue] = issuesOf(await health(), "requireLoop");
    for (const [action, params] of [
      ["removeMods", undefined],
      ["removeMods", { modIds: ["Elsewhere"] }],
      ["addMapFolders", { folders: ["X"] }],
    ]) {
      const res = await fix(issue, action, params);
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().code).toBe("MODS_HEALTH_FIX_NOT_OFFERED");
    }
    for (const [body, field] of [
      [{ issueId: "nope", action: "removeMods" }, "issueId"],
      [{ issueId: issue.id, action: "rewriteIni" }, "action"],
      [{ issueId: issue.id, action: "removeMods", params: ["x"] }, "params"],
    ]) {
      const res = await call("/health/fix", "post", { body });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "MODS_HEALTH_FIX_INVALID", params: { field } });
    }
    expect(fx.iniValue("Mods")).toBe("A;B");
    expect(fx.backups()).toEqual([]);
  });

  it("reports Mods= ids no installed item ships, and a B41-only mod", async () => {
    addMod("500", "OldMod", { infoDir: "" });
    addMod("501", "Fine");
    fx.writeIni("Mods=Ghost;OldMod;Fine\nWorkshopItems=500;501\n");
    const body = await health();
    const [ghost] = issuesOf(body, "notInstalled");
    expect(ghost).toMatchObject({ severity: "warning", modIds: ["Ghost"], fixes: [{ action: "removeMods", params: { modIds: ["Ghost"] } }] });
    const [old] = issuesOf(body, "b41Only");
    expect(old).toMatchObject({ modIds: ["OldMod"], workshopIds: ["500"], fixes: [{ action: "removeMods" }] });
    const removed = await fix(old, "removeMods");
    expect(removed.getBody()).toMatchObject({ applied: true });
    expect(fx.iniValue("Mods")).toBe("Ghost;Fine");
  });

  it("offers the item that ships a Mods= id, and an unused item's removal", async () => {
    addMod("600", "Elsewhere"); // downloaded only
    addMod("601", "Used");
    addMod("602", "Idle");
    fx.writeIni("Mods=Elsewhere;Used\nWorkshopItems=601;602\n");
    const body = await health();
    const [missing] = issuesOf(body, "notInstalled");
    expect(missing.fixes.map((f) => f.action)).toEqual(["addWorkshopItems", "removeMods"]);
    expect(missing.params.foundIn).toBe("600");
    const [unused] = issuesOf(body, "unusedWorkshopItem");
    expect(unused).toMatchObject({ severity: "info", workshopIds: ["602"], params: { modIds: ["Idle"] } });
    await fix(unused, "removeWorkshopItems");
    expect(fx.iniValue("WorkshopItems")).toBe("601");
  });

  it("checks Map= against the maps the loaded mods ship", async () => {
    addMod("700", "TownMod", { files: { "42/media/maps/My Town/0_0.lotheader": "x" } });
    addMod("701", "Other");
    fx.writeIni("Mods=TownMod;Other\nWorkshopItems=700;701\nMap=Gone Town;Muldraugh, KY\n");
    const body = await health();
    const [notInMap] = issuesOf(body, "mapNotInMapLine");
    expect(notInMap).toMatchObject({ modIds: ["TownMod"], params: { folders: ["My Town"] } });
    const [orphan] = issuesOf(body, "mapFolderWithoutMod");
    expect(orphan).toMatchObject({ params: { folder: "Gone Town", shippedBy: [] }, fixes: [{ action: "removeMapFolders" }] });
    await fix(notInMap, "addMapFolders");
    expect(fx.iniValue("Map")).toBe("My Town;Gone Town;Muldraugh, KY");
    const after = await health();
    await fix(issuesOf(after, "mapFolderWithoutMod")[0], "removeMapFolders");
    expect(fx.iniValue("Map")).toBe("My Town;Muldraugh, KY");
  });

  it("reports order problems and applies the plan, keeping each entry as written", async () => {
    addMod("800", "Lib");
    addMod("801", "User", { lines: ["loadModAfter=Lib"] });
    fx.writeIni("Mods=\\User;Lib\nWorkshopItems=800;801\n");
    const [issue] = issuesOf(await health(), "orderProblems");
    expect(issue).toMatchObject({
      severity: "warning",
      params: { moves: 1, changesLoading: true },
      fixes: [{ action: "applyPlan", params: {} }],
    });
    const res = await fix(issue, "applyPlan");
    expect(res.getBody().applied).toBe(true);
    expect(fx.iniValue("Mods")).toBe("Lib;\\User");
    expect(issuesOf(res.getBody().health, "orderProblems")).toEqual([]);
  });

  it("an order the game fixes itself (require=) is an info, not a warning", async () => {
    addMod("810", "Lib");
    addMod("811", "User", { lines: ["require=Lib"] });
    fx.writeIni("Mods=User;Lib\nWorkshopItems=810;811\n");
    const [issue] = issuesOf(await health(), "orderProblems");
    expect(issue).toMatchObject({ severity: "info", params: { changesLoading: false } });
  });

  it("reports a required mod loaded implicitly, two items with one id, and an incompatible pair", async () => {
    addMod("900", "User", { lines: ["require=Dep"] });
    addMod("901", "Dep");
    addMod("902", "Twin");
    addMod("903", "Twin");
    addMod("904", "Rival", { lines: ["incompatible=User"] });
    fx.writeIni("Mods=Twin;User;Rival\nWorkshopItems=900;901;902;903;904\n");
    const body = await health();
    const [implicit] = issuesOf(body, "requiredLoadedImplicitly");
    expect(implicit).toMatchObject({ severity: "info", modIds: ["Dep"], fixes: [{ action: "addMods", params: { modIds: ["Dep"], before: "User" } }] });
    expect(issuesOf(body, "duplicateModId")[0]).toMatchObject({ modIds: ["Twin"], workshopIds: ["902", "903"] });
    const [incompatible] = issuesOf(body, "incompatibleEnabled");
    expect(incompatible.fixes.map((f) => f.params.modIds[0]).sort()).toEqual(["Rival", "User"]);
    await fix(implicit, "addMods");
    expect(fx.iniValue("Mods")).toBe("Twin;Dep;User;Rival");
  });

  it("reads Steam Required items from the cache and adds a missing one with the mod it needs", async () => {
    addMod("1000", "Car", { lines: ["require=tsarslib"] });
    addMod("1001", "tsarslib"); // downloaded, not listed
    addMod("1002", "Extra");
    seedSteam([{ workshopId: "1002", title: "Extra", requires: [{ workshopId: "1003", title: "Some Framework" }] }]);
    fx.writeIni("Mods=Extra\nWorkshopItems=1002\n");
    const body = await health();
    const [issue] = issuesOf(body, "requiredWorkshopItemMissing");
    expect(issue).toMatchObject({
      severity: "warning",
      workshopIds: ["1003", "1002"],
      params: { workshopId: "1003", title: "Some Framework", requiredBy: ["1002"], downloaded: false },
      fixes: [{ action: "addWorkshopItems", params: { workshopIds: ["1003"] } }],
    });
    await fix(issue, "addWorkshopItems");
    expect(fx.iniValue("WorkshopItems")).toBe("1002;1003");
  });

  it("lists updates the update checker knows of, and never touches PanelBridge's entries", async () => {
    addMod("1100", "Mine");
    fx.writeIni("Mods=Mine\nWorkshopItems=1100\n");
    const state = await db.getDb();
    state.data.tracked_mods = [{ workshop_id: "1100", name: "Mine", server_id: fx.activeServer.id, update_available: 1 }];
    const [updates] = issuesOf(await health(), "updatesAvailable");
    expect(updates).toMatchObject({ severity: "info", workshopIds: ["1100"], params: { count: 1, items: [{ workshopId: "1100", title: "Mine" }] }, fixes: [] });
  });
});

describe("GET /insights", () => {
  it("classifies the loaded mods, lists Steam Required items and every constraint", async () => {
    addMod("2000", "tsarslib", { name: "Tsar's Common Library", files: { "42/media/lua/shared/TCL.lua": "x" } });
    for (let i = 0; i < 3; i++) {
      addMod(String(2001 + i), `Car${i}`, { lines: ["require=tsarslib"], files: { [`42/media/scripts/car${i}.txt`]: "x" } });
    }
    addMod("2010", "CarTR", { files: { "42/media/lua/shared/Translate/RU/UI_RU.json": "{}" } });
    seedSteam([
      { workshopId: "2001", requires: [{ workshopId: "2000", title: "TCL" }, { workshopId: "9999", title: "Not here" }], tags: ["Vehicles"] },
      { workshopId: "2000", title: "Tsar's Common Library", tags: ["Framework"] },
    ]);
    const state = await db.getDb();
    state.data.mod_order_rules = [{ id: "r1", before: "Car0", after: "Car1", source: "manual" }];
    fx.writeIni("Mods=tsarslib;Car0;Car1;Car2;CarTR\nWorkshopItems=2000;2001;2002;2003;2010\n");
    const res = await call("/insights", "get");
    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.mods.tsarslib).toMatchObject({ workshopId: "2000", kind: "framework", kindConfidence: "high", tier: 0, dependents: 3, steamTags: ["Framework"] });
    expect(body.mods.Car0).toMatchObject({ kind: "content", requires: ["tsarslib"], steamTags: ["Vehicles"] });
    expect(body.mods.CarTR).toMatchObject({ kind: "translation", tier: 4 });
    expect(body.workshopRequirements).toEqual([
      {
        workshopId: "2001",
        title: null,
        requires: [
          { workshopId: "2000", title: "TCL", installed: true, enabled: true },
          { workshopId: "9999", title: "Not here", installed: false, enabled: false },
        ],
      },
    ]);
    const reasons = new Set(body.constraints.map((c) => c.reason));
    expect(reasons).toEqual(new Set(["require", "rule"]));
    expect(body.constraints.find((c) => c.reason === "rule")).toMatchObject({ before: "Car0", after: "Car1", strength: "hard", ruleId: "r1" });
    expect(body.steamStatus).toMatchObject({ known: 2, total: 5 });
  });
});

describe("authorization", () => {
  const routes = [
    ["/order-rules", "get"],
    ["/order-rules", "post"],
    ["/order-rules/:id", "delete"],
    ["/load-order/plan", "post"],
    ["/health", "get"],
    ["/health/fix", "post"],
    ["/insights", "get"],
  ];

  it("refuses a moderator and a request without a user on every route", async () => {
    for (const [routePath, method] of routes) {
      const asModerator = await runRoute(routePath, method, { user: { role: "moderator" }, query: {}, params: { id: "x" }, body: {} });
      expect(asModerator.getStatusCode(), `${method} ${routePath}`).toBe(403);
      const anonymous = await runRoute(routePath, method, { query: {}, params: { id: "x" }, body: {} });
      expect(anonymous.getStatusCode(), `${method} ${routePath}`).toBe(401);
    }
  });

  it("lets a technician in (mods.manage)", async () => {
    const res = await runRoute("/order-rules", "get", { user: { role: "technician" }, query: {}, params: {}, body: {} });
    expect(res.getStatusCode()).toBe(200);
  });
});
