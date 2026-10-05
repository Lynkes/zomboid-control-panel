import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// PATHS-1/PATHS-2, verifier pass 2 (security sweep 2026-10-05). The
// data-folder rule (services/zomboidDataPath.js) judges a server's data
// folder when it is saved, but leaves a remote server's alone (its path is
// on another host). Holding the config folder to <data folder>/Server
// protected nothing while that data folder went unjudged, so a technician
// saved a remote server whose data folder was any folder here, and the
// mods routes, /configure-rcon, /configure-network, the UPnP edit, the
// template preview and the Discord presence read and rewrote <that
// folder>/Server/<name>.ini on this computer. Activating that server also
// copied its folder into the legacy settings, which the console-log routes,
// mods and /configure-rcon fall back to for a local server with no data
// folder of its own; the install folder, the console log's other fallback,
// is any folder servers.manage names. /wipe still deleted under a remote
// server's data folder here. And the round before had stopped Map Cleanup's
// documented Saves/Multiplayer shape from being saved.
//
// Full stack through the real routers and the real, unmocked database layer
// (the suite's per-file temp data dir keeps it isolated), with the
// signed-in role injected as req.user.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverRouter, ensureRconConfigured } = await import("../routes/server.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { default: chunksRouter } = await import("../routes/chunks.js");
const { previewTemplate } = await import("../services/templateService.js");
const { resolveBridgeIniPath } = await import("../services/bridgeDelivery.js");
const { captureBackupSnapshot } = await import("../utils/backupSnapshot.js");
const { DiscordBot } = await import("../services/discordBot.js");
const { LogTailer } = await import("../services/logTailer.js");
const { checkZomboidDataPath, zomboidDataFolderHolds } = await import("../services/zomboidDataPath.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const NOT_A_DATA_FOLDER = ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER;
const OTHER_INI =
  "PublicName=OtherApp\nMaxPlayers=64\nMods=\nMap=SecretMapValue\nUPnP=true\nRCONPassword=hunter2\nRCONPort=27015\n";
const HOST_LOG_LINE = "HOST LOG LINE from a file on this computer";

let baseUrl;
let httpServer;
let currentRole = "technician";
let root;
let installDir;
let realData;
let otherApp;
let sameHostData;
let remoteWorld;
let localId;
let remoteId;

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

const otherIni = () => path.join(otherApp, "Server", "Victim.ini");
const otherLog = () => path.join(otherApp, "server-console.txt");

function otherAppUntouched() {
  expect(fs.readFileSync(otherIni(), "utf8")).toBe(OTHER_INI);
  expect(fs.readFileSync(otherLog(), "utf8")).toContain(HOST_LOG_LINE);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-data-rule-use-"));
  installDir = path.join(root, "pz-install");
  realData = path.join(root, "Zomboid");
  // Another program's folder on this computer: never a data folder, but it
  // happens to have a Server/<name>.ini and a server-console.txt.
  otherApp = path.join(root, "OtherApp");
  // A "remote" profile that is really on this computer, with a real data
  // folder: the panel's own config readers keep working for it.
  sameHostData = path.join(root, "SameHost", "Zomboid");
  // A folder here shaped like a data folder, named as a remote server's.
  remoteWorld = path.join(root, "RemoteWorld");
  for (const dir of [
    installDir,
    path.join(realData, "Saves", "Multiplayer", "Victim"),
    path.join(realData, "Saves", "Multiplayer", "servertest", "map"),
    path.join(realData, "Saves", "Multiplayer", "76561198000000000_Victim_player"),
    path.join(realData, "Server"),
    path.join(otherApp, "Server"),
    path.join(otherApp, "secret-project"),
    path.join(sameHostData, "Saves"),
    path.join(sameHostData, "Server"),
    path.join(remoteWorld, "Saves", "Multiplayer", "Victim", "map"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(remoteWorld, "Saves", "Multiplayer", "Victim", "map", "0_0.bin"), "chunk");
  fs.writeFileSync(path.join(remoteWorld, "Saves", "Multiplayer", "Victim", "map_meta.bin"), "meta");
  fs.writeFileSync(path.join(realData, "Saves", "Multiplayer", "Victim", "map_sand.bin"), "");
  fs.writeFileSync(path.join(otherApp, "notes.txt"), "not a PZ file\n");
  fs.writeFileSync(path.join(sameHostData, "Server", "Victim.ini"), "Mods=SameHostMod\nMaxPlayers=8\n");

  await db.initDatabase();
  const local = await db.createServer({
    name: "Local",
    serverName: "Victim",
    installPath: installDir,
    zomboidDataPath: realData,
    rconHost: "127.0.0.1",
    rconPort: 27991,
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
  app.use("/api/servers", serversRouter);
  app.use("/api/server", serverRouter);
  app.use("/api/mods", modsRouter);
  app.use("/api/chunks", chunksRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  // The way in: servers.manage saves a remote server whose data folder (and
  // a config folder inside it) is the other program's folder. Remote records
  // skip the save-time rule, so this is stored as sent.
  const created = await call("POST", "/api/servers", {
    name: "Remote",
    serverName: "Victim",
    isRemote: true,
    zomboidDataPath: otherApp,
    serverConfigPath: path.join(otherApp, "Server"),
    rconHost: "10.0.0.2",
    rconPort: 27992,
    rconPassword: "x",
  });
  expect(created.status).toBe(201);
  remoteId = created.json.server.id;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  currentRole = "technician";
  fs.writeFileSync(otherIni(), OTHER_INI);
  fs.writeFileSync(otherLog(), `${HOST_LOG_LINE}\nERROR boom\n`);
  await db.updateServer(localId, { zomboidDataPath: realData, serverConfigPath: null, installPath: installDir });
  await db.updateServer(remoteId, {
    isRemote: true,
    zomboidDataPath: otherApp,
    serverConfigPath: path.join(otherApp, "Server"),
    installPath: "",
  });
  await db.setActiveServer(remoteId);
});

describe("a remote server whose data folder is a folder here that isn't one", () => {
  it("the mods routes neither read nor rewrite <that folder>/Server/<name>.ini", async () => {
    const current = await call("GET", "/api/mods/current-config");
    expect(current.status).toBe(200);
    expect(current.json.configured).toBe(false);
    expect(current.text).not.toContain("SecretMapValue");

    const toggled = await call("POST", "/api/mods/toggle-mod-id", {
      modId: "[injected] by technician",
      enabled: true,
    });
    expect(toggled.status).toBe(400);
    otherAppUntouched();
  });

  it("/configure-rcon and /configure-network refuse it, naming the data folder", async () => {
    const rcon = await call("POST", "/api/server/configure-rcon", {
      rconPassword: "technician-chosen",
      rconPort: 27015,
    });
    expect(rcon.status).toBe(400);
    expect(rcon.json.code).toBe(NOT_A_DATA_FOLDER);

    const network = await call("POST", "/api/server/configure-network", {
      serverPort: 16261,
      useUpnp: false,
    });
    expect(network.status).toBe(400);
    expect(network.json.code).toBe(NOT_A_DATA_FOLDER);
    otherAppUntouched();
  });

  it("the UPnP edit doesn't rewrite it, and says why", async () => {
    const r = await call("PUT", `/api/servers/${remoteId}`, { useUpnp: false });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).toMatch(/data folder holds files the game doesn't keep/);
    otherAppUntouched();
  });

  it("the template preview, the Discord presence, ensureRconConfigured, PanelBridge delivery and backup snapshots don't use it", async () => {
    const preview = await previewTemplate("first-week-friendly", remoteId);
    expect(preview.success).toBe(false);
    expect(preview.code).toBe(NOT_A_DATA_FOLDER);

    expect(await new DiscordBot(null, null, null).getConfiguredMaxPlayers()).toBeNull();

    const record = await db.getServer(remoteId);
    expect(await ensureRconConfigured({ ...record, rconPassword: "changed" })).toBe(false);
    expect(resolveBridgeIniPath(record)).toBeNull();
    expect(captureBackupSnapshot(record).serverIni).toEqual({});
    otherAppUntouched();
  });

  it("a same-host remote profile whose data folder is a real one still reads its config", async () => {
    await db.updateServer(remoteId, {
      zomboidDataPath: sameHostData,
      serverConfigPath: path.join(sameHostData, "Server"),
    });
    const current = await call("GET", "/api/mods/current-config");
    expect(current.status).toBe(200);
    expect(current.json.configured).toBe(true);
    expect(current.json.modIds).toEqual(["SameHostMod"]);
    expect(await new DiscordBot(null, null, null).getConfiguredMaxPlayers()).toBe(8);
  });
});

describe("wiping a remote server", () => {
  it("is refused, and nothing under its data folder here is deleted", async () => {
    currentRole = "admin";
    await db.updateServer(remoteId, { zomboidDataPath: remoteWorld, serverConfigPath: null });
    const save = path.join(remoteWorld, "Saves", "Multiplayer", "Victim");

    const preview = await call("POST", "/api/server/wipe/preview", { targets: ["map"] });
    expect(preview.status).toBe(400);
    expect(preview.json.code).toBe(ErrorCode.WIPE_REMOTE_NOT_AVAILABLE);

    const wiped = await call("POST", "/api/server/wipe", {
      targets: ["map", "world"],
      confirm: true,
      createBackup: false,
    });
    expect(wiped.status).toBe(400);
    expect(wiped.json.code).toBe(ErrorCode.WIPE_REMOTE_NOT_AVAILABLE);
    expect(fs.readFileSync(path.join(save, "map", "0_0.bin"), "utf8")).toBe("chunk");
    expect(fs.readFileSync(path.join(save, "map_meta.bin"), "utf8")).toBe("meta");
  });
});

describe("the legacy settings copy of the data folder", () => {
  it("activating a remote server copies none of its folders; a local one's are copied as before", async () => {
    await db.setSetting("zomboidDataPath", realData);
    const activated = await call("POST", `/api/servers/${remoteId}/activate`);
    expect(activated.status).toBe(200);
    expect(await db.getSetting("zomboidDataPath")).toBeNull();
    expect(await db.getSetting("serverConfigPath")).toBeNull();

    await db.setActiveServer(localId);
    expect(await db.getSetting("zomboidDataPath")).toBe(realData);
  });

  // A copy made before the fix above (or set some other way): the record
  // turned local with no data folder of its own, so every feature falls
  // back to the legacy setting.
  async function useStaleLegacyCopy(folder) {
    await db.updateServer(remoteId, { isRemote: false, zomboidDataPath: "", serverConfigPath: null });
    await db.setSetting("zomboidDataPath", folder);
    await db.setSetting("serverConfigPath", null);
  }

  it("the console-log routes don't read or clear server-console.txt in a legacy folder that isn't one", async () => {
    await useStaleLegacyCopy(otherApp);
    const log = await call("GET", "/api/server/console-log?filter=all");
    expect(log.status).toBe(200);
    expect(log.json.exists).toBe(false);
    expect(log.text).not.toContain(HOST_LOG_LINE);

    const stream = await call("GET", "/api/server/console-log/stream?lastSize=0");
    expect(stream.status).toBe(200);
    expect(stream.text).not.toContain(HOST_LOG_LINE);

    const cleared = await call("POST", "/api/server/console-log/clear");
    expect(cleared.status).toBe(400);
    expect(cleared.json.code).toBe(NOT_A_DATA_FOLDER);
    otherAppUntouched();
  });

  it("mods, /configure-rcon and the log tailer don't use it either", async () => {
    await useStaleLegacyCopy(otherApp);
    const current = await call("GET", "/api/mods/current-config");
    expect(current.json.configured).toBe(false);
    expect(current.text).not.toContain("SecretMapValue");

    const rcon = await call("POST", "/api/server/configure-rcon", { rconPassword: "chosen", rconPort: 27015 });
    expect(rcon.status).toBe(400);
    expect(rcon.json.code).toBe(NOT_A_DATA_FOLDER);

    const tailer = new LogTailer();
    await tailer.findLogPath();
    expect(tailer.basePath).toBeNull();
    expect(tailer.logPath).toBeNull();
    otherAppUntouched();
  });

  it("the console log isn't read from an install folder that isn't a data folder", async () => {
    await db.updateServer(remoteId, { isRemote: false, zomboidDataPath: "", installPath: otherApp });
    await db.setSetting("zomboidDataPath", null);
    const log = await call("GET", "/api/server/console-log?filter=all");
    expect(log.json.exists).toBe(false);
    expect(log.text).not.toContain(HOST_LOG_LINE);
    const cleared = await call("POST", "/api/server/console-log/clear");
    expect(cleared.status).toBe(400);
    otherAppUntouched();
  });

  it("a legacy folder that is a real data folder still works", async () => {
    await useStaleLegacyCopy(realData);
    fs.writeFileSync(path.join(realData, "server-console.txt"), "SERVER STARTED\nlegacy line\n");
    fs.writeFileSync(path.join(realData, "Server", "Victim.ini"), "Mods=LegacyMod\n");
    const log = await call("GET", "/api/server/console-log?filter=all");
    expect(log.json.exists).toBe(true);
    expect(log.json.lines).toContain("legacy line");
    const current = await call("GET", "/api/mods/current-config");
    expect(current.json.configured).toBe(true);
    expect(current.json.modIds).toEqual(["LegacyMod"]);
  });
});

describe("Map Cleanup's Saves/Multiplayer shape", () => {
  const multiplayer = () => path.join(realData, "Saves", "Multiplayer");

  it("the rule accepts a Saves/Multiplayer folder that holds world saves", () => {
    expect(checkZomboidDataPath(multiplayer()).ok).toBe(true);
    expect(zomboidDataFolderHolds(multiplayer())).toBe(true);
  });

  it("'Save as default' saves it, and /browse lists it", async () => {
    currentRole = "admin";
    await db.setActiveServer(localId);
    const saved = await call("POST", "/api/chunks/save-path", { path: multiplayer() });
    expect(saved.status).toBe(200);
    expect((await db.getServer(localId)).zomboidDataPath).toBe(multiplayer());
    const browsed = await call("GET", `/api/chunks/browse?path=${encodeURIComponent(multiplayer())}`);
    expect(browsed.status).toBe(200);
    expect(browsed.json.directories).toEqual(
      expect.arrayContaining(["Victim", "servertest", "76561198000000000_Victim_player"]),
    );
  });

  it("still refuses one that holds anything else, and a folder of projects that merely have map folders", () => {
    const mixed = path.join(root, "Mixed", "Saves", "Multiplayer");
    fs.mkdirSync(path.join(mixed, "MyServer", "map"), { recursive: true });
    fs.writeFileSync(path.join(mixed, "unrelated.txt"), "x");
    expect(checkZomboidDataPath(mixed).ok).toBe(false);
    expect(zomboidDataFolderHolds(mixed)).toBe(false);

    const projects = path.join(root, "projects");
    fs.mkdirSync(path.join(projects, "game-one", "map"), { recursive: true });
    fs.mkdirSync(path.join(projects, "game-two", "map"), { recursive: true });
    expect(checkZomboidDataPath(projects).ok).toBe(false);
    expect(checkZomboidDataPath(projects).body.code).toBe(NOT_A_DATA_FOLDER);
  });
});
