import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../utils/errorCodes.js";

// sweep-round2 (2026-09-06, dwight): auth.js:507 (POST /users) and auth.js:544
// (PATCH /users/:id/role) are both gated requirePermission("users.manage"),
// but neither the routes nor authService.createUser()/changeUserRoleById()
// underneath them restricted WHICH role could be granted relative to the
// caller's own privileges. A caller whose role holds users.manage but not
// roles.manage/admin could, in one API call, PATCH their own account (or a
// brand-new POST /users account) straight to admin -- self-service
// escalation with zero admin cooperation, worse than the already-fixed
// recovery-codes bug (auth.js:700-722) it precedent-matches: one call, not
// two, no plaintext-codes side channel a real admin might notice.
//
// This codebase already enforces the exact same "you cannot hand out an
// authority you do not hold yourself" rule for a SECONDARY door
// (DISCORD_PERMISSIONS_CAPABILITY_REQUIRED, routes/discord.js's PUT
// /permissions) -- role assignment is the PRIMARY door for that same
// authority and had no such rule at all. Fix: assertNoCapabilityEscalation
// (services/auth.js) refuses creating/reassigning a user into any role
// whose capabilities aren't a subset of the caller's own, per-capability,
// not special-cased to roles.manage/users.manage the way the existing
// last-manager lockout guard is. Plus an unconditional self-role-change
// refusal (USER_SELF_ROLE_CHANGE_REFUSED), closing the asymmetry with
// deleteUser's own pre-existing self-delete refusal.
//
// ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES and USER_SELF_ROLE_CHANGE_REFUSED
// were shipped (ff17ee11) ahead of their errorCodes.js/locale registration
// -- client/src/locales/ was contested by another agent's concurrent,
// unrelated work at the time -- and registered once that cleared
// (29a080c3 fixed the params.detail shape first; this commit adds the
// ErrorCode constants and all 9 locales' translations).

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
  getUsersForRoleAccounting: async () =>
    db.data.users.map((u) => ({ id: u.id, username: u.username, role: u.role, roleId: u.roleId })),
  replaceRoleById: async (id, role) => {
    const index = db.data.roles.findIndex((r) => String(r.id) === String(id));
    if (index === -1) return null;
    db.data.roles[index] = role;
    return role;
  },
  removeRoleById: async (id) => {
    const before = db.data.roles.length;
    db.data.roles = db.data.roles.filter((r) => String(r.id) !== String(id));
    return db.data.roles.length !== before;
  },
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
}));

const { default: authService } = await import("../services/auth.js");
const { updateRole, deleteRole, CAPABILITIES } = await import("../services/permissions.js");

const ADMIN_ROLE = {
  id: "role-admin",
  name: "admin",
  capabilities: ["users.manage", "roles.manage", "server.control", "rcon.execute"],
  isSeeded: true,
};
const TECHNICIAN_ROLE = {
  id: "role-technician",
  name: "technician",
  capabilities: ["server.control", "rcon.execute"],
  isSeeded: true,
};
const MODERATOR_ROLE = {
  id: "role-moderator",
  name: "moderator",
  capabilities: ["players.moderate"],
  isSeeded: true,
};
// The vulnerable shape: an operator-built custom role that legitimately
// needs to manage accounts (users.manage) but was never meant to be
// admin-equivalent -- exactly the "Support" example from the fix's own
// design discussion. Also holds players.moderate so it can demonstrate the
// POSITIVE case (assigning a role it genuinely IS a superset of).
const SUPPORT_ROLE = {
  id: "role-support",
  name: "support",
  capabilities: ["users.manage", "players.moderate"],
};
// A role that grants nothing: what a delegate may move an account out of.
const MEMBER_ROLE = { id: "role-member", name: "member", capabilities: [] };

function resetWith({ roles = [], users = [] }) {
  settings.clear();
  db.data.roles = roles.map((r) => ({ ...r }));
  db.data.users = users.map((u) => ({ ...u }));
}

