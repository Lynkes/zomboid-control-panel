import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../utils/errorCodes.js";

// continuous-bug-hunt, 2026-09-18 (panel-user/role-truth round): the
// 2026-09-10 re-entrancy sweep closed the "last manager" lockout race
// role-vs-role (permissions.js's own withRoleMutex, see
// permissionsRoleLockoutConcurrency.test.js) and, earlier, user-vs-user
// (auth.js's AuthService._withMutex) -- but never noticed the THIRD
// combination: a user-role-change (auth.js, guarded only by
// AuthService._withMutex) racing a role edit (permissions.js, guarded only
// by its own separate roleMutex). The two mutexes never coordinated with
// each other.
//
// Concrete: role-x and role-y are the only two roles granting
// users.manage; user-a holds role-x, user-b holds role-y. A concurrent
// changeUserRoleById(user-a -> role-z, which grants nothing) and
// updateRole(role-y, capabilities: [] -- stripping users.manage from it)
// each read the SAME pre-change state: the user change sees user-b (via
// role-y) still holds users.manage, the role edit sees user-a (via role-x)
// still holds it. Both pass their own lockout check, both write -- zero
// users end up able to manage users at all, exactly the lockout
// RECOVERY_CAPABILITIES exists to make impossible. Fixed by having
// changeUserRoleById/deleteUser nest inside permissions.js's exported
// withRoleMutex too, so every operation that can move the
// roles.manage/users.manage headcount shares one critical section.
//
// Deterministic-by-construction is NOT assumed here (unlike the pure
// role-vs-role tests): _withMutex's own chaining defers
// changeUserRoleById's inner withRoleMutex call by one microtask relative
// to updateRole's synchronous one, so which caller's check runs first is
// not pinned down the same way. The assertion that matters either way: AT
// LEAST ONE of the two concurrent calls must be refused, and the invariant
// (some user can still manage users) must hold once both have settled --
// the pre-fix bug is that NEITHER was refused and the invariant broke.

const rolesById = new Map();
const usersById = new Map();

function seedRole(id, name, capabilities, isSeeded = false) {
  rolesById.set(id, { id, name, capabilities, isSeeded });
}

function seedUser(id, username, roleId) {
  const role = rolesById.get(roleId);
  usersById.set(id, { id, username, role: role?.name, roleId });
}

const { replaceRoleById, removeRoleById } = vi.hoisted(() => ({
  replaceRoleById: vi.fn(),
  removeRoleById: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getSetting: async () => null,
  setSetting: async () => {},
  getDb: async () => ({ data: { users: Array.from(usersById.values()) } }),
  commitNow: async () => {},
  getRoles: async () => Array.from(rolesById.values()),
  getRoleById: async (id) => rolesById.get(String(id)) || null,
  getRoleByName: async (name) =>
    Array.from(rolesById.values()).find((r) => r.name === name) || null,
  insertRole: async (role) => {
    rolesById.set(role.id, role);
    return role;
  },
  replaceRoleById,
  removeRoleById,
  getUsersForRoleAccounting: async () => Array.from(usersById.values()),
  getUsersForRole: async (role) =>
    Array.from(usersById.values()).filter(
      (u) => String(u.roleId) === String(role.id),
    ),
  reassignRoleMembers: async () => 0,
}));

const { default: authService } = await import("../services/auth.js");
const { updateRole } = await import("../services/permissions.js");

beforeEach(() => {
  rolesById.clear();
  usersById.clear();
  replaceRoleById.mockReset().mockImplementation(async (id, role) => {
    rolesById.set(String(id), role);
    return role;
  });
  removeRoleById.mockReset().mockImplementation(async (id) => rolesById.delete(String(id)));

  seedRole("role-x", "CustomX", ["users.manage"]);
  seedRole("role-y", "CustomY", ["users.manage"]);
  seedRole("role-z", "CustomZ", []);
  seedUser("user-a", "userA", "role-x");
  seedUser("user-b", "userB", "role-y");
});

function usersManageHolderCount() {
  const granting = new Set(
    Array.from(rolesById.values())
      .filter((r) => r.capabilities.includes("users.manage"))
      .map((r) => r.id),
  );
  return Array.from(usersById.values()).filter((u) => granting.has(u.roleId))
    .length;
}

describe("changeUserRoleById() vs. concurrent updateRole(): cross-file last-manager lockout race", () => {
  it("refuses at least one side instead of letting both proceed and zeroing out users.manage", async () => {
    expect(usersManageHolderCount()).toBe(2); // sanity: user-a and user-b, before either call

    const userChange = authService.changeUserRoleById("user-a", "role-z", {});
    const roleEdit = updateRole("role-y", { capabilities: [] });

    const [userResult, roleResult] = await Promise.allSettled([
      userChange,
      roleEdit,
    ]);

    const refusals = [userResult, roleResult].filter(
      (r) => r.status === "rejected",
    );
    // At least one must be refused -- exactly which one depends on
    // microtask timing, not something this test should pin down.
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    for (const refusal of refusals) {
      expect(refusal.reason).toMatchObject({
        code: ErrorCode.ROLE_LOCKOUT_LAST_MANAGER,
      });
    }

    // The actual invariant this whole guard exists for: someone can still
    // manage user accounts after both calls have settled.
    expect(usersManageHolderCount()).toBeGreaterThanOrEqual(1);
  });

  it("both proceed when they don't touch the same recovery capability (no false refusal from the shared mutex)", async () => {
    // Give user-a a role that already grants nothing recovery-relevant, so
    // moving them touches no recovery capability at all.
    seedRole("role-plain", "Plain", ["players.view"]);
    seedUser("user-a", "userA", "role-plain");

    const userChange = authService.changeUserRoleById("user-a", "role-z", {});
    const roleEdit = updateRole("role-y", { capabilities: ["users.manage"] }); // no-op edit, still grants it

    const [userResult, roleResult] = await Promise.allSettled([
      userChange,
      roleEdit,
    ]);

    expect(userResult.status).toBe("fulfilled");
    expect(roleResult.status).toBe("fulfilled");
  });
});
