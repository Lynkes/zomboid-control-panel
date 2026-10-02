import { createLogger } from "./logger.js";

const log = createLogger("ProcessScan");

// One failed process scan is "don't know yet", not an answer, for a flow
// that is already under way. GH #190: a scheduled restart saved, sent
// `quit`, hit ONE unreadable Windows scan while the old JVM was exiting, and
// gave up -- leaving the server down until someone noticed. The post-start
// wait has always tolerated a failed sample; the waits for the old process
// to exit now do too.
//
// Retrying never acts on an unknown state; it only asks again. A flow that
// gets no answer after every attempt still fails closed exactly as before:
// it treats the state as unknown and never starts a second server over one
// that may still be running.
export const SCAN_RETRY_ATTEMPTS = 5;
export const SCAN_RETRY_DELAY_MS = 1500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls `read` (a getServerProcessDetails()-shaped check) until it answers
 * with something other than a failed scan: up to `attempts` times,
 * `delayMs` apart, and -- when `maxElapsedMs` is set -- never starting an
 * attempt that would begin past it (a scan that hangs until its own timeout
 * shouldn't hold a waiting request five times over). Resolves to the first
 * answer that isn't scanFailed, or, when none came, to the last one, still
 * marked `scanFailed: true`. A `read` that resolves to nothing counts as a
 * failed scan; one that throws is not caught, as before.
 */
export async function readProcessStateWithRetry(
  read,
  {
    attempts = SCAN_RETRY_ATTEMPTS,
    delayMs = SCAN_RETRY_DELAY_MS,
    maxElapsedMs = Infinity,
    sleep = defaultSleep,
    context = "Process check",
  } = {},
) {
  const startedAt = Date.now();
  let details = null;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    details = await read();
    if (details && !details.scanFailed) {
      if (attempt > 1) {
        log.info(
          `${context}: process detection answered on attempt ${attempt} of ${attempts}`,
        );
      }
      return details;
    }
    if (attempt >= attempts) break;
    if (Date.now() - startedAt + delayMs >= maxElapsedMs) break;
    log.debug(
      `${context}: process detection could not tell (attempt ${attempt} of ${attempts}), asking again in ${delayMs}ms`,
    );
    await sleep(delayMs);
  }
  log.warn(
    `${context}: process detection failed ${attempt} time(s) in a row, so the server's state is unknown`,
  );
  return {
    running: false,
    ...(details && typeof details === "object" ? details : {}),
    scanFailed: true,
  };
}
