import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// W5 (security sweep 2026-10-05). In 1.4.5 Map Cleanup's "Save as default"
// stored a server's data folder as it was typed -- any folder that existed,
// path.resolve(normalizeUserPath(raw)) -- and its hint named three shapes:
// "your Zomboid data folder, a Saves/Multiplayer folder, or a single save
// directory"; resolveSavesPath() took a Saves folder too. The record kept
// its config folder, <Zomboid>/Server.
//   P1: Windows and macOS ignore letter case, so a stored
//       ...\saves\multiplayer is the game's own folder; the rule compared
//       the names as spelled and refused it, and every feature for that
//       server with it.
//   P2: for a Saves folder and a single world save, the data folder met
//       the rule, but the config folder <Zomboid>/Server didn't
//       (SERVER_CONFIG_PATH_OUTSIDE_DATA): Server Files, Mods, the RCON
//       settings and templates stopped.
// Every feature is checked against the folders 1.4.5 used for such a
// record: the record's config folder for Server Files, Mods, the RCON
// settings and templates; <data folder>/backups for backups; wipe's
// <data folder>/Saves/Multiplayer/<name>; Map Cleanup's saves folder (which
// 1.4.5 found only for a path spelled as the game spells it); the console
// log in the data folder (else, as for Saves/Multiplayer since PT2, the
// Zomboid folder's).
//
// Real routers over the real, unmocked database layer (the suite's per-file
// temp data dir keeps it isolated), signed in as admin.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverRouter, ensureRconConfigured } = await import("../routes/server.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { default: chunksRouter } = await import("../routes/chunks.js");
const { applyTemplate } = await import("../services/templateService.js");
const { BackupService } = await import("../services/backupService.js");
const { LogTailer } = await import("../services/logTailer.js");
const { checkZomboidDataPath, zomboidDataFolderHolds } = await import("../services/zomboidDataPath.js");
const { serverConfigDirOf, serverConfigPathIsConfined } = await import("../utils/serverConfigPath.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const INI = "Mods=RealMod\nWorkshopItems=\nMaxPlayers=12\nPauseEmpty=false\nRCONPort=27015\nRCONPassword=old\n";
const SANDBOX = "SandboxVars = {\n    VERSION = 6,\n    Zombies = 4,\n}\n";
const ZOMBOID_LOG_LINE = "the line the server wrote in the Zomboid folder";

function write(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-map-cleanup-shapes-"));
// Whether this file system ignores letter case (Windows, macOS): only there
// is a path spelled in another case the game's own folder.
const ignoresCase = (() => {
  fs.mkdirSync(path.join(root, "CaseProbe"));
  return fs.existsSync(path.join(root, "caseprobe"));
})();

// A Zomboid folder as the game leaves one, with the server's own ini,
// sandbox settings and console log.
function buildZomboid(name) {
  const zomboid = path.join(root, name, "Zomboid");
  const multiplayer = path.join(zomboid, "Saves", "Multiplayer");
  write(path.join(multiplayer, "Victim", "map_t.bin"), "t");
  write(path.join(multiplayer, "Victim", "map", "0", "0.bin"), "chunk");
  write(path.join(zomboid, "Server", "Victim.ini"), INI);
  write(path.join(zomboid, "Server", "Victim_SandboxVars.lua"), SANDBOX);
  write(path.join(zomboid, "server-console.txt"), `SERVER STARTED\n${ZOMBOID_LOG_LINE}\n`);
  return { zomboid, config: path.join(zomboid, "Server") };
}

let baseUrl;
let httpServer;
let installDir;
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
  return { status: res.status, json, text };
}

beforeAll(async () => {
  installDir = path.join(root, "pz-install");
  write(path.join(installDir, "ProjectZomboid64.exe"));

  await db.initDatabase();
  const server = await db.createServer({
    name: "Victim",
    serverName: "Victim",
    installPath: installDir,
    zomboidDataPath: buildZomboid("seed").zomboid,
    rconHost: "127.0.0.1",
    rconPort: 27015,
    rconPassword: "x",
  });
  serverId = server.id;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: "u-admin", username: "admin", role: "admin" };
    next();
  });
  app.set("serverManager", {
    reloadConfig: async () => {},
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  });
  app.use("/api/servers", serversRouter);
  app.use("/api/server", serverRouter);
  app.use("/api/server-files", serverFilesRouter);
  app.use("/api/mods", modsRouter);
  app.use("/api/chunks", chunksRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

async function useRecord(record) {
  await db.updateServer(serverId, { isRemote: false, installPath: installDir, ...record });
  // Copies the record's folders to the legacy settings, as 1.4.5 did.
  await db.setActiveServer(serverId);
}

const SHAPES = [
  ["a Saves/Multiplayer folder", ["Saves", "Multiplayer"]],
  ["a Saves folder", ["Saves"]],
  ["a single world save", ["Saves", "Multiplayer", "Victim"]],
];
const SPELLINGS = [
  ["as the game spells it", (segment) => segment],
  ["in lower case", (segment) => segment.toLowerCase()],
];
const CASES = SHAPES.flatMap(([shape, segments]) =>
  SPELLINGS.map(([spelling, spell]) => ({ shape, spelling, segments, spell, lower: spelling !== SPELLINGS[0][0] })),
);

let caseNumber = 0;

describe.each(CASES)("a 1.4.5 record: data folder $shape, spelled $spelling; config folder <Zomboid>/Server", ({
  segments,
  spell,
  lower,
}) => {
  let zomboid;
  let config;
  let dataPath;

  beforeAll(() => {
    ({ zomboid, config } = buildZomboid(`case-${++caseNumber}`));
    dataPath = path.join(zomboid, ...segments.map(spell));
    // 1.4.5's Backups page made <data folder>/backups.
    write(path.join(dataPath, "backups", "Victim_2026-10-01T10-00-00-000.zip"), "zip");
  });

  beforeEach(async () => {
    write(path.join(config, "Victim.ini"), INI);
    write(path.join(config, "Victim_SandboxVars.lua"), SANDBOX);
    await useRecord({ zomboidDataPath: dataPath, serverConfigPath: config });
  });

  // A path in another letter case leads to the game's folder only where
  // the file system ignores case.
  describe.skipIf(lower && !ignoresCase)("where it is the game's own folder", () => {
    it("meets the data-folder rule, and its config folder is the record's", async () => {
      expect(zomboidDataFolderHolds(dataPath)).toBe(true);
      expect(checkZomboidDataPath(dataPath).ok).toBe(true);
      expect(serverConfigPathIsConfined(config, dataPath)).toBe(true);
      expect(serverConfigDirOf(await db.getServer(serverId))).toMatchObject({ dir: config, refused: false });
      const listed = await call("GET", "/api/servers");
      expect(listed.json.servers.find((s) => s.id === serverId).folderProblem ?? null).toBeNull();
    });

    it("Server Files and Mods read the server's own ini", async () => {
      const ini = await call("GET", "/api/server-files/raw/ini");
      expect(ini.status).toBe(200);
      expect(ini.text).toContain("Mods=RealMod");

      const mods = await call("GET", "/api/mods/current-config");
      expect(mods.json.code).toBeUndefined();
      expect(mods.json.modIds).toEqual(["RealMod"]);
    });

    it("a start writes the RCON settings into it, and a template applies to it", async () => {
      const record = await db.getServer(serverId);
      expect(await ensureRconConfigured({ ...record, rconPassword: "changed-at-start" })).toBe(true);
      expect(fs.readFileSync(path.join(config, "Victim.ini"), "utf8")).toContain("RCONPassword=changed-at-start");

      const applied = await applyTemplate("first-week-friendly", serverId, { backup: false });
      expect(applied.code).toBeUndefined();
      expect(applied.success).toBe(true);
      expect(fs.readFileSync(path.join(config, "Victim.ini"), "utf8")).toContain("PauseEmpty=true");
      expect(fs.readFileSync(path.join(config, "Victim_SandboxVars.lua"), "utf8")).toMatch(/Zombies = 5/);
    });

    it("backups use <data folder>/backups and list 1.4.5's backup, as in 1.4.5", async () => {
      const service = new BackupService();
      expect(await service.getBackupsPath()).toBe(path.join(dataPath, "backups"));
      // 1.4.5: <data folder>/Saves/Multiplayer/<name> isn't there, so the
      // legacy settings' copy of the same folder.
      expect(await service.getSavesPath()).toBe(path.join(dataPath, "Saves", "Multiplayer", "Victim"));
      const backups = await service.listBackups();
      expect(backups.map((b) => b.name)).toContain("Victim_2026-10-01T10-00-00-000.zip");
    });

    it("wipe looks for <data folder>/Saves/Multiplayer/<name>, as in 1.4.5, and answers that it isn't there", async () => {
      const preview = await call("POST", "/api/server/wipe/preview", { targets: ["map"] });
      expect(preview.status).toBe(404);
      expect(preview.json.code).toBe(ErrorCode.WIPE_SAVE_DIRECTORY_NOT_FOUND);
    });

    it("Map Cleanup lists the world, and /browse lists the data folder", async () => {
      const saves = await call("GET", "/api/chunks/saves");
      expect(saves.status).toBe(200);
      expect(saves.json.saves.map((s) => s.name)).toContain("Victim");

      const browsed = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(dataPath)}`);
      expect(browsed.status).toBe(200);
      expect(browsed.json.code).toBeUndefined();
    });

    it("the console log: the data folder's own first, as in 1.4.5; else the Zomboid folder's", async () => {
      const fromZomboid = await call("GET", "/api/server/console-log?filter=all");
      expect(fromZomboid.json.refusal).toBeUndefined();
      expect(fromZomboid.json.exists).toBe(true);
      expect(fromZomboid.json.lines).toContain(ZOMBOID_LOG_LINE);
      const tailer = new LogTailer();
      await tailer.findLogPath();
      expect(tailer.logPath).toBe(path.join(zomboid, "server-console.txt"));

      const own = path.join(dataPath, "server-console.txt");
      write(own, "SERVER STARTED\nthe cachedir's own line\n");
      try {
        const fromDataFolder = await call("GET", "/api/server/console-log?filter=all");
        expect(fromDataFolder.json.lines).toContain("the cachedir's own line");
      } finally {
        fs.rmSync(own);
      }
    });
  });

  // On a case-sensitive file system the path leads to no folder: the game's
  // folder is spelled otherwise, and matching stays exact.
  describe.skipIf(!lower || ignoresCase)("where the file system tells letter case apart", () => {
    it("doesn't lead to the game's folder", () => {
      expect(fs.existsSync(dataPath)).toBe(true); // its backups/, made above
      expect(serverConfigPathIsConfined(config, dataPath)).toBe(false);
    });
  });
});

describe("the shapes count only as the game makes them", () => {
  it("not folders named saves/multiplayer on disk: names aren't compared ignoring case", () => {
    // The game names them Saves/Multiplayer; these are someone else's.
    const home = path.join(root, "lowercase-on-disk");
    const multiplayer = path.join(home, "saves", "multiplayer");
    write(path.join(multiplayer, "Victim", "map_t.bin"), "t");
    write(path.join(home, "Server", "Victim.ini"), INI);
    expect(zomboidDataFolderHolds(multiplayer)).toBe(false);
    expect(serverConfigPathIsConfined(path.join(home, "Server"), multiplayer)).toBe(false);
  });

  it("not a Saves folder whose Multiplayer folder holds no world save", () => {
    // The Zomboid folder meets the rule on its own (a world in
    // Saves/Sandbox), but the data folder isn't the Saves folder of a
    // multiplayer world.
    const { zomboid, config } = buildZomboid("no-multiplayer-world");
    const multiplayer = path.join(zomboid, "Saves", "Multiplayer");
    fs.rmSync(multiplayer, { recursive: true });
    write(path.join(zomboid, "Saves", "Sandbox", "Solo", "map_t.bin"), "t");
    fs.mkdirSync(path.join(multiplayer, "Victim", "map"), { recursive: true });
    expect(zomboidDataFolderHolds(zomboid)).toBe(true);
    expect(serverConfigPathIsConfined(config, path.join(zomboid, "Saves"))).toBe(false);
  });

  it("not a world folder without save files, nor one named like the game's own entries", () => {
    const { zomboid, config } = buildZomboid("not-a-world");
    const multiplayer = path.join(zomboid, "Saves", "Multiplayer");
    write(path.join(multiplayer, "Notes", "todo.txt"), "x");
    expect(serverConfigPathIsConfined(config, path.join(multiplayer, "Notes"))).toBe(false);
    // A server-side mod writes files by any name in Lua/.
    write(path.join(multiplayer, "Lua", "map_t.bin"), "t");
    expect(serverConfigPathIsConfined(config, path.join(multiplayer, "Lua"))).toBe(false);
    expect(serverConfigPathIsConfined(config, path.join(multiplayer, "Victim"))).toBe(true);
  });

  it("a world save in the game's folders is the shape, not one in another folder of that name", () => {
    // Map Cleanup's own backups/ (in a Saves/Multiplayer data folder) is
    // no world save, so its folders aren't one either.
    const { zomboid, config } = buildZomboid("world-inside-backups");
    const nested = path.join(zomboid, "Saves", "Multiplayer", "backups", "Victim_chunks_1");
    write(path.join(nested, "map_t.bin"), "t");
    expect(zomboidDataFolderHolds(nested)).toBe(true); // save files directly in it
    expect(serverConfigPathIsConfined(config, nested)).toBe(false);
  });

  // The check that a path in another letter case leads to the folder the
  // game named: the real path on Windows, the device and inode elsewhere
  // (macOS). Windows runs both, the second with the platform read as macOS.
  it.skipIf(process.platform !== "win32")("on Windows, and by device and inode as on macOS", () => {
    const { zomboid, config } = buildZomboid("inode-check");
    const lowerData = path.join(zomboid, "saves", "multiplayer");
    expect(serverConfigPathIsConfined(config, lowerData)).toBe(true);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(zomboidDataFolderHolds(lowerData)).toBe(true);
      expect(serverConfigPathIsConfined(config, lowerData)).toBe(true);
      expect(serverConfigPathIsConfined(config, path.join(zomboid, "SAVES", "Multiplayer", "victim"))).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
