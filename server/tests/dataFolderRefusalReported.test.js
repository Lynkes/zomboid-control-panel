import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// PT3 (security sweep 2026-10-05, final round): after the update, a server
// whose data folder no longer meets the data-folder rule, or whose record
// has a config folder but no data folder, lost features with no word why.
// Server Files, chunks and backups answered the refusal; the Mods page said
// "Server config path not set. Please configure the server first.", the
// Console page showed no log, the Discord presence dropped MaxPlayers and a
// start skipped the RCON settings with one log line. Each now reports the
// refusal itself (ZOMBOID_DATA_PATH_NOT_DATA_FOLDER or
// SERVER_CONFIG_PATH_OUTSIDE_DATA, saying what to set), and the server list
// carries it for the Servers page.
//
// PT4: the console-log routes judged a record with no data folder on its
// install folder, and /clear answered ZOMBOID_DATA_PATH_NOT_DATA_FOLDER
// about a data folder that wasn't set.
//
// PT5: the refusal was logged at warn on every call, and GET
// /api/backup/status (polled every 15 s) made up to three calls.
//
// Real routers over the real, unmocked database layer; only the logger is
// replaced, to read what each feature logs.
const loggers = vi.hoisted(() => new Map());
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createLogger: (source) => {
      if (!loggers.has(source)) {
        const fns = {};
        for (const level of ["error", "warn", "info", "http", "verbose", "debug", "silly", "log"]) fns[level] = vi.fn();
        loggers.set(source, fns);
      }
      return loggers.get(source);
    },
  };
});

