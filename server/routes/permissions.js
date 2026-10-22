import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { requireLoginsOn } from "../middleware/requireLoginsOn.js";
import {
  requireAnyPermission,
  requirePermission,
  listCapabilitiesGrouped,
  listRolesWithMemberCounts,
  createRole,
  updateRole,
  deleteRole,
} from "../services/permissions.js";

const log = createLogger("API:Permissions");
const router = express.Router();

function respondWithServiceError(res, error, fallbackMessage) {
  if (error && error.status) {
    const body = { error: error.message || fallbackMessage };
    if (error.code) body.code = error.code;
    if (error.params) body.params = sanitizeErrorParams(error.params);
    return res.status(error.status).json(body);
  }
  log.error(`${fallbackMessage}: ${error.message}`);
  return res.status(500).json({ error: sanitizeError(error.message) });
}

// The role list is read by two pages: the matrix (roles.manage) and Panel
// Users (users.manage), whose role picker and lockout warnings need each
// role's id, name, built-in flag and capabilities. Reading it changes
// nothing, so either capability may; every route after the router.use()
// below -- the capability catalogue and every role write -- stays
// roles.manage's alone. (A users.manage-only role used to get a 403 here and
// an empty Users page: 2026-10-20 access-control audit.) Registered before
// that router.use() on purpose.
router.get("/roles", requireAnyPermission("roles.manage", "users.manage"), async (req, res) => {
  try {
    const roles = await listRolesWithMemberCounts();
    res.json({ roles });
  } catch (error) {
    respondWithServiceError(res, error, "Failed to list roles");
  }
});

// Every other route here needs roles.manage: this is the matrix itself, not
// a tool that reads/writes anything the matrix grants access to. Role
// writes also wait for panel logins (requireLoginsOn).
router.use(requirePermission("roles.manage"));

router.get("/capabilities", (req, res) => {
  res.json({ groups: listCapabilitiesGrouped() });
});

router.post("/roles", requireLoginsOn, async (req, res) => {
  try {
    const { name, capabilities } = req.body || {};
    const role = await createRole({ name, capabilities }, { actingUser: req.user });
    res.status(201).json({ success: true, role });
  } catch (error) {
    respondWithServiceError(res, error, "Failed to create role");
  }
});

router.put("/roles/:id", requireLoginsOn, async (req, res) => {
  try {
    const { name, capabilities, confirmSelfCapabilityLoss } = req.body || {};
    const role = await updateRole(
      req.params.id,
      { name, capabilities },
      { actingUser: req.user, confirmSelfCapabilityLoss: confirmSelfCapabilityLoss === true },
    );
    res.json({ success: true, role });
  } catch (error) {
    respondWithServiceError(res, error, "Failed to update role");
  }
});

router.delete("/roles/:id", requireLoginsOn, async (req, res) => {
  try {
    const reassignTo =
      typeof req.query.reassignTo === "string" ? req.query.reassignTo : undefined;
    const result = await deleteRole(req.params.id, {
      reassignTo,
      actingUser: req.user,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    respondWithServiceError(res, error, "Failed to delete role");
  }
});

export default router;
