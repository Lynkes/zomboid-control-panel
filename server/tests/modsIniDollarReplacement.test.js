import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// String.prototype.replace treats its replacement string as a template:
// `$&`, `$'`, `` $` `` and `$$` are expanded. Every Mods=/WorkshopItems=/Map=
// rewrite in routes/mods.js passed `Mods=${list}` as that string, so a mod id
// or map folder name containing one of those sequences corrupted the ini (the
// line was spliced with the text it replaced). Folder names and mod ids can
// legally contain `$` and `&`; the fix passes a replacer function at every
// site so the value is inserted literally.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getTrackedMods: vi.fn(async () => []),
  addTrackedMod: vi.fn(),
  removeTrackedMod: vi.fn(),
  clearModUpdates: vi.fn(),
  getModPresets: vi.fn(async () => []),
  createModPreset: vi.fn(),
  updateModPreset: vi.fn(),
  deleteModPreset: vi.fn(),
  addIgnoredMod: vi.fn(),
  getIgnoredMods: vi.fn(async () => []),
  removeIgnoredMod: vi.fn(),
  clearAllIgnoredMods: vi.fn(),
  isModIgnored: vi.fn(async () => false),
  getIgnoredModPairs: vi.fn(async () => []),
  addIgnoredModPair: vi.fn(),
  removeIgnoredModPair: vi.fn(),
}));

const { getActiveServer, getModPresets } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const TRICKY = "Odd$&Id$'Mod$$End";
const WS = "1111111111";

describe("Mods=/WorkshopItems=/Map= rewrites insert values literally", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({ prefix: "mods-dollar-", ini: "Mods=Alpha\nWorkshopItems=2222222222\nMap=Muldraugh, KY\n" });
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    getModPresets.mockReset().mockResolvedValue([]);
  });

  afterEach(() => fx.cleanup());

  it("POST /add-to-ini keeps a mod id with $-sequences intact", async () => {
    const res = await runRoute("/add-to-ini", "post", { body: { workshopId: WS, modId: TRICKY } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(`Alpha;${TRICKY}`);
    expect(fx.iniValue("WorkshopItems")).toBe(`2222222222;${WS}`);
  });

  it("POST /add-to-ini keeps a map folder name with $-sequences intact", async () => {
    const mapFolder = "Map$&Folder";
    const modDir = fx.writeMod(WS, "MapMod", "name=Map Mod\nid=MapMod\n");
    const mapDir = path.join(modDir, "media", "maps", mapFolder);
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(path.join(mapDir, "objects.lua"), "");

    const res = await runRoute("/add-to-ini", "post", { body: { workshopId: WS } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Map")).toBe(`${mapFolder};Muldraugh, KY`);
    expect(fx.iniValue("Mods")).toBe("Alpha;MapMod");
  });

  it("POST /toggle-mod-id and /batch-toggle-mod-ids keep the whole list intact", async () => {
    let res = await runRoute("/toggle-mod-id", "post", { body: { modId: TRICKY, enabled: true } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(`Alpha;${TRICKY}`);

    res = await runRoute("/batch-toggle-mod-ids", "post", {
      body: { changes: [{ modId: "Beta", enabled: true }] },
    });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(`Alpha;${TRICKY};Beta`);
  });

  it("POST /remove-from-ini rewrites the remaining list literally", async () => {
    fx.writeIni(`Mods=${TRICKY};Gone\nWorkshopItems=${WS};3333333333\nMap=Muldraugh, KY\n`);
    fx.writeMod(WS, "GoneMod", "name=Gone\nid=Gone\n");

    const res = await runRoute("/remove-from-ini", "post", { body: { workshopId: WS } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(TRICKY);
    expect(fx.iniValue("WorkshopItems")).toBe("3333333333");
  });

  it("POST /save-order and POST /presets/:id/apply write the ids literally", async () => {
    let res = await runRoute("/save-order", "post", { body: { modIds: [TRICKY, "Alpha"] } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(`${TRICKY};Alpha`);

    getModPresets.mockResolvedValue([
      { id: "p1", name: "P", workshop_ids: ["4444444444"], mods: ["Alpha", TRICKY] },
    ]);
    res = await runRoute("/presets/:id/apply", "post", { params: { id: "p1" }, body: {} });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(`Alpha;${TRICKY}`);
    expect(fx.iniValue("WorkshopItems")).toBe("4444444444");
  });

  it("POST /add-mod-advanced and POST /add-missing-dep write the lists literally", async () => {
    let res = await runRoute("/add-mod-advanced", "post", {
      body: { workshopId: WS, selectedModIds: [TRICKY] },
    });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(`Alpha;${TRICKY}`);
    expect(fx.iniValue("WorkshopItems")).toBe(`2222222222;${WS}`);

    res = await runRoute("/add-missing-dep", "post", { body: { workshopId: "5555555555", modId: "Dep_Mod" } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(`Alpha;${TRICKY};Dep_Mod`);
  });

  it("POST /write-to-ini writes the resolved ids literally", async () => {
    const res = await runRoute("/write-to-ini", "post", {
      body: { mods: [{ workshopId: WS, modId: TRICKY }], mapFolders: ["Map$'Folder"] },
    });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(TRICKY);
    expect(fx.iniValue("Map")).toBe("Map$'Folder;Muldraugh, KY");
  });

  it("POST /deduplicate-mod-ids writes the deduplicated list literally", async () => {
    fx.writeIni(`Mods=${TRICKY};Alpha;${TRICKY}\nWorkshopItems=\n`);
    const res = await runRoute("/deduplicate-mod-ids", "post", { body: {} });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe(`${TRICKY};Alpha`);
  });
});

describe("source guard: no string replacement templates on ini key lines", () => {
  it("every .replace() of a Mods/WorkshopItems/Map key line in routes/mods.js uses a replacer function", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "..", "routes", "mods.js"), "utf-8");
    // `.replace(/^[ \t]*Mods[ \t]*=.*/m, <not "() =>">`
    const bad = [];
    const re = /\.replace\(\s*\/\^\[ \\t\]\*(Mods|WorkshopItems|Map)\[ \\t\]\*=\.\*\/m,\s*([^\n]*)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!/^\(\)\s*=>/.test(m[2])) bad.push(`${m[1]}: ${m[2].slice(0, 60)}`);
    }
    expect(bad).toEqual([]);
  });
});