const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverRouter, ensureRconConfigured } = await import("../routes/server.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { BackupService } = await import("../services/backupService.js");
const { DiscordBot } = await import("../services/discordBot.js");
const { logRefusalOnce } = await import("../services/zomboidDataPath.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const NOT_A_DATA_FOLDER = ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER;
const OUTSIDE_DATA = ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA;

let baseUrl;
let httpServer;
let currentRole = "admin";
let root;
let installDir;
let realData;
let refusedData;
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

function write(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// The lines a logger wrote at `level` that carry `code` (and `about`).
function linesWith(source, level, code, about = "") {
  return (loggers.get(source)?.[level].mock.calls ?? []).filter(
    ([line]) => String(line).includes(code) && String(line).includes(about),
  );
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refusal-reported-"));
  installDir = path.join(root, "pz-install");
  write(path.join(installDir, "ProjectZomboid64.exe"));
  write(path.join(installDir, "server-console.txt"), "SERVER STARTED\ninstall-folder line\n");
  realData = path.join(root, "Zomboid");
  write(path.join(realData, "Saves", "Multiplayer", "Victim", "map_t.bin"));
  write(path.join(realData, "Server", "Victim.ini"), "Mods=RealMod\nWorkshopItems=\nMaxPlayers=12\n");
  write(path.join(realData, "server-console.txt"), "SERVER STARTED\nreal data line\n");
  // A data folder saved before the rule: someone's folder, with a Server
  // folder and a console log of the right names in it.
  refusedData = path.join(root, "refused-data");
  write(path.join(refusedData, "Server", "Victim.ini"), "Mods=Hijacked\nMaxPlayers=99\n");
  write(path.join(refusedData, "server-console.txt"), "SERVER STARTED\nrefused folder line\n");
  write(path.join(refusedData, "notes.txt"), "private");

  await db.initDatabase();
  const server = await db.createServer({
    name: "Victim",
    serverName: "Victim",
    installPath: installDir,
    zomboidDataPath: realData,
    rconHost: "127.0.0.1",
    rconPort: 27951,
    rconPassword: "secret-rcon",
  });
  serverId = server.id;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", { reloadConfig: async () => {} });
  app.use("/api/servers", serversRouter);
  app.use("/api/server", serverRouter);
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

async function useRecord(fields) {
  await db.updateServer(serverId, {
    zomboidDataPath: realData,
    serverConfigPath: null,
    installPath: installDir,
    isRemote: false,
    ...fields,
  });
  await db.setActiveServer(serverId);
}

beforeEach(async () => {
  currentRole = "admin";
  await useRecord({});
});

describe("PT3: the features that went quiet say why", () => {
  it("the Mods page gets the data folder's refusal, not 'Server config path not set'", async () => {
    await useRecord({ zomboidDataPath: refusedData });
    const current = await call("GET", "/api/mods/current-config");
    expect(current.json.configured).toBe(false);
    expect(current.json.code).toBe(NOT_A_DATA_FOLDER);
    expect(current.json.error).toMatch(/Servers page/);
    expect(current.text).not.toContain("Hijacked");

    const added = await call("POST", "/api/mods/add-to-ini", { modIds: ["Some"], workshopId: "123" });
    expect(added.status).toBe(400);
    expect(added.json.code).toBe(NOT_A_DATA_FOLDER);
    const sync = await call("POST", "/api/mods/sync-from-server");
    expect(sync.json.success).toBe(false);
    expect(sync.json.code).toBe(NOT_A_DATA_FOLDER);
  });

  it("a config folder with no data folder answers SERVER_CONFIG_PATH_OUTSIDE_DATA", async () => {
    await db.setSetting("zomboidDataPath", null);
    await db.setSetting("serverConfigPath", null);
    await useRecord({ zomboidDataPath: null, serverConfigPath: path.join(realData, "Server") });
    await db.setSetting("zomboidDataPath", null);
    const current = await call("GET", "/api/mods/current-config");
    expect(current.json.configured).toBe(false);
    expect(current.json.code).toBe(OUTSIDE_DATA);
  });

  it("a usable folder still reads, with no refusal anywhere", async () => {
    const current = await call("GET", "/api/mods/current-config");
    expect(current.json.configured).toBe(true);
    expect(current.json.modIds).toEqual(["RealMod"]);
    const servers = await call("GET", "/api/servers");
    expect(servers.json.servers.find((s) => s.id === serverId).folderProblem).toBeNull();
  });

  it("the Console page's log routes say why there is no log", async () => {
    await useRecord({ zomboidDataPath: refusedData });
    const log = await call("GET", "/api/server/console-log?filter=all");
    expect(log.json.exists).toBe(false);
    expect(log.json.refusal.code).toBe(NOT_A_DATA_FOLDER);
    expect(log.text).not.toContain("refused folder line");
    const stream = await call("GET", "/api/server/console-log/stream?lastSize=0");
    expect(stream.json.exists).toBe(false);
    expect(stream.json.refusal.code).toBe(NOT_A_DATA_FOLDER);
    const cleared = await call("POST", "/api/server/console-log/clear");
    expect(cleared.status).toBe(400);
    expect(cleared.json.code).toBe(NOT_A_DATA_FOLDER);
  });

  it("the server list carries the refusal for the Servers page", async () => {
    await useRecord({ zomboidDataPath: refusedData });
    const servers = await call("GET", "/api/servers");
    const listed = servers.json.servers.find((s) => s.id === serverId);
    expect(listed.folderProblem.code).toBe(NOT_A_DATA_FOLDER);

    await useRecord({ zomboidDataPath: null, serverConfigPath: path.join(realData, "Server") });
    const again = await call("GET", "/api/servers");
    expect(again.json.servers.find((s) => s.id === serverId).folderProblem.code).toBe(OUTSIDE_DATA);
  });

  it("a start that skips the RCON settings says why in the log, with the code, once", async () => {
    await useRecord({ zomboidDataPath: refusedData });
    const record = await db.getServer(serverId);
    expect(await ensureRconConfigured(record)).toBe(false);
    expect(await ensureRconConfigured(record)).toBe(false);
    expect(linesWith("API:Server", "warn", NOT_A_DATA_FOLDER, "RCON settings")).toHaveLength(1);
    expect(linesWith("API:Server", "debug", NOT_A_DATA_FOLDER, "RCON settings")).toHaveLength(1);
    expect(fs.readFileSync(path.join(refusedData, "Server", "Victim.ini"), "utf8")).not.toContain("RCON");
  });

  it("the Discord presence says why MaxPlayers is missing, in the log, once", async () => {
    await useRecord({ zomboidDataPath: refusedData });
    const bot = new DiscordBot();
    expect(await bot.getConfiguredMaxPlayers()).toBeNull();
    expect(await bot.getConfiguredMaxPlayers()).toBeNull();
    expect(linesWith("Discord", "warn", NOT_A_DATA_FOLDER)).toHaveLength(1);

    await useRecord({});
    expect(await bot.getConfiguredMaxPlayers()).toBe(12);
  });
});

describe("PT4: the console log of a record with no data folder", () => {
  it("is 'no data folder set', not a refusal of its install folder", async () => {
    await useRecord({ zomboidDataPath: null });
    await db.setSetting("zomboidDataPath", null);
    const cleared = await call("POST", "/api/server/console-log/clear");
    expect(cleared.status).toBe(400);
    expect(cleared.json.code).toBe(ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED);
    const log = await call("GET", "/api/server/console-log?filter=all");
    expect(log.json.exists).toBe(false);
    expect(log.json.refusal.code).toBe(ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED);
    expect(log.text).not.toContain("install-folder line");
  });

  it("uses the legacy data folder before the install folder", async () => {
    await useRecord({ zomboidDataPath: null });
    await db.setSetting("zomboidDataPath", realData);
    try {
      const log = await call("GET", "/api/server/console-log?filter=all");
      expect(log.json.exists).toBe(true);
      expect(log.json.lines).toContain("real data line");
    } finally {
      await db.setSetting("zomboidDataPath", null);
    }
  });
});

describe("PT5: a refused folder is logged at warn once, then at debug", () => {
  it("GET /api/backup/status's three lookups and every poll after warn once", async () => {
    await useRecord({ zomboidDataPath: refusedData });
    const service = new BackupService();
    await service.getStatus();
    await service.getStatus();
    expect(linesWith("Backup", "warn", NOT_A_DATA_FOLDER)).toHaveLength(1);
    expect(linesWith("Backup", "debug", NOT_A_DATA_FOLDER).length).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(path.join(refusedData, "backups"))).toBe(false);
  });

  it("the Mods routes warn once, however often the page loads", async () => {
    await useRecord({ zomboidDataPath: refusedData });
    await call("GET", "/api/mods/current-config");
    await call("GET", "/api/mods/current-config");
    await call("GET", "/api/mods/validate-config");
    // The first test in this file already loaded the page for this folder.
    expect(linesWith("API:Mods", "warn", NOT_A_DATA_FOLDER)).toHaveLength(1);
    expect(linesWith("API:Mods", "debug", NOT_A_DATA_FOLDER).length).toBeGreaterThanOrEqual(3);
  });

  it("each line warns once; another folder or reason warns again", () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    logRefusalOnce(logger, "feature: folder A [X]");
    logRefusalOnce(logger, "feature: folder A [X]");
    logRefusalOnce(logger, "feature: folder B [X]");
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });
});
