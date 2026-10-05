import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Socket.IO rooms that carry gated broadcasts (install, chunkscan, players,
// logs, perf, rcon-live) are joined once, after a capability check. Editing
// a role's capabilities never re-checked them, so a member who had joined
// kept receiving install:*, steamcmd:*, chunkScan:progress, logs and live
// RCON after the capability was taken off their role, until they
// reconnected. #193 added two of these rooms; a role edit now re-checks all
// of them for that role's members.
const rolesById = new Map();

vi.mock("../database/init.js", () => ({
  getDb: vi.fn(async () => ({ data: { users: [] } })),
  commitNow: vi.fn(async () => {}),
  peekServerDisplayName: vi.fn(() => null),
  getRoles: async () => Array.from(rolesById.values()),
  getRoleById: async (id) => rolesById.get(String(id)) || null,
  getRoleByName: async (name) => Array.from(rolesById.values()).find((r) => r.name === name) || null,
  replaceRoleById: async (id, role) => {
    rolesById.set(String(id), role);
    return role;
  },
  getUsersForRole: async () => [],
  getUsersForRoleAccounting: async () => [],
}));

const { io, CAPABILITY_ROOMS, recheckCapabilityRooms } = await import("../index.js");
const { updateRole, onRoleCapabilitiesChanged } = await import("../services/permissions.js");

function fakeSocket(id, role, rooms) {
  return {
    id,
    user: { userId: id, username: id, role },
    rooms: new Set([id, `user:${id}`, ...rooms]),
    leave(room) {
      this.rooms.delete(room);
    },
  };
}

const ALL_GATED = Object.keys(CAPABILITY_ROOMS);
const added = [];
function connect(socket) {
  io.sockets.sockets.set(socket.id, socket);
  added.push(socket.id);
  return socket;
}

// The listener runs on setImmediate, then resolves roles asynchronously.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  rolesById.clear();
  rolesById.set("r-installer", {
    id: "r-installer",
    name: "Installer",
    isSeeded: false,
    capabilities: ["server.install", "chunks.manage", "players.view", "diagnostics.manage", "rcon.execute"],
  });
  rolesById.set("r-other", {
    id: "r-other",
    name: "Other",
    isSeeded: false,
    capabilities: ["server.install", "chunks.manage"],
  });
});

afterEach(() => {
  for (const id of added.splice(0)) io.sockets.sockets.delete(id);
});

describe("editing a role's capabilities re-checks its members' socket rooms", () => {
  it("drops the rooms whose capability was removed and keeps the rest", async () => {
    const installer = connect(fakeSocket("s1", "Installer", ALL_GATED));
    const other = connect(fakeSocket("s2", "Other", ["install", "chunkscan"]));

    await updateRole("r-installer", { capabilities: ["players.view"] });
    await settle();

    expect([...installer.rooms].sort()).toEqual(["players", "s1", "user:s1"]);
    // Another role's members are not touched.
    expect([...other.rooms].sort()).toEqual(["chunkscan", "install", "s2", "user:s2"]);
  });

  it("a rename alone does not re-check anything", async () => {
    const listener = vi.fn();
    const off = onRoleCapabilitiesChanged(listener);
    const installer = rolesById.get("r-installer");
    await updateRole("r-installer", { name: "Builders", capabilities: [...installer.capabilities].reverse() });
    await settle();
    off();
    expect(listener).not.toHaveBeenCalled();
  });

  it("tells listeners the role's name from before the edit", async () => {
    const listener = vi.fn();
    const off = onRoleCapabilitiesChanged(listener);
    await updateRole("r-installer", { name: "Builders", capabilities: ["players.view"] });
    await settle();
    off();
    expect(listener).toHaveBeenCalledWith("Installer");
  });

  it("recheckCapabilityRooms() fails closed for a role that no longer resolves", async () => {
    const ghost = connect(fakeSocket("s3", "Deleted Role", ["install", "players", "rcon-live"]));
    await recheckCapabilityRooms("Deleted Role");
    expect([...ghost.rooms].sort()).toEqual(["s3", "user:s3"]);
  });

  it("covers every room a subscribe:* handler gates", () => {
    expect(CAPABILITY_ROOMS).toEqual({
      players: "players.view",
      install: "server.install",
      chunkscan: "chunks.manage",
      logs: "diagnostics.manage",
      perf: "diagnostics.manage",
      "rcon-live": "rcon.execute",
    });
  });
});
