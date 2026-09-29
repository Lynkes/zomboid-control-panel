import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Live test on a 42.21 Steam-mode dedicated server installed through the
// Steam client, in the library the operator also plays from
// (D:\SteamLibrary\steamapps\common\ProjectZomboid): the server downloaded
// its Workshop items into <install>\steamapps\workshop, as it always does
// (its working folder's steamapps\workshop). The panel instead walked up the
// parents, took D:\SteamLibrary\steamapps\workshop\appworkshop_108600.acf
// -- the Steam client's, holding the operator's own player subscriptions --
// and kept it for the life of the panel. The mod checker then checked and
// flagged items that weren't on the server at all, and the PanelBridge
// delivery status reported the Workshop item as downloaded before the
// server had downloaded anything.

let activeServer = null;

vi.mock("../database/init.js", () => ({
  getTrackedMods: vi.fn(async () => []),
  updateModTimestamp: vi.fn(),
  logServerEvent: vi.fn(),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
  addTrackedMod: vi.fn(),
  getActiveServer: vi.fn(async () => activeServer),
  isModIgnored: vi.fn(async () => false),
  markModsChecked: vi.fn(),
}));

const { getActiveServer } = await import("../database/init.js");
const { ModChecker, WORKSHOP_ACF_WATCH_INTERVAL_MS, getWorkshopAcfCandidates, refreshWorkshopChecker } =
  await import("../services/modChecker.js");
const { detectWorkshopItem } = await import("../services/bridgeDisk.js");

const ACF = "appworkshop_108600.acf";
const ID = "3809901056";
const EMPTY_ACF = '"AppWorkshop"\n{\n\t"appid"\t\t"108600"\n}\n';

function acfIn(dir) {
  return path.join(dir, "steamapps", "workshop", ACF);
}

function writeAcf(acfPath) {
  fs.mkdirSync(path.dirname(acfPath), { recursive: true });
  fs.writeFileSync(acfPath, EMPTY_ACF);
}

function makeBridgeItem(workshopDir) {
  const modDir = path.join(workshopDir, "content", "108600", ID, "mods", "ZCPB", "42");
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, "mod.info"), "name=Zomboid Control Panel Bridge\nid=ZCPB\nmodversion=1.7.70\n");
  return path.join(workshopDir, "content", "108600", ID);
}

describe("getWorkshopAcfCandidates on a Steam library install", () => {
  const library = path.join(path.parse(process.cwd()).root, "SteamLibrary");
  const install = path.join(library, "steamapps", "common", "ProjectZomboid");

  it("starts with the server's own <install>/steamapps/workshop", () => {
    expect(getWorkshopAcfCandidates(install)[0]).toBe(acfIn(install));
  });

  it("never lists the library's own steamapps/workshop, nor anything outside the app folder", () => {
    // Older Steam clients wrote SteamApps/, and the game's own launcher
    // (ProjectZomboidServer.bat) sits in the client install.
    const oldCase = path.join(library, "SteamApps", "Common", "ProjectZomboid");
    for (const [configured, appFolder] of [
      [install, install],
      [`${install}${path.sep}`, install],
      [path.join(install, "StartServer64.bat"), install],
      [path.join(install, "ProjectZomboidServer.bat"), install],
      [oldCase, oldCase],
    ]) {
      const candidates = getWorkshopAcfCandidates(configured);
      expect(candidates[0]).toBe(acfIn(appFolder));
      expect(candidates.map((candidate) => candidate.toLowerCase())).not.toContain(
        path.join(library, "steamapps", "workshop", ACF).toLowerCase(),
      );
      for (const candidate of candidates) {
        expect(path.relative(appFolder, candidate).startsWith("..")).toBe(false);
      }
    }
  });

  it("does the same for the Linux Steam client's library", () => {
    const home = path.join(path.parse(process.cwd()).root, "home", "pz");
    const steamLibrary = path.join(home, ".local", "share", "Steam");
    const linuxInstall = path.join(steamLibrary, "steamapps", "common", "Project Zomboid Dedicated Server");
    const candidates = getWorkshopAcfCandidates(path.join(linuxInstall, "start-server.sh"));
    expect(candidates[0]).toBe(acfIn(linuxInstall));
    expect(candidates).not.toContain(acfIn(steamLibrary));
  });
});

