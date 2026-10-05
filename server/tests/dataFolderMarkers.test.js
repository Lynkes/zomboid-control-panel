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
// Real routers over the real, unmocked database layer (the suite's per-file
// temp data dir keeps it isolated), with the signed-in role injected.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: backupRouter } = await import("../routes/backup.js");
const { default: chunksRouter } = await import("../routes/chunks.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { BackupService } = await import("../services/backupService.js");
const { checkZomboidDataPath, zomboidDataFolderHolds } = await import("../services/zomboidDataPath.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const NOT_A_DATA_FOLDER = ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER;

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
  await db.updateServer(localId, { zomboidDataPath: realData, serverConfigPath: null, isRemote: false });
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
  // Map Cleanup delete-with-backup, and a restore's leftover staging folder.
  function build145Shape(name) {
    const multiplayer = path.join(root, name, "Zomboid", "Saves", "Multiplayer");
    writeWorld(path.join(multiplayer, "Victim"));
    fs.mkdirSync(path.join(multiplayer, "76561198000000000_Victim_player"), { recursive: true });
    write(path.join(multiplayer, "backups", "Victim_chunks_1759600000000-0a1b2c3d", "map_0_0.bin"), "chunk");
    write(path.join(multiplayer, "backups", "Victim_2026-10-01T10-00-00-000.zip"), "zip");
    fs.mkdirSync(path.join(multiplayer, ".restore-staging-1759600000000-4242"), { recursive: true });
    fs.mkdirSync(path.join(multiplayer, ".restore-staging-6f1c2a1e-7b7c-4c39-9a35-8f0e1d2c3b4a"), {
      recursive: true,
    });
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
    expect(mods.json.code).not.toBe(NOT_A_DATA_FOLDER);
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
  });
});