describe("createUser() -- refuses creating a user in a role that exceeds the caller's own capabilities", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE, MODERATOR_ROLE, SUPPORT_ROLE],
      users: [
        { id: "u-admin", username: "realadmin", role: "admin", roleId: "role-admin" },
        { id: "u-support", username: "support1", role: "support", roleId: "role-support" },
      ],
    });
  });

  it("params.detail is JUST the joined capability list, not a full sentence -- the shape a future locale template's {{detail}} will interpolate, matching DISCORD_PERMISSIONS_CAPABILITY_REQUIRED's own params.detail precedent", async () => {
    await expect(
      authService.createUser("newtech", "password123", "technician", {
        actingUserId: "u-support",
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES,
      // technician holds server.control, rcon.execute; support holds
      // users.manage, players.moderate -- everything technician has that
      // support doesn't, in order, comma-joined, nothing else. (Not the admin
      // role: since 2026-10-08 (#5) joining it is worth the whole catalogue.)
      params: { detail: "server.control, rcon.execute" },
    });
  });

  it("refuses a users.manage-only (support) caller minting a brand-new ADMIN account -- the exploit this closes", async () => {
    await expect(
      authService.createUser("newadmin", "password123", "admin", {
        actingUserId: "u-support",
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES,
      status: 403,
    });
    expect(db.data.users.find((u) => u.username === "newadmin")).toBeUndefined();
  });

  it("allows a users.manage-only (support) caller creating a MODERATOR account -- support's own capabilities are a superset of moderator's, so this is the delegation feature working as intended", async () => {
    const user = await authService.createUser("newmod", "password123", "moderator", {
      actingUserId: "u-support",
    });
    expect(user.role).toBe("moderator");
    expect(db.data.users.find((u) => u.username === "newmod")).toBeTruthy();
  });

  it("allows a real admin caller minting a new admin account -- the fix does not regress the legitimate case", async () => {
    const user = await authService.createUser("newadmin2", "password123", "admin", {
      actingUserId: "u-admin",
    });
    expect(user.role).toBe("admin");
  });
});

describe("changeUserRoleById() -- self-change refusal and escalation guard", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE, MODERATOR_ROLE, SUPPORT_ROLE, MEMBER_ROLE],
      users: [
        { id: "u-admin", username: "realadmin", role: "admin", roleId: "role-admin" },
        { id: "u-support", username: "support1", role: "support", roleId: "role-support" },
        { id: "u-target", username: "target", role: "technician", roleId: "role-technician" },
        { id: "u-member", username: "member1", role: "member", roleId: "role-member" },
      ],
    });
  });

  it("refuses a caller changing their OWN role, even a real admin -- closes the asymmetry with deleteUser's existing self-delete refusal", async () => {
    await expect(
      authService.changeUserRoleById("u-admin", "role-technician", {
        actingUserId: "u-admin",
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.USER_SELF_ROLE_CHANGE_REFUSED,
      status: 400,
    });
    // Refused before any DB mutation -- the target user's row is untouched.
    expect(db.data.users.find((u) => u.id === "u-admin").role).toBe("admin");
  });

  it("refuses a users.manage-only (support) caller promoting a DIFFERENT user to admin -- the exploit this closes", async () => {
    await expect(
      authService.changeUserRoleById("u-target", "role-admin", {
        actingUserId: "u-support",
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES,
      status: 403,
    });
    expect(db.data.users.find((u) => u.id === "u-target").role).toBe("technician");
  });

  it("allows a users.manage-only (support) caller reassigning a DIFFERENT user to MODERATOR -- a subset of support's own capabilities", async () => {
    // From a role support covers too: since 2026-10-08 (#3) the user's
    // CURRENT role has to be within support's reach as well (see the
    // ceiling tests below).
    const user = await authService.changeUserRoleById("u-member", "role-moderator", {
      actingUserId: "u-support",
    });
    expect(user.role).toBe("moderator");
  });

  it("allows a real admin caller promoting a different user to admin -- the fix does not regress the legitimate case", async () => {
    const user = await authService.changeUserRoleById("u-target", "role-admin", {
      actingUserId: "u-admin",
    });
    expect(user.role).toBe("admin");
  });

  it("callers with no actingUserId at all (internal/legacy callers) are unaffected -- no caller context means no escalation check to run", async () => {
    const user = await authService.changeUserRoleById("u-target", "role-admin");
    expect(user.role).toBe("admin");
  });
});

describe("changeUserRole() (legacy fixed-name wrapper) threads actingUserId through to changeUserRoleById", () => {
  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, TECHNICIAN_ROLE, MODERATOR_ROLE, SUPPORT_ROLE],
      users: [
        { id: "u-support", username: "support1", role: "support", roleId: "role-support" },
        { id: "u-target", username: "target", role: "technician", roleId: "role-technician" },
      ],
    });
  });

  it("refuses the same escalation via the legacy role-NAME path, not just the roleId path", async () => {
    await expect(
      authService.changeUserRole("u-target", "admin", { actingUserId: "u-support" }),
    ).rejects.toMatchObject({
      code: ErrorCode.ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES,
      status: 403,
    });
  });
});

