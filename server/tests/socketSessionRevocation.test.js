import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import WebSocket from "ws";

// sweep-round2 (2026-09-06, dwight): Socket.IO connections authenticate
// once at handshake (server/index.js's io.use middleware, which calls
// authService.authenticateAccessToken()) and are never re-validated per
// event -- unlike every HTTP request, which re-runs that exact same check
// via authService.middleware() on every single call. Every documented
// session-invalidation path was therefore a no-op for any socket that had
// already completed its handshake: regenerate-jwt-secret's own route
// comment (server/routes/auth.js) promises it "Immediately invalidates
// EVERY existing session -- access and refresh tokens, every user, every
// device", but a socket connected before the regen kept its cached
// socket.user forever and stayed joined to whatever rooms it had already
// joined -- including rcon-live, which the code's own comment says carries
// whitelist passwords. Same gap for password change/reset (tokenGen bump),
// role change, and user deletion. Nothing in the codebase ever called
// disconnectSockets/socket.disconnect/fetchSockets to evict a live socket.
//
// Fix: services/auth.js's revocation paths (regenerateJwtSecret,
// changePassword, resetPassword, changeUserRoleById, deleteUser) now emit
// through a tiny onSessionRevoked() pub/sub (same shape as
// utils/logger.js's onLog), and index.js subscribes with
// evictRevokedSockets(), which calls the real Socket.IO server's
// disconnectSockets(true) -- globally for a secret regen, or scoped to the
// `user:<id>` room every authenticated socket joins on connect for
// everything else (that room membership is index.js's own addition too).
//
// sweep-round3 (2026-09-06): logout() was missing from that list. Every one
// of the original five was found by asking "where does this file
// invalidate a credential" (tokenGen bump, secret rotation, row deletion);
// logout ends a session WITHOUT touching a credential, so that search never
// surfaced it -- and it's the one action a user takes SPECIFICALLY to end
// their session. See logout()'s own doc comment in services/auth.js for the
// scope tradeoff (evicts every socket for that user, not just the one
// device that logged out -- sockets authenticate off the access token,
// which carries no per-device sessionId to target more narrowly).
//
// PRE-FIX BREAK-VERIFY: before this fix, `onSessionRevoked` was not an
// export of services/auth.js and `evictRevokedSockets` was not an export
// of index.js, so this file's imports below fail outright against pre-fix
// code. Patched around that, every assertion here would still fail: calling
// any of the five mutations produced zero observable signal for anything
// downstream to act on -- there was nothing in the codebase that could ever
// learn a revocation had happened and evict a socket for it, which is
// exactly why an already-open socket kept working forever.
//
// VERIFICATION LIMIT: socket.io-client is a client-only dependency (lives
// in client/node_modules, not resolvable from a server-side test), so this
// suite cannot drive a real network client through a real handshake and
// watch it actually get dropped. Instead it exercises the real production
// chain up to the exact boundary that would evict a live socket: real
// authService mutations -> the real onSessionRevoked bus -> the real
// evictRevokedSockets() -> the real (non-listening) Socket.IO `Server`
// instance's own disconnectSockets()/in() methods, spied on rather than
// reimplemented. index.js is never started (`start()` is gated behind
// `!process.env.VITEST`, which vitest sets automatically) -- only its
// module-level Socket.IO wiring runs.

const ADMIN_ROLE = {
  id: "role-admin",
  name: "admin",
  capabilities: ["users.manage", "roles.manage", "server.control"],
  isSeeded: true,
};
const TECHNICIAN_ROLE = {
  id: "role-technician",
  name: "technician",
  capabilities: ["server.control", "backups.manage"],
  isSeeded: true,
};

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
  // index.js's own boot sequence wires this into lifecycleCoordinator.js's
  // setServerDisplayNameResolver() unconditionally at module scope --
  // referencing it here even without calling it is enough to throw against
  // an incomplete mock.
  peekServerDisplayName: () => null,
}));

// Importing both from the SAME test file's module graph means this
// `authService` reference and the one index.js holds internally are the
// identical singleton -- index.js's own `onSessionRevoked(evictRevokedSockets)`
// call (made once, at its import time below) registers against the exact
// callback array these tests' authService calls fire into. This is the real
// wiring, not a reimplementation of it.
const { default: authService } = await import("../services/auth.js");
const { io, evictRevokedSockets } = await import("../index.js");

function resetWith({ roles = [], users = [] }) {
  settings.clear();
  db.data.roles = roles.map((r) => ({ ...r }));
  db.data.users = users.map((u) => ({ ...u }));
}

