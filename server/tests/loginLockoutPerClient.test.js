import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";

// LOCKOUT (AUTHN-3 + SDOS-1) and AUTHN-4 (security sweep).
//
// LOCKOUT: 10 wrong passwords for a username locked that ACCOUNT for 15
// minutes -- for everyone, from anywhere. Any stranger who knew a username
// (the default is "admin") could keep its owner out for good from one
// address, the lock also refused SSO, and password recovery (recovery
// code, reset token, --reset-password) did not clear it, so even the new
// password was refused. Repro: 10 guesses from two addresses, then the
// owner's correct password from a third -> 401; recover-with-code -> 200;
// the new password -> still 401.
//
// AUTHN-4: the lock was checked before the ~250ms bcrypt compare and the
// failure written after it, so concurrent guesses all passed the check:
// 40 at once were all evaluated and #35 (the right password) signed in.
//
// Now failures are counted per (account, client address), reserved before
// the compare; recovery lifts every pause on the account; SSO is not a
// password guess and is never refused by one.

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
const { default: authService, _resetLoginThrottleForTests } = authModule;
// The documented limit, spelled out here rather than imported so this file
// still exercises the real behaviour against code that doesn't export it.
const MAX_FAILED_LOGINS = 10;
const { io } = await import("../index.js");

const PASSWORD = "correct-horse-1";
let passwordHash;
let port;

function post(path, body, fromAddress) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        localAddress: fromAddress,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const login = (password, fromAddress) => post("/api/auth/login", { username: "admin", password }, fromAddress);

beforeAll(async () => {
  authService.jwtSecret = "lockout-test-secret-".padEnd(64, "x");
  // Low cost keeps 40 compares fast; the lock logic doesn't depend on it.
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(() => {
  _resetLoginThrottleForTests?.();
  settings.clear();
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage", "roles.manage"], isSeeded: true }];
  db.data.users = [
    {
      id: "u-admin",
      username: "admin",
      role: "admin",
      roleId: "role-admin",
      password: passwordHash,
      tokenGen: 0,
      refreshSessions: [],
      externalIdentities: [{ issuer: "https://idp.example", subject: "admin-sub" }],
    },
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LOCKOUT: strangers' failed sign-ins don't lock the owner out", () => {
  it("allows MAX_FAILED_LOGINS failures per window", () => {
    expect(authModule.MAX_FAILED_LOGINS).toBe(MAX_FAILED_LOGINS);
  });

  it("10 wrong passwords from other addresses leave the owner's correct password working", async () => {
    for (const address of ["127.0.0.2", "127.0.0.3"]) {
      for (let i = 0; i < 5; i++) {
        expect((await login(`guess${i}`, address)).status).toBe(401);
      }
    }
    const owner = await login(PASSWORD, "127.0.0.4");
    expect(owner.status).toBe(200);
  });

  it("pauses only the address that keeps guessing", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await expect(authService.login("admin", `wrong${i}`, false, { clientKey: "198.51.100.7" })).rejects.toThrow(
        "Invalid username or password",
      );
    }
    // Paused: even the right password is refused from there...
    await expect(authService.login("admin", PASSWORD, false, { clientKey: "198.51.100.7" })).rejects.toThrow(
      "Invalid username or password",
    );
    // ...and nowhere else.
    await expect(authService.login("admin", PASSWORD, false, { clientKey: "203.0.113.9" })).resolves.toMatchObject({
      user: { username: "admin" },
    });
  });

  it("recovering the password lifts every pause on the account, so the new password works", async () => {
    const { codes } = await authService.generateRecoveryCodes(2);
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await expect(authService.login("admin", `wrong${i}`, false, { clientKey: "127.0.0.5" })).rejects.toThrow();
    }
    const recovered = await post("/api/auth/recover-with-code", { code: codes[0], newPassword: "brand-new-pass-1" }, "127.0.0.6");
    expect(recovered.status).toBe(200);
    // The owner was the one who kept failing (a forgotten password): their
    // own address is unpaused too.
    await expect(
      authService.login("admin", "brand-new-pass-1", false, { clientKey: "127.0.0.5" }),
    ).resolves.toMatchObject({ user: { username: "admin" } });
    expect(db.data.users[0].lockedUntil).toBeUndefined();
  });

  it("SSO sign-in is not refused by failed password attempts", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await expect(authService.login("admin", `wrong${i}`)).rejects.toThrow();
    }
    const result = await authService.loginWithExternalIdentity({ issuer: "https://idp.example", subject: "admin-sub" });
    expect(result.linked).toBe(true);
    expect(result.accessToken).toBeTruthy();
  });

  it("a lock left in db.json by an older version no longer refuses the owner", async () => {
    db.data.users[0].failedLoginCount = 3;
    db.data.users[0].lockedUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const result = await authService.login("admin", PASSWORD, false, { clientKey: "127.0.0.7" });
    expect(result.user.username).toBe("admin");
    expect(db.data.users[0].lockedUntil).toBeUndefined();
    expect(db.data.users[0].failedLoginCount).toBeUndefined();
  });
});

