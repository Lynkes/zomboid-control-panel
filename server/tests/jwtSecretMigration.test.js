import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import jwt from "jsonwebtoken";

// Same in-memory db/settings stand-in as setupTokenGate.test.js, PLUS a real
// isolated temp dir for utils/paths.js — authService.init() now touches
// both db.json (via getSetting/setSetting) and a real jwt.secret file (via
// utils/jwtSecret.js), so both need to be test-owned rather than falling
// back to whatever paths.config.json happens to be live in the repo root
// right now (another agent's session, per the "already exists and is not
// ours" globalSetup message — must not touch that).
const settings = new Map();
const db = { data: { users: [] } };
// Seeded with a real directory immediately (not inside beforeEach): the
// static imports below run at module-load time, before any hook fires, and
// services/auth.js's import chain reaches utils/logger.js, which calls
// getDataPaths() and mkdirSync's logsDir right away. beforeEach still swaps
// this out per test for isolation between tests.
let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtmigration-init-"));

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
}));

vi.mock("../utils/paths.js", () => ({
  // utils/logger.js also calls getDataPaths() at import time for logsDir —
  // needs a real, existing path or its own mkdirSync throws before any test
  // body runs.
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

const { default: authService } = await import("../services/auth.js");
const { getJwtSecretPath } = await import("../utils/jwtSecret.js");
const { default: authRouter } = await import("../routes/auth.js");

function createResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.cookie.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return authRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(routePath, method, req, res) {
  const layer = getLayer(routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
}

describe("authService.init() — JWT secret migration out of db.json", () => {
  beforeEach(() => {
    settings.clear();
    db.data.users = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtmigration-"));
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_FILE;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fresh install: generates a key, no legacy value to clear from db.json", async () => {
    await authService.init();
    expect(authService.jwtSecret).toMatch(/^[0-9a-f]{128}$/);
    expect(settings.get("jwtSecret")).toBeUndefined();
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe(
      authService.jwtSecret,
    );
  });

  it("existing install: a legacy jwtSecret in db.json migrates verbatim and is cleared from db.json", async () => {
    settings.set("jwtSecret", "legacy-value-from-old-install");

    await authService.init();

    expect(authService.jwtSecret).toBe("legacy-value-from-old-install");
    expect(settings.get("jwtSecret")).toBeNull(); // cleared, not just left stale
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe(
      "legacy-value-from-old-install",
    );
  });

  it("a token signed before the upgrade still authenticates a real request after migration — zero forced logout", async () => {
    const legacySecret = "legacy-value-that-already-signed-a-real-session";
    settings.set("jwtSecret", legacySecret);
    const tokenIssuedBeforeUpgrade = jwt.sign(
      { userId: "u1", tokenGen: 0 },
      legacySecret,
    );
    db.data.users = [{ id: "u1", username: "admin", role: "admin", tokenGen: 0 }];

    await authService.init();

    const authenticated = await authService.authenticateAccessToken(
      tokenIssuedBeforeUpgrade,
    );
    expect(authenticated).not.toBeNull();
    expect(authenticated.username).toBe("admin");
  });

  it("JWT_SECRET env override wins even with a legacy db.json value present, and still clears the stale db.json copy", async () => {
    process.env.JWT_SECRET = "env-pinned-secret";
    settings.set("jwtSecret", "legacy-value-now-unused");

    await authService.init();

    expect(authService.jwtSecret).toBe("env-pinned-secret");
    expect(settings.get("jwtSecret")).toBeNull();
  });

  it("fails loud and does not start when jwt.secret exists but is unreadable — never silently regenerates", async () => {
    fs.mkdirSync(getJwtSecretPath()); // directory at the path -> unreadable as a file

    await expect(authService.init()).rejects.toThrow(/could not be read/i);
  });
});

describe("authService.regenerateJwtSecret()", () => {
  beforeEach(async () => {
    settings.clear();
    db.data.users = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtregen-"));
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_FILE;
    await authService.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("changes the in-memory secret and invalidates a token signed before regeneration", async () => {
    const oldSecret = authService.jwtSecret;
    const oldToken = jwt.sign({ userId: "u1", tokenGen: 0 }, oldSecret);
    db.data.users = [{ id: "u1", username: "admin", role: "admin", tokenGen: 0 }];

    await authService.regenerateJwtSecret();

    expect(authService.jwtSecret).not.toBe(oldSecret);
    const authenticated = await authService.authenticateAccessToken(oldToken);
    expect(authenticated).toBeNull();
  });

  it("refuses when a JWT_SECRET environment override is active, with an actionable message", async () => {
    process.env.JWT_SECRET = "env-pinned-secret";
    await expect(authService.regenerateJwtSecret()).rejects.toThrow(
      /environment variable/i,
    );
  });
});

describe("POST /api/auth/regenerate-jwt-secret — admin-only route gate", () => {
  beforeEach(async () => {
    settings.clear();
    db.data.users = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtregen-route-"));
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_FILE;
    await authService.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses a technician", async () => {
    const req = { user: { role: "technician" } };
    const res = createResponse();
    await runRoute("/regenerate-jwt-secret", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("refuses a moderator", async () => {
    const req = { user: { role: "moderator" } };
    const res = createResponse();
    await runRoute("/regenerate-jwt-secret", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("admits an admin, invalidates the caller's own refresh cookie, and reports success", async () => {
    const oldSecret = authService.jwtSecret;
    const req = { user: { role: "admin", username: "boss" }, headers: {} };
    const res = createResponse();

    await runRoute("/regenerate-jwt-secret", "post", req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.clearCookie).toHaveBeenCalledWith(
      "refreshToken",
      expect.any(Object),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(authService.jwtSecret).not.toBe(oldSecret);
  });
});
