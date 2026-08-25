/**
 * Permission system: capabilities are the primitive, roles are named,
 * database-stored bundles of them. Replaces the hardcoded
 * requireRole("admin", "technician") role lists with requirePermission(
 * "capability.name") backed by the `roles` collection in database/init.js.
 *
 * CAPABILITIES is the catalogue every route-level requirePermission() call
 * and the matrix UI both draw from -- capability keys are load-bearing
 * wire values (server/routes/*.js reference them by string, and once the
 * matrix UI renders them, renaming one is a breaking change for whoever is
 * looking at it), so treat additions as append-only and renames as a
 * decision, not a refactor.
 *
 * DEFAULT_ROLE_CAPABILITIES is the migration seed (see database/init.js's
 * schema v2 migration) -- it is a SNAPSHOT of what every requireRole(...)
 * call site in the app actually granted at the moment this file was
 * written, not a policy choice. If a future requireRole call site's role
 * list and this file's seed ever disagree, the call site is the one that
 * changed; this seed only matters for the one-time migration of existing
 * installs and is not re-derived at runtime.
 */

import {
  getDb,
  commitNow,
  getRoles,
  getRoleById,
  getRoleByName,
  insertRole,
  replaceRoleById,
  removeRoleById,
  getUsersForRole,
  getUsersForRoleAccounting,
  reassignRoleMembers,
} from "../database/init.js";
import { createLogger } from "../utils/logger.js";
import { ErrorCode } from "../utils/errorCodes.js";

const log = createLogger("Permissions");

// ============================================
// Capability catalogue
// ============================================

