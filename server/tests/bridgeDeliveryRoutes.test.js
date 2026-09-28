import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import {
  MOD,
  WS_ID,
  bundledLua,
  createRoot,
  createServerFiles,
  looseServerPath,
  makeServer,
  readText,
  writeLoose,
} from "./helpers/bridgeDeliveryFixtures.js";
import { getDataPaths } from "../utils/paths.js";

// GET/POST /api/panel-bridge/delivery over real HTTP, through the real
// routers (bridgeDelivery.js mounted above panelBridge.js, as index.js does)
// and the real permission middleware, against a temp game folder and a temp
// server.ini. The last block is the end-to-end walk the spec's manual smoke
// test describes: preview == apply, the ini backed up and edited, the loose
// file archived, workshop-restart-needed, then back to panel-installed with
// the file reinstalled, both entries removed, DoLuaChecksum=false, local-ok.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async () => {
  const { dbMockImplementation } = await import("./helpers/bridgeDeliveryFixtures.js");
  const roles = {
    admin: { name: "admin", capabilities: ["bridge.setup", "bridge.diagnostics", "serverfiles.manage", "mods.manage"] },
    technician: { name: "technician", capabilities: ["bridge.setup", "bridge.diagnostics", "serverfiles.manage", "mods.manage"] },
    moderator: { name: "moderator", capabilities: ["players.moderate", "players.gm_tools", "players.view", "server.world_events"] },
    filesonly: { name: "filesonly", capabilities: ["serverfiles.manage"] },
    modsonly: { name: "modsonly", capabilities: ["mods.manage"] },
  };
  return {
    ...dbMockImplementation(dbState),
    getRoleByName: async (name) => roles[name] || null,
    getAllSettings: async () => ({}),
  };
});
vi.mock("../utils/serverStatus.js", () => ({ resolveObservedServerRunning: vi.fn(async () => false) }));

