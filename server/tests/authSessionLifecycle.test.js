import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

// sweep-round3 (2026-09-06, dwight): auth-session lens beyond sockets. Two
// questions god asked to be proven empirically rather than settled by
// reading the code, because "the code can look correct either way":
//
//   1. Refresh-token replay: does redeeming a refresh token invalidate the
//      one that was redeemed, or can the SAME token be replayed to mint a
//      second, independent session? If rotation doesn't actually invalidate
//      the old token, a token captured once (XSS, a synced browser profile,
//      a leaked log line) works indefinitely with nothing in the UI ever
//      showing it.
//   2. Does logout emit onSessionRevoked (services/auth.js, built for
//      c0017c7b's socket-eviction fix)? Confirmed by reading first: it does
//      not. A socket opened before logout keeps its rooms -- including
//      rcon-live, which carries RCON whitelist passwords -- because the
//      only thing that currently tears it down is the WEB CLIENT'S OWN
//      cleanup effect (client/src/App.tsx, `createdSocket?.close()` in the
//      socket useEffect's cleanup, keyed on `isAuthenticated`), not
//      anything server-enforced. Every one of the five triggers this bus
//      already covers (secret regen, password change/reset, role change,
//      delete) works regardless of what the client does; logout is the one
//      action that currently doesn't, and it's the one action a user takes
//      SPECIFICALLY to end their session.

const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id) =>
    db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) =>
    db.data.roles.find((r) => r.name === name) || null,
  getUsersForRole: async (role) =>
    db.data.users.filter(
      (u) => u.roleId === role.id || (role.isSeeded && u.role === role.name),
    ),
}));

const { default: authService, onSessionRevoked } = await import(
  "../services/auth.js"
);

const TECHNICIAN_ROLE = {
  id: "role-technician",
  name: "technician",
  capabilities: ["server.control", "rcon.execute"],
  isSeeded: true,
};

function resetWith({ roles = [], users = [] }) {
  settings.clear();
  db.data.roles = roles.map((r) => ({ ...r }));
  db.data.users = users.map((u) => ({ ...u }));
}

describe("Refresh-token replay: redeeming a token must invalidate it, proven empirically", () => {
  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 },
      ],
    });
    authService.jwtSecret = "test-replay-secret";
  });

  it("the SAME refresh token cannot be redeemed twice -- the second attempt is refused, not treated as a fresh, independent session", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const originalRefreshToken = authService.generateRefreshToken(user, session.id);

    // First redemption: exactly what POST /api/auth/refresh does with a
    // legitimate, not-yet-used token.
    const first = await authService.refreshAccessToken(originalRefreshToken);
    expect(first).not.toBeNull();
    expect(first.accessToken).toBeTruthy();
    expect(first.refreshToken).toBeTruthy();
    expect(first.refreshToken).not.toBe(originalRefreshToken);

    // Second redemption of the EXACT SAME (now-stale) token -- the replay
    // attempt. If rotation is real, this must fail: the session it pointed
    // at no longer exists (it was revoked and replaced during the first
    // redemption above).
    const replay = await authService.refreshAccessToken(originalRefreshToken);
    // Refused either way: within REFRESH_RACE_GRACE_MS as a lost race
    // between two tabs (2026-10-08, #19), later as reuse (#10, below).
    expect(replay?.accessToken).toBeUndefined();
    expect(replay).toEqual({ refreshFailureReason: "race" });
  });

  it("the NEW token issued by rotation keeps working where the old one is dead -- proves rotation issues a real, usable replacement, not just revocation", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const originalRefreshToken = authService.generateRefreshToken(user, session.id);

    const first = await authService.refreshAccessToken(originalRefreshToken);
    const second = await authService.refreshAccessToken(first.refreshToken);

    expect(second).not.toBeNull();
    expect(second.accessToken).toBeTruthy();
  });

  it("two concurrent redemptions of the same token: exactly one succeeds, the other is refused -- no double-issuance from a race", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const originalRefreshToken = authService.generateRefreshToken(user, session.id);

    const [a, b] = await Promise.all([
      authService.refreshAccessToken(originalRefreshToken),
      authService.refreshAccessToken(originalRefreshToken),
    ]);

    const results = [a, b];
    const succeeded = results.filter((r) => r?.accessToken);
    const failed = results.filter((r) => !r?.accessToken);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
  });
});

