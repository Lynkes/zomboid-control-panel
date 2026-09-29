import { ApiError, backupApi, type BackupStatus, type RestoreOutcome } from '@/lib/api'

// GH#166: a restore's outcome used to live only in the response to the POST
// that started it -- a request held open for the whole pre-restore backup,
// extraction and verification, which on a big world can run for many
// minutes. When that response never arrives (the 10-minute client timeout,
// a reverse proxy giving up on a long request, the connection dropping),
// the page used to either report a failure for a restore that was still
// running, or wait on nothing. The server now records every restore's
// outcome in GET /backup/status under the id the page picked, so a page
// whose response went missing reads the outcome back instead of guessing.

// How often a page re-reads the status while a restore it's showing is
// running without a response of its own to wait on.
export const RESTORE_STATUS_POLL_MS = 5000

// How long reading the outcome back may keep failing (the panel restarting
// or unreachable) before the page stops waiting and says it couldn't tell,
// and how many failed reads in a row that also takes: a laptop that slept
// through part of it is past the time on its first read after waking,
// while its network is still coming back.
const STATUS_UNREACHABLE_GIVE_UP_MS = 10 * 60 * 1000
const STATUS_UNREACHABLE_GIVE_UP_READS = 3

// How many reads in a row may show no restore running and none recorded as
// this one before the page takes it as never started, or lost. An answer
// lost early (a proxy's quick 502, a reset connection) can come back before
// the panel has marked the restore running: the route first checks the
// active server and scans for the game's process (up to 8 s on Windows,
// 16 s elsewhere). Reads are RESTORE_STATUS_POLL_MS apart, so 5 span 20 s.
const ABSENT_READS_BEFORE_UNKNOWN = 5

// Thrown when neither the POST's response nor the status could say how the
// restore ended: the panel restarted mid-restore (its record of the restore
// went with it), or it stayed unreachable. Not a failure -- the restore may
// well have finished -- so pages word it as "couldn't confirm".
export class RestoreOutcomeUnknownError extends Error {
  constructor() {
    super('The restore outcome could not be confirmed')
    this.name = 'RestoreOutcomeUnknownError'
  }
}

// Thrown when something in front of the panel (a proxy, a tunnel) refused
// the request with an error status of its own, and the status shows the
// panel never ran this restore. That refusal's body is usually a whole HTML
// error page, not a reason to put in front of an operator, so pages say it
// in their own words, with the HTTP status the proxy gave.
export class RestoreNotStartedError extends Error {
  status: number
  constructor(status: number) {
    super('Something in front of the panel refused the restore request; the restore did not start')
    this.name = 'RestoreNotStartedError'
    this.status = status
  }
}

