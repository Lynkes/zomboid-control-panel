import { getActiveServer } from "../database/init.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ConfigMutationGuard");

// Refuses a request outright while the server is running. As of 2026-08-23
// this is used for WHOLESALE FILE OVERWRITES only (restoring a backup,
// applying a template) — see serverFiles.js's isLocalConfigOverwrite() and
// the comment above LOCAL_CONFIG_MUTATIONS for why those stay blocked while
// ordinary edits to the same files do not.
export async function requireStoppedForLocalConfigMutation(req, res, next) {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager");
    // getServerProcessDetails(), not checkServerRunning() -- the latter
    // discards the scan's own scanFailed flag and returns a plain boolean,
    // so a scan that completed but couldn't determine the server's state
    // (timeout, PowerShell/exec error) came back indistinguishable from
    // "confirmed stopped" and let this wholesale overwrite proceed, exactly
    // the case this guard exists to refuse. Same fail-open class already
    // fixed at /wipe, backup restore, and chunks.js's delete-chunks/
    // delete-region.
    if (typeof serverManager?.getServerProcessDetails !== "function") {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }

    const processDetails = await serverManager.getServerProcessDetails();
    if (processDetails.scanFailed) {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }

    if (processDetails.running) {
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
      error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
    });
  }
}

// Allows an ordinary local config edit through regardless of server state —
// the operator ruled 2026-08-23 that these should always be permitted, on
// the understanding that a write while the server is running does not take
// effect in the live game until it restarts (see serverFiles.js's
// LOCAL_CONFIG_MUTATIONS comment for the measurement behind that ruling and
// what it does/doesn't cover). This function's only job is to tell each
// route handler, via req.configEditRestartWarning, whether it should say so
// in its response — it never blocks.
//
// "Cannot verify" is treated the same as "running", not as "stopped": the
// 1.2.0 release fixed exactly this class of bug elsewhere in the panel (a
// server-state check that silently meant "assume stopped" when it couldn't
// tell), and defaulting to warn is the harmless direction to be wrong in —
// an unnecessary warning costs a reader a sentence; a missing one costs them
// a config change they believe took effect and didn't.
export async function warnRunningForLocalConfigEdit(req, res, next) {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager");
    if (typeof serverManager?.checkServerRunning !== "function") {
      req.configEditRestartWarning = true;
      return next();
    }

    const running = await serverManager
      .checkServerRunning()
      .catch(() => true);
    req.configEditRestartWarning = running !== false;
    return next();
  } catch (error) {
    log.warn(
      `Could not verify server state before config edit: ${error.message}`,
    );
    req.configEditRestartWarning = true;
    return next();
  }
}
