import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";
import { applyModGroups, groupsInOrder, keepTogetherForcedApart } from "../utils/modGroups.js";

// A group kept together yields to hard constraints, under ONE rule the
// load-order planner and the group enforcement of POST /save-order share
// (modGroups.js keepTogetherForcedApart): saving the plan's order leaves it as
// planned, and GET /groups/status reports such a group as kept apart, not
// out of order. Real database, real routers, real Workshop folders.
const db = await import("../database/init.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { default: smartRouter } = await import("../routes/modsSmart.js");
const { _resetSteamKnowledgeForTests } = await import("../services/modSteamKnowledge.js");
const runMods = createRouteRunner(modsRouter);
const runSmart = createRouteRunner(smartRouter);
const ADMIN = { username: "alice", role: "admin" };

let fx;

beforeAll(async () => {
  await db.initDatabase();
});

beforeEach(async () => {
  const state = await db.getDb();
  state.data.mod_groups = [];
  state.data.mod_order_rules = [];
  delete state.data.settings.modGroupsEnforce;
  fx = makeServerFixture({ prefix: "mods-forced-apart-", ini: "Mods=\nWorkshopItems=\n" });
  state.data.servers = [{ ...fx.activeServer, name: "Test", isActive: true }];
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("offline");
  }));
  _resetSteamKnowledgeForTests();
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

const modInfo = (id, require) => `name=${id}\nid=${id}\n${require ? `require=${require}\n` : ""}`;

async function keepTogether(...modIds) {
  const state = await db.getDb();
  state.data.mod_groups = [
    { id: "g", name: "Pack", description: "", modIds, keepTogether: true, placement: null, createdAt: "x", updatedAt: "x" },
  ];
}

describe("plan, save, status agree on a group kept apart by require=", () => {
  beforeEach(async () => {
    // Mid require=s G1 and G2 require=s Mid: Mid must load between them.
    fx.writeMod("6000", "G1", modInfo("G1"), "42");
    fx.writeMod("6001", "Mid", modInfo("Mid", "G1"), "42");
    fx.writeMod("6002", "G2", modInfo("G2", "Mid"), "42");
    fx.writeMod("6003", "Other", modInfo("Other"), "42");
    fx.writeIni("Mods=G2;Other;G1;Mid\nWorkshopItems=6000;6001;6002;6003\n");
    await keepTogether("G1", "G2");
  });

  it("saving the plan's order through POST /save-order leaves it as planned", async () => {
    const plan = (await runSmart("/load-order/plan", "post", { user: ADMIN, body: {} })).getBody();
    expect(plan.order.filter((id) => id !== "Other")).toEqual(["G1", "Mid", "G2"]);
    expect(plan.warnings).toEqual([{ code: "keepTogetherBroken", params: { group: "g", groupName: "Pack", mods: ["Mid"] } }]);

    const saved = await runMods("/save-order", "post", { body: { modIds: plan.order } });
    expect(saved.getStatusCode()).toBe(200);
    expect(saved.getBody()).toMatchObject({ groupsAdjusted: [], groupConflicts: [] });
    expect(fx.iniValue("Mods")).toBe(plan.order.join(";"));

    const status = (await runMods("/groups/status", "get", {})).getBody();
    expect(status).toEqual({
      groups: [{ id: "g", inOrder: true, present: 2, total: 2, missing: [], forcedApart: ["Mid"] }],
      inOrder: true,
      conflicts: [],
    });
    const applied = (await runMods("/groups/apply", "post", { body: {} })).getBody();
    expect(applied).toMatchObject({ changed: false, written: false, conflicts: [] });

    const again = (await runSmart("/load-order/plan", "post", { user: ADMIN, body: {} })).getBody();
    expect(again.changed).toBe(false);
  });

  it("still keeps the group's order, and gathers it again once nothing forces a mod between", async () => {
    fx.writeIni("Mods=G2;Mid;G1\nWorkshopItems=6000;6001;6002\n");
    const status = (await runMods("/groups/status", "get", {})).getBody();
    expect(status.groups[0]).toMatchObject({ inOrder: false, forcedApart: ["Mid"] });

    fx.writeMod("6001", "Mid", modInfo("Mid"), "42");
    fx.writeIni("Mods=G1;Mid;G2\nWorkshopItems=6000;6001;6002\n");
    const saved = await runMods("/save-order", "post", { body: { modIds: ["G1", "Mid", "G2"] } });
    expect(saved.getBody().groupsAdjusted).toEqual(["G2", "Mid"]);
    expect(fx.iniValue("Mods")).toBe("G1;G2;Mid");
  });
});

