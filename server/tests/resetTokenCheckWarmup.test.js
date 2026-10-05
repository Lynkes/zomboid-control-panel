import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";

// Security sweep 2026-10-05, A2, round 4 of the verification: the table of
// well-known hashes behind resetTokenWeakness() (utils/resetTokenStrength.js)
// was worked out the first time a token file of 32 characters or more
// turned up, inside the request that found it. So the first remote guess
// after the operator wrote a file took about 300 ms, against a few ms
// before and after: a one-off timing signal that a token file now exists,
// which the panel tells nobody but the host. The table is now worked out
// before the file is looked at, whether or not there is one.
//
// A file of its own, so the first request here is the process's first.

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

// Each call the routes make, and whether the table was ready when it
// returned.
const builds = vi.hoisted(() => []);
vi.mock("../utils/resetTokenStrength.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    prepareResetTokenChecks: () => {
      const build = { settled: false };
      builds.push(build);
      return original.prepareResetTokenChecks().then(() => {
        build.settled = true;
      });
    },
  };
});

const { default: authService } = await import("../services/auth.js");
const { getDataPaths } = await import("../utils/paths.js");
const { io } = await import("../index.js");

let port;
let nextAddress = 10;
const freshAddress = () => `127.0.4.${nextAddress++}`;

function reset(token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ token, newPassword: "attacker-pw-1" });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/auth/reset-password",
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

beforeAll(async () => {
  authService.jwtSecret = "reset-token-warmup-secret-".padEnd(64, "x");
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
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  fs.rmSync(tokenPath(), { force: true });
  await new Promise((resolve) => io.httpServer.close(resolve));
});

describe("A2 round 4: the first guess costs the same whether or not a token file exists", () => {
  it("works the hash table out on a remote guess made before any token file exists", async () => {
    const guess = "e4c1f0a8b2d6973e5a1c0f8b7d2e6a49e4c1f0a8b2d6973e";
    fs.rmSync(tokenPath(), { force: true });
    expect(builds).toEqual([]);

    const missing = await reset(guess);
    expect(missing).toEqual({ status: 403, body: expect.objectContaining({ code: "RESET_TOKEN_INVALID" }) });
    // The request waited for the table: it was ready before the answer.
    expect(builds.length).toBeGreaterThan(0);
    expect(builds.every((build) => build.settled)).toBe(true);

    // Once a file turns up, the next guess finds the table ready, and the
    // answer is the same as before.
    fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
    fs.writeFileSync(tokenPath(), "3f9a0c7be15d42a8960e7d1fb4c2a95e0d63b8f1c7a24e59\n");
    const present = await reset(guess);
    expect(present).toEqual(missing);
    expect(builds.every((build) => build.settled)).toBe(true);
    expect(fs.existsSync(tokenPath())).toBe(true);
  });
});
