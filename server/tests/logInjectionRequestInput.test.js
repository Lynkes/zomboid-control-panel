import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";

// Security sweep 2026-10-05, H2: log lines quoted request input as sent.
// Node's HTTP parser refuses CR/LF in a header but keeps bytes 0x80-0xFF as
// latin1, so a 0x85 byte in Origin or Host arrived as U+0085 (NEL), which
// some log tools break lines on: "CORS blocked request from origin: <...>"
// let an anonymous caller start what looked like a second, genuine panel
// entry. The same went for the Host refusal, the stored CORS block record,
// the sign-in pause line (X-Forwarded-For behind TRUST_PROXY), the generic
// API error line (a rejected JSON body is quoted in err.message) and the
// OIDC callback lines (query parameters in the client library's error text,
// the provider's `sub`). The client-error route's escaping (SDOS-3) now
// lives in utils/logText.js and all of these use it; the logger also
// escapes C1 controls and U+2028/U+2029 in every entry.

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

vi.mock("../services/oidc.js", async (importOriginal) => {
  let issuedStates = 0;
  return {
    ...(await importOriginal()),
    getOidcSettings: async () => ({
      issuerUrl: "https://idp.example",
      clientId: "panel",
      clientSecret: "secret",
      redirectUri: "https://panel.example/api/auth/oidc/callback",
    }),
    isOidcConfigured: () => true,
    handleOidcCallback: vi.fn(),
    // routes/oidc.js only honours a callback for a flow it issued, once, so
    // the callback tests below each start their own through GET /login.
    buildOidcAuthorizationRequest: async () => ({
      authorizationUrl: "https://idp.example/authorize",
      state: `s-${++issuedStates}`,
      nonce: "n",
      codeVerifier: "v",
    }),
  };
});

const { escapeLogText } = await import("../utils/logText.js");
const { onLog } = await import("../utils/logger.js");
const { default: authService, _resetLoginThrottleForTests } = await import("../services/auth.js");
const oidcService = await import("../services/oidc.js");
const { default: oidcRoutes } = await import("../routes/oidc.js");
const { app, io, apiErrorHandler } = await import("../index.js");

const C = (...codes) => String.fromCharCode(...codes);
const NEL = C(0x85);
const LS = C(0x2028);
const PS = C(0x2029);
const CRLF = C(13, 10);
// Anything a log viewer (or String.split) might take for the end of a line.
const LINE_BREAKS = new RegExp(`[${C(13, 10, 0x85, 0x2028, 0x2029)}]`);

function forgedEntry(text) {
  return `2026-10-05 03:12:44 [INFO] [Auth] ${text}`;
}

const logged = [];
const stopLogging = onLog((entry) => logged.push(entry));

async function logLine(marker) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const entry = logged.find((e) => typeof e.message === "string" && e.message.includes(marker));
    if (entry || Date.now() > deadline) return entry?.message;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let port;

// Raw header values go out as latin1, so U+0085 leaves as the single byte
// 0x85 -- what an attacker's client sends.
function get(path, headers) {
  return send("GET", path, headers).then((res) => res.status);
}

