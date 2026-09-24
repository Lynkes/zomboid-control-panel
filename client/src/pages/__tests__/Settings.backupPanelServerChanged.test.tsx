import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { backupApi, configApi, serversApi } from '@/lib/api'

// pz-bughunt round 17 (every write that trusts the server-side active
// server): Settings.tsx embeds its OWN independent backup mini-panel
// (World Backups card) alongside the dedicated Backups.tsx page. Its
// activeServerChanged handler used to only refetch the servers list and
// app-wide settings -- backups/backupStatus/backupSchedule/backupMaxCount
// were never refreshed, and nothing blocked a write (create/delete/restore/
// save schedule/toggle enabled) from firing against the now-different
// active server using values loaded for the PREVIOUS one. Worst case:
// backupApi.updateSettings has no server-side ownership check at all
// (unlike delete/restore, which an earlier round hardened against a shared
// backups folder) -- a stale save silently misconfigures the wrong
// server's retention with zero error. Guarded by backupPanelServerChanged,
// mirroring Backups.tsx's own serverChangedSinceLoad shape.

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
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    backupApi: {
      ...actual.backupApi,
      getStatus: vi.fn(),
      listBackups: vi.fn(),
      createBackup: vi.fn(),
      deleteBackup: vi.fn(),
      restoreBackup: vi.fn(),
      updateSettings: vi.fn(),
    },
  }
})

// STABLE module-level fake socket -- see Settings.activeServerChangedEditLoss
// .test.tsx's own comment for why this must be a singleton, not a fresh
// object literal per useSocket() call.
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

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getAllServers = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const createBackup = vi.mocked(backupApi.createBackup)
const deleteBackup = vi.mocked(backupApi.deleteBackup)
const restoreBackup = vi.mocked(backupApi.restoreBackup)
const updateSettings = vi.mocked(backupApi.updateSettings)

const baseStatus = {
  enabled: true,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  savesExists: true,
} as Awaited<ReturnType<typeof backupApi.getStatus>>

function primeReadMocks() {
  getAppSettings.mockResolvedValue({ settings: {} } as never)
  getAllServers.mockResolvedValue({ servers: [] } as never)
  // First call (mount) resolves normally; every call AFTER that (i.e. the
  // backup-panel's own activeServerChanged refetch) hangs forever -- this
  // keeps backupPanelServerChanged stuck at true for the duration of each
  // test, the same way a real slow/in-flight refetch would.
  let statusCalls = 0
  getStatus.mockImplementation(() => {
    statusCalls += 1
    return statusCalls === 1 ? Promise.resolve(baseStatus) : new Promise(() => {})
  })
  let listCalls = 0
  listBackups.mockImplementation(() => {
    listCalls += 1
    return listCalls === 1
      ? Promise.resolve({ backups: [{ name: 'ServerA_2026-01-01T00-00-00-000.zip', size: 100, created: '2026-01-01T00:00:00.000Z' }] } as never)
      : new Promise(() => {})
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=backups']}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function waitForBackupsLoaded() {
  await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(listBackups).toHaveBeenCalledTimes(1))
  await screen.findByText('World Backups')
}

describe('Settings.tsx: activeServerChanged blocks the backup mini-panel writes', () => {
  it('handleCreateBackup: Backup Now is disabled and never calls createBackup once the server changed', async () => {
    primeReadMocks()
    renderSettings()
    await waitForBackupsLoaded()

    const backupNowButton = await screen.findByRole('button', { name: /backup now/i })
    expect(backupNowButton).not.toBeDisabled()

    emitActiveServerChanged()

    await waitFor(() => expect(screen.getByRole('button', { name: /backup now/i })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /backup now/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(createBackup).not.toHaveBeenCalled()
  })

  it('toggleBackupEnabled: the switch is disabled and never calls updateSettings once the server changed', async () => {
    primeReadMocks()
    renderSettings()
    await waitForBackupsLoaded()

    const toggle = await screen.findByRole('switch', { name: /enable scheduled backups/i })
    expect(toggle).not.toBeDisabled()

    emitActiveServerChanged()

    await waitFor(() => expect(screen.getByRole('switch', { name: /enable scheduled backups/i })).toBeDisabled())
    fireEvent.click(screen.getByRole('switch', { name: /enable scheduled backups/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('handleSaveBackupSettings: Save Schedule Settings is disabled and never calls updateSettings once the server changed', async () => {
    primeReadMocks()
    renderSettings()
    await waitForBackupsLoaded()

    const saveButton = await screen.findByRole('button', { name: /save schedule settings/i })
    expect(saveButton).not.toBeDisabled()

    emitActiveServerChanged()

    await waitFor(() => expect(screen.getByRole('button', { name: /save schedule settings/i })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /save schedule settings/i }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('handleDeleteBackup: refuses to delete after the server changed even though the confirm button has no disabled= of its own', async () => {
    primeReadMocks()
    renderSettings()
    await waitForBackupsLoaded()

    // The row's delete trigger is icon-only with no accessible name (no
    // title/aria-label) -- locate it by its lucide icon class, same escape
    // hatch used elsewhere in this codebase's own tests for icon-only
    // buttons (see Mods.promoteModOverOpponentServerChanged.test.tsx).
    const deleteTrigger = document.querySelector('svg.lucide-trash-2')?.closest('button')
    expect(deleteTrigger).not.toBeNull()
    fireEvent.click(deleteTrigger!)
    const confirmButton = await screen.findByRole('button', { name: 'Delete' })

    emitActiveServerChanged()
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))

    fireEvent.click(confirmButton)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deleteBackup).not.toHaveBeenCalled()
  })

  it('handleRestoreBackup: refuses to restore after the server changed even though the confirm button has no disabled= of its own', async () => {
    primeReadMocks()
    renderSettings()
    await waitForBackupsLoaded()

    // The row's restore trigger is icon-only; its accessible name comes
    // from its `title` attribute ("Restore this backup (server must be
    // stopped)"), not "Restore Backup" -- that text belongs only to the
    // confirm dialog's own AlertDialogAction.
    const restoreTrigger = await screen.findByRole('button', { name: /restore this backup/i })
    fireEvent.click(restoreTrigger)
    await screen.findByRole('button', { name: 'Restore Backup' })

    // The restore confirm dialog is CONTROLLED by restoreConfirmBackup,
    // which the guard handler resets to null on activeServerChanged (same
    // reasoning as Backups.tsx closing its own restore/delete dialogs on
    // this event) -- it closes here as a side effect. Reopen it (a fresh,
    // deliberate action) to prove the FUNCTION guard -- not just "the
    // dialog happened to close" -- is what actually blocks the write.
    emitActiveServerChanged()
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore Backup' })).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /restore this backup/i }))
    const confirmButton = await screen.findByRole('button', { name: 'Restore Backup' })
    fireEvent.click(confirmButton)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(restoreBackup).not.toHaveBeenCalled()
  })
})
