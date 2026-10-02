import { createLogger } from "./logger.js";

const log = createLogger("ProcessScan");

// One failed process scan is "don't know yet", not an answer, for a flow
// that is already under way. GH #190: a scheduled restart saved, sent
// `quit`, hit ONE unreadable Windows scan while the old JVM was exiting, and
// gave up -- leaving the server down until someone noticed. The post-start
// wait has always tolerated a failed sample; the waits for the old process
// to exit now do too (waitForProcessExit()), and so does the one look that
// confirms a kill (readProcessStateWithRetry()).
//
// Neither ever acts on an unknown state; they only ask again. A flow that
// still has no answer at the end fails closed exactly as before: it treats
// the state as unknown and never starts a second server over one that may
// still be running.
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

// The processes a wait may look for by PID: all of them, or none when any
// one has no PID to look for.
function trackableProcesses(processes) {
  const list = Array.isArray(processes) ? processes : [];
  if (list.length === 0) return [];
  if (!list.every((entry) => /^\d+$/.test(String(entry?.pid ?? "")))) return [];
  return list.map((entry) => ({
    pid: String(entry.pid),
    startedMs: entry.startedMs ?? null,
  }));
}

// Same process: same PID and, when both sides know it, the same start time
// -- a PID Windows has since handed to a new process is not the old one.
function isSameProcess(row, known) {
  if (String(row?.pid) !== known.pid) return false;
  if (row?.startedMs == null || known.startedMs == null) return true;
  return Number(row.startedMs) === Number(known.startedMs);
}

/**
 * Waits for a server that was just told to stop to exit: asks `read` (a
 * getServerProcessDetails()-shaped check) once, then -- while the answer
 * isn't a confirmed stop -- up to `polls` more times, `intervalMs` apart,
 * starting none past `maxElapsedMs` (a scan that runs into its own timeout
 * must not stretch the wait `polls` times over).
 *
 * A failed scan is "don't know yet" here, not the answer (GH #190): the old
 * JVM is exiting right now, the moment a Windows scan is most likely to
 * catch it half gone, so a failed sample spends one poll of the budget the
 * same as a "still running" one, and the wait goes on. Only the answer the
 * wait ends on counts. Resolves to it -- stopped, still `running`, or still
 * `scanFailed` (a `read` that resolved to nothing counts as one) -- and the
 * caller decides what an unconfirmed stop means; this never acts on one. A
 * `read` that throws is not caught.
 *
 * `alsoWaitWhile`, asked after every sample, keeps the wait going while it
 * says true (restartServer()'s check that the JVM binary is still busy).
 *
 * `ownProcesses` -- the server's own processes ({ pid, startedMs? }), from a
 * scan taken before it was told to stop -- settle one kind of unknown: a
 * Windows scan whose only doubt is processes listed with no command line
 * (`unreadable`, see ServerManager._scanWindowsServerProcesses()). When none
 * of those is one of the server's own, its processes are all gone, so it
 * has stopped -- whatever else on the host the panel can't read (an
 * elevated Jenkins, another user's JVM).
 */
export async function waitForProcessExit(
  read,
  {
    polls = 30,
    intervalMs = 1000,
    maxElapsedMs = Infinity,
    sleep = defaultSleep,
    context = "Process check",
    ownProcesses = [],
    alsoWaitWhile = () => false,
  } = {},
) {
  const own = trackableProcesses(ownProcesses);
  const settle = (details) => {
    if (!details || typeof details !== "object") {
      return { running: false, scanFailed: true };
    }
    const unreadable = Array.isArray(details.unreadable) ? details.unreadable : [];
    if (!details.scanFailed || own.length === 0 || unreadable.length === 0) {
      return details;
    }
    if (unreadable.some((row) => own.some((known) => isSameProcess(row, known)))) {
      return details;
    }
    log.info(
      `${context}: the server's own process(es) (PID ${own.map((known) => known.pid).join(", ")}) are gone; the PID(s) process detection can't read (${unreadable.map((row) => row.pid).join(", ")}) are not among them, so the server counts as stopped`,
    );
    return { ...details, running: false, scanFailed: false };
  };

  const startedAt = Date.now();
  let unknownSamples = 0;
  let poll = 0;
  for (;;) {
    const details = settle(await read());
    const busy = Boolean(alsoWaitWhile());
    if (details.scanFailed) {
      unknownSamples += 1;
    } else if (!details.running && !busy) {
      if (unknownSamples > 0) {
        log.info(
          `${context}: the server's exit was confirmed after process detection could not tell ${unknownSamples} time(s)`,
        );
      }
      return details;
    }
    if (poll >= polls || Date.now() - startedAt + intervalMs >= maxElapsedMs) {
      if (details.scanFailed) {
        log.warn(
          `${context}: process detection still could not tell whether the server exited after ${poll + 1} look(s) (${unknownSamples} unanswered), so its state is unknown`,
        );
      }
      return details;
    }
    if (details.scanFailed) {
      log.debug(
        `${context}: process detection could not tell (look ${poll + 1}), asking again in ${intervalMs}ms`,
      );
    }
    await sleep(intervalMs);
    poll += 1;
  }
}