const { default: bridgeDeliveryRoutes } = await import("../routes/bridgeDelivery.js");
const { default: panelBridgeRoutes } = await import("../routes/panelBridge.js");
const { default: modsRoutes } = await import("../routes/mods.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server;
let baseUrl;
let root;
let files;

async function call(method, url, { role = "admin", body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "content-type": "application/json", ...(role ? { "x-test-role": role } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for authService.middleware(): the role comes from a header.
  app.use((req, _res, next) => {
    const role = req.get("x-test-role");
    if (role) req.user = { id: `${role}-id`, username: `${role}-user`, role };
    next();
  });
  app.set("serverManager", { startTime: null, getServerProcessDetails: async () => ({ running: false, scanFailed: false }) });
  app.set("rconService", { connected: false });
  app.set("modChecker", { autoRestartEnabled: false, lastUnavailableWorkshopIds: new Map() });
  app.use("/api/panel-bridge/delivery", bridgeDeliveryRoutes);
  app.use("/api/panel-bridge", panelBridgeRoutes);
  app.use("/api/mods", modsRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  root = createRoot();
  files = createServerFiles(root, { ini: "PVP=true\r\nMods=OtherMod\r\nWorkshopItems=111\r\nDoLuaChecksum=true\r\n" });
  dbState.servers = [makeServer(files, { serverConfigPath: path.join(files.dataDir, "Server") })];
  dbState.settings = {};
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", WS_ID);
  _resetWorkshopReleaseCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetWorkshopReleaseCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("permissions", () => {
  it.each([
    ["admin", 200],
    ["technician", 200],
    ["filesonly", 200],
    ["modsonly", 200],
    ["moderator", 403],
  ])("GET /delivery as %s -> %i", async (role, status) => {
    expect((await call("GET", "/api/panel-bridge/delivery", { role })).status).toBe(status);
  });

  it("GET without a user is 401", async () => {
    expect((await call("GET", "/api/panel-bridge/delivery", { role: null })).status).toBe(401);
  });

  it.each([
    ["technician", 200],
    ["filesonly", 403],
    ["modsonly", 403],
    ["moderator", 403],
  ])("POST /delivery (preview) as %s -> %i", async (role, status) => {
    const res = await call("POST", "/api/panel-bridge/delivery", { role, body: { serverId: "s1", method: "workshop", dryRun: true } });
    expect(res.status).toBe(status);
  });
});

describe("request validation", () => {
  it("409 when the named server is not the active one (GET and POST)", async () => {
    const get = await call("GET", "/api/panel-bridge/delivery?serverId=other");
    expect(get).toMatchObject({ status: 409, body: { code: "PANELBRIDGE_DELIVERY_NOT_ACTIVE_SERVER" } });
    const post = await call("POST", "/api/panel-bridge/delivery", { body: { serverId: "other", method: "workshop", dryRun: true } });
    expect(post).toMatchObject({ status: 409, body: { code: "PANELBRIDGE_DELIVERY_NOT_ACTIVE_SERVER" } });
  });

  it("400 for an unknown method, or an apply without a valid expectedFrom", async () => {
    const bad = await call("POST", "/api/panel-bridge/delivery", { body: { serverId: "s1", method: "mod", dryRun: true } });
    expect(bad).toMatchObject({ status: 400, body: { code: "PANELBRIDGE_DELIVERY_METHOD_INVALID" } });
    const noFrom = await call("POST", "/api/panel-bridge/delivery", { body: { serverId: "s1", method: "workshop", dryRun: false } });
    expect(noFrom).toMatchObject({ status: 400, body: { code: "PANELBRIDGE_DELIVERY_METHOD_INVALID" } });
  });

  it("400 with the existing code when there is no active server", async () => {
    dbState.servers = [];
    const res = await call("GET", "/api/panel-bridge/delivery");
    expect(res).toMatchObject({ status: 400, body: { code: "PANELBRIDGE_NO_ACTIVE_SERVER" } });
  });

  it("409 SERVER_LIFECYCLE_IN_PROGRESS while another lifecycle operation holds the lock", async () => {
    const lock = acquireLifecycleLock("restart", "s1");
    try {
      const res = await call("POST", "/api/panel-bridge/delivery", {
        body: { serverId: "s1", method: "workshop", dryRun: false, expectedFrom: "local" },
      });
      expect(res).toMatchObject({ status: 409, body: { code: "SERVER_LIFECYCLE_IN_PROGRESS" } });
      // A preview never needs the lock.
      const preview = await call("POST", "/api/panel-bridge/delivery", { body: { serverId: "s1", method: "workshop", dryRun: true } });
      expect(preview.status).toBe(200);
    } finally {
      lock.release();
    }
  });

  it("409 STALE with the current method when expectedFrom is out of date", async () => {
    const res = await call("POST", "/api/panel-bridge/delivery", {
      body: { serverId: "s1", method: "local", dryRun: false, expectedFrom: "workshop" },
    });
    expect(res).toMatchObject({ status: 409, body: { code: "PANELBRIDGE_DELIVERY_STALE", params: { current: "local" } } });
  });

  it("400 UNAVAILABLE with the reason for a blocked switch", async () => {
    dbState.servers[0].useNoSteam = true;
    const res = await call("POST", "/api/panel-bridge/delivery", {
      body: { serverId: "s1", method: "workshop", dryRun: false, expectedFrom: "local" },
    });
    expect(res).toMatchObject({ status: 400, body: { code: "PANELBRIDGE_DELIVERY_UNAVAILABLE", params: { reason: "noSteam" } } });
  });
});

describe("index.js wiring (source)", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

  it("rate-limits POST /delivery only, and no longer limits the removed install routes", () => {
    expect(indexSource).toContain('app.post("/api/panel-bridge/delivery", strictLimiter);');
    expect(indexSource).not.toMatch(/app\.use\("\/api\/panel-bridge\/delivery", strictLimiter\)/);
    expect(indexSource).not.toContain('"/api/panel-bridge/install-mod"');
    expect(indexSource).not.toContain('"/api/panel-bridge/install-local"');
  });

  it("mounts the delivery router above the panel-bridge router and wires the launch hook", () => {
    const deliveryMount = indexSource.indexOf('app.use("/api/panel-bridge/delivery", bridgeDeliveryRoutes);');
    const bridgeMount = indexSource.indexOf('app.use("/api/panel-bridge", panelBridgeRoutes);');
    expect(deliveryMount).toBeGreaterThan(-1);
    expect(deliveryMount).toBeLessThan(bridgeMount);
    expect(indexSource).toContain('setBeforeLaunchHook((server) => reconcileBridge(server, { reason: "launch" }));');
  });

  it("keeps the delivery fields off the PUT /api/servers/:id allowlist", () => {
    const serversSource = fs.readFileSync(path.join(__dirname, "..", "routes", "servers.js"), "utf8");
    const start = serversSource.indexOf("const ALLOWED_SERVER_UPDATE_FIELDS = [");
    const list = serversSource.slice(start, serversSource.indexOf("];", start));
    expect(list).not.toMatch(/"bridgeDelivery/);
  });
});

describe("removed install routes", () => {
  it("POST /install-local and /install-mod are gone", async () => {
    const hasRoute = (routePath) => panelBridgeRoutes.stack.some((entry) => entry.route?.path === routePath);
    expect(hasRoute("/install-local")).toBe(false);
    expect(hasRoute("/install-mod")).toBe(false);
    expect(hasRoute("/install-mod-auto")).toBe(true);
  });
});

describe("end to end: panel-installed -> Steam Workshop -> panel-installed", () => {
  it("walks the whole switch and back through the HTTP API", async () => {
    writeLoose(files.installDir, "media/lua/server/PanelBridge.lua", bundledLua());

    // Start: panel-installed and current.
    let status = await call("GET", "/api/panel-bridge/delivery?serverId=s1");
    expect(status.body).toMatchObject({ method: "local", state: "local-ok", access: "automatic" });
    expect(status.body.switchAvailability.toWorkshop).toMatchObject({ available: true, warnings: expect.arrayContaining(["envOverride"]) });

    // Preview == apply.
    const preview = await call("POST", "/api/panel-bridge/delivery", { body: { serverId: "s1", method: "workshop", dryRun: true } });
    expect(preview.status).toBe(200);
    expect(preview.body.applied).toBe(false);
    const applied = await call("POST", "/api/panel-bridge/delivery", {
      role: "technician",
      body: { serverId: "s1", method: "workshop", dryRun: false, expectedFrom: "local" },
    });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(applied.body.steps).toEqual(preview.body.steps);
    expect(applied.body.steps.map((step) => step.kind)).toEqual(["iniAdd", "iniAdd", "archiveFile", "recordMethod"]);

    // The ini was backed up and edited (CRLF kept, checksum untouched).
    expect(applied.body.backups).toEqual([{ file: files.iniPath, backupName: expect.stringMatching(/^servertest\.ini\..+\.bak$/) }]);
    expect(fs.existsSync(path.join(path.dirname(files.iniPath), "backups", applied.body.backups[0].backupName))).toBe(true);
    expect(fs.readFileSync(files.iniPath, "utf8")).toBe(
      `PVP=true\r\nMods=OtherMod;${MOD}\r\nWorkshopItems=111;${WS_ID}\r\nDoLuaChecksum=true\r\n`,
    );

    // The loose file was archived, not deleted.
    expect(fs.existsSync(looseServerPath(files.installDir))).toBe(false);
    const archiveRoot = path.join(getDataPaths().dataDir, "bridge-delivery-archive");
    const archived = fs.readdirSync(archiveRoot, { recursive: true }).map(String);
    expect(archived.some((entry) => entry.endsWith("PanelBridge.lua"))).toBe(true);

    // The stored method and the status.
    expect(dbState.servers[0]).toMatchObject({ bridgeDelivery: "workshop", bridgeDeliverySwitch: { to: "workshop", by: "technician-user", workshopId: WS_ID } });
    status = await call("GET", "/api/panel-bridge/delivery");
    expect(status.body).toMatchObject({ method: "workshop", state: "workshop-restart-needed", effectiveWorkshopId: WS_ID });
    expect(status.body.disk.iniEntries).toEqual({ mods: true, workshopItems: true });

    // The rest of the panel follows the method.
    const bridgeStatus = await call("GET", "/api/panel-bridge/status");
    expect(bridgeStatus.body).toMatchObject({ deliveryMethod: "workshop", localInstall: null, remoteBridgeVersionCheck: null });
    const install = await call("POST", "/api/panel-bridge/install-mod-auto", { body: {} });
    expect(install).toMatchObject({ status: 409, body: { code: "PANELBRIDGE_DELIVERY_WORKSHOP_ACTIVE", params: { serverName: "servertest" } } });
    expect(fs.existsSync(looseServerPath(files.installDir))).toBe(false);
    const modsConfig = await call("GET", "/api/mods/current-config");
    expect(modsConfig.body.bridgeManaged).toEqual({ modId: MOD, workshopId: WS_ID });

    // Back to panel-installed: preview == apply again.
    const back = await call("POST", "/api/panel-bridge/delivery", { body: { serverId: "s1", method: "local", dryRun: true } });
    expect(back.body.steps.map((step) => step.kind)).toEqual(["installFile", "iniRemove", "iniRemove", "iniSet", "recordMethod"]);
    const backApplied = await call("POST", "/api/panel-bridge/delivery", {
      body: { serverId: "s1", method: "local", dryRun: false, expectedFrom: "workshop" },
    });
    expect(backApplied.status).toBe(200);
    expect(backApplied.body.steps).toEqual(back.body.steps);

    // Reinstalled, both entries removed, DoLuaChecksum=false, local-ok.
    expect(fs.readFileSync(looseServerPath(files.installDir), "utf8")).toBe(bundledLua());
    expect(readText(files.iniPath)).toBe("PVP=true\nMods=OtherMod\nWorkshopItems=111\nDoLuaChecksum=false\n");
    status = await call("GET", "/api/panel-bridge/delivery");
    expect(status.body).toMatchObject({ method: "local", state: "local-ok" });
    expect(status.body.checksum).toMatchObject({ current: false, playersBlocked: false });
    const bridgeStatusAfter = await call("GET", "/api/panel-bridge/status");
    expect(bridgeStatusAfter.body.deliveryMethod).toBe("local");
    expect(bridgeStatusAfter.body.localInstall).toMatchObject({ installed: true, needsUpdate: false });
  });
});
