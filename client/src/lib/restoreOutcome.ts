import { ApiError, backupApi, type RestoreOutcome } from '@/lib/api'

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
// or unreachable) before the page stops waiting and says it couldn't tell.
const STATUS_UNREACHABLE_GIVE_UP_MS = 10 * 60 * 1000

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

// A failure that says nothing about whether the server ran the restore: no
// answer at all (timeout, dropped connection), or a proxy in front of the
// panel answering for it (502/504, or a 503 without the panel's own code).
// Anything the panel itself answered -- a refusal, a failed restore -- is
// the outcome, and is reported as it is.
export function isRestoreResponseLost(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.isTimeout || error.isNetworkError) return true
  if (error.status === 502 || error.status === 504) return true
  return error.status === 503 && error.code === 'HTTP_503'
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Reads the outcome of restore `requestId` back from the status: waits while
// a restore is still running, returns the outcome once the status records
// it, and throws RestoreOutcomeUnknownError if no restore is running and the
// last one recorded isn't this one (it never started, or the panel
// restarted and lost it).
export async function waitForRestoreOutcome(requestId: string): Promise<RestoreOutcome> {
  let unreachableSince: number | null = null
  for (;;) {
    try {
      const status = await backupApi.getStatus()
      unreachableSince = null
      if (status.lastRestore?.id === requestId) return status.lastRestore
      if (!status.restoreInProgress) throw new RestoreOutcomeUnknownError()
    } catch (error) {
      if (error instanceof RestoreOutcomeUnknownError) throw error
      unreachableSince ??= Date.now()
      if (Date.now() - unreachableSince >= STATUS_UNREACHABLE_GIVE_UP_MS) {
        throw new RestoreOutcomeUnknownError()
      }
    }
    await sleep(RESTORE_STATUS_POLL_MS)
  }
}

// Restores `name` (with the pre-restore safety backup, as every page does)
// and resolves only with the real outcome: the POST's own response when it
// arrives, otherwise the one read back from the status.
// `onResponseLost` fires when the page switches to reading it back, so it
// can say it's still waiting for an answer rather than still restoring.
// Rejects with the panel's own error for a failed or refused restore, or
// with RestoreOutcomeUnknownError when nothing could say.
export async function restoreBackupAndConfirm(
  name: string,
  requestId: string,
  { onResponseLost }: { onResponseLost?: () => void } = {},
): Promise<{ duration: number | null }> {
  try {
    const result = await backupApi.restoreBackup(name, { createPreRestoreBackup: true, requestId })
    return { duration: typeof result.duration === 'number' ? result.duration : null }
  } catch (error) {
    if (!isRestoreResponseLost(error)) throw error
    onResponseLost?.()
    const outcome = await waitForRestoreOutcome(requestId)
    if (outcome.success) return { duration: outcome.duration }
    // The same reason the POST would have answered with (an empty one
    // leaves the caller's own fallback to getUserErrorMessage()).
    throw new ApiError(outcome.message ?? '')
  }
}
