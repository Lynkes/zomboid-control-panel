import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fakeApp, linkDir, makeServerTree, makeTempDir, removeDir, write } from "./helpers/fileManagerFixtures.js";

// Protected areas and world state (spec §A5): every area at its level, the
// ancestor rule, names the bridge owns in any case, the list-only backups
// folder, the world-save gate for each live state, launch scripts only for
// managed launches, and a Zomboid folder nested inside another root.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
  };
});

const service = await import("../services/fileManagerService.js");
const { buildProtectionContext, buildRemoteProtectionContext } = await import("../services/fileManagerProtectedAreas.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests, _setRunStateDepsForTests } = await import("../services/fileManagerRunState.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");
const { getDataPaths, getPanelProgramDir } = await import("../utils/paths.js");
const { FmError } = await import("../services/fileManagerContract.js");

const user = { userId: "u1", username: "kate", role: "admin" };
let base;
let tree;

function audit() {
  return { defer: () => ({ finish: async () => {} }) };
}

async function ctx(app = fakeApp()) {
  return service.loadProfileContext(tree.profile.id, app);
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FmError) return err;
    throw err;
  }
  throw new Error("expected an FmError");
}

function rules(rootId, rootReal, extra = {}) {
  return buildProtectionContext({ rootId, rootReal, profiles: [tree.profile], settings: dbState.settings, ...extra });
}

function relOf(from, to) {
  return path.relative(fs.realpathSync.native(from), fs.realpathSync.native(to)).split(path.sep).join("/");
}

beforeEach(() => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  dbState.settings = {};
  invalidateRootCache();
  _setRunStateDepsForTests({});
  _resetRunStateCacheForTests();
  service._resetPreviewsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetWorkshopReleaseCacheForTests();
  removeDir(base);
});