// Each entry: { key, group, label, description }. `group` is a display
// grouping for the matrix UI, not a separate stored entity.
export const CAPABILITIES = [
  // --- Users & Roles ---
  {
    key: "users.manage",
    group: "Users & Roles",
    label: "Manage user accounts",
    description:
      "Create accounts, list them, and change which role each one holds.",
  },
  {
    key: "roles.manage",
    group: "Users & Roles",
    label: "Manage roles & permissions",
    description:
      "Create, edit and delete roles, and choose which capabilities each one grants.",
  },

  // --- Backups ---
  {
    key: "backups.manage",
    group: "Backups",
    label: "Create, delete & configure backups",
    description:
      "Create manual backups, delete or prune old ones, upload external backups, and change the backup schedule.",
  },
  {
    key: "backups.download",
    group: "Backups",
    label: "Download a backup archive",
    description:
      "Download a backup .zip off the machine -- a full copy of the world save and, if database backups are turned on, the panel's own account data. A different act from creating, deleting or restoring one: this one leaves the machine.",
  },
  {
    key: "backups.restore",
    group: "Backups",
    label: "Restore a backup",
    description:
      "Roll the live world back to an earlier backup -- affects every player currently on the server.",
  },

  // --- Server Lifecycle ---
  {
    key: "server.control",
    group: "Server Lifecycle",
    label: "Start, stop, restart & save the server",
    description: "Start, stop, force-stop, restart or save the running server.",
  },
  {
    key: "server.install",
    group: "Server Lifecycle",
    label: "Install & update the server",
    description:
      "Install or update the server through SteamCMD, browse the filesystem to configure it, and verify a discovered install.",
  },
  {
    key: "server.configure",
    group: "Server Lifecycle",
    label: "Edit server configuration",
    description:
      "Edit the server's .ini settings, RCON connection details, and network/path configuration.",
  },
  {
    key: "server.wipe",
    group: "Server Lifecycle",
    label: "Wipe the world",
    description: "Irreversibly delete map, player or world save data.",
  },
  {
    key: "server.world_events",
    group: "Server Lifecycle",
    label: "Run world events",
    description:
      "Weather, climate, time of day, ambient sound, zombie hordes, utilities, visual settings and broadcast messages -- world-wide effects, not aimed at a specific player.",
  },

  // --- RCON ---
  {
    key: "rcon.execute",
    group: "RCON",
    label: "Run RCON commands",
    description: "Connect to RCON and execute arbitrary console commands.",
  },

  // --- Server Setup & Fleet ---
  {
    key: "servers.manage",
    group: "Server Setup & Fleet",
    label: "Add, edit & remove configured servers",
    description: "Add, edit, remove or activate a configured server entry.",
  },
  {
    key: "servers.discover",
    group: "Server Setup & Fleet",
    label: "Auto-discover servers on this machine",
    description: "Scan the host filesystem for existing PZ server installs.",
  },
  {
    key: "templates.manage",
    group: "Server Setup & Fleet",
    label: "Manage server templates",
    description: "Create, import, apply and delete configuration templates.",
  },

  // --- PanelBridge Integration ---
  {
    key: "bridge.setup",
    group: "PanelBridge Integration",
    label: "Connect & configure PanelBridge",
    description:
      "Connect or reconfigure the in-game mod bridge, its SFTP transport, and install the mod.",
  },
  {
    key: "bridge.diagnostics",
    group: "PanelBridge Integration",
    label: "PanelBridge diagnostics",
    description:
      "View the mod's debug log and stats, and run item/vehicle catalog scans.",
  },
  {
    key: "bridge.command",
    group: "PanelBridge Integration",
    label: "Run any PanelBridge action",
    description:
      "The unrestricted passthrough behind every in-game tool, including ones with no dedicated button.",
  },

  // --- Player Authority ---
  {
    key: "players.moderate",
    group: "Player Authority",
    label: "Discipline players",
    description: "Ban, unban, kick or whitelist a player.",
  },
  {
    key: "players.gm_tools",
    group: "Player Authority",
    label: "Game-master tools",
    description:
      "Spawn items, teleport, and similar trusted event-runner actions.",
  },
  {
    key: "players.view",
    group: "Player Authority",
    label: "View player info",
    description: "Read player details, status and history.",
  },

  // --- Mods ---
  {
    key: "mods.manage",
    group: "Mods",
    label: "Manage mods",
    description: "Track, install and configure Workshop mods.",
  },

  // --- Automation ---
  {
    key: "automation.manage",
    group: "Automation",
    label: "Manage scheduled tasks",
    description: "Create and edit automated restarts, backups and other scheduled jobs.",
  },

  // --- Integrations ---
  {
    key: "integrations.manage",
    group: "Integrations",
    label: "Manage integrations",
    description: "Configure the Discord bot and similar external hooks.",
  },

  // --- Infrastructure ---
  {
    key: "docker.manage",
    group: "Infrastructure",
    label: "Manage the Docker container",
    description: "View status/stats and start, stop or restart the game server's container.",
  },
  {
    key: "chunks.manage",
    group: "Infrastructure",
    label: "Manage map chunks",
    description: "Clean up or delete map chunk regions, and configure the chunk save path.",
  },
  {
    key: "serverfiles.manage",
    group: "Infrastructure",
    label: "Manage server files",
    description: "Edit sandbox options, spawn points and other server config files.",
  },

  // --- Panel Diagnostics & Settings ---
  {
    key: "diagnostics.manage",
    group: "Panel Diagnostics & Settings",
    label: "View panel diagnostics",
    description:
      "View logs, performance history, database maintenance tools and CORS diagnostics.",
  },
  {
    key: "panel.settings",
    group: "Panel Diagnostics & Settings",
    label: "Manage panel-wide settings",
    description: "Change CORS policy, mod-check interval and other app-level settings.",
  },
];

const CAPABILITY_KEYS = new Set(CAPABILITIES.map((c) => c.key));

export function isKnownCapability(key) {
  return typeof key === "string" && CAPABILITY_KEYS.has(key);
}

export function listCapabilitiesGrouped() {
  const groups = new Map();
  for (const cap of CAPABILITIES) {
    if (!groups.has(cap.group)) groups.set(cap.group, []);
    groups.get(cap.group).push({
      key: cap.key,
      label: cap.label,
      description: cap.description,
    });
  }
  return Array.from(groups.entries()).map(([group, capabilities]) => ({
    group,
    capabilities,
  }));
}

// The two capabilities lockout rule 1 protects: without at least one user
// holding each of these, the panel has no way to recover from a bad role
// edit through its own UI.
const RECOVERY_CAPABILITIES = ["roles.manage", "users.manage"];

// ============================================
// Default role seed (migration snapshot -- see file header)
// ============================================

