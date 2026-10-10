import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// The conflict scanner paired a mod folder with its mod only when the folder
// was named exactly like the mod's id= or name=. A mod whose folder is named
// anything else (the common case: "MyMod_v2" holding id=MyMod) matched
// nothing, was scanned under the folder name, and -- once the scan was limited
// to Mods= -- was reported "skipped (not in Mods=)" and never compared.
// getModDetailsFromWorkshop now records the folder and both paths match on it.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router, buildFileIndex } = await import("../routes/mods.js");
const { getModDetailsFromWorkshop } = await import("../services/workshopModInfo.js");
const runRoute = createRouteRunner(router);

function writeMedia(modDir, relFile, content) {
  const target = path.join(modDir, "media", relFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe("conflict scanning finds a mod whose folder is named after neither its id nor its name", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({
      prefix: "mods-folder-match-",
      ini: "Mods=ModOne;ModTwo\nWorkshopItems=1111111111;2222222222\n",
    });
    writeMedia(fx.writeMod("1111111111", "weird-folder-1", "name=Mod One\nid=ModOne\n"), "lua/shared/a.lua", "-- one\n");
    writeMedia(fx.writeMod("2222222222", "another_folder", "name=Mod Two\nid=ModTwo\n"), "lua/shared/a.lua", "-- two\n");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
  });

  afterEach(() => fx.cleanup());

  it("getModDetailsFromWorkshop records the folder", () => {
    const details = getModDetailsFromWorkshop("1111111111", fx.installPath);
    expect(details).toEqual([expect.objectContaining({ id: "ModOne", folder: "weird-folder-1" })]);
  });

  it("buildFileIndex scans it under its id and does not skip it as inactive", async () => {
    const { fileIndex, modsScanned, modsSkippedInactive } = await buildFileIndex(
      ["1111111111", "2222222222"],
      fx.installPath,
      null,
      ["ModOne", "ModTwo"],
    );
    expect(modsSkippedInactive).toBe(0);
    expect(modsScanned).toBe(2);
    const entries = fileIndex["lua/shared/a.lua"];
    expect(entries.map((e) => [e.modId, e.modName]).sort()).toEqual([
      ["ModOne", "Mod One"],
      ["ModTwo", "Mod Two"],
    ]);
  });

  it("GET /conflicts/diff compares the two mods by id", async () => {
    const res = await runRoute("/conflicts/diff", "get", {
      query: { file: "lua/shared/a.lua", modA: "ModOne", modB: "ModTwo" },
    });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().type).toBe("text");
  });
});