describe("logout() and the session-revocation bus (onSessionRevoked)", () => {
  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 },
      ],
    });
    authService.jwtSecret = "test-logout-secret";
  });

  it("logout() DOES emit onSessionRevoked for the logging-out user when it actually revokes a session", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);

    const events = [];
    const unsubscribe = onSessionRevoked((event) => events.push(event));
    try {
      const result = await authService.logout(refreshToken);
      expect(result).toBe(true);
      expect(events).toEqual([{ scope: "user", userId: "u-tech" }]);
    } finally {
      unsubscribe();
    }
  });

  it("logout() does NOT emit onSessionRevoked when there was nothing to revoke (invalid/already-used token) -- no false eviction from a no-op call", async () => {
    const events = [];
    const unsubscribe = onSessionRevoked((event) => events.push(event));
    try {
      const result = await authService.logout("not-a-real-token");
      expect(result).toBe(false);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("the logged-out session's refresh token is genuinely dead afterward (not just an event with no effect)", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);

    await authService.logout(refreshToken);

    const afterLogout = await authService.refreshAccessToken(refreshToken);
    expect(afterLogout).toBeNull();
  });
});

// sweep-round4 (2026-09-07, dwight): god's ruling on the MAX_REFRESH_SESSIONS
// silent-eviction observation -- build a tombstone, not a heuristic, because
// findRefreshSession() returning null carries no reason and guessing one is
// worse than the silence we have today: a false "just capacity" told to a
// genuinely compromised user is a false all-clear. createRefreshSession() is
// the ONLY site that knows *why* it dropped a session, so it's the only site
// that records a reason -- and only "capacity", never the security ones
// (expired/revoked/forged), which must stay identical to each other on
// purpose (telling a forged-token holder "that one was real once" is a gift).
//
// PRE-FIX BREAK-VERIFY: before this fix, `refreshAccessToken` returned a bare
// `null` for a capacity-evicted session's token, byte-identical to what it
// returns for a forged one -- the first test below would have received
// `null` instead of `{ refreshFailureReason: "capacity" }` and failed.
describe("MAX_REFRESH_SESSIONS capacity eviction: a tombstone, not a guess", () => {
  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 },
      ],
    });
    authService.jwtSecret = "test-capacity-secret";
  });

  it("the refresh token of a session evicted purely for capacity gets a distinct reason, not the generic null", async () => {
    const user = db.data.users[0];

    // MAX_REFRESH_SESSIONS is 5 (services/auth.js) -- the oldest survives
    // exactly 5 concurrent sessions and is evicted by the 6th.
    const oldestSession = authService.createRefreshSession(user);
    const oldestRefreshToken = authService.generateRefreshToken(user, oldestSession.id);
    for (let i = 0; i < 4; i += 1) {
      authService.createRefreshSession(user);
    }
    expect(user.refreshSessions).toHaveLength(5);
    expect(user.refreshSessions.some((s) => s.id === oldestSession.id)).toBe(true);

    // The 6th session pushes the oldest out.
    authService.createRefreshSession(user);
    expect(user.refreshSessions).toHaveLength(5);
    expect(user.refreshSessions.some((s) => s.id === oldestSession.id)).toBe(false);

    const result = await authService.refreshAccessToken(oldestRefreshToken);
    expect(result).toEqual({ refreshFailureReason: "capacity" });
  });

  it("a genuinely forged token (never a real session) still gets the plain, uninformative null -- the half that matters", async () => {
    const user = db.data.users[0];
    // Same shape as a real refresh token, but for a sessionId that was never
    // created -- indistinguishable, from the outside, from a stolen and
    // guessed id.
    const forgedToken = authService.generateRefreshToken(user, "session-that-never-existed");

    const result = await authService.refreshAccessToken(forgedToken);
    expect(result).toBeNull();
  });

  it("a session revoked by logout (a security reason) still gets the plain null, not the capacity reason -- the two must not be confusable", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);

    await authService.logout(refreshToken);

    const result = await authService.refreshAccessToken(refreshToken);
    expect(result).toBeNull();
  });

  it("tombstone storage is bounded -- churning sessions well past MAX_REFRESH_SESSIONS does not grow evictedRefreshSessions without limit", async () => {
    const user = db.data.users[0];
    for (let i = 0; i < 20; i += 1) {
      authService.createRefreshSession(user);
      authService.createRefreshSession(user, { persistent: false });
    }
    // One cap's worth per kind (#21).
    expect(user.evictedRefreshSessions.length).toBeLessThanOrEqual(10);
  });

  it("a tombstone does not outlive the token it describes -- it is pruned once that token's own expiresAt has passed", async () => {
    const user = db.data.users[0];
    authService.createRefreshSession(user);
    for (let i = 0; i < 5; i += 1) {
      authService.createRefreshSession(user);
    }
    expect(user.evictedRefreshSessions).toHaveLength(1);
    const [tombstone] = user.evictedRefreshSessions;

    // Simulate that tombstone's own describes-a-token expiry having already
    // passed, the same way an already-expired refreshSessions entry would be
    // pruned by ensureUserAuthState.
    tombstone.expiresAt = new Date(Date.now() - 1000).toISOString();

    const reason = authService.findCapacityEvictionReason(user, tombstone.id);
    expect(reason).toBeNull();
    expect(user.evictedRefreshSessions).toHaveLength(0);
  });
});