// backups.download joins here even though it is a brand new capability
// with no prior requireRole call site to snapshot: GET /download/:name
// had NO gate at all before it (see routes/backup.js), so technician
// already had unrestricted access to it on every existing install, and
// technician already holds backups.manage -- the same trust level. Not
// granting it here would silently take away something this role could
// already do. moderator, which never held backups.manage and never had
// a deliberate grant to this route either, does NOT get it -- that gap
// is the actual vulnerability this capability closes.
const TECHNICIAN_CAPABILITIES = [
  "backups.manage",
  "backups.download",
  "server.control",
  "server.install",
  "server.configure",
  "server.world_events",
  "rcon.execute",
  "servers.manage",
  "templates.manage",
  "bridge.setup",
  "bridge.diagnostics",
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "mods.manage",
  "automation.manage",
  "integrations.manage",
  "docker.manage",
  "chunks.manage",
  "serverfiles.manage",
];

// server.world_events joins here too (not just players.gm_tools/moderate/view):
// weather/climate/zombie-horde/broadcast-message routes were previously
// reachable by any signed-in role including moderator with no gate at all,
// same as the players.* routes -- folding them in is adding a capability
// that already existed as "no gate", not narrowing anything (see god's
// ruling: "adding a capability is not restricting it").
const MODERATOR_CAPABILITIES = [
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "server.world_events",
];

export const DEFAULT_ROLE_CAPABILITIES = Object.freeze({
  admin: Object.freeze(CAPABILITIES.map((c) => c.key)),
  technician: Object.freeze(TECHNICIAN_CAPABILITIES),
  moderator: Object.freeze(MODERATOR_CAPABILITIES),
});

// ============================================
// requirePermission middleware -- FAILS CLOSED
// ============================================

/**
 * Express middleware factory. Unlike requireRole (a role-name check),
 * this resolves the caller's role row from the database and checks its
 * capabilities array. Every failure path refuses -- there is no branch
 * that falls through to next() on anything other than a confirmed grant:
 *   - capability not in the catalogue -> refuse (logged as a bug, not an
 *     access decision -- this should only happen from a typo at a call site)
 *   - req.user missing -> refuse (401). This used to pass through on the
 *     theory that authService.middleware() only ever left req.user unset
 *     when auth was intentionally off (setup pending / auth disabled),
 *     so there was nothing left to check. That precondition silently
 *     stopped being true for a whole URL prefix -- middleware() started
 *     exempting /api/auth/* from authentication entirely without also
 *     exempting it from this gate, so "no req.user" started meaning
 *     "nobody checked" instead of "auth is off", and every
 *     requirePermission-gated route under that prefix admitted every
 *     request. middleware() now sets an explicit req.user even when auth
 *     is disabled (see services/auth.js), so this function no longer
 *     needs -- or trusts -- an implicit meaning for absence.
 *   - no role row matches req.user.role -> refuse (role renamed/deleted
 *     out from under an active session)
 *   - role.capabilities is missing or not an array -> refuse
 *   - capability not present in role.capabilities -> refuse
 *   - any unexpected error resolving the role -> refuse, not fall open
 */
