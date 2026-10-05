import { describe, expect, it, vi } from "vitest";

// security audit M1 follow-ups: what the panel broadcasts over Socket.IO,
// and to whom. Each helper here replaced an inline io.emit() that sent
// privileged data to every signed-in socket regardless of role.
const { getRoleByNameMock } = vi.hoisted(() => ({ getRoleByNameMock: vi.fn() }));

vi.mock("../database/init.js", () => ({
  getRoleByName: getRoleByNameMock,
  getDb: vi.fn(async () => ({ data: {} })),
  peekServerDisplayName: vi.fn(() => null),
}));

const {
  publicModStatusView,
  isPublicChatMessage,
  createChatBroadcaster,
  emitToCapabilities,
  PRIVATE_CHAT_CAPABILITIES,
} = await import("../index.js");
const { DEFAULT_ROLE_CAPABILITIES } = await import("../services/permissions.js");

describe("publicModStatusView() — allow-list, not delete-list", () => {
  it("keeps only the fields the dashboard/bridge badges read", () => {
    const view = publicModStatusView({
      alive: true,
      version: "1.2.3",
      serverName: "MyServer",
      playerCount: 2,
      timestamp: 123,
      players: ["alice", "bob"],
      path: "/home/pz/Zomboid/Lua/panelbridge/MyServer",
      filePath: "/opt/panel/data/cache/status.json",
      age: 10,
    });
    expect(view).toEqual({ alive: true, version: "1.2.3", serverName: "MyServer", playerCount: 2, timestamp: 123 });
  });

  it("drops lastPath and error text from the disconnected status (they carry host paths)", () => {
    const view = publicModStatusView({
      alive: false,
      error: "Parse error: EACCES: permission denied, open '/srv/secret/status.json'",
      lastPath: "/srv/secret",
      consecutiveFailures: 3,
      players: [],
    });
    expect(view).toEqual({ alive: false });
    expect(JSON.stringify(view)).not.toContain("/srv/secret");
  });

  it("never forwards a field it does not know, so a new modStatus field cannot leak by default", () => {
    expect(publicModStatusView({ alive: true, someFutureHostPath: "/x" })).toEqual({ alive: true });
  });
});

describe("isPublicChatMessage()", () => {
  it("treats ordinary in-game rooms as public", () => {
    for (const sourceChatType of ["Local", "Shout", "Say", "General", "Server Alert", "Server chat"]) {
      expect(isPublicChatMessage({ type: "general", sourceChatType })).toBe(true);
    }
    // Older log formats carry no room title at all.
    expect(isPublicChatMessage({ type: "general" })).toBe(true);
  });

  it("restricts admin chat and every unlisted room (faction, safehouse, radio, whispers)", () => {
    expect(isPublicChatMessage({ type: "admin", sourceChatType: "Admin chat" })).toBe(false);
    expect(isPublicChatMessage({ type: "admin" })).toBe(false);
    for (const sourceChatType of ["Faction", "Safehouse", "Radio", "Private", "Something New"]) {
      expect(isPublicChatMessage({ type: "general", sourceChatType })).toBe(false);
    }
  });

  it("restricted chat reaches every built-in role with in-game moderation authority", () => {
    // Gating on rcon.execute instead silently cut the moderator role off
    // from the admin chat it exists to take part in.
    for (const role of ["admin", "technician", "moderator"]) {
      expect(
        PRIVATE_CHAT_CAPABILITIES.some((c) => DEFAULT_ROLE_CAPABILITIES[role].includes(c)),
      ).toBe(true);
    }
  });
});

describe("createChatBroadcaster() — log order is preserved", () => {
  it("does not let a public line overtake a restricted line still resolving recipients", async () => {
    const delivered = [];
    const broadcast = createChatBroadcaster({
      emitPublic: (p) => delivered.push(p.id),
      emitRestricted: async (p) => {
        await new Promise((r) => setTimeout(r, 20)); // slow role lookups
        delivered.push(p.id);
      },
    });
    broadcast({ type: "general", sourceChatType: "General" }, { id: "A" });
    broadcast({ type: "admin" }, { id: "B" });
    await broadcast({ type: "general", sourceChatType: "General" }, { id: "C" });
    expect(delivered).toEqual(["A", "B", "C"]);
  });

  it("keeps delivering after one send fails", async () => {
    const delivered = [];
    const onError = vi.fn();
    const broadcast = createChatBroadcaster({
      emitPublic: (p) => delivered.push(p.id),
      emitRestricted: async () => {
        throw new Error("boom");
      },
      onError,
    });
    broadcast({ type: "admin" }, { id: "B" });
    await broadcast({ type: "general" }, { id: "C" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["C"]);
  });
});

describe("emitToCapabilities()", () => {
  const fakeSocket = (user) => ({ user, emit: vi.fn() });
  const fakeServer = (sockets) => ({ sockets: { sockets: new Map(sockets.map((s, i) => [String(i), s])) } });

  it("emits only to sockets whose role holds one of the capabilities, and fails closed", async () => {
    getRoleByNameMock.mockReset();
    getRoleByNameMock.mockImplementation(async (name) => {
      if (name === "mod") return { capabilities: ["players.view"] };
      if (name === "viewer") return { capabilities: ["server.view"] };
      if (name === "broken") throw new Error("db down");
      return null;
    });
    const mod = fakeSocket({ role: "mod" });
    const mod2 = fakeSocket({ role: "mod" });
    const viewer = fakeSocket({ role: "viewer" });
    const broken = fakeSocket({ role: "broken" });
    const deleted = fakeSocket({ role: "deleted-role" });
    const anonymous = fakeSocket(undefined);

    await emitToCapabilities(["players.view"], "evt", { x: 1 }, fakeServer([mod, mod2, viewer, broken, deleted, anonymous]));

    expect(mod.emit).toHaveBeenCalledWith("evt", { x: 1 });
    expect(mod2.emit).toHaveBeenCalledWith("evt", { x: 1 });
    for (const s of [viewer, broken, deleted, anonymous]) expect(s.emit).not.toHaveBeenCalled();
    // Each distinct role is resolved once per broadcast, not once per socket.
    expect(getRoleByNameMock.mock.calls.filter(([n]) => n === "mod")).toHaveLength(1);
  });
});
