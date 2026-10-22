import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// Regression for the conflict rule rework: every conflict the scanner reported
// before on this fixture (one of each file kind, in the old root media/ layout
// the existing conflict tests use) is still reported, except the ones listed
// in NEWLY_BENIGN, which Build 42 never loads or which define exactly the same
// thing. Checked against the previous scanner: it reported all eleven paths.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const STILL_CONFLICTS = {
  "lua/shared/a.lua": { severity: "high", reason: "luaFileOverride" },
  "textures/x.png": { severity: "low", reason: "assetOverride" },
  "sound/s.ogg": { severity: "low", reason: "assetOverride" },
  "maps/mymap/spawnpoints.lua": { severity: "medium", reason: "mapFileOverride" },
  "data.xml": { severity: "medium", reason: "dataFileOverride" },
  "clothing/clothingitems/hat_x.xml": { severity: "medium", reason: "clothingItemOverride" },
  "clothing/clothing.xml": { severity: "medium", reason: "clothingOutfitOverride" },
  "scripts/items.txt": { severity: "medium", reason: "scriptFileOverride" },
};

const NEWLY_BENIGN = {
  "readme.txt": "documentation, never read by the game",
  "lua/shared/translate/en/ui_en.txt": "B41 translation format, not read by B42",
  "scripts/same.txt": "same definitions, only the formatting differs",
};

function modFiles(tag, damage) {
  return {
    "lua/shared/a.lua": `-- ${tag}\n`,
    "textures/x.png": `png ${tag}`,
    "sound/s.ogg": `ogg ${tag}`,
    "maps/MyMap/spawnpoints.lua": `-- spawn ${tag}\n`,
    "data.xml": `<data>${tag}</data>`,
    "clothing/clothingItems/Hat_X.xml": `<clothingItem><m_MaleModel>hat_${tag}</m_MaleModel><m_Name>Hat_X</m_Name></clothingItem>`,
    "clothing/clothing.xml": `<outfitManager><m_MaleOutfits><m_Name>Biker</m_Name><m_items><itemGUID>${tag}</itemGUID></m_items></m_MaleOutfits></outfitManager>`,
    "scripts/items.txt": `module Base { item Axe { MaxDamage = ${damage}, } }`,
    "readme.txt": `about ${tag}`,
    "lua/shared/Translate/EN/UI_EN.txt": `UI_EN = {\n  UI_Hello = "${tag}",\n}\n`,
    "scripts/same.txt": tag === "one" ? "module Base { item Rope { Weight = 1, } }" : "module Base {\n  item Rope\n  {\n    Weight = 1,\n  }\n}\n",
    "textures/identical.png": "same bytes",
  };
}

describe("conflict scan regression on the old fixture shapes", () => {
  let fx;
  let body;

  beforeAll(async () => {
    fx = makeServerFixture({
      prefix: "mods-conflict-regression-",
      ini: "Mods=RegA;RegB\nWorkshopItems=1111111111;2222222222\n",
    });
    getActiveServer.mockResolvedValue(fx.activeServer);
    const write = (dir, files) => {
      for (const [rel, content] of Object.entries(files)) {
        const target = path.join(dir, "media", rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    };
    write(fx.writeMod("1111111111", "RegA", "name=Reg A\nid=RegA\n"), modFiles("one", 2));
    write(fx.writeMod("2222222222", "RegB", "name=Reg B\nid=RegB\n"), modFiles("two", 3));
    const res = await runRoute("/conflicts", "get", { query: {} });
    expect(res.getStatusCode()).toBe(200);
    body = res.getBody();
  });

  afterAll(() => fx.cleanup());

  it("still reports every earlier conflict, with its kind and reason", () => {
    const files = body.pairs.flatMap((p) => p.files);
    const byFile = Object.fromEntries(files.map((f) => [f.file, f]));
    for (const [file, expected] of Object.entries(STILL_CONFLICTS)) {
      expect(byFile[file], file).toMatchObject({
        ...expected,
        winner: expect.objectContaining({ modId: "RegB" }),
      });
    }
  });

  it("drops exactly the newly benign ones", () => {
    const files = body.pairs.flatMap((p) => p.files.map((f) => f.file)).sort();
    expect(files).toEqual(Object.keys(STILL_CONFLICTS).sort());
    for (const file of Object.keys(NEWLY_BENIGN)) expect(files).not.toContain(file);
    expect(body.benignSkipped).toEqual({ nonGameplay: 1, notLoaded: 1, sameDefinitions: 1, layeredAdditions: 0 });
    expect(body.identicalSkipped).toBe(1);
  });
});