describe("areas and levels", () => {
  it("the panel's data, logs, program folder and paths.config.json are sealed", () => {
    const { dataDir, logsDir, configPath } = getDataPaths();
    const around = fs.realpathSync.native(path.dirname(dataDir));
    const r = rules("data", around);
    expect(r.classify(`${relOf(around, dataDir)}/db.json`)).toEqual({ level: "sealed", area: "panelData" });
    expect(r.classify(`${relOf(around, logsDir)}/combined.log`)).toEqual({ level: "sealed", area: "panelLogs" });
    expect(r.classify(relOf(around, configPath))).toEqual({ level: "sealed", area: "panelProgram" });

    const programParent = fs.realpathSync.native(path.dirname(getPanelProgramDir()));
    const p = rules("install", programParent);
    expect(p.classify(`${relOf(programParent, getPanelProgramDir())}/server/index.js`)).toEqual({
      level: "sealed",
      area: "panelProgram",
    });
  });

  it("panel secret files are sealed by inode, including hard-link aliases", () => {
    const key = write(path.join(tree.data, "certs-copy", "panel.key"), "KEY");
    fs.linkSync(key, path.join(tree.data, "alias.key"));
    dbState.settings = { httpsKeyPath: key };
    const r = rules("data", tree.data);
    const aliasStat = fs.statSync(path.join(tree.data, "alias.key"), { bigint: true });
    expect(r.classify("alias.key", { type: "file", dev: aliasStat.dev, ino: aliasStat.ino })).toEqual({
      level: "sealed",
      area: "panelSecret",
    });
    expect(r.protectedWithin("certs-copy")).toMatchObject({ area: "panelSecret", containsProtected: true });
  });

  it("credentials folders are sealed at any depth", () => {
    const r = rules("data", tree.data);
    expect(r.classify(".ssh/id_ed25519")).toEqual({ level: "sealed", area: "credentials" });
    expect(r.classify("home/pz/.gnupg")).toEqual({ level: "sealed", area: "credentials" });
    expect(r.classify("steam/.steam/config.vdf")).toEqual({ level: "sealed", area: "credentials" });
    expect(r.classify("steam/steamapps")).toBeNull();
  });

  it("backups is list-only in the data folder only", () => {
    expect(rules("data", tree.data).classify("backups/world-1.zip")).toEqual({ level: "listOnly", area: "panelBackups" });
    expect(rules("data", tree.data).classify("backups")).toEqual({ level: "listOnly", area: "panelBackups" });
    expect(rules("install", tree.install).classify("backups/x")).toBeNull();
  });

  it("Lua/panelbridge is read-only under the data and the install folder, at any depth", () => {
    expect(rules("data", tree.data).classify("Lua/panelbridge/servertest/commands.json")).toEqual({
      level: "readOnly",
      area: "bridgeIo",
    });
    expect(rules("install", tree.install).classify("Zomboid/lua/PanelBridge/x")).toEqual({
      level: "readOnly",
      area: "bridgeIo",
    });
    expect(rules("data", tree.data).classify("Lua/other.lua")).toBeNull();
  });

  it("the live bridge folder is read-only wherever it is", () => {
    const live = path.join(tree.data, "custom-bridge");
    fs.mkdirSync(live);
    expect(rules("data", tree.data, { bridgePath: live }).classify("custom-bridge/status.json")).toEqual({
      level: "readOnly",
      area: "bridgeIo",
    });
  });

  it("the bridge's own install files are read-only in any case, and the Workshop item folder too", () => {
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "3809901056");
    _resetWorkshopReleaseCacheForTests();
    write(path.join(tree.install, "mod.info"), "name=PanelBridge\nid=PanelBridge\n");
    const r = rules("install", tree.install);
    for (const rel of [
      "media/lua/server/PanelBridge.lua",
      "media/lua/server/panelbridge.lua",
      "MEDIA/LUA/SERVER/PANELBRIDGE.LUA",
      "media/lua/client/PanelBridgeClient.lua",
      "mod.info",
      "steamapps/workshop/content/108600/3809901056/mods/ZCPB/mod.info",
    ]) {
      expect(r.classify(rel), rel).toEqual({ level: "readOnly", area: "bridgeManaged" });
    }
    expect(r.classify("media/lua/server/Other.lua")).toBeNull();
    expect(r.classify("steamapps/workshop/content/108600/12345")).toBeNull();
  });

  it("an unrelated root mod.info is not the bridge's", () => {
    write(path.join(tree.install, "mod.info"), "name=Other\nid=OtherMod\n");
    expect(rules("install", tree.install).classify("mod.info")).toBeNull();
  });

  it("launch scripts are list-only when the panel manages the launch: they carry -adminpassword", () => {
    const listOnly = { level: "listOnly", area: "launchScripts" };
    const managed = rules("install", tree.install);
    expect(managed.classify("StartServer_servertest.bat")).toEqual(listOnly);
    expect(managed.classify("start-server_servertest.sh")).toEqual(listOnly);
    expect(managed.classify(".pz-panel-scripts.json")).toEqual(listOnly);
    expect(managed.classify("start-server.sh")).toBeNull();
    // The copies the panel keeps of a hand-edited script hold the same password.
    expect(managed.classify("StartServer_servertest.bat.bak-2026-09-29T00-00-00-000Z")).toEqual(listOnly);
    expect(managed.classify("start-server_servertest.sh.bak-2026-09-29T00-00-00-000Z-2")).toEqual(listOnly);
    expect(managed.classify("StartServer_servertest.bat.bak-x/inner")).toBeNull();
    expect(managed.protectedWithin("")).not.toBeNull();

    const custom = { ...tree.profile, installPath: path.join(tree.install, "my-launcher.bat") };
    const r = buildProtectionContext({ rootId: "install", rootReal: tree.install, profiles: [custom], settings: {} });
    // The panel never deletes a script it generated: one from before the
    // switch to a custom launcher still holds the admin password.
    expect(r.classify("StartServer_servertest.bat")).toEqual(listOnly);
    expect(r.classify("StartServer_servertest.bat.bak-2026-09-29T00-00-00-000Z")).toEqual(listOnly);
    expect(r.classify("my-launcher.bat")).toBeNull();
    expect(r.classify(".pz-panel-scripts.json")).toBeNull();
  });

  it("scripts the panel generated under an earlier server name stay list-only too", () => {
    const listOnly = { level: "listOnly", area: "launchScripts" };
    const install = rules("install", tree.install);
    for (const name of [
      "StartServer_oldname.bat",
      "start-server_oldname.sh",
      "StartServer_oldname.bat.bak-2026-09-01T00-00-00-000Z",
      "start-server_oldname.sh.bak-2026-09-01T00-00-00-000Z-2",
    ]) {
      expect(install.classify(name), name).toEqual(listOnly);
    }
    // The stock scripts have no underscore after the stem.
    for (const name of ["StartServer64.bat", "StartServer64_nosteam.bat", "start-server.sh", "start-nosteam-server.sh"]) {
      expect(install.classify(name), name).toBeNull();
    }
    // A build before #167 wrote them into installPath even with a separate
    // launch folder: that folder is covered as well as the launch folder.
    const launch = path.join(base, "launch");
    write(path.join(launch, "ProjectZomboid64.json"), "{}\n");
    const separate = { ...tree.profile, serverPath: launch };
    const inInstall = buildProtectionContext({ rootId: "install", rootReal: tree.install, profiles: [separate], settings: {} });
    expect(inInstall.classify("StartServer_servertest.bat")).toEqual(listOnly);
    const inLaunch = buildProtectionContext({ rootId: "launch", rootReal: fs.realpathSync.native(launch), profiles: [separate], settings: {} });
    expect(inLaunch.classify("StartServer_servertest.bat")).toEqual(listOnly);
  });

  it("the panel's feature secrets, per-server secrets and database backups are sealed by inode too", () => {
    // A hard link stands in for a bind-mount alias of the data folder inside
    // a root: the path anchors can't see it, only the inode can.
    const { dataDir } = getDataPaths();
    const secrets = [
      write(path.join(dataDir, "discordBotToken.secret"), "DISCORD-TOKEN"),
      write(path.join(dataDir, "oidcClientSecret.secret"), "OIDC-SECRET"),
      write(path.join(dataDir, "server-secrets", "p1.secret"), "RCON-AND-ADMIN"),
      write(path.join(dataDir, "backups", "db-20260930.json"), '{"users":[]}'),
    ];
    const r = rules("data", tree.data);
    for (const [i, secret] of secrets.entries()) {
      const alias = path.join(tree.data, "aliases", `alias-${i}`);
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.linkSync(secret, alias);
      const st = fs.statSync(alias, { bigint: true });
      expect(r.classify(`aliases/alias-${i}`, { type: "file", dev: st.dev, ino: st.ino }), path.basename(secret)).toEqual({
        level: "sealed",
        area: "panelSecret",
      });
    }
  });

  it("PanelBridge's own files are read-only in a separate launch folder too (the installer writes there)", () => {
    const launch = path.join(base, "launch");
    write(path.join(launch, "ProjectZomboid64.json"), "{}\n");
    const separate = { ...tree.profile, serverPath: path.join(launch, "StartServer64.bat") };
    const inLaunch = buildProtectionContext({ rootId: "launch", rootReal: fs.realpathSync.native(launch), profiles: [separate], settings: {} });
    const bridgeManaged = { level: "readOnly", area: "bridgeManaged" };
    expect(inLaunch.classify("media/lua/server/PanelBridge.lua")).toEqual(bridgeManaged);
    expect(inLaunch.classify("media/lua/client/PanelBridgeClient.lua")).toEqual(bridgeManaged);
    expect(inLaunch.protectedWithin("media")).toMatchObject({ area: "bridgeManaged", containsProtected: true });
    // A launch subfolder of the install folder has no root of its own: the
    // install root reaches it.
    const nested = { ...tree.profile, serverPath: path.join(tree.install, "game", "StartServer64.bat") };
    fs.mkdirSync(path.join(tree.install, "game"), { recursive: true });
    const inInstall = buildProtectionContext({ rootId: "install", rootReal: tree.install, profiles: [nested], settings: {} });
    expect(inInstall.classify("game/media/lua/server/PanelBridge.lua")).toEqual(bridgeManaged);
  });

  it("World Backups and a world save moved elsewhere behind a link stay protected where they really are", () => {
    // backups moved into the game folder, a link left in its place
    fs.renameSync(path.join(tree.data, "backups"), path.join(tree.install, "bk"));
    linkDir(path.join(tree.install, "bk"), path.join(tree.data, "backups"));
    // the world save moved there as well
    fs.mkdirSync(path.join(tree.install, "worlds"), { recursive: true });
    fs.renameSync(path.join(tree.data, "Saves", "Multiplayer", "servertest"), path.join(tree.install, "worlds", "servertest"));
    linkDir(path.join(tree.install, "worlds", "servertest"), path.join(tree.data, "Saves", "Multiplayer", "servertest"));
    const install = rules("install", tree.install);
    expect(install.classify("bk/world-1.zip")).toEqual({ level: "listOnly", area: "panelBackups" });
    expect(install.isWorldState("worlds/servertest/map_0_0.bin")).toBe(true);
    expect(install.worldStateOwners("worlds/servertest")).toEqual([tree.profile]);
  });

  it("anchors match in any case on every OS (a case-insensitive mount under a Linux panel)", () => {
    const data = rules("data", tree.data);
    expect(data.classify("BACKUPS/world-1.zip")).toEqual({ level: "listOnly", area: "panelBackups" });
    expect(data.isWorldState("saves/multiplayer/SERVERTEST/map_0_0.bin")).toBe(true);
    expect(data.worldStateOwners("DB/servertest.DB")).toHaveLength(1);
    expect(rules("install", tree.install).classify("START-SERVER_servertest.SH")).toEqual({ level: "listOnly", area: "launchScripts" });
  });

  it("a Zomboid folder inside the game folder keeps its areas through the install root", () => {
    const install = path.join(base, "PZServer");
    const data = path.join(install, "Zomboid");
    write(path.join(install, "ProjectZomboid64.json"), "{}\n");
    write(path.join(data, "backups", "world-1.zip"), "zip");
    write(path.join(data, "Saves", "Multiplayer", "servertest", "map_0_0.bin"), "world");
    write(path.join(data, "Lua", "panelbridge", "servertest", "status.json"), "{}");
    const profile = { ...tree.profile, installPath: install, zomboidDataPath: data, serverConfigPath: path.join(data, "Server") };
    const r = buildProtectionContext({ rootId: "install", rootReal: fs.realpathSync.native(install), profiles: [profile], settings: {} });
    expect(r.classify("Zomboid/backups/world-1.zip")).toEqual({ level: "listOnly", area: "panelBackups" });
    expect(r.isWorldState("Zomboid/Saves/Multiplayer/servertest/map_0_0.bin")).toBe(true);
    expect(r.worldStateOwners("Zomboid")).toEqual([profile]);
    expect(r.protectedWithin("Zomboid")).toMatchObject({ containsProtected: true });
    // And the other way round: a game install folder inside a data root.
    const nested = { ...tree.profile, installPath: path.join(tree.data, "server") };
    fs.mkdirSync(path.join(tree.data, "server"), { recursive: true });
    const d = buildProtectionContext({ rootId: "data", rootReal: tree.data, profiles: [nested], settings: {} });
    expect(d.classify("server/media/lua/server/PanelBridge.lua")).toEqual({ level: "readOnly", area: "bridgeManaged" });
  });

  it("a remote install root protects the bridge's Workshop folder like a local one", () => {
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "3809901056");
    _resetWorkshopReleaseCacheForTests();
    const rel = "steamapps/workshop/content/108600/3809901056/mods/PanelBridge/media/lua/server/PanelBridge.lua";
    const remote = buildRemoteProtectionContext({ rootId: "install", rootReal: "/srv/pz", profile: tree.profile, settings: {} });
    expect(remote.classify(rel)).toEqual({ level: "readOnly", area: "bridgeManaged" });
    expect(rules("install", tree.install).classify(rel)).toEqual({ level: "readOnly", area: "bridgeManaged" });
    expect(remote.classify("steamapps/workshop/content/108600/12345/x")).toBeNull();
  });

  it("the ancestor rule: a folder holding something protected reports it", () => {
    const r = rules("data", tree.data);
    expect(r.protectedWithin("Lua")).toMatchObject({ area: "bridgeIo", level: "readOnly", containsProtected: true });
    expect(r.protectedWithin("Server")).toBeNull();
  });
});

