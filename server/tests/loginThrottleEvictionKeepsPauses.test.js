import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

// Security sweep 2026-10-04, adversary pass on LOCKOUT: failed sign-ins are
// counted per (account, client address) in a table capped at 10000 entries.
// Once it was full, pruneLoginThrottle() dropped the oldest entries with
// nothing in flight -- paused ones included. An attacker with about
// 10000 / (number of accounts) addresses could cycle them so each paused
// address got a fresh count: roughly loginLimiter's 5 guesses a minute per
// address instead of 10 per 15 minutes.
//
// Fix: only stale entries are dropped. While the table is still full, an
// address with no entry of its own shares the account's overflow entry, so
// all of them together get MAX_FAILED_LOGINS per window.
//
// The table is shrunk to a few entries through the test hook, so filling it
// doesn't take 10000 logins.

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
const { default: authService, _resetLoginThrottleForTests, _setLoginThrottleCapacityForTests } =
  authModule;
const MAX_FAILED_LOGINS = 10;
const CAPACITY = 4;
const PASSWORD = "correct-horse-1";

const signIn = (password, clientKey) =>
  authService.login("admin", password, false, { clientKey });

async function fail(clientKey, times = 1) {
  for (let i = 0; i < times; i++) {
    await expect(signIn(`wrong-${clientKey}-${i}`, clientKey)).rejects.toThrow(
      "Invalid username or password",
    );
  }
}

beforeAll(async () => {
  authService.jwtSecret = "throttle-eviction-secret-".padEnd(64, "x");
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage"], isSeeded: true }];
  db.data.users = [
    {
      id: "u-admin",
      username: "admin",
      role: "admin",
      roleId: "role-admin",
      password: await bcrypt.hash(PASSWORD, 4),
      tokenGen: 0,
      refreshSessions: [],
    },
  ];
});

beforeEach(() => {
  _resetLoginThrottleForTests();
  _setLoginThrottleCapacityForTests(CAPACITY);
});

afterAll(() => {
  _resetLoginThrottleForTests();
});

describe("a full sign-in throttle never forgets a pause", () => {
  it("a paused address stays paused while other addresses churn through the table", async () => {
    await fail("198.51.100.1", MAX_FAILED_LOGINS);
    // Paused.
    await expect(signIn(PASSWORD, "198.51.100.1")).rejects.toThrow("Invalid username or password");

    // Enough other addresses to fill the table several times over.
    for (let i = 2; i < 2 + CAPACITY * 3; i++) await fail(`198.51.100.${i}`);

    // Still paused, even with the right password.
    await expect(signIn(PASSWORD, "198.51.100.1")).rejects.toThrow("Invalid username or password");
  });

  it("new addresses beyond the table's room share one count for the account", async () => {
    // Fill the table with addresses that each have a recent failure.
    for (let i = 1; i <= CAPACITY; i++) await fail(`203.0.113.${i}`);

    // MAX_FAILED_LOGINS guesses spread over that many fresh addresses...
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await fail(`192.0.2.${i + 1}`);

    // ...use up the shared count, so the next fresh address is refused too.
    await expect(signIn(PASSWORD, "192.0.2.200")).rejects.toThrow("Invalid username or password");
    // An address that already had its own entry is not affected.
    await expect(signIn(PASSWORD, "203.0.113.1")).resolves.toMatchObject({
      user: { username: "admin" },
    });
  });
});