// Auth audit 2026-10-08 (#3): every check above limits what a caller HANDS
// OUT, none what they TAKE AWAY. A helper given [roles.manage, users.manage]
// could strip the built-in admin role, move the co-admin into an empty role
// and delete the owner -- each step passed, and the helper ended up the only
// account manager. Now the account or role being narrowed, demoted, deleted
// (or signed out) must hold nothing the caller doesn't.
describe("ceiling on the target: a delegate can't take power from accounts or roles wider than its own", () => {
  const DELEGATE_ROLE = {
    id: "role-delegate",
    name: "delegate",
    capabilities: ["roles.manage", "users.manage"],
  };
  const WIDE_ROLE = {
    id: "role-wide",
    name: "wide",
    capabilities: ["roles.manage", "users.manage", "server.control"],
  };
  const delegate = { userId: "u-delegate", role: "delegate" };
  const owner = { userId: "u-owner", role: "admin" };

  beforeEach(() => {
    resetWith({
      roles: [ADMIN_ROLE, DELEGATE_ROLE, WIDE_ROLE, MEMBER_ROLE],
      users: [
        { id: "u-owner", username: "owner", role: "admin", roleId: "role-admin" },
        { id: "u-coadmin", username: "coadmin", role: "admin", roleId: "role-admin" },
        { id: "u-delegate", username: "helper", role: "delegate", roleId: "role-delegate" },
        { id: "u-wide", username: "wide1", role: "wide", roleId: "role-wide" },
        { id: "u-member", username: "member1", role: "member", roleId: "role-member" },
      ],
    });
  });

  it("refuses the delegate narrowing the built-in admin role", async () => {
    await expect(
      updateRole("role-admin", { capabilities: ["users.manage"] }, { actingUser: delegate }),
    ).rejects.toMatchObject({
      code: ErrorCode.ROLE_TARGET_EXCEEDS_CALLER_CAPABILITIES,
      status: 403,
      // The whole catalogue but the delegate's two: the admin role is worth
      // every capability (#5), not just its stored row.
      params: { missing: expect.arrayContaining(["server.control", "rcon.execute", "server.wipe"]) },
    });
    expect(db.data.roles.find((r) => r.id === "role-admin").capabilities).toEqual(
      ADMIN_ROLE.capabilities,
    );
  });

  it("refuses the delegate demoting an admin", async () => {
    await expect(
      authService.changeUserRoleById("u-coadmin", "role-member", { actingUserId: "u-delegate" }),
    ).rejects.toMatchObject({ code: ErrorCode.ROLE_TARGET_EXCEEDS_CALLER_CAPABILITIES, status: 403 });
    expect(db.data.users.find((u) => u.id === "u-coadmin").role).toBe("admin");
  });

  it("refuses the delegate deleting an admin", async () => {
    await expect(
      authService.deleteUser("u-owner", { actingUserId: "u-delegate" }),
    ).rejects.toMatchObject({ code: ErrorCode.ROLE_TARGET_EXCEEDS_CALLER_CAPABILITIES, status: 403 });
    expect(db.data.users.some((u) => u.id === "u-owner")).toBe(true);
  });

  it("refuses the delegate deleting a role wider than its own that still has members", async () => {
    await expect(
      deleteRole("role-wide", { reassignTo: "role-member", actingUser: delegate }),
    ).rejects.toMatchObject({
      code: ErrorCode.ROLE_TARGET_EXCEEDS_CALLER_CAPABILITIES,
      params: { detail: "server.control" },
    });
    expect(db.data.roles.some((r) => r.id === "role-wide")).toBe(true);
    expect(db.data.users.find((u) => u.id === "u-wide").role).toBe("wide");
  });

  it("still lets the delegate act on accounts and roles within its reach", async () => {
    const moved = await authService.changeUserRoleById("u-member", "role-delegate", {
      actingUserId: "u-delegate",
    });
    expect(moved.role).toBe("delegate");
    await expect(
      authService.deleteUser("u-member", { actingUserId: "u-delegate" }),
    ).resolves.toMatchObject({ id: "u-member" });
  });

  it("a real admin can still do all four", async () => {
    await expect(
      updateRole(
        "role-admin",
        { capabilities: ["users.manage", "roles.manage"] },
        { actingUser: owner },
      ),
    ).resolves.toMatchObject({ capabilities: ["users.manage", "roles.manage"] });
    await expect(
      authService.changeUserRoleById("u-coadmin", "role-member", { actingUserId: "u-owner" }),
    ).resolves.toMatchObject({ role: "member" });
    await expect(
      deleteRole("role-wide", { reassignTo: "role-member", actingUser: owner }),
    ).resolves.toMatchObject({ deleted: true, reassigned: 1 });
    await expect(
      authService.deleteUser("u-wide", { actingUserId: "u-owner" }),
    ).resolves.toMatchObject({ id: "u-wide" });
  });
});