describe("through the service", () => {
  it("creating, uploading or renaming to PanelBridge.lua in any case is refused", async () => {
    write(path.join(tree.install, "media", "lua", "server", "Mine.lua"), "-- mine");
    const c = await ctx();
    const created = await failure(
      service.saveText(c, { root: "install", path: "media/lua/server/panelbridge.lua", content: "x", etag: null, eol: "lf", bom: false, confirm: ["serverRunning"] }, user, audit()),
    );
    expect(created.code).toBe("FM_PATH_PROTECTED");
    const renamed = await failure(
      service.renameEntry(c, { root: "install", path: "media/lua/server/Mine.lua", newName: "PANELBRIDGE.LUA", confirm: [] }, user, audit()),
    );
    expect(renamed.code).toBe("FM_PATH_PROTECTED");
    expect(renamed.params).toMatchObject({ area: "bridgeManaged", level: "readOnly" });
  });

  it("the bridge's command folder can be read but not changed", async () => {
    const c = await ctx();
    const text = await service.readText(c, { root: "data", path: "Lua/panelbridge/servertest/status.json" });
    expect(text.readOnly).toBe(true);
    expect(text.readOnlyReason).toBe("protected");
    const err = await failure(
      service.saveText(c, { root: "data", path: "Lua/panelbridge/servertest/status.json", content: "{}", etag: text.etag, eol: "lf", bom: false, confirm: [] }, user, audit()),
    );
    expect(err.code).toBe("FM_PATH_PROTECTED");
    const renameParent = await failure(
      service.renameEntry(c, { root: "data", path: "Lua", newName: "Lua2", confirm: [] }, user, audit()),
    );
    expect(renameParent.params).toMatchObject({ containsProtected: true, area: "bridgeIo" });
  });

  it("backups can be listed but not read or changed", async () => {
    const c = await ctx();
    const listing = await service.listDir(c, { root: "data", path: "backups" });
    expect(listing.entries.map((e) => e.name)).toEqual(["world-1.zip"]);
    expect(listing.entries[0].flags.editable).toBe(false);
    expect((await failure(service.openDownload(c, { root: "data", path: "backups/world-1.zip" }, user, {}))).code).toBe(
      "FM_PATH_PROTECTED",
    );
    const preview = await failure(service.deletePreview(c, { root: "data", paths: ["backups/world-1.zip"] }, user));
    expect(preview.code).toBe("FM_PATH_PROTECTED");
  });

  it("a delete of a folder that holds a protected area deeper down is refused after the preview", async () => {
    write(path.join(tree.data, "nested", "Zomboid", "Lua", "panelbridge", "s", "status.json"), "{}");
    const c = await ctx();
    const preview = await service.deletePreview(c, { root: "data", paths: ["nested"] }, user);
    expect(preview.items[0].containsProtected).toBe(true);
    const err = await failure(
      service.deleteItems(c, { root: "data", previewId: preview.previewId, mode: "trash", confirm: [] }, user, audit()),
    );
    expect(err.code).toBe("FM_PATH_PROTECTED");
    expect(err.params).toMatchObject({ containsProtected: true, area: "bridgeIo" });
    expect(fs.existsSync(path.join(tree.data, "nested"))).toBe(true);
  });
});

