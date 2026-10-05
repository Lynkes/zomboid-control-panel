import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// Security sweep 2026-10-05, H4 round 3 (verifier): GET /api/servers gives a
// role without the host-path capabilities (utils/hostPathView.js) the
// placeholder for the server's folders, but a custom role holding one of the
// capabilities that work WITH those folders without setting them up still
// read them elsewhere:
//   - bridge.diagnostics: GET /api/panel-bridge/status's bridge folder,
//     detected install and data folders, status file and Lua file paths;
//   - mods.manage: the Workshop ACF path (GET /api/mods/status and
//     /workshop-status) and the ini path the Mods routes answer with;
//   - serverfiles.manage: GET /api/server-files/paths's config folder and
//     each file's full path, echoed by the file routes too;
//   - all three (and bridge.setup): GET /api/panel-bridge/delivery's install
//     folder, ini and loose bridge files;
//   - a failed config backup's warning, which mods.manage and
//     serverfiles.manage saves answer with, quoted the config folder raw.
// The roles that set the folders up keep them.

const init = await import("../database/init.js");
const { default: panelBridgeRouter } = await import("../routes/panelBridge.js");
const { default: bridgeDeliveryRouter } = await import("../routes/bridgeDelivery.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { default: bridge } = await import("../services/panelBridge.js");
const { HIDDEN_HOST_PATH } = await import("../utils/hostPathView.js");
const { backupWarningFor } = await import("../utils/configBackup.js");

const MARKER = `zcp-h4c-${process.pid}`;
const ROOT = path.join(os.tmpdir(), MARKER);
const INSTALL_DIR = path.join(ROOT, "pz install");
const DATA_DIR = path.join(ROOT, "Zomboid");
const CONFIG_DIR = path.join(DATA_DIR, "Server");
const BRIDGE_DIR = path.join(DATA_DIR, "Lua", "ZCPB");
const ACF_PATH = path.join(INSTALL_DIR, "steamapps", "workshop", "appworkshop_108600.acf");
const LOOSE_LUA = path.join(INSTALL_DIR, "media", "lua", "server", "PanelBridge.lua");
const INI = path.join(CONFIG_DIR, "servertest.ini");

const modChecker = {
  getStatus: async () => ({
    running: false,
    workshopAcfConfigured: true,
    workshopAcfPath: ACF_PATH,
    totalModsTracked: 0,
  }),
};

let baseUrl;
let httpServer;
let currentRole = "technician";
let previousBridgePath;
let previousModStatus;

async function request(url, init = {}) {
  const res = await fetch(baseUrl + url, init);
  return { status: res.status, body: await res.json() };
}

async function getJson(url) {
  const { status, body } = await request(url);
  expect(status, url).toBe(200);
  return body;
}

function expectNoHostFolder(body) {
  const text = JSON.stringify(body);
  expect(text).not.toContain(MARKER);
  expect(text).not.toContain(JSON.stringify(process.cwd()).slice(1, -1));
}

beforeAll(async () => {
  await init.initDatabase();
  await init.insertRole({ id: "role-h4c-bridge", name: "h4c-bridge", capabilities: ["bridge.diagnostics"] });
  await init.insertRole({ id: "role-h4c-mods", name: "h4c-mods", capabilities: ["mods.manage"] });
  await init.insertRole({ id: "role-h4c-files", name: "h4c-files", capabilities: ["serverfiles.manage"] });

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(ACF_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(LOOSE_LUA), { recursive: true });
  fs.writeFileSync(ACF_PATH, '"AppWorkshop"\n{\n}\n');
  fs.writeFileSync(LOOSE_LUA, "-- PanelBridge\n");
  fs.writeFileSync(INI, "PVP=true\nMods=\nWorkshopItems=\nMap=Muldraugh, KY\n");
  const server = await init.createServer({
    name: "H4C",
    serverName: "servertest",
    installPath: INSTALL_DIR,
    zomboidDataPath: DATA_DIR,
    serverConfigPath: CONFIG_DIR,
  });
  await init.setActiveServer(server.id);

  previousBridgePath = bridge.bridgePath;
  previousModStatus = bridge.modStatus;
  bridge.bridgePath = BRIDGE_DIR;
  bridge.modStatus = {
    alive: false,
    version: "1.7.72",
    error: `Parse error: EACCES: permission denied, open '${path.join(BRIDGE_DIR, "status.json")}'`,
    lastPath: BRIDGE_DIR,
    filePath: path.join(BRIDGE_DIR, "status.json"),
    players: [],
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("modChecker", modChecker);
  app.set("io", null);
  app.use("/api/panel-bridge/delivery", bridgeDeliveryRouter);
  app.use("/api/panel-bridge", panelBridgeRouter);
  app.use("/api/mods", modsRouter);
  app.use("/api/server-files", serverFilesRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  bridge.bridgePath = previousBridgePath;
  bridge.modStatus = previousModStatus;
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("GET /api/panel-bridge/status", () => {
  it("gives a role that only diagnoses the bridge no host folder", async () => {
    currentRole = "h4c-bridge";
    const status = await getJson("/api/panel-bridge/status");
    expect(status.configured).toBe(true);
    expect(status.bridgePath).toBe(HIDDEN_HOST_PATH);
    expect(status.detectedPaths).toMatchObject({
      serverName: "servertest",
      installPath: HIDDEN_HOST_PATH,
      zomboidDataPath: HIDDEN_HOST_PATH,
    });
    expect(status.statusFile.path).toMatch(/^status\.json(\.txt)?$/);
    expect(status.localInstall).toMatchObject({ sourcePath: "PanelBridge.lua", targetPath: "PanelBridge.lua" });
    expect(status.modStatus).toMatchObject({
      version: "1.7.72",
      lastPath: HIDDEN_HOST_PATH,
      filePath: "status.json",
      error: "Parse error: EACCES: permission denied, open '[path]'",
    });
    expectNoHostFolder(status);
  });

  it("keeps the folders for a role that sets the bridge up", async () => {
    currentRole = "technician";
    const status = await getJson("/api/panel-bridge/status");
    expect(status.bridgePath).toBe(BRIDGE_DIR);
    expect(status.detectedPaths.installPath).toBe(INSTALL_DIR);
    expect(status.localInstall.targetPath).toBe(LOOSE_LUA);
    expect(status.modStatus.lastPath).toBe(BRIDGE_DIR);
  });
});

describe("GET /api/panel-bridge/delivery", () => {
  for (const role of ["h4c-bridge", "h4c-mods", "h4c-files"]) {
    it(`gives ${role} the install folder as the placeholder and the bridge files below it`, async () => {
      currentRole = role;
      const status = await getJson("/api/panel-bridge/delivery");
      expect(status.access).toBe("automatic");
      expect(status.disk.installDir).toBe(HIDDEN_HOST_PATH);
      expect(status.disk.iniPath).toBe("servertest.ini");
      expect(status.disk.looseFiles).toEqual([
        { path: path.join("media", "lua", "server", "PanelBridge.lua"), kind: "server", recognized: false },
      ]);
      expectNoHostFolder(status);
    });
  }

  it("keeps the folders for a role that sets the bridge up", async () => {
    currentRole = "technician";
    const status = await getJson("/api/panel-bridge/delivery");
    expect(status.disk.installDir).toBe(INSTALL_DIR);
    expect(status.disk.iniPath).toBe(INI);
    expect(status.disk.looseFiles[0].path).toBe(LOOSE_LUA);
  });
});

describe("the Mods routes", () => {
  it("give a mods.manage-only role the Workshop ACF as the placeholder and the ini by name", async () => {
    currentRole = "h4c-mods";
    const status = await getJson("/api/mods/status");
    expect(status.workshopAcfConfigured).toBe(true);
    expect(status.workshopAcfPath).toBe(HIDDEN_HOST_PATH);

    const workshop = await getJson("/api/mods/workshop-status");
    expect(workshop).toMatchObject({ configured: true, workshopAcfPath: HIDDEN_HOST_PATH });

    const config = await getJson("/api/mods/current-config");
    expect(config).toMatchObject({ configured: true, iniPath: "servertest.ini", maps: ["Muldraugh, KY"] });

    fs.renameSync(INI, `${INI}.away`);
    try {
      const { body } = await request("/api/mods/sync-from-server", { method: "POST" });
      expect(body).toMatchObject({ success: false });
      expect(body.message).toBe("Server config not found at servertest.ini. Start the server once first.");
    } finally {
      fs.renameSync(`${INI}.away`, INI);
    }

    for (const body of [status, workshop, config]) expectNoHostFolder(body);
  });

  it("keep them for a role that sets the server's folders up", async () => {
    currentRole = "technician";
    expect((await getJson("/api/mods/status")).workshopAcfPath).toBe(ACF_PATH);
    expect((await getJson("/api/mods/workshop-status")).workshopAcfPath).toBe(ACF_PATH);
    expect((await getJson("/api/mods/current-config")).iniPath).toBe(INI);
  });
});

describe("the Server Files routes", () => {
  it("give a serverfiles.manage-only role the config folder as the placeholder and each file by name", async () => {
    currentRole = "h4c-files";
    const paths = await getJson("/api/server-files/paths");
    expect(paths).toEqual({
      configPath: HIDDEN_HOST_PATH,
      serverName: "servertest",
      files: {
        ini: "servertest.ini",
        sandbox: "servertest_SandboxVars.lua",
        spawnpoints: "servertest_spawnpoints.lua",
        spawnregions: "servertest_spawnregions.lua",
      },
      exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
    });

    const ini = await getJson("/api/server-files/ini");
    expect(ini.path).toBe("servertest.ini");
    expect(ini.settings.PVP).toBe("true");

    const missing = await request("/api/server-files/spawnpoints");
    expect(missing.status).toBe(404);
    expect(missing.body.path).toBe("servertest_spawnpoints.lua");

    for (const body of [paths, ini, missing.body]) expectNoHostFolder(body);
  });

  it("path-redact a failed config backup's warning, which both file editors' saves answer with", () => {
    const warning = backupWarningFor({
      backedUp: false,
      reason: "failed",
      error: `EACCES: permission denied, copyfile '${INI}' -> '${path.join(CONFIG_DIR, "backups", "servertest.ini.bak")}'`,
    });
    expect(warning).toBe(
      "Could not back up the previous version before saving: EACCES: permission denied, copyfile '[path]' -> '[path]'. Your change was saved, but there is no safety copy of what was there before.",
    );
  });

  it("keep them for a role that sets the server's folders up", async () => {
    currentRole = "technician";
    const paths = await getJson("/api/server-files/paths");
    expect(paths.configPath).toBe(CONFIG_DIR);
    expect(paths.files.ini).toBe(INI);
    expect((await getJson("/api/server-files/ini")).path).toBe(INI);
  });
});
