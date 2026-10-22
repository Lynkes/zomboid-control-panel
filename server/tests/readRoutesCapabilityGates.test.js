import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, tokenWithCapabilities } from "./helpers/authzHarness.js";

// SECURITY (2026-10-20, access-control audit): three routes answered every
// signed-in role. GET /api/map/vehicles (where every saved vehicle sits) now
// needs players.view; GET /api/panel-bridge/ping (queues a command to the
// game) a bridge capability; GET /api/rcon/status keeps `connected` for
// everyone but gives the RCON host and port to rcon.execute or
// servers.manage only.

const { default: mapRouter } = await import("../routes/mapProxy.js");
const { default: bridgeRouter } = await import("../routes/panelBridge.js");
const { default: rconRouter } = await import("../routes/rcon.js");

let app;
let nobody;
let viewer;
let diagnostics;
let rconUser;
let fleet;

beforeAll(async () => {
  nobody = await tokenWithCapabilities(["server.world_events"]);
  viewer = await tokenWithCapabilities(["players.view"]);
  diagnostics = await tokenWithCapabilities(["bridge.diagnostics"]);
  rconUser = await tokenWithCapabilities(["rcon.execute"]);
  fleet = await tokenWithCapabilities(["servers.manage"]);
  app = await startApp(
    [
      ["/api/map", mapRouter],
      ["/api/panel-bridge", bridgeRouter],
      ["/api/rcon", rconRouter],
    ],
    {
      rconService: {
        getConfig: () => ({
          host: "10.0.0.5",
          port: 27015,
          connected: true,
          lastSuccessfulCommand: null,
          reconnectAttempts: 0,
          autoReconnectEnabled: true,
          autoReconnectIntervalSeconds: 30,
        }),
      },
    },
  );
});

afterAll(async () => {
  await app?.close();
});

describe("GET /api/map/vehicles", () => {
  it("is refused without players.view", async () => {
    expect((await app.call("GET", "/api/map/vehicles", nobody)).status).toBe(403);
  });

  it("answers players.view", async () => {
    const res = await app.call("GET", "/api/map/vehicles", viewer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ vehicles: [] });
  });
});

describe("GET /api/panel-bridge/ping", () => {
  it("is refused without a bridge capability", async () => {
    expect((await app.call("GET", "/api/panel-bridge/ping", viewer)).status).toBe(403);
  });

  it("passes the gate with bridge.diagnostics", async () => {
    const res = await app.call("GET", "/api/panel-bridge/ping", diagnostics);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});

describe("GET /api/rcon/status", () => {
  it("tells any role whether RCON is connected, but not where it connects", async () => {
    const res = await app.call("GET", "/api/rcon/status", viewer);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body).not.toHaveProperty("host");
    expect(res.body).not.toHaveProperty("port");
    expect(res.text).not.toContain("10.0.0.5");
  });

  it("gives the host and port to rcon.execute and to servers.manage", async () => {
    for (const token of [rconUser, fleet]) {
      const res = await app.call("GET", "/api/rcon/status", token);
      expect(res.body).toMatchObject({ host: "10.0.0.5", port: 27015, connected: true });
    }
  });
});
