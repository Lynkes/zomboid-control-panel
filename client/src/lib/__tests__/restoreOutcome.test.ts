import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, backupApi, type BackupStatus } from '@/lib/api'
import {
  RESTORE_STATUS_POLL_MS,
  RestoreOutcomeUnknownError,
  isRestoreResponseLost,
  newRestoreRequestId,
  restoreBackupAndConfirm,
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

function outcome(id: string, success: boolean, message: string | null = null) {
  return {
    id,
    backupName: 'world.zip',
    startedAt: '2026-09-28T09:00:00.000Z',
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

describe('isRestoreResponseLost', () => {
  it('is true only when nothing from the panel itself answered', () => {
    expect(isRestoreResponseLost(timeout())).toBe(true)
    expect(isRestoreResponseLost(new ApiError('offline', { code: 'NETWORK_ERROR', isNetworkError: true }))).toBe(true)
    expect(isRestoreResponseLost(new ApiError('Bad gateway', { status: 502, code: 'HTTP_502' }))).toBe(true)
    expect(isRestoreResponseLost(new ApiError('Gateway timeout', { status: 504, code: 'HTTP_504' }))).toBe(true)
    expect(isRestoreResponseLost(new ApiError('Unavailable', { status: 503, code: 'HTTP_503' }))).toBe(true)

    // The panel's own answers are the outcome.
    expect(isRestoreResponseLost(new ApiError('scan failed', { status: 503, code: 'SERVER_STATE_UNKNOWN' }))).toBe(false)
    expect(isRestoreResponseLost(new ApiError('busy', { status: 409, code: 'LIFECYCLE_IN_PROGRESS' }))).toBe(false)
    expect(isRestoreResponseLost(new ApiError('running', { status: 400, code: 'HTTP_400' }))).toBe(false)
    expect(isRestoreResponseLost(new ApiError('boom', { status: 500, code: 'HTTP_500' }))).toBe(false)
    expect(isRestoreResponseLost(new Error('not an api error'))).toBe(false)
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

  it("rethrows the panel's own refusal without reading the status", async () => {
    const refusal = new ApiError('Server must be stopped', { status: 400, code: 'BACKUP_RESTORE_SERVER_RUNNING' })
    restoreBackup.mockRejectedValue(refusal)
    await expect(restoreBackupAndConfirm('world.zip', 'request-0001')).rejects.toBe(refusal)
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('on a lost answer, waits while the restore runs and resolves with its recorded success', async () => {
    vi.useFakeTimers()
    restoreBackup.mockRejectedValue(timeout())
    getStatus
      .mockResolvedValueOnce({ ...idle, restoreInProgress: true, currentRestore: { id: 'request-0001', backupName: 'world.zip', startedAt: '' } })
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