describe("world state gate", () => {
  const savePath = "Saves/Multiplayer/servertest/notes.txt";

  async function save(app, confirm = []) {
    return service.saveText(await ctx(app), { root: "data", path: savePath, content: "x", etag: null, eol: "lf", bom: false, confirm }, user, audit());
  }

  it("running: world save mutations are blocked", async () => {
    const err = await failure(save(fakeApp({ running: true })));
    expect(err.code).toBe("FM_SERVER_RUNNING_BLOCKED");
    expect(fs.existsSync(path.join(tree.data, savePath))).toBe(false);
  });

  it("unknown: they need the serverRunning confirmation", async () => {
    const err = await failure(save(fakeApp({ scanFailed: true })));
    expect(err.code).toBe("FM_CONFIRMATION_REQUIRED");
    expect(err.params.required).toEqual(["serverRunning"]);
    expect(err.details).toEqual({ serverState: "unknown" });
    _resetRunStateCacheForTests();
    const ok = await save(fakeApp({ scanFailed: true }), ["serverRunning"]);
    expect(ok.status).toBe(201);
  });

  it("stopped: allowed", async () => {
    const ok = await save(fakeApp({ running: false }));
    expect(ok.status).toBe(201);
  });

  it("config files outside the world save need no confirmation while running, and say to restart", async () => {
    const c = await ctx(fakeApp({ running: true }));
    const read = await service.readText(c, { root: "data", path: "Server/servertest_SandboxVars.lua" });
    const saved = await service.saveText(
      c,
      { root: "data", path: "Server/servertest_SandboxVars.lua", content: "SandboxVars = { a = 1 }\n", etag: read.etag, eol: "lf", bom: false, confirm: [] },
      user,
      audit(),
    );
    expect(saved.body.restartRequired).toBe(true);
    expect(saved.body.hints).toContain("restartToApply");
  });

  it("the player database is world state too, and a Saves folder rename holds a world save", async () => {
    const c = await ctx(fakeApp({ running: true }));
    const err = await failure(service.renameEntry(c, { root: "data", path: "Saves", newName: "Saves-old", confirm: [] }, user, audit()));
    expect(err.code).toBe("FM_SERVER_RUNNING_BLOCKED");
    const listing = await service.listDir(c, { root: "data", path: "db" });
    expect(listing.entries.find((e) => e.name === "servertest.db").flags.worldState).toBe(true);
  });
});
