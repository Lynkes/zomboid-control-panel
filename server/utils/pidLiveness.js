/**
 * Shared pid-liveness primitive.
 *
 * fileWriteQueue.js's writeFileAtomic sweep and backupService.js's
 * cleanupOrphanBackupTemps sweep both need to answer the same question --
 * "is the process that created this temp file still running?" -- before
 * deleting a file whose owner might still be mid-write. They used to carry
 * two byte-identical copies of this function (hunt-wave12, 2026-08-30);
 * this module is the one place that logic now lives.
 *
 * pidLock.js's mutual-exclusion startup lock needs the identical answer to
 * a differently-phrased question -- "is the panel instance that wrote this
 * lock file still running?" -- and used to carry a THIRD, undeduplicated
 * copy that got the ambiguous-error direction backwards (treated an
 * inconclusive signal as "not alive," i.e. safe to proceed and start a
 * second instance). Folded onto this shared primitive bughunt-2026-08-31-c,
 * both removing that copy and correcting its direction: pidLock.js's
 * mutual-exclusion use case has the OPPOSITE cost asymmetry from a temp-file
 * sweep (a false proceed there risks port conflicts and db.json corruption;
 * a false refusal is a one-step recovery, delete-the-lock-and-restart) but
 * the SAME resolution -- an inconclusive signal must fail toward "still
 * alive," never toward "safe to act." This really is the one place the
 * check lives now, not an aspiration.
 *
 * process.kill(pid, 0) is the standard way to probe for a running process
 * without signaling it: confirmed on this platform and on Linux to throw
 * ESRCH for a pid that is not running, and to not throw (or to throw EPERM,
 * for a pid this process doesn't own) for one that is. Any outcome other
 * than a confirmed ESRCH is treated as "still alive" -- an ambiguous signal
 * never authorises the caller's own destructive/exclusive action (deleting
 * an orphan temp; starting a second panel instance), even at the cost of
 * occasionally waiting out a truly-dead process's evidence a little longer.
 *
 * Deliberately does NOT decide how a caller extracts a pid from a filename
 * or a lock file, or what to do with a value that doesn't parse to one at
 * all -- that stays with each caller, since the shapes they read from don't
 * uniformly embed a pid the same way (see backupService.js's
 * CENTRAL_TEMP_PATTERN vs. its *.zip.tmp pattern-only branch, which has no
 * pid to check and must not be given one just to fit this helper).
 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
