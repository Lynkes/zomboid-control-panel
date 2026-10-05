import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";

// outbound-3 (security sweep): with authentication disabled (authEnabled:
// false in db.json, a trusted-LAN setup) the API had no Host-header check,
// so DNS rebinding read admin data: a page on an attacker's domain, whose
// DNS then points at the panel, is same-origin with it, and its GETs carry
// no Origin header for CORS to refuse. The repro got 200 and the user list
// from GET /api/auth/users with Host: rebind.attacker.example:3001.
//
// Now, while auth is disabled, /api and the Socket.IO handshake answer only
// requests addressed to one of the panel's own names (server/index.js's
// isAllowedHostHeader()).

const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getAllSettings: async () => Object.fromEntries(settings),
  getDb: async () => db,
  commitNow: async () => {},
  scheduleWrite: () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id) => db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
  getUsersForRole: async () => [],
  peekServerDisplayName: () => null,
}));

const { app, io, isAllowedHostHeader } = await import("../index.js");

const REBIND_HOST = "rebind.attacker.example:3001";
let port;

function get(path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(async () => {
  settings.clear();
  settings.set("authEnabled", false);
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage", "roles.manage"], isSeeded: true }];
  db.data.users = [{ id: "u-admin", username: "verifyadmin", role: "admin", roleId: "role-admin", password: "x" }];
  await app.get("refreshCorsConfig")();
});

describe("outbound-3: Host-header check while panel logins are off", () => {
  it("refuses an /api request addressed to a foreign host name (DNS rebinding)", async () => {
    const res = await get("/api/auth/users", REBIND_HOST);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe("HOST_NOT_ALLOWED");
    expect(res.body).not.toContain("verifyadmin");
  });

  it("refuses it whatever the letter case of the /api prefix", async () => {
    const res = await get("/API/auth/users", REBIND_HOST);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("verifyadmin");
  });

  it("still answers the panel's own addresses", async () => {
    for (const host of [`127.0.0.1:${port}`, "localhost:3001", "192.168.1.20:3001", "[::1]:3001", "garage:3001", "panel.lan"]) {
      const res = await get("/api/auth/users", host);
      expect(res.status, host).toBe(200);
      expect(res.body).toContain("verifyadmin");
    }
  });

  it("answers a host name the operator allowed under Remote Access", async () => {
    settings.set("corsAllowedOrigins", "https://panel.example.com");
    await app.get("refreshCorsConfig")();
    expect((await get("/api/auth/users", "panel.example.com")).status).toBe(200);
    expect((await get("/api/auth/users", "other.example.com")).status).toBe(403);
  });

  it("refuses a Socket.IO handshake addressed to a foreign host name", async () => {
    const refused = await get("/socket.io/?EIO=4&transport=polling", REBIND_HOST);
    expect(refused.status).toBe(403);
    const allowed = await get("/socket.io/?EIO=4&transport=polling", `127.0.0.1:${port}`);
    expect(allowed.status).toBe(200);
  });

  it("does not change anything while logins are on (no session to ride on)", async () => {
    settings.delete("authEnabled");
    const res = await get("/api/auth/users", REBIND_HOST);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).code).toBe("AUTH_REQUIRED");
  });
});

describe("isAllowedHostHeader()", () => {
  it("accepts IP addresses and local names, refuses anything else or anything malformed", () => {
    expect(isAllowedHostHeader("10.0.0.5:3001")).toBe(true);
    expect(isAllowedHostHeader("203.0.113.7")).toBe(true);
    expect(isAllowedHostHeader("[fe80::1]:3001")).toBe(true);
    expect(isAllowedHostHeader("panel.localhost:3001")).toBe(true);
    expect(isAllowedHostHeader("evil.example")).toBe(false);
    expect(isAllowedHostHeader("10.evil.example")).toBe(false);
    expect(isAllowedHostHeader("1.2.3.4.nip.io")).toBe(false);
    expect(isAllowedHostHeader("")).toBe(false);
    expect(isAllowedHostHeader(undefined)).toBe(false);
    expect(isAllowedHostHeader("localhost/x")).toBe(false);
    expect(isAllowedHostHeader("user@localhost")).toBe(false);
  });
});