describe("an order rule keeps a group apart the same way", () => {
  it("plan and save agree", async () => {
    for (const [ws, id] of [["7000", "A"], ["7001", "X"], ["7002", "B"]]) fx.writeMod(ws, id, modInfo(id), "42");
    fx.writeIni("Mods=A;B;X\nWorkshopItems=7000;7001;7002\n");
    await keepTogether("A", "B");
    const state = await db.getDb();
    state.data.mod_order_rules = [
      { id: "r1", before: "A", after: "X", source: "manual" },
      { id: "r2", before: "X", after: "B", source: "manual" },
    ];
    const plan = (await runSmart("/load-order/plan", "post", { user: ADMIN, body: {} })).getBody();
    expect(plan.order).toEqual(["A", "X", "B"]);
    await runMods("/save-order", "post", { body: { modIds: plan.order } });
    expect(fx.iniValue("Mods")).toBe("A;X;B");
  });
});

describe("keepTogetherForcedApart (pure)", () => {
  const groups = [{ id: "g", modIds: ["A", "B"], keepTogether: true }];
  it("finds the mods hard constraints force between the members", () => {
    expect(keepTogetherForcedApart(["A", "X", "B"], groups, [
      { before: "A", after: "X", reason: "require" },
      { before: "X", after: "B", reason: "rule" },
    ])).toEqual(new Map([["g", ["X"]]]));
    // Only one side: nothing forced.
    expect(keepTogetherForcedApart(["A", "X", "B"], groups, [{ before: "A", after: "X", reason: "require" }]).size).toBe(0);
    // Soft reasons do not count.
    expect(keepTogetherForcedApart(["A", "X", "B"], groups, [
      { before: "A", after: "X", reason: "loadAfter" },
      { before: "X", after: "B", reason: "loadAfter" },
    ]).size).toBe(0);
  });

  it("counts another group's order as hard, and lets require= beat a rule the other way", () => {
    const withOrder = [...groups, { id: "h", modIds: ["A", "X", "B"] }];
    expect(keepTogetherForcedApart(["A", "X", "B"], withOrder, []).get("g")).toEqual(["X"]);
    // A rule X before A loses to A before X (require=): no loop through it.
    expect(keepTogetherForcedApart(["A", "X", "B"], groups, [
      { before: "A", after: "X", reason: "require" },
      { before: "X", after: "A", reason: "rule" },
    ]).size).toBe(0);
  });

  it("applyModGroups and groupsInOrder follow it, and behave as before without hard edges", () => {
    const hardEdges = [
      { before: "A", after: "X", reason: "require" },
      { before: "X", after: "B", reason: "require" },
    ];
    expect(applyModGroups(["A", "X", "B"], groups, { hardEdges }).order).toEqual(["A", "X", "B"]);
    expect(applyModGroups(["A", "X", "B"], groups).order).toEqual(["A", "B", "X"]);
    expect(groupsInOrder(["A", "X", "B"], groups, { hardEdges })[0]).toMatchObject({ inOrder: true, forcedApart: ["X"] });
    expect(groupsInOrder(["A", "X", "B"], groups)[0]).not.toHaveProperty("forcedApart");
  });
});
