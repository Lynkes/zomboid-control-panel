import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// Adding a mod by URL: when the item is not on the server yet and its mod IDs
// cannot be read, the dialog asks the server to download it with SteamCMD
// (`download: true`) so the IDs come from its own files and are enabled with it.
// Without that the mod went into WorkshopItems= only, the server downloaded it
// after it had read Mods= on its next boot, and the mod was never enabled.

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
  removeIgnoredMods: vi.fn(),
  clearAllIgnoredMods: vi.fn(),
  isModIgnored: vi.fn(async () => false),
  getIgnoredModPairs: vi.fn(async () => []),
  addIgnoredModPair: vi.fn(),
  removeIgnoredModPair: vi.fn(),
}));

const downloadWorkshopItem = vi.fn();
vi.mock("../services/workshopDownload.js", () => ({
  downloadWorkshopItem: (...args) => downloadWorkshopItem(...args),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

const WS_ID = "3519629457";
let fx;

beforeEach(() => {
  fx = makeServerFixture({ ini: "Mods=\nWorkshopItems=\n" });
  getActiveServer.mockResolvedValue(fx.activeServer);
  // Steam's description gives nothing: the case that needs the download.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ response: { publishedfiledetails: [{ publishedfileid: WS_ID, result: 9 }] } }) })));
  // SteamCMD downloads into the folder it is given (the panel's cache).
  downloadWorkshopItem.mockReset().mockImplementation(async (id, opts) => {
    const dir = path.join(opts.serverPath, "steamapps", "workshop", "content", "108600", String(id), "mods", "TearAllClothing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mod.info"), "id=TearAllClothing\nname=Tear All Clothing\n");
    return { success: true };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fx.cleanup();
});

const discover = (body) => runRoute("/discover-mod-ids", "post", { body: { workshopId: WS_ID, ...body } });

describe("POST /discover-mod-ids with download: true", () => {
  it("downloads an item the server does not have and reads its mod IDs from the files", async () => {
    const res = await discover({ download: true });

    expect(downloadWorkshopItem).toHaveBeenCalledTimes(1);
    expect(downloadWorkshopItem.mock.calls[0][0]).toBe(WS_ID);
    // Into the panel's own cache, never the game server's Workshop folder
    // (whose files and appworkshop_108600.acf the server writes when it starts).
    const cacheRoot = downloadWorkshopItem.mock.calls[0][1].serverPath;
    expect(cacheRoot).not.toBe(fx.installPath);
    expect(cacheRoot).toMatch(/workshop-download-cache$/);
    expect(fs.existsSync(path.join(fx.installPath, "steamapps", "workshop", "content", "108600", WS_ID))).toBe(false);
    // The cached copy is dropped once its IDs are read.
    expect(fs.existsSync(path.join(cacheRoot, "steamapps", "workshop", "content", "108600", WS_ID))).toBe(false);
    expect(res.getBody()).toMatchObject({
      success: true,
      modIds: ["TearAllClothing"],
      isDownloaded: false,
      downloadedFromSteam: true,
      sources: [{ modId: "TearAllClothing", source: "steamcmd-download" }],
    });
  });

  it("does not download without being asked", async () => {
    const res = await discover({});

    expect(downloadWorkshopItem).not.toHaveBeenCalled();
    expect(res.getBody()).toMatchObject({ modIds: [], isDownloaded: false, downloadedFromSteam: false });
  });

  it("does not download an item that is already on the server", async () => {
    fx.writeMod(WS_ID, "TearAllClothing", "id=TearAllClothing\n");

    const res = await discover({ download: true });

    expect(downloadWorkshopItem).not.toHaveBeenCalled();
    expect(res.getBody()).toMatchObject({ modIds: ["TearAllClothing"], isDownloaded: true, downloadedFromSteam: false });
  });

  it("falls back to what Steam's description says when SteamCMD cannot download", async () => {
    downloadWorkshopItem.mockResolvedValue({ success: false, reason: "steamcmd-not-configured", error: "SteamCMD is not configured" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ response: { publishedfiledetails: [{ publishedfileid: WS_ID, result: 1, title: "Tear All Clothing", description: "Mod ID: TearAllClothing" }] } }),
    })));

    const res = await discover({ download: true });

    expect(res.getBody()).toMatchObject({
      modIds: ["TearAllClothing"],
      downloadedFromSteam: false,
      downloadSkippedReason: "steamcmd-not-configured",
      sources: [{ modId: "TearAllClothing", source: "steam-description" }],
    });
  });

  it("leaves a remote server alone", async () => {
    getActiveServer.mockResolvedValue({ ...fx.activeServer, isRemote: true });

    const res = await discover({ download: true });

    expect(downloadWorkshopItem).not.toHaveBeenCalled();
    expect(res.getBody().downloadSkippedReason).toBe("remote-server");
  });
});
