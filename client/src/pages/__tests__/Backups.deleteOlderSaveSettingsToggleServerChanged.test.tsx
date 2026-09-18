import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus, type ServerBackupArchive } from '@/lib/api'

// pz-bughunt round 17 (every write that trusts the server-side active
// server): Backups.tsx's serverChangedSinceLoad guard (bug-hunt-2026-09-04)
// already protects handleCreateBackup/handleRestoreBackup/handleDeleteBackups
// (see Backups.activeServerChanged.test.tsx), but three more writes on this
// same page shared the identical no-server-id shape and were missed:
// handleDeleteOlderThan, handleSaveSettings, and toggleBackupEnabled --
// backupApi.deleteOlderThan()/updateSettings() all resolve "the active
// server" server-side with no server id in the request. Switch the active
// server while the delete-older dialog is open or the settings panel is
// showing values loaded for the old server, and (before this fix) the write
// would silently land on whichever server is active NOW.

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
      deleteOlderThan: vi.fn(),
      updateSettings: vi.fn(),
    },
  }
})

// STABLE module-level fake socket -- see Backups.activeServerChanged.test.tsx
// for why a fresh object literal per useSocket() call thrashes effects that
// depend on [socket, ...].
const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)
const deleteOlderThan = vi.mocked(backupApi.deleteOlderThan)
const updateSettings = vi.mocked(backupApi.updateSettings)

const testStatus: BackupStatus = {
  enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true,
  backupInProgress: false, restoreInProgress: false, lastBackup: null,
  backupCount: 1, savesPath: '/saves', backupsPath: '/backups', savesExists: true,
}
const testBackup: ServerBackupArchive = {
  name: 'backup-2026-08-27T00-00-00',
  path: '/backups/backup-2026-08-27T00-00-00.zip',
  size: 1024 * 1024,
  created: '2026-08-27T00:00:00.000Z',
}

function primeReadMocks() {
  getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Ashenwood' } as never })
  getStatus.mockResolvedValue(testStatus)
  listBackups.mockResolvedValue({ backups: [testBackup] })
  getHistory.mockResolvedValue({ records: [] })
}

// Makes the reload the activeServerChanged handler kicks off hang, so the
// guard's transient window (set true synchronously, cleared once refreshAll
// resolves) is observable instead of flashing and clearing within one tick.
function hangReload() {
  let resolve!: () => void
  getResolvedActive.mockReturnValue(new Promise((r) => { resolve = () => r({ server: { id: 2, name: 'Brightmoor' } as never }) }))
  return () => resolve()
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderBackups() {
  return render(
    <TooltipProvider>
      <Backups />
    </TooltipProvider>,
  )
}

describe('Backups.tsx: serverChangedSinceLoad also guards deleteOlderThan/saveSettings/toggleEnabled', () => {
  it('handleDeleteOlderThan: closes the dialog and never calls deleteOlderThan after a switch', async () => {
    primeReadMocks()
    deleteOlderThan.mockResolvedValue({ success: true, deleted: 3, message: 'Deleted 3 backups' })

    renderBackups()
    const openButton = await screen.findByRole('button', { name: /delete older/i })
    fireEvent.click(openButton)
    expect(await screen.findByRole('button', { name: /delete older backups/i })).toBeInTheDocument()

    const resolveReload = hangReload()
    act(() => { emitActiveServerChanged() })

    // The dialog closes immediately, before the reload even resolves --
    // same treatment as restoreDialog/deleteDialog.
    await waitFor(() => expect(screen.queryByRole('button', { name: /delete older backups/i })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: /delete older/i })).toBeDisabled())

    fireEvent.click(screen.getByRole('button', { name: /delete older/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deleteOlderThan).not.toHaveBeenCalled()

    resolveReload()
    await waitFor(() => expect(screen.getByRole('button', { name: /delete older/i })).not.toBeDisabled())
  })

  it('handleSaveSettings: disables Save Settings and never calls updateSettings after a switch', async () => {
    primeReadMocks()
    updateSettings.mockResolvedValue({ success: true })

    renderBackups()
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }))
    const saveButton = await screen.findByRole('button', { name: /save settings/i })
    expect(saveButton).not.toBeDisabled()

    const resolveReload = hangReload()
    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateSettings).not.toHaveBeenCalled()

    resolveReload()
    await waitFor(() => expect(screen.getByRole('button', { name: /save settings/i })).not.toBeDisabled())
  })

  it('toggleBackupEnabled: disables the schedule switch and never calls updateSettings after a switch', async () => {
    primeReadMocks()
    updateSettings.mockResolvedValue({ success: true })

    renderBackups()
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }))
    const toggle = await screen.findByRole('switch', { name: /toggle scheduled backups/i })
    expect(toggle).not.toBeDisabled()

    const resolveReload = hangReload()
    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(screen.getByRole('switch', { name: /toggle scheduled backups/i })).toBeDisabled())
    fireEvent.click(screen.getByRole('switch', { name: /toggle scheduled backups/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateSettings).not.toHaveBeenCalled()

    resolveReload()
    await waitFor(() => expect(screen.getByRole('switch', { name: /toggle scheduled backups/i })).not.toBeDisabled())
  })
})
