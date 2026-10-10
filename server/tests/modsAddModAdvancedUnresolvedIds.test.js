import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// POST /add-mod-advanced (the Mods page's Add dialog and Import Collection)
// resolved mod ids from local files only, with no Steam fallback -- unlike
// POST /add-to-ini. Importing a collection that was not downloaded yet changed
// only WorkshopItems= while the page said "Restart the server to load the new
// mods", and the response text "mod IDs were already configured" was wrong for
// that case. It now asks the Steam Workshop page like /add-to-ini does and,
// when the id is still unknown, says so with status "workshop-only".

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

const { getActiveServer, addTrackedMod } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const WS = "4444444444";

function steamReplies(description) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      response: { publishedfiledetails: [{ result: 1, title: "Some Mod Title", description }] },
    }),
  }));
}

describe("POST /add-mod-advanced: mod ids of a workshop item that is not downloaded", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({ prefix: "mods-adv-steam-", ini: "Mods=Alpha\nWorkshopItems=\n" });
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    addTrackedMod.mockClear();
  });

  afterEach(() => {
    fx.cleanup();
    vi.unstubAllGlobals();
  });

  it("asks the Steam Workshop page when nothing is on disk and enables the id it finds", async () => {
    const fetchMock = steamReplies("Install it.\nMod ID: SteamMod\n");
    vi.stubGlobal("fetch", fetchMock);
    const res = await runRoute("/add-mod-advanced", "post", {
      body: { workshopId: WS, includeAllModIds: true },
    });
    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.status).toBe("added");
    expect(body.detectionSource).toBe("steam-workshop");
    expect(body.addedModIds).toEqual(["SteamMod"]);
    expect(fx.iniValue("Mods")).toBe("Alpha;SteamMod");
    expect(fx.iniValue("WorkshopItems")).toBe(WS);
  });

  it("says 'workshop-only' when the id is not known either, and does not claim the mods were configured", async () => {
    vi.stubGlobal("fetch", steamReplies("No id in here at all"));
    const res = await runRoute("/add-mod-advanced", "post", {
      body: { workshopId: WS, includeAllModIds: true },
    });
    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.status).toBe("workshop-only");
    expect(body.addedModIds).toEqual([]);
    expect(body.message).toMatch(/WorkshopItems only/);
    expect(body.message).not.toMatch(/already configured/);
    expect(fx.iniValue("Mods")).toBe("Alpha");
    expect(fx.iniValue("WorkshopItems")).toBe(WS);
  });

  it("does not ask Steam when the files are on disk", async () => {
    const fetchMock = steamReplies("Mod ID: Wrong");
    vi.stubGlobal("fetch", fetchMock);
    fx.writeMod(WS, "Folder", "name=Local\nid=LocalMod\n");
    const res = await runRoute("/add-mod-advanced", "post", {
      body: { workshopId: WS, includeAllModIds: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.getBody().status).toBe("added");
    expect(res.getBody().detectionSource).toBe("local-files");
    expect(fx.iniValue("Mods")).toBe("Alpha;LocalMod");
  });

  it("does not ask Steam for an explicit selection", async () => {
    const fetchMock = steamReplies("Mod ID: Wrong");
    vi.stubGlobal("fetch", fetchMock);
    const res = await runRoute("/add-mod-advanced", "post", {
      body: { workshopId: WS, selectedModIds: ["Picked"] },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.getBody().status).toBe("added");
    expect(res.getBody().detectionSource).toBe("provided");
    expect(fx.iniValue("Mods")).toBe("Alpha;Picked");
  });

  it("reports 'already-configured' when the item and its ids were all there", async () => {
    vi.stubGlobal("fetch", steamReplies("nothing"));
    fx.writeIni(`Mods=Alpha;Picked\nWorkshopItems=${WS}\n`);
    const res = await runRoute("/add-mod-advanced", "post", {
      body: { workshopId: WS, selectedModIds: ["Picked"] },
    });
    expect(res.getBody().status).toBe("already-configured");
    expect(res.getBody().workshopAlreadyExisted).toBe(true);
    expect(res.getBody().addedModIds).toEqual([]);
    // nothing changed, so no new backup was taken
    expect(fx.backups()).toHaveLength(0);
  });
});
