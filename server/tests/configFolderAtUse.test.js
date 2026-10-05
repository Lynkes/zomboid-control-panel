import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// PATHS-2 (security sweep 2026-10-05): a server's config folder is confined
// to <zomboidDataPath>/Server when it is saved, but Server Files' use-time
// check ran only when the record had BOTH folders: a record with a config
// folder and no data folder, and the legacy settings copy of the config
// folder (used when the record has neither), were read and written as they
// were. The services that read or write a server's .ini/.lua files
// (ensureRconConfigured, /configure-rcon, mods, templates, PanelBridge
// delivery, pre-restart backups, backup snapshots, the UPnP edit, the
// Discord presence, the support bundle) took a record's config folder as it
// was too. All of them now hold it to the data folder in effect
// (utils/serverConfigPath.js), so data saved before the save-time check
// can't reach an outside folder either.
//
// Real routers and services over the real, unmocked database layer (the
// suite's per-file temp data dir keeps it isolated).
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { default: serverRouter, ensureRconConfigured, getActiveServerPaths: serverPaths } = await import(
  "../routes/server.js"
);
const { getActiveServerPaths: modsPaths } = await import("../routes/mods.js");
const { applyTemplate } = await import("../services/templateService.js");
const { resolveBridgeIniPath } = await import("../services/bridgeDelivery.js");
const { captureBackupSnapshot } = await import("../utils/backupSnapshot.js");
const { Scheduler } = await import("../services/scheduler.js");
const { DiscordBot } = await import("../services/discordBot.js");
const { buildServerConfigSummary } = await import("../routes/debug.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const OUTSIDE = ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA;
const OUTSIDE_INI = "PublicName=Outside\nMaxPlayers=99\nUPnP=true\nRCONPassword=outside\nRCONPort=27015\n";
const OUTSIDE_LUA = "SandboxVars = {\n    Zombies = 4,\n}\n";

let baseUrl;
let httpServer;
let currentRole = "technician";
let root;
let installDir;
let dataDir;
let configDir;
let outsideDir;
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

function outsideUntouched() {
  expect(fs.readFileSync(path.join(outsideDir, "Victim.ini"), "utf8")).toBe(OUTSIDE_INI);
  expect(fs.readFileSync(path.join(outsideDir, "Victim_SandboxVars.lua"), "utf8")).toBe(OUTSIDE_LUA);
  expect(fs.readdirSync(outsideDir).sort()).toEqual(["Victim.ini", "Victim_SandboxVars.lua"]);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-config-at-use-"));
  installDir = path.join(root, "pz-install");
  dataDir = path.join(root, "Zomboid");
  configDir = path.join(dataDir, "Server");
  // A folder outside any data folder, saved as a config folder before the
  // save-time check existed.
  outsideDir = path.join(root, "unrelated-host-dir");
  for (const dir of [installDir, configDir, path.join(dataDir, "Saves"), outsideDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await db.initDatabase();
  const server = await db.createServer({
    name: "Victim",
    serverName: "Victim",
    installPath: installDir,
    zomboidDataPath: dataDir,
    serverConfigPath: configDir,
    rconHost: "127.0.0.1",
    rconPort: 27997,
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
  app.use("/api/server", serverRouter);
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
  fs.writeFileSync(path.join(outsideDir, "Victim.ini"), OUTSIDE_INI);
  fs.writeFileSync(path.join(outsideDir, "Victim_SandboxVars.lua"), OUTSIDE_LUA);
  for (const name of fs.readdirSync(outsideDir)) {
    if (!["Victim.ini", "Victim_SandboxVars.lua"].includes(name)) {
      fs.rmSync(path.join(outsideDir, name), { recursive: true, force: true });
    }
  }
  await db.updateServer(serverId, { zomboidDataPath: dataDir, serverConfigPath: configDir, isRemote: false });
  await db.setSetting("zomboidDataPath", dataDir);
  await db.setSetting("serverConfigPath", configDir);
});

// A record (or legacy setting) saved before the save-time check: written
// straight to the database.
async function storeRecord(fields) {
  await db.updateServer(serverId, fields);
}

describe("Server Files holds the folder a request uses to the data folder in effect", () => {
  it("refuses a record with a config folder and no data folder", async () => {
    await storeRecord({ zomboidDataPath: null, serverConfigPath: outsideDir });
    await db.setSetting("zomboidDataPath", null);
    const read = await call("GET", "/api/server-files/raw/ini");
    expect(read.status).toBe(400);
    expect(read.json.code).toBe(OUTSIDE);
    const write = await call("PUT", "/api/server-files/raw/sandbox", { content: "-- chosen\n" });
    expect(write.status).toBe(400);
    outsideUntouched();
  });

  it("refuses the legacy settings config folder when the record has neither folder", async () => {
    await storeRecord({ zomboidDataPath: null, serverConfigPath: null });
    await db.setSetting("zomboidDataPath", null);
    await db.setSetting("serverConfigPath", outsideDir);
    const read = await call("GET", "/api/server-files/raw/ini");
    expect(read.status).toBe(400);
    expect(read.json.code).toBe(OUTSIDE);
    const write = await call("PUT", "/api/server-files/raw/ini", { content: "Pwned=1\n" });
    expect(write.status).toBe(400);
    outsideUntouched();
  });

  it("holds a record's config folder to the legacy data folder when the record has none", async () => {
    await storeRecord({ zomboidDataPath: null, serverConfigPath: outsideDir });
    const refused = await call("GET", "/api/server-files/raw/ini");
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe(OUTSIDE);

    await storeRecord({ zomboidDataPath: null, serverConfigPath: configDir });
    fs.writeFileSync(path.join(configDir, "Victim.ini"), "PublicName=Inside\n");
    const allowed = await call("GET", "/api/server-files/raw/ini");
    expect(allowed.status).toBe(200);
  });
});

describe("the other readers and writers of a server's config folder", () => {
  it("mods and /configure-rcon don't use a config folder outside the data folder", async () => {
    await storeRecord({ serverConfigPath: outsideDir });
    expect((await modsPaths()).serverConfigPath).toBeNull();
    const paths = await serverPaths();
    expect(paths.serverConfigPath).toBeNull();
    expect(paths.configPathRefused).toBe(true);

    const r = await call("POST", "/api/server/configure-rcon", { rconPassword: "newpass", rconPort: 27015 });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(OUTSIDE);
    outsideUntouched();
  });

  it("ensureRconConfigured() doesn't write the RCON password into it", async () => {
    const result = await ensureRconConfigured({
      ...(await db.getServer(serverId)),
      serverConfigPath: outsideDir,
      rconPassword: "changed",
    });
    expect(result).toBe(false);
    outsideUntouched();
  });

  it("applying a template refuses it", async () => {
    await storeRecord({ serverConfigPath: outsideDir });
    const result = await applyTemplate("first-week-friendly", serverId);
    expect(result.success).toBe(false);
    expect(result.code).toBe(OUTSIDE);
    outsideUntouched();
  });

  it("PanelBridge delivery, backup snapshots, the Discord presence and the support bundle don't read it", async () => {
    await storeRecord({ serverConfigPath: outsideDir });
    const record = await db.getServer(serverId);
    expect(resolveBridgeIniPath(record)).toBeNull();
    expect(captureBackupSnapshot(record).serverIni).toEqual({});
    expect(await new DiscordBot(null, null, null).getConfiguredMaxPlayers()).toBeNull();
    expect((await buildServerConfigSummary(record)).available).toBe(false);
  });

  it("a pre-restart config backup writes nothing into it", async () => {
    await storeRecord({ serverConfigPath: outsideDir });
    await new Scheduler({}, {})._backupConfigBeforeRestart(serverId);
    outsideUntouched();
  });

  it("editing UPnP doesn't rewrite its ini, and says so", async () => {
    await storeRecord({ serverConfigPath: outsideDir, useUpnp: true });
    const r = await call("PUT", `/api/servers/${serverId}`, { useUpnp: false });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).toMatch(/outside its Zomboid data folder/);
    outsideUntouched();
  });

  it("all of them still use a config folder inside the data folder", async () => {
    fs.writeFileSync(path.join(configDir, "Victim.ini"), "PublicName=Inside\nMaxPlayers=12\n");
    const record = await db.getServer(serverId);
    expect(resolveBridgeIniPath(record)).toBe(path.join(configDir, "Victim.ini"));
    expect(captureBackupSnapshot(record).serverIni.MaxPlayers).toBe("12");
    expect(await new DiscordBot(null, null, null).getConfiguredMaxPlayers()).toBe(12);
    expect((await modsPaths()).serverConfigPath).toBe(configDir);
  });
});
