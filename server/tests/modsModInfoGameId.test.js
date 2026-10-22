import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// The game reads ONE mod.info per mod (the best version folder's, else
// common/) and a line counts as the id only when it starts with "id=" (checked
// against zombie.gameStates.ChooseGameInfo.readModInfoAux in the 42.x jar):
// the last such line wins, so a mod.info that lists three ids is ONE mod, the
// third. The panel treated every id= line of every version folder as its own
// mod, so /add-to-ini and /sync-mod-ids could enable an id the game never
// loads (and report the real one as an "alternative").

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

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const { getModDetailsFromWorkshop, findAllModIdsFromWorkshop } = await import(
  "../services/workshopModInfo.js"
);
const runRoute = createRouteRunner(router);

const WS = "4444444444";

describe("getModDetailsFromWorkshop follows the game's mod.info rules", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({ prefix: "mods-modinfo-" });
  });

  afterEach(() => fx.cleanup());

  const ids = () => getModDetailsFromWorkshop(WS, fx.installPath).map((m) => m.id);

  it("a mod.info with several id= lines is one mod: the last one", () => {
    fx.writeMod(WS, "Pack", "name=Pack\nid=First\nid=Second\nid=Third\n");
    expect(ids()).toEqual(["Third"]);
  });

  it("only a line that starts with id= is an id line", () => {
    fx.writeMod(
      WS,
      "Pack",
      ["name=Pack", "id=Real", "  id=Indented", "ID=Upper", "modid=Other", "# id=Commented", "//id=Slashed", ""].join(
        "\n",
      ),
    );
    expect(ids()).toEqual(["Real"]);
  });

  it("an empty id= line does not clear the id", () => {
    fx.writeMod(WS, "Pack", "id=Real\nid=\nname=Pack\n");
    expect(ids()).toEqual(["Real"]);
  });

  it("the newest version folder's mod.info decides, not every version's ids", () => {
    const dir = fx.writeMod(WS, "Pack", "name=Pack Legacy\nid=Pack_Old\n", "41");
    fs.mkdirSync(path.join(dir, "42"), { recursive: true });
    fs.writeFileSync(path.join(dir, "42", "mod.info"), "name=Pack\nid=Pack\n");
    const details = getModDetailsFromWorkshop(WS, fx.installPath);
    expect(details.map((m) => [m.id, m.name])).toEqual([["Pack", "Pack"]]);
  });

  it("falls back to the next mod.info when the preferred one has no id", () => {
    const dir = fx.writeMod(WS, "Pack", "name=Pack\nid=Pack\n", "common");
    fs.mkdirSync(path.join(dir, "42"), { recursive: true });
    fs.writeFileSync(path.join(dir, "42", "mod.info"), "name=No id here\n");
    expect(ids()).toEqual(["Pack"]);
  });

  it("separate mod folders stay separate mods, each remembering its folder", () => {
    fx.writeMod(WS, "FolderA", "name=A\nid=ModA\n");
    fx.writeMod(WS, "FolderB", "name=B\nid=ModB\n");
    const details = getModDetailsFromWorkshop(WS, fx.installPath);
    expect(details.map((m) => [m.folder, m.id]).sort()).toEqual([
      ["FolderA", "ModA"],
      ["FolderB", "ModB"],
    ]);
    expect(findAllModIdsFromWorkshop(WS, fx.installPath).sort()).toEqual(["ModA", "ModB"]);
  });
});

describe("the routes enable the id the game would load", () => {
  let fx;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      }),
    );
    fx = makeServerFixture({ prefix: "mods-modinfo-routes-", ini: "Mods=\nWorkshopItems=\n" });
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
  });

  afterEach(() => {
    fx.cleanup();
    vi.unstubAllGlobals();
  });

  it("POST /add-to-ini enables the last id= line of a multi-id mod.info and invents no alternatives", async () => {
    fx.writeMod(WS, "BundledPack", "name=Bundled Pack\nid=BundledCore\nid=BundledExtraOne\nid=BundledExtraTwo\n");
    const res = await runRoute("/add-to-ini", "post", { body: { workshopId: WS } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().modId).toBe("BundledExtraTwo");
    expect(res.getBody().alternativeModIds).toEqual([]);
    expect(fx.iniValue("Mods")).toBe("BundledExtraTwo");
  });

  it("POST /add-to-ini still reports the other mod folders of a bundle as alternatives", async () => {
    fx.writeMod(WS, "FolderA", "name=A\nid=ModA\nid=ModA_final\n");
    fx.writeMod(WS, "FolderB", "name=B\nid=ModB\n");
    const res = await runRoute("/add-to-ini", "post", { body: { workshopId: WS } });
    expect(res.getBody().modId).toBe("ModA_final");
    expect(res.getBody().alternativeModIds).toEqual(["ModB"]);
    expect(fx.iniValue("Mods")).toBe("ModA_final");
  });

  it("POST /sync-mod-ids adds the game's id, not the first id= line", async () => {
    fx.writeMod(WS, "Pack", "name=Pack\nid=Pack_Draft\nid=Pack\n");
    fx.writeIni(`Mods=\nWorkshopItems=${WS}\n`);
    const res = await runRoute("/sync-mod-ids", "post", { body: {} });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe("Pack");
    expect(res.getBody().syncedMods).toEqual([
      { workshopId: WS, mods: ["Pack"], status: "added_default" },
    ]);
  });

  it("POST /sync-mod-ids does not count a draft id= line as 'already enabled'", async () => {
    fx.writeMod(WS, "Pack", "name=Pack\nid=Pack_Draft\nid=Pack\n");
    fx.writeIni(`Mods=Pack_Draft\nWorkshopItems=${WS}\n`);
    const res = await runRoute("/sync-mod-ids", "post", { body: {} });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe("Pack_Draft;Pack");
  });
});
