import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";
import { ErrorCode } from "../utils/errorCodes.js";

// Importing a collection fired POST /add-mod-advanced once per mod, and every
// call is its own ini write and so its own backup. A backup keeps only the 10
// newest, so a 60-mod import evicted the pre-import copy of the server config.
// POST /add-to-ini-bulk applies the whole batch under one lock with one write:
// one backup, and it holds the config as it was before the import.

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

vi.mock("../services/workshopCollectionSync.js", () => ({
  getCollectionContents: vi.fn(),
  addItemToCollection: vi.fn(),
  removeItemFromCollection: vi.fn(),
  computeDiff: vi.fn(),
  syncSingleChange: vi.fn(async () => ({ skipped: true })),
  fetchPublishedFileTitles: vi.fn(async () => new Map()),
  getSteamSessionCredentials: vi.fn(async () => ({ sessionId: "", loginSecure: "" })),
  setSteamSessionCredentials: vi.fn(),
}));

const { getActiveServer, addTrackedMod, removeIgnoredMod } = await import("../database/init.js");
const { syncSingleChange } = await import("../services/workshopCollectionSync.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const PRE_IMPORT_INI = "Mods=Alpha\nWorkshopItems=1000000000\nMap=Muldraugh, KY\n";
const wsId = (i) => String(2000000000 + i);

describe("POST /add-to-ini-bulk", () => {
  let fx;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      }),
    );
    fx = makeServerFixture({ prefix: "mods-bulk-", ini: PRE_IMPORT_INI });
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    addTrackedMod.mockClear();
    removeIgnoredMod.mockClear();
    syncSingleChange.mockClear();
  });

  afterEach(() => {
    fx.cleanup();
    vi.unstubAllGlobals();
  });

  it("writes a 60-mod import once: one backup, and it is the pre-import config", async () => {
    const mods = [];
    for (let i = 0; i < 60; i++) {
      fx.writeMod(wsId(i), `Folder${i}`, `name=Mod ${i}\nid=Mod${i}\n`);
      mods.push({ workshopId: wsId(i), includeAllModIds: true });
    }
    const res = await runRoute("/add-to-ini-bulk", "post", { body: { mods } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().added).toBe(60);

    const backups = fx.backups();
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(fx.configPath, "backups", backups[0]), "utf-8")).toBe(PRE_IMPORT_INI);

    const modsLine = fx.iniValue("Mods").split(";");
    expect(modsLine).toHaveLength(61);
    expect(modsLine.slice(0, 3)).toEqual(["Alpha", "Mod0", "Mod1"]);
    expect(fx.iniValue("WorkshopItems").split(";")).toHaveLength(61);
  });

  it("is the reason it exists: the single-item route flushes the pre-import backup", async () => {
    // 12 single adds -> 12 writes -> only the newest 10 backups survive, and
    // the oldest (the pre-import copy) is gone.
    for (let i = 0; i < 12; i++) {
      fx.writeMod(wsId(i), `Folder${i}`, `name=Mod ${i}\nid=Mod${i}\n`);
      const res = await runRoute("/add-mod-advanced", "post", {
        body: { workshopId: wsId(i), includeAllModIds: true },
      });
      expect(res.getStatusCode()).toBe(200);
    }
    const backups = fx.backups();
    expect(backups).toHaveLength(10);
    const contents = backups.map((b) => fs.readFileSync(path.join(fx.configPath, "backups", b), "utf-8"));
    expect(contents).not.toContain(PRE_IMPORT_INI);
  });

  it("reports each item: added, already configured, workshop-only, invalid", async () => {
    fx.writeMod("3000000001", "New", "name=New\nid=NewMod\n");
    // already in the ini
    fx.writeMod("1000000000", "Old", "name=Old\nid=Alpha\n");
    // nothing on disk and Steam is unreachable: workshop-only
    const res = await runRoute("/add-to-ini-bulk", "post", {
      body: {
        mods: [
          { workshopId: "3000000001", includeAllModIds: true },
          { workshopId: "1000000000", includeAllModIds: true },
          { workshopId: "3000000002", includeAllModIds: true },
          { workshopId: "not-a-number" },
          { workshopId: "3000000003", selectedModIds: ["Bad;Id"] },
          { workshopId: "3000000001" }, // listed twice: one item
        ],
      },
    });
    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    const byId = Object.fromEntries(body.results.map((r) => [r.workshopId, r]));
    expect(byId["3000000001"]).toMatchObject({ status: "added", addedModIds: ["NewMod"] });
    expect(byId["1000000000"]).toMatchObject({ status: "already-configured", workshopAlreadyExisted: true });
    expect(byId["3000000002"]).toMatchObject({ status: "workshop-only", addedModIds: [] });
    expect(byId["not-a-number"]).toMatchObject({
      status: "invalid",
      code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
    });
    expect(byId["3000000003"]).toMatchObject({
      status: "invalid",
      code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT_TEMPLATE,
    });
    expect(body.results).toHaveLength(5);
    expect(body).toMatchObject({ added: 1, alreadyConfigured: 1, workshopOnly: 1, invalid: 2 });

    expect(fx.iniValue("Mods")).toBe("Alpha;NewMod");
    expect(fx.iniValue("WorkshopItems")).toBe("1000000000;3000000001;3000000002");
  });

  it("asks Steam for the id of an item that is not downloaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          response: { publishedfiledetails: [{ result: 1, title: "T", description: "Mod ID: FromSteam" }] },
        }),
      })),
    );
    const res = await runRoute("/add-to-ini-bulk", "post", {
      body: { mods: [{ workshopId: "3000000002", includeAllModIds: true }] },
    });
    expect(res.getBody().results[0]).toMatchObject({
      status: "added",
      detectionSource: "steam-workshop",
      addedModIds: ["FromSteam"],
    });
    expect(fx.iniValue("Mods")).toBe("Alpha;FromSteam");
  });

  it("enables only the default mod without includeAllModIds and reports the rest as alternatives", async () => {
    fx.writeMod("3000000001", "1_Core", "name=Core\nid=Core\n");
    fx.writeMod("3000000001", "2_Extra", "name=Extra\nid=Extra\n");
    let res = await runRoute("/add-to-ini-bulk", "post", { body: { mods: [{ workshopId: "3000000001" }] } });
    expect(res.getBody().results[0]).toMatchObject({
      status: "added",
      addedModIds: ["Core"],
      alternativeModIds: ["Extra"],
    });
    expect(fx.iniValue("Mods")).toBe("Alpha;Core");

    res = await runRoute("/add-to-ini-bulk", "post", {
      body: { mods: [{ workshopId: "3000000001", includeAllModIds: true }] },
    });
    expect(res.getBody().results[0]).toMatchObject({ addedModIds: ["Extra"] });
    expect(fx.iniValue("Mods")).toBe("Alpha;Core;Extra");
  });

  it("writes nothing, and takes no backup, when nothing changes", async () => {
    fx.writeMod("1000000000", "Old", "name=Old\nid=Alpha\n");
    const res = await runRoute("/add-to-ini-bulk", "post", {
      body: { mods: [{ workshopId: "1000000000", includeAllModIds: true }] },
    });
    expect(res.getBody().alreadyConfigured).toBe(1);
    expect(fx.backups()).toHaveLength(0);
    expect(fx.readIni()).toBe(PRE_IMPORT_INI);
  });

  it("track: true tracks every valid item and clears its ignore entry; otherwise it does not", async () => {
    fx.writeMod("3000000001", "New", "name=New\nid=NewMod\n");
    await runRoute("/add-to-ini-bulk", "post", {
      body: { mods: [{ workshopId: "3000000001", includeAllModIds: true }] },
    });
    expect(addTrackedMod).not.toHaveBeenCalled();

    await runRoute("/add-to-ini-bulk", "post", {
      body: { mods: [{ workshopId: "3000000001" }, { workshopId: "nope" }], track: true },
    });
    expect(removeIgnoredMod).toHaveBeenCalledWith("3000000001");
    expect(addTrackedMod).toHaveBeenCalledTimes(1);
    expect(addTrackedMod).toHaveBeenCalledWith("3000000001", "Workshop Mod 3000000001");
  });

  it("rejects a missing, empty or oversized mods array", async () => {
    for (const body of [{}, { mods: [] }, { mods: "x" }]) {
      const res = await runRoute("/add-to-ini-bulk", "post", { body });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().code).toBe(ErrorCode.MODS_ADD_BULK_MODS_ARRAY_REQUIRED);
    }
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ workshopId: wsId(i) }));
    const res = await runRoute("/add-to-ini-bulk", "post", { body: { mods: tooMany } });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe(ErrorCode.MODS_ADD_BULK_TOO_MANY);
  });
});
