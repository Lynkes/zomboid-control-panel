import { createLogger } from "../utils/logger.js";

const log = createLogger("SteamOperations");

// Extracted out of routes/server.js (hunt-wave5-2026-08-29, concurrency
// hunt) so serverManager.js's startServer() can check it too, without a
// circular import: routes/server.js already imports resolveLaunchMode from
// serverManager.js, so a reverse edge (serverManager.js importing FROM
// routes/server.js) would create a real cycle. This module sits below both
// -- routes/server.js and serverManager.js both import from here, neither
// imports from the other for this.
//
// Tracks in-flight SteamCMD operations (install/update/validate) per
// normalized install path. POST /install and POST /steam-update
// (routes/server.js) already guarded against a SECOND SteamCMD operation
// on the SAME path this way -- what was missing (see
// server/tests/startServerBlockedDuringSteamOperation.test.js) is that
// nothing checked this before SPAWNING THE PZ SERVER ITSELF: a Start or
// Restart could launch the JVM directly against an install directory
// SteamCMD was still mid-write to.
const activeSteamOperations = new Map();
export const STEAM_OPERATION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function isSteamOperationIdle(operation, now = Date.now()) {
  return Boolean(
    operation?.lastOutputAt &&
      now - operation.lastOutputAt >= STEAM_OPERATION_IDLE_TIMEOUT_MS,
  );
}

export function getActiveSteamOperations() {
  return activeSteamOperations;
}

export function clearActiveSteamOperation(normalizedPath) {
  const operation = activeSteamOperations.get(normalizedPath);
  if (operation?.watchdog) clearInterval(operation.watchdog);
  activeSteamOperations.delete(normalizedPath);
}

// True if a live SteamCMD process is still tracked for this exact
// normalized path. A tracked-but-dead entry (the process exited without
// this module's own 'close' handler clearing it -- shouldn't normally
// happen, but this must not trust stale bookkeeping either way) is
// verified with a signal-0 liveness probe and self-heals by clearing the
// stale entry rather than reporting a false positive forever.
export function hasActiveSteamOperation(normalizedPath) {
  const operation = activeSteamOperations.get(normalizedPath);
  if (!operation) return false;

  if (Number.isInteger(operation.pid)) {
    try {
      process.kill(operation.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") {
        clearActiveSteamOperation(normalizedPath);
        log.warn(
          `Cleared stale Steam ${operation.type} operation for ${normalizedPath}`,
        );
        return false;
      }
    }
  }

  return true;
}