describe("getWorkshopAcfCandidates on other layouts", () => {
  it("puts a SteamCMD force_install_dir install's own folder first", () => {
    const install = path.join(path.parse(process.cwd()).root, "PZServer");
    expect(getWorkshopAcfCandidates(path.join(install, "StartServer64.bat"))[0]).toBe(acfIn(install));
  });

  it("puts the all-in-one Docker image's /pz-server/steamapps/workshop first", () => {
    const install = path.join(path.parse(process.cwd()).root, "pz-server");
    expect(getWorkshopAcfCandidates(install)[0]).toBe(acfIn(install));
  });

  it("still accepts a configured path that is itself a workshop folder", () => {
    const library = path.join(path.parse(process.cwd()).root, "SteamLibrary");
    const workshopDir = path.join(library, "steamapps", "workshop");
    expect(getWorkshopAcfCandidates(workshopDir)).toContain(path.join(workshopDir, ACF));
  });
});

describe("Workshop ACF and item detection on disk", () => {
  let root;
  let library;
  let install;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-acf-library-"));
    library = path.join(root, "SteamLibrary");
    install = path.join(library, "steamapps", "common", "ProjectZomboid");
    fs.mkdirSync(install, { recursive: true });
    // The operator plays from this library: the Steam client's Workshop
    // folder holds their subscriptions, PanelBridge's item among them.
    writeAcf(acfIn(library));
    makeBridgeItem(path.join(library, "steamapps", "workshop"));
    activeServer = { installPath: install };
  });

  afterEach(() => {
    activeServer = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds no ACF and no item until the server has downloaded into its own folder", async () => {
    const checker = new ModChecker();
    expect(await checker.findWorkshopAcfPath()).toBeNull();
    expect(checker.workshopAcfPath).toBeNull();
    expect(detectWorkshopItem(install, ID)).toBeNull();

    writeAcf(acfIn(install));
    const serverItem = makeBridgeItem(path.join(install, "steamapps", "workshop"));
    expect(await checker.findWorkshopAcfPath()).toBe(acfIn(install));
    expect(detectWorkshopItem(install, ID)).toEqual({ folder: serverItem, version: "1.7.70", source: "candidate" });
  });

  it("skips a library's workshop folder beside an install outside common/", async () => {
    const beside = path.join(library, "PZServer");
    fs.mkdirSync(beside, { recursive: true });
    activeServer = { installPath: beside };
    expect(getWorkshopAcfCandidates(beside)).not.toContain(acfIn(library));
    expect(await new ModChecker().findWorkshopAcfPath()).toBeNull();
    expect(detectWorkshopItem(beside, ID)).toBeNull();
  });

  it("re-resolves on each check, so the server's own ACF replaces a fallback found earlier", async () => {
    // A layout the older guesses still cover: a steamapps folder beside the
    // install that is not a Steam library (no common/).
    const parent = path.join(root, "servers");
    const serverInstall = path.join(parent, "pzserver");
    fs.mkdirSync(serverInstall, { recursive: true });
    writeAcf(acfIn(parent));
    activeServer = { installPath: serverInstall };

    const checker = new ModChecker();
    expect(await checker.findWorkshopAcfPath()).toBe(acfIn(parent));

    writeAcf(acfIn(serverInstall));
    await checker.checkForUpdates();
    expect(checker.workshopAcfPath).toBe(acfIn(serverInstall));
  });

  it("drops a check's lookup that a server switch overtook", async () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    writeAcf(acfIn(first));
    writeAcf(acfIn(second));
    activeServer = { installPath: first };
    const checker = new ModChecker();
    expect(await checker.findWorkshopAcfPath()).toBe(acfIn(first));

    // The check reads the active server just before the switch lands.
    let release;
    getActiveServer.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ installPath: first }); }),
    );
    const check = checker.checkForUpdates();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    activeServer = { installPath: second };
    expect(await checker.findWorkshopAcfPath()).toBe(acfIn(second));
    release();
    await check;
    expect(checker.workshopAcfPath).toBe(acfIn(second));
  });

  it("looks in the folder the server is launched from first, then its install path", async () => {
    const launchDir = path.join(root, "launch");
    const installDir = path.join(root, "install");
    writeAcf(acfIn(installDir));
    activeServer = { serverPath: launchDir, installPath: installDir };
    expect(await new ModChecker().findWorkshopAcfPath()).toBe(acfIn(installDir));

    writeAcf(acfIn(launchDir));
    expect(await new ModChecker().findWorkshopAcfPath()).toBe(acfIn(launchDir));
  });

  it("keeps the current ACF when a check resolves nothing", async () => {
    activeServer = null;
    const acfPath = path.join(root, "configured", ACF);
    writeAcf(acfPath);
    const checker = new ModChecker();
    checker.workshopAcfPath = acfPath;
    const result = await checker.checkForUpdates();
    expect(result.code).toBeUndefined();
    expect(checker.workshopAcfPath).toBe(acfPath);
  });
});

