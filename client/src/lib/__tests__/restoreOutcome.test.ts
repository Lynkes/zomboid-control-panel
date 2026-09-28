import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, backupApi, type BackupStatus } from '@/lib/api'
import {
  RESTORE_STATUS_POLL_MS,
  RestoreOutcomeUnknownError,
  newRestoreRequestId,
  restoreBackupAndConfirm,
  restoreFailureKind,
} from '@/lib/restoreOutcome'

// GH#166: restoreBackupAndConfirm() is what Backups.tsx and Settings.tsx
// restore through. It must report the panel's own answer as it is, and
// read the outcome back from GET /backup/status only when that answer never
// arrived -- never guessing "failed" for a restore that may have finished.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    backupApi: { ...actual.backupApi, getStatus: vi.fn(), restoreBackup: vi.fn() },
  }
})

const getStatus = vi.mocked(backupApi.getStatus)
const restoreBackup = vi.mocked(backupApi.restoreBackup)

const idle = {
  enabled: false,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  includeDb: false,
  backupInProgress: false,
  restoreInProgress: false,
  lastBackup: null,
  backupCount: 0,
  savesPath: null,
  backupsPath: null,
  savesExists: false,
  lastScheduledBackupAttempt: null,
} satisfies BackupStatus

const timeout = () => new ApiError('The request timed out.', { code: 'TIMEOUT', isTimeout: true, isNetworkError: true })

// An error page from something between the browser and the panel, the way
// api.ts's buildResponseError() builds it: the body is the page's text, the
// code the synthesized HTTP_<status>.
function proxyError(status: number, body: string | null = `<html><body>error code: ${status}</body></html>`) {
  return new ApiError(body ?? `Request failed with status ${status}.`, { status, code: `HTTP_${status}`, data: body })
}

// The panel's own error answer: always a JSON object.
function panelError(status: number, error: string, code = `HTTP_${status}`) {
  return new ApiError(error, { status, code, data: { error, code } })
}

