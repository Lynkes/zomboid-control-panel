import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// PATHS-1 (security sweep 2026-10-05): POST /api/servers stored a server's
// Zomboid data folder with no check, so a technician (servers.manage) named
// any folder on this computer as one -- then listed every folder name in it
// through /api/chunks/browse, reached its Server folder through Server Files,
// and had backups read and write under it. PUT /:id, chunks /save-path and
// the legacy app setting accepted any folder whose path merely said
// "zomboid". Every setter now holds the folder to one rule
// (services/zomboidDataPath.js), and the features that list or read under it
// apply the rule again when they use it.
//
// Full stack through the real routers and the real, unmocked database layer
// (the suite's per-file temp data dir keeps it isolated), with the
// signed-in role injected as req.user.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { default: chunksRouter } = await import("../routes/chunks.js");
const { default: configRouter } = await import("../routes/config.js");
const { BackupService } = await import("../services/backupService.js");
const { checkZomboidDataPath, isGameDataFolderEntry, zomboidDataFolderHolds } = await import(
  "../services/zomboidDataPath.js"
);
const { ErrorCode } = await import("../utils/errorCodes.js");

const NOT_A_DATA_FOLDER = ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER;

let baseUrl;
let httpServer;
let currentRole = "technician";
let root;
let installDir;
let realData;
let hostDir;
let namedDir;
let gameOnlyDir;
let serverId;

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

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-data-rule-"));
  installDir = path.join(root, "pz-install");
  realData = path.join(root, "RealData");
  // A folder on this computer that was never a data folder.
  hostDir = path.join(root, "unrelated-host-dir");
  // One whose path says "zomboid" -- inspectZomboidPath()'s name-only check
  // accepts it, so PUT and /save-path did.
  namedDir = path.join(root, "zomboid-notes");
  // What the game leaves in a data folder before any world exists.
  gameOnlyDir = path.join(root, "fresh-data");
  for (const dir of [
    installDir,
    path.join(realData, "Saves", "Multiplayer", "Victim"),
    path.join(realData, "Server"),
    path.join(hostDir, "secret-project"),
    namedDir,
    path.join(gameOnlyDir, "Logs"),
    path.join(gameOnlyDir, "Server"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(hostDir, "private-notes.txt"), "not a PZ file\n");
  fs.writeFileSync(path.join(hostDir, "credentials.env"), "X=1\n");
  fs.writeFileSync(path.join(namedDir, "notes.txt"), "not a PZ file\n");
  for (const name of ["server-console.txt", "options.ini", "zipfstmp4242.tmp", "log_5.txt"]) {
    fs.writeFileSync(path.join(gameOnlyDir, name), "");
  }

  await db.initDatabase();
  const server = await db.createServer({
    name: "Victim",
    serverName: "Victim",
    installPath: installDir,
    zomboidDataPath: realData,
    serverConfigPath: path.join(realData, "Server"),
    rconHost: "127.0.0.1",
    rconPort: 27998,
    rconPassword: "x",
  });
  serverId = server.id;
  await db.setActiveServer(serverId);

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", { reloadConfig: async () => {} });
  app.use("/api/servers", serversRouter);
  app.use("/api/server-files", serverFilesRouter);
  app.use("/api/chunks", chunksRouter);
  app.use("/api/config", configRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

// A record saved before the rule existed: written straight to the DB.
async function setStoredDataPath(zomboidDataPath, extra = {}) {
  await db.updateServer(serverId, { zomboidDataPath, serverConfigPath: null, isRemote: false, ...extra });
}

beforeEach(async () => {
  currentRole = "technician";
  await setStoredDataPath(realData, { serverConfigPath: path.join(realData, "Server") });
});

describe("the rule (services/zomboidDataPath.js)", () => {
  it("accepts a folder that doesn't exist yet, an empty one, one the game made, and a real one", () => {
    const empty = path.join(root, "empty-data");
    fs.mkdirSync(empty, { recursive: true });
    for (const value of [path.join(root, "not-created-yet"), empty, gameOnlyDir, realData]) {
      const check = checkZomboidDataPath(value);
      expect(check.ok).toBe(true);
      expect(check.path).toBe(path.resolve(value));
    }
  });

  it("refuses a folder holding anything the game doesn't put in a data folder, whatever its name says", () => {
    for (const value of [hostDir, namedDir]) {
      const check = checkZomboidDataPath(value);
      expect(check.ok).toBe(false);
      expect(check.body.code).toBe(NOT_A_DATA_FOLDER);
    }
  });

  // Verifier pass: inspectZomboidPath()'s hasSaveArtifacts also looks in
  // every folder just inside, so a folder holding unrelated files and some
  // project with a "map" folder in it passed. Save files count only directly
  // in the folder (a world save folder); a data folder's are under Saves/.
  it("counts save files directly in the folder, not in some folder inside it", () => {
    const project = path.join(root, "projects-with-a-map");
    fs.mkdirSync(path.join(project, "some-project", "map"), { recursive: true });
    fs.writeFileSync(path.join(project, "unrelated.txt"), "x");
    expect(checkZomboidDataPath(project).ok).toBe(false);
    expect(checkZomboidDataPath(project).body.code).toBe(NOT_A_DATA_FOLDER);
    expect(zomboidDataFolderHolds(project)).toBe(false);

    const worldSave = path.join(root, "a-world-save");
    fs.mkdirSync(path.join(worldSave, "map"), { recursive: true });
    fs.writeFileSync(path.join(worldSave, "map_sand.bin"), "");
    fs.writeFileSync(path.join(worldSave, "unrelated.txt"), "x");
    expect(checkZomboidDataPath(worldSave).ok).toBe(true);
  });

  it("refuses a server install folder, a file, a relative path and control characters", () => {
    const install = path.join(root, "ServerInstall");
    fs.mkdirSync(install, { recursive: true });
    fs.writeFileSync(path.join(install, "ProjectZomboid64.exe"), "");
    const file = path.join(root, "a-file.txt");
    fs.writeFileSync(file, "x");
    expect(checkZomboidDataPath(install).body.code).toBe(NOT_A_DATA_FOLDER);
    expect(checkZomboidDataPath(install).body.error).toMatch(/server install/i);
    for (const value of [file, "relative/Zomboid", `${realData}\nX`, 42, ""]) {
      const check = checkZomboidDataPath(value);
      expect(check.ok).toBe(false);
      expect(check.body.code).toBe(ErrorCode.ZOMBOID_DATA_PATH_INVALID);
    }
  });

  it("refuses a link that leads to an unrelated folder", () => {
    const link = path.join(root, "Zomboid-link");
    fs.symlinkSync(hostDir, link, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(checkZomboidDataPath(link).ok).toBe(false);
      expect(zomboidDataFolderHolds(link)).toBe(false);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it("refuses a missing folder named through an environment variable, and never echoes its value", () => {
    process.env.ZCP_DATA_RULE_SECRET = "super-secret-value";
    try {
      const value = path.join(root, "%ZCP_DATA_RULE_SECRET%");
      const check = checkZomboidDataPath(value);
      expect(check.ok).toBe(false);
      expect(check.body.error).toContain("%ZCP_DATA_RULE_SECRET%");
      expect(JSON.stringify(check.body)).not.toContain("super-secret-value");
    } finally {
      delete process.env.ZCP_DATA_RULE_SECRET;
    }
  });

  it("takes the folder PZ_SAVE_PATH names as it is", () => {
    const previous = process.env.PZ_SAVE_PATH;
    process.env.PZ_SAVE_PATH = hostDir;
    try {
      expect(checkZomboidDataPath(hostDir).ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PZ_SAVE_PATH;
      else process.env.PZ_SAVE_PATH = previous;
    }
  });

  it("knows the game's own entries, and nothing that merely resembles them", () => {
    for (const name of ["Saves", "Server", "Logs", "Lua", "db", "mods", "backups", "Sandbox Presets", "console.txt", "logs.zip", "log_12.txt", "zipfstmp123.tmp", "lost+found"]) {
      expect(isGameDataFolderEntry(name)).toBe(true);
    }
    for (const name of ["notes.txt", ".ssh", "package.json", "data", "server.js", "log_x.txt"]) {
      expect(isGameDataFolderEntry(name)).toBe(false);
    }
  });
});

describe("every place a data folder is saved", () => {
  const created = [];
  afterAll(async () => {
    for (const id of created) await db.deleteServer(id).catch(() => {});
    await db.setActiveServer(serverId);
  });

  const body = (extra) => ({
    name: `Created ${created.length}`,
    serverName: `Created${created.length}`,
    installPath: installDir,
    rconHost: "127.0.0.1",
    rconPort: 28100 + created.length,
    rconPassword: "x",
    ...extra,
  });

  it("POST /api/servers refuses a host folder as a new server's data folder", async () => {
    const before = (await db.getServers()).length;
    const r = await call("POST", "/api/servers", body({ zomboidDataPath: hostDir }));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(NOT_A_DATA_FOLDER);
    expect((await db.getServers()).length).toBe(before);
  });

  it("POST /api/servers still saves a folder that doesn't exist yet, as the path it resolves to", async () => {
    const fresh = path.join(root, "first-start-creates-me");
    const r = await call("POST", "/api/servers", body({ zomboidDataPath: fresh }));
    expect(r.status).toBe(201);
    created.push(r.json.server.id);
    expect((await db.getServer(r.json.server.id)).zomboidDataPath).toBe(path.resolve(fresh));
  });

  it("POST /api/servers leaves a remote server's folder alone (it is on another host)", async () => {
    const r = await call("POST", "/api/servers", body({ isRemote: true, zomboidDataPath: hostDir }));
    expect(r.status).toBe(201);
    created.push(r.json.server.id);
  });

  it("PUT /api/servers/:id refuses a folder whose path merely says zomboid", async () => {
    const r = await call("PUT", `/api/servers/${serverId}`, { zomboidDataPath: namedDir });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(NOT_A_DATA_FOLDER);
    expect((await db.getServer(serverId)).zomboidDataPath).toBe(realData);
  });

  it("PUT /api/servers/:id judges the stored folder when a remote profile turns local", async () => {
    await setStoredDataPath(hostDir, { isRemote: true });
    const r = await call("PUT", `/api/servers/${serverId}`, { isRemote: false });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(NOT_A_DATA_FOLDER);
    expect((await db.getServer(serverId)).isRemote).toBe(true);
  });

  it("PUT /config/app-settings refuses the legacy copy of the data folder too", async () => {
    currentRole = "admin";
    const before = await db.getSetting("zomboidDataPath");
    const r = await call("PUT", "/api/config/app-settings", { settings: { zomboidDataPath: hostDir } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(NOT_A_DATA_FOLDER);
    expect(await db.getSetting("zomboidDataPath")).toBe(before);
  });

  it("chunks /save-path refuses a folder whose path merely says zomboid", async () => {
    currentRole = "admin";
    const r = await call("POST", "/api/chunks/save-path", { path: namedDir });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(NOT_A_DATA_FOLDER);
    expect((await db.getServer(serverId)).zomboidDataPath).toBe(realData);
  });
});

describe("every feature that lists or reads under a stored data folder", () => {
  it("chunks /browse refuses a folder saved before the rule, and still browses a real one", async () => {
    await setStoredDataPath(hostDir);
    const refused = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(hostDir)}`);
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe(NOT_A_DATA_FOLDER);
    expect(JSON.stringify(refused.json)).not.toContain("secret-project");

    await setStoredDataPath(realData);
    const ok = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(realData)}`);
    expect(ok.status).toBe(200);
    expect(ok.json.directories).toContain("Saves");
  });

  it("chunks /browse refuses a folder that didn't exist when it was saved and appeared later", async () => {
    const later = path.join(root, "appears-later");
    const saved = await call("PUT", `/api/servers/${serverId}`, {
      zomboidDataPath: later,
      serverConfigPath: "",
    });
    expect(saved.status).toBe(200);
    fs.mkdirSync(path.join(later, "not-from-the-game"), { recursive: true });
    const r = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(later)}`);
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(NOT_A_DATA_FOLDER);
  });

  it("Server Files refuses every route for a folder saved before the rule, files.manage included", async () => {
    await setStoredDataPath(hostDir);
    for (const role of ["technician", "admin"]) {
      currentRole = role;
      const raw = await call("GET", "/api/server-files/raw/ini");
      expect(raw.status).toBe(400);
      expect(raw.json.code).toBe(NOT_A_DATA_FOLDER);
      const listed = await call("GET", `/api/server-files/browse-files?path=${encodeURIComponent(hostDir)}`);
      expect(listed.status).toBe(400);
      expect(listed.json.code).toBe(NOT_A_DATA_FOLDER);
    }
    expect(fs.existsSync(path.join(hostDir, "Server"))).toBe(false);
  });

  it("Server Files' image browser drops a legacy-setting data folder that isn't one", async () => {
    currentRole = "admin";
    await db.setSetting("zomboidDataPath", hostDir);
    try {
      const r = await call("GET", `/api/server-files/browse-files?path=${encodeURIComponent(hostDir)}`);
      expect(r.status).toBe(403);
      expect(r.json.code).toBe(ErrorCode.BROWSE_ACCESS_DENIED);
    } finally {
      await db.setSetting("zomboidDataPath", realData);
    }
  });

  it("backups don't read, list or write under a folder saved before the rule", async () => {
    await setStoredDataPath(hostDir);
    const service = new BackupService();
    expect(await service.getBackupsPath()).toBeNull();
    expect(await service.listBackups()).toEqual([]);
    const result = await service.createBackup({});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Zomboid data folder/);
    expect(fs.existsSync(path.join(hostDir, "backups"))).toBe(false);
  });
});