export function requirePermission(capability) {
  if (!isKnownCapability(capability)) {
    // Programming error at the call site (typo, renamed capability never
    // updated here) -- fail closed for every request rather than only
    // logging once at import time, since a module-load-time throw would
    // crash the whole route file for an error that's really about one
    // route. See permissionsFailClosed.test.js.
    log.error(
      `requirePermission() called with an unregistered capability: "${capability}" -- refusing every request to this route until fixed.`,
    );
    return (req, res) => {
      res.status(403).json({
        error: "Insufficient permissions",
        code: ErrorCode.PERMISSION_DENIED,
      });
    };
  }

  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required",
        code: ErrorCode.AUTH_REQUIRED,
      });
    }

    try {
      const role = await getRoleByName(req.user.role);
      if (!role || !Array.isArray(role.capabilities)) {
        return res.status(403).json({
          error: "Insufficient permissions",
          code: ErrorCode.PERMISSION_DENIED,
        });
      }
      if (!role.capabilities.includes(capability)) {
        return res.status(403).json({
          error: "Insufficient permissions",
          code: ErrorCode.PERMISSION_DENIED,
        });
      }
      return next();
    } catch (error) {
      log.error(`requirePermission("${capability}") failed: ${error.message}`);
      return res.status(403).json({
        error: "Insufficient permissions",
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
  };
}

/**
 * A role's effective capabilities, for a client-side UX check (e.g. "should
 * this tab be visible") -- NOT an access-control decision. requirePermission()
 * above remains the only thing that actually enforces anything server-side;
 * this exists so routes exposing the caller's own user object (login,
 * refresh, /auth/me) can resolve capabilities the identical way
 * requirePermission() does, instead of each hand-rolling its own lookup.
 * Returns null (not []) when the role can't be resolved -- a renamed/deleted
 * role, or a lookup failure -- so callers can tell "no capabilities" apart
 * from "couldn't find out." Never throws.
 */
async function getCapabilitiesForRole(roleName) {
  try {
    const role = await getRoleByName(roleName);
    return role && Array.isArray(role.capabilities) ? role.capabilities : null;
  } catch {
    return null;
  }
}

// ============================================
// Role data access
// ============================================
// getRoles/getRoleById/getRoleByName/getUsersForRole are re-exported here
// (imported from database/init.js above) so route/service callers only
// ever need to import from this file, not from the data layer directly.
// RECOVERY_CAPABILITIES is exported as the shared POLICY, not as shared logic.
// The counting differs legitimately by operation — editing a role asks whether
// its members collectively drop a capability to zero holders, while reassigning
// one user asks whether everybody else still covers it — so callers write their
// own count. What must never be duplicated is WHICH capabilities are the ones
// that can lock an operator out: a second hardcoded copy of that list silently
// stops protecting anything the day a third capability is added here.
export {
  getRoles,
  getRoleById,
  getRoleByName,
  getUsersForRole,
  getCapabilitiesForRole,
  RECOVERY_CAPABILITIES,
};

async function countUsersWithCapability(capability, excludingRoleId = null) {
  const roles = await getRoles();
  const users = await getUsersForRoleAccounting();
  const grantingRoleIds = new Set(
    roles
      .filter(
        (r) =>
          String(r.id) !== String(excludingRoleId) &&
          Array.isArray(r.capabilities) &&
          r.capabilities.includes(capability),
      )
      .map((r) => String(r.id)),
  );
  const grantingRoleNames = new Set(
    roles
      .filter(
        (r) =>
          String(r.id) !== String(excludingRoleId) &&
          r.isSeeded &&
          Array.isArray(r.capabilities) &&
          r.capabilities.includes(capability),
      )
      .map((r) => r.name),
  );
  let count = 0;
  for (const u of users) {
    if (u.roleId && grantingRoleIds.has(String(u.roleId))) count++;
    else if (!u.roleId && grantingRoleNames.has(u.role)) count++;
  }
  return count;
}

// Returns null when valid, otherwise { message, capability } -- capability
// is only set when there's an actual offending value to report (the
// not-an-array case has none), so callers can build the INVALID_CAPABILITY
// `params` object without a placeholder value to fill.
function validateCapabilitiesArray(capabilities) {
  if (!Array.isArray(capabilities)) {
    return { message: "capabilities must be an array" };
  }
  const unknown = capabilities.filter((c) => !isKnownCapability(c));
  if (unknown.length > 0) {
    return { message: `Unknown capability: ${unknown[0]}`, capability: unknown[0] };
  }
  return null;
}

function makeError(code, message, status = 400, params) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (params) err.params = params;
  return err;
}

// ============================================
// Role CRUD -- lockout rules enforced here
// ============================================

export async function listRolesWithMemberCounts() {
  const roles = await getRoles();
  const withCounts = [];
  for (const role of roles) {
    const members = await getUsersForRole(role);
    withCounts.push({ ...role, memberCount: members.length });
  }
  return withCounts;
}

export async function createRole({ name, capabilities }) {
  if (typeof name !== "string" || !name.trim()) {
    throw makeError(null, "name is required", 400);
  }
  const trimmedName = name.trim();
  const capError = validateCapabilitiesArray(capabilities);
  if (capError) {
    throw makeError(
      ErrorCode.INVALID_CAPABILITY,
      capError.message,
      400,
      capError.capability !== undefined ? { capability: capError.capability } : undefined,
    );
  }

  const existingRoles = await getRoles();
  if (existingRoles.some((r) => r.name === trimmedName)) {
    throw makeError(
      ErrorCode.ROLE_NAME_TAKEN,
      `A role named "${trimmedName}" already exists`,
      409,
      { name: trimmedName },
    );
  }

  const role = {
    id: `role-${randomToken()}`,
    name: trimmedName,
    capabilities: [...new Set(capabilities)],
    isSeeded: false,
    createdAt: new Date().toISOString(),
  };
  await insertRole(role);
  return role;
}