// Auth audit 2026-10-08 (#10, #19, #21): refresh sessions slid forever (each
// rotation started a fresh 30 days), a replaced token sent again was just
// refused with no reuse detection, two tabs refreshing at once signed the
// loser out (and its cookie clear could wipe the winner's), nothing could
// sign one user out everywhere, and "Keep me signed in" unticked meant no
// refresh session at all -- a hard sign-out 15 minutes after sign-in.
const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = "lifecycle-pass-1";
let passwordHash;

function route(routePath) {
  return async (req) => {
    const { default: router } = await import("../routes/auth.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === routePath && entry.route.methods.post,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { statusCode: 200, body: null, cookies: [], cleared: [] };
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload) => {
      res.body = payload;
      return res;
    };
    res.cookie = (name, value, options) => {
      res.cookies.push({ name, value, options });
      return res;
    };
    res.clearCookie = (name, options) => {
      res.cleared.push({ name, options });
      return res;
    };
    await handler({ headers: {}, cookies: {}, body: {}, socket: {}, ...req }, res);
    return res;
  };
}

describe("refresh session lifecycle (#10, #19, #21)", () => {
  beforeAll(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 4);
  });

  beforeEach(() => {
    resetWith({
      roles: [TECHNICIAN_ROLE],
      users: [
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", password: passwordHash, tokenGen: 0 },
      ],
    });
    authService.jwtSecret = "test-lifecycle-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#10: a session refreshed again and again still ends 30 days after sign-in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const signedIn = await authService.login("tech", PASSWORD, true);

    let token = signedIn.refreshToken;
    for (const day of [10, 20, 29]) {
      vi.setSystemTime(start + day * DAY);
      const refreshed = await authService.refreshAccessToken(token);
      expect(refreshed?.accessToken).toBeTruthy();
      token = refreshed.refreshToken;
    }

    vi.setSystemTime(start + 31 * DAY);
    expect(await authService.refreshAccessToken(token)).toBeNull();
  });

  it("#10: the refresh cookie ends with the session, not 30 days after each refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const signedIn = await authService.login("tech", PASSWORD, true);

    vi.setSystemTime(start + 25 * DAY);
    const res = await route("/refresh")({ cookies: { refreshToken: signedIn.refreshToken } });

    expect(res.statusCode).toBe(200);
    const [cookie] = res.cookies;
    expect(cookie.options.maxAge).toBeGreaterThan(4 * DAY);
    expect(cookie.options.maxAge).toBeLessThanOrEqual(5 * DAY);
  });

  it("#10: a replaced token sent again after the grace window signs the account out everywhere", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const user = db.data.users[0];
    const deviceA = await authService.login("tech", PASSWORD, true);
    const deviceB = await authService.login("tech", PASSWORD, true);
    const rotatedA = await authService.refreshAccessToken(deviceA.refreshToken);
    expect(rotatedA?.accessToken).toBeTruthy();

    vi.setSystemTime(Date.now() + 31 * 1000);
    const events = [];
    const unsubscribe = onSessionRevoked((event) => events.push(event));
    try {
      expect(await authService.refreshAccessToken(deviceA.refreshToken)).toBeNull();
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([{ scope: "user", userId: "u-tech" }]);
    expect(user.refreshSessions).toEqual([]);
    expect(user.tokenGen).toBe(1);
    expect(await authService.refreshAccessToken(rotatedA.refreshToken)).toBeNull();
    expect(await authService.refreshAccessToken(deviceB.refreshToken)).toBeNull();
    expect(await authService.authenticateAccessToken(deviceB.accessToken)).toBeNull();
  });

  it("#19: two refreshes with one cookie give one 200 and one REFRESH_RACE that leaves the cookie alone", async () => {
    const signedIn = await authService.login("tech", PASSWORD, true);
    const refresh = route("/refresh");

    const [a, b] = await Promise.all([
      refresh({ cookies: { refreshToken: signedIn.refreshToken } }),
      refresh({ cookies: { refreshToken: signedIn.refreshToken } }),
    ]);

    const winner = [a, b].find((res) => res.statusCode === 200);
    const loser = [a, b].find((res) => res.statusCode !== 200);
    expect(winner.body.accessToken).toBeTruthy();
    expect(winner.cookies).toHaveLength(1);
    expect(loser.statusCode).toBe(401);
    expect(loser.body.code).toBe("REFRESH_RACE");
    expect(loser.cleared).toEqual([]);
    expect(loser.cookies).toEqual([]);
    // Not counted as reuse: the winner's new token still works.
    expect((await authService.refreshAccessToken(winner.cookies[0].value))?.accessToken).toBeTruthy();
    expect(db.data.users[0].tokenGen).toBe(0);
  });

  it("#21: signing in without Keep me signed in sets a browser-session cookie, and /refresh works", async () => {
    const signedIn = await route("/login")({ body: { username: "tech", password: PASSWORD, rememberMe: false } });

    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.cookies).toHaveLength(1);
    expect(signedIn.cookies[0].options).not.toHaveProperty("maxAge");

    const refreshed = await route("/refresh")({ cookies: { refreshToken: signedIn.cookies[0].value } });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    expect(refreshed.cookies[0].options).not.toHaveProperty("maxAge");
  });

  it("#21: a browser session ends 12 hours after sign-in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const signedIn = await authService.login("tech", PASSWORD, false);

    vi.setSystemTime(start + 11 * 60 * 60 * 1000);
    const refreshed = await authService.refreshAccessToken(signedIn.refreshToken);
    expect(refreshed?.accessToken).toBeTruthy();

    vi.setSystemTime(start + 13 * 60 * 60 * 1000);
    expect(await authService.refreshAccessToken(refreshed.refreshToken)).toBeNull();
  });

  // Each kind has its own MAX_REFRESH_SESSIONS (5). A shared cap let a
  // single browser-session sign-in -- and the browser extension signs in that
  // way every time its access token runs out -- push out the oldest
  // remembered device once the account had five.
  async function signIn(count, rememberMe) {
    const results = [];
    for (let i = 0; i < count; i += 1) {
      results.push(await authService.login("tech", PASSWORD, rememberMe));
    }
    return results;
  }
  const refreshes = async (signedIn) => Boolean((await authService.refreshAccessToken(signedIn.refreshToken))?.accessToken);

  it("#21: a browser sign-in doesn't evict any of five remembered devices", async () => {
    const remembered = await signIn(5, true);
    const [browserOnly] = await signIn(1, false);

    expect(db.data.users[0].refreshSessions).toHaveLength(6);
    expect(db.data.users[0].evictedRefreshSessions).toEqual([]);
    for (const signedIn of [...remembered, browserOnly]) {
      expect(await refreshes(signedIn)).toBe(true);
    }
  });

  it("#21: remembered sign-ins don't evict a browser session", async () => {
    const [browserOnly] = await signIn(1, false);
    const remembered = await signIn(6, true);

    expect(await refreshes(browserOnly)).toBe(true);
    expect(await authService.refreshAccessToken(remembered[0].refreshToken)).toEqual({
      refreshFailureReason: "capacity",
    });
  });

  it("#21: a sixth browser sign-in evicts only the oldest browser session", async () => {
    const [rememberedDevice] = await signIn(1, true);
    const browserOnly = await signIn(6, false);

    const sessions = db.data.users[0].refreshSessions;
    expect(sessions.filter((session) => session.persistent)).toHaveLength(1);
    expect(sessions.filter((session) => !session.persistent)).toHaveLength(5);
    expect(await authService.refreshAccessToken(browserOnly[0].refreshToken)).toEqual({
      refreshFailureReason: "capacity",
    });
    expect(await refreshes(browserOnly[1])).toBe(true);
    expect(await refreshes(rememberedDevice)).toBe(true);
  });

  it("#21: a stored list over the cap is trimmed per kind, newest kept, order unchanged", () => {
    const user = db.data.users[0];
    const expiresAt = new Date(Date.now() + DAY).toISOString();
    user.refreshSessions = Array.from({ length: 14 }, (_, i) => ({
      id: `s${i}`,
      expiresAt,
      persistent: i % 2 === 0,
    }));

    authService.ensureUserAuthState(user);

    expect(user.refreshSessions.map((session) => session.id)).toEqual([
      "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13",
    ]);
  });
});

