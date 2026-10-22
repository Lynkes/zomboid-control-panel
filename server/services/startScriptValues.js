import { ErrorCode } from "../utils/errorCodes.js";
import { startScriptValueProblem } from "../utils/startScriptQuoting.js";

/**
 * The response body for an admin password the start scripts cannot carry
 * (null when it can): refused where it is saved (POST/PUT /api/servers,
 * /install, /quick-setup), so a script never has to drop or change a
 * character of it. Any other password -- % ! & $ ' ` \ spaces -- is written
 * into the scripts exactly as typed.
 */
export function adminPasswordStartScriptRefusal(adminPassword) {
  if (!adminPassword || !startScriptValueProblem(adminPassword)) return null;
  return {
    error:
      "The admin password can't contain a double quote or a control character (such as a line break), because the server's start script can't carry it safely. Choose a different password.",
    code: ErrorCode.ADMIN_PASSWORD_UNSUPPORTED_CHARACTERS,
  };
}