describe("AUTHN-4: concurrent guesses can't get past the limit", () => {
  it("of 40 guesses sent at once, only MAX_FAILED_LOGINS reach the password compare, and the right one late in the burst is refused", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    const attempts = [];
    for (let i = 0; i < 40; i++) {
      attempts.push(authService.login("admin", i === 35 ? PASSWORD : `wrong${i}`, false, { clientKey: "192.0.2.10" }));
    }
    const results = await Promise.allSettled(attempts);
    expect(results[35].status).toBe("rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(0);
    const againstRealHash = compare.mock.calls.filter(([, hash]) => hash === passwordHash);
    expect(againstRealHash).toHaveLength(MAX_FAILED_LOGINS);
  });

  it("the right password inside the first MAX_FAILED_LOGINS of a burst still signs in", async () => {
    const attempts = [];
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      attempts.push(
        authService.login("admin", i === MAX_FAILED_LOGINS - 1 ? PASSWORD : `wrong${i}`, false, { clientKey: "192.0.2.11" }),
      );
    }
    const results = await Promise.allSettled(attempts);
    expect(results[MAX_FAILED_LOGINS - 1].status).toBe("fulfilled");
  });
});

// Auth audit 2026-10-08 (#8): POST /change-password compared the current
// password with no limit but the 300-a-minute API limiter, so anyone holding
// a session could guess it about 3 times a second (and confirm a hit by
// sending the guess as the new password too). The check now counts against
// the account's own allowance, the same MAX_FAILED_LOGINS per window as
// sign-in, without touching sign-in from anywhere.
describe("#8: change-password goes through the login pause", () => {
  it("after MAX_FAILED_LOGINS wrong current passwords the right one is refused too, and sign-in is unaffected", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await expect(authService.changePassword("u-admin", `wrong${i}`, "brand-new-pass-1")).rejects.toThrow(
        "Current password is incorrect",
      );
    }
    await expect(authService.changePassword("u-admin", PASSWORD, "brand-new-pass-1")).rejects.toMatchObject({
      code: "CURRENT_PASSWORD_INCORRECT",
    });
    expect(db.data.users[0].password).toBe(passwordHash);

    await expect(authService.login("admin", PASSWORD, false, { clientKey: "203.0.113.20" })).resolves.toMatchObject({
      user: { username: "admin" },
    });
  });

  it("concurrent guesses can't get past the limit either", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    const attempts = [];
    for (let i = 0; i < 30; i++) {
      attempts.push(authService.changePassword("u-admin", `wrong${i}`, "brand-new-pass-1"));
    }
    await Promise.allSettled(attempts);
    expect(compare.mock.calls.filter(([, hash]) => hash === passwordHash)).toHaveLength(MAX_FAILED_LOGINS);
  });

  it("a recovery lifts the pause", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await expect(authService.changePassword("u-admin", `wrong${i}`, "brand-new-pass-1")).rejects.toThrow();
    }
    await authService.resetPassword("recovered-pass-1");
    await expect(authService.changePassword("u-admin", "recovered-pass-1", "brand-new-pass-2")).resolves.toBe(true);
  });
});