describe("Socket eviction wiring: real authService revocation calls reach the real Socket.IO server", () => {
  let disconnectSocketsSpy;
  let roomDisconnectSpy;
  let inSpy;

  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE],
      users: [
        {
          id: "u-tech",
          username: "tech",
          role: "technician",
          roleId: "role-technician",
          tokenGen: 0,
          password: bcrypt.hashSync("currentpw", 4),
        },
      ],
    });
    authService.jwtSecret = "test-socket-revocation-secret";

    disconnectSocketsSpy = vi
      .spyOn(io, "disconnectSockets")
      .mockImplementation(() => {});
    roomDisconnectSpy = vi.fn();
    inSpy = vi.spyOn(io, "in").mockReturnValue({ disconnectSockets: roomDisconnectSpy });
  });

  afterEach(() => {
    disconnectSocketsSpy.mockRestore();
    inSpy.mockRestore();
  });

  it("changePassword() evicts only that user's live sockets, by their own user:<id> room, not everyone's", async () => {
    await authService.changePassword("u-tech", "currentpw", "brandnewpassword1");

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("resetPassword() evicts the reset user's live sockets", async () => {
    // No admin user seeded in this db -- resetPassword() falls through to
    // users[0], which is u-tech.
    await authService.resetPassword("anotherbrandnewpw1");

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("changeUserRoleById() evicts the promoted/demoted user's live sockets", async () => {
    await authService.changeUserRoleById("u-tech", "role-admin");

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("deleteUser() evicts the deleted user's live sockets", async () => {
    await authService.deleteUser("u-tech", { actingUserId: "someone-else" });

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("regenerateJwtSecret() evicts EVERY live socket globally, not a single user's room -- matches its own route comment's 'every user, every device' claim", async () => {
    await authService.regenerateJwtSecret();

    expect(disconnectSocketsSpy).toHaveBeenCalledWith(true);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it("a read that isn't a revocation path (getUsers) evicts nothing -- the wiring doesn't fire on every auth.js call", async () => {
    await authService.getUsers();

    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
    expect(inSpy).not.toHaveBeenCalled();
  });

  it("logout() evicts that user's live sockets too -- sweep-round3: the sixth trigger, found by asking 'what ENDS a session' instead of 'what invalidates a credential'", async () => {
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);

    await authService.logout(refreshToken);

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("a logout() call that revokes nothing (invalid token) evicts nothing -- no false eviction from a no-op", async () => {
    await authService.logout("not-a-real-token");

    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
    expect(inSpy).not.toHaveBeenCalled();
  });
});

describe("evictRevokedSockets() fails safe on a malformed or unrecognized event", () => {
  let disconnectSocketsSpy;
  let inSpy;

  beforeEach(() => {
    disconnectSocketsSpy = vi
      .spyOn(io, "disconnectSockets")
      .mockImplementation(() => {});
    inSpy = vi.spyOn(io, "in").mockReturnValue({ disconnectSockets: vi.fn() });
  });

  afterEach(() => {
    disconnectSocketsSpy.mockRestore();
    inSpy.mockRestore();
  });

  it("does nothing for an unrecognized scope", () => {
    expect(() => evictRevokedSockets({ scope: "not-a-real-scope" })).not.toThrow();
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
    expect(inSpy).not.toHaveBeenCalled();
  });

  it("does nothing for scope:'user' with no userId -- refuses to guess a room to evict", () => {
    expect(() => evictRevokedSockets({ scope: "user" })).not.toThrow();
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
    expect(inSpy).not.toHaveBeenCalled();
  });
});

// Auth audit 2026-10-08, #11: the token was checked once, at the handshake,
// and nothing looked at its expiry again. A socket opened with a briefly
// valid token (a ?token= from a proxy log, one copied before sign-out)
// stayed in rcon-live, logs and players until a revocation or a restart.
// Now the transport is closed when the token expires (not disconnect(true),
// so the real client reconnects with a refreshed token), and a reconnect
// with the same token is refused. Spoken over `ws` directly, like
// presetupSocketRefused.test.js: socket.io-client lives in client/.
describe("a live socket ends when its access token expires", () => {
  let port;

  function connectRawSocket(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
      const conn = { ws, events: [], closed: false };
      conn.closedPromise = new Promise((resolveClosed) => {
        ws.on("close", () => {
          conn.closed = true;
          resolveClosed();
        });
      });
      let settled = false;
      const settle = (outcome, message) => {
        if (settled) return;
        settled = true;
        resolve({ ws, outcome, message, conn });
      };
      ws.on("error", (error) => (settled ? null : reject(error)));
      ws.on("close", () => settle("closed"));
      ws.on("message", (data) => {
        const packet = data.toString();
        if (packet.startsWith("0")) {
          ws.send(`40${JSON.stringify({ token })}`);
        } else if (packet === "2") {
          ws.send("3");
        } else if (packet.startsWith("40")) {
          settle("connected");
        } else if (packet.startsWith("44")) {
          settle("refused", JSON.parse(packet.slice(2)).message);
        } else if (packet.startsWith("42")) {
          conn.events.push(JSON.parse(packet.slice(2))[0]);
        }
      });
    });
  }

  function shortLivedToken(seconds) {
    const user = db.data.users[0];
    return jwt.sign(
      { userId: user.id, username: user.username, role: user.role, tokenGen: 0 },
      authService.jwtSecret,
      { algorithm: "HS256", expiresIn: seconds },
    );
  }

  beforeAll(async () => {
    await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
    port = io.httpServer.address().port;
  });

  afterAll(async () => {
    io.disconnectSockets(true);
    await new Promise((resolve) => io.httpServer.close(resolve));
  });

  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE],
      users: [{ id: "u-admin", username: "admin", role: "admin", roleId: "role-admin", tokenGen: 0, password: "x" }],
    });
    authService.jwtSecret = "test-socket-expiry-secret-".padEnd(64, "x");
  });

  it("closes a socket opened with a 2-second token once it expires, and refuses that token again", async () => {
    const token = shortLivedToken(2);
    const first = await connectRawSocket(token);
    expect(first.outcome).toBe("connected");

    await Promise.race([first.conn.closedPromise, new Promise((resolve) => setTimeout(resolve, 4000))]);
    expect(first.conn.closed).toBe(true);
    expect(first.conn.events).toContain("auth:token-expired");

    const again = await connectRawSocket(token);
    again.ws.close();
    expect(again.outcome).toBe("refused");
    expect(again.message).toBe("Invalid or expired token");
  }, 15000);

  it("leaves a socket with time left on its token open", async () => {
    const live = await connectRawSocket(shortLivedToken(60));
    expect(live.outcome).toBe("connected");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(live.conn.closed).toBe(false);
    live.ws.close();
  });
});
