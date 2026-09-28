import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Backups from '../Backups'
import {
  ApiError,
  backupApi,
  serversApi,
  type BackupStatus,
  type RestoreOutcome,
  type ServerBackupArchive,
} from '@/lib/api'
import { RESTORE_STATUS_POLL_MS } from '@/lib/restoreOutcome'
import en from '../../locales/en/backups.json'

// GH#166 ("World Recovery View do not get finished", ALR84): restoring a
// backup archived the current world and restored the chosen one, but the
// page's Restore card never left "in progress" until a reload. Every
// restore's pre-restore safety backup reports its own backup:progress
// 'complete' while the restore is still running; the page re-read the
// status on that event and got restoreInProgress:true -- and after its own
// restore returned, never read it again. The instant restoringBackup
// cleared, that stale flag turned the card into "A restore is already in
// progress for this server…", with no poll and no restore event listener
// left to ever end it. The same dead end met a page that only saw a restore
// running (another tab, a reload, a navigation away and back), and a
// restore whose own response went missing (a long restore past the client
// timeout, a proxy cutting the request) was reported as a failure.

const toastSpy = vi.fn()

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    backupApi: {
      ...actual.backupApi,
      getStatus: vi.fn(),
      listBackups: vi.fn(),
      getHistory: vi.fn(),
      restoreBackup: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)
const restoreBackup = vi.mocked(backupApi.restoreBackup)

const idleStatus: BackupStatus = {
  enabled: false,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  includeDb: false,
  backupInProgress: false,
  restoreInProgress: false,
  currentRestore: null,
  lastRestore: null,
  lastBackup: null,
  backupCount: 1,
  savesPath: '/saves',
  backupsPath: '/backups',
  savesExists: true,
  lastScheduledBackupAttempt: null,
}

const testBackup: ServerBackupArchive = {
  name: 'servertest_2026-09-20T10-00-00-000.zip',
  path: '/backups/servertest_2026-09-20T10-00-00-000.zip',
  size: 1024 * 1024,
  created: '2026-09-20T10:00:00.000Z',
}

const STARTED_AT = '2026-09-28T09:00:00.000Z'

function running(id: string | undefined, backupName = testBackup.name): BackupStatus {
  return {
    ...idleStatus,
    restoreInProgress: true,
    currentRestore: { id: id ?? 'unknown', backupName, startedAt: STARTED_AT },
  }
}

function ended(outcome: Partial<RestoreOutcome> & { id: string }): BackupStatus {
  return {
    ...idleStatus,
    lastRestore: {
      backupName: testBackup.name,
      startedAt: STARTED_AT,
      finishedAt: '2026-09-28T09:03:00.000Z',
      success: true,
      message: null,
      duration: 180,
      ...outcome,
    },
  }
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key])
}

function makeMockSocket() {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    off: (event: string) => { delete handlers[event] },
  }
  return { socket, fire: (event: string, data?: unknown) => handlers[event]?.(data) }
}

function renderBackups(socket: Pick<Socket, 'on' | 'off'>) {
  return render(
    <SocketContext.Provider value={socket as Socket}>
      <TooltipProvider>
        <Backups />
      </TooltipProvider>
    </SocketContext.Provider>,
  )
}

function setUp(status: BackupStatus = idleStatus) {
  getResolvedActive.mockResolvedValue({ server: null })
  getStatus.mockResolvedValue(status)
  listBackups.mockResolvedValue({ backups: [testBackup] })
  getHistory.mockResolvedValue({ records: [] })
}

