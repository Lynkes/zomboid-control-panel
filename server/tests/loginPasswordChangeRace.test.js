import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

// Auth audit 2026-10-08 (#9): login() compared the password against the hash
// as it was when the ~250ms bcrypt compare started, then minted a session
// and tokens from the user row as it was after. A password change or reset
// landing in between (new hash, tokenGen bumped, sessions cleared) was
// followed by a sign-in with the OLD password getting a session under the
// NEW tokenGen -- in a probe, sign-ins started 350-650 ms into a change kept
// working after it. Same gap in login()/refreshAccessToken() signing their
// tokens only after `await commitNow()`.

const db = { data: { users: [], roles: [] } };
let commitImpl = async () => {};

vi.mock("../database/init.js", () => ({
  getSetting: async () => null,
  setSetting: async () => {},
  getDb: async () => db,
  commitNow: (...args) => commitImpl(...args),
  getRoles: async () => db.data.roles,
  getRoleById: async (id) => db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
  getUsersForRole: async () => [],
}));

const { default: authService, _resetLoginThrottleForTests } = await import("../services/auth.js");

const OLD_PASSWORD = "leaked-password-1";
const NEW_PASSWORD = "fresh-password-2";
let oldHash;
const realCompare = bcrypt.compare;

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const victim = () => db.data.users.find((u) => u.id === "u-victim");

beforeAll(async () => {
  oldHash = await bcrypt.hash(OLD_PASSWORD, 4);
});

beforeEach(() => {
  _resetLoginThrottleForTests();
  commitImpl = async () => {};
  authService.jwtSecret = "login-password-change-race-secret";
  db.data.roles = [
    { id: "role-admin", name: "admin", capabilities: ["users.manage", "roles.manage"], isSeeded: true },
    { id: "role-moderator", name: "moderator", capabilities: ["players.view"], isSeeded: true },
  ];
  db.data.users = [
    { id: "u-owner", username: "owner", role: "admin", roleId: "role-admin", password: oldHash, tokenGen: 0, refreshSessions: [] },
    { id: "u-victim", username: "victim", role: "moderator", roleId: "role-moderator", password: oldHash, tokenGen: 0, refreshSessions: [] },
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Holds login()'s own bcrypt.compare after it has checked the password, and
// says when it got there.
function holdNextCompare() {
  const entered = deferred();
  const release = deferred();
  vi.spyOn(bcrypt, "compare").mockImplementationOnce(async (...args) => {
    const result = await realCompare(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  return { entered: entered.promise, release: release.resolve };
}

// Holds the next commitNow() and says when it got there.
function holdNextCommit() {
  const entered = deferred();
  const release = deferred();
  commitImpl = async () => {
    commitImpl = async () => {};
    entered.resolve();
    await release.promise;
  };
  return { entered: entered.promise, release: release.resolve };
}

describe("a sign-in still being checked when the password changes doesn't survive the change", () => {
  it("login with the old password fails when changePassword lands during its compare, and leaves no session", async () => {
    const held = holdNextCompare();
    const signIn = authService.login("victim", OLD_PASSWORD, true, { clientKey: "198.51.100.1" });
    await held.entered;

    await authService.changePassword("u-victim", OLD_PASSWORD, NEW_PASSWORD);
    held.release();

    await expect(signIn).rejects.toThrow("Invalid username or password");
    expect(victim().refreshSessions).toEqual([]);
  });

  it("the same when a reset (reset token, recovery code) lands during the compare", async () => {
    db.data.users = db.data.users.filter((u) => u.id !== "u-owner");
    victim().role = "admin";
    victim().roleId = "role-admin";
    const held = holdNextCompare();
    const signIn = authService.login("victim", OLD_PASSWORD, true, { clientKey: "198.51.100.2" });
    await held.entered;

    await authService.resetPassword(NEW_PASSWORD);
    held.release();

    await expect(signIn).rejects.toThrow("Invalid username or password");
    expect(victim().refreshSessions).toEqual([]);
  });

  it("the same when the account is deleted during the compare", async () => {
    const held = holdNextCompare();
    const signIn = authService.login("victim", OLD_PASSWORD, true, { clientKey: "198.51.100.3" });
    await held.entered;

    await authService.deleteUser("u-victim", { actingUserId: "u-owner" });
    held.release();

    await expect(signIn).rejects.toThrow("Invalid username or password");
  });

  it("a change landing while login() writes the database leaves its access token dead", async () => {
    const held = holdNextCommit();
    const signIn = authService.login("victim", OLD_PASSWORD, true, { clientKey: "198.51.100.4" });
    await held.entered;

    await authService.changePassword("u-victim", OLD_PASSWORD, NEW_PASSWORD);
    held.release();

    const result = await signIn;
    expect(await authService.authenticateAccessToken(result.accessToken)).toBeNull();
    expect(await authService.refreshAccessToken(result.refreshToken)).toBeNull();
  });

  it("a change landing while a refresh writes the database leaves the refreshed access token dead", async () => {
    const signedIn = await authService.login("victim", OLD_PASSWORD, true, { clientKey: "198.51.100.5" });
    const held = holdNextCommit();
    const refreshing = authService.refreshAccessToken(signedIn.refreshToken);
    await held.entered;

    await authService.changePassword("u-victim", OLD_PASSWORD, NEW_PASSWORD);
    held.release();

    const refreshed = await refreshing;
    expect(await authService.authenticateAccessToken(refreshed.accessToken)).toBeNull();
    expect(await authService.refreshAccessToken(refreshed.refreshToken)).toBeNull();
  });

  it("a sign-in that doesn't overlap a change still works", async () => {
    const result = await authService.login("victim", OLD_PASSWORD, true, { clientKey: "198.51.100.6" });
    expect(await authService.authenticateAccessToken(result.accessToken)).toMatchObject({ userId: "u-victim" });
  });
});
