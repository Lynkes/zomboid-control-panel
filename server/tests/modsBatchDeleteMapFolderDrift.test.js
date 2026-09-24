import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// continuous-bug-hunt, 2026-09-18 (mod-list-drift round): /batch-delete-disk-mods
// deletes the whole workshop content folder per id (fs.rmSync, recursive) --
// including any map data it owns -- and already stripped the matching
// WorkshopItems=/Mods= entries, but never touched Map= at all. Its single-mod
// sibling (deleteModFromDiskAndIni, used by /delete-disk-mod and /purge)
// already gets this right. The result: after a batch delete, Map= kept
// naming a folder that no longer existed on disk, silently, with the response
// reporting success and nothing about it -- exactly "a map folder left
// behind" from an ini three lists are supposed to stay in sync with each
// other.

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

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

describe("POST /batch-delete-disk-mods keeps Map= in sync with the deleted workshop folder", () => {
  let dataRoot;
  let configPath;
  let serverPath;
  const WORKSHOP_ID = "1111111111";
  const MAP_FOLDER = "TestMapFolder";

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-batch-map-drift-"));
    configPath = path.join(dataRoot, "Server");
    serverPath = path.join(dataRoot, "game");
    fs.mkdirSync(configPath, { recursive: true });

    // Workshop content: mods/<name>/mod.info (declares the mod id) and
    // mods/<name>/media/maps/<MAP_FOLDER>/ with real map tile data, exactly
    // the shape findAllModIdsFromWorkshop/findMapFoldersFromWorkshop scan.
    const modDir = path.join(
      serverPath,
      "steamapps",
      "workshop",
      "content",
      "108600",
      WORKSHOP_ID,
      "mods",
      "TestMod",
    );
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, "mod.info"), "id=TestMod\nname=Test Mod\n");
    const mapsDir = path.join(modDir, "media", "maps", MAP_FOLDER);
    fs.mkdirSync(mapsDir, { recursive: true });
    fs.writeFileSync(path.join(mapsDir, "world_0_0.lotpack"), "fake tile data");

    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      `Mods=TestMod\nWorkshopItems=${WORKSHOP_ID}\nMap=Muldraugh, KY;${MAP_FOLDER}\n`,
    );

    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      installPath: serverPath,
      isRemote: false,
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("removes the mod's map folder from Map= and reports it, the same way /purge already does", async () => {
    const res = await runRoute("/batch-delete-disk-mods", "post", {
      body: { workshopIds: [WORKSHOP_ID] },
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().mapFoldersStripped).toBe(1);

    const iniContent = fs.readFileSync(
      path.join(configPath, "TestServer.ini"),
      "utf-8",
    );
    const mapLine = iniContent.match(/^Map=(.*)$/m)?.[1] || "";
    const maps = mapLine.split(";").filter(Boolean);
    expect(maps).not.toContain(MAP_FOLDER);
    // A map this mod does NOT own stays untouched -- this isn't clearing
    // Map= wholesale, only the entries the deleted mod actually owned.
    expect(maps).toContain("Muldraugh, KY");

    // WorkshopItems=/Mods= still get cleaned up as before.
    expect(iniContent).not.toMatch(/WorkshopItems=.*1111111111/);
    expect(iniContent).not.toMatch(/^Mods=.*TestMod/m);
  });

  it("falls back to Muldraugh, KY when the deleted mod owned every listed map", async () => {
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      `Mods=TestMod\nWorkshopItems=${WORKSHOP_ID}\nMap=${MAP_FOLDER}\n`,
    );

    const res = await runRoute("/batch-delete-disk-mods", "post", {
      body: { workshopIds: [WORKSHOP_ID] },
    });

    expect(res.getStatusCode()).toBe(200);
    const iniContent = fs.readFileSync(
      path.join(configPath, "TestServer.ini"),
      "utf-8",
    );
    expect(iniContent).toMatch(/^Map=Muldraugh, KY$/m);
  });
});