function outcome(id: string, success: boolean, message: string | null = null) {
  return {
    id,
    backupName: 'world.zip',
    startedAt: '2026-09-28T09:00:00.000Z',
    preRestoreBackup: true,
    finishedAt: '2026-09-28T09:12:00.000Z',
    success,
    message,
    duration: success ? 720 : null,
  }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('restoreFailureKind', () => {
  it("takes the panel's own answer -- always a JSON object -- as the outcome", () => {
    expect(restoreFailureKind(panelError(400, 'Server must be stopped', 'BACKUP_RESTORE_SERVER_RUNNING'))).toBe('answered')
    expect(restoreFailureKind(panelError(409, 'busy', 'LIFECYCLE_IN_PROGRESS'))).toBe('answered')
    expect(restoreFailureKind(panelError(500, 'boom'))).toBe('answered')
    expect(restoreFailureKind(panelError(503, 'scan failed', 'SERVER_STATE_UNKNOWN'))).toBe('answered')
    // The route's own failed-restore answer: { success: false, message }.
    expect(restoreFailureKind(new ApiError('Restore failed', {
      status: 400,
      code: 'HTTP_400',
      data: { success: false, message: 'Restore failed' },
    }))).toBe('answered')
  })

  it('takes no answer, or a 5xx page from a proxy or tunnel in front of the panel, as lost', () => {
    expect(restoreFailureKind(timeout())).toBe('lost')
    expect(restoreFailureKind(new ApiError('offline', { code: 'NETWORK_ERROR', isNetworkError: true }))).toBe('lost')
    // Cloudflare: 524 "a timeout occurred" after ~100 s -- a long restore's
    // usual fate behind a tunnel -- and 520/522.
    expect(restoreFailureKind(proxyError(524))).toBe('lost')
    expect(restoreFailureKind(proxyError(520))).toBe('lost')
    expect(restoreFailureKind(proxyError(522))).toBe('lost')
    // nginx, and a proxy answering with an empty body.
    expect(restoreFailureKind(proxyError(502, 'Bad Gateway'))).toBe('lost')
    expect(restoreFailureKind(proxyError(504))).toBe('lost')
    expect(restoreFailureKind(proxyError(503, null))).toBe('lost')
  })

  it("leaves a proxy's own refusal for the status to decide", () => {
    expect(restoreFailureKind(proxyError(403))).toBe('proxy-refusal')
    expect(restoreFailureKind(proxyError(429, 'Too Many Requests'))).toBe('proxy-refusal')
    expect(restoreFailureKind(new ApiError('The server returned an invalid response.', { status: 200, code: 'INVALID_RESPONSE' }))).toBe('proxy-refusal')
  })
})

describe('newRestoreRequestId', () => {
  it('makes an id the server accepts ([A-Za-z0-9_-]{8,64}), different every time', () => {
    const a = newRestoreRequestId()
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(newRestoreRequestId()).not.toBe(a)
  })
})

describe('restoreBackupAndConfirm', () => {
  it("sends the request id and returns the POST's own answer when it arrives", async () => {
    restoreBackup.mockResolvedValue({ success: true, duration: 3.5 })
    await expect(restoreBackupAndConfirm('world.zip', 'request-0001')).resolves.toEqual({ duration: 3.5 })
    expect(restoreBackup).toHaveBeenCalledWith('world.zip', { createPreRestoreBackup: true, requestId: 'request-0001' })
    expect(getStatus).not.toHaveBeenCalled()
  })

  it("rethrows the panel's own refusal or failure without reading the status", async () => {
    const refusal = panelError(400, 'Server must be stopped', 'BACKUP_RESTORE_SERVER_RUNNING')
    restoreBackup.mockRejectedValue(refusal)
    await expect(restoreBackupAndConfirm('world.zip', 'request-0001')).rejects.toBe(refusal)

    const failure = panelError(500, 'Failed to restore backup')
    restoreBackup.mockRejectedValue(failure)
    await expect(restoreBackupAndConfirm('world.zip', 'request-0001')).rejects.toBe(failure)
    expect(getStatus).not.toHaveBeenCalled()
  })

  it("on Cloudflare's 524 (the tunnel gave up after ~100 s), follows the restore still running on the panel to its real outcome", async () => {
    vi.useFakeTimers()
    restoreBackup.mockRejectedValue(proxyError(524))
    getStatus
      .mockResolvedValueOnce({ ...idle, restoreInProgress: true, currentRestore: { id: 'request-0001', backupName: 'world.zip', startedAt: '', preRestoreBackup: true } })
      .mockResolvedValueOnce({ ...idle, lastRestore: outcome('request-0001', true) })
    const onResponseLost = vi.fn()

    const pending = restoreBackupAndConfirm('world.zip', 'request-0001', { onResponseLost })
    await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS)

    await expect(pending).resolves.toEqual({ duration: 720 })
    expect(onResponseLost).toHaveBeenCalledTimes(1)
  })

  it('on a proxy 5xx for a restore the panel has no record of, says it could not confirm rather than "failed"', async () => {
    // A 520 can mean the panel died mid-restore and came back without its
    // record -- not proof the world was left alone.
    restoreBackup.mockRejectedValue(proxyError(520))
    getStatus.mockResolvedValue(idle)

    await expect(restoreBackupAndConfirm('world.zip', 'request-0001')).rejects.toBeInstanceOf(RestoreOutcomeUnknownError)
  })

  it("rethrows a proxy's refusal when the panel has no trace of the restore -- it never ran", async () => {
    const refusal = proxyError(403)
    restoreBackup.mockRejectedValue(refusal)
    getStatus.mockResolvedValue({ ...idle, lastRestore: outcome('someone-else-01', true) })
    const onResponseLost = vi.fn()

    await expect(restoreBackupAndConfirm('world.zip', 'request-0001', { onResponseLost })).rejects.toBe(refusal)
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(onResponseLost).not.toHaveBeenCalled()
  })

  it("follows the restore anyway when a proxy's refusal came back for a restore the panel did run", async () => {
    restoreBackup.mockRejectedValue(proxyError(403))
    getStatus.mockResolvedValue({ ...idle, lastRestore: outcome('request-0001', true) })

    await expect(restoreBackupAndConfirm('world.zip', 'request-0001')).resolves.toEqual({ duration: 720 })
  })

  it('on a lost answer, waits while the restore runs and resolves with its recorded success', async () => {
    vi.useFakeTimers()
    restoreBackup.mockRejectedValue(timeout())
    getStatus
      .mockResolvedValueOnce({ ...idle, restoreInProgress: true, currentRestore: { id: 'request-0001', backupName: 'world.zip', startedAt: '', preRestoreBackup: true } })
      .mockResolvedValueOnce({ ...idle, lastRestore: outcome('request-0001', true) })
    const onResponseLost = vi.fn()

    const pending = restoreBackupAndConfirm('world.zip', 'request-0001', { onResponseLost })
    await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS)

    await expect(pending).resolves.toEqual({ duration: 720 })
    expect(onResponseLost).toHaveBeenCalledTimes(1)
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it("on a lost answer, rejects with the recorded failure's reason", async () => {
    restoreBackup.mockRejectedValue(timeout())
    getStatus.mockResolvedValue({ ...idle, lastRestore: outcome('request-0001', false, 'Backup not found: world.zip') })

    await expect(restoreBackupAndConfirm('world.zip', 'request-0001')).rejects.toThrow('Backup not found: world.zip')
  })

  it("does not take another restore's outcome for its own", async () => {
    restoreBackup.mockRejectedValue(timeout())
    getStatus.mockResolvedValue({ ...idle, lastRestore: outcome('someone-else-01', true) })

    await expect(restoreBackupAndConfirm('world.zip', 'request-0001')).rejects.toBeInstanceOf(RestoreOutcomeUnknownError)
  })

  it('keeps trying while the panel is unreachable, then gives up as "unknown" rather than "failed"', async () => {
    vi.useFakeTimers()
    restoreBackup.mockRejectedValue(timeout())
    getStatus.mockRejectedValue(new ApiError('offline', { code: 'NETWORK_ERROR', isNetworkError: true }))

    const pending = restoreBackupAndConfirm('world.zip', 'request-0001')
    const settled = expect(pending).rejects.toBeInstanceOf(RestoreOutcomeUnknownError)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + RESTORE_STATUS_POLL_MS)
    await settled
    expect(getStatus.mock.calls.length).toBeGreaterThan(100)
  })
})