/**
 * Rule 1 (hard block, capability check not role-name check): refuse any
 * change that would leave zero users holding roles.manage or zero users
 * holding users.manage.
 * Rule 2 (soft block): if the ACTING user would lose a recovery
 * capability they currently hold, but at least one other user would still
 * hold it (so rule 1 doesn't already block it), require
 * confirmSelfCapabilityLoss: true.
 */
async function checkLockoutRulesForCapabilityChange({
  roleId,
  existingCapabilities,
  nextCapabilities,
  actingUser,
  confirmSelfCapabilityLoss,
}) {
  for (const capability of RECOVERY_CAPABILITIES) {
    const currentlyGrants = existingCapabilities.includes(capability);
    const willStillGrant = nextCapabilities.includes(capability);
    // Nothing is being taken away for this capability -- either the role
    // never granted it (editing an unrelated role must not trip this check
    // just because its own capability list happens not to include
    // roles.manage/users.manage) or it still grants it after the change.
    if (!currentlyGrants || willStillGrant) continue;

    const othersWithCapability = await countUsersWithCapability(capability, roleId);
    if (othersWithCapability === 0) {
      throw makeError(
        ErrorCode.ROLE_LOCKOUT_LAST_MANAGER,
        `This change would leave no user able to ${
          capability === "roles.manage" ? "manage roles" : "manage user accounts"
        }.`,
        409,
        // `action` carries the stable capability key, not English prose --
        // the client resolves it through capabilities.<key>.label in
        // client/src/locales/*/roles.json, the same catalogue the matrix
        // UI renders from. See errorMessage.ts's CAPABILITY_KEY_PARAM_NAMES.
        { action: capability },
      );
    }

    if (actingUser) {
      // actingUser.role (from the JWT payload) IS how requirePermission()
      // itself resolves a role today -- so "is the acting user in the role
      // being edited" is exactly "does their role's id match roleId".
      const actingRole = await getRoleByName(actingUser.role);
      const actingUserIsInThisRole =
        actingRole && String(actingRole.id) === String(roleId);
      if (actingUserIsInThisRole && !confirmSelfCapabilityLoss) {
        throw makeError(
          ErrorCode.ROLE_SELF_CAPABILITY_LOSS_CONFIRM,
          `This would remove your own ability to ${
            capability === "roles.manage" ? "manage roles" : "manage user accounts"
          }. Set confirmSelfCapabilityLoss: true to proceed anyway.`,
          409,
          { action: capability },
        );
      }
    }
  }
}

export async function updateRole(
  id,
  { name, capabilities },
  { actingUser, confirmSelfCapabilityLoss = false } = {},
) {
  const roles = await getRoles();
  const existing = roles.find((r) => String(r.id) === String(id));
  if (!existing) {
    throw makeError(ErrorCode.ROLE_NOT_FOUND, "Role not found", 404);
  }

  const nextName = typeof name === "string" && name.trim() ? name.trim() : existing.name;

  // requirePermission() resolves a user's capabilities via
  // getRoleByName(req.user.role) -- a plain string match against every
  // current member's OWN user.role field, not roleId (see
  // changeUserRoleById's and reassignRoleMembers's own comments for the
  // same constraint). A seeded role's name is also load-bearing elsewhere
  // as a fixed string: USER_ROLES/DEFAULT_ROLE_CAPABILITIES key in
  // auth.js/permissions.js, and getUsersForRole()/reassignRoleMembers()
  // both match a seeded role's members by `u.role === role.name`. Renaming
  // "admin" here -- nothing above blocked it -- would desync the roles
  // collection's row from every admin's stored role string in one write:
  // getRoleByName("admin") then finds nothing, and every admin fails every
  // requirePermission check on their very next request. That is a total,
  // immediate self-lockout that completely bypasses the recovery-lockout
  // rules below, because those only fire on a CAPABILITIES change -- a
  // name-only edit trips neither rule 1 nor rule 2. Refuse it outright,
  // the same way deleteRole() already refuses to delete a seeded role.
  if (existing.isSeeded && nextName !== existing.name) {
    throw makeError(null, "Built-in roles cannot be renamed.", 403);
  }

  if (roles.some((r) => String(r.id) !== String(id) && r.name === nextName)) {
    throw makeError(
      ErrorCode.ROLE_NAME_TAKEN,
      `A role named "${nextName}" already exists`,
      409,
      { name: nextName },
    );
  }

  let nextCapabilities = existing.capabilities;
  if (capabilities !== undefined) {
    const capError = validateCapabilitiesArray(capabilities);
    if (capError) {
      throw makeError(
        ErrorCode.INVALID_CAPABILITY,
        capError.message,
        400,
        capError.capability !== undefined ? { capability: capError.capability } : undefined,
      );
    }
    nextCapabilities = [...new Set(capabilities)];

    await checkLockoutRulesForCapabilityChange({
      roleId: id,
      existingCapabilities: existing.capabilities,
      nextCapabilities,
      actingUser,
      confirmSelfCapabilityLoss,
    });
  }

  const updated = {
    ...existing,
    name: nextName,
    capabilities: nextCapabilities,
    updatedAt: new Date().toISOString(),
  };
  await replaceRoleById(id, updated);

  // A custom role's name just changed under its current members' feet --
  // propagate it to every user.role string that pointed at the OLD name,
  // the exact same write reassignRoleMembers() already does when moving
  // members to a DIFFERENT role. Without this, getRoleByName(req.user.role)
  // finds nothing for any of them until an admin notices and reassigns
  // each one by hand. Only the roleId branch is needed here (unlike
  // getUsersForRole()'s own isSeeded-name fallback): a seeded role can
  // never reach this line, it was refused above.
  if (nextName !== existing.name) {
    const db = await getDb();
    const users = db.data.users || [];
    let changed = false;
    for (const u of users) {
      if (String(u.roleId) === String(existing.id)) {
        u.role = nextName;
        changed = true;
      }
    }
    if (changed) await commitNow();
  }

  return updated;
}

