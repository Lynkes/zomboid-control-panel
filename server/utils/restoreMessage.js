import { sanitizeError } from "./sanitize.js";

// The one restore failure whose absolute path must reach the operator
// intact: the swap failed AND the rollback failed, so the previous world is
// sitting in a renamed folder and this message is the only place that says
// where. backupService.js builds the message from this prefix; every place
// that shows a restore failure to a client decides with it.
export const RESTORE_ROLLBACK_FAILED_PREFIX =
  "Restore failed and the previous save could not be put back automatically.";

// A restore failure message as a client may see it. restoreBackup()'s own
// failure messages are almost all short and pathless, but an unexpected raw
// fs exception (ENOENT/EACCES) carries Node's default message, which
// includes a full absolute path -- redacted here like every other error
// response in the panel. A blanket sanitizeError() would also redact the
// rollback-failure message above, the single most important string in the
// whole restore flow when it fires, so that one passes through as-is.
// 2026-08-26 partial-failure-state hunt (moved here from routes/backup.js so
// GET /backup/status's lastRestore applies the same rule, GH#166).
export function publicRestoreMessage(message) {
  if (typeof message === "string" && message.startsWith(RESTORE_ROLLBACK_FAILED_PREFIX)) {
    return message;
  }
  return sanitizeError(message);
}
