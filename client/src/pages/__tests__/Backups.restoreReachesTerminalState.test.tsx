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
// timeout, a proxy cutting the request) was reported as a failure. The
// backup card for the restore's safety backup ("Archiving files…") could
// spin on the same way when the socket missed that backup's 'complete'.

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
    currentRestore: { id: id ?? 'unknown', backupName, startedAt: STARTED_AT, preRestoreBackup: true },
  }
}

function ended(outcome: Partial<RestoreOutcome> & { id: string }): BackupStatus {
  return {
    ...idleStatus,
    lastRestore: {
      backupName: testBackup.name,
      startedAt: STARTED_AT,
      preRestoreBackup: true,
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

// An error page from a tunnel in front of the panel, the way api.ts's
// buildResponseError() builds it: Cloudflare gives up on a request after
// about 100 s -- a restore and its safety backup routinely run longer.
function cloudflare524() {
  const body = '<!DOCTYPE html><html><head><title>A timeout occurred</title></head><body>Error code 524</body></html>'
  return new ApiError(body, { status: 524, code: 'HTTP_524', isRetryable: true, data: body })
}

// A status read while the panel can't be reached, and a restore request
// whose answer never came, the way api.ts builds them.
function panelUnreachable() {
  return new ApiError('Unable to reach the server.', { code: 'NETWORK_ERROR', isNetworkError: true, isRetryable: true })
}

function requestTimedOut() {
  return new ApiError('The request timed out. Check your connection and try again.', {
    code: 'TIMEOUT',
    isTimeout: true,
    isNetworkError: true,
    isRetryable: true,
  })
}

// How long the panel must stay unreachable before a restore ends as
// "couldn't confirm" (restoreOutcome.ts), with the reads it takes.
const GIVE_UP_AFTER_MS = 10 * 60 * 1000 + 3 * RESTORE_STATUS_POLL_MS

const SAFETY_BACKUP_PROGRESS = { phase: 'archiving', percent: 40, message: 'Archiving files... (400/1000)' }

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

  it("doesn't claim a safety backup for a watched restore that was started without one", async () => {
    // POST /backup/restore passes its body through: an API caller can send
    // createPreRestoreBackup: false, which neither panel page does.
    const { socket, fire } = makeMockSocket()
    const status = running('api-restore', 'other.zip')
    setUp({ ...status, currentRestore: { ...status.currentRestore!, preRestoreBackup: false } })

    renderBackups(socket)
    expect(await screen.findByText(fill(en.restoreProgress.title, { name: 'other.zip' }))).toBeInTheDocument()

    getStatus.mockResolvedValue(ended({ id: 'api-restore', backupName: 'other.zip', duration: 42, preRestoreBackup: false }))
    act(() => { fire('restore:finished', { id: 'api-restore' }) })

    expect(await screen.findByText(fill(en.restoreResult.successDetailNoSafetyBackup, { seconds: '42.0' }))).toBeInTheDocument()
    expect(screen.queryByText(fill(en.restoreResult.successDetail, { seconds: '42.0' }))).not.toBeInTheDocument()
  })

  it("another tab's restore failing turns the card into the reason and the next step as soon as restore:finished arrives", async () => {
    const { socket, fire } = makeMockSocket()
    setUp(running('other-tab-restore'))

    renderBackups(socket)
    expect(await screen.findByText(fill(en.restoreProgress.title, { name: testBackup.name }))).toBeInTheDocument()

    const reason = 'Backup archive failed integrity verification: 1 file(s) did not match their recorded checksum -- map_meta.bin. Live save left untouched.'
    getStatus.mockResolvedValue(ended({ id: 'other-tab-restore', success: false, message: reason, duration: null }))
    // Named, nothing more: the event reaches every signed-in role.
    act(() => { fire('restore:finished', { id: 'other-tab-restore' }) })

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
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: en.restoreResult.successTitle }))
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.restoreResult.failedTitle }))
  })

  it('still tells the operator how a restore with a lost answer ended after they left the page', async () => {
    // The card says they may leave; the toast (the Toaster sits above every
    // page) is then the one place the outcome reaches them.
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
      throw cloudflare524()
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const { unmount } = renderBackups(socket)
    await startRestoreFromTheRow()
    expect(await screen.findByText(en.restoreProgress.responseLost)).toBeInTheDocument()
    unmount()

    serverSide = 'done'
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS) })

    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: en.restoreResult.successTitle }))
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
    vi.useFakeTimers({ shouldAdvanceTime: true })

    renderBackups(socket)
    await startRestoreFromTheRow()
    // Not on the first read: a restore whose answer was lost early may not
    // be marked running yet.
    expect(await screen.findByText(en.restoreProgress.responseLost)).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * RESTORE_STATUS_POLL_MS) })

    expect(await screen.findByText(en.restoreResult.unknownTitle)).toBeInTheDocument()
    expect(screen.getByText(en.restoreResult.unknownDetail)).toBeInTheDocument()
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: en.restoreResult.unknownTitle, variant: 'warning' }))
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.restoreResult.successTitle }))
  })

  it("replaces \"couldn't confirm\" with the real outcome once the panel, unreachable for too long, is back and has recorded it", async () => {
    const { socket, fire } = makeMockSocket()
    setUp()
    const requestIdSent = () => restoreBackup.mock.calls[0]?.[1]?.requestId ?? 'unknown'
    restoreBackup.mockImplementation(async () => {
      // The answer is lost, and the panel with it: every status read fails
      // from here on (a long network drop, a laptop asleep).
      getStatus.mockRejectedValue(new ApiError('Unable to reach the server.', {
        code: 'NETWORK_ERROR',
        isNetworkError: true,
        isRetryable: true,
      }))
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
    expect(await screen.findByText(en.restoreProgress.responseLost)).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + RESTORE_STATUS_POLL_MS) })
    expect(await screen.findByText(en.restoreResult.unknownTitle)).toBeInTheDocument()

    // The panel is back, the socket reconnects -- and the status has how
    // this very restore ended.
    getStatus.mockResolvedValue(ended({ id: requestIdSent(), duration: 640 }))
    act(() => { fire('connect') })

    expect(await screen.findByText(en.restoreResult.successTitle)).toBeInTheDocument()
    expect(screen.getByText(fill(en.restoreResult.successDetail, { seconds: '640.0' }))).toBeInTheDocument()
    expect(screen.queryByText(en.restoreResult.unknownTitle)).not.toBeInTheDocument()
  })

  it("keeps \"couldn't confirm\" when the restore the panel recorded since is another one", async () => {
    const { socket, fire } = makeMockSocket()
    setUp()
    restoreBackup.mockImplementation(async () => {
      getStatus.mockRejectedValue(new ApiError('Unable to reach the server.', {
        code: 'NETWORK_ERROR',
        isNetworkError: true,
        isRetryable: true,
      }))
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
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + RESTORE_STATUS_POLL_MS) })
    expect(await screen.findByText(en.restoreResult.unknownTitle)).toBeInTheDocument()

    getStatus.mockResolvedValue(ended({ id: 'someone-elses-restore', duration: 5 }))
    const readsBefore = getStatus.mock.calls.length
    act(() => { fire('connect') })
    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(readsBefore))

    expect(await screen.findByText(en.restoreResult.unknownTitle)).toBeInTheDocument()
    expect(screen.queryByText(en.restoreResult.successTitle)).not.toBeInTheDocument()
  })

  it("says it couldn't confirm -- not an endless \"Restoring…\" -- while the panel stays unreachable after the safety backup's mid-restore status read", async () => {
    // The realistic order: the safety backup's 'complete' re-reads the
    // status mid-restore, which names this very restore as running -- and
    // no failed read replaces that. It must not read as a restore running
    // elsewhere once this one has given up.
    const { socket, fire } = makeMockSocket()
    setUp()
    let loseTheAnswer!: () => void
    restoreBackup.mockImplementation(() => new Promise((_, reject) => {
      loseTheAnswer = () => reject(requestTimedOut())
    }))
    vi.useFakeTimers({ shouldAdvanceTime: true })

    renderBackups(socket)
    const requestId = await startRestoreFromTheRow()
    getStatus.mockResolvedValue(running(requestId))
    const readsBefore = getStatus.mock.calls.length
    act(() => { fire('backup:progress', { phase: 'complete', percent: 100, message: 'Backup complete!' }) })
    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(readsBefore))
    await act(async () => {})

    // Then the panel drops off the network, the restore's answer with it.
    getStatus.mockRejectedValue(panelUnreachable())
    await act(async () => { loseTheAnswer() })
    expect(await screen.findByText(en.restoreProgress.responseLost)).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS) })

    expect(await screen.findByText(en.restoreResult.unknownTitle)).toBeInTheDocument()
    expect(screen.getByText(en.restoreResult.unknownDetail)).toBeInTheDocument()
    expect(screen.queryByText(fill(en.restoreProgress.title, { name: testBackup.name }))).not.toBeInTheDocument()
    expect(screen.queryByText(en.restoreProgress.note)).not.toBeInTheDocument()

    // The panel is back, the restore still running. socket.io stopped
    // reconnecting long ago, so no 'connect': the page's own re-check finds
    // it, and blocks new actions meanwhile.
    getStatus.mockResolvedValue(running(requestId))
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS) })
    expect(await screen.findByText(fill(en.restoreProgress.title, { name: testBackup.name }))).toBeInTheDocument()
    expect(screen.queryByText(en.restoreResult.unknownTitle)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.pageHeader.createBackup })).toBeDisabled()

    getStatus.mockResolvedValue(ended({ id: requestId ?? 'unknown', duration: 900 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS) })
    expect(await screen.findByText(en.restoreResult.successTitle)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: en.pageHeader.createBackup })).not.toBeDisabled())
  })

  it("replaces \"couldn't confirm\" with the recorded outcome on its own re-check once the panel is back, with no socket reconnect", async () => {
    const { socket } = makeMockSocket()
    setUp()
    restoreBackup.mockImplementation(async () => {
      getStatus.mockRejectedValue(panelUnreachable())
      throw requestTimedOut()
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })

    renderBackups(socket)
    const requestId = await startRestoreFromTheRow()
    await act(async () => { await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS) })
    expect(await screen.findByText(en.restoreResult.unknownTitle)).toBeInTheDocument()

    getStatus.mockResolvedValue(ended({ id: requestId ?? 'unknown', success: false, message: 'Disk full', duration: null }))
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS) })

    expect(await screen.findByText(en.restoreResult.failedTitle)).toBeInTheDocument()
    expect(screen.getByText('Disk full')).toBeInTheDocument()
    expect(screen.queryByText(en.restoreResult.unknownTitle)).not.toBeInTheDocument()
  })

  it("stops re-checking a \"couldn't confirm\" restore once a read gets through with no record of it (the panel restarted)", async () => {
    const { socket } = makeMockSocket()
    setUp()
    restoreBackup.mockImplementation(async () => {
      getStatus.mockRejectedValue(panelUnreachable())
      throw requestTimedOut()
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })

    renderBackups(socket)
    await startRestoreFromTheRow()
    await act(async () => { await vi.advanceTimersByTimeAsync(GIVE_UP_AFTER_MS) })
    expect(await screen.findByText(en.restoreResult.unknownTitle)).toBeInTheDocument()

    getStatus.mockResolvedValue(idleStatus)
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS) })
    await waitFor(() => expect(getStatus).toHaveLastResolvedWith(idleStatus))
    const readsAfterPanelBack = getStatus.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(6 * RESTORE_STATUS_POLL_MS) })

    expect(getStatus.mock.calls.length).toBe(readsAfterPanelBack)
    expect(screen.getByText(en.restoreResult.unknownTitle)).toBeInTheDocument()
  })

  it("a proxy's refusal (an HTML error page) of a restore that never started says so in a sentence, not the page's markup", async () => {
    const { socket } = makeMockSocket()
    setUp()
    const body = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1><hr><center>nginx</center></body></html>'
    restoreBackup.mockRejectedValue(new ApiError(body, { status: 403, code: 'HTTP_403', data: body }))

    renderBackups(socket)
    await startRestoreFromTheRow()

    const reason = fill(en.restoreResult.notStartedProxy, { status: '403' })
    expect(await screen.findByText(en.restoreResult.failedTitle)).toBeInTheDocument()
    expect(screen.getByText(reason)).toBeInTheDocument()
    expect(screen.queryByText(/DOCTYPE|<html>/)).not.toBeInTheDocument()
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: en.restoreResult.failedTitle, description: reason }))
  })

  it("a restore behind Cloudflare, whose request the tunnel gave up on (524), is followed to its real outcome -- not reported as failed", async () => {
    const { socket } = makeMockSocket()
    setUp()
    let serverSide: 'idle' | 'running' | 'done' = 'idle'
    const requestIdSent = () => restoreBackup.mock.calls[0]?.[1]?.requestId ?? 'unknown'
    getStatus.mockImplementation(async () => (
      serverSide === 'running'
        ? running(requestIdSent())
        : serverSide === 'done'
          ? ended({ id: requestIdSent(), duration: 312.5 })
          : idleStatus
    ))
    restoreBackup.mockImplementation(async () => {
      serverSide = 'running'
      throw cloudflare524()
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })

    renderBackups(socket)
    await startRestoreFromTheRow()

    // Still restoring -- and saying honestly that it's waiting on the panel.
    expect(await screen.findByText(en.restoreProgress.responseLost)).toBeInTheDocument()
    expect(screen.getByText(fill(en.restoreProgress.title, { name: testBackup.name }))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.pageHeader.createBackup })).toBeDisabled()

    serverSide = 'done'
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_STATUS_POLL_MS) })

    expect(await screen.findByText(en.restoreResult.successTitle)).toBeInTheDocument()
    expect(screen.getByText(fill(en.restoreResult.successDetail, { seconds: '312.5' }))).toBeInTheDocument()
    expect(screen.queryByText(en.restoreResult.failedTitle)).not.toBeInTheDocument()
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.restoreResult.failedTitle }))
  })

  it("hands the card to the restore when a failure answer came back for a restore that is still running", async () => {
    // A JSON error page from something in front of the panel reads like the
    // panel's own answer. The status read right after says otherwise: the
    // page must not leave "Restore failed" -- and Create/Restore enabled --
    // over a world still being replaced.
    const { socket, fire } = makeMockSocket()
    setUp()
    let serverSide: 'idle' | 'running' | 'done' = 'idle'
    const requestIdSent = () => restoreBackup.mock.calls[0]?.[1]?.requestId ?? 'unknown'
    getStatus.mockImplementation(async () => (
      serverSide === 'running'
        ? running(requestIdSent())
        : serverSide === 'done'
          ? ended({ id: requestIdSent(), duration: 90 })
          : idleStatus
    ))
    restoreBackup.mockImplementation(async () => {
      serverSide = 'running'
      throw new ApiError('Internal Server Error', { status: 500, code: 'HTTP_500', data: { error: 'Internal Server Error' } })
    })

    renderBackups(socket)
    await startRestoreFromTheRow()

    await waitFor(() => expect(screen.queryByText(en.restoreResult.failedTitle)).not.toBeInTheDocument())
    expect(await screen.findByText(fill(en.restoreProgress.title, { name: testBackup.name }))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.pageHeader.createBackup })).toBeDisabled()

    serverSide = 'done'
    act(() => { fire('restore:finished', { id: requestIdSent() }) })

    expect(await screen.findByText(en.restoreResult.successTitle)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: en.pageHeader.createBackup })).not.toBeDisabled())
  })

  it('a refused restore (the panel answered) is reported as it is, without waiting on the status', async () => {
    const { socket } = makeMockSocket()
    setUp()
    const error = 'Server must be stopped before restoring a backup. Please stop the server first.'
    restoreBackup.mockRejectedValue(new ApiError(error, {
      status: 400,
      code: 'BACKUP_RESTORE_SERVER_RUNNING',
      data: { success: false, error, code: 'BACKUP_RESTORE_SERVER_RUNNING' },
    }))

    renderBackups(socket)
    await startRestoreFromTheRow()

    expect(await screen.findByText(en.restoreResult.failedTitle)).toBeInTheDocument()
    expect(screen.getByText(/Server must be stopped before restoring a backup/)).toBeInTheDocument()
    expect(screen.queryByText(en.restoreProgress.responseLost)).not.toBeInTheDocument()
  })

  it('announces the Restore card through one live region that is already on the page before the restore starts', async () => {
    // A live region inserted together with its content is often not
    // announced; one that already exists announces what changes inside it.
    const { socket } = makeMockSocket()
    setUp()
    let finishRestore!: (value: { success: boolean; duration?: number }) => void
    restoreBackup.mockImplementation(() => new Promise((resolve) => { finishRestore = resolve }))

    const { container } = renderBackups(socket)
    await screen.findByRole('button', { name: fill(en.mainCard.restoreAria, { name: testBackup.name }) })
    const region = container.querySelector('[role="status"][aria-live="polite"]')
    expect(region).not.toBeNull()
    expect(region).toBeEmptyDOMElement()

    const requestId = await startRestoreFromTheRow()
    expect(region).toContainElement(await screen.findByText(fill(en.restoreProgress.title, { name: testBackup.name })))

    getStatus.mockResolvedValue(ended({ id: requestId ?? 'unknown' }))
    await act(async () => { finishRestore({ success: true, duration: 5 }) })
    expect(region).toContainElement(await screen.findByText(en.restoreResult.successTitle))
  })
})

