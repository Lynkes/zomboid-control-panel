import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus, type ServerBackupArchive } from '@/lib/api'
import en from '../../locales/en/backups.json'

// pz-ux-deep-pass 2026-09-18 (Backups.tsx, "running server" persona): when
// another tab/session already has a restore running, backupStatus.restoreInProgress
// comes back true while THIS session's own `restoringBackup` stays null (see
// restoreInProgressElsewhere's own comment in Backups.tsx). Before this fix,
// that state disabled Create Backup, Upload, and every row's Restore button
// with NO visible explanation anywhere on the page -- no card, no tooltip --
// exactly the "disabled controls with no reason shown" class of bug the
// OPERATOR UX CONTRACT calls out, and irritant #1 ("can't tell what state
// it's in"). Now: (1) the Restore Progress card shows a generic message
// instead of only appearing for a restore THIS session started, and (2) the
// Create Backup button's DisabledReason tooltip names the reason instead of
// falling through to null.

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
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)

const restoreElsewhereStatus: BackupStatus = {
  enabled: true,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  includeDb: true,
  backupInProgress: false,
  restoreInProgress: true,
  lastBackup: null,
  backupCount: 1,
  savesPath: '/saves',
  backupsPath: '/backups',
  savesExists: true,
  lastScheduledBackupAttempt: null,
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
})

function renderBackups() {
  return render(
    <TooltipProvider>
      <Backups />
    </TooltipProvider>,
  )
}

describe('Backups.tsx: a restore started elsewhere is visible, not just silently disabling buttons', () => {
  it('shows a persistent card and names the reason on the disabled Create Backup button', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue(restoreElsewhereStatus)
    listBackups.mockResolvedValue({ backups: [testBackup] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    // The card itself.
    expect(await screen.findByText(en.restoreProgress.titleUnknown)).toBeInTheDocument()

    // Create Backup is disabled, and hovering/focusing it explains why.
    const createButton = await screen.findByRole('button', { name: en.pageHeader.createBackup })
    expect(createButton).toBeDisabled()
    const wrapper = createButton.parentElement
    expect(wrapper).not.toBeNull()
    fireEvent.focus(wrapper!)
    expect(await screen.findByText(en.permissions.restoreInProgress)).toBeInTheDocument()
  })
})
