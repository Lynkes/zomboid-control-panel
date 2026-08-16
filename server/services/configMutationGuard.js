import { getActiveServer } from "../database/init.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ConfigMutationGuard");

export async function requireStoppedForLocalConfigMutation(req, res, next) {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager");
    if (typeof serverManager?.checkServerRunning !== "function") {
      return next();
    }

    // The server can accept config edits while running because the INI file is
    // saved immediately and the game reads it again on reboot. Blocking the
    // mutation here creates a false negative for a valid operation.
    return next();
  } catch (error) {
    log.warn(
      `Could not verify server state before config mutation: ${error.message}`,
    );
    return next();
  }
}