describe("Backups.tsx: the restore's safety-backup card ends with it, even when the socket missed its 'complete' (GH#166)", () => {
  it("this page's own restore: the card is gone once the restore ends", async () => {
    const { socket, fire } = makeMockSocket()
    setUp()
    let finishRestore!: (value: { success: boolean; duration?: number }) => void
    restoreBackup.mockImplementation(() => new Promise((resolve) => { finishRestore = resolve }))

    renderBackups(socket)
    const requestId = await startRestoreFromTheRow()
    act(() => { fire('backup:progress', SAFETY_BACKUP_PROGRESS) })
    expect(await screen.findByText(SAFETY_BACKUP_PROGRESS.message)).toBeInTheDocument()

    // Its 'complete' never arrives; the restore then ends.
    getStatus.mockResolvedValue(ended({ id: requestId ?? 'unknown' }))
    await act(async () => { finishRestore({ success: true, duration: 12 }) })

    expect(await screen.findByText(en.restoreResult.successTitle)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(SAFETY_BACKUP_PROGRESS.message)).not.toBeInTheDocument())
  })

  it('a reconnect after the safety backup ended clears its card straight away, while the restore goes on', async () => {
    const { socket, fire } = makeMockSocket()
    setUp()
    restoreBackup.mockImplementation(() => new Promise(() => {}))

    renderBackups(socket)
    const requestId = await startRestoreFromTheRow()
    act(() => { fire('backup:progress', SAFETY_BACKUP_PROGRESS) })
    expect(await screen.findByText(SAFETY_BACKUP_PROGRESS.message)).toBeInTheDocument()

    // The socket drops, the safety backup finishes meanwhile, the socket
    // comes back: the status says the restore runs, no backup does.
    getStatus.mockResolvedValue(running(requestId))
    act(() => { fire('connect') })

    await waitFor(() => expect(screen.queryByText(SAFETY_BACKUP_PROGRESS.message)).not.toBeInTheDocument())
    expect(screen.getByText(fill(en.restoreProgress.title, { name: testBackup.name }))).toBeInTheDocument()
  })

  it("another tab's restore: a reconnect after its safety backup ended clears the card, and the restore's end leaves none", async () => {
    const { socket, fire } = makeMockSocket()
    setUp(running('other-tab-restore'))

    renderBackups(socket)
    expect(await screen.findByText(fill(en.restoreProgress.title, { name: testBackup.name }))).toBeInTheDocument()
    act(() => { fire('backup:progress', SAFETY_BACKUP_PROGRESS) })
    expect(await screen.findByText(SAFETY_BACKUP_PROGRESS.message)).toBeInTheDocument()

    act(() => { fire('connect') })
    await waitFor(() => expect(screen.queryByText(SAFETY_BACKUP_PROGRESS.message)).not.toBeInTheDocument())

    getStatus.mockResolvedValue(ended({ id: 'other-tab-restore' }))
    act(() => { fire('restore:finished', { id: 'other-tab-restore' }) })
    expect(await screen.findByText(en.restoreResult.successTitle)).toBeInTheDocument()
    expect(screen.queryByText(SAFETY_BACKUP_PROGRESS.message)).not.toBeInTheDocument()
  })

  it("keeps a live backup's card: a status read sent before the backup's first event can't clear it", async () => {
    const { socket, fire } = makeMockSocket()
    setUp()
    renderBackups(socket)
    await screen.findByRole('button', { name: fill(en.mainCard.restoreAria, { name: testBackup.name }) })

    // A read goes out while nothing runs, and answers only after another
    // tab's backup has started reporting.
    let answerStaleRead!: (status: BackupStatus) => void
    getStatus.mockImplementationOnce(() => new Promise((resolve) => { answerStaleRead = resolve }))
    act(() => { fire('backup:deferred') })
    await waitFor(() => expect(answerStaleRead).toBeDefined())
    act(() => { fire('backup:progress', SAFETY_BACKUP_PROGRESS) })
    await act(async () => { answerStaleRead(idleStatus) })

    expect(screen.getByText(SAFETY_BACKUP_PROGRESS.message)).toBeInTheDocument()
  })
})
