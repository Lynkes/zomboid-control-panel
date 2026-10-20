import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { ApiError, backupApi, serversApi, type BackupStatus, type ServerBackupArchive } from '@/lib/api'

// Shipped in v1.4.17:
// - Download from a row's menu was fire-and-forget: a refused or failed
//   download (403, a backup gone from disk) showed nothing at all.
// - The empty state's Create Backup sent a second POST /create on a double
//   click; its refusal put an error card over the running backup.
// New in the redesign:
// - The empty state says "turn on scheduled backups above", but that
//   switch moved into the Schedule & retention card, closed by default.
// - "Open Diagnostics › Activity" after an unknown restore outcome was
//   shown to roles that can't open Diagnostics.

const caps = vi.hoisted(() => ({ denied: new Set<string>() }))
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => !caps.denied.has(capability),
  }),
}))

const toastSpy = vi.hoisted(() => vi.fn())
const toastApi = vi.hoisted(() => ({ toast: toastSpy, dismiss: () => {}, toasts: [] }))
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => toastApi,
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
      createBackup: vi.fn(),
      downloadBackup: vi.fn(),
      validateSchedule: vi.fn(),
      deleteOlderThan: vi.fn(),
    },
  }
})

const status: BackupStatus = {
  enabled: false, schedule: '0 */6 * * *', maxBackups: 10, includeDb: false,
  backupInProgress: false, restoreInProgress: false, lastBackup: null,
  backupCount: 0, savesPath: '/saves', backupsPath: '/backups', savesExists: true,
  lastScheduledBackupAttempt: null,
}

const backup: ServerBackupArchive = {
  name: 'backup-2026-08-27T00-00-00',
  path: '/backups/backup-2026-08-27T00-00-00.zip',
  size: 1024 * 1024,
  created: '2026-08-27T00:00:00.000Z',
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>
}

function renderBackups() {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={['/backups']}>
        <Backups />
        <LocationProbe />
      </MemoryRouter>
    </TooltipProvider>,
  )
}

function setUp(backups: ServerBackupArchive[]) {
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: null })
  vi.mocked(backupApi.getStatus).mockResolvedValue(status)
  vi.mocked(backupApi.listBackups).mockResolvedValue({ backups })
  vi.mocked(backupApi.getHistory).mockResolvedValue({ records: [] })
  vi.mocked(backupApi.validateSchedule).mockResolvedValue({ valid: true, nextRun: null, timezone: 'UTC', restartOverlaps: [] })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  caps.denied = new Set()
})

describe('Backups.tsx: Download says when it fails', () => {
  it('shows the reason in a toast', async () => {
    setUp([backup])
    vi.mocked(backupApi.downloadBackup).mockRejectedValue(
      new ApiError('Backup not found', { status: 404, code: 'HTTP_404' }),
    )
    renderBackups()

    const trigger = await screen.findByRole('button', { name: `More actions for ${backup.name}` })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: /download/i }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Download failed', variant: 'destructive' })),
    )
  })
})

describe('Backups.tsx: "Delete older…" shows it is running', () => {
  // The old header button spun; the action now lives in a menu that is
  // closed while it runs.
  it('puts a busy status in the header until it is done', async () => {
    setUp([backup])
    let finish: (value: Awaited<ReturnType<typeof backupApi.deleteOlderThan>>) => void = () => {}
    vi.mocked(backupApi.deleteOlderThan).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    renderBackups()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'More list actions' }), { button: 0, ctrlKey: false })
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /delete older/i }))
    fireEvent.click(await screen.findByRole('button', { name: /delete older backups/i }))

    expect(await screen.findByText('Deleting old backups…')).toBeInTheDocument()
    finish({ success: true, deleted: 0, message: 'Nothing to delete' } as never)
    await waitFor(() => expect(screen.queryByText('Deleting old backups…')).not.toBeInTheDocument())
  })
})

describe('Backups.tsx: the empty state', () => {
  it('starts one backup however often Create Backup is clicked while it runs', async () => {
    setUp([])
    let finish: (value: Awaited<ReturnType<typeof backupApi.createBackup>>) => void = () => {}
    vi.mocked(backupApi.createBackup).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    renderBackups()

    await screen.findByText('No safety net')
    const create = screen.getAllByRole('button', { name: 'Create Backup' }).at(-1)!
    fireEvent.click(create)
    fireEvent.click(create)
    fireEvent.click(create)
    expect(backupApi.createBackup).toHaveBeenCalledTimes(1)
    finish({ success: true, backup, duration: 1 })
  })

  it('opens Schedule & retention, where the scheduled-backups switch is', async () => {
    setUp([])
    renderBackups()

    await screen.findByText('No safety net')
    const empty = screen.getByText('No safety net').parentElement!
    fireEvent.click(within(empty).getByRole('button', { name: 'Back up automatically' }))

    expect(await screen.findByRole('switch', { name: 'Toggle scheduled backups' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('?panel=schedule')
  })
})
