import { ErrorCode } from "../utils/errorCodes.js";

// SECURITY (2026-10-20, access-control audit): while panel logins are off
// (authEnabled: false in db.json), services/auth.js's middleware hands every
// request an admin identity without a password. Account and role changes
// made then outlive the setting: anyone who could reach the panel could add
// an admin account (or a role, a recovery code, a new signing key) that
// still works after the operator turns logins back on. So these changes
// wait for logins, the same way the file manager does (routes/files.js,
// FM_AUTH_DISABLED). Reads stay available.
export const ACCOUNT_CHANGES_NEED_LOGINS_MESSAGE =
  "Accounts, roles and sign-in secrets can't be changed while panel logins are off: anyone who can reach the panel could add an admin that keeps working once logins are back on. To turn them on, remove the authEnabled: false setting from the panel's db.json (in its data folder), restart the panel, then sign in.";

export function requireLoginsOn(req, res, next) {
  if (req.user?.authDisabled) {
    return res.status(403).json({
      error: ACCOUNT_CHANGES_NEED_LOGINS_MESSAGE,
      code: ErrorCode.ACCOUNT_CHANGES_NEED_LOGINS,
    });
  }
  return next();
}
