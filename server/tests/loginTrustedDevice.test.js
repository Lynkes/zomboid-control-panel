import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// Security sweep 2026-10-05, A1: failed password sign-ins are counted per
// (account, client address) in a table capped at 10000 entries; once it is
// full, a client with no entry of its own shares one overflow entry for the
// account. Someone with about 10000 addresses (cheap with IPv6), refreshed
// every 15 minutes, could fill the table and keep that overflow entry
// paused, so the owner signing in from a new address was refused. And where
// every client arrives from one address (a proxy or tunnel without
// TRUST_PROXY, Docker's bridge gateway for IPv6), the per-address count --
// and loginLimiter's 5 a minute -- were account-wide anyway.
//
// Fix (OWASP "device cookies"): a successful sign-in returns a device token;
// a later attempt carrying a valid one for the same account is counted
// under that device, with its own MAX_FAILED_LOGINS window and its own
// loginLimiter budget, never under the address or overflow entry. Invalid,
// expired, other-account and pre-password-change tokens count by address.

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

const authModule = await import("../services/auth.js");
const {
  default: authService,
  _resetLoginThrottleForTests,
  _setLoginThrottleCapacityForTests,
  _setDeviceThrottleCapacityForTests,
} = authModule;
const { io } = await import("../index.js");

// Spelled out rather than imported so this file still exercises the real
// behaviour against code that doesn't export them.
const MAX_FAILED_LOGINS = 10;
const DEVICE_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const PASSWORD = "correct-horse-1";
const JWT_SECRET = "trusted-device-test-secret-".padEnd(64, "x");
let adminHash;
let port;

const signIn = (password, { clientKey, deviceToken, username = "admin" } = {}) =>
  authService.login(username, password, false, { clientKey, deviceToken });

async function fail(clientKey, times = 1, deviceToken) {
  for (let i = 0; i < times; i++) {
    await expect(signIn(`wrong-${clientKey}-${i}`, { clientKey, deviceToken })).rejects.toThrow(
      "Invalid username or password",
    );
  }
}

async function ownerDeviceToken(clientKey = "198.18.0.1") {
  const result = await signIn(PASSWORD, { clientKey });
  return result.deviceToken;
}

function post(path, body, fromAddress, accessToken) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(data) };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        localAddress: fromAddress,
        headers,
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

