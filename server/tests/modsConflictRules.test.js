import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// The conflict scanner's rules follow what Build 42 really loads (the notes at
// the top of server/utils/modLoadOrder.js, read from projectzomboid.jar):
// files the game never reads are no conflicts, translations conflict key by
// key, a shared script path drops the other copies' definitions, a shared Lua
// path runs one copy, definitions and Lua globals clash across files, a
// declared patch overriding its target is intended, incompatible= pairs are
// flagged, only the folders B42 loads are compared, and winners follow the
// order the server really loads mods in.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

let fx;
let wsCounter;

beforeEach(() => {
  fx = makeServerFixture({ prefix: "mods-conflict-rules-" });
  wsCounter = 1_000_000_001;
  getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
});

afterEach(() => fx.cleanup());

/**
 * A Workshop item holding one mod. `files` maps a path inside the mod folder
 * ("42/media/lua/shared/a.lua", "media/x.txt", ...) to its content. The
 * mod.info goes to `infoDir` ("42" by default, "" for the old root layout).
 */
function addMod(id, files, { modInfo = "", infoDir = "42", wsId } = {}) {
  const workshopId = wsId || String(wsCounter++);
  const modDir = fx.writeMod(workshopId, id, `name=${id} Mod\nid=${id}\n${modInfo}`, infoDir);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(modDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return workshopId;
}

async function scan(mods, workshopIds) {
  fx.writeIni(`Mods=${mods.join(";")}\nWorkshopItems=${[...new Set(workshopIds)].join(";")}\n`);
  const res = await runRoute("/conflicts", "get", { query: {} });
  expect(res.getStatusCode()).toBe(200);
  return res.getBody();
}

// Every pair-file entry, flattened: { a, b, ...file }.
function entries(body) {
  return body.pairs.flatMap((p) => p.files.map((f) => ({ a: p.modA.modId, b: p.modB.modId, ...f })));
}
const forFile = (body, file) => entries(body).filter((e) => e.file === file);

describe("files the game never reads", () => {
  it("are not conflicts, while a real asset with the same kind of name still is", async () => {
    const files = (tag) => ({
      "42/media/readme.txt": `read me ${tag}`,
      "42/media/LICENSE.md": `license ${tag}`,
      "42/media/poster.png": `poster ${tag}`,
      "42/media/.gitkeep": tag,
      "42/media/textures/Thumbs.db": `thumbs ${tag}`,
      "42/media/desktop.ini": `ini ${tag}`,
      "42/media/ui/icon.png": `real icon ${tag}`,
    });
    const ws = [addMod("ModA", files("a")), addMod("ModB", files("b"))];
    const body = await scan(["ModA", "ModB"], ws);
    expect(entries(body).map((e) => e.file)).toEqual(["ui/icon.png"]);
    expect(body.benignSkipped.nonGameplay).toBe(6);
  });

  it("identical copies are not conflicts", async () => {
    const ws = [
      addMod("ModA", { "42/media/textures/same.png": "same bytes" }),
      addMod("ModB", { "42/media/textures/same.png": "same bytes" }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(body.totalConflicts).toBe(0);
    expect(body.identicalSkipped).toBe(1);
  });
});

describe("translations merge key by key", () => {
  const file = "lua/shared/translate/en/itemname.json";

  it("conflict only on the same key with a different value, between the mods giving it", async () => {
    const ws = [
      addMod("ModA", { "42/media/lua/shared/Translate/EN/ItemName.json": JSON.stringify({ ItemName_A: "a", Shared: "same", Clash: "one" }) }),
      addMod("ModB", { "42/media/lua/shared/Translate/EN/ItemName.json": JSON.stringify({ ItemName_B: "b", Shared: "same", Clash: "two" }) }),
      addMod("ModC", { "42/media/lua/shared/Translate/EN/ItemName.json": JSON.stringify({ ItemName_C: "c", Clash: "" }) }),
    ];
    const body = await scan(["ModA", "ModB", "ModC"], ws);
    const hits = forFile(body, file);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      a: "ModA",
      b: "ModB",
      severity: "low",
      kind: "translation-override",
      reason: "translationKeyOverride",
      overlap: { kind: "translation-keys", items: ["Clash"], total: 1 },
      winner: expect.objectContaining({ modId: "ModB" }),
    });
  });

  it("two mods shipping the same file name with their own keys is no conflict", async () => {
    const ws = [
      addMod("ModA", { "42/media/lua/shared/Translate/EN/UI.json": JSON.stringify({ UI_A: "a" }) }),
      addMod("ModB", { "42/media/lua/shared/Translate/EN/UI.json": JSON.stringify({ UI_B: "b" }) }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(body.totalConflicts).toBe(0);
    expect(body.pzAdditiveBreakdown.translate).toBe(1);
  });

  it("a .lua file under Translate/ is Lua, run like any other", async () => {
    const ws = [
      addMod("ModA", { "42/media/lua/shared/Translate/EN/patch.lua": "-- a\n" }),
      addMod("ModB", { "42/media/lua/shared/Translate/EN/patch.lua": "-- b\n" }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(forFile(body, "lua/shared/translate/en/patch.lua")).toEqual([
      expect.objectContaining({ severity: "high", reason: "luaFileOverride" }),
    ]);
  });

  it("B41 .txt translations are never read by B42", async () => {
    const ws = [
      addMod("ModA", { "42/media/lua/shared/Translate/EN/UI_EN.txt": 'UI_EN = {\n  UI_X = "a",\n}\n' }),
      addMod("ModB", { "42/media/lua/shared/Translate/EN/UI_EN.txt": 'UI_EN = {\n  UI_X = "b",\n}\n' }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(body.totalConflicts).toBe(0);
    expect(body.benignSkipped.notLoaded).toBe(1);
  });
});

describe("scripts", () => {
  it("a shared script path drops the other copy's definitions (high)", async () => {
    const ws = [
      addMod("ModA", { "42/media/scripts/items.txt": "module ModA { item Foo { Weight = 1, } }" }),
      addMod("ModB", { "42/media/scripts/items.txt": "module ModB { item Bar { Weight = 1, } }" }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(forFile(body, "scripts/items.txt")).toEqual([
      expect.objectContaining({
        severity: "high",
        kind: "script-file-override",
        reason: "scriptFileReplaced",
        overlap: { kind: "script-defs", items: ["ModA.item.Foo"], total: 1 },
        winner: expect.objectContaining({ modId: "ModB" }),
      }),
    ]);
  });

  it("the same definitions written differently are no conflict", async () => {
    const ws = [
      addMod("ModA", { "42/media/scripts/items.txt": "module Base {\n  item Foo\n  {\n    Weight = 1,\n  }\n}\n" }),
      addMod("ModB", { "42/media/scripts/items.txt": "/* same */ module Base { item Foo { Weight = 1, } }" }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(body.totalConflicts).toBe(0);
    expect(body.benignSkipped.sameDefinitions).toBe(1);
  });

  it("the same item redefined from different files is an override; an identical body is not", async () => {
    const axe = (damage) => `module Base { item Axe { DisplayName = Axe, MaxDamage = ${damage}, } }`;
    const ws = [
      addMod("ModA", { "42/media/scripts/a_axe.txt": axe(2) }),
      addMod("ModB", { "42/media/scripts/b_axe.txt": axe(3) }),
      addMod("ModC", { "42/media/scripts/c_axe.txt": axe(3) }),
      addMod("ModD", { "42/media/scripts/d_new.txt": "module Base { item Hatchet2 { MaxDamage = 1, } }" }),
    ];
    const body = await scan(["ModA", "ModB", "ModC", "ModD"], ws);
    const hits = entries(body).filter((e) => e.kind === "script-override");
    expect(hits.map((e) => `${e.a}-${e.b}`).sort()).toEqual(["ModA-ModB", "ModA-ModC"]);
    for (const hit of hits) {
      expect(hit).toMatchObject({
        severity: "medium",
        reason: "scriptDefinitionOverride",
        overlap: { kind: "script-defs", items: ["Base.item.Axe"], total: 1 },
        winner: expect.objectContaining({ modId: "ModC" }),
      });
    }
  });

  it("vehicle bodies are layered by the game, not replaced: only a key both set differently clashes (low)", async () => {
    const ws = [
      addMod("ModA", { "42/media/scripts/a.txt": "module Base { vehicle Van { mass = 800, engineForce = 3000, } }" }),
      addMod("ModB", { "42/media/scripts/b.txt": "module Base { vehicle Van { mass = 900, engineForce = 3000, part Door { x = 1, } } }" }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(entries(body)).toEqual([
      expect.objectContaining({
        severity: "low",
        reason: "scriptDefinitionMerge",
        overlap: { kind: "script-defs", items: ["Base.vehicle.Van › mass"], total: 1 },
        winner: expect.objectContaining({ modId: "ModB" }),
      }),
    ]);
  });

  // Seen live: Neat Building's generated entity scripts and Rocco's Tiles each
  // add their own entity style to "xuiSkin default" (and the entity's
  // UiConfig only references the skin): the game layers xuiSkin bodies, so
  // this was never a "definition clash".
  it("two mods adding their own entity styles to xuiSkin default is no conflict", async () => {
    const neat = `module Base
{
\txuiSkin default
\t{
\t\tentity ES_Wood_YellowPanelWindowFrame
\t\t{
\t\t\tLuaWindowClass\t= ISEntityWindow,
\t\t\tDisplayName\t= NBEntityName_YellowPanelWindowFrame,
\t\t\tIcon\t\t= Build_walls_exterior_house_02_41,
\t\t}
\t}

    entity Wood_YellowPanelWindowFrame
    {
        component UiConfig
        {
            xuiSkin         = default,
            entityStyle     = ES_Wood_YellowPanelWindowFrame,
            uiEnabled       = false,
        }
    }
}
`;
    const rocco = `module Base
{
    xuiSkin default
    {
        entity RT_WaterDispenser
        {
            LuaWindowClass = ISEntityTabWindow,
            DisplayName = Water Dispenser,
            Icon = Item_WaterTank,
        }
    }
}
`;
    const ws = [
      addMod("Neat_Building", { "42/media/scripts/generated/entities/neat_expand/windows/WindowFrame/entity_wood_yellowpanelwindowframe.txt": neat }),
      addMod("Roccos_Tiles", { "42/media/scripts/entities/appliances/entity_rt_waterdispenser_xuiSkin.txt": rocco }),
    ];
    const body = await scan(["Neat_Building", "Roccos_Tiles"], ws);
    expect(body.totalConflicts).toBe(0);
    expect(body.benignSkipped.layeredAdditions).toBe(1);
  });

  it("the same entity style styled differently in xuiSkin default is a low clash on that style only", async () => {
    const skin = (icon, extra = "") => `module Base { xuiSkin default { entity ES_Shared { Icon = ${icon}, } ${extra} } }`;
    const ws = [
      addMod("ModA", { "42/media/scripts/a_skin.txt": skin("A", "entity ES_OnlyA { Icon = X, }") }),
      addMod("ModB", { "42/media/scripts/b_skin.txt": skin("B", "entity ES_OnlyB { Icon = Y, }") }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(entries(body)).toEqual([
      expect.objectContaining({
        severity: "low",
        reason: "scriptDefinitionMerge",
        overlap: { kind: "script-defs", items: ["Base.xuiskin.default › entity ES_Shared"], total: 1 },
      }),
    ]);
  });
});

describe("Lua", () => {
  it("a shared Lua path is a real override even without shared names (high)", async () => {
    const ws = [
      addMod("ModA", { "42/media/lua/client/ui.lua": "local function a() end\n" }),
      addMod("ModB", { "42/media/lua/client/ui.lua": "local function b() end\n" }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(forFile(body, "lua/client/ui.lua")).toEqual([
      expect.objectContaining({ severity: "high", kind: "lua-override", reason: "luaFileOverride" }),
    ]);
  });

  it("a global redefined from different files clashes (medium); locals, chained hooks and events do not", async () => {
    const shared = [
      "local function helper() end",
      "local orig = ISInventoryPane.refresh",
      "function ISInventoryPane:refresh(...) return orig(self, ...) end",
      "Events.OnTick.Add(helper)",
    ].join("\n");
    const ws = [
      addMod("ModA", { "42/media/lua/client/a.lua": `${shared}\nfunction SharedGlobalFn() end\n` }),
      addMod("ModB", { "42/media/lua/client/b.lua": `${shared}\nfunction SharedGlobalFn() end\n` }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(entries(body)).toEqual([
      expect.objectContaining({
        file: "lua/client/a.lua ↔ lua/client/b.lua",
        severity: "medium",
        kind: "lua-global-clash",
        reason: "luaGlobalRedefined",
        overlap: { kind: "lua-symbols", items: ["fn:SharedGlobalFn"], total: 1 },
      }),
    ]);
  });
});

describe("intended patches and declared incompatibilities", () => {
  it("a mod that require=s its target and overrides it is intended (info)", async () => {
    const ws = [
      addMod("Target", { "42/media/lua/shared/core.lua": "-- original\n" }),
      addMod("Patch", { "42/media/lua/shared/core.lua": "-- patched\n" }, { modInfo: "require=\\Target\n" }),
    ];
    const body = await scan(["Patch", "Target"], ws);
    expect(forFile(body, "lua/shared/core.lua")).toEqual([
      expect.objectContaining({
        severity: "info",
        reason: "intendedPatch",
        baseReason: "luaFileOverride",
        intended: true,
        winner: expect.objectContaining({ modId: "Patch" }),
      }),
    ]);
    expect(body.pairs[0].infoCount).toBe(1);
    expect(body.severityCounts.info).toBe(1);
  });

  it("a loadModAfter= patch listed before its target loses its changes (high)", async () => {
    const ws = [
      addMod("Target", { "42/media/lua/shared/core.lua": "-- original\n" }),
      addMod("Patch", { "42/media/lua/shared/core.lua": "-- patched\n" }, { modInfo: "loadModAfter=\\Target\n" }),
    ];
    const body = await scan(["Patch", "Target"], ws);
    expect(forFile(body, "lua/shared/core.lua")).toEqual([
      expect.objectContaining({
        severity: "high",
        reason: "patchLoadsBeforeTarget",
        intended: false,
        winner: expect.objectContaining({ modId: "Target" }),
      }),
    ]);
    expect(body.orderWarnings).toContainEqual({ code: "loadAfterViolated", severity: "medium", modId: "Patch", other: "Target" });
  });

  it("incompatible= pairs that both load are a high conflict", async () => {
    const ws = [
      addMod("ModA", {}, { modInfo: "incompatible=\\ModB\n" }),
      addMod("ModB", { "42/media/textures/b.png": "b" }),
    ];
    // A mod folder needs a media/ folder to be scanned.
    fs.mkdirSync(path.join(fx.workshopFolder(ws[0]), "mods", "ModA", "42", "media"), { recursive: true });
    const body = await scan(["ModA", "ModB"], ws);
    expect(entries(body)).toEqual([
      expect.objectContaining({
        file: "mod.info",
        severity: "high",
        kind: "declared-incompatible",
        reason: "declaredIncompatible",
      }),
    ]);
  });
});

describe("only the folders B42 loads are compared", () => {
  it("ignores a B41 root media/ next to B42 folders", async () => {
    const ws = [
      addMod("ModA", {
        "media/lua/shared/x.lua": "-- B41 copy\n",
        "42/media/lua/shared/x.lua": "-- B42 copy\n",
      }),
      addMod("ModB", { "42/media/lua/shared/x.lua": "-- B42 copy\n" }),
    ];
    const body = await scan(["ModA", "ModB"], ws);
    expect(body.totalConflicts).toBe(0);
  });

  it("uses the version folder's copy over common/ and only the newest 42.x folder", async () => {
    const ws = [
      addMod("ModA", {
        "common/media/textures/t.png": "common",
        "42/media/textures/t.png": "version",
        "42/media/lua/shared/y.lua": "-- 42.0\n",
        "42.5/media/lua/shared/y.lua": "-- 42.5\n",
      }, { infoDir: "42.5" }),
      addMod("ModB", {
        "42/media/textures/t.png": "version",
        "42/media/lua/shared/y.lua": "-- 42.5\n",
      }),
    ];
    // ModA's game folders: common/ and 42.5/ (not 42/).
    fs.rmSync(path.join(fx.workshopFolder(ws[0]), "mods", "ModA", "42", "media", "textures"), { recursive: true });
    fs.mkdirSync(path.join(fx.workshopFolder(ws[0]), "mods", "ModA", "42.5", "media", "textures"), { recursive: true });
    fs.writeFileSync(path.join(fx.workshopFolder(ws[0]), "mods", "ModA", "42.5", "media", "textures", "t.png"), "version");
    const body = await scan(["ModA", "ModB"], ws);
    expect(body.totalConflicts).toBe(0);
  });
});

describe("winners follow the order the server really loads", () => {
  it("a required mod loads first wherever Mods= lists it", async () => {
    const ws = [
      addMod("ModA", { "42/media/textures/t.png": "a" }),
      addMod("ModB", { "42/media/textures/t.png": "b" }),
      addMod("ModC", { "42/media/textures/c.png": "c" }, { modInfo: "require=\\ModA\n" }),
    ];
    const body = await scan(["ModC", "ModB", "ModA"], ws);
    expect(body.effectiveModOrder).toEqual(["ModA", "ModC", "ModB"]);
    expect(forFile(body, "textures/t.png")).toEqual([
      expect.objectContaining({ winner: expect.objectContaining({ modId: "ModB" }) }),
    ]);
    expect(body.modLoadOrder).toEqual(["ModC", "ModB", "ModA"]);
  });

  it("scans a required mod the game loads although Mods= does not list it", async () => {
    const ws = [
      addMod("ModA", { "42/media/textures/t.png": "a" }),
      addMod("ModB", { "42/media/textures/t.png": "b" }),
      addMod("ModC", { "42/media/textures/c.png": "c" }, { modInfo: "require=\\ModA\n" }),
    ];
    const body = await scan(["ModC", "ModB"], ws);
    expect(body.effectiveModOrder).toEqual(["ModA", "ModC", "ModB"]);
    expect(forFile(body, "textures/t.png")).toHaveLength(1);
    expect(body.orderWarnings).toContainEqual({ code: "requireAutoLoaded", severity: "info", modId: "ModC", dependency: "ModA" });
    expect(body.orderingConstraints).toContainEqual({ before: "ModA", after: "ModC", reason: "require", declaredBy: "ModC" });
  });
});

describe("GET /conflicts/stream", () => {
  it("completes with the same rule fields as GET /conflicts", async () => {
    const ws = [
      addMod("ModA", { "42/media/lua/client/ui.lua": "-- a\n" }),
      addMod("ModB", { "42/media/lua/client/ui.lua": "-- b\n" }),
    ];
    fx.writeIni(`Mods=ModA;ModB\nWorkshopItems=${ws.join(";")}\n`);
    const layer = router.stack.find((l) => l.route?.path === "/conflicts/stream");
    const chunks = [];
    const res = {
      writable: true,
      writeHead() {},
      flushHeaders() {},
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
      end() {},
      status() {
        return this;
      },
      json() {
        return this;
      },
    };
    await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, on() {} }, res, () => {});
    const complete = chunks.find((c) => c.startsWith("event: complete"));
    const result = JSON.parse(complete.split("\ndata: ")[1]);
    expect(result.effectiveModOrder).toEqual(["ModA", "ModB"]);
    expect(result.pairs[0].files[0]).toMatchObject({ kind: "lua-override", reason: "luaFileOverride", severity: "high" });
  });
});
