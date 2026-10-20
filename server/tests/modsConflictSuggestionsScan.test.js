import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// The conflict scan's pairs carry a suggested winner when the panel has a
// reason (utils/modConflictSuggestions.js), and the cached result answers an
// order rule stored after the scan (the way the UI resolves a conflict).
// Real database, real mods router, real Workshop folders.
const db = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const { default: smartRouter } = await import("../routes/modsSmart.js");
const { _resetSteamKnowledgeForTests } = await import("../services/modSteamKnowledge.js");
const runRoute = createRouteRunner(router);
const runSmart = createRouteRunner(smartRouter);

let fx;
let ws;

beforeAll(async () => {
  await db.initDatabase();
});

beforeEach(async () => {
  const state = await db.getDb();
  state.data.mod_order_rules = [];
  fx = makeServerFixture({ prefix: "mods-conflict-suggest-" });
  state.data.servers = [{ ...fx.activeServer, name: "Test", isActive: true }];
  ws = 3_000_000_001;
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
  state.data.mod_order_rules = [];
  state.data.servers = [];
});

function addMod(id, files, modInfo = "") {
  const workshopId = String(ws++);
  const dir = fx.writeMod(workshopId, id, `name=${id}\nid=${id}\n${modInfo}`, "42");
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, "42", "media", rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return workshopId;
}

const pairOf = (body, a, b) => body.pairs.find((p) => [p.modA.modId, p.modB.modId].sort().join("|") === [a, b].sort().join("|"));

describe("conflict scan suggestions", () => {
  it("suggests the dependent, then answers a rule stored after the scan", async () => {
    const items = [
      addMod("Base", { "lua/client/shared.lua": "base" }),
      addMod("Patch", { "lua/client/shared.lua": "patch" }, "require=Base"),
      addMod("Left", { "lua/client/other.lua": "left" }),
      addMod("Right", { "lua/client/other.lua": "right" }),
    ];
    fx.writeIni(`Mods=Base;Patch;Left;Right\nWorkshopItems=${items.join(";")}\n`);
    const res = await runRoute("/conflicts", "get", { query: {} });
    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(pairOf(body, "Base", "Patch").suggestion).toEqual({
      winner: "Patch",
      confidence: "high",
      reason: "requiresOther",
      alreadyWinning: true,
    });
    expect(pairOf(body, "Left", "Right")).not.toHaveProperty("suggestion");

    // Resolving in the UI: Left should win over Right.
    const rule = await runSmart("/order-rules", "post", {
      user: { username: "alice", role: "admin" },
      body: { before: "Right", after: "Left", source: "conflictResolve" },
    });
    expect(rule.getStatusCode()).toBe(201);
    const cached = (await runRoute("/conflicts/cached", "get", { query: {} })).getBody();
    expect(pairOf(cached, "Left", "Right").suggestion).toEqual({
      winner: "Left",
      confidence: "high",
      reason: "rule",
      alreadyWinning: false,
      params: { ruleId: rule.getBody().rule.id },
    });
  });
});
