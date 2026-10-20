import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, startApp, tokenWithCapabilities } from "./helpers/authzHarness.js";
import { RCON_TARGET_CAPABILITIES } from "../utils/rconTargetView.js";

// SECURITY (2026-10-20, access-control audit, bp5 follow-up): 4f9c61011 hid
// the RCON host and port from GET /api/rcon/status for a role that doesn't
// work with RCON, but GET /api/server/status (rcon.host/port), GET
// /api/servers/active/status (the RCON signal's "host:port" detail) and GET
// /api/servers, /active and /:id (rconHost/rconPort) still gave them to
// every signed-in role. One rule now (utils/rconTargetView.js): only
// servers.manage, rcon.execute or server.configure see them.

const { default: rconRouter } = await import("../routes/rcon.js");
const { default: serverRouter } = await import("../routes/server.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverStatusRouter } = await import("../routes/serverStatus.js");

const RCON_HOST = "10.20.30.40";
const RCON_PORT = 27999;

let app;
let serverId;
let moderator;
let allowed;

beforeAll(async () => {
  const server = await init.createServer({
    name: "Prod",
    serverName: "servertest",
    rconHost: RCON_HOST,
    rconPort: RCON_PORT,
    rconPassword: "rcon-secret",
    isRemote: true,
  });
  serverId = server.id;
  await init.setActiveServer(server.id);

  // What the seeded moderator holds: no RCON capability.
  moderator = await tokenWithCapabilities(["players.moderate", "players.gm_tools", "players.view", "server.world_events"]);
  allowed = {};
  for (const capability of RCON_TARGET_CAPABILITIES) {
    allowed[capability] = await tokenWithCapabilities([capability]);
  }

  app = await startApp(
    [
      ["/api/rcon", rconRouter],
      ["/api/server", serverRouter],
      ["/api/servers", serversRouter],
      ["/api/servers", serverStatusRouter],
    ],
    {
      rconService: {
        getConfig: () => ({
          host: RCON_HOST,
          port: RCON_PORT,
          connected: true,
          lastSuccessfulCommand: null,
          reconnectAttempts: 0,
          autoReconnectEnabled: true,
          autoReconnectIntervalSeconds: 30,
        }),
      },
      serverManager: {
        getServerStatus: async () => ({ running: true, port: 16261 }),
        getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
      },
      io: null,
    },
  );
});

afterAll(async () => {
  await app?.close();
});

const READS = [
  {
    url: "/api/rcon/status",
    target: (body) => body,
    host: "host",
    port: "port",
  },
  {
    url: "/api/server/status",
    target: (body) => body.rcon,
    host: "host",
    port: "port",
  },
  {
    url: "/api/servers",
    target: (body) => body.servers.find((server) => String(server.id) === String(serverId)),
    host: "rconHost",
    port: "rconPort",
  },
  {
    url: "/api/servers/active",
    target: (body) => body.server,
    host: "rconHost",
    port: "rconPort",
  },
  {
    url: () => `/api/servers/${serverId}`,
    target: (body) => body.server,
    host: "rconHost",
    port: "rconPort",
  },
];

describe.each(READS)("$url", ({ url, target, host, port }) => {
  const path = () => (typeof url === "function" ? url() : url);

  it("leaves the RCON host and port out for a role without an RCON capability", async () => {
    const res = await app.call("GET", path(), moderator);
    expect(res.status).toBe(200);
    const view = target(res.body);
    expect(view).toBeTruthy();
    expect(view).not.toHaveProperty(host);
    expect(view).not.toHaveProperty(port);
    expect(res.text).not.toContain(RCON_HOST);
    expect(res.text).not.toContain(String(RCON_PORT));
  });

  it.each(RCON_TARGET_CAPABILITIES)("gives them to %s", async (capability) => {
    const res = await app.call("GET", path(), allowed[capability]);
    expect(res.status).toBe(200);
    expect(target(res.body)).toMatchObject({ [host]: RCON_HOST, [port]: RCON_PORT });
  });
});

describe("/api/servers/active/status", () => {
  it("keeps the RCON state but not its host:port detail for a role without an RCON capability", async () => {
    const res = await app.call("GET", "/api/servers/active/status", moderator);
    expect(res.status).toBe(200);
    expect(res.body.server).toMatchObject({ status: "connected", label: "RCON", detail: null });
    expect(res.text).not.toContain(RCON_HOST);
  });

  it.each(RCON_TARGET_CAPABILITIES)("gives %s the detail", async (capability) => {
    const res = await app.call("GET", "/api/servers/active/status", allowed[capability]);
    expect(res.status).toBe(200);
    expect(res.body.server.detail).toBe(`${RCON_HOST}:${RCON_PORT}`);
  });
});

describe("GET /api/rcon/status and /api/server/status", () => {
  it("still tell every role whether RCON is connected", async () => {
    expect((await app.call("GET", "/api/rcon/status", moderator)).body.connected).toBe(true);
    expect((await app.call("GET", "/api/server/status", moderator)).body.rcon.connected).toBe(true);
  });
});