/**
 * Rule 0: a seeded role (admin/technician/moderator) can never be deleted,
 * independent of member count -- this used to be enforced ONLY by
 * RolesPermissions.tsx disabling the delete button for isSeeded roles,
 * which meant a seeded role with zero current members (e.g. every admin
 * reassigned to a custom role first) could be deleted outright via a
 * direct DELETE /roles/:id call, requiring only roles.manage, not
 * users.manage -- the same "wipe out the ability to administer the panel"
 * catastrophe the recovery-lockout rules below exist to prevent, reached
 * by deleting the ROLE DEFINITION instead of removing its last manager's
 * membership. See docs/qa/kevin-access-control-french-usability.md
 * Finding 1. The guard belongs here, in the service every caller goes
 * through, not only in the one route or the one screen that happens to
 * call it today.
 *
 * Rule 3: refuse to delete a role with members unless reassignTo names
 * another role -- then every affected user is moved there first.
 * Rule 1 also applies here: deleting a role is a capability change to
 * "no capabilities" for its members, so the same recovery-capability
 * check runs against the reassignment target (or against nothing granted,
 * if there is no reassignTo and no members -- vacuously safe).
 */
export async function deleteRole(id, { reassignTo, actingUser } = {}) {
  const role = await getRoleById(id);
  if (!role) {
    throw makeError(ErrorCode.ROLE_NOT_FOUND, "Role not found", 404);
  }
  if (role.isSeeded) {
    throw makeError(
      ErrorCode.ROLE_IS_SEEDED,
      "Built-in roles cannot be deleted.",
      403,
    );
  }
  const members = await getUsersForRole(role);

  if (members.length > 0 && !reassignTo) {
    throw makeError(
      ErrorCode.ROLE_HAS_MEMBERS,
      `${members.length} user(s) still hold this role. Pass reassignTo to move them to another role first.`,
      409,
      { count: members.length },
    );
  }

  let targetRole = null;
  if (reassignTo) {
    targetRole = await getRoleById(reassignTo);
    if (!targetRole) {
      throw makeError(ErrorCode.ROLE_NOT_FOUND, "reassignTo role not found", 404);
    }
  }

  // Deleting this role removes its capabilities from every current member;
  // check the recovery invariant as if they were being moved to
  // targetRole's capability set (or to nothing, if there's no reassignTo).
  if (members.length > 0) {
    await checkLockoutRulesForCapabilityChange({
      roleId: role.id,
      existingCapabilities: role.capabilities,
      nextCapabilities: targetRole ? targetRole.capabilities : [],
      actingUser,
      confirmSelfCapabilityLoss: true, // deletion is explicit; rule 2's confirm is implied by the delete action itself
    });
  }

  let reassigned = 0;
  if (targetRole) {
    reassigned = await reassignRoleMembers(role, targetRole);
  }

  await removeRoleById(id);
  return { deleted: true, reassigned, reassignedTo: targetRole?.id || null };
}

function randomToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
