import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// The Workshop collection mirrors what the server loads (WorkshopItems=).
// Settings' per-item view already measured drift that way, but the diff's
// toAdd (the Mods page chip) and POST /collection/sync still compared the
// TRACKED list: a deactivated mod (tracked on purpose, no longer in
// WorkshopItems=) read "1 out of sync", and Sync pushed it into the public
// collection.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async (key) => (key === "workshopCollectionId" ? "9999999999" : null)),
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

const WS_ON_SERVER = "1111111111";
const WS_IN_BOTH = "2222222222";
const WS_DEACTIVATED = "3333333333";
const COLLECTION = [WS_IN_BOTH];

// Same contract as the real computeDiff(): the ids passed in vs the collection.
vi.mock("../services/workshopCollectionSync.js", () => ({
  getCollectionContents: vi.fn(),
  addItemToCollection: vi.fn(async () => ({ ok: true })),
  removeItemFromCollection: vi.fn(),
  computeDiff: vi.fn(async (ids) => {
    const inCollection = new Set(COLLECTION);
    const mirrored = new Set(ids.map(String));
    return {
      ok: true,
      title: "Server mods",
      inCollection: [...inCollection],
      toAdd: [...mirrored].filter((id) => !inCollection.has(id)),
      toRemove: [],
      collectionOnly: [...inCollection].filter((id) => !mirrored.has(id)),
    };
  }),
  syncSingleChange: vi.fn(async () => ({ skipped: true })),
  fetchPublishedFileTitles: vi.fn(async () => new Map()),
  getSteamSessionCredentials: vi.fn(async () => ({ sessionId: "", loginSecure: "" })),
  setSteamSessionCredentials: vi.fn(),
}));

const { getActiveServer, getTrackedMods } = await import("../database/init.js");
const { addItemToCollection } = await import("../services/workshopCollectionSync.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const tracked = [WS_ON_SERVER, WS_IN_BOTH, WS_DEACTIVATED].map((id) => ({
  workshop_id: id,
  name: `Mod ${id}`,
}));

describe("Workshop collection diff and Sync mirror WorkshopItems=", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({
      prefix: "collection-mirror-",
      // The deactivated mod is still tracked but no longer on the server.
      ini: `Mods=A;B\nWorkshopItems=${WS_ON_SERVER};${WS_IN_BOTH}\n`,
    });
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    getTrackedMods.mockReset().mockResolvedValue(tracked);
    addItemToCollection.mockClear();
  });

  afterEach(() => fx.cleanup());

  it("GET /collection/diff counts only server mods missing from the collection", async () => {
    const res = await runRoute("/collection/diff", "get", {});
    const body = res.getBody();
    expect(res.getStatusCode()).toBe(200);
    expect(body.toAdd).toEqual([WS_ON_SERVER]);
    // The per-item view agrees with it.
    expect(body.items.filter((it) => it.status === "to-add").map((it) => it.workshopId)).toEqual([WS_ON_SERVER]);
    expect(body.items.find((it) => it.workshopId === WS_DEACTIVATED)?.status).toBe("tracked-only");
  });

  it("POST /collection/sync never pushes a deactivated (tracked-only) mod into the collection", async () => {
    const res = await runRoute("/collection/sync", "post", {});
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().added).toEqual([WS_ON_SERVER]);
    expect(addItemToCollection).toHaveBeenCalledTimes(1);
    expect(addItemToCollection).toHaveBeenCalledWith("9999999999", WS_ON_SERVER);
  });

  it("falls back to the tracked list when WorkshopItems= can't be read", async () => {
    fx.cleanup();
    const res = await runRoute("/collection/diff", "get", {});
    expect(res.getBody().toAdd.sort()).toEqual([WS_DEACTIVATED, WS_ON_SERVER].sort());
    expect(res.getBody().serverConfigRead).toBe(false);
  });
});