// The other half of the live-test layout: with the library's ACF no longer
// taken, a panel that boots before the server's first Workshop download
// finds no ACF at all. The checker used to start only at boot or on a
// server profile save, so update polling (and auto-restart on update) then
// stayed off, and the Mods page kept offering "Fix path", after the server
// had downloaded its items -- until the panel was restarted.
describe("a mod checker that booted before the server's first Workshop download", () => {
  let root;
  let install;
  let checker;

  beforeEach(() => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-acf-watch-"));
    const library = path.join(root, "SteamLibrary");
    install = path.join(library, "steamapps", "common", "ProjectZomboid");
    fs.mkdirSync(install, { recursive: true });
    writeAcf(acfIn(library));
    activeServer = { installPath: install };
    checker = new ModChecker();
  });

  afterEach(() => {
    checker.stop();
    vi.useRealTimers();
    activeServer = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts polling by itself once the server writes its own ACF", async () => {
    await expect(refreshWorkshopChecker(checker)).resolves.toBeNull();
    expect(checker.isRunning).toBe(false);

    await vi.advanceTimersByTimeAsync(WORKSHOP_ACF_WATCH_INTERVAL_MS);
    expect(checker.isRunning).toBe(false);

    writeAcf(acfIn(install));
    await vi.advanceTimersByTimeAsync(WORKSHOP_ACF_WATCH_INTERVAL_MS);
    expect(checker.isRunning).toBe(true);
    expect(checker.workshopAcfPath).toBe(acfIn(install));
    expect(checker.acfWatchInterval).toBeNull();
  });

  it("reports the server's ACF as soon as the Mods page asks", async () => {
    expect(await checker.findWorkshopAcfPath()).toBeNull();
    checker.watchForWorkshopAcf();
    expect((await checker.getStatus()).workshopAcfConfigured).toBe(false);

    writeAcf(acfIn(install));
    const status = await checker.getStatus();
    expect(status.workshopAcfConfigured).toBe(true);
    expect(status.workshopAcfPath).toBe(acfIn(install));
    expect(checker.isRunning).toBe(true);
  });

  it("stays stopped after an explicit stop", async () => {
    checker.watchForWorkshopAcf();
    checker.stop();
    writeAcf(acfIn(install));
    await vi.advanceTimersByTimeAsync(WORKSHOP_ACF_WATCH_INTERVAL_MS * 2);
    expect(checker.isRunning).toBe(false);
    expect((await checker.getStatus()).workshopAcfConfigured).toBe(false);
  });
});