describe("signing an account out everywhere (#10)", () => {
  const ADMIN_ROLE = {
    id: "role-admin",
    name: "admin",
    capabilities: ["users.manage", "roles.manage", "server.control", "rcon.execute"],
    isSeeded: true,
  };
  const SUPPORT_ROLE = { id: "role-support", name: "support", capabilities: ["users.manage"] };

  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE, SUPPORT_ROLE],
      users: [
        { id: "u-admin", username: "admin", role: "admin", roleId: "role-admin", tokenGen: 0 },
        { id: "u-tech", username: "tech", role: "technician", roleId: "role-technician", tokenGen: 0 },
        { id: "u-support", username: "support", role: "support", roleId: "role-support", tokenGen: 0 },
      ],
    });
    authService.jwtSecret = "test-revoke-all-secret";
  });

  it("POST /sessions/revoke-all ends every session of the caller's account and clears the cookie", async () => {
    const user = db.data.users.find((u) => u.id === "u-tech");
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);
    const accessToken = authService.generateAccessToken(user);
    const events = [];
    const unsubscribe = onSessionRevoked((event) => events.push(event));
    let res;
    try {
      res = await route("/sessions/revoke-all")({ headers: { authorization: `Bearer ${accessToken}` } });
    } finally {
      unsubscribe();
    }

    expect(res.statusCode).toBe(200);
    expect(res.cleared.map((c) => c.name)).toEqual(["refreshToken"]);
    expect(events).toEqual([{ scope: "user", userId: "u-tech" }]);
    expect(await authService.refreshAccessToken(refreshToken)).toBeNull();
    expect(await authService.authenticateAccessToken(accessToken)).toBeNull();
  });

  it("an admin can sign another account out", async () => {
    const tech = db.data.users.find((u) => u.id === "u-tech");
    const session = authService.createRefreshSession(tech);
    const refreshToken = authService.generateRefreshToken(tech, session.id);

    await authService.revokeAllSessions("u-tech", { actingUserId: "u-admin" });

    expect(await authService.refreshAccessToken(refreshToken)).toBeNull();
    expect(tech.tokenGen).toBe(1);
  });

  it("a users.manage delegate can't sign out an account that holds more than it does", async () => {
    await expect(
      authService.revokeAllSessions("u-admin", { actingUserId: "u-support" }),
    ).rejects.toMatchObject({ code: "ROLE_TARGET_EXCEEDS_CALLER_CAPABILITIES", status: 403 });
    expect(db.data.users.find((u) => u.id === "u-admin").tokenGen).toBe(0);
  });
});
