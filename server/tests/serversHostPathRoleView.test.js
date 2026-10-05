import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";

// Security sweep 2026-10-04, adversary pass on the app-settings role view:
// GET /api/config/app-settings now hides host folders from a role that can't
// change them, but GET /api/servers (and /active, /:id) -- no capability
// gate, every role's pages read it -- returned each server's install
// folder, data folder, config folder and launch command as stored. A
// moderator read /opt/pz/prod-install and /home/operator/Zomboid there
// instead. GET /api/server/status returned the install folder too.
//
// Fix: these reads replace host folders with the masked placeholder for a
// role holding none of servers.manage, server.install, bridge.setup and
// panel.settings. Promoted from the adversary's
// appSettingsSiblingLeak.test.mjs.
const db = await import("../database/init.js");
const { DEFAULT_ROLE_CAPABILITIES } = await import("../services/permissions.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverRouter } = await import("../routes/server.js");

const PATHS = {
  installPath: "/opt/pz/prod-install",
  zomboidDataPath: "/home/operator/Zomboid",
  serverConfigPath: "/home/operator/Zomboid/Server",
  startCommand: "/opt/pz/prod-install/start-server.sh -servername Prod",
};

let baseUrl;
let httpServer;
let currentRole = "moderator";
let serverId;

async function getJson(url) {
  const res = await fetch(baseUrl + url);
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  await db.initDatabase();
  const server = await db.createServer({
    name: "Prod",
    serverName: "Prod",
    ...PATHS,
    rconHost: "127.0.0.1",
    rconPort: 27015,
    rconPassword: "super-secret-rcon",
    adminPassword: "super-secret-admin",
  });
  serverId = server.id;
  await db.updateServer(serverId, { startCommand: PATHS.startCommand });
  await db.setActiveServer(serverId);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", {
    getServerStatus: async () => ({
      running: false,
      serverPath: PATHS.installPath,
      serverPathConfigured: true,
    }),
  });
  app.set("rconService", { getConfig: () => ({ host: "127.0.0.1", port: 27015 }) });
  app.use("/api/servers", serversRouter);
  app.use("/api/server", serverRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
});

async function serverViews() {
  const list = await getJson("/api/servers");
  const active = await getJson("/api/servers/active");
  const one = await getJson(`/api/servers/${serverId}`);
  for (const r of [list, active, one]) expect(r.status).toBe(200);
  return [list.json.servers.find((s) => s.id === serverId), active.json.server, one.json.server];
}

describe("server reads show host folders only to roles that set them up", () => {
  it("premise: the moderator holds none of the path capabilities", () => {
    for (const capability of ["servers.manage", "server.install", "bridge.setup", "panel.settings"]) {
      expect(DEFAULT_ROLE_CAPABILITIES.moderator).not.toContain(capability);
    }
  });

  it("a moderator gets placeholders for every host folder and the launch command", async () => {
    currentRole = "moderator";
    for (const view of await serverViews()) {
      expect(view.name).toBe("Prod");
      for (const [field, value] of Object.entries(PATHS)) {
        expect(view[field]).toBe("••••••••");
        expect(JSON.stringify(view)).not.toContain(value);
      }
      expect(view.rconPassword).toBe("••••••••");
    }
  });

  it("a moderator doesn't get the install folder from the server status either", async () => {
    currentRole = "moderator";
    const r = await getJson("/api/server/status");
    expect(r.status).toBe(200);
    expect(r.json.serverPath).toBe("••••••••");
    expect(r.json.serverPathConfigured).toBe(true);
  });

  it("a technician (servers.manage) still gets the real folders", async () => {
    currentRole = "technician";
    for (const view of await serverViews()) {
      for (const [field, value] of Object.entries(PATHS)) expect(view[field]).toBe(value);
    }
    const status = await getJson("/api/server/status");
    expect(status.json.serverPath).toBe(PATHS.installPath);
  });
});
