import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

// AUTHN-5 (security sweep): the manual data/reset-token.txt recovery path
// accepted any token of 8+ characters (the remote-recovery help said "any
// token at least 8 characters long"), failed guesses were only limited per
// address (3 per 15 minutes) and never used the file up. The repro: the
// operator writes "changeme", an attacker rotates addresses through a short
// dictionary against POST /api/auth/reset-password, hits it, and signs in
// as admin with a password of their choosing.
//
// Now a token must be at least RESET_TOKEN_MIN_LENGTH (32) characters, and
// MAX_RESET_TOKEN_FAILURES wrong tokens from any mix of addresses delete
// the file.

const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
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
const authRoutesModule = await import("../routes/auth.js");
const { _resetResetTokenFailuresForTests } = authRoutesModule;
// Spelled out rather than imported so this file still exercises the real
// behaviour against code that doesn't export them.
const MAX_RESET_TOKEN_FAILURES = 5;
const RESET_TOKEN_MIN_LENGTH = 32;
const { getDataPaths } = await import("../utils/paths.js");
const { io } = await import("../index.js");

let port;
// The reset limiter allows 3 tries per address per 15 minutes; every
// request here comes from its own loopback address so only the logic under
// test decides the outcome.
let nextAddress = 20;
const freshAddress = () => `127.0.0.${nextAddress++}`;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        localAddress: freshAddress(),
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text || "{}") }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const tokenPath = () => path.join(getDataPaths().dataDir, "reset-token.txt");
function writeToken(token) {
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  fs.writeFileSync(tokenPath(), `${token}\n`);
}
const reset = (token) => post("/api/auth/reset-password", { token, newPassword: "attacker-pw-1" });
const passwordIs = (password) => bcrypt.compare(password, db.data.users[0].password);

beforeAll(async () => {
  authService.jwtSecret = "reset-token-test-secret-".padEnd(64, "x");
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(async () => {
  _resetResetTokenFailuresForTests?.();
  fs.rmSync(tokenPath(), { force: true });
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage"], isSeeded: true }];
  db.data.users = [
    {
      id: "u-admin",
      username: "admin",
      role: "admin",
      roleId: "role-admin",
      password: await bcrypt.hash("original-pw-1", 4),
      tokenGen: 0,
      refreshSessions: [],
    },
  ];
});

describe("AUTHN-5: the manual reset token", () => {
  it("documents its limits", () => {
    expect(authRoutesModule.MAX_RESET_TOKEN_FAILURES).toBe(MAX_RESET_TOKEN_FAILURES);
    expect(authRoutesModule.RESET_TOKEN_MIN_LENGTH).toBe(RESET_TOKEN_MIN_LENGTH);
  });

  it("refuses a short, human-chosen token instead of resetting the admin password with it", async () => {
    writeToken("changeme");
    const res = await reset("changeme");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESET_TOKEN_TOO_SHORT");
    expect(await passwordIs("original-pw-1")).toBe(true);
  });

  it("deletes the token file after MAX_RESET_TOKEN_FAILURES wrong tokens, whichever addresses sent them", async () => {
    const token = crypto.randomBytes(24).toString("hex");
    writeToken(token);
    for (let i = 1; i < MAX_RESET_TOKEN_FAILURES; i++) {
      const res = await reset(`wrong-guess-${i}`);
      expect(res.body.code).toBe("RESET_TOKEN_INVALID");
    }
    const last = await reset("wrong-guess-last");
    expect(last.status).toBe(403);
    expect(last.body.code).toBe("RESET_TOKEN_BURNED");
    expect(fs.existsSync(tokenPath())).toBe(false);

    // Used up: even the right token no longer works.
    const late = await reset(token);
    expect(late.body.code).toBe("RESET_TOKEN_NOT_FOUND");
    expect(await passwordIs("original-pw-1")).toBe(true);
  });

  it("a new token file starts a fresh count", async () => {
    writeToken(crypto.randomBytes(24).toString("hex"));
    for (let i = 1; i < MAX_RESET_TOKEN_FAILURES; i++) await reset(`wrong-guess-${i}`);
    // A different length too, so the new file can't look like the old one
    // even where a filesystem reuses the inode and its clock is coarse.
    fs.rmSync(tokenPath());
    writeToken(crypto.randomBytes(32).toString("hex"));
    expect((await reset("one-more-wrong-guess")).body.code).toBe("RESET_TOKEN_INVALID");
    expect(fs.existsSync(tokenPath())).toBe(true);
  });

  it("still resets with a strong token, once", async () => {
    const token = crypto.randomBytes(24).toString("hex");
    expect(token.length).toBeGreaterThanOrEqual(RESET_TOKEN_MIN_LENGTH);
    writeToken(token);
    const res = await reset(token);
    expect(res.status).toBe(200);
    expect(await passwordIs("attacker-pw-1")).toBe(true);
    expect(fs.existsSync(tokenPath())).toBe(false);
  });
});
