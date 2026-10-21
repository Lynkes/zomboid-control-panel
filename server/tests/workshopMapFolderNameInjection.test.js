import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// SECURITY (2026-10-20): a Workshop map's folder name went into the server
// .ini's Map= line as it was on disk. On Linux a folder name can hold a line
// break, so a Workshop item could add any ini line ("DiscordToken=...",
// "RCONPassword=...") when an operator added it. Such names are now never
// offered, and every Map= write goes through the ini sanitizer.
//
// Windows can't create such a folder, so the scan sees them through a fake
// listing: readdirSync of a real maps folder gains the names in FAKE_MAPS,
// each of which "holds" a .lotheader.
const fake = vi.hoisted(() => ({ mapsDir: null, names: [] }));

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal();
  const realFs = real.default ?? real;
  const nodePath = await import("path");
  const readdirSync = (dir, options) => {
    const resolved = nodePath.resolve(String(dir));
    if (fake.mapsDir && fake.names.some((name) => nodePath.join(fake.mapsDir, name) === resolved)) {
      return ["cell.lotheader"];
    }
    const entries = realFs.readdirSync(dir, options);
    if (fake.mapsDir && resolved === fake.mapsDir && options?.withFileTypes) {
      return [
        ...entries,
        ...fake.names.map((name) => ({ name, isDirectory: () => true, isFile: () => false })),
      ];
    }
    return entries;
  };
  const patched = { ...realFs, readdirSync };
  return { ...real, ...patched, default: patched };
});

const { findMapFoldersFromWorkshop, isWritableMapFolderName } = await import(
  "../services/workshopModInfo.js"
);
const { addWorkshopItemToIni } = await import("../services/modIniEdit.js");

const WORKSHOP_ID = "3000000001";
const BAD_NAMES = [
  "Evil\nDiscordToken=attacker\nDiscordEnable=true",
  "Evil\rRCONPassword=x",
  "Two;Maps",
  "Cut=Here",
  "Nul\u0000Map",
  "Bell\u0007Map",
  "Del\u007fMap",
  "   ",
];

let serverPath;
beforeAll(() => {
  serverPath = fs.mkdtempSync(path.join(os.tmpdir(), "map-folder-names-"));
  const mapsDir = path.join(
    serverPath, "steamapps", "workshop", "content", "108600", WORKSHOP_ID,
    "mods", "MapMod", "media", "maps",
  );
  fs.mkdirSync(path.join(mapsDir, "GoodMap"), { recursive: true });
  fs.writeFileSync(path.join(mapsDir, "GoodMap", "cell.lotheader"), "");
  fake.mapsDir = path.resolve(mapsDir);
  fake.names = BAD_NAMES;
});
afterAll(() => {
  fake.mapsDir = null;
  fs.rmSync(serverPath, { recursive: true, force: true });
});

describe("Workshop map folder names", () => {
  it("are offered only when Map= can hold them as they are", () => {
    expect(findMapFoldersFromWorkshop(WORKSHOP_ID, serverPath)).toEqual(["GoodMap"]);
  });

  it("isWritableMapFolderName refuses line breaks, ';', '=', control chars and blank names", () => {
    for (const name of BAD_NAMES) expect(isWritableMapFolderName(name)).toBe(false);
    for (const name of ["GoodMap", "Muldraugh, KY", "Map With Spaces", "Ünïcødé-map_2"]) {
      expect(isWritableMapFolderName(name)).toBe(true);
    }
    expect(isWritableMapFolderName(undefined)).toBe(false);
  });
});

describe("addWorkshopItemToIni and Map=", () => {
  const ini = "PVP=true\nMap=Muldraugh, KY\nMods=\nWorkshopItems=\nPassword=join\n";

  it("never writes a map folder name that would add a line or an entry", () => {
    const result = addWorkshopItemToIni(ini, {
      workshopId: WORKSHOP_ID,
      modIds: [],
      mapFolders: [...BAD_NAMES, "GoodMap"],
    });
    expect(result.content).toBe(
      "PVP=true\nMap=GoodMap;Muldraugh, KY\nMods=\nWorkshopItems=3000000001\nPassword=join\n",
    );
    expect(result.addedMapFolders).toEqual(["GoodMap"]);
  });

  it("writes nothing to Map= when every name is refused", () => {
    const result = addWorkshopItemToIni(ini, {
      workshopId: WORKSHOP_ID,
      mapFolders: BAD_NAMES,
    });
    expect(result.content).toContain("\nMap=Muldraugh, KY\n");
    expect(result.content.split("\n").filter((line) => line.includes("="))).toHaveLength(5);
    expect(result.addedMapFolders).toEqual([]);
  });
});