beforeAll(async () => {
  authService.jwtSecret = JWT_SECRET;
  adminHash = await bcrypt.hash(PASSWORD, 4);
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  _resetLoginThrottleForTests();
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(async () => {
  _resetLoginThrottleForTests();
  // POST /regenerate-jwt-secret below replaces it.
  authService.jwtSecret = JWT_SECRET;
  settings.clear();
  db.data.roles = [
    { id: "role-admin", name: "admin", capabilities: ["users.manage", "roles.manage"], isSeeded: true },
    { id: "role-mod", name: "moderator", capabilities: [], isSeeded: true },
  ];
  db.data.users = [
    {
      id: "u-admin",
      username: "admin",
      role: "admin",
      roleId: "role-admin",
      password: adminHash,
      tokenGen: 0,
      refreshSessions: [],
    },
    {
      id: "u-mod",
      username: "mod",
      role: "moderator",
      roleId: "role-mod",
      password: await bcrypt.hash("mod-password-1", 4),
      tokenGen: 0,
      refreshSessions: [],
    },
  ];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("A1: a browser that signed in before can't be locked out by strangers", () => {
  it("a successful sign-in hands back a device token", async () => {
    const token = await ownerDeviceToken();
    expect(typeof token).toBe("string");
    expect(authService.trustedDeviceId(db.data.users[0], token)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("a full throttle table with a paused overflow entry doesn't refuse it from a new address", async () => {
    const token = await ownerDeviceToken();
    _setLoginThrottleCapacityForTests(4);
    // Fill the table with addresses that each have a recent failure...
    for (let i = 1; i <= 4; i++) await fail(`203.0.113.${i}`);
    // ...then pause the account's overflow entry from fresh ones.
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await fail(`192.0.2.${i + 1}`);

    // A browser that never signed in, at a new address: refused (unchanged).
    await expect(signIn(PASSWORD, { clientKey: "198.51.100.77" })).rejects.toThrow();
    // The owner's browser, at a new address: signs in.
    await expect(signIn(PASSWORD, { clientKey: "198.51.100.78", deviceToken: token })).resolves.toMatchObject({
      user: { username: "admin" },
    });
  });

  it("strangers sharing the owner's address (a proxy without TRUST_PROXY) don't pause it", async () => {
    const shared = "172.17.0.1";
    const token = await ownerDeviceToken(shared);
    await fail(shared, MAX_FAILED_LOGINS);

    await expect(signIn(PASSWORD, { clientKey: shared })).rejects.toThrow();
    await expect(signIn(PASSWORD, { clientKey: shared, deviceToken: token })).resolves.toMatchObject({
      user: { username: "admin" },
    });
  });

  it("over HTTP, loginLimiter's 5 a minute at a shared address doesn't refuse it either", async () => {
    const shared = "127.0.0.61";
    const token = await ownerDeviceToken();
    for (let i = 0; i < 5; i++) {
      expect((await post("/api/auth/login", { username: "admin", password: `guess${i}` }, shared)).status).toBe(401);
    }
    expect((await post("/api/auth/login", { username: "admin", password: PASSWORD }, shared)).status).toBe(429);

    const owner = await post("/api/auth/login", { username: "admin", password: PASSWORD, deviceToken: token }, shared);
    expect(owner.status).toBe(200);
    // And the response carries a fresh token for the browser to keep.
    expect(authService.trustedDeviceId(db.data.users[0], owner.body.deviceToken)).toBeTruthy();
  });
});

describe("A1: a device token is worth no more than one address", () => {
  it("MAX_FAILED_LOGINS wrong passwords with it pause it, even for the right password", async () => {
    const token = await ownerDeviceToken();
    await fail("198.51.100.1", MAX_FAILED_LOGINS, token);
    await expect(signIn(PASSWORD, { clientKey: "198.51.100.2", deviceToken: token })).rejects.toThrow();
  });

  it("a burst of 40 concurrent guesses with it gets only MAX_FAILED_LOGINS password compares", async () => {
    const token = await ownerDeviceToken();
    const compare = vi.spyOn(bcrypt, "compare");
    const attempts = [];
    for (let i = 0; i < 40; i++) {
      attempts.push(signIn(i === 35 ? PASSWORD : `wrong${i}`, { clientKey: `198.51.100.${i + 1}`, deviceToken: token }));
    }
    const results = await Promise.allSettled(attempts);
    expect(results[35].status).toBe("rejected");
    expect(compare.mock.calls.filter(([, hash]) => hash === adminHash)).toHaveLength(MAX_FAILED_LOGINS);
  });

  it("each sign-in's token is its own device; a paused one doesn't pause the others", async () => {
    const first = await ownerDeviceToken();
    const second = await ownerDeviceToken();
    await fail("198.51.100.3", MAX_FAILED_LOGINS, first);
    await expect(signIn(PASSWORD, { clientKey: "198.51.100.3", deviceToken: second })).resolves.toBeTruthy();
  });
});

describe("A1: tokens that don't count are counted by address", () => {
  const paused = "198.51.100.200";

  it("forged, garbage and other-account tokens", async () => {
    await fail(paused, MAX_FAILED_LOGINS);
    const forged = jwt.sign({ type: "device", userId: "u-admin", pwd: "x".repeat(22) }, JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: 3600,
      jwtid: "A".repeat(22),
    });
    const modToken = (await signIn("mod-password-1", { clientKey: "198.51.100.9", username: "mod" })).deviceToken;
    expect(modToken).toBeTruthy();

    for (const deviceToken of [forged, "not-a-token", "x".repeat(5000), modToken, { evil: true }]) {
      await expect(signIn(PASSWORD, { clientKey: paused, deviceToken })).rejects.toThrow();
    }
  });

  it("an expired token", async () => {
    const token = await ownerDeviceToken();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + DEVICE_TOKEN_LIFETIME_MS + 60_000);
    await fail(paused, MAX_FAILED_LOGINS);
    await expect(signIn(PASSWORD, { clientKey: paused, deviceToken: token })).rejects.toThrow();
  });

  it("a token issued before the password changed", async () => {
    const token = await ownerDeviceToken();
    await authService.changePassword("u-admin", PASSWORD, "brand-new-pass-1");
    await fail(paused, MAX_FAILED_LOGINS);
    await expect(signIn("brand-new-pass-1", { clientKey: paused, deviceToken: token })).rejects.toThrow();
    // A fresh sign-in elsewhere hands out one that counts again.
    const renewed = (await signIn("brand-new-pass-1", { clientKey: "198.51.100.10" })).deviceToken;
    await expect(signIn("brand-new-pass-1", { clientKey: paused, deviceToken: renewed })).resolves.toBeTruthy();
  });

  it("a token issued before the password was reset", async () => {
    const token = await ownerDeviceToken();
    await authService.resetPassword("reset-pass-1");
    await fail(paused, MAX_FAILED_LOGINS);
    await expect(signIn("reset-pass-1", { clientKey: paused, deviceToken: token })).rejects.toThrow();
  });
});

describe("A1: what else carries or refuses a device token", () => {
  it("is neither an access token nor a refresh token", async () => {
    const token = await ownerDeviceToken();
    expect(await authService.authenticateAccessToken(token)).toBeNull();
    expect(authService.verifyAccessToken(token)).toBeNull();
    expect(await authService.refreshAccessToken(token)).toBeNull();
  });

  it("a session refresh (kept-signed-in browsers, and the first one after SSO) hands one out", async () => {
    const { refreshToken } = await authService.login("admin", PASSWORD, true, { clientKey: "198.51.100.11" });
    const refreshed = await authService.refreshAccessToken(refreshToken);
    expect(authService.trustedDeviceId(db.data.users[0], refreshed.deviceToken)).toBeTruthy();
  });

  it("one account's devices are bounded and a full map never forgets a pause", async () => {
    _setDeviceThrottleCapacityForTests(2);
    const paused = await ownerDeviceToken();
    await fail("198.51.100.20", MAX_FAILED_LOGINS, paused);
    // More devices than the map has room for, each with a recent failure.
    for (let i = 0; i < 4; i++) await fail("198.51.100.21", 1, await ownerDeviceToken());
    await expect(signIn(PASSWORD, { clientKey: "198.51.100.22", deviceToken: paused })).rejects.toThrow();
  });
});

// Round 1 of the A1 verification: changing the password retired every
// device token, as it should, but POST /change-password handed none back to
// the browser that had just proved the current password -- and signed it
// out. Its next sign-in was counted by address, the very count a stranger
// keeps paused, so an owner who changed the password because of a guessing
// attack was refused from the browser they had just used. Rotating the JWT
// secret, a reset token and a recovery code did the same.
describe("A1: setting the password from a browser keeps that browser trusted", () => {
  const deviceIdOf = (token) => jwt.decode(token)?.jti;

  it("POST /change-password hands back a fresh device token that counts", async () => {
    const shared = "127.0.0.71";
    const signedIn = await post("/api/auth/login", { username: "admin", password: PASSWORD }, shared);
    expect(signedIn.status).toBe(200);

    const changed = await post(
      "/api/auth/change-password",
      { currentPassword: PASSWORD, newPassword: "changed-pass-1" },
      shared,
      signedIn.body.accessToken,
    );
    expect(changed.status).toBe(200);
    expect(changed.body.username).toBe("admin");
    expect(authService.trustedDeviceId(db.data.users[0], changed.body.deviceToken)).toBeTruthy();
    // The one it had before no longer counts.
    expect(authService.trustedDeviceId(db.data.users[0], signedIn.body.deviceToken)).toBeNull();

    // Strangers sharing the address pause it...
    await fail(shared, MAX_FAILED_LOGINS);
    // ...and the owner's browser still signs in with the new password.
    const again = await post(
      "/api/auth/login",
      { username: "admin", password: "changed-pass-1", deviceToken: changed.body.deviceToken },
      shared,
    );
    expect(again.status).toBe(200);
  });

  it("POST /regenerate-jwt-secret hands the admin who did it a device token on the new key", async () => {
    const shared = "127.0.0.72";
    const signedIn = await post("/api/auth/login", { username: "admin", password: PASSWORD }, shared);
    const rotated = await post("/api/auth/regenerate-jwt-secret", {}, shared, signedIn.body.accessToken);
    expect(rotated.status).toBe(200);
    expect(authService.jwtSecret).not.toBe(JWT_SECRET);
    expect(rotated.body.username).toBe("admin");
    expect(authService.trustedDeviceId(db.data.users[0], rotated.body.deviceToken)).toBeTruthy();
    expect(authService.trustedDeviceId(db.data.users[0], signedIn.body.deviceToken)).toBeNull();

    await fail(shared, MAX_FAILED_LOGINS);
    await expect(
      signIn(PASSWORD, { clientKey: shared, deviceToken: rotated.body.deviceToken }),
    ).resolves.toBeTruthy();
  });

  it("a recovery code (and a reset token, which shares resetPassword()) hands back one too", async () => {
    const { codes } = await authService.generateRecoveryCodes("u-admin", PASSWORD, 1);
    const recovered = await post(
      "/api/auth/recover-with-code",
      { code: codes[0], newPassword: "recovered-pass-1" },
      "127.0.0.73",
    );
    expect(recovered.status).toBe(200);
    expect(recovered.body.username).toBe("admin");

    const shared = "127.0.0.74";
    await fail(shared, MAX_FAILED_LOGINS);
    await expect(
      signIn("recovered-pass-1", { clientKey: shared, deviceToken: recovered.body.deviceToken }),
    ).resolves.toBeTruthy();

    const reset = await authService.resetPassword("reset-pass-2");
    expect(authService.trustedDeviceId(db.data.users[0], reset.deviceToken)).toBeTruthy();
  });

  // Round 1 also found that every refresh minted a new device id, so
  // whoever held a session cookie could collect a fresh MAX_FAILED_LOGINS
  // budget per refresh and fill the account's device table with paused
  // entries. A session keeps one id for its whole life now.
  it("a kept-signed-in session keeps one device id however often it refreshes", async () => {
    const signedIn = await authService.login("admin", PASSWORD, true, { clientKey: "198.51.100.30" });
    const ids = [deviceIdOf(signedIn.deviceToken)];
    let { refreshToken } = signedIn;
    for (let i = 0; i < 3; i++) {
      const refreshed = await authService.refreshAccessToken(refreshToken);
      expect(authService.trustedDeviceId(db.data.users[0], refreshed.deviceToken)).toBeTruthy();
      ids.push(deviceIdOf(refreshed.deviceToken));
      refreshToken = refreshed.refreshToken;
    }
    expect(new Set(ids).size).toBe(1);

    // So pausing it once pauses every token that session hands out.
    const paused = await authService.refreshAccessToken(refreshToken);
    await fail("198.51.100.31", MAX_FAILED_LOGINS, paused.deviceToken);
    const next = await authService.refreshAccessToken(paused.refreshToken);
    await expect(signIn(PASSWORD, { clientKey: "198.51.100.32", deviceToken: next.deviceToken })).rejects.toThrow();
  });

  it("a session stored before sessions had a device id gets one on refresh and keeps it", async () => {
    const { refreshToken } = await authService.login("admin", PASSWORD, true, { clientKey: "198.51.100.33" });
    delete db.data.users[0].refreshSessions[0].deviceId;
    const first = await authService.refreshAccessToken(refreshToken);
    const second = await authService.refreshAccessToken(first.refreshToken);
    expect(deviceIdOf(first.deviceToken)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(deviceIdOf(second.deviceToken)).toBe(deviceIdOf(first.deviceToken));
  });
});
