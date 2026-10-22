import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// Some mods use an all-digit mod.info id (e.g. "Tear All Clothes",
// 3519629457). Every route that rewrote the Mods= line ran the WHOLE existing
// list through sanitizeModIdList, which deletes every 5-15 digit token as "a
// workshop id that landed in Mods=" -- so an unrelated add, remove, dedupe,
// delete or sync silently dropped such a mod from the server. The rewrite now
// keeps whatever the line already had and only holds the entries the edit adds
// to the numeric filter (a mod.info on disk confirms a real numeric id).

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
const runRoute = createRouteRunner(router);

const NUMERIC = "3519629457"; // a real all-digit mod.info id
const NOT_DOWNLOADED_WS = "9999999999"; // owns NUMERIC, but is not on this disk
const WS_BETA = "2222222222";
const WS_NEW = "4444444444";

describe("an unrelated Mods= rewrite keeps a legitimate all-digit mod id", () => {
  let fx;

  beforeEach(() => {
    // No network in tests: the Steam fallbacks must fail quietly.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      }),
    );
    fx = makeServerFixture({
      prefix: "mods-numeric-",
      ini: `Mods=Alpha;${NUMERIC};Beta\nWorkshopItems=${NOT_DOWNLOADED_WS};${WS_BETA}\nMap=Muldraugh, KY\n`,
    });
    fx.writeMod(WS_BETA, "BetaMod", "name=Beta\nid=Beta\n");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
  });

  afterEach(() => {
    fx.cleanup();
    vi.unstubAllGlobals();
  });

  const cases = [
    {
      name: "POST /add-to-ini",
      route: "/add-to-ini",
      body: { workshopId: WS_NEW, modId: "NewMod" },
      mods: `Alpha;${NUMERIC};Beta;NewMod`,
    },
    {
      name: "POST /remove-from-ini",
      route: "/remove-from-ini",
      body: { workshopId: WS_BETA },
      mods: `Alpha;${NUMERIC}`,
    },
    {
      name: "POST /batch-remove",
      route: "/batch-remove",
      body: { workshopIds: [WS_BETA] },
      mods: `Alpha;${NUMERIC}`,
    },
    {
      name: "POST /deduplicate-mod-ids",
      route: "/deduplicate-mod-ids",
      setup: (f) => f.writeIni(`Mods=Alpha;${NUMERIC};Beta;Alpha\nWorkshopItems=${NOT_DOWNLOADED_WS}\n`),
      body: {},
      mods: `Alpha;${NUMERIC};Beta`,
    },
    {
      name: "POST /add-missing-dep",
      route: "/add-missing-dep",
      body: { workshopId: WS_NEW, modId: "DepMod" },
      mods: `Alpha;${NUMERIC};Beta;DepMod`,
    },
    {
      name: "POST /add-all-resolved-deps",
      route: "/add-all-resolved-deps",
      body: { deps: [{ workshopId: WS_NEW, modId: "DepMod" }] },
      mods: `Alpha;${NUMERIC};Beta;DepMod`,
    },
    {
      name: "POST /sync-mod-ids",
      route: "/sync-mod-ids",
      setup: (f) => f.writeIni(`Mods=Alpha;${NUMERIC}\nWorkshopItems=${NOT_DOWNLOADED_WS};${WS_BETA}\n`),
      body: {},
      mods: `Alpha;${NUMERIC};Beta`,
    },
    {
      name: "POST /add-mod-advanced",
      route: "/add-mod-advanced",
      body: { workshopId: WS_NEW, selectedModIds: ["NewMod"] },
      mods: `Alpha;${NUMERIC};Beta;NewMod`,
    },
    {
      name: "POST /enable-disk-mod",
      route: "/enable-disk-mod",
      setup: (f) => f.writeIni(`Mods=Alpha;${NUMERIC}\nWorkshopItems=${NOT_DOWNLOADED_WS}\n`),
      body: { workshopId: WS_BETA },
      mods: `Alpha;${NUMERIC};Beta`,
    },
    {
      name: "POST /delete-disk-mod",
      route: "/delete-disk-mod",
      body: { workshopId: WS_BETA },
      mods: `Alpha;${NUMERIC}`,
    },
    {
      name: "POST /batch-delete-disk-mods",
      route: "/batch-delete-disk-mods",
      body: { workshopIds: [WS_BETA] },
      mods: `Alpha;${NUMERIC}`,
    },
    {
      name: "POST /resolve-orphan-workshop",
      route: "/resolve-orphan-workshop",
      setup: (f) => f.writeIni(`Mods=Alpha;${NUMERIC}\nWorkshopItems=${WS_BETA}\n`),
      body: { workshopIds: [WS_BETA] },
      mods: `Alpha;${NUMERIC};Beta`,
    },
    {
      name: "POST /toggle-mod-id",
      route: "/toggle-mod-id",
      body: { modId: "Gamma", enabled: true },
      mods: `Alpha;${NUMERIC};Beta;Gamma`,
    },
    {
      name: "POST /batch-toggle-mod-ids",
      route: "/batch-toggle-mod-ids",
      body: { changes: [{ modId: "Gamma", enabled: true }] },
      mods: `Alpha;${NUMERIC};Beta;Gamma`,
    },
  ];

  for (const c of cases) {
    it(`${c.name} leaves ${NUMERIC} on the Mods= line`, async () => {
      c.setup?.(fx);
      const res = await runRoute(c.route, "post", { body: c.body });
      expect(res.getStatusCode()).toBe(200);
      expect(fx.iniValue("Mods")).toBe(c.mods);
    });
  }
});

describe("a numeric id the edit itself adds still needs a mod.info to vouch for it", () => {
  let fx;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      }),
    );
    fx = makeServerFixture({ prefix: "mods-numeric-new-", ini: "Mods=Alpha\nWorkshopItems=\n" });
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
  });

  afterEach(() => {
    fx.cleanup();
    vi.unstubAllGlobals();
  });

  it("POST /add-to-ini enables a disk-verified numeric mod id of the item being added", async () => {
    fx.writeMod("7777777777", "TearAllClothes", `name=Tear All Clothes\nid=${NUMERIC}\n`);
    const res = await runRoute("/add-to-ini", "post", { body: { workshopId: "7777777777" } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().modId).toBe(NUMERIC);
    expect(fx.iniValue("Mods")).toBe(`Alpha;${NUMERIC}`);
  });

  it("POST /add-mod-advanced (include all) enables it too, and reports only what was written", async () => {
    fx.writeMod("7777777777", "TearAllClothes", `name=Tear All Clothes\nid=${NUMERIC}\n`);
    const res = await runRoute("/add-mod-advanced", "post", {
      body: { workshopId: "7777777777", includeAllModIds: true },
    });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().addedModIds).toEqual([NUMERIC]);
    expect(fx.iniValue("Mods")).toBe(`Alpha;${NUMERIC}`);
  });

  it("POST /add-mod-advanced refuses an unverified numeric id and does not claim it was added", async () => {
    const res = await runRoute("/add-mod-advanced", "post", {
      body: { workshopId: WS_NEW, selectedModIds: ["1234567890", "RealMod"] },
    });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().addedModIds).toEqual(["RealMod"]);
    expect(fx.iniValue("Mods")).toBe("Alpha;RealMod");
  });
});