// An id for one restore request, echoed back in the status's
// currentRestore/lastRestore. getRandomValues (unlike randomUUID) also
// exists on a panel opened over plain http from another machine.
export function newRestoreRequestId(): string {
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// What a failed restore request says about the restore.
// 'answered': the panel itself answered -- every response it sends is a
// JSON object ({ error, code? }, or the restore's own { success, message })
// -- and that answer is the outcome: a refusal, or a restore that ran and
// failed.
// 'lost': no answer at all (a timeout, a dropped connection), or a 5xx
// that isn't the panel's own -- a reverse proxy or tunnel giving up on the
// panel (Cloudflare's 524 after about 100 s, its 520/522, nginx's 502/504)
// with an HTML, plain-text or empty body. Says nothing about whether the
// restore ran, or how it ended.
// 'proxy-refusal': anything else that isn't the panel's own -- a proxy's
// 403/429 page, a 200 with an HTML body. Most likely the request never
// reached the panel, but the status has the last word.
export type RestoreFailureKind = 'answered' | 'lost' | 'proxy-refusal'

export function restoreFailureKind(error: ApiError): RestoreFailureKind {
  if (error.isTimeout || error.isNetworkError) return 'lost'
  if (typeof error.data === 'object' && error.data !== null) return 'answered'
  return (error.status ?? 0) >= 500 ? 'lost' : 'proxy-refusal'
}

// Whether the status names restore `requestId`, running or ended. True
// too when the status can't be read: then nothing rules it out.
async function statusMayNameRestore(requestId: string): Promise<boolean> {
  try {
    const status = await backupApi.getStatus()
    return status.currentRestore?.id === requestId || status.lastRestore?.id === requestId
  } catch {
    return true
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Reads the outcome of restore `requestId` back from the status: waits while
// a restore is still running, returns the outcome once the status records
// it, and throws RestoreOutcomeUnknownError once reads keep showing no
// restore running and none recorded as this one (it never started, or the
// panel restarted and lost it), or keep failing.
export async function waitForRestoreOutcome(requestId: string): Promise<RestoreOutcome> {
  let unreachableSince: number | null = null
  let failedReads = 0
  let absentReads = 0
  for (;;) {
    let status: BackupStatus | null = null
    try {
      status = await backupApi.getStatus()
    } catch {
      failedReads += 1
      unreachableSince ??= Date.now()
      if (
        failedReads >= STATUS_UNREACHABLE_GIVE_UP_READS &&
        Date.now() - unreachableSince >= STATUS_UNREACHABLE_GIVE_UP_MS
      ) {
        throw new RestoreOutcomeUnknownError()
      }
    }
    if (status) {
      failedReads = 0
      unreachableSince = null
      if (status.lastRestore?.id === requestId) return status.lastRestore
      if (status.restoreInProgress) {
        absentReads = 0
      } else if (++absentReads >= ABSENT_READS_BEFORE_UNKNOWN) {
        throw new RestoreOutcomeUnknownError()
      }
    }
    await sleep(RESTORE_STATUS_POLL_MS)
  }
}

// Restores `name` (with the pre-restore safety backup, as every page does)
// and resolves only with the real outcome: the POST's own response when the
// panel answered it, otherwise the one read back from the status.
// `onResponseLost` fires when the page switches to reading it back, so it
// can say it's still waiting for an answer rather than still restoring.
// Rejects with the panel's own error for a failed or refused restore, with
// RestoreNotStartedError when a proxy refused it and the status shows it
// never ran, or with RestoreOutcomeUnknownError when nothing could say.
//
// It keeps reading the status after the page that called it is gone, on
// purpose: the restore card tells the operator they may leave the page,
// and the toast this ends with (the Toaster sits above every page) is then
// the one place the outcome still reaches them. It stops when the restore
// does, or once the panel has been unreachable for 10 minutes.
export async function restoreBackupAndConfirm(
  name: string,
  requestId: string,
  { onResponseLost }: { onResponseLost?: () => void } = {},
): Promise<{ duration: number | null }> {
  try {
    const result = await backupApi.restoreBackup(name, { createPreRestoreBackup: true, requestId })
    return { duration: typeof result.duration === 'number' ? result.duration : null }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    const kind = restoreFailureKind(error)
    if (kind === 'answered') throw error
    // A proxy refusing the request: when the panel has no trace of this
    // restore, it never ran, and that refusal is the outcome after all --
    // as RestoreNotStartedError when it came with an error status (an error
    // page, whose body is no reason to show); anything else (a 200 that
    // isn't JSON) already carries a short message of api.ts's own.
    if (kind === 'proxy-refusal' && !(await statusMayNameRestore(requestId))) {
      throw typeof error.status === 'number' && error.status >= 400 ? new RestoreNotStartedError(error.status) : error
    }
    onResponseLost?.()
    const outcome = await waitForRestoreOutcome(requestId)
    if (outcome.success) return { duration: outcome.duration }
    // The same reason the POST would have answered with (an empty one
    // leaves the caller's own fallback to getUserErrorMessage()).
    throw new ApiError(outcome.message ?? '')
  }
}
