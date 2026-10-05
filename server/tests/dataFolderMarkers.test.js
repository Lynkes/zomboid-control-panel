import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// PT1 (security sweep 2026-10-05, final round): the data-folder rule
// (services/zomboidDataPath.js) took any Saves or Multiplayer folder as a
// sign of a real data folder (existsSync(), which on Windows also matched
// "saves"), and any folder named like a save file ("map") as a world save.
// It also accepts a folder that doesn't exist yet, and panel features
// created folders inside a data folder even when they only read: GET
// /api/backup/list and /status made <data>/backups, GET
// /api/server-files/templates made <config>/templates. So a technician saved
// <folder>/Saves as a server's data folder, opened Backups, and then saved
// <folder> itself -- and chunks /browse listed everything in it. A marker
// counts now only when it holds what the game writes (a world folder with
// save files, names compared as the folder lists them), and the read-only
// routes create nothing.
//
// PT2: in 1.4.5 Map Cleanup's "Save as default" could store a
// Saves/Multiplayer folder as a server's data folder, and the panel then
// made backups/ in it (the Backups page, Map Cleanup's delete-with-backup
// backups) -- after the update the rule refused that folder everywhere.
//
// Verifier round 1: players.db counted as a world save, and the game also
// writes <cachedir>/db/<server name>.db -- a server named "players" started
// with <folder>/Saves/x as its data folder made <folder> pass. And a
// Saves/Multiplayer data folder holding the panel's own Server/ (the config
// folder 1.4.5 and 1.4.6 make there when none is set) or Lua/ (PanelBridge's
// queue) was refused again.
//
// Verifier round 2: the File Manager's Trash (.zcp-trash, at the top of its
// "data" root, the server's data folder, since 1.4.5) and its temp files
// were none of those entries, so a 1.4.5 Saves/Multiplayer data folder the
// File Manager had ever deleted or edited in -- and a data folder with no
// world save yet -- were refused everywhere. And the "nothing but the game's
// own entries" branch went by names alone.
//
// Real routers over the real, unmocked database layer (the suite's per-file
// temp data dir keeps it isolated), with the signed-in role injected.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { generateStartupScripts } = await import("../routes/server.js");
const { default: backupRouter } = await import("../routes/backup.js");
const { default: chunksRouter } = await import("../routes/chunks.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { BackupService } = await import("../services/backupService.js");
const { checkZomboidDataPath, zomboidDataFolderHolds } = await import("../services/zomboidDataPath.js");
const fileManagerTrash = await import("../services/fileManagerTrash.js");
const fileManagerFs = await import("../services/fileManagerLocalFs.js");
const { RENAME_TEMP_SUFFIX, TRASH_DIR_NAME, UPLOAD_TEMP_SUFFIX } = await import("../services/fileManagerContract.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const NOT_A_DATA_FOLDER = ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER;
const FOLDER_REFUSED = ErrorCode.ZOMBOID_DATA_FOLDER_REFUSED;

let baseUrl;
let httpServer;
let currentRole = "technician";
let root;
let installDir;
let realData;
let localId;

async function call(method, url, body) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

function write(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A world save as the B42 game writes one: the map folder and save files.
function writeWorld(dir) {
  fs.mkdirSync(path.join(dir, "map", "0"), { recursive: true });
  write(path.join(dir, "map", "0", "0.bin"), "chunk");
  write(path.join(dir, "map_t.bin"), "t");
  write(path.join(dir, "players.db"), "db");
}

// Someone's folder that was never a data folder.
function privateFolder(name) {
  const dir = path.join(root, name);
  write(path.join(dir, "Documents", "secret-project", "plan.txt"), "private");
  write(path.join(dir, "notes.txt"), "private");
  return dir;
}

// What the File Manager does when the operator saves `relPath` in its "data"
// root (writeBytesCas()): the previous version goes to the root's Trash.
function fileManagerEdit(dataRoot, relPath) {
  return fileManagerTrash.copyVersionToTrash(fs.realpathSync(dataRoot), {
    name: path.basename(relPath),
    buffer: Buffer.from("previous version"),
    originalPath: relPath,
    deletedBy: { userId: "u-admin", username: "admin" },
    reason: "edited",
  });
}

// A temp file an upload or a save in flight leaves beside its target when
// the request is cut off, named as the File Manager names it.
function fileManagerTemp(dir, nameHint, suffix) {
  const temp = fileManagerFs.createTempFile(dir, nameHint, suffix);
  fileManagerFs.closeFd(temp.fd);
  return temp.name;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-data-markers-"));
  installDir = path.join(root, "pz-install");
  realData = path.join(root, "Zomboid");
  fs.mkdirSync(installDir, { recursive: true });
  writeWorld(path.join(realData, "Saves", "Multiplayer", "Victim"));
  fs.mkdirSync(path.join(realData, "Server"), { recursive: true });

  await db.initDatabase();
  const local = await db.createServer({
    name: "Local",
    serverName: "Victim",
    installPath: installDir,
    zomboidDataPath: realData,
    rconHost: "127.0.0.1",
    rconPort: 27941,
    rconPassword: "x",
  });
  localId = local.id;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", {
    reloadConfig: async () => {},
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  });
  app.set("backupService", new BackupService());
  app.use("/api/servers", serversRouter);
  app.use("/api/backup", backupRouter);
  app.use("/api/chunks", chunksRouter);
  app.use("/api/server-files", serverFilesRouter);
  app.use("/api/mods", modsRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  currentRole = "technician";
  await db.updateServer(localId, {
    zomboidDataPath: realData,
    serverConfigPath: null,
    serverName: "Victim",
    isRemote: false,
  });
  await db.setActiveServer(localId);
});

describe("PT1: a Saves or Multiplayer folder counts only when it holds a world save", () => {
  it("what the panel creates in a Saves folder never makes the folder around it pass", () => {
    const shapes = {
      "Saves/backups": (dir) => fs.mkdirSync(path.join(dir, "Saves", "backups"), { recursive: true }),
      "Saves/Server/templates": (dir) =>
        fs.mkdirSync(path.join(dir, "Saves", "Server", "templates"), { recursive: true }),
      "an empty world folder": (dir) =>
        fs.mkdirSync(path.join(dir, "Saves", "Multiplayer", "Victim"), { recursive: true }),
      "a world with only a map folder": (dir) =>
        fs.mkdirSync(path.join(dir, "Saves", "Multiplayer", "Victim", "map", "Server"), { recursive: true }),
      "a folder named like a save file": (dir) =>
        fs.mkdirSync(path.join(dir, "Saves", "Multiplayer", "Victim", "players.db", "Server"), {
          recursive: true,
        }),
      "Multiplayer/backups": (dir) => fs.mkdirSync(path.join(dir, "Multiplayer", "backups"), { recursive: true }),
    };
    for (const [label, make] of Object.entries(shapes)) {
      const dir = privateFolder(`manufactured-${label.replace(/\W+/g, "-")}`);
      make(dir);
      expect(zomboidDataFolderHolds(dir), label).toBe(false);
      const check = checkZomboidDataPath(dir);
      expect(check.ok, label).toBe(false);
      expect(check.body.code, label).toBe(NOT_A_DATA_FOLDER);
    }
  });

  it("a 'map' folder (or one named like a save file) directly in a folder isn't a world save", () => {
    for (const name of ["map", "players.db", "map_t.bin"]) {
      const dir = privateFolder(`direct-${name}`);
      fs.mkdirSync(path.join(dir, name, "backups"), { recursive: true });
      expect(zomboidDataFolderHolds(dir), name).toBe(false);
    }
  });

  it("names are compared as the folder lists them: 'saves' with a world in it isn't the game's Saves", () => {
    const dir = privateFolder("lowercase-saves");
    writeWorld(path.join(dir, "saves", "Multiplayer", "World"));
    expect(zomboidDataFolderHolds(dir)).toBe(false);
    expect(checkZomboidDataPath(dir).ok).toBe(false);
  });

  // The game writes more than worlds under its -cachedir (a server's data
  // folder): db/<server name>.db (ServerWorldDatabase.connect()), a
  // server-side mod's files in Lua/ by any name (getFileOutput() checks only
  // for ".."), a local mod's in mods/<mod>/. With the data folder at
  // <folder>/Saves/x those land where the rule looks for worlds; at
  // <folder>/Saves, where it looks for game modes.
  it("what the game writes outside a world never counts as one: db/players.db, Lua/ and mods/ files", () => {
    const shapes = [
      "Saves/x/db/players.db",
      "Saves/x/Lua/map_t.bin",
      "Saves/Multiplayer/Lua/WorldDictionary.bin",
      "Saves/Lua/w/map_t.bin",
      "Saves/mods/SomeMod/map_t.bin",
      "Multiplayer/Lua/map_t.bin",
    ];
    for (const file of shapes) {
      const dir = privateFolder(`game-written-${file.replace(/\W+/g, "-")}`);
      write(path.join(dir, ...file.split("/")), "written by the game");
      expect(zomboidDataFolderHolds(dir), file).toBe(false);
      expect(checkZomboidDataPath(dir).ok, file).toBe(false);
    }
  });

  it("the chain through the game: a server named 'players' started in <folder>/Saves/x -- <folder> is still refused", async () => {
    const victim = privateFolder("chain-db");
    const target = path.join(victim, "Saves", "x");
    const saved = await call("PUT", `/api/servers/${localId}`, { zomboidDataPath: target, serverName: "players" });
    expect(saved.status).toBe(200);

    // The start bakes both into the game's arguments ...
    const stored = await db.getServer(localId);
    const scripts = generateStartupScripts({
      installPath: installDir,
      serverName: stored.serverName,
      zomboidDataPath: stored.zomboidDataPath,
    });
    expect(`${scripts.bat}\n${scripts.sh}`).toContain(`-cachedir="${target}`);
    expect(`${scripts.bat}\n${scripts.sh}`).toContain('-servername "players"');
    // ... and the game then writes getCacheDir() + /db/ + serverName + .db.
    write(path.join(target, "db", "players.db"), "sqlite");

    const step2 = await call("PUT", `/api/servers/${localId}`, { zomboidDataPath: victim });
    expect(step2.status).toBe(400);
    expect(step2.json.code).toBe(NOT_A_DATA_FOLDER);
    const browse = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(victim)}`);
    expect(browse.status).not.toBe(200);
    expect(JSON.stringify(browse.json)).not.toContain("Documents");
  });

  it("a stored folder refused where it is used has its own code, which says where to set it", async () => {
    const refused = privateFolder("refused-in-use");
    await db.updateServer(localId, { zomboidDataPath: refused });
    const browse = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(refused)}`);
    expect(browse.status).toBe(400);
    expect(browse.json.code).toBe(FOLDER_REFUSED);
    expect(browse.json.error).toContain("My Servers page");
    expect(browse.json.error).toContain("a world save in its Saves folder");
    // Saving one is still the save-time refusal.
    expect(checkZomboidDataPath(refused).body.code).toBe(NOT_A_DATA_FOLDER);
  });

  it("still accepts a data folder the game has run in (with files of the operator's own), a Saves folder, a world save, a missing, an empty and an operator folder", () => {
    const lived = privateFolder("lived-in-Zomboid");
    writeWorld(path.join(lived, "Saves", "Multiplayer", "MyServer"));
    const client = privateFolder("client-only-Zomboid");
    // A client's per-server cache: GameTime writes map_t.bin there too.
    fs.mkdirSync(path.join(client, "Saves", "Multiplayer", "192.168.1.20_16261_abc", "map"), { recursive: true });
    write(path.join(client, "Saves", "Multiplayer", "192.168.1.20_16261_abc", "map_t.bin"));
    const singlePlayer = privateFolder("sp-Zomboid");
    write(path.join(singlePlayer, "Saves", "Sandbox", "2025-09-25_21-21-02", "WorldDictionary.bin"));
    const savesFolder = path.join(lived, "Saves");
    const world = path.join(lived, "Saves", "Multiplayer", "MyServer");
    const empty = path.join(root, "empty-data");
    fs.mkdirSync(empty, { recursive: true });
    const gameOnly = path.join(root, "first-start");
    write(path.join(gameOnly, "Server", "MyServer.ini"));
    write(path.join(gameOnly, "server-console.txt"));
    for (const dir of [lived, client, singlePlayer, savesFolder, world, empty, gameOnly, path.join(root, "not-yet")]) {
      expect(checkZomboidDataPath(dir).ok, dir).toBe(true);
    }

    const previous = process.env.PZ_SAVE_PATH;
    const dockerVolume = privateFolder("docker-volume");
    process.env.PZ_SAVE_PATH = dockerVolume;
    try {
      expect(zomboidDataFolderHolds(dockerVolume)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PZ_SAVE_PATH;
      else process.env.PZ_SAVE_PATH = previous;
    }
  });

  it("the chain: <folder>/Saves saved while missing, Backups opened, then <folder> -- refused, and nothing was created", async () => {
    const victim = privateFolder("chain-home");
    const step1 = await call("PUT", `/api/servers/${localId}`, { zomboidDataPath: path.join(victim, "Saves") });
    expect(step1.status).toBe(200);

    for (const url of ["/api/backup/list", "/api/backup/status"]) {
      const r = await call("GET", url);
      expect(r.status, url).toBe(200);
    }
    const templates = await call("GET", "/api/server-files/templates");
    expect(templates.status).toBe(200);
    expect(templates.json.templates).toEqual([]);
    const mods = await call("GET", "/api/mods/current-config");
    expect(mods.status).toBe(200);
    expect(fs.existsSync(path.join(victim, "Saves"))).toBe(false);

    const step2 = await call("PUT", `/api/servers/${localId}`, { zomboidDataPath: victim });
    expect(step2.status).toBe(400);
    expect(step2.json.code).toBe(NOT_A_DATA_FOLDER);
    const browse = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(path.join(victim, "Documents"))}`);
    expect(browse.status).not.toBe(200);
    expect(JSON.stringify(browse.json)).not.toContain("secret-project");
  });

  it("the same chain through a missing <folder>/map", async () => {
    const victim = privateFolder("chain-map");
    expect((await call("PUT", `/api/servers/${localId}`, { zomboidDataPath: path.join(victim, "map") })).status).toBe(
      200,
    );
    await call("GET", "/api/backup/list");
    await call("GET", "/api/server-files/templates");
    expect(fs.existsSync(path.join(victim, "map"))).toBe(false);
    const step2 = await call("PUT", `/api/servers/${localId}`, { zomboidDataPath: victim });
    expect(step2.status).toBe(400);
  });

  it("writing still creates what it writes into, in a data folder that passes", async () => {
    const backupsDir = path.join(realData, "backups");
    fs.rmSync(backupsDir, { recursive: true, force: true });
    const list = await call("GET", "/api/backup/list");
    expect(list.status).toBe(200);
    expect(fs.existsSync(backupsDir)).toBe(false);

    const result = await new BackupService().createBackup({});
    expect(result.success).toBe(true);
    expect(fs.readdirSync(backupsDir).some((name) => name.endsWith(".zip"))).toBe(true);

    currentRole = "admin";
    const saved = await call("POST", "/api/server-files/templates", { name: "Kept", type: "ini" });
    expect(saved.status).toBeLessThan(300);
    expect(fs.existsSync(path.join(realData, "Server", "templates"))).toBe(true);
    const listed = await call("GET", "/api/server-files/templates");
    expect(listed.json.templates.map((t) => t.name)).toContain("Kept");
  });
});

describe("PT2: a 1.4.5 Saves/Multiplayer data folder with the panel's own entries in it", () => {
  // As 1.4.5 left one: a dedicated server's world, the client's per-server
  // cache (this machine also plays), backups/ from the Backups page and a
  // Map Cleanup delete-with-backup, a restore's leftover staging folder, and
  // the config folder the panel makes as <data folder>/Server when the
  // record has none -- templates/ from the Server Config Templates dialog,
  // <name>.ini from the RCON settings a start writes, backups/ from an
  // edit -- and PanelBridge's queue in Lua/panelbridge/<server>/. And
  // (verifier round 2) the File Manager's Trash, from an edit of
  // Server/Victim.ini in its "data" root, an upload's temp file a cut-off
  // request left, and client caches as the game names them, saved into or
  // not yet.
  function build145Shape(name) {
    const multiplayer = path.join(root, name, "Zomboid", "Saves", "Multiplayer");
    writeWorld(path.join(multiplayer, "Victim"));
    fs.mkdirSync(path.join(multiplayer, "76561198000000000_Victim_player"), { recursive: true });
    writeWorld(path.join(multiplayer, "192.168.2.5_16261_21232f297a57a5a743894a0e4a801fc3"));
    writeWorld(path.join(multiplayer, "192.168.2.5_16261_21232f297a57a5a743894a0e4a801fc3_crash"));
    fs.mkdirSync(path.join(multiplayer, "play.example.com_16262_ce5c82deca471f66ce07c96745e2eaee"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(multiplayer, "Victim_player"), { recursive: true });
    write(path.join(multiplayer, "backups", "Victim_chunks_1759600000000-0a1b2c3d", "map_0_0.bin"), "chunk");
    write(path.join(multiplayer, "backups", "Victim_2026-10-01T10-00-00-000.zip"), "zip");
    fs.mkdirSync(path.join(multiplayer, ".restore-staging-1759600000000-4242"), { recursive: true });
    fs.mkdirSync(path.join(multiplayer, ".restore-staging-6f1c2a1e-7b7c-4c39-9a35-8f0e1d2c3b4a"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(multiplayer, "Server", "templates"), { recursive: true });
    write(path.join(multiplayer, "Server", "Victim.ini"), "RCONPort=27015\nRCONPassword=x\n");
    write(path.join(multiplayer, "Server", "backups", "Victim.ini.2026-10-01T10-00-00-000Z.bak"), "Mods=\n");
    fs.mkdirSync(path.join(multiplayer, "Lua", "panelbridge", "Victim", "inbox"), { recursive: true });
    fs.mkdirSync(path.join(multiplayer, "Lua", "panelbridge", "Victim", "outbox"), { recursive: true });
    fileManagerEdit(multiplayer, "Server/Victim.ini");
    fileManagerTemp(multiplayer, "Victim-world.zip", UPLOAD_TEMP_SUFFIX);
    return multiplayer;
  }

  it("is accepted, and chunks /browse, backups and mods work for that server again", async () => {
    const multiplayer = build145Shape("upgrade-145");
    expect(zomboidDataFolderHolds(multiplayer)).toBe(true);
    expect(checkZomboidDataPath(multiplayer).ok).toBe(true);

    await db.updateServer(localId, { zomboidDataPath: multiplayer, serverConfigPath: null });
    const browse = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(multiplayer)}`);
    expect(browse.status).toBe(200);
    expect(browse.json.directories).toEqual(expect.arrayContaining(["Victim", "backups"]));
    const list = await call("GET", "/api/backup/list");
    expect(list.status).toBe(200);
    expect(list.json.backups.map((b) => b.name)).toContain("Victim_2026-10-01T10-00-00-000.zip");
    const mods = await call("GET", "/api/mods/current-config");
    expect(mods.json.code).not.toBe(FOLDER_REFUSED);
    expect(mods.json.code).not.toBe(NOT_A_DATA_FOLDER);
  });

  it("is still accepted once the panel has started the server there (the game's -cachedir)", () => {
    const started = build145Shape("upgrade-145-started");
    write(path.join(started, "server-console.txt"), "SERVER STARTED\n");
    write(path.join(started, "console.txt"), "");
    write(path.join(started, "Logs", "2026-10-05_10-00_chat.txt"), "");
    write(path.join(started, "db", "Victim.db"), "sqlite");
    write(path.join(started, "Server", "Victim_SandboxVars.lua"), "SandboxVars = {}\n");
    fs.mkdirSync(path.join(started, "Saves", "Multiplayer"), { recursive: true });
    expect(zomboidDataFolderHolds(started)).toBe(true);
    expect(checkZomboidDataPath(started).ok).toBe(true);
  });

  it("the panel's entries don't count as the world save the folder must hold, and anything else is still refused", () => {
    const noWorld = path.join(root, "no-world", "Saves", "Multiplayer");
    fs.mkdirSync(path.join(noWorld, "backups", "Victim_chunks_1-ab"), { recursive: true });
    fs.mkdirSync(path.join(noWorld, ".restore-staging-1-2"), { recursive: true });
    fs.mkdirSync(path.join(noWorld, "76561198000000000_Victim_player"), { recursive: true });
    expect(zomboidDataFolderHolds(noWorld)).toBe(false);

    const extra = build145Shape("upgrade-145-extra");
    write(path.join(extra, "notes.txt"), "not the game's");
    expect(zomboidDataFolderHolds(extra)).toBe(false);
    const backupsFile = build145Shape("upgrade-145-file");
    fs.rmSync(path.join(backupsFile, "backups"), { recursive: true });
    write(path.join(backupsFile, "backups"), "a file, not the panel's folder");
    expect(zomboidDataFolderHolds(backupsFile)).toBe(false);
    const serverFile = build145Shape("upgrade-145-server-file");
    fs.rmSync(path.join(serverFile, "Server"), { recursive: true });
    write(path.join(serverFile, "Server"), "a file, not the panel's folder");
    expect(zomboidDataFolderHolds(serverFile)).toBe(false);

    const gameFileAsFolder = build145Shape("upgrade-145-console-folder");
    fs.mkdirSync(path.join(gameFileAsFolder, "server-console.txt", "Documents"), { recursive: true });
    expect(zomboidDataFolderHolds(gameFileAsFolder)).toBe(false);

    // Server/ and Lua/ are let through, never counted, whatever they hold
    // (next to a player cache, which isn't one of the game's own entries, so
    // the folder isn't let through as nothing but those).
    for (const entry of ["Server", "Lua", "backups"]) {
      const onlyPanel = path.join(root, `only-${entry}`, "Saves", "Multiplayer");
      writeWorld(path.join(onlyPanel, entry));
      fs.mkdirSync(path.join(onlyPanel, "76561198000000000_Victim_player"), { recursive: true });
      expect(zomboidDataFolderHolds(onlyPanel), entry).toBe(false);
    }
  });

  it("stays accepted through the File Manager: a stale cache deleted to its Trash, the Trash emptied, a case-only rename cut off", async () => {
    const multiplayer = build145Shape("upgrade-145-file-manager");
    const rootReal = fs.realpathSync(multiplayer);
    const stale = path.join(multiplayer, "192.168.2.5_16261_21232f297a57a5a743894a0e4a801fc3");
    const trashId = fileManagerTrash.moveToTrash(rootReal, stale, {
      originalPath: path.basename(stale),
      type: "folder",
      bytes: 0,
      files: 1,
      deletedBy: { userId: "u-admin", username: "admin" },
      reason: "deleted",
      dev: null,
    });
    expect(zomboidDataFolderHolds(multiplayer)).toBe(true);
    await fileManagerTrash.purgeTrashItem(rootReal, trashId);
    expect(fs.readdirSync(path.join(multiplayer, TRASH_DIR_NAME))).not.toContain(trashId);
    expect(zomboidDataFolderHolds(multiplayer)).toBe(true);
    // A case-only rename moves the entry through .<name>.case.<hex>.zcptmp.
    fs.renameSync(
      path.join(multiplayer, "Victim_player"),
      path.join(multiplayer, `.Victim_player.case.0a1b2c3d${RENAME_TEMP_SUFFIX}`),
    );
    fileManagerTemp(multiplayer, "Victim.ini", RENAME_TEMP_SUFFIX);
    expect(zomboidDataFolderHolds(multiplayer)).toBe(true);
    expect(checkZomboidDataPath(multiplayer).ok).toBe(true);

    await db.updateServer(localId, { zomboidDataPath: multiplayer, serverConfigPath: null });
    const browse = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(multiplayer)}`);
    expect(browse.status).toBe(200);
    const list = await call("GET", "/api/backup/list");
    expect(list.json.backups.map((b) => b.name)).toContain("Victim_2026-10-01T10-00-00-000.zip");
    const mods = await call("GET", "/api/mods/current-config");
    expect(mods.json.code).not.toBe(FOLDER_REFUSED);
    const templates = await call("GET", "/api/server-files/templates");
    expect(templates.status).toBe(200);
  });

  it("the File Manager's entries never count as the world save, and are let through only as what it makes", () => {
    // A world in the Trash, or under a case-rename temp name, isn't one.
    const noWorld = path.join(root, "fm-no-world", "Saves", "Multiplayer");
    writeWorld(path.join(noWorld, TRASH_DIR_NAME, "Victim"));
    writeWorld(path.join(noWorld, `.Victim.case.0a1b2c3d${RENAME_TEMP_SUFFIX}`));
    fs.mkdirSync(path.join(noWorld, "76561198000000000_Victim_player"), { recursive: true });
    expect(zomboidDataFolderHolds(noWorld)).toBe(false);

    // The Trash is a folder; a temp is a file (a folder only as a
    // case-rename's); and the names are the File Manager's exactly.
    const withoutTrash = (dir) => fs.rmSync(path.join(dir, TRASH_DIR_NAME), { recursive: true });
    const shapes = {
      "a file named like the Trash": (dir) => {
        withoutTrash(dir);
        write(path.join(dir, TRASH_DIR_NAME), "x");
      },
      "the Trash's name in capitals": (dir) => {
        withoutTrash(dir);
        fs.mkdirSync(path.join(dir, TRASH_DIR_NAME.toUpperCase()));
      },
      "an upload temp that is a folder": (dir) =>
        fs.mkdirSync(path.join(dir, `.notes.1234.0a1b2c3d${UPLOAD_TEMP_SUFFIX}`), { recursive: true }),
      "a file ending like a temp, not named like one": (dir) => write(path.join(dir, `notes${UPLOAD_TEMP_SUFFIX}`)),
    };
    for (const [label, make] of Object.entries(shapes)) {
      const dir = build145Shape(`upgrade-145-fm-${label.replace(/\W+/g, "-")}`);
      make(dir);
      expect(zomboidDataFolderHolds(dir), label).toBe(false);
    }
  });
});

describe("a data folder with no world save yet: the game's own entries, as the game makes them", () => {
  function firstStart(name) {
    const dir = path.join(root, name, "Zomboid");
    write(path.join(dir, "Server", "Victim.ini"), "Mods=\n");
    write(path.join(dir, "Logs", "2026-10-05_10-00_DebugLog-server.txt"));
    write(path.join(dir, "server-console.txt"));
    return dir;
  }

  it("is still accepted once the File Manager has edited in it or an upload was cut off there", () => {
    const fresh = firstStart("fm-fresh");
    expect(zomboidDataFolderHolds(fresh)).toBe(true);
    fileManagerEdit(fresh, "Server/Victim.ini");
    fileManagerTemp(fresh, "server-console.txt", UPLOAD_TEMP_SUFFIX);
    fileManagerTemp(path.join(fresh, "Server"), "Victim.ini", RENAME_TEMP_SUFFIX);
    expect(zomboidDataFolderHolds(fresh)).toBe(true);
    expect(checkZomboidDataPath(fresh).ok).toBe(true);
  });

  it("accepts a world the game hasn't saved yet and the folders it keeps in Saves", () => {
    const started = firstStart("fresh-saves");
    fs.mkdirSync(path.join(started, "Saves", "Multiplayer", "Victim", "map"), { recursive: true });
    write(path.join(started, "Saves", "Multiplayer", "Victim", "players.db"), "db");
    fs.mkdirSync(path.join(started, "Saves", "Multiplayer", "Victim.replaced-1759600000000"), { recursive: true });
    fs.mkdirSync(path.join(started, "Saves", "Sandbox"), { recursive: true });
    write(path.join(started, "Saves", ".DS_Store"));
    write(path.join(started, ".DS_Store"));
    expect(zomboidDataFolderHolds(started)).toBe(true);
    expect(checkZomboidDataPath(started).ok).toBe(true);
  });

  it("refuses entries that only carry the game's names, and a File Manager name never counts as a game mode or world", () => {
    const shapes = {
      // Another program's folder, every top-level name one of the game's.
      "files directly in a Saves mode folder": (dir) => {
        write(path.join(dir, "Saves", "slot1", "private-notes.txt"), "private");
        write(path.join(dir, "Screenshots", "a.png"));
        write(path.join(dir, "mods", "SomeMod", "readme.txt"));
      },
      "a file directly in Saves": (dir) => write(path.join(dir, "Saves", "profile.json"), "private"),
      "a file named Saves": (dir) => write(path.join(dir, "Saves"), "private"),
      "a folder named like a game file": (dir) =>
        write(path.join(dir, "console.txt", "secret-project", "plan.txt"), "private"),
    };
    for (const [label, make] of Object.entries(shapes)) {
      const dir = path.join(root, `names-only-${label.replace(/\W+/g, "-")}`);
      write(path.join(dir, "Logs", "today.log"));
      make(dir);
      expect(zomboidDataFolderHolds(dir), label).toBe(false);
      expect(checkZomboidDataPath(dir).ok, label).toBe(false);
    }

    // With the data folder at <folder>/Saves, the File Manager's Trash is
    // <folder>/Saves/.zcp-trash: a world under it isn't a game mode's.
    const victim = privateFolder("fm-trash-mode");
    writeWorld(path.join(victim, "Saves", TRASH_DIR_NAME, "Victim"));
    writeWorld(path.join(victim, "Saves", "Multiplayer", `.Victim.case.0a1b2c3d${RENAME_TEMP_SUFFIX}`));
    expect(zomboidDataFolderHolds(victim)).toBe(false);
    expect(checkZomboidDataPath(victim).ok).toBe(false);
  });
});
