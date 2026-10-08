import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";

// security audit L4: private-network CORS matching used string prefixes
// ("10.", "192.168."), so attacker-controlled hostnames like 10.evil.com
// were treated as LAN origins. Only real IPv4 literals in the private
// ranges (plus loopback) may match now.
//
// Auth audit 2026-10-08, #4: every private-network origin also got
// credentialed CORS. A page on another port of the panel's host (another
// self-hosted app on :8080, any localhost:<port> page) is same-site with
// the panel, so SameSite=Strict still sends it the refresh cookie, and
// fetch(':3001/api/auth/refresh', {credentials:'include'}) read a fresh
// access token. Now only same-origin requests and origins the operator
// named get Access-Control-Allow-Credentials, and /refresh and /logout
// refuse a browser request marked same-site or cross-site.

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
const { app, io, isPrivateNetworkHost } = await import("../index.js");

describe("isPrivateNetworkHost()", () => {
  it("accepts loopback and every private / CGNAT range", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
      "10.0.0.1",
      "10.255.255.255",
      "192.168.1.20",
      "172.16.0.1",
      "172.31.255.255",
      "100.64.0.1",
      "100.127.255.255",
    ]) {
      expect(isPrivateNetworkHost(host), host).toBe(true);
    }
  });

  it("rejects hostnames that merely start like a private address", () => {
    for (const host of ["10.evil.com", "192.168.1.1.evil.com", "172.16.0.1.nip.io", "100.64.attacker.net"]) {
      expect(isPrivateNetworkHost(host), host).toBe(false);
    }
  });

  it("rejects public addresses at the edges of the private ranges", () => {
    for (const host of ["172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "11.0.0.1", "8.8.8.8"]) {
      expect(isPrivateNetworkHost(host), host).toBe(false);
    }
  });

  it("rejects malformed IPv4 and empty input", () => {
    for (const host of ["256.1.1.1", "10.0.0.256", "10.0.0", "10.0.0.1.2", "", null, undefined]) {
      expect(isPrivateNetworkHost(host), String(host)).toBe(false);
    }
  });
});

const PANEL_HOST = "192.168.1.10:3001";
const SIBLING_ORIGIN = "http://192.168.1.10:8080";
let port;

function request(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (_) {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function signedInCookie() {
  const user = db.data.users[0];
  const session = authService.createRefreshSession(user);
  return {
    session,
    cookie: `refreshToken=${authService.generateRefreshToken(user, session.id)}`,
  };
}

const sessionAlive = (session) => db.data.users[0].refreshSessions.some((s) => s.id === session.id);

beforeAll(async () => {
  authService.jwtSecret = "cors-private-network-test-secret-".padEnd(64, "x");
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(async () => {
  settings.clear();
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage"], isSeeded: true }];
  db.data.users = [
    { id: "u1", username: "admin", role: "admin", roleId: "role-admin", password: "x", tokenGen: 0 },
  ];
  await app.get("refreshCorsConfig")();
});

describe("credentialed CORS for private-network origins (auth audit #4)", () => {
  it("lets a page on another port of the panel's host call the API, but not with credentials", async () => {
    const { cookie } = signedInCookie();
    const res = await request("POST", "/api/auth/refresh", {
      Host: PANEL_HOST,
      Origin: SIBLING_ORIGIN,
      Cookie: cookie,
    });

    expect(res.headers["access-control-allow-origin"]).toBe(SIBLING_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("answers a credentialed preflight from such a page without Allow-Credentials", async () => {
    const res = await request("OPTIONS", "/api/auth/refresh", {
      Host: PANEL_HOST,
      Origin: "http://localhost:8080",
      "Access-Control-Request-Method": "POST",
    });

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("no longer remembers a private-network origin as if the operator had allowed it", async () => {
    await request("GET", "/api/health", { Host: PANEL_HOST, Origin: SIBLING_ORIGIN });
    const second = await request("POST", "/api/auth/refresh", { Host: PANEL_HOST, Origin: SIBLING_ORIGIN });

    expect(app.get("getCorsDebugSnapshot")().effectiveAllowedOrigins).not.toContain(SIBLING_ORIGIN);
    expect(second.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("refuses /refresh marked same-site and leaves the session alone", async () => {
    const { session, cookie } = signedInCookie();
    const res = await request("POST", "/api/auth/refresh", {
      Host: PANEL_HOST,
      Origin: SIBLING_ORIGIN,
      Cookie: cookie,
      "Sec-Fetch-Site": "same-site",
    });

    expect(res.status).toBe(403);
    expect(res.json?.accessToken).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(sessionAlive(session)).toBe(true);
  });

  it("refuses /logout marked cross-site, so another site can't sign the user out", async () => {
    const { session, cookie } = signedInCookie();
    const res = await request("POST", "/api/auth/logout", {
      Host: PANEL_HOST,
      Origin: "http://192.168.1.99:8080",
      Cookie: cookie,
      "Sec-Fetch-Site": "cross-site",
    });

    expect(res.status).toBe(403);
    expect(sessionAlive(session)).toBe(true);
  });

  it("still refreshes for the panel's own page, with credentials", async () => {
    const { cookie } = signedInCookie();
    const res = await request("POST", "/api/auth/refresh", {
      Host: PANEL_HOST,
      Origin: `http://${PANEL_HOST}`,
      Cookie: cookie,
      "Sec-Fetch-Site": "same-origin",
    });

    expect(res.status).toBe(200);
    expect(typeof res.json?.accessToken).toBe("string");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("treats an Origin naming the request's own host as same-origin when Sec-Fetch-Site is missing", async () => {
    const { cookie } = signedInCookie();
    const res = await request("POST", "/api/auth/refresh", {
      Host: PANEL_HOST,
      Origin: `http://${PANEL_HOST}`,
      Cookie: cookie,
    });

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("logs out the panel's own page", async () => {
    const { session, cookie } = signedInCookie();
    const res = await request("POST", "/api/auth/logout", {
      Host: PANEL_HOST,
      Cookie: cookie,
      "Sec-Fetch-Site": "same-origin",
    });

    expect(res.status).toBe(200);
    expect(sessionAlive(session)).toBe(false);
  });

  it("keeps credentials for an origin the operator named in Remote Access", async () => {
    settings.set("corsAllowedOrigins", "https://panel.example.com");
    await app.get("refreshCorsConfig")();
    const res = await request("GET", "/api/health", { Host: PANEL_HOST, Origin: "https://panel.example.com" });

    expect(res.headers["access-control-allow-origin"]).toBe("https://panel.example.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("keeps credentials for the browser extension, which sends a Bearer token", async () => {
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const res = await request("GET", "/api/health", { Host: PANEL_HOST, Origin: origin });

    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