// Review of #5: the admin role counts as every capability for the CALLER,
// so it has to count as every capability for the TARGET too. With one box
// unticked in the admin column (the state #5 exists for) and a custom role
// holding everything left in that row, comparing against the stored row let
// that role demote, delete or sign out admins and mint new ones -- and a new
// admin can grant what nobody held.
describe("the admin role is worth every capability on the target side too", () => {
  const ALL_BUT_WIPE = CAPABILITIES.map((c) => c.key).filter((key) => key !== "server.wipe");
  const NARROWED_ADMIN_ROLE = { ...ADMIN_ROLE, capabilities: ALL_BUT_WIPE };
  const HEAD_ROLE = { id: "role-head", name: "head", capabilities: ALL_BUT_WIPE };
  const head = { userId: "u-head", role: "head" };
  const owner = { userId: "u-owner", role: "admin" };
  const exceedsGrant = {
    code: ErrorCode.ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES,
    status: 403,
    params: { missing: ["server.wipe"] },
  };
  const exceedsTarget = {
    code: ErrorCode.ROLE_TARGET_EXCEEDS_CALLER_CAPABILITIES,
    status: 403,
    params: { missing: ["server.wipe"] },
  };

  beforeEach(() => {
    resetWith({
      roles: [NARROWED_ADMIN_ROLE, HEAD_ROLE, MEMBER_ROLE],
      users: [
        { id: "u-owner", username: "owner", role: "admin", roleId: "role-admin" },
        { id: "u-coadmin", username: "coadmin", role: "admin", roleId: "role-admin" },
        { id: "u-head", username: "head1", role: "head", roleId: "role-head" },
        { id: "u-member", username: "member1", role: "member", roleId: "role-member" },
      ],
    });
  });

  it("refuses the head role minting an admin", async () => {
    await expect(
      authService.createUser("puppet", "password123", "admin", { actingUserId: "u-head" }),
    ).rejects.toMatchObject(exceedsGrant);
    await expect(
      authService.changeUserRoleById("u-member", "role-admin", { actingUserId: "u-head" }),
    ).rejects.toMatchObject(exceedsGrant);
    await expect(
      deleteRole("role-head", { reassignTo: "role-admin", actingUser: head }),
    ).rejects.toMatchObject(exceedsGrant);
    expect(db.data.users.filter((u) => u.role === "admin").map((u) => u.id)).toEqual([
      "u-owner",
      "u-coadmin",
    ]);
    expect(db.data.roles.some((r) => r.id === "role-head")).toBe(true);
  });

  it("refuses the head role demoting, deleting or signing out an admin", async () => {
    await expect(
      authService.changeUserRoleById("u-coadmin", "role-member", { actingUserId: "u-head" }),
    ).rejects.toMatchObject(exceedsTarget);
    await expect(
      authService.deleteUser("u-coadmin", { actingUserId: "u-head" }),
    ).rejects.toMatchObject(exceedsTarget);
    await expect(
      authService.revokeAllSessions("u-coadmin", { actingUserId: "u-head" }),
    ).rejects.toMatchObject(exceedsTarget);
    await expect(
      updateRole("role-admin", { capabilities: ["users.manage", "roles.manage"] }, { actingUser: head }),
    ).rejects.toMatchObject(exceedsTarget);
    expect(db.data.users.find((u) => u.id === "u-coadmin").role).toBe("admin");
    expect(db.data.roles.find((r) => r.id === "role-admin").capabilities).toEqual(ALL_BUT_WIPE);
  });

  it("a real admin still does all of it", async () => {
    await expect(
      authService.createUser("newadmin", "password123", "admin", { actingUserId: "u-owner" }),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(
      authService.changeUserRoleById("u-member", "role-admin", { actingUserId: "u-owner" }),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(
      authService.revokeAllSessions("u-coadmin", { actingUserId: "u-owner" }),
    ).resolves.toMatchObject({ id: "u-coadmin" });
    await expect(
      authService.changeUserRoleById("u-coadmin", "role-member", { actingUserId: "u-owner" }),
    ).resolves.toMatchObject({ role: "member" });
    await expect(
      authService.deleteUser("u-coadmin", { actingUserId: "u-owner" }),
    ).resolves.toMatchObject({ id: "u-coadmin" });
    await expect(
      deleteRole("role-head", { reassignTo: "role-admin", actingUser: owner }),
    ).resolves.toMatchObject({ deleted: true, reassigned: 1 });
    await expect(
      updateRole("role-admin", { capabilities: ["users.manage", "roles.manage"] }, { actingUser: owner }),
    ).resolves.toMatchObject({ capabilities: ["users.manage", "roles.manage"] });
  });
});