function send(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

beforeAll(async () => {
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  stopLogging();
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(async () => {
  settings.clear();
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage", "roles.manage"], isSeeded: true }];
  db.data.users = [];
});

describe("escapeLogText()", () => {
  it("escapes C0, DEL, C1 and U+2028/U+2029, and nothing else", () => {
    expect(escapeLogText(`a${C(0)}b${CRLF}c${C(9)}d${C(0x7f)}e${NEL}f${C(0x9f)}g${LS}h${PS}i`)).toBe(
      String.raw`a\u0000b\r\nc\td\u007fe\u0085f\u009fg\u2028h\u2029i`,
    );
    expect(escapeLogText("Spiffo's café, 测试 ✓")).toBe("Spiffo's café, 测试 ✓");
    expect(escapeLogText(undefined)).toBe("");
  });
});

describe("request headers in log lines", () => {
  it("keeps a NEL in a refused Origin out of the log line and the stored CORS record", async () => {
    settings.set("corsDebug", true);
    await app.get("refreshCorsConfig")();
    const marker = `origin-${Date.now()}`;
    await get("/api/health", {
      Origin: `https://${marker}.example${NEL}${forgedEntry("Password reset successful for user: admin")}`,
    });

    const line = await logLine(marker);
    expect(line).toContain("CORS blocked request from origin:");
    expect(line).not.toMatch(LINE_BREAKS);
    expect(line).toContain(String.raw`\u0085`);

    const blocked = app.get("getCorsDebugSnapshot")().blocked.find((b) => b.origin.includes(marker));
    expect(blocked).toBeTruthy();
    expect(blocked.origin).not.toMatch(LINE_BREAKS);
  });

  it("keeps a NEL in a refused Host header out of the log line", async () => {
    settings.set("authEnabled", false);
    db.data.users = [{ id: "u1", username: "admin", role: "admin", roleId: "role-admin", password: "x" }];
    await app.get("refreshCorsConfig")();
    const marker = `host-${Date.now()}`;
    const status = await get("/api/auth/users", { Host: `${marker}.example${NEL}${forgedEntry("User logged in: admin")}` });
    expect(status).toBe(403);

    const line = await logLine(marker);
    expect(line).toContain("Refused /api requests addressed to");
    expect(line).not.toMatch(LINE_BREAKS);
  });

  it("keeps a forwarded address out of the sign-in pause line", async () => {
    _resetLoginThrottleForTests?.();
    db.data.users = [
      { id: "u1", username: "admin", role: "admin", roleId: "role-admin", password: bcrypt.hashSync("correct-horse-1", 4) },
    ];
    const marker = `xff-${Date.now()}`;
    const clientKey = `203.0.113.9${NEL}${forgedEntry(`Password reset successful for user: admin ${marker}`)}`;
    for (let i = 0; i < 10; i++) {
      await expect(authService.login("admin", "wrong-password", false, { clientKey })).rejects.toThrow();
    }
    const line = await logLine(marker);
    expect(line).toContain("Sign-in to admin from");
    expect(line).not.toMatch(LINE_BREAKS);
  });
});

describe("unauthenticated input in log lines", () => {
  it("keeps a body the JSON parser rejected, and the request path, on one line", async () => {
    const marker = `body-${Date.now()}`;
    const err = new SyntaxError(`Unexpected token 'x', "${marker}${CRLF}${forgedEntry("User logged in: admin")}" is not valid JSON`);
    err.status = 400;
    const res = { status() { return this; }, json() { return this; } };
    apiErrorHandler(err, { method: "POST", path: `/api/auth/login${NEL}${LS}` }, res, () => {});

    const line = await logLine(marker);
    expect(line).toContain("Unhandled API error on POST /api/auth/login");
    expect(line).not.toMatch(LINE_BREAKS);
  });

  it("logs a request path of at most 200 characters", async () => {
    const marker = `longpath-${Date.now()}`;
    const res = { status() { return this; }, json() { return this; } };
    apiErrorHandler(new Error(`boom ${marker}`), { method: "GET", path: `/api/${"p".repeat(5000)}` }, res, () => {});

    const line = await logLine(marker);
    expect(line).toContain("Unhandled API error on GET /api/ppp");
    expect(line).not.toContain("p".repeat(201));
    expect(line.length).toBeLessThan(300);
  });

  function callbackHandler() {
    const layer = oidcRoutes.stack.find((l) => l.route?.path === "/callback" && l.route.methods.get);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  // Replays exactly the flow cookie GET /login set.
  function callbackReq(flowCookie) {
    const { state } = JSON.parse(flowCookie);
    return {
      cookies: { oidcFlow: flowCookie },
      url: `/callback?code=c&state=${encodeURIComponent(state)}`,
      headers: {},
      secure: false,
    };
  }

  function callbackRes() {
    return {
      redirect() { return this; },
      cookie() { return this; },
      clearCookie() { return this; },
    };
  }

  async function issueFlow() {
    const layer = oidcRoutes.stack.find((l) => l.route?.path === "/login" && l.route.methods.get);
    let flowCookie;
    const res = {
      ...callbackRes(),
      cookie(name, value) {
        if (name === "oidcFlow") flowCookie = value;
        return this;
      },
    };
    await layer.route.stack[layer.route.stack.length - 1].handle({ headers: {}, secure: false }, res);
    return flowCookie;
  }

  it("keeps the OIDC callback's rejection reason on one line", async () => {
    const marker = `oidc-${Date.now()}`;
    oidcService.handleOidcCallback.mockRejectedValueOnce(
      new Error(`unexpected "state" ${marker}${CRLF}${forgedEntry("OIDC sign-in: admin")}`),
    );
    const flowCookie = await issueFlow();
    await callbackHandler()(callbackReq(flowCookie), callbackRes());

    const line = await logLine(marker);
    expect(line).toContain("OIDC callback rejected:");
    expect(line).not.toMatch(LINE_BREAKS);
  });

  it("keeps the provider's subject on one line", async () => {
    const marker = `sub-${Date.now()}`;
    oidcService.handleOidcCallback.mockResolvedValueOnce({
      iss: "https://idp.example",
      sub: `${marker}${NEL}${forgedEntry("User logged in: admin")}${LS}x`,
    });
    const spy = vi
      .spyOn(authService, "loginWithExternalIdentity")
      .mockResolvedValueOnce({ linked: false, canBootstrapAdmin: false });
    const flowCookie = await issueFlow();
    await callbackHandler()(callbackReq(flowCookie), callbackRes());
    spy.mockRestore();

    const line = await logLine(marker);
    expect(line).toContain("OIDC identity not linked to any account");
    expect(line).not.toMatch(LINE_BREAKS);
  });
});

// Auth audit 2026-10-08, #18: a refused Origin and a body the JSON parser
// refused skipped every limiter (both are raised before apiLimiter ran) and
// wrote one or two lines per request, one quoting the whole path (up to Node's
// 16 KB header limit). A few thousand anonymous requests rotated the sign-in,
// lockout, reset and RCON history out of the log files.
describe("log volume from requests nobody signed in for", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it("answers 20 refused-Origin requests 403, rate-counted, with one short log line", async () => {
    const marker = `cors-flood-${Date.now()}`;
    const longPath = `/api/${"a".repeat(5000)}`;
    const before = logged.length;

    const responses = [];
    for (let i = 0; i < 20; i++) {
      responses.push(await send("GET", longPath, { Origin: `https://${marker}.example` }));
    }
    await logLine(marker);
    await settle();

    expect(responses.map((r) => r.status)).toEqual(Array(20).fill(403));
    expect(responses[0].headers["ratelimit-limit"]).toBeDefined();
    const lines = logged.slice(before).filter((e) => e.message.includes(marker));
    expect(lines).toHaveLength(1);
    expect(lines[0].message.length).toBeLessThanOrEqual(200);
    expect(logged.slice(before).some((e) => e.message.includes("a".repeat(201)))).toBe(false);
  });

  it("does not log a body the JSON parser refused at error level", async () => {
    const marker = `badjson-${Date.now()}`;
    const before = logged.length;
    const res = await send(
      "POST",
      "/api/auth/login",
      { "Content-Type": "application/json" },
      `{"username": ${marker}`,
    );
    await settle();

    expect(res.status).toBe(400);
    expect(logged.slice(before).filter((e) => e.level === "error")).toEqual([]);
  });

  // The router's "Failed to decode param '<segment>'" quotes the whole raw
  // segment in err.message, so cutting req.path alone left it at 15 KB a line.
  it("does not log a malformed path parameter at error level, nor more than 200 characters of it", async () => {
    const before = logged.length;
    const res = await send("GET", `/api/mods/thumbnail/%ZZ${"a".repeat(5000)}`);
    await settle();

    expect(res.status).toBe(400);
    const entries = logged.slice(before);
    expect(entries.filter((e) => e.level === "error")).toEqual([]);
    expect(entries.some((e) => e.message.includes("a".repeat(201)))).toBe(false);
  });

  it("cuts a long error message to 200 characters", async () => {
    const marker = `longmessage-${Date.now()}`;
    const res = { status() { return this; }, json() { return this; } };
    apiErrorHandler(new Error(`${marker} ${"m".repeat(5000)}`), { method: "GET", path: "/api/x" }, res, () => {});

    const line = await logLine(marker);
    expect(line.includes("m".repeat(201))).toBe(false);
    expect(line.length).toBeLessThan(300);
  });
});
