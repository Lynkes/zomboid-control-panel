import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";

// Security audit 2026-10-20, pre-auth limits in server/index.js:
//   - the Server Files text save's 6 MB JSON parser ran before the login
//     check, so anyone who could reach the panel had up to 6 MB parsed per
//     request; it now runs after it (the route still takes its big bodies);
//   - /socket.io/ handshakes were outside every rate limit: they are now
//     counted per client address (utils/handshakeRateLimit.js);
//   - cors() listed no PATCH, so an allowed cross-origin client's preflight
//     for PATCH /api/auth/users/:id/role failed.

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

const { default: authService } = await import("../services/auth.js");
const { app, io, _resetSocketHandshakeLimiterForTests } = await import("../index.js");
const { SOCKET_HANDSHAKE_LIMITS } = await import("../utils/handshakeRateLimit.js");

let port;

function request(method, path, { headers = {}, body, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, localAddress }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", (error) => (error.code === "ECONNRESET" || error.code === "EPIPE" ? resolve({ status: "reset" }) : reject(error)));
    req.end(body);
  });
}

const accessToken = () => authService.generateAccessToken(db.data.users[0]);
const TEXT_SAVE = "/api/files/profiles/p1/text";

beforeAll(async () => {
  authService.jwtSecret = "pre-auth-limits-test-secret-".padEnd(64, "x");
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  io.close();
  await new Promise((resolve) => io.httpServer.close(() => resolve()));
});

beforeEach(async () => {
  settings.clear();
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage"], isSeeded: true }];
  db.data.users = [{ id: "u1", username: "admin", role: "admin", roleId: "role-admin", password: "x", tokenGen: 0 }];
  await app.get("refreshCorsConfig")();
  _resetSocketHandshakeLimiterForTests?.();
});

describe("PUT /api/files/profiles/:id/text: its 6 MB body parser runs after the login check", () => {
  it("answers a signed-out request 401 without parsing its body (a malformed body is not a 400)", async () => {
    const res = await request("PUT", TEXT_SAVE, {
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(401);
  });

  it("answers a signed-out 7 MB body 401, not 413", async () => {
    const body = JSON.stringify({ content: "x".repeat(7 * 1024 * 1024) });
    const res = await request("PUT", TEXT_SAVE, { headers: { "content-type": "application/json" }, body });
    expect(res.status === 401 || res.status === "reset").toBe(true);
  });

  it("still parses a signed-in request's body with the 6 MB limit", async () => {
    const auth = { "content-type": "application/json", authorization: `Bearer ${accessToken()}` };
    const malformed = await request("PUT", TEXT_SAVE, { headers: auth, body: "{not json" });
    expect(malformed.status).toBe(400);

    const twoMb = await request("PUT", TEXT_SAVE, {
      headers: auth,
      body: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(twoMb.status).not.toBe(413);
    expect(twoMb.status).not.toBe(400);

    const sevenMb = await request("PUT", TEXT_SAVE, {
      headers: auth,
      body: JSON.stringify({ content: "x".repeat(7 * 1024 * 1024) }),
    });
    expect(sevenMb.status === 413 || sevenMb.status === "reset").toBe(true);
  });

  it("keeps the app-wide 1 MB limit for every other route", async () => {
    const res = await request("PUT", "/api/files/profiles/p1/remote-roots", {
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken()}` },
      body: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.status === 413 || res.status === "reset").toBe(true);
  });
});

describe("CORS", () => {
  it("allows PATCH in a preflight from an origin the operator allowed", async () => {
    settings.set("corsAllowedOrigins", "https://panel.example.com");
    await app.get("refreshCorsConfig")();
    const res = await request("OPTIONS", "/api/auth/users/u1/role", {
      headers: { Origin: "https://panel.example.com", "Access-Control-Request-Method": "PATCH" },
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"].split(",")).toContain("PATCH");
  });
});

describe("Socket.IO handshakes are rate limited per client address", () => {
  const handshake = (opts = {}) => request("GET", "/socket.io/?EIO=4&transport=polling", opts);

  it(`allows ${SOCKET_HANDSHAKE_LIMITS.max} a minute from one address, then refuses with 403`, async () => {
    const first = await handshake();
    expect(first.status).toBe(200);
    const sid = JSON.parse(first.text.slice(1)).sid;

    for (let i = 1; i < SOCKET_HANDSHAKE_LIMITS.max; i++) {
      expect((await handshake()).status).toBe(200);
    }
    const refused = await handshake();
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("Too many connection attempts");

    // A spoofed X-Forwarded-For is not another client (TRUST_PROXY is off).
    expect((await handshake({ headers: { "X-Forwarded-For": "203.0.113.9" } })).status).toBe(403);

    // A connection that is already open keeps working: its requests carry
    // its sid and are not handshakes.
    const post = await request("POST", `/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: "40",
    });
    expect(post.status).toBe(200);
    expect(post.text).toBe("ok");

    // Another address has its own budget.
    expect((await handshake({ localAddress: "127.0.0.2" })).status).toBe(200);
  });
});

describe("createHandshakeRateLimiter", () => {
  it("starts a new window after windowMs, keys by IPv6 /56, and tracks a bounded number of addresses", async () => {
    const { createHandshakeRateLimiter, handshakeClientKey } = await import("../utils/handshakeRateLimit.js");
    const limiter = createHandshakeRateLimiter({ windowMs: 1000, max: 2, maxKeys: 3 });
    expect([limiter.allow("a", 0), limiter.allow("a", 1), limiter.allow("a", 2)]).toEqual([true, true, false]);
    expect([limiter.allow("a", 1000), limiter.allow("a", 1000)]).toEqual([true, true]);

    // One /56 is one client.
    expect(handshakeClientKey("2001:db8:0:1::1")).toBe(handshakeClientKey("2001:db8:0:2::9"));
    expect(handshakeClientKey("::ffff:127.0.0.1")).toBe("127.0.0.1");

    // "a" has used its window; past maxKeys the oldest address is forgotten
    // (it starts afresh).
    expect(limiter.allow("a", 1001)).toBe(false);
    for (const key of ["b", "c", "d"]) limiter.allow(key, 1001);
    expect(limiter.allow("a", 1002)).toBe(true);
  });
});
