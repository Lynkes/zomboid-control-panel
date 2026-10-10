import fs from "fs";

// Codes that mean "something else has a momentary handle on the file" -- an
// antivirus scanner, the search indexer, a backup agent -- rather than a
// permanent failure. Windows reports that contention as EPERM as often as
// EBUSY; EACCES is the same shape from a transient permission check. Anything
// else (ENOENT, ENOSPC, EXDEV, ...) is not going to clear by waiting, so it is
// thrown at once.
const TRANSIENT_RENAME_ERROR_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fs.renameSync() that waits out a short-lived lock on either path: up to
 * `attempts` tries with a growing pause between them (about 1.5 s in all with
 * the defaults), only for the transient codes above. The last error is thrown.
 *
 * `rename` and `sleep` are injectable for tests.
 */
export async function renameWithRetry(
  from,
  to,
  {
    attempts = 5,
    delayMs = 100,
    rename = (source, target) => fs.renameSync(source, target),
    sleep = defaultSleep,
    onRetry,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT_RENAME_ERROR_CODES.has(error?.code)) {
        throw error;
      }
      onRetry?.(error, attempt);
      await sleep(delayMs * attempt);
    }
  }
}
