import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// Adding a mod by URL: when the item is not on the server yet and its mod IDs
// cannot be read, the dialog asks the server to download it with SteamCMD
// (`download: true`) so the IDs come from its own files and are enabled with it.
// Without that the mod went into WorkshopItems= only, the server downloaded it
// after it had read Mods= on its next boot, and the mod was never enabled.
//
// bp5 (2026-10-20): each request downloads into a folder of its own under
// <dataDir>/workshop-download-cache/ and removes it whole afterwards. With one
// shared folder, appworkshop_108600.acf outlived the dropped files (SteamCMD
// then reports a later download of the same item as done without fetching
// it), and two adds at once deleted each other's files.

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
const { getDataPaths } = await import("../utils/paths.js");
const runRoute = createRouteRunner(router);

const WS_ID = "3519629457";
let fx;

const cacheRoot = () => path.join(getDataPaths().dataDir, "workshop-download-cache");
const acfPath = (installDir) => path.join(installDir, "steamapps", "workshop", "appworkshop_108600.acf");

// What SteamCMD does with +force_install_dir <dir> +workshop_download_item:
// writes the item under <dir>/steamapps/workshop/content/108600/<id> and
// records it in <dir>/steamapps/workshop/appworkshop_108600.acf. An item the
// .acf already lists as installed is reported downloaded without fetching it
// again, even when its files are gone.
async function fakeSteamCmd(id, opts) {
  const acf = acfPath(opts.serverPath);
  if (fs.existsSync(acf) && fs.readFileSync(acf, "utf8").includes(`"${id}"`)) {
    return { success: true };
  }
  const dir = path.join(opts.serverPath, "steamapps", "workshop", "content", "108600", String(id), "mods", "TearAllClothing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mod.info"), "id=TearAllClothing\nname=Tear All Clothing\n");
  fs.writeFileSync(acf, `"AppWorkshop"\n{\n  "WorkshopItemsInstalled"\n  {\n    "${id}"\n    {\n    }\n  }\n}\n`);
  return { success: true };
}

beforeEach(() => {
  fx = makeServerFixture({ ini: "Mods=\nWorkshopItems=\n" });
  getActiveServer.mockResolvedValue(fx.activeServer);
  // Steam's description gives nothing: the case that needs the download.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ response: { publishedfiledetails: [{ publishedfileid: WS_ID, result: 9 }] } }) })));
  downloadWorkshopItem.mockReset().mockImplementation(fakeSteamCmd);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fx.cleanup();
  fs.rmSync(cacheRoot(), { recursive: true, force: true });
});

const discover = (body) => runRoute("/discover-mod-ids", "post", { body: { workshopId: WS_ID, ...body } });

describe("POST /discover-mod-ids with download: true", () => {
  it("downloads an item the server does not have and reads its mod IDs from the files", async () => {
    const res = await discover({ download: true });

    expect(downloadWorkshopItem).toHaveBeenCalledTimes(1);
    expect(downloadWorkshopItem.mock.calls[0][0]).toBe(WS_ID);
    // Into a folder of its own in the panel's cache, never the game server's
    // Workshop folder (whose files and appworkshop_108600.acf the server
    // writes when it starts).
    const downloadDir = downloadWorkshopItem.mock.calls[0][1].serverPath;
    expect(downloadDir).not.toBe(fx.installPath);
    expect(path.dirname(downloadDir)).toBe(cacheRoot());
    expect(path.basename(downloadDir)).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(path.join(fx.installPath, "steamapps", "workshop", "content", "108600", WS_ID))).toBe(false);
    // The whole folder goes once its IDs are read, the .acf with it.
    expect(fs.existsSync(acfPath(downloadDir))).toBe(false);
    expect(fs.existsSync(downloadDir)).toBe(false);
    expect(res.getBody()).toMatchObject({
      success: true,
      modIds: ["TearAllClothing"],
      isDownloaded: false,
      downloadedFromSteam: true,
      sources: [{ modId: "TearAllClothing", source: "steamcmd-download" }],
    });
  });

  it("downloads the same mod again on a second add (no .acf left to skip it)", async () => {
    const first = await discover({ download: true });
    const second = await discover({ download: true });

    expect(first.getBody().modIds).toEqual(["TearAllClothing"]);
    expect(second.getBody()).toMatchObject({
      modIds: ["TearAllClothing"],
      downloadedFromSteam: true,
      sources: [{ modId: "TearAllClothing", source: "steamcmd-download" }],
    });
    const [firstDir, secondDir] = downloadWorkshopItem.mock.calls.map((call) => call[1].serverPath);
    expect(secondDir).not.toBe(firstDir);
    expect(fs.existsSync(firstDir)).toBe(false);
    expect(fs.existsSync(secondDir)).toBe(false);
  });

  it("keeps two adds at once apart: the first to finish doesn't delete the other's files", async () => {
    let releaseFirst;
    const firstMayFinish = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted;
    const secondHasStarted = new Promise((resolve) => {
      secondStarted = resolve;
    });
    let releaseSecond;
    const secondMayFinish = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    downloadWorkshopItem
      .mockImplementationOnce(async (id, opts) => {
        const result = await fakeSteamCmd(id, opts);
        await firstMayFinish;
        return result;
      })
      .mockImplementationOnce(async (id, opts) => {
        const result = await fakeSteamCmd(id, opts);
        secondStarted();
        await secondMayFinish;
        return result;
      });

    const first = discover({ download: true });
    const second = discover({ download: true });
    await secondHasStarted;
    releaseFirst();
    expect((await first).getBody().modIds).toEqual(["TearAllClothing"]);
    releaseSecond();
    expect((await second).getBody()).toMatchObject({ modIds: ["TearAllClothing"], downloadedFromSteam: true });
  });

  it("removes its folder when SteamCMD fails too", async () => {
    downloadWorkshopItem.mockImplementation(async (id, opts) => {
      fs.mkdirSync(path.dirname(acfPath(opts.serverPath)), { recursive: true });
      fs.writeFileSync(acfPath(opts.serverPath), "partial");
      return { success: false, reason: "failed", error: "Timed out" };
    });

    await discover({ download: true });

    expect(fs.existsSync(downloadWorkshopItem.mock.calls[0][1].serverPath)).toBe(false);
  });

  it("sweeps folders left over an hour ago, and leaves newer ones", async () => {
    const root = cacheRoot();
    const old = path.join(root, "11111111-1111-4111-8111-111111111111");
    const legacy = path.join(root, "steamapps"); // the earlier shared layout
    const recent = path.join(root, "22222222-2222-4222-8222-222222222222");
    for (const dir of [old, legacy, recent]) fs.mkdirSync(path.join(dir, "steamapps", "workshop"), { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const dir of [old, legacy]) fs.utimesSync(dir, twoHoursAgo, twoHoursAgo);

    await discover({ download: true });

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
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
