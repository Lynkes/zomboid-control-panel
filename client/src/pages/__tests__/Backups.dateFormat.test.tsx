import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus, type ServerBackupArchive } from '@/lib/api'
import { DATE_FORMAT_STORAGE_KEY, setDateFormatPref } from '@/lib/dateFormat'

// Discord (MrBrain): "Can we have an option for backups to show the date as
// day/month/year". An English UI used to print every backup date in the US
// order whatever the browser's region; the Settings choice now applies here.

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

// 4 March, 10:07 in the browser's own zone: a day/month swap shows.
const CREATED = new Date(2026, 2, 4, 10, 7).toISOString()

const backup: ServerBackupArchive = {
  name: 'Tavern_2026-03-04T10-07-00-000Z',
  path: '/backups/Tavern_2026-03-04T10-07-00-000Z.zip',
  size: 1024 * 1024,
  created: CREATED,
}

const status: BackupStatus = {
  enabled: true,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  includeDb: true,
  backupInProgress: false,
  restoreInProgress: false,
  lastBackup: { ...backup },
  backupCount: 1,
  savesPath: '/saves',
  backupsPath: '/backups',
  savesExists: true,
}

function renderBackups() {
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: null })
  vi.mocked(backupApi.getStatus).mockResolvedValue(status)
  vi.mocked(backupApi.listBackups).mockResolvedValue({ backups: [backup] })
  vi.mocked(backupApi.getHistory).mockResolvedValue({ records: [] })
  return render(
    <TooltipProvider>
      <Backups />
    </TooltipProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  setDateFormatPref('auto')
  localStorage.removeItem(DATE_FORMAT_STORAGE_KEY)
})

describe('Backups.tsx: the date format setting', () => {
  it('shows backup dates as day/month/year when that is the saved choice', async () => {
    localStorage.setItem(DATE_FORMAT_STORAGE_KEY, 'dmy')
    renderBackups()

    // The Last Backup card and the backup's row.
    expect(await screen.findAllByText('04/03/2026 10:07 AM')).toHaveLength(2)
    expect(screen.queryByText(/3\/4\/2026/)).toBeNull()
  })

  it('keeps the US order under Automatic in an en-US browser', async () => {
    renderBackups()
    expect(await screen.findAllByText('3/4/2026, 10:07 AM')).toHaveLength(2)
  })

  it('follows a change made while the page is open', async () => {
    renderBackups()
    await screen.findAllByText('3/4/2026, 10:07 AM')
    act(() => setDateFormatPref('ymd'))
    expect(screen.getAllByText('2026-03-04 10:07 AM')).toHaveLength(2)
  })
})