async function startRestoreFromTheRow() {
  const rowButton = await screen.findByRole('button', { name: fill(en.mainCard.restoreAria, { name: testBackup.name }) })
  await waitFor(() => expect(rowButton).not.toBeDisabled())
  fireEvent.click(rowButton)
  fireEvent.click(await screen.findByRole('button', { name: en.restoreDialog.confirm }))
  await waitFor(() => expect(restoreBackup).toHaveBeenCalledTimes(1))
  return restoreBackup.mock.calls[0][1]?.requestId
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('Backups.tsx: the Restore card always reaches a finished state (GH#166)', () => {
  it("this page's own restore ends as \"Restore finished\", not an endless \"restore in progress\" left by the mid-restore status read", async () => {
    const { socket, fire } = makeMockSocket()
    setUp()
    let finishRestore!: (value: { success: boolean; message?: string; duration?: number }) => void
    restoreBackup.mockImplementation(() => new Promise((resolve) => { finishRestore = resolve }))

    renderBackups(socket)
    const requestId = await startRestoreFromTheRow()
    expect(await screen.findByText(fill(en.restoreProgress.title, { name: testBackup.name }))).toBeInTheDocument()

    // The pre-restore safety backup finishes first, while the restore runs
    // on: the page re-reads the status, which truthfully says it's running.
    getStatus.mockResolvedValue(running(requestId))
    const readsBefore = getStatus.mock.calls.length
    act(() => { fire('backup:progress', { phase: 'complete', percent: 100, message: 'Backup complete!' }) })
    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(readsBefore))

    // Then the restore itself finishes.
    getStatus.mockResolvedValue(ended({ id: requestId ?? 'unknown', duration: 12.3 }))
    await act(async () => { finishRestore({ success: true, message: 'Restored', duration: 12.3 }) })

    expect(await screen.findByText(en.restoreResult.successTitle)).toBeInTheDocument()
    expect(screen.getByText(fill(en.restoreResult.successDetail, { seconds: '12.3' }))).toBeInTheDocument()
    expect(screen.queryByText(en.restoreProgress.titleUnknown)).not.toBeInTheDocument()
    expect(screen.queryByText(fill(en.restoreProgress.title, { name: testBackup.name }))).not.toBeInTheDocument()
    // And nothing is left blocked by a restore that's over.
    await waitFor(() => expect(screen.getByRole('button', { name: en.pageHeader.createBackup })).not.toBeDisabled())
    expect(screen.getByRole('button', { name: fill(en.mainCard.restoreAria, { name: testBackup.name }) })).not.toBeDisabled()

    // Dismissable once read.
    fireEvent.click(screen.getByRole('button', { name: en.restoreResult.dismissAria }))
    expect(screen.queryByText(en.restoreResult.successTitle)).not.toBeInTheDocument()
  })

  it('a restore already running when the page loads (another tab, or a navigation away and back) ends on its own, with no socket event at all', async () => {
    const { socket } = makeMockSocket()
    setUp(running('other-tab-restore', 'other.zip'))
    vi.useFakeTimers({ shouldAdvanceTime: true })

    renderBackups(socket)
    // Named now, not "a restore is already in progress".
    expect(await screen.findByText(fill(en.restoreProgress.title, { name: 'other.zip' }))).toBeInTheDocument()

    getStatus.mockResolvedValue(ended({ id: 'other-tab-restore', backupName: 'other.zip', duration: 42 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS) })

    expect(await screen.findByText(en.restoreResult.successTitle)).toBeInTheDocument()
    expect(screen.getByText('other.zip')).toBeInTheDocument()
    expect(screen.queryByText(fill(en.restoreProgress.title, { name: 'other.zip' }))).not.toBeInTheDocument()
  })

  it("another tab's restore failing turns the card into the reason and the next step as soon as restore:finished arrives", async () => {
    const { socket, fire } = makeMockSocket()
    setUp(running('other-tab-restore'))

    renderBackups(socket)
    expect(await screen.findByText(fill(en.restoreProgress.title, { name: testBackup.name }))).toBeInTheDocument()

    const reason = 'Backup archive failed integrity verification: 1 file(s) did not match their recorded checksum -- map_meta.bin. Live save left untouched.'
    const status = ended({ id: 'other-tab-restore', success: false, message: reason, duration: null })
    getStatus.mockResolvedValue(status)
    act(() => { fire('restore:finished', status.lastRestore) })

    expect(await screen.findByText(en.restoreResult.failedTitle)).toBeInTheDocument()
    expect(screen.getByText(reason)).toBeInTheDocument()
    expect(screen.getByText(en.restoreResult.failedNextStep)).toBeInTheDocument()
  })

  it("this page's restore whose response is lost (client timeout, proxy) reads its real outcome back instead of reporting a failure", async () => {
    const { socket } = makeMockSocket()
    setUp()
    let serverSide: 'idle' | 'running' | 'done' = 'idle'
    const requestIdSent = () => restoreBackup.mock.calls[0]?.[1]?.requestId ?? 'unknown'
    getStatus.mockImplementation(async () => (
      serverSide === 'running'
        ? running(requestIdSent())
        : serverSide === 'done'
          ? ended({ id: requestIdSent(), duration: 700 })
          : idleStatus
    ))
    restoreBackup.mockImplementation(async () => {
      serverSide = 'running'
      throw new ApiError('The request timed out. Check your connection and try again.', {
        code: 'TIMEOUT',
        isTimeout: true,
        isNetworkError: true,
        isRetryable: true,
      })
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })

    renderBackups(socket)
    await startRestoreFromTheRow()

    // Still restoring, and saying why it's still waiting.
    expect(await screen.findByText(en.restoreProgress.responseLost)).toBeInTheDocument()
    expect(screen.getByText(fill(en.restoreProgress.title, { name: testBackup.name }))).toBeInTheDocument()

    serverSide = 'done'
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS) })

    expect(await screen.findByText(en.restoreResult.successTitle)).toBeInTheDocument()
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: en.toasts.restoredTitle }))
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.toasts.restoreFailedTitle }))
  })

  it("says it couldn't confirm the outcome -- not success, not failure -- when the panel lost the restore (it restarted mid-restore)", async () => {
    const { socket } = makeMockSocket()
    setUp()
    // The connection drops; the panel comes back with no restore running and
    // no record of this one.
    restoreBackup.mockRejectedValue(new ApiError('Unable to reach the server.', {
      code: 'NETWORK_ERROR',
      isNetworkError: true,
      isRetryable: true,
    }))

    renderBackups(socket)
    await startRestoreFromTheRow()

    expect(await screen.findByText(en.restoreResult.unknownTitle)).toBeInTheDocument()
    expect(screen.getByText(en.restoreResult.unknownDetail)).toBeInTheDocument()
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: en.restoreResult.unknownTitle, variant: 'warning' }))
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.toasts.restoredTitle }))
  })

  it('a refused restore (the panel answered) is reported as it is, without waiting on the status', async () => {
    const { socket } = makeMockSocket()
    setUp()
    restoreBackup.mockRejectedValue(new ApiError('Server must be stopped before restoring a backup. Please stop the server first.', {
      status: 400,
      code: 'HTTP_400',
    }))

    renderBackups(socket)
    await startRestoreFromTheRow()

    expect(await screen.findByText(en.restoreResult.failedTitle)).toBeInTheDocument()
    expect(screen.getByText(/Server must be stopped before restoring a backup/)).toBeInTheDocument()
    expect(screen.queryByText(en.restoreProgress.responseLost)).not.toBeInTheDocument()
  })
})
