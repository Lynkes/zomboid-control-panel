import { getActiveServer } from "../database/init.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ConfigMutationGuard");

export async function requireStoppedForLocalConfigMutation(req, res, next) {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager");
    if (typeof serverManager?.checkServerRunning !== "function") {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Cannot verify whether the server is stopped. Try again shortly.",
      });
    }

    if (await serverManager.checkServerRunning()) {
      return res.status(409).json({
        code: "SERVER_RUNNING",
        error: "Stop the server before editing configuration.",
      });
    }

    return next();
  } catch (error) {
    log.warn(
      `Could not verify server state before config mutation: ${error.message}`,
    );
    return res.status(503).json({
      code: "SERVER_STATE_UNKNOWN",
      error: "Cannot verify whether the server is stopped. Try again shortly.",
    });
  }
}
