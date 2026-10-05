import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

// AUTHN-1 (security sweep): while the panel had no account yet, io.use
// admitted any Socket.IO connection with no identity at all, and nothing
// dropped it once first-run setup created the admin and locked the HTTP
// side. The sweep's repro opened a tokenless socket before setup, ran the
// real POST /api/auth/setup, and the socket stayed connected afterwards,
// still in server-status and still receiving every io.emit() broadcast
// (admin chat, deaths, bridge paths) -- while a fresh tokenless socket was
// already refused.
//
// Now: a socket is refused until an account exists (same as every /api
// route but the setup ones), creating the first account drops every
// socket, and subscribe:status needs a user.
//
// socket.io-client lives in client/node_modules, which the server CI job
// doesn't install, so this speaks Engine.IO v4 over `ws` directly: "0{...}"
// open, "40<auth>" connect, "40{sid}" accepted / "44{message}" refused,
// "2"/"3" ping/pong, "42[event,payload]" events.

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
const { io } = await import("../index.js");

const SETUP_TOKEN = "s".repeat(64);
let port;

function connectRawSocket({ token, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.on("error", (error) => (settled ? null : reject(error)));
    ws.on("close", () => settle({ outcome: "closed", ws }));
    ws.on("message", (data) => {
      const packet = data.toString();
      if (packet.startsWith("0")) {
        ws.send(token ? `40${JSON.stringify({ token })}` : "40");
      } else if (packet === "2") {
        ws.send("3");
      } else if (packet.startsWith("40")) {
        settle({ outcome: "connected", ws });
      } else if (packet.startsWith("44")) {
        settle({ outcome: "refused", message: JSON.parse(packet.slice(2)).message, ws });
      } else if (packet.startsWith("42")) {
        const [event, payload] = JSON.parse(packet.slice(2));
        onEvent?.(event, payload);
      }
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  authService.jwtSecret = "presetup-socket-test-secret-".padEnd(64, "x");
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  io.disconnectSockets(true);
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(() => {
  settings.clear();
  settings.set("setupToken", SETUP_TOKEN);
  db.data.roles = [
    { id: "role-admin", name: "admin", capabilities: ["users.manage", "roles.manage", "rcon.execute"], isSeeded: true },
  ];
  db.data.users = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  io.disconnectSockets(true);
});

describe("AUTHN-1: no Socket.IO connection before the first account exists", () => {
  it("refuses a tokenless socket while setup is pending, then the real setup's token works", async () => {
    const before = await connectRawSocket();
    before.ws.close();
    expect(before.outcome).toBe("refused");
    expect(before.message).toBe("First-run setup required");

    const setupRes = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: SETUP_TOKEN, username: "admin", password: "correct-horse-1", panelPort: 3001 }),
    });
    expect(setupRes.status).toBe(201);
    const { accessToken } = await setupRes.json();

    const anonymous = await connectRawSocket();
    anonymous.ws.close();
    expect(anonymous.outcome).toBe("refused");

    const events = [];
    const signedIn = await connectRawSocket({ token: accessToken, onEvent: (event) => events.push(event) });
    expect(signedIn.outcome).toBe("connected");
    signedIn.ws.send('42["subscribe:status"]');
    await wait(100);
    io.to("server-status").emit("server:status", { running: true });
    await wait(100);
    signedIn.ws.close();
    expect(events).toContain("server:status");
  });

  it("creating the first account drops every connected socket", async () => {
    const disconnectAll = vi.spyOn(io, "disconnectSockets");
    await authService.createUser("firstadmin", "correct-horse-1");
    expect(disconnectAll).toHaveBeenCalledWith(true);
  });

  it("bootstrapping the first account from SSO drops every connected socket too", async () => {
    const disconnectAll = vi.spyOn(io, "disconnectSockets");
    await authService.bootstrapAdminFromExternalIdentity({
      issuer: "https://idp.example",
      subject: "first-admin",
      username: "ssoadmin",
      setupToken: SETUP_TOKEN,
    });
    expect(disconnectAll).toHaveBeenCalledWith(true);
  });

  it("a later account does not drop everyone", async () => {
    db.data.users = [{ id: "u-admin", username: "admin", role: "admin", roleId: "role-admin", password: "x" }];
    db.data.roles.push({ id: "role-moderator", name: "moderator", capabilities: [], isSeeded: true });
    const disconnectAll = vi.spyOn(io, "disconnectSockets");
    await authService.createUser("second", "correct-horse-1", "moderator", { actingUserId: "u-admin" });
    expect(disconnectAll).not.toHaveBeenCalled();
  });

  it("subscribe:status does not let a socket with no user into server-status", async () => {
    const [onConnection] = io.sockets.listeners("connection");
    const handlers = {};
    const socket = {
      id: "no-user",
      user: undefined,
      join: vi.fn(),
      leave: vi.fn(),
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };
    onConnection(socket);
    await handlers["subscribe:status"]();
    expect(socket.join).not.toHaveBeenCalled();
  });
});
