import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// security sweep 2026-10-04 (AUTHN-2): every per-USER revocation path in
// services/auth.js (password change/reset, role change, delete, logout)
// evicts that user's live sockets through onSessionRevoked ->
// index.js's evictRevokedSockets(). The per-ROLE paths in
// services/permissions.js never did: an admin stripping rcon.execute from a
// role (PUT /api/permissions/roles/:id) or deleting it with reassignTo cut
// every member's HTTP access on their next request, but a socket that had
// already joined rcon-live / logs / perf / players kept streaming -- rooms
// joined at subscribe time are never re-checked, and the socket stays
// authorized against the role name it cached at handshake.
//
// Same verification boundary as socketSessionRevocation.test.js: real
// services/permissions.js -> real services/auth.js bus -> real index.js
// evictRevokedSockets() -> the real Socket.IO server's in()/
// disconnectSockets(), spied on rather than reimplemented.
//
// PRE-FIX BREAK-VERIFY: against the old updateRole()/deleteRole() every
// "evicts" assertion below sees zero in("user:<id>") calls -- nothing on the
// role side ever reached the bus.

const settings = new Map();
const db = { data: { users: [], roles: [] } };

const roleMembers = (role) =>
  db.data.users.filter((u) => u.roleId === role.id || (role.isSeeded && u.role === role.name));

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id) => db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
  getUsersForRole: async (role) => roleMembers(role),
  getUsersForRoleAccounting: async () =>
    db.data.users.map((u) => ({ id: u.id, username: u.username, role: u.role, roleId: u.roleId })),
  insertRole: async (role) => {
    db.data.roles.push(role);
    return role;
  },
  replaceRoleById: async (id, updated) => {
    const index = db.data.roles.findIndex((r) => String(r.id) === String(id));
    if (index === -1) return null;
    db.data.roles[index] = updated;
    return updated;
  },
  removeRoleById: async (id) => {
    const index = db.data.roles.findIndex((r) => String(r.id) === String(id));
    if (index === -1) return false;
    db.data.roles.splice(index, 1);
    return true;
  },
  // Same body as the real database/init.js reassignRoleMembers().
  reassignRoleMembers: async (fromRole, toRole) => {
    let count = 0;
    for (const u of db.data.users) {
      if (u.roleId === fromRole.id || (fromRole.isSeeded && u.role === fromRole.name)) {
        u.roleId = toRole.id;
        u.role = toRole.name;
        count++;
      }
    }
    return count;
  },
  // index.js wires this into lifecycleCoordinator.js at module scope.
  peekServerDisplayName: () => null,
}));

const { updateRole, deleteRole } = await import("../services/permissions.js");
const { io } = await import("../index.js");

const ADMIN_ACTOR = { userId: "u-admin", role: "admin" };

function seed() {
  settings.clear();
  db.data.roles = [
    {
      id: "role-admin",
      name: "admin",
      capabilities: ["users.manage", "roles.manage", "rcon.execute", "diagnostics.manage", "players.view"],
      isSeeded: true,
    },
    { id: "role-ops", name: "ops", capabilities: ["rcon.execute", "diagnostics.manage"], isSeeded: false },
    { id: "role-viewer", name: "viewer", capabilities: [], isSeeded: false },
    {
      id: "role-moderator",
      name: "moderator",
      capabilities: ["players.view", "diagnostics.manage"],
      isSeeded: true,
    },
  ];
  db.data.users = [
    { id: "u-admin", username: "admin", role: "admin", roleId: "role-admin" },
    { id: "u-ops1", username: "ops1", role: "ops", roleId: "role-ops" },
    { id: "u-ops2", username: "ops2", role: "ops", roleId: "role-ops" },
    { id: "u-viewer", username: "viewer", role: "viewer", roleId: "role-viewer" },
    // Pre-migration-style seeded-role member: matched by name, no roleId.
    { id: "u-mod", username: "mod", role: "moderator" },
  ];
}

describe("role edits and deletes evict the affected members' live sockets", () => {
  let inSpy;
  let roomDisconnectSpy;
  let globalDisconnectSpy;

  const evictedRooms = () => inSpy.mock.calls.map(([room]) => room).sort();

  beforeEach(() => {
    seed();
    roomDisconnectSpy = vi.fn();
    inSpy = vi.spyOn(io, "in").mockReturnValue({ disconnectSockets: roomDisconnectSpy });
    globalDisconnectSpy = vi.spyOn(io, "disconnectSockets").mockImplementation(() => {});
  });

  afterEach(() => {
    inSpy.mockRestore();
    globalDisconnectSpy.mockRestore();
  });

  it("removing a capability from a role evicts every member, and only members", async () => {
    await updateRole("role-ops", { capabilities: ["diagnostics.manage"] }, { actingUser: ADMIN_ACTOR });

    expect(evictedRooms()).toEqual(["user:u-ops1", "user:u-ops2"]);
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    // Scoped, never the panel-wide hammer.
    expect(globalDisconnectSpy).not.toHaveBeenCalled();
  });

  it("covers a seeded role's name-matched members too (no roleId on the record)", async () => {
    await updateRole("role-moderator", { capabilities: ["players.view"] }, { actingUser: ADMIN_ACTOR });

    expect(evictedRooms()).toEqual(["user:u-mod"]);
  });

  it("does NOT evict anyone when the edit only adds capabilities -- subscribe:* re-checks live on join", async () => {
    await updateRole(
      "role-ops",
      { capabilities: ["rcon.execute", "diagnostics.manage", "players.view"] },
      { actingUser: ADMIN_ACTOR },
    );

    expect(inSpy).not.toHaveBeenCalled();
  });

  it("renaming a role evicts its members: their sockets are still bound to the old name", async () => {
    await updateRole("role-ops", { name: "operators" }, { actingUser: ADMIN_ACTOR });

    expect(evictedRooms()).toEqual(["user:u-ops1", "user:u-ops2"]);
  });

  it("deleting a role and reassigning its members evicts every moved member", async () => {
    const result = await deleteRole("role-ops", { reassignTo: "role-viewer", actingUser: ADMIN_ACTOR });

    expect(result.reassigned).toBe(2);
    expect(evictedRooms()).toEqual(["user:u-ops1", "user:u-ops2"]);
    expect(globalDisconnectSpy).not.toHaveBeenCalled();
  });

  it("a refused edit evicts nobody -- nothing changed", async () => {
    await expect(
      updateRole(
        "role-viewer",
        { capabilities: ["rcon.execute"] },
        { actingUser: { userId: "u-viewer", role: "viewer" } },
      ),
    ).rejects.toMatchObject({ code: "ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES" });

    expect(inSpy).not.toHaveBeenCalled();
  });
});
