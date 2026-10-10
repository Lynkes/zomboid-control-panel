import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// The game trims every Mods= token (and removes backslashes from the line
// before splitting it); the panel split on ";" and compared tokens exactly, so
// a hand-edited `Mods=Alpha; Beta;Gamma ` made removing Beta or Gamma a silent
// no-op and the Mods page show "Beta" as not enabled. All the ini readers now
// use one trimming parser. /collection/diff additionally matched
// `^WorkshopItems=` with no whitespace tolerance, so `WorkshopItems = 222`
// marked every mod as off the server.

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
  computeDiff: vi.fn(async () => ({
    ok: true,
    inCollection: ["2222222222"],
    toAdd: [],
    toRemove: [],
    collectionOnly: [],
  })),
  syncSingleChange: vi.fn(async () => ({ skipped: true })),
  fetchPublishedFileTitles: vi.fn(async () => new Map()),
  getSteamSessionCredentials: vi.fn(async () => ({ sessionId: "", loginSecure: "" })),
  setSteamSessionCredentials: vi.fn(),
}));

const { getActiveServer, getTrackedMods } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const WS_A = "1111111111";
const WS_B = "2222222222";
const WS_C = "3333333333";

describe("Mods=/WorkshopItems=/Map= lines with padded tokens", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({
      prefix: "mods-trim-",
      ini: `Mods=Alpha; Beta;Gamma \nWorkshopItems=${WS_A}; ${WS_B} ;${WS_C}\nMap=Muldraugh, KY\n`,
    });
    fx.writeMod(WS_A, "AlphaMod", "name=Alpha\nid=Alpha\n");
    fx.writeMod(WS_B, "BetaMod", "name=Beta\nid=Beta\n");
    fx.writeMod(WS_C, "GammaMod", "name=Gamma\nid=Gamma\n");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    getTrackedMods.mockReset().mockResolvedValue([]);
  });

  afterEach(() => fx.cleanup());

  it("GET /current-config reports trimmed ids and marks each as enabled", async () => {
    fx.writeIni(`Mods=\\Alpha; Beta;Gamma \nWorkshopItems=${WS_A}; ${WS_B} ;${WS_C}\n`);
    const res = await runRoute("/current-config", "get", { user: null });
    const body = res.getBody();
    expect(body.modIds).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(body.workshopIds).toEqual([WS_A, WS_B, WS_C]);
    expect(body.totalMods).toBe(3);
    expect(body.workshopModMap[WS_B].map((m) => [m.id, m.enabled])).toEqual([["Beta", true]]);
  });

  it("POST /toggle-mod-id can disable a padded token and does not duplicate an enabled one", async () => {
    let res = await runRoute("/toggle-mod-id", "post", { body: { modId: "Beta", enabled: false } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe("Alpha;Gamma");

    fx.writeIni("Mods=Alpha; Beta;Gamma \nWorkshopItems=\n");
    res = await runRoute("/toggle-mod-id", "post", { body: { modId: "Gamma", enabled: true } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe("Alpha;Beta;Gamma");
  });

  it("POST /batch-toggle-mod-ids can disable padded tokens", async () => {
    const res = await runRoute("/batch-toggle-mod-ids", "post", {
      body: {
        changes: [
          { modId: "Beta", enabled: false },
          { modId: "Gamma", enabled: false },
        ],
      },
    });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe("Alpha");
  });

  it("POST /remove-from-ini removes a padded workshop id and its padded mod id", async () => {
    const res = await runRoute("/remove-from-ini", "post", { body: { workshopId: WS_B } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("WorkshopItems")).toBe(`${WS_A};${WS_C}`);
    expect(fx.iniValue("Mods")).toBe("Alpha;Gamma");

    const res2 = await runRoute("/remove-from-ini", "post", { body: { workshopId: WS_C } });
    expect(res2.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe("Alpha");
  });

  it("POST /batch-remove removes padded workshop ids and mod ids", async () => {
    const res = await runRoute("/batch-remove", "post", { body: { workshopIds: [WS_B, WS_C] } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().iniRemoved).toBe(2);
    expect(fx.iniValue("WorkshopItems")).toBe(WS_A);
    expect(fx.iniValue("Mods")).toBe("Alpha");
  });

  it("POST /delete-disk-mod strips a padded workshop id and mod id", async () => {
    const res = await runRoute("/delete-disk-mod", "post", { body: { workshopId: WS_C } });
    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("WorkshopItems")).toBe(`${WS_A};${WS_B}`);
    expect(fx.iniValue("Mods")).toBe("Alpha;Beta");
  });

  it("POST /add-to-ini sees a padded workshop id as already configured", async () => {
    const res = await runRoute("/add-to-ini", "post", { body: { workshopId: WS_B } });
    expect(res.getBody().alreadyExists).toBe(true);
    expect(fx.iniValue("WorkshopItems")).toBe(`${WS_A}; ${WS_B} ;${WS_C}`);
  });

  it("POST /add-to-ini does not duplicate a mod id that is already there padded", async () => {
    fx.writeIni("Mods=Alpha; Beta;Gamma \nWorkshopItems=\n");
    const res = await runRoute("/add-to-ini", "post", { body: { workshopId: WS_B, modId: "Beta" } });
    expect(res.getStatusCode()).toBe(200);
    // Beta is already enabled: nothing is appended, whatever the padding.
    expect(fx.iniValue("Mods").split(";").map((t) => t.trim())).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

describe("GET /collection/diff reads WorkshopItems= like every other reader", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({ prefix: "mods-diff-", ini: `Mods=Alpha\nWorkshopItems = ${WS_B}; ${WS_A}\n` });
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    getTrackedMods.mockReset().mockResolvedValue([{ workshop_id: WS_B, name: "Beta" }]);
  });

  afterEach(() => fx.cleanup());

  it("a hand-edited 'WorkshopItems = ...' line still counts as on the server", async () => {
    const res = await runRoute("/collection/diff", "get", {});
    const body = res.getBody();
    expect(body.serverConfigRead).toBe(true);
    const byId = Object.fromEntries(body.items.map((i) => [i.workshopId, i]));
    expect(byId[WS_B].inServer).toBe(true);
    expect(byId[WS_B].status).toBe("synced");
    expect(byId[WS_A].inServer).toBe(true);
  });
});
