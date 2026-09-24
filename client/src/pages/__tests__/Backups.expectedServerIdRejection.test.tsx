import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, ApiError, type BackupStatus, type ServerBackupArchive } from '@/lib/api'

// pz-bughunt round 18 (send expectedServerId on backup settings writes):
// server/routes/backup.js's POST /settings and POST /delete-older-than now
// accept an optional expectedServerId in the body and 409
// BACKUP_ACTIVE_SERVER_CHANGED on a real mismatch against the currently
// active server -- defense in depth alongside Backups.tsx's own
// serverChangedSinceLoad guard (which already blocks the click during the
// known race window, but doesn't cover every path a write could reach the
// server through, e.g. a second tab, a stale in-memory guard state).
// backupApi.updateSettings()/deleteOlderThan() now take the caller's
// captured activeServerId as an explicit second argument, and the existing
// getUserErrorMessage(error, fallback) call in each catch block picks up
// the coded 409's translated message automatically once the code is
// registered in errors.json (already true for en; this round also gave it
// real translations in the other 8 locales).

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
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
      updateSettings: vi.fn(),
    },
  }
})

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

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)
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

describe('Backups.tsx: sends expectedServerId on settings saves and surfaces the coded 409', () => {
  it('calls updateSettings with the captured active server id, and shows the registered BACKUP_ACTIVE_SERVER_CHANGED message on a 409', async () => {
    getResolvedActive.mockResolvedValue({ server: { id: 42, name: 'Ashenwood' } as never })
    getStatus.mockResolvedValue(testStatus)
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })
    updateSettings.mockRejectedValue(
      new ApiError('The active server changed since these settings were loaded. Reload backup settings before saving.', {
        status: 409,
        code: 'BACKUP_ACTIVE_SERVER_CHANGED',
      }),
    )

    renderBackups()
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }))
    const saveButton = await screen.findByRole('button', { name: /save settings/i })
    fireEvent.click(saveButton)

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
    // The second argument is the active server id captured when this page
    // last loaded -- the whole point of this round's fix.
    expect(updateSettings).toHaveBeenCalledWith(expect.any(Object), 42)

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'The active server changed since these settings were loaded. Reload backup settings before saving.',
      }),
    ))
  })
})
